'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAudioStream } from '@/lib/recorder/recordrtc';
import type { ASRServiceState, ServiceStatus, StreamingASRService } from '@/lib/recorder/asr-service-base';
import {
    createInitialServiceStateMap,
    getConfiguredASRDescriptors,
    type ASRServiceDescriptor,
} from '@/lib/recorder/asr-service-config';
import type { AwsTranscribeCredentials } from '@/lib/recorder/aws-transcribe-service';

type SessionStatus = 'idle' | 'connecting' | 'recording' | 'stopping' | 'error';

const toErrorMessage = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
};

const formatServiceStatus = (status: ServiceStatus): string => {
    switch (status) {
        case 'idle':
            return 'idle';
        case 'connecting':
            return 'connecting';
        case 'ready':
            return 'ready';
        case 'streaming':
            return 'streaming';
        case 'stopping':
            return 'stopping';
        case 'closed':
            return 'closed';
        case 'error':
            return 'error';
        default:
            return status;
    }
};

const shouldDisableStart = (status: SessionStatus): boolean =>
    status === 'connecting' || status === 'recording' || status === 'stopping';

const shouldDisableStop = (status: SessionStatus): boolean => status === 'idle';

const parseAwsCredentialsInput = (input: string): AwsTranscribeCredentials | null => {
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }
    try {
        const parsed = JSON.parse(trimmed) as Partial<AwsTranscribeCredentials>;
        if (typeof parsed.accessKeyId === 'string' && typeof parsed.secretAccessKey === 'string') {
            return {
                accessKeyId: parsed.accessKeyId,
                secretAccessKey: parsed.secretAccessKey,
                sessionToken: typeof parsed.sessionToken === 'string' ? parsed.sessionToken : undefined,
            };
        }
    } catch {
        return null;
    }
    return null;
};

export default function ASRTestPage() {
    const [awsToken, setAwsToken] = useState('');
    const [azureKey, setAzureKey] = useState('');
    const [azureRegion, setAzureRegion] = useState('');

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }
        const storedAws = window.localStorage.getItem('asr.awsToken');
        if (storedAws) {
            setAwsToken(storedAws);
        }
        const storedAzureKey = window.localStorage.getItem('asr.azureKey');
        if (storedAzureKey) {
            setAzureKey(storedAzureKey);
        }
        const storedAzureRegion = window.localStorage.getItem('asr.azureRegion');
        if (storedAzureRegion) {
            setAzureRegion(storedAzureRegion);
        }
    }, []);
    const awsCredentialsProvider = useCallback(async () => parseAwsCredentialsInput(awsToken), [awsToken]);
    const azureCredentialsProvider = useCallback(async () => {
        const key = azureKey.trim();
        const region = azureRegion.trim();
        if (!region || !key) {
            return null;
        }
        return { key, region };
    }, [azureKey, azureRegion]);
    const serviceDescriptors = useMemo<ASRServiceDescriptor[]>(
        () => getConfiguredASRDescriptors({ awsCredentialsProvider, azureCredentialsProvider }),
        [awsCredentialsProvider, azureCredentialsProvider],
    );
    const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle');
    const [sessionError, setSessionError] = useState<string | null>(null);
    const [serviceStates, setServiceStates] = useState<Record<string, ASRServiceState>>(() =>
        createInitialServiceStateMap(serviceDescriptors),
    );

    const servicesRef = useRef<Map<string, StreamingASRService>>(new Map());
    const recorderRef = useRef<RecordRTC | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);

    const instantiateServices = useCallback(() => {
        const map = new Map<string, StreamingASRService>();
        const initialState: Record<string, ASRServiceState> = {};

        serviceDescriptors.forEach((descriptor) => {
            const service = descriptor.createService({
                onStateChange: (state) => {
                    setServiceStates((prev) => ({ ...prev, [descriptor.id]: state }));
                },
            });
            map.set(descriptor.id, service);
            initialState[descriptor.id] = service.getState();
        });

        setServiceStates(initialState);
        return map;
    }, [serviceDescriptors]);

    const cleanupMedia = useCallback(async () => {
        const recorder = recorderRef.current;
        recorderRef.current = null;
        if (recorder) {
            await new Promise<void>((resolve) => {
                try {
                    recorder.stopRecording(() => {
                        try {
                            recorder.destroy();
                        } catch {
                            // ignore destroy failures
                        }
                        resolve();
                    });
                } catch (error) {
                    console.error('Unable to stop recorder', error);
                    resolve();
                }
            });
        }

        const stream = mediaStreamRef.current;
        mediaStreamRef.current = null;
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
        }
    }, []);

    const stopAllServices = useCallback(() => {
        servicesRef.current.forEach((service) => {
            service.stop();
        });
        servicesRef.current.clear();
    }, []);

    const stopStreaming = useCallback(async () => {
        setSessionStatus((prev) => (prev === 'idle' ? 'idle' : 'stopping'));
        stopAllServices();
        await cleanupMedia();
        setSessionStatus('idle');
    }, [cleanupMedia, stopAllServices]);

    useEffect(() => {
        return () => {
            void stopStreaming();
        };
    }, [stopStreaming]);

    const startStreaming = useCallback(async () => {
        if (sessionStatus === 'connecting' || sessionStatus === 'recording' || sessionStatus === 'stopping') {
            return;
        }

        if (!serviceDescriptors.length) {
            setSessionError('No ASR providers configured.');
            setSessionStatus('error');
            return;
        }

        setSessionError(null);
        setSessionStatus('connecting');

        if (typeof window !== 'undefined') {
            window.localStorage.setItem('asr.awsToken', awsToken);
            window.localStorage.setItem('asr.azureKey', azureKey);
            window.localStorage.setItem('asr.azureRegion', azureRegion);
        }

        const services = instantiateServices();
        servicesRef.current = services;
        services.forEach((service) => service.start());

        try {
            const { recorder, stream } = await getAudioStream(async (blob) => {
                if (!servicesRef.current.size) {
                    return;
                }
                try {
                    const buffer = await blob.arrayBuffer();
                    servicesRef.current.forEach((service) => service.sendAudioChunk(buffer));
                } catch (error) {
                    console.error('Failed to broadcast audio chunk', error);
                }
            });
            recorderRef.current = recorder;
            mediaStreamRef.current = stream;
            setSessionStatus('recording');
        } catch (error) {
            stopAllServices();
            servicesRef.current.clear();
            setSessionError(`Microphone error: ${toErrorMessage(error)}`);
            setSessionStatus('error');
        }
    }, [instantiateServices, serviceDescriptors.length, sessionStatus, stopAllServices]);

    const handleStop = useCallback(() => {
        void stopStreaming();
    }, [stopStreaming]);

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
            <div className="space-y-1">
                <h1 className="text-2xl font-semibold">ASR Comparison Test</h1>
                <p className="text-sm text-muted-foreground">
                    Broadcast your microphone to every provider and compare interim/final transcripts live.
                </p>
            </div>

            <div className="flex flex-wrap gap-3">
                <button
                    className="flex-1 min-w-[120px] rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
                    disabled={shouldDisableStart(sessionStatus)}
                    onClick={() => {
                        void startStreaming();
                    }}
                >
                    {sessionStatus === 'connecting'
                        ? 'Connecting…'
                        : sessionStatus === 'recording'
                            ? 'Streaming…'
                            : 'Start session'}
                </button>
                <button
                    className="flex-1 min-w-[120px] rounded border border-gray-300 px-4 py-2 disabled:opacity-50"
                    disabled={shouldDisableStop(sessionStatus)}
                    onClick={handleStop}
                >
                    Stop session
                </button>
                <div className="rounded border border-dashed px-4 py-2 text-sm">
                    <span className="font-medium">Recorder status:</span> {sessionStatus}
                </div>
            </div>

            <details className="rounded border bg-white/70 shadow-sm">
                <summary className="cursor-pointer select-none px-4 py-3 font-medium">
                    Credentials & Settings
                </summary>
                <div className="grid gap-4 border-t px-4 py-4 text-sm sm:grid-cols-2">
                    <div className="flex flex-col gap-2 sm:col-span-2">
                        <label className="font-medium" htmlFor="aws-token">
                            AWS Token (JSON)
                        </label>
                        <textarea
                            id="aws-token"
                            className="min-h-[80px] rounded border p-3 font-mono"
                            placeholder='{"accessKeyId":"","secretAccessKey":"","sessionToken":""}'
                            value={awsToken}
                            onChange={(event) => setAwsToken(event.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                            Paste temporary AWS credentials. Leaving this empty only disables AWS while other services keep running.
                        </p>
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="font-medium" htmlFor="azure-region">
                            Azure Region
                        </label>
                        <input
                            id="azure-region"
                            className="rounded border p-2"
                            placeholder="e.g. eastus"
                            value={azureRegion}
                            onChange={(event) => setAzureRegion(event.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <label className="font-medium" htmlFor="azure-key">
                            Azure Speech Key
                        </label>
                        <input
                            id="azure-key"
                            className="rounded border p-2"
                            placeholder="Paste speech key"
                            value={azureKey}
                            onChange={(event) => setAzureKey(event.target.value)}
                        />
                    </div>
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                        Provide Azure Speech credentials to enable Microsoft streaming. Missing values affect only the Azure card.
                    </p>
                </div>
            </details>

            {sessionError ? (
                <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
                    {sessionError}
                </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {serviceDescriptors.map((descriptor) => {
                    const state = serviceStates[descriptor.id];
                    if (!state) {
                        return null;
                    }
                    return (
                        <div key={descriptor.id} className="flex flex-col gap-3 rounded border p-4">
                            <div className="flex flex-col gap-1">
                                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                    <div className="min-w-0">
                                        <p className="font-semibold truncate">{state.label}</p>
                                        {state.connectionLabel ? (
                                            <p className="break-all text-xs text-muted-foreground">{state.connectionLabel}</p>
                                        ) : null}
                                    </div>
                                    <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium capitalize">
                                        {formatServiceStatus(state.status)}
                                    </span>
                                </div>
                                {state.lastInfoMessage ? (
                                    <p className="text-xs text-muted-foreground">Info: {state.lastInfoMessage}</p>
                                ) : null}
                            </div>
                            {state.errorMessage ? (
                                <div className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                                    {state.errorMessage}
                                </div>
                            ) : null}
                            <div className="min-h-[90px] max-h-[150px] w-full rounded border bg-white/80 p-3 text-xs leading-relaxed text-gray-800 shadow-inner">
                                {state.transcript || <span className="text-muted-foreground">Waiting for transcript…</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
