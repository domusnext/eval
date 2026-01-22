'use client';
import { EvaluationVersion } from "@/lib/evaluations/models";
import { EvaluationWorkspace } from "@/components/evaluations/evaluation-workspace";
import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";

type ApiResponse = {
    data?: EvaluationVersion[];
    error?: string;
};

export default function EvaluationsPage() {
    const [versions, setVersions] = useState<EvaluationVersion[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // 通过 API 路由加载数据
        fetch('/api/evaluations/tree')
            .then(res => {
                if (!res.ok) {
                    return res.json().then((data: any) => {
                        throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
                    });
                }
                return res.json();
            })
            .then((result) => {
                const apiResult = result as ApiResponse;
                if (apiResult.data) {
                    console.log('[Evaluations Page] Loaded data:', {
                        versionCount: apiResult.data.length,
                        firstVersion: apiResult.data[0]
                    });
                    setVersions(apiResult.data);
                } else {
                    console.warn('[Evaluations Page] No data in response:', result);
                }
            })
            .catch((error: Error) => {
                console.error('[Evaluations Page] Failed to load evaluations:', error);
                setError(error.message || 'Failed to load evaluations');
            })
            .finally(() => {
                setIsLoading(false);
            });
    }, []);

    // 数据加载完成前显示加载状态
    if (isLoading) {
        return (
            <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
                <div className="text-muted-foreground">Loading evaluations...</div>
            </div>
        );
    }

    // 显示错误状态
    if (error) {
        return (
            <div className="flex h-[calc(100vh-4rem)] items-center justify-center p-6">
                <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-4">
                    <h2 className="font-semibold text-red-900">Failed to load evaluations</h2>
                    <p className="mt-2 text-sm text-red-800">{error}</p>
                    <p className="mt-3 text-xs text-red-700">
                        <strong>Troubleshooting:</strong> Check the database connection by visiting{' '}
                        <code className="inline-block rounded bg-red-100 px-2 py-1">/api/debug/db-check</code>
                    </p>
                    <button
                        onClick={() => window.location.reload()}
                        className="mt-4 inline-block rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
                    >
                        Retry
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-[calc(100vh-4rem)] flex-col pb-6">
            <EvaluationWorkspace
                initialVersions={versions}
                className="flex-1"
            />
        </div>
    );
}