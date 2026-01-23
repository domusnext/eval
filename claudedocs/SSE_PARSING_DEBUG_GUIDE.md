# SSE 响应解析问题调试指南

## 问题描述
Agent 执行结果在前端展示不全，具体表现：
- ✅ 有 tool result
- ❌ 缺少 tool call
- ❌ 看不到完整的执行过程

## 根本原因分析

### 可能的原因
1. **事件类型识别问题**：SSE 响应中的事件类型名称与代码中的不匹配
2. **字段缺失问题**：tool-call 事件缺少必需字段（toolName, toolCallId, input）
3. **静默丢弃**：字段验证失败时，事件被静默跳过，没有错误提示

### 代码位置
`src/lib/evaluations/response-converter.ts`
- Line 159: tool-call 字段验证（严格要求 3 个字段都存在）
- Line 216: tool-result 字段验证（严格要求 2 个字段都存在）

## 诊断步骤

### 1. 运行一次 Case 测试
在前端执行任意一个 Case，观察浏览器控制台输出。

### 2. 查看事件统计日志
```
[ResponseConverter] Event type statistics: {
  "text-delta": 15,
  "tool-call": 3,    // ← 应该有 tool-call 事件
  "tool-result": 3,
  ...
}
[ResponseConverter] Total events: 21
```

**检查点**：
- ✅ 如果有 "tool-call" 事件 → 继续下一步
- ❌ 如果没有 "tool-call" 事件 → **事件类型命名问题**

### 3. 查看 tool-call 字段完整性
```
[ResponseConverter] tool-call event: {
  hasToolName: true,
  hasToolCallId: true,
  hasInput: true,     // ← 所有字段都应该是 true
  toolName: "Read",
  toolCallId: "call_123"
}
```

**检查点**：
- ✅ 所有字段都是 `true` → 应该看到 "✅ Adding tool-call"
- ❌ 任何字段是 `false` → 会看到 "⚠️ Skipped tool-call due to missing fields"

### 4. 查看最终消息统计
```
[ResponseConverter] Conversion complete: {
  totalMessages: 4,
  messageRoles: ["user", "assistant", "tool", "assistant"],
  assistantToolCalls: 3,  // ← 应该 > 0
  toolResults: 3
}
```

**检查点**：
- ✅ `assistantToolCalls > 0` → tool-call 被正确添加
- ❌ `assistantToolCalls = 0` → tool-call 被跳过了

### 5. 查看未处理的事件类型
```
[ResponseConverter] 🔍 Unhandled event type: "tool-use" {
  hasText: false,
  hasToolName: true,
  hasToolCallId: true,
  keys: ["type", "id", "name", "input"]
}
```

**重要**：如果看到类似 "tool-use" 或其他包含 tool 的事件类型，说明事件类型命名不匹配！

## 解决方案

### 方案 1: 事件类型命名不匹配
如果实际事件类型是 "tool-use" 而不是 "tool-call"：

**修改位置**: `src/lib/evaluations/response-converter.ts:145`
```typescript
// 原来
} else if (type === "tool-call") {

// 改为
} else if (type === "tool-use" || type === "tool-call") {
```

### 方案 2: 字段名称不匹配
如果事件有 tool 信息，但字段名不是 `toolName`、`toolCallId`、`input`：

查看日志中的 `keys` 数组，确认实际的字段名，然后修改验证逻辑。

### 方案 3: 字段值为空
如果某些字段存在但值为空字符串：

**修改验证逻辑**（更宽松的检查）：
```typescript
// 原来（严格）
if (event.toolName && event.toolCallId && event.input) {

// 改为（宽松，允许空 input）
if (event.toolName && event.toolCallId) {
    const toolInput = event.input || {};
    assistantContent.push({
        type: "tool_call",
        tool_call: {
            id: event.toolCallId,
            name: event.toolName,
            arguments: toolInput as Record<string, unknown>,
        },
    });
}
```

## 验证修复

修复后，重新运行 Case，应该看到：
```
[ResponseConverter] ✅ Adding tool-call: Read
[ResponseConverter] ✅ Adding tool-call: Grep
[ResponseConverter] ✅ Adding tool-result: Read
[ResponseConverter] ✅ Adding tool-result: Grep
[ResponseConverter] Conversion complete: {
  assistantToolCalls: 2,  // ← 现在大于 0 了！
  toolResults: 2
}
```

## 常见问题

### Q: 为什么日志显示有 tool-call 但前端还是看不到？
A: 检查前端是否正确处理了 `tool_call` 类型的 content。查看 `evaluation-workspace.tsx` 中的消息渲染逻辑。

### Q: 为什么 tool-result 显示正常但 tool-call 不显示？
A: 可能是 tool-call 的验证更严格（需要 3 个字段），而 tool-result 只需要 2 个字段。检查日志中的 "⚠️ Skipped tool-call" 警告。

### Q: 如何保存实际的 SSE 响应用于调试？
A: 在前端 `evaluation-workspace.tsx:1504` 处添加：
```typescript
console.log("Raw responseContent:", responseContent);
// 或者
localStorage.setItem('debug-sse-response', responseContent);
```

## 下一步

如果添加日志后问题仍然存在，请：
1. 复制完整的控制台日志
2. 保存一份实际的 SSE 响应内容
3. 使用 `debug-sse-parser.ts` 脚本分析响应格式

运行脚本：
```bash
npx tsx debug-sse-parser.ts <saved-response-file>
```
