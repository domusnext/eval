'use client';

import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import {
    appendSegment,
    type ASRServiceCallbacks,
    type ASRServiceState,
    type StreamingASRService,
} from './asr-service-base';

export type AzureSpeechCredentials = {
    region: string;
    key?: string;
    token?: string;
};

export type AzureSpeechServiceConfig = {
    id: string;
    label: string;
    language?: string;
    credentialsProvider: () => Promise<AzureSpeechCredentials | null>;
};

export class AzureSpeechService implements StreamingASRService {
    private state: ASRServiceState;
    private recognizer: SpeechSDK.SpeechRecognizer | null = null;
    private pushStream: SpeechSDK.PushAudioInputStream | null = null;
    private audioQueue: ArrayBuffer[] = [];
    private readyForAudio = false;
    private stopping = false;

    constructor(
        private readonly config: AzureSpeechServiceConfig,
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
            connectionLabel: 'azure://speech',
        };
    }

    start(): void {
        if (this.recognizer) {
            return;
        }
        this.stopping = false;
        this.readyForAudio = false;
        this.audioQueue = [];
        this.setState({
            status: 'connecting',
            transcript: '',
            finalTranscript: '',
            partialTranscript: '',
            errorMessage: null,
            lastInfoMessage: null,
        });
        void this.startInternal();
    }

    stop(): void {
        this.stopping = true;
        if (this.pushStream) {
            try {
                this.pushStream.close();
            } catch {
                // ignore
            }
        }
        this.pushStream = null;
        if (this.recognizer) {
            const recognizer = this.recognizer;
            this.recognizer = null;
            recognizer.stopContinuousRecognitionAsync(
                () => {
                    this.setState({ status: 'closed' });
                },
                (error) => {
                    console.error('[azure] failed to stop recognition', error);
                    this.setState({ status: 'closed' });
                },
            );
            recognizer.close();
        } else {
            this.setState({ status: 'closed' });
        }
    }

    sendAudioChunk(chunk: ArrayBuffer): void {
        if (!chunk || chunk.byteLength === 0 || this.stopping) {
            return;
        }
        const pcmChunk = this.toPcmChunk(chunk);
        if (this.readyForAudio && this.pushStream) {
            try {
                this.pushStream.write(pcmChunk);
            } catch (error) {
                console.error('[azure] failed to write audio chunk', error);
                this.setError('Failed to push audio chunk');
            }
            return;
        }
        this.audioQueue.push(pcmChunk.slice(0));
    }

    getState(): ASRServiceState {
        return { ...this.state };
    }

    private async startInternal(): Promise<void> {
        try {
            const credentials = await this.config.credentialsProvider();
            if (!credentials?.region || (!credentials.key && !credentials.token)) {
                throw new Error('Azure credentials are missing');
            }
            const speechConfig = credentials.token
                ? SpeechSDK.SpeechConfig.fromAuthorizationToken(credentials.token, credentials.region)
                : SpeechSDK.SpeechConfig.fromSubscription(credentials.key!, credentials.region);
            speechConfig.speechRecognitionLanguage = this.config.language ?? 'en-US';

            const format = SpeechSDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
            this.pushStream = SpeechSDK.AudioInputStream.createPushStream(format);
            const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(this.pushStream);
            this.recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

            this.registerRecognizerEvents(this.recognizer);

            await new Promise<void>((resolve, reject) => {
                this.recognizer!.startContinuousRecognitionAsync(
                    () => {
                        resolve();
                    },
                    (error) => {
                        reject(error);
                    },
                );
            });

            this.readyForAudio = true;
            this.setState({ status: 'streaming', lastInfoMessage: 'Azure streaming started' });
            this.flushAudioQueue();
        } catch (error) {
            console.error('[azure] failed to start', error);
            this.setError(this.stringifyError(error));
        }
    }

    private flushAudioQueue(): void {
        if (!this.readyForAudio || !this.pushStream) {
            return;
        }
        while (this.audioQueue.length) {
            const chunk = this.audioQueue.shift();
            if (chunk) {
                try {
                    this.pushStream.write(chunk);
                } catch (error) {
                    console.error('[azure] failed to flush chunk', error);
                    this.setError('Failed to write buffered audio chunk');
                    break;
                }
            }
        }
    }

    private toPcmChunk(chunk: ArrayBuffer): ArrayBuffer {
        if (chunk.byteLength < 8) {
            return chunk;
        }
        const view = new DataView(chunk);
        const isRiff =
            view.getUint8(0) === 0x52 &&
            view.getUint8(1) === 0x49 &&
            view.getUint8(2) === 0x46 &&
            view.getUint8(3) === 0x46;
        if (!isRiff || chunk.byteLength <= 44) {
            return chunk;
        }
        // Assume 44-byte WAV header; return PCM payload.
        return chunk.slice(44);
    }

    private registerRecognizerEvents(recognizer: SpeechSDK.SpeechRecognizer): void {
        recognizer.recognizing = (_, event) => {
            const text = event?.result?.text?.trim();
            if (!text) {
                return;
            }
            const payload = appendSegment(this.state.finalTranscript, text);
            this.setState({ transcript: payload, partialTranscript: text });
        };

        recognizer.recognized = (_, event) => {
            if (
                event?.result?.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
                event.result.text?.trim()
            ) {
                const nextFinal = appendSegment(this.state.finalTranscript, event.result.text.trim());
                this.setState({ transcript: nextFinal, finalTranscript: nextFinal, partialTranscript: '' });
            }
        };

        recognizer.canceled = (_, event) => {
            const errorDetails = event?.errorDetails?.trim();
            this.setError(errorDetails || 'Azure speech canceled');
            this.stop();
        };

        recognizer.sessionStopped = () => {
            if (!this.stopping) {
                this.setState({ status: 'closed', lastInfoMessage: 'Azure session stopped' });
            }
        };
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
