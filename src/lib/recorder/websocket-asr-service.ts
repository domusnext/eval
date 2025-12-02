'use client';

import type { ASRServiceCallbacks, ASRServiceState, StreamingASRService } from './asr-service-base';
import { appendSegment } from './asr-service-base';

export type SpeechServerMessage =
    | { type: 'ready'; config?: Record<string, unknown> }
    | { type: 'transcript'; transcript: string; isFinal?: boolean; confidence?: number; resultIndex?: number }
    | { type: 'error'; message?: string; detail?: string }
    | { type: 'info'; message?: string }
    | { type: 'end' }
    | Record<string, unknown>;

export type WebSocketASRServiceConfig = {
    id: string;
    label: string;
    wsUrl: string;
};

const cloneState = (state: ASRServiceState): ASRServiceState => ({ ...state });

export class WebSocketASRService implements StreamingASRService {
    private ws: WebSocket | null = null;
    private readonly pendingChunks: Array<ArrayBuffer> = [];
    private state: ASRServiceState;
    private wsClosed = false;

    constructor(
        private readonly config: WebSocketASRServiceConfig,
        private readonly callbacks?: ASRServiceCallbacks,
    ) {
        this.state = {
            id: config.id,
            label: config.label,
            status: 'idle',
            transcript: '',
            finalTranscript: '',
            partialTranscript: '',
            errorMessage: null,
            lastInfoMessage: null,
            connectionLabel: config.wsUrl,
        };
    }

    getState(): ASRServiceState {
        return cloneState(this.state);
    }

    start(): void {
        if (this.ws) {
            return;
        }
        this.pendingChunks.length = 0;
        this.wsClosed = false;
        this.setState({
            status: 'connecting',
            transcript: '',
            finalTranscript: '',
            partialTranscript: '',
            errorMessage: null,
            lastInfoMessage: null,
        });

        try {
            const socket = new WebSocket(`wss://domus-agent-738222537643.us-central1.run.app/agent/v1/speech/ws`);
            socket.binaryType = 'arraybuffer';
            this.ws = socket;

            socket.addEventListener('open', () => {
                this.flushPendingChunks();
            });

            socket.addEventListener('message', (event) => {
                if (typeof event.data === 'string') {
                    this.handleServerPayload(event.data);
                    return;
                }
                if (event.data instanceof ArrayBuffer) {
                    this.handleServerPayload(event.data);
                    return;
                }
                if (event.data instanceof Blob) {
                    event.data.text().then((text) => this.handleServerPayload(text)).catch((error) => {
                        console.error(`[${this.config.id}] unable to decode blob payload`, error);
                    });
                }
            });

            socket.addEventListener('close', () => {
                this.wsClosed = true;
                this.ws = null;
                this.pendingChunks.length = 0;
                if (this.state.status !== 'error') {
                    this.setState({ status: 'closed' });
                }
            });

            socket.addEventListener('error', (event) => {
                console.error(`[${this.config.id}] ws error`, event);
                this.setError('WebSocket error, check provider logs');
                socket.close(1011, 'socket_error');
            });
        } catch (error) {
            this.setError(`Unable to open WebSocket: ${this.stringifyError(error)}`);
        }
    }

    stop(reason = 'client_stop'): void {
        if (this.state.status === 'idle' || this.state.status === 'closed') {
            return;
        }
        this.setState({ status: 'stopping' });
        this.pendingChunks.length = 0;
        if (this.ws) {
            try {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send('stop');
                }
                this.ws.close(1000, reason);
            } catch (error) {
                console.error(`[${this.config.id}] unable to close ws`, error);
            }
            this.ws = null;
        }
        this.setState({ status: 'closed' });
    }

    sendAudioChunk(chunk: ArrayBuffer): void {
        if (!chunk || chunk.byteLength === 0 || this.wsClosed) {
            return;
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.pendingChunks.push(chunk.slice(0));
            return;
        }
        try {
            this.ws.send(chunk.slice(0));
            if (this.state.status === 'ready' || this.state.status === 'connecting') {
                this.setState({ status: 'streaming' });
            }
        } catch (error) {
            this.setError(`Failed to send audio chunk: ${this.stringifyError(error)}`);
        }
    }

    private flushPendingChunks(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        while (this.pendingChunks.length) {
            const chunk = this.pendingChunks.shift();
            if (chunk) {
                try {
                    this.ws.send(chunk);
                } catch (error) {
                    this.setError(`Failed to flush chunk: ${this.stringifyError(error)}`);
                    break;
                }
            }
        }
    }

    private handleServerPayload(raw: string | ArrayBuffer): void {
        let payload: SpeechServerMessage | null = null;
        try {
            if (typeof raw === 'string') {
                payload = JSON.parse(raw);
            } else {
                const text = new TextDecoder().decode(raw);
                payload = JSON.parse(text);
            }
        } catch (error) {
            console.error(`[${this.config.id}] failed to parse server payload`, error, raw);
            return;
        }

        if (!payload || typeof payload !== 'object' || !('type' in payload)) {
            return;
        }

        const typedPayload = payload as SpeechServerMessage;

        switch (typedPayload.type) {
            case 'ready':
                this.setState({ status: 'ready' });
                break;
            case 'transcript':
                this.handleTranscriptPayload(typedPayload as Extract<SpeechServerMessage, { type: 'transcript' }>);
                break;
            case 'info':
                this.setState({
                    lastInfoMessage:
                        typeof (typedPayload as { message?: unknown }).message === 'string'
                            ? (typedPayload as { message?: string }).message ?? null
                            : null,
                });
                break;
            case 'error':
                this.setError(
                    (typeof (typedPayload as { detail?: unknown }).detail === 'string'
                        ? (typedPayload as { detail?: string }).detail
                        : typeof (typedPayload as { message?: unknown }).message === 'string'
                            ? (typedPayload as { message?: string }).message
                            : null) || 'Speech stream error',
                );
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.close(1011, 'speech_stream_error');
                }
                break;
            case 'end':
                this.setState({ status: 'closed' });
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.close(1000, 'speech_stream_finished');
                }
                break;
            default:
                break;
        }
    }

    private handleTranscriptPayload(payload: Extract<SpeechServerMessage, { type: 'transcript' }>): void {
        const text = typeof payload.transcript === 'string' ? payload.transcript.trim() : '';
        if (!text) {
            return;
        }
        const isFinal = Boolean(payload.isFinal);
        const currentFinal = this.state.finalTranscript;
        const nextFinal = isFinal ? appendSegment(currentFinal, text) : currentFinal;
        const nextPartial = isFinal ? '' : text;
        const display = nextPartial ? appendSegment(nextFinal, nextPartial) : nextFinal;
        this.setState({
            status: isFinal ? 'streaming' : this.state.status,
            transcript: display,
            finalTranscript: nextFinal,
            partialTranscript: nextPartial,
        });
    }

    private setError(message: string): void {
        this.setState({ status: 'error', errorMessage: message });
    }

    private setState(patch: Partial<ASRServiceState>): void {
        this.state = { ...this.state, ...patch };
        this.callbacks?.onStateChange?.(cloneState(this.state));
    }

    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }
}
