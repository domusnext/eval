'use client';
import { EvaluationWorkspace } from "@/components/evaluations/evaluation-workspace";
import { EvaluationVersion } from "@/lib/evaluations/models";
import { fetchEvaluationTree } from "@/lib/evaluations/repository";
import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";

export default async function EvaluationsPage() {
    const [versions, setVersions] = useState<EvaluationVersion[]>([]);
    useEffect(() => {
        fetchEvaluationTree().then(setVersions);
    }, []);

    return (
        <div className="flex h-[calc(100vh-4rem)] flex-col pb-6">
            <EvaluationWorkspace
                initialVersions={versions}
                className="flex-1"
            />
        </div>
    );
}