import { EvaluationWorkspace } from "@/components/evaluations/evaluation-workspace";
import { fetchEvaluationTree } from "@/lib/evaluations/repository";

export const dynamic = "force-dynamic";

export default async function EvaluationsPage() {
    const versions = await fetchEvaluationTree();

    return (
        <div className="flex h-[calc(100vh-4rem)] flex-col pb-6">
            <EvaluationWorkspace
                initialVersions={versions}
                className="flex-1"
            />
        </div>
    );
}
