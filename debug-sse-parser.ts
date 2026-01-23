/**
 * 调试脚本：检查 SSE 响应解析
 * 运行方式: npx tsx debug-sse-parser.ts <response-file>
 */

import fs from 'fs';

interface SSEEvent {
    type?: string;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    input?: Record<string, unknown>;
    output?: {
        success?: boolean;
        modelVisibleData?: {
            data?: unknown;
        };
    };
    [key: string]: unknown;
}

function parseSSEResponse(responseText: string): SSEEvent[] {
    const lines = responseText.split("\n");
    const events: SSEEvent[] = [];
    const eventTypes = new Map<string, number>();

    for (const line of lines) {
        if (line.startsWith("data: ")) {
            try {
                const jsonStr = line.substring(6);
                const event = JSON.parse(jsonStr) as SSEEvent;
                events.push(event);

                // 统计事件类型
                const type = event.type || "unknown";
                eventTypes.set(type, (eventTypes.get(type) || 0) + 1);
            } catch (error) {
                console.error("❌ Failed to parse line:", line.substring(0, 100));
            }
        }
    }

    // 打印统计信息
    console.log("\n📊 Event Type Statistics:");
    console.log("=" .repeat(50));
    for (const [type, count] of Array.from(eventTypes.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`${type.padEnd(30)} : ${count}`);
    }
    console.log("=" .repeat(50));
    console.log(`Total events: ${events.length}\n`);

    return events;
}

function analyzeToolEvents(events: SSEEvent[]) {
    console.log("\n🔧 Tool-Related Events:");
    console.log("=" .repeat(50));

    let toolCallCount = 0;
    let toolResultCount = 0;
    let otherToolEvents = 0;

    events.forEach((event, index) => {
        const type = event.type || "";

        // 检查所有可能包含 tool 的事件
        if (type.toLowerCase().includes("tool")) {
            console.log(`\nEvent #${index + 1}:`);
            console.log(`  Type: ${type}`);
            console.log(`  Full event:`, JSON.stringify(event, null, 2).substring(0, 300));

            if (type === "tool-call") toolCallCount++;
            else if (type === "tool-result") toolResultCount++;
            else otherToolEvents++;
        }
    });

    console.log("\n" + "=".repeat(50));
    console.log(`Tool Call events: ${toolCallCount}`);
    console.log(`Tool Result events: ${toolResultCount}`);
    console.log(`Other tool-related events: ${otherToolEvents}`);
    console.log("=" .repeat(50));
}

// 主程序
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: npx tsx debug-sse-parser.ts <response-file-or-text>");
    console.error("\nExample:");
    console.error("  npx tsx debug-sse-parser.ts response.txt");
    process.exit(1);
}

let responseText: string;
const input = args[0];

// 尝试作为文件读取
if (fs.existsSync(input)) {
    responseText = fs.readFileSync(input, 'utf-8');
    console.log(`📄 Reading from file: ${input}`);
} else {
    // 作为直接输入的文本
    responseText = input;
    console.log(`📝 Using provided text (${responseText.length} chars)`);
}

const events = parseSSEResponse(responseText);
analyzeToolEvents(events);

console.log("\n✅ Analysis complete!");
