/**
 * Context 配置解析工具
 * 用于递归合并父节点的配置（environment, headers, messages）
 */

import type { Environment, Message } from "./models";

export interface ContextConfig {
    environment: Environment;
    headers: Record<string, string>;
    messages: Message[];
}

export interface ContextNode {
    id: string;
    parentContextId?: string;
    environment?: Environment;
    headers?: Record<string, string>;
    recentMessages?: Message[];
    contextSummary?: string;
}

/**
 * 解析 Context 的完整配置（递归合并父节点）
 * 使用覆盖式继承
 */
export function resolveContextConfig(
    context: ContextNode,
    getParent: (id: string) => ContextNode | null
): ContextConfig {
    // 递归终止条件：根节点
    if (!context.parentContextId) {
        return {
            environment: context.environment || {},
            headers: context.headers || {},
            messages: context.recentMessages || [],
        };
    }

    // 获取父节点
    const parent = getParent(context.parentContextId);
    if (!parent) {
        // 父节点不存在，返回当前节点配置
        return {
            environment: context.environment || {},
            headers: context.headers || {},
            messages: context.recentMessages || [],
        };
    }

    // 递归解析父节点配置
    const parentConfig = resolveContextConfig(parent, getParent);

    // 合并配置（覆盖式继承）
    return {
        // Environment: 浅合并，子节点字段覆盖父节点
        environment: {
            ...parentConfig.environment,
            ...context.environment,
        },
        // Headers: 浅合并，子节点字段覆盖父节点
        headers: {
            ...parentConfig.headers,
            ...context.headers,
        },
        // Messages: 追加，保持顺序（父 -> 子）
        messages: [
            ...parentConfig.messages,
            ...(context.recentMessages || []),
        ],
    };
}

/**
 * 获取从根到当前节点的路径
 * 返回: [root, parent, ..., current]
 */
export function getContextPath(
    context: ContextNode,
    getParent: (id: string) => ContextNode | null
): ContextNode[] {
    const path: ContextNode[] = [context];

    let current = context;
    while (current.parentContextId) {
        const parent = getParent(current.parentContextId);
        if (!parent) break;
        path.unshift(parent); // 添加到开头
        current = parent;
    }

    return path;
}

/**
 * 验证是否可以创建子节点
 * 检查深度限制（子节点数量限制已移除）
 */
export function canCreateChild(
    parentContext: { depth: number; childCount: number },
    maxDepth: number,
    maxChildren: number
): {
    canCreate: boolean;
    reason?: string;
} {
    // 检查深度限制
    if (parentContext.depth >= maxDepth) {
        return {
            canCreate: false,
            reason: `Maximum depth of ${maxDepth} reached`,
        };
    }

    // 子节点数量限制已移除
    // if (parentContext.childCount >= maxChildren) {
    //     return {
    //         canCreate: false,
    //         reason: `Maximum children count of ${maxChildren} reached`,
    //     };
    // }

    return { canCreate: true };
}

/**
 * 合并 Environment 对象（深度合并单个层级）
 */
export function mergeEnvironment(
    parent: Environment,
    child: Environment
): Environment {
    return {
        family_info: child.family_info || parent.family_info,
        user_brief: child.user_brief || parent.user_brief,
        chat_info: child.chat_info || parent.chat_info,
    };
}
