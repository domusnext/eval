'use client';

import {
    StartStreamTranscriptionCommand,
    TranscribeStreamingClient,
    LanguageCode as AwsLanguageCode,
    MediaEncoding as AwsMediaEncoding,
    type LanguageCode,
    type MediaEncoding,
    type TranscriptResultStream,
} from '@aws-sdk/client-transcribe-streaming';
import { AUDIO_CONFIG } from './recordrtc';
import {
    appendSegment,
    type ASRServiceCallbacks,
    type ASRServiceState,
    type StreamingASRService,
} from './asr-service-base';

export type AwsTranscribeCredentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
};

export type AwsTranscribeServiceConfig = {
    id: string;
    label: string;
    region: string;
    languageCode?: LanguageCode | string;
    mediaEncoding?: MediaEncoding | string;
    sampleRate?: number;
    credentialsProvider: () => Promise<AwsTranscribeCredentials | null>;
};

export class AwsTranscribeService implements StreamingASRService {
    private state: ASRServiceState;
    private readonly audioQueue: Uint8Array[] = [];
    private audioQueueResolver: (() => void) | null = null;
    private stopRequested = false;
    private client: TranscribeStreamingClient | null = null;
    private processingTask: Promise<void> | null = null;

    constructor(
        private readonly config: AwsTranscribeServiceConfig,
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
            connectionLabel: `aws://${config.region}`,
        };
    }

    getState(): ASRServiceState {
        return { ...this.state };
    }

    start(): void {
        if (this.processingTask) {
            return;
        }
        this.stopRequested = false;
        this.audioQueue.length = 0;
        this.setState({
            status: 'connecting',
            transcript: '',
            finalTranscript: '',
            partialTranscript: '',
            errorMessage: null,
            lastInfoMessage: null,
        });
        this.processingTask = this.startInternal().finally(() => {
            this.processingTask = null;
        });
    }

    stop(reason = 'client_stop'): void {
        if (this.state.status === 'idle' || this.state.status === 'closed') {
            return;
        }
        this.stopRequested = true;
        this.resolvePendingAudio();
        this.client?.destroy?.();
        this.client = null;
        if (reason === 'error') {
            this.setState({ status: 'error' });
        } else {
            this.setState({ status: 'stopping' });
        }
        this.setState({ status: 'closed' });
    }

    sendAudioChunk(chunk: ArrayBuffer): void {
        if (this.stopRequested) {
            return;
        }
        if (!chunk || chunk.byteLength === 0) {
            return;
        }
        this.audioQueue.push(new Uint8Array(chunk.slice(0)));
        this.resolvePendingAudio();
    }

    private async startInternal(): Promise<void> {
        try {
            const credentials = await this.config.credentialsProvider();
            if (!credentials) {
                throw new Error('AWS Transcribe credentials are not configured');
            }
            this.client = new TranscribeStreamingClient({
                region: this.config.region,
                credentials,
            });
            this.setState({ status: 'ready', lastInfoMessage: 'Awaiting audio chunks…' });

            const audioStream = this.createAudioStream();
            const command = new StartStreamTranscriptionCommand({
                LanguageCode: (this.config.languageCode ?? AwsLanguageCode.EN_US) as LanguageCode,
                MediaEncoding: (this.config.mediaEncoding ?? AwsMediaEncoding.PCM) as MediaEncoding,
                MediaSampleRateHertz: this.config.sampleRate ?? AUDIO_CONFIG.SAMPLE_RATE,
                AudioStream: audioStream,
            });

            const response = await this.client.send(command);
            if (!response.TranscriptResultStream) {
                throw new Error('TranscriptResultStream is empty');
            }

            this.setState({ status: 'streaming', lastInfoMessage: 'Streaming transcription…' });

            for await (const event of response.TranscriptResultStream as AsyncIterable<TranscriptResultStream>) {
                if (this.stopRequested) {
                    break;
                }
                if (event.TranscriptEvent) {
                    const results = ((event.TranscriptEvent.Transcript as Record<string, unknown>)?.Results ?? []) as unknown[];
                    this.handleTranscriptEvent(results);
                }
                const handledError = this.handleServiceException(event);
                if (handledError) {
                    break;
                }
            }

            if (!this.stopRequested) {
                this.setState({ status: 'closed', lastInfoMessage: 'Transcription finished' });
            }
        } catch (error) {
            this.setError(this.stringifyError(error));
        } finally {
            this.stopRequested = true;
            this.resolvePendingAudio();
            this.client?.destroy?.();
            this.client = null;
        }
    }

    private handleTranscriptEvent(results: unknown[]): void {
        if (!results || !results.length) {
            return;
        }
        results.forEach((resultEntry) => {
            const result = resultEntry as {
                Alternatives?: Array<{ Transcript?: string | null }>;
                IsPartial?: boolean;
            };
            if (!result?.Alternatives?.length) {
                return;
            }
            result.Alternatives.forEach((alternativeEntry) => {
                const alternative = alternativeEntry as { Transcript?: string | null };
                const transcriptText = alternative?.Transcript?.trim();
                if (!transcriptText) {
                    return;
                }
                if (result.IsPartial) {
                    const payload = appendSegment(this.state.finalTranscript, transcriptText);
                    this.setState({ transcript: payload, partialTranscript: transcriptText });
                } else {
                    const nextFinal = appendSegment(this.state.finalTranscript, transcriptText);
                    this.setState({ transcript: nextFinal, finalTranscript: nextFinal, partialTranscript: '' });
                }
            });
        });
    }

    private handleServiceException(event: TranscriptResultStream): boolean {
        const exception =
            event.BadRequestException ||
            event.LimitExceededException ||
            event.InternalFailureException ||
            event.ConflictException;
        if (!exception) {
            return false;
        }
        const serialized = this.stringifyError(exception);
        this.setError(serialized);
        return true;
    }

    private async *createAudioStream() {
        while (!this.stopRequested) {
            if (!this.audioQueue.length) {
                await new Promise<void>((resolve) => {
                    this.audioQueueResolver = resolve;
                });
                continue;
            }
            const chunk = this.audioQueue.shift();
            if (chunk) {
                yield { AudioEvent: { AudioChunk: chunk } };
            }
        }
    }

    private resolvePendingAudio(): void {
        if (this.audioQueueResolver) {
            this.audioQueueResolver();
            this.audioQueueResolver = null;
        }
    }

    private setState(patch: Partial<ASRServiceState>): void {
        this.state = { ...this.state, ...patch };
        this.callbacks?.onStateChange?.({ ...this.state });
    }

    private setError(message: string): void {
        this.setState({ status: 'error', errorMessage: message });
    }

    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return `${error.name}: ${error.message}`;
        }
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }
}
