'use client';

export type ServiceStatus =
    | 'idle'
    | 'connecting'
    | 'ready'
    | 'streaming'
    | 'stopping'
    | 'closed'
    | 'error';

export type ASRServiceState = {
    id: string;
    label: string;
    status: ServiceStatus;
    transcript: string;
    finalTranscript: string;
    partialTranscript: string;
    errorMessage: string | null;
    lastInfoMessage: string | null;
    connectionLabel: string | null;
};

export type ASRServiceCallbacks = {
    onStateChange?: (state: ASRServiceState) => void;
};

export interface StreamingASRService {
    start(): void;
    stop(reason?: string): void;
    sendAudioChunk(chunk: ArrayBuffer): void;
    getState(): ASRServiceState;
}

export const appendSegment = (base: string, addition: string): string => {
    if (!base) {
        return addition;
    }
    if (!addition) {
        return base;
    }
    const needsSpace = !base.endsWith(' ') && !addition.startsWith(' ');
    return `${base}${needsSpace ? ' ' : ''}${addition}`;
};

