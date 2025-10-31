"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvaluationContext } from "@/lib/evaluations/models";

type SelectedNode =
    | { type: "version" }
    | { type: "context"; contextId: string }
    | { type: "case"; contextId: string; caseId: string };

interface ContextTreeNodeProps {
    context: EvaluationContext;
    selectedNode: SelectedNode;
    onSelectNode: (node: SelectedNode) => void;
    checkedCaseIds: Set<string>;
    onToggleCaseChecked: (caseId: string, checked: boolean) => void;
    level?: number;
    isRootContext?: boolean;
}

// Status emoji 映射
const statusEmojiMap: Record<string, string> = {
    succeeded: "✓",
    pending: "○",
    running: "●",
    failed: "✗",
    timeout: "⏱",
};

export function ContextTreeNode({
    context,
    selectedNode,
    onSelectNode,
    checkedCaseIds,
    onToggleCaseChecked,
    level = 0,
    isRootContext = false,
}: ContextTreeNodeProps) {
    const [isExpanded, setIsExpanded] = useState(false); // Cases 默认折叠
    const [childrenExpanded, setChildrenExpanded] = useState(true);

    const isActive =
        selectedNode.type === "context" &&
        selectedNode.contextId === context.id;

    const hasChildren = context.children && context.children.length > 0;
    const hasCases = (context.cases?.length || 0) > 0;

    // Calculate indentation based on depth (increased from 20px to 24px)
    const indentPx = level * 24;

    return (
        <div className="relative mb-2"> {/* 增加 Context 之间的间距 */}
            {/* Context row */}
            <div
                className={cn(
                    "flex items-center gap-2 px-3 py-2.5 border-l-2 transition-colors", // py-2 → py-2.5
                    isActive
                        ? "border-l-primary bg-primary/5"
                        : "border-l-transparent hover:bg-slate-50",
                )}
                style={{ paddingLeft: `${12 + indentPx}px` }}
            >
                {/* Expand/collapse button for children */}
                {hasChildren && (
                    <button
                        type="button"
                        onClick={() => setChildrenExpanded(!childrenExpanded)}
                        className="flex items-center justify-center size-4 hover:bg-slate-200 rounded transition-colors flex-shrink-0"
                        aria-label={childrenExpanded ? "Collapse children" : "Expand children"}
                    >
                        {childrenExpanded ? (
                            <ChevronDown className="size-3" />
                        ) : (
                            <ChevronRight className="size-3" />
                        )}
                    </button>
                )}

                {/* Spacer if no children */}
                {!hasChildren && <div className="size-4 flex-shrink-0" />}

                {/* Context button */}
                <button
                    type="button"
                    className={cn(
                        "flex flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors min-w-0", // 添加 min-w-0 使 truncate 生效
                        isActive
                            ? "bg-primary/10 text-primary font-medium"
                            : "hover:bg-slate-100",
                    )}
                    onClick={() =>
                        onSelectNode({
                            type: "context",
                            contextId: context.id,
                        })
                    }
                    title={context.name} // 添加 tooltip 显示完整名称
                >
                    <span className="flex items-center gap-2 min-w-0 flex-1"> {/* 添加 min-w-0 和 flex-1 */}
                        {/* 使用图标替代 emoji */}
                        {childrenExpanded ? (
                            <FolderOpen className="size-4 text-slate-500 flex-shrink-0" />
                        ) : (
                            <Folder className="size-4 text-slate-500 flex-shrink-0" />
                        )}
                        <span className="truncate">{context.name}</span> {/* 添加 truncate */}
                    </span>

                    <div className="flex items-center gap-2 flex-shrink-0">
                        {/* 只在折叠时显示 Cases count */}
                        {hasCases && !isExpanded && (
                            <Badge variant="outline" className="text-xs">
                                {context.cases?.length || 0}
                            </Badge>
                        )}

                        {/* 只在折叠时显示 Children count */}
                        {hasChildren && !childrenExpanded && (
                            <Badge variant="outline" className="text-xs">
                                {context.children.length}
                            </Badge>
                        )}
                    </div>
                </button>

                {/* Expand/collapse button for cases */}
                {hasCases && (
                    <button
                        type="button"
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="flex items-center justify-center size-4 hover:bg-slate-200 rounded transition-colors flex-shrink-0"
                        aria-label={isExpanded ? "Collapse cases" : "Expand cases"}
                    >
                        {isExpanded ? (
                            <ChevronDown className="size-3" />
                        ) : (
                            <ChevronRight className="size-3" />
                        )}
                    </button>
                )}
            </div>

            {/* Cases */}
            {isExpanded && hasCases && (
                <div className="border-t bg-slate-50/50">
                    {context.cases?.map((testCase) => {
                        const caseSelected =
                            selectedNode.type === "case" &&
                            selectedNode.caseId === testCase.id;
                        const status = testCase.lastRunSummary?.status;

                        return (
                            <div
                                key={testCase.id}
                                className="flex items-center gap-2 px-4 py-2.5" // py-2 → py-2.5
                                style={{ paddingLeft: `${36 + indentPx}px` }} // 从 32px 增加到 36px
                            >
                                <Checkbox
                                    checked={checkedCaseIds.has(testCase.id)}
                                    onCheckedChange={(value) =>
                                        onToggleCaseChecked(
                                            testCase.id,
                                            value === true,
                                        )
                                    }
                                    className="flex-shrink-0"
                                />
                                <button
                                    type="button"
                                    onClick={() =>
                                        onSelectNode({
                                            type: "case",
                                            contextId: context.id,
                                            caseId: testCase.id,
                                        })
                                    }
                                    className={cn(
                                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors min-w-0", // 添加 min-w-0
                                        caseSelected
                                            ? "bg-primary/5 text-primary"
                                            : "hover:bg-slate-100",
                                    )}
                                    title={testCase.title} // 添加 tooltip
                                >
                                    <span className="flex items-center gap-2 min-w-0 flex-1"> {/* 添加 min-w-0 和 flex-1 */}
                                        <FileText className="size-4 text-slate-400 flex-shrink-0" /> {/* 使用 FileText 替代 ChevronRight */}
                                        <span className="truncate">{testCase.title}</span> {/* 添加 truncate */}
                                    </span>
                                    {status && (
                                        <Badge
                                            variant={
                                                status === "succeeded"
                                                    ? "default"
                                                    : status === "failed"
                                                      ? "destructive"
                                                      : "secondary"
                                            }
                                            className="text-xs flex-shrink-0"
                                        >
                                            {statusEmojiMap[status] || status}
                                        </Badge>
                                    )}
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Child contexts (recursive) */}
            {childrenExpanded && hasChildren && (
                <div>
                    {context.children.map((child) => (
                        <ContextTreeNode
                            key={child.id}
                            context={child}
                            selectedNode={selectedNode}
                            onSelectNode={onSelectNode}
                            checkedCaseIds={checkedCaseIds}
                            onToggleCaseChecked={onToggleCaseChecked}
                            level={level + 1}
                            isRootContext={false}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
