/**
 * AI 评估工具
 * 使用 Vercel AI Gateway 调用 Gemini 来评估 case response
 */

import { AI_GATEWAY_API_KEY } from "@/../../apikey";

export type EvaluationResult = {
    resultOverview: string;
    score: 0 | 1;
};

/**
 * 评估 response 是否满足 evaluation rule
 */
export async function evaluateResponse(
    evalRule: string,
    responseContent: string,
    contextSummary?: string
): Promise<EvaluationResult> {
    console.log("[AI Evaluator] Starting evaluation...");
    console.log(`[AI Evaluator] Eval Rule: ${evalRule.substring(0, 100)}...`);
    console.log(`[AI Evaluator] Response length: ${responseContent.length} chars`);

    // 获取当前日期和星期几
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weekday = weekdays[now.getDay()];
    const dateString = `${year}-${month}-${day} (${weekday})`;

    const contextBackground = contextSummary
        ? `Context Background:\n${contextSummary}\n\n`
        : "";

    const prompt = `${contextBackground}You are an evaluation assistant. Your task is to evaluate whether an AI agent's response meets the specified evaluation criteria.

Evaluation Rule:
${evalRule}

AI Agent Response:
${responseContent}

Please evaluate the response and provide your assessment in the following JSON format:
{
  "resultOverview": "First, summarize what the AI response did in 1-2 sentences.\\n\\nThen, explain whether it satisfies the evaluation rule and why (2-3 sentences).",
  "score": 1 or 0
}

Current Date: ${dateString}

Guidelines:
- score: 1 if the response satisfies the evaluation rule, 0 if it does not
- resultOverview: Use the same language as the evaluation rule and response
- Be objective and specific in your reasoning
- Consider both the content and quality of the response

Return ONLY the JSON object, no additional text.`;

    try {
        const response = await fetch(
            "https://ai-gateway.vercel.sh/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${AI_GATEWAY_API_KEY}`,
                },
                body: JSON.stringify({
                    model: "google/gemini-2.5-flash",
                    messages: [
                        {
                            role: "user",
                            content: prompt,
                        },
                    ],
                    stream: false,
                }),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error(
                "[AI Evaluator] AI Gateway error:",
                response.status,
                errorText
            );
            throw new Error(
                `AI Gateway returned ${response.status}: ${errorText}`
            );
        }

        const data = (await response.json()) as {
            choices?: Array<{
                message?: {
                    content?: string;
                };
            }>;
        };

        if (
            !data.choices ||
            data.choices.length === 0 ||
            !data.choices[0].message?.content
        ) {
            console.error("[AI Evaluator] No content in AI response");
            throw new Error("No content in AI response");
        }

        const content = data.choices[0].message.content.trim();
        console.log("[AI Evaluator] Raw AI response:");
        console.log(content);

        // 解析 JSON（移除可能的 markdown 代码块标记）
        let jsonStr = content;
        if (jsonStr.includes("```json")) {
            jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
        } else if (jsonStr.includes("```")) {
            jsonStr = jsonStr.replace(/```\s*/g, "");
        }

        // 清理可能的前后空白
        jsonStr = jsonStr.trim();

        console.log("[AI Evaluator] Cleaned JSON string:");
        console.log(jsonStr);

        let result: { resultOverview: string; score: number };
        try {
            result = JSON.parse(jsonStr) as {
                resultOverview: string;
                score: number;
            };
        } catch (parseError) {
            console.error("[AI Evaluator] JSON parse failed:");
            console.error("Error:", parseError);
            console.error("JSON string:", jsonStr);
            throw new Error(
                `Failed to parse AI response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            );
        }

        // 验证返回格式
        if (
            typeof result.resultOverview !== "string" ||
            (result.score !== 0 && result.score !== 1)
        ) {
            console.error("[AI Evaluator] Invalid result format:", result);
            throw new Error("Invalid evaluation result format");
        }

        console.log(
            `[AI Evaluator] Evaluation complete. Score: ${result.score}`
        );
        console.log(
            `[AI Evaluator] Overview: ${result.resultOverview.substring(0, 100)}...`
        );

        return {
            resultOverview: result.resultOverview,
            score: result.score as 0 | 1,
        };
    } catch (error) {
        console.error("[AI Evaluator] Failed to evaluate response:", error);
        throw error;
    }
}
