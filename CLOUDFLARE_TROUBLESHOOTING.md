# Cloudflare 部署诊断指南

## 问题排查步骤

你的应用突然不显示评测数据，但 D1 数据库中数据存在。这通常是由以下原因引起：

### 第一步：检查数据库连接

1. **部署最新代码**：我添加了一个诊断 API，可以帮助检查问题：
```bash
npm run build:cf
npm run deploy:cf
```

2. **运行诊断工具**：部署后访问：
```
https://你的-cloudflare-域名/api/debug/db-check
```

这会返回：
- ✅ D1 数据库是否正确绑定
- ✅ 数据库表是否存在
- ✅ 各表中的数据数量
- ✅ 如果表缺失，会告诉你需要运行迁移

### 第二步：如果显示"Tables missing"

运行数据库迁移：
```bash
npm run db:migrate:prod
```

### 第三步：检查浏览器控制台

部署后刷新页面，打开浏览器开发者工具 (F12) → Console，查看：
- 是否有错误信息
- `/api/evaluations/tree` 返回什么错误
- 完整的错误堆栈

### 第四步：手动检查数据

如果诊断工具显示数据存在，但页面仍不显示，检查：

```bash
# 查看 production 中的数据
npm run db:inspect:prod
```

## 我做了什么改动

1. **添加诊断 API** (`/api/debug/db-check`):
   - 检查 Cloudflare 环境变量
   - 验证 D1 数据库绑定
   - 列出所有表
   - 计算每个表中的数据行数

2. **改进错误日志** (`/api/evaluations/tree`):
   - 添加详细的日志输出
   - 显示获取了多少版本
   - 提示检查诊断工具

3. **改进前端错误处理** (`/app/evaluations/page.tsx`):
   - 显示详细的错误消息
   - 提供故障排除指南
   - 添加重试按钮

## 常见问题

### 问题：DB 检查显示 "D1 binding not found"
**原因**：Cloudflare Pages 部署时没有正确传递 D1 绑定

**解决方案**：
1. 确保 `wrangler.jsonc` 中的绑定名称是 `eval_d1_db`
2. 重新部署：`npm run deploy:cf`
3. 等待部署完成后再测试

### 问题：Tables missing
**原因**：数据库存在但表未创建

**解决方案**：
```bash
npm run db:migrate:prod
```

### 问题：有数据但页面还是空的
**可能原因**：
1. 浏览器缓存 - 按 Ctrl+Shift+Delete 清除所有缓存
2. API 响应格式问题 - 检查浏览器开发者工具的 Network 标签
3. JavaScript 错误 - 查看浏览器控制台

## 下次部署时的检查清单

在部署到 Cloudflare 前：

- [ ] 本地构建成功：`npm run build`
- [ ] 所有 API 都有正确的错误处理
- [ ] 数据库迁移已运行：`npm run db:migrate:prod`
- [ ] 检查浏览器控制台没有错误

部署后：

- [ ] 访问 `/api/debug/db-check` 确保数据库连接正常
- [ ] 访问主页面确保数据加载
- [ ] 检查浏览器控制台的日志输出
