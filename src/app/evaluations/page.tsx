import { EvaluationWorkspace } from "@/components/evaluations/evaluation-workspace";
import { fetchEvaluationTree } from "@/lib/evaluations/repository";

export const dynamic = "force-dynamic";

export default async function EvaluationsPage() {
    const versions = await fetchEvaluationTree();

    return (
        <div className="container mx-auto my-10 px-4">
            <div className="mb-6">
                <h1 className="text-3xl font-bold text-slate-900">
                    Evaluation Workspace
                </h1>
                <p className="mt-2 text-slate-600">
                    Browse contexts, cases, and payload details for each
                    evaluation version.
                </p>
            </div>
            <EvaluationWorkspace initialVersions={versions} />
        </div>
    );
}
