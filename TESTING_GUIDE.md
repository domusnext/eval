# Context Tree Structure - 测试指南

## ✅ 迁移完成确认

数据库迁移已成功完成！以下表结构已更新：

### evaluation_contexts 表
- ✅ `parent_context_id` - 父 Context ID
- ✅ `depth` - 树深度 (0 = 根节点)
- ✅ `child_count` - 子节点数量
- ✅ `environment_json` - 环境配置
- ✅ `headers_json` - HTTP headers
- ✅ `recent_messages_json` - 消息数组

### evaluation_cases 表
- ✅ `root_context_id` - 引用根 Context (之前是 context_id)
- ✅ `last_run_status` - 缓存的运行状态
- ✅ `last_run_duration_ms` - 缓存的运行时长
- ✅ `last_run_completed_at` - 缓存的完成时间
- ✅ `last_run_response_content` - 缓存的响应内容

## 🚀 启动应用

```bash
npm run dev
```

访问: http://localhost:3000/evaluations

## 📋 测试步骤

### 1. 创建 Version

1. 点击 "Create Version" 按钮
2. 输入名称，例如: "Production v1.0"
3. 保存

### 2. 创建根 Context

1. 选择刚创建的 Version
2. 点击 "Add Context" 按钮
3. 填写表单:
   - Name: "Default Environment"
   - Description: "测试用的默认环境"
   - Environment JSON:
     ```json
     {
       "family_info": {
         "members": 3,
         "city": "Beijing"
       },
       "user_brief": {
         "name": "张三",
         "age": 30
       },
       "chat_info": {
         "session_id": "test-001"
       }
     }
     ```
   - Headers JSON:
     ```json
     {
       "Authorization": "Bearer test-token-123"
     }
     ```
4. 保存

### 3. 创建 Case

1. 选中刚创建的 Context (应该显示为根节点 🌳)
2. 点击 "Add Case" 按钮
3. 填写:
   - Title: "Test Greeting"
   - User Message: "你好，今天天气怎么样？"
4. 保存

### 4. 运行 Case

1. 选中刚创建的 Case
2. 点击 "Run" 按钮
3. 等待执行完成
4. 查看 Response Content

### 5. 保存为子 Context (核心功能测试)

1. 在 Case 运行完成后，点击 "Save to Context" 按钮
2. 系统会自动:
   - 创建一个新的子 Context
   - 名称自动生成 (基于时间戳)
   - 将 user message 和 assistant response 存储为 recent_messages
   - 继承父 Context 的 environment 和 headers

### 6. 验证树形结构

在左侧边栏应该看到:

```
🌳 Default Environment
   ├── Cases: 1 case
   │   └── Test Greeting
   │
   └─ L1 (子 Context，缩进显示)
      └── Children: 0
```

**验证点**:
- ✅ 子 Context 显示在父节点下方
- ✅ 子 Context 有缩进
- ✅ 显示层级标记 "L1"
- ✅ 可以折叠/展开

### 7. 验证配置继承

1. 选中子 Context
2. 在右侧查看 "Environment" 和 "Headers" JSON
3. 应该看到:
   - Environment 完整包含父节点的所有字段
   - Headers 完整包含父节点的所有 headers
   - Recent Messages 包含保存的对话记录

### 8. 测试子节点的子节点 (深度 2)

1. 选中 L1 子 Context
2. 创建一个新的 Case
3. 运行 Case
4. 再次点击 "Save to Context"
5. 应该创建一个 L2 子 Context

**验证点**:
- ✅ L2 Context 显示在 L1 下方
- ✅ L2 有更深的缩进
- ✅ L2 继承了 L1 的配置，而 L1 又继承了根节点的配置

### 9. 测试覆盖式继承

1. 编辑 L1 Context
2. 修改 Environment JSON:
   ```json
   {
     "user_brief": {
       "mood": "happy"
     }
   }
   ```
3. 保存
4. 查看 L1 的 resolved environment
5. 应该看到:
   - `family_info`: 从根节点继承
   - `user_brief`: 合并了根节点和 L1 的字段
     - `name`: "张三" (继承)
     - `age`: 30 (继承)
     - `mood`: "happy" (新增)
   - `chat_info`: 从根节点继承

### 10. 测试树限制

**深度限制 (10 层)**:
1. 尝试创建很深的树 (L1 → L2 → ... → L10)
2. 在 L10 时尝试再创建子节点
3. 应该看到错误提示: "Maximum depth of 10 reached"

**子节点数量限制 (50 个)**:
1. 在同一个父节点下创建多个子节点
2. 达到 50 个后
3. 应该看到错误提示: "Maximum children count of 50 reached"

## 🎨 UI 功能测试

### 折叠/展开

- ✅ 点击 Context 旁边的箭头图标可以折叠/展开子节点
- ✅ 点击 Case 列表旁边的箭头可以折叠/展开 Cases

### 视觉反馈

- ✅ 选中的 Context 高亮显示
- ✅ 不同层级有不同的缩进
- ✅ 根节点显示 🌳 图标
- ✅ 子节点显示 └ 图标
- ✅ 层级标记 (L0, L1, L2...)

### Badges

- ✅ 根节点显示 Cases 数量
- ✅ 有子节点时显示 Children 数量
- ✅ Case 运行状态显示 (succeeded, failed, etc.)

## 🐛 常见问题排查

### 问题 1: "Failed query: no such column: parent_context_id"

**原因**: 数据库迁移未运行

**解决**:
```bash
npm run db:migrate:local
```

### 问题 2: UI 中看不到树形结构

**检查**:
1. 确认已经创建了父子关系的 Contexts
2. 刷新页面
3. 检查浏览器控制台是否有错误

### 问题 3: 配置继承不正确

**检查**:
1. 查看 resolved environment/headers (不是 incremental 的)
2. 确认父节点有设置配置
3. 检查 Repository 的 resolveContextConfig 函数

### 问题 4: Save to Context 失败

**可能原因**:
1. Case 没有运行或运行失败
2. Response content 为空
3. 检查浏览器控制台错误信息

## 📊 验证数据

### 直接查询数据库

```bash
# 查看所有 Contexts
wrangler d1 execute eval-evaluations --local --command="SELECT id, name, depth, parent_context_id, child_count FROM evaluation_contexts;"

# 查看树形关系
wrangler d1 execute eval-evaluations --local --command="
SELECT
  SUBSTR('          ', 1, depth * 2) || name as tree_view,
  depth,
  child_count
FROM evaluation_contexts
ORDER BY created_at;
"

# 查看 Cases
wrangler d1 execute eval-evaluations --local --command="SELECT id, title, root_context_id FROM evaluation_cases;"
```

## ✅ 测试清单

- [ ] 创建根 Context
- [ ] 设置 Environment 和 Headers
- [ ] 创建 Case
- [ ] 运行 Case
- [ ] Save to Context (创建子节点)
- [ ] 验证子节点显示在树中
- [ ] 验证配置继承
- [ ] 创建子节点的子节点 (L2)
- [ ] 测试覆盖式继承
- [ ] 测试折叠/展开功能
- [ ] 测试深度限制 (如果有时间)
- [ ] 测试子节点数量限制 (如果有时间)

## 🎉 成功标准

所有核心功能正常工作:
1. ✅ 树形结构正确显示
2. ✅ 配置继承正确工作
3. ✅ Save to Context 功能正常
4. ✅ UI 响应流畅
5. ✅ 没有控制台错误

如果遇到任何问题，请检查浏览器控制台的错误信息！
