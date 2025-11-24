'use client';

import type { ASRServiceCallbacks, ASRServiceState, StreamingASRService } from './asr-service-base';
import { AwsTranscribeService, type AwsTranscribeCredentials } from './aws-transcribe-service';
import { AzureSpeechService, type AzureSpeechCredentials } from './azure-speech-service';
import { WebSocketASRService, type WebSocketASRServiceConfig } from './websocket-asr-service';

const SPEECH_WS_PATH = '/agent/v1/speech/ws';
const DEFAULT_AGENT_BASE_URL = process.env.NEXT_PUBLIC_AGENT_BASE_URL ?? '/api/agent';
const EXPLICIT_AGENT_WS_URL = process.env.NEXT_PUBLIC_AGENT_WS_URL;

const AWS_TRANSCRIBE_REGION = 'us-east-1';
const AWS_TRANSCRIBE_LANGUAGE = 'en-US';
const AWS_TRANSCRIBE_ENCODING = 'pcm';
const AWS_TRANSCRIBE_SAMPLE_RATE = 16000;
const AWS_TRANSCRIBE_LABEL = 'AWS Transcribe';

export type ASRServiceDescriptor = {
    id: string;
    label: string;
    connectionLabel: string | null;
    createService: (callbacks: ASRServiceCallbacks) => StreamingASRService;
};

export type GetASRServiceDescriptorsOptions = {
    awsCredentialsProvider?: () => Promise<AwsTranscribeCredentials | null>;
    azureCredentialsProvider?: () => Promise<AzureSpeechCredentials | null>;
};

export const getConfiguredASRDescriptors = (
    options?: GetASRServiceDescriptorsOptions,
): ASRServiceDescriptor[] => {
    return [
        createWebSocketDescriptor({
            id: 'agent-default',
            label: 'Agent Speech (default)',
            wsUrl: getSpeechWsUrl(),
        }),
        createAwsDescriptor(options?.awsCredentialsProvider),
        createAzureDescriptor(options?.azureCredentialsProvider),
    ];
};

export const createInitialServiceStateMap = (
    descriptors: ASRServiceDescriptor[],
): Record<string, ASRServiceState> => {
    const initial: Record<string, ASRServiceState> = {};
    descriptors.forEach((descriptor) => {
        initial[descriptor.id] = {
            id: descriptor.id,
            label: descriptor.label,
            status: 'idle',
            transcript: '',
            finalTranscript: '',
            partialTranscript: '',
            errorMessage: null,
            lastInfoMessage: null,
            connectionLabel: descriptor.connectionLabel,
        };
    });
    return initial;
};

const createWebSocketDescriptor = (config: WebSocketASRServiceConfig): ASRServiceDescriptor => ({
    id: config.id,
    label: config.label,
    connectionLabel: config.wsUrl,
    createService: (callbacks) => new WebSocketASRService(config, callbacks),
});

const createAwsDescriptor = (
    credentialsProvider?: () => Promise<AwsTranscribeCredentials | null>,
): ASRServiceDescriptor => ({
    id: 'aws-transcribe',
    label: AWS_TRANSCRIBE_LABEL,
    connectionLabel: `aws://${AWS_TRANSCRIBE_REGION}`,
    createService: (callbacks) =>
        new AwsTranscribeService(
            {
                id: 'aws-transcribe',
                label: AWS_TRANSCRIBE_LABEL,
                region: AWS_TRANSCRIBE_REGION,
                languageCode: AWS_TRANSCRIBE_LANGUAGE,
                mediaEncoding: AWS_TRANSCRIBE_ENCODING,
                sampleRate: AWS_TRANSCRIBE_SAMPLE_RATE,
                credentialsProvider: credentialsProvider ?? (() => Promise.resolve(null)),
            },
            callbacks,
        ),
});

const createAzureDescriptor = (
    credentialsProvider?: () => Promise<AzureSpeechCredentials | null>,
): ASRServiceDescriptor => ({
    id: 'azure-speech',
    label: 'Azure Speech',
    connectionLabel: 'azure://speech',
    createService: (callbacks) =>
        new AzureSpeechService(
            {
                id: 'azure-speech',
                label: 'Azure Speech',
                language: 'en-US',
                credentialsProvider: credentialsProvider ?? (() => Promise.resolve(null)),
            },
            callbacks,
        ),
});

const getSpeechWsUrl = (): string => {
    return 'wss://domus-agent-738222537643.us-central1.run.app/agent/v1/speech/ws';
    // if (EXPLICIT_AGENT_WS_URL?.trim()) {
    //     return toAbsoluteWsUrl(EXPLICIT_AGENT_WS_URL);
    // }
    // const base = (DEFAULT_AGENT_BASE_URL?.trim() || '/api/agent') ?? '/api/agent';
    // const fullPath = joinPath(base, SPEECH_WS_PATH);
    // return toAbsoluteWsUrl(fullPath);
};

const joinPath = (base: string, suffix: string): string => {
    if (!base) {
        return suffix;
    }
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
    return `${normalizedBase}${normalizedSuffix}`;
};

const toAbsoluteWsUrl = (input: string): string => {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error('Speech WebSocket URL cannot be empty');
    }
    if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
        return trimmed;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const url = new URL(trimmed);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url.toString();
    }
    if (trimmed.startsWith('/')) {
        return trimmed;
    }
    return `/${trimmed}`;
};
