const API_BASE = 'http://localhost:3001';
const VERSION_ID = '43ae6e7c-3311-4a3a-9f88-72d15d5adbbf';
const AI_GATEWAY_API_KEY = 'vck_0MrIi2DLGhlJE8QoWAjy6jJavscxZDRPtcgJggdNV6SslAY4a94b6Ikz';

// 已经处理过的context（从上一次运行的日志中提取）
const PROCESSED_CONTEXTS = [
    "[Calcium-rich recipes for growing bones] 11/13 16:41",
    "[Suggest quick & healthy weeknight meals that take ...] 11/13 16:24",
    "[Light Chinese home-style dishes] 11/13 16:30",
    "[Pregnancy nutrition meal plan] 11/13 16:40",
    "[Recipes to reduce food waste] 11/13 16:31",
    "[High-protein, low-carb family meal ideas] 11/13 16:30",
    "[Thanksgiving menu for 12 people] 11/13 16:31",
    "[Economical family gathering menus] 11/13 16:31",
    "[Simple recipes kids can help cook] 11/13 16:30",
    "[Classroom party food ideas] 11/13 16:31",
    "[Non-perishable snack ideas for sports practice] 11/13 16:31",
    "[Create a weekly dinner plan for a family of 4 with...] 11/13 16:29",
    "[Dish to bring to a potluck] 11/13 16:31",
    "[Healthy lunchbox ideas that won't get traded] 11/13 16:31",
    "[Valentine's Day dinner that feels special but easy] 11/13 16:31",
    "[Dairy-free breakfast options for lactose intoleran...] 11/13 16:30",
    "[Healthy taco night variations] 11/13 16:30",
    "[Make-ahead meal prep ideas] 11/13 16:30",
    "[How to hide veggies in favorite foods] 11/13 16:30",
    "[Allergy-friendly birthday party foods] 11/13 16:31",
    "[Weekend meal prep recipes] 11/13 16:30",
    "[Kid-friendly pasta recipes] 11/13 16:30",
    "[Creative ways to use leftover turkey] 11/13 16:30",
    "[Post-sports recovery meals for teen athletes] 11/13 16:30",
    "[Christmas dinner timeline] 11/13 16:31",
    "[Ways to make vegetables more appealing to kids] 11/13 16:30",
    "[Give me a vegetarian meal plan that meat-eaters wi...] 11/13 16:30",
    "[Suggest quick & healthy weeknight meals that take ...] 11/13 16:30",
    "[How to cook once, eat twice] 11/13 16:30",
    "[Creative uses for leftover rice] 11/13 16:40"
];

async function getSubContexts() {
    try {
        const treeResponse = await fetch(`${API_BASE}/api/evaluations/tree`);
        if (!treeResponse.ok) {
            throw new Error('Failed to fetch tree');
        }
        const treeData = await treeResponse.json();
        const versions = treeData.data;

        const version = versions.find(v => v.id === VERSION_ID);
        if (!version) {
            throw new Error('Version not found');
        }

        const subContexts = [];

        const processContext = (context) => {
            if (context.children && context.children.length > 0) {
                context.children.forEach(child => {
                    const messages = child.resolvedMessages || [];
                    if (messages.length >= 2) {
                        const userMsg = messages[messages.length - 2];
                        const aiMsg = messages[messages.length - 1];

                        if (userMsg && aiMsg) {
                            subContexts.push({
                                contextId: child.id,
                                contextName: child.name,
                                userQuery: typeof userMsg.content === 'string' ? userMsg.content : JSON.stringify(userMsg.content),
                                aiResponse: typeof aiMsg.content === 'string' ? aiMsg.content : JSON.stringify(aiMsg.content),
                            });
                        }
                    }
                    processContext(child);
                });
            }
        };

        version.rootContexts.forEach(processContext);

        return subContexts;
    } catch (error) {
        console.error('Failed to get sub contexts:', error);
        throw error;
    }
}

async function generateCRUDCases(userQuery, aiResponse) {
    const prompt = `Given this conversation:

User Query: ${userQuery}

AI Response: ${aiResponse.substring(0, 2000)}

Generate TWO follow-up questions focused on UPDATE, SEARCH, or DELETE operations. These questions should:
1. Build upon both the user's original query AND the AI's response
2. Involve MODIFICATION, FINDING/SEARCHING, or DELETION operations with client features: calendar, tasks, meal plan, recipe, or shopping list
3. Be natural and contextually relevant
4. Be written in English
5. Focus on CRUD operations beyond just creating/adding

Examples of good CRUD follow-up questions:
- "Update the meal plan to swap Tuesday's dinner with Thursday's"
- "Find all recipes in my collection that use chicken"
- "Remove the broccoli from my shopping list"
- "Change the calendar event from 6pm to 7pm"
- "Delete all completed tasks from last week"
- "Search for low-carb recipes in my saved recipes"
- "Modify the ingredients in the Pasta recipe to be gluten-free"
- "Find all meal plans that include salmon"
- "Update my shopping list to remove items I already bought"
- "Delete the old meal plan from last month"

Return ONLY a JSON object with this format:
{
  "case1": "First follow-up question here",
  "case2": "Second follow-up question here"
}`;

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
                    model: "google/gemini-3-flash",
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
            throw new Error(`AI Gateway error: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const content = data.choices[0].message.content.trim();

        let jsonStr = content;
        if (content.includes('```json')) {
            jsonStr = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
        } else if (content.includes('```')) {
            jsonStr = content.replace(/```\s*/g, '');
        }
        jsonStr = jsonStr.trim();

        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            jsonStr = jsonMatch[0];
        }

        const result = JSON.parse(jsonStr);
        return {
            case1: result.case1,
            case2: result.case2,
        };
    } catch (error) {
        console.error('Failed to generate CRUD cases:', error);
        throw error;
    }
}

async function createCasesForContext(contextId, cases) {
    try {
        const response = await fetch(
            `${API_BASE}/api/evaluations/cases/batch`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contextId,
                    cases: cases.map(c => ({
                        userMessage: c,
                        evalRule: '',
                    })),
                }),
            }
        );

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create cases');
        }

        const result = await response.json();
        return result;
    } catch (error) {
        throw error;
    }
}

async function generateCRUDCasesForRemainingContexts() {
    console.log('🔍 Fetching all sub contexts...\n');

    const allSubContexts = await getSubContexts();
    console.log(`Found ${allSubContexts.length} sub contexts total\n`);

    // Filter out already processed contexts
    const remainingContexts = allSubContexts.filter(ctx =>
        !PROCESSED_CONTEXTS.includes(ctx.contextName)
    );

    console.log(`Remaining ${remainingContexts.length} contexts to process...\n`);

    let successCount = 0;
    let failureCount = 0;
    const errors = [];

    for (let i = 0; i < remainingContexts.length; i++) {
        const context = remainingContexts[i];
        const progress = `[${i + 1}/${remainingContexts.length}]`;

        try {
            console.log(`${progress} Processing "${context.contextName}"...`);

            const crudCases = await generateCRUDCases(
                context.userQuery,
                context.aiResponse
            );

            console.log(`  Generated CRUD cases:`);
            console.log(`    1. ${crudCases.case1}`);
            console.log(`    2. ${crudCases.case2}`);

            const result = await createCasesForContext(
                context.contextId,
                [crudCases.case1, crudCases.case2]
            );

            console.log(`  ✅ Created ${result.created} cases`);
            successCount++;

            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            console.log(`  ❌ Failed: ${error.message}`);
            failureCount++;
            errors.push({
                contextName: context.contextName,
                error: error.message,
            });
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 Summary:');
    console.log(`  ✅ Success: ${successCount} contexts (${successCount * 2} cases)`);
    console.log(`  ❌ Failed: ${failureCount} contexts`);

    if (errors.length > 0) {
        console.log('\n❌ Errors:');
        errors.forEach(e => {
            console.log(`  - ${e.contextName}: ${e.error}`);
        });
    }

    console.log('='.repeat(60));
}

generateCRUDCasesForRemainingContexts().catch(error => {
    console.error('\n💥 Fatal error:', error);
    process.exit(1);
});
