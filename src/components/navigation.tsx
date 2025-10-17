import { BrainCircuit, LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export function Navigation() {
    return (
        <nav className="border-b bg-white sticky top-0 z-50">
            <div className="container mx-auto px-4 py-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-6">
                        <Link
                            href="/"
                            className="flex items-center gap-2 text-xl font-bold text-gray-900"
                        >
                            <BrainCircuit className="size-5 text-primary" />
                            EvalWorkspace
                        </Link>
                        <div className="hidden items-center space-x-4 md:flex">
                            <Link href="/evaluations">
                                <Button variant="ghost" size="sm">
                                    <LayoutDashboard className="mr-2 h-4 w-4" />
                                    Workspace
                                </Button>
                            </Link>
                        </div>
                    </div>
                </div>
            </div>
        </nav>
    );
}
