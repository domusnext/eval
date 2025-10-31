/**
 * 简单的文本格式化组件
 * 支持基本的 markdown 格式：加粗、斜体、列表等
 * 不需要额外依赖
 */

"use client";

import { Fragment } from "react";
import type { ReactElement, JSX } from "react";

function parseMarkdown(text: string): ReactElement[] {
    const lines = text.split('\n');
    const elements: ReactElement[] = [];
    let key = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 空行
        if (line.trim() === '') {
            elements.push(<br key={key++} />);
            continue;
        }

        // 无序列表 (- item 或 * item)
        const unorderedListMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
        if (unorderedListMatch) {
            elements.push(
                <div key={key++} className="flex items-start gap-2 my-1">
                    <span className="text-slate-600 mt-0.5">•</span>
                    <span>{parseInlineMarkdown(unorderedListMatch[1])}</span>
                </div>
            );
            continue;
        }

        // 有序列表 (1. item, 2. item, etc.)
        const orderedListMatch = line.match(/^[\s]*(\d+)\.\s+(.+)$/);
        if (orderedListMatch) {
            elements.push(
                <div key={key++} className="flex items-start gap-2 my-1">
                    <span className="text-slate-600 mt-0.5">{orderedListMatch[1]}.</span>
                    <span>{parseInlineMarkdown(orderedListMatch[2])}</span>
                </div>
            );
            continue;
        }

        // 标题 (## Title)
        const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            const HeadingTag = `h${level + 2}` as keyof JSX.IntrinsicElements; // h3, h4, h5
            elements.push(
                <HeadingTag
                    key={key++}
                    className={`font-bold mb-1 ${level === 1 ? 'text-base' : 'text-sm'}`}
                >
                    {parseInlineMarkdown(headingMatch[2])}
                </HeadingTag>
            );
            continue;
        }

        // 普通段落
        elements.push(
            <p key={key++} className="my-1">
                {parseInlineMarkdown(line)}
            </p>
        );
    }

    return elements;
}

function parseInlineMarkdown(text: string): (string | ReactElement)[] {
    const parts: (string | ReactElement)[] = [];
    let remaining = text;
    let key = 0;

    while (remaining) {
        // 加粗 **text** 或 __text__
        const boldMatch = remaining.match(/^(.*?)(\*\*|__)(.*?)\2(.*)$/);
        if (boldMatch && boldMatch[3]) {
            if (boldMatch[1]) parts.push(boldMatch[1]);
            parts.push(
                <strong key={key++} className="font-semibold text-slate-900">
                    {boldMatch[3]}
                </strong>
            );
            remaining = boldMatch[4];
            continue;
        }

        // 斜体 *text* 或 _text_ (但不是 ** 或 __)
        const italicMatch = remaining.match(/^(.*?)([*_])([^*_]+?)\2(.*)$/);
        if (italicMatch && italicMatch[3] && !italicMatch[1].endsWith('*') && !italicMatch[1].endsWith('_')) {
            if (italicMatch[1]) parts.push(italicMatch[1]);
            parts.push(
                <em key={key++} className="italic text-slate-800">
                    {italicMatch[3]}
                </em>
            );
            remaining = italicMatch[4];
            continue;
        }

        // 行内代码 `code`
        const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)$/);
        if (codeMatch && codeMatch[2]) {
            if (codeMatch[1]) parts.push(codeMatch[1]);
            parts.push(
                <code key={key++} className="bg-slate-100 text-slate-900 px-1 py-0.5 rounded text-xs font-mono">
                    {codeMatch[2]}
                </code>
            );
            remaining = codeMatch[3];
            continue;
        }

        // 没有更多匹配，添加剩余文本
        parts.push(remaining);
        break;
    }

    return parts;
}

export function MarkdownRenderer({ content }: { content: string }) {
    if (!content) return null;

    const elements = parseMarkdown(content);

    return (
        <div className="text-slate-900 leading-relaxed">
            {elements.map((element, index) => (
                <Fragment key={index}>{element}</Fragment>
            ))}
        </div>
    );
}
