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

    useEffect(() => {
        // 通过 API 路由加载数据
        fetch('/api/evaluations/tree')
            .then(res => res.json())
            .then((result) => {
                const apiResult = result as ApiResponse;
                if (apiResult.data) {
                    setVersions(apiResult.data);
                }
            })
            .catch(error => {
                console.error('Failed to load evaluations:', error);
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

    return (
        <div className="flex h-[calc(100vh-4rem)] flex-col pb-6">
            <EvaluationWorkspace
                initialVersions={versions}
                className="flex-1"
            />
        </div>
    );
}