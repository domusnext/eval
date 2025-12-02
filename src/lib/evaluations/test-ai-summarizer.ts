/**
 * 测试 AI 总结功能
 * 运行方式: tsx src/lib/evaluations/test-ai-summarizer.ts
 */

import { generateContextSummary } from "./ai-summarizer";
import type { Message } from "./models";

async function testAISummarizer() {
    console.log("=== Testing AI Summarizer ===\n");

    // 测试用的消息
    const testMessages: Message[] = [
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: "你好，我想了解一下今天的天气情况",
                },
            ],
        },
        {
            role: "assistant",
            content: [
                {
                    type: "text",
                    text: "你好！今天北京的天气是晴天，气温在20-28度之间，适合外出活动。需要我为您提供更详细的信息吗？",
                },
            ],
        },
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: "那明天会下雨吗？",
                },
            ],
        },
        {
            role: "assistant",
            content: [
                {
                    type: "text",
                    text: "根据天气预报，明天有60%的降雨概率，建议您出门带伞。降雨时间预计在下午2点到5点之间。",
                },
            ],
        },
    ];

    console.log(`Testing with ${testMessages.length} messages...\n`);

    try {
        const summary = await generateContextSummary(testMessages);

        console.log("\n=== Result ===");
        console.log("Summary generated successfully!");
        console.log("\nSummary:");
        console.log(summary);
        console.log("\n=== Test Passed ===");
    } catch (error) {
        console.error("\n=== Test Failed ===");
        console.error("Error:", error);
    }
}

// 运行测试
testAISummarizer();
