# 同步本地 Case 数据到远程数据库

## 方法 1：直接同步到 Cloudflare D1 远程数据库

### 步骤 1：导出本地数据为 SQL
```bash
# 导出所有 cases
npx wrangler d1 execute eval-evaluations --local --command "SELECT * FROM evaluation_cases" --json > cases-export.json

# 或者导出为 SQL INSERT 语句（使用自定义脚本）
node export-cases-to-sql.js
```

### 步骤 2：上传到远程数据库
```bash
# 使用 --remote 标志执行 SQL
npx wrangler d1 execute eval-evaluations --remote --file=insert-cases.sql
```

**注意**: 这会将数据上传到 Cloudflare D1 云端数据库，不是 Git 仓库。

---

## 方法 2：创建数据库迁移文件

如果您希望通过 Git 分享数据结构和种子数据：

### 步骤 1：创建迁移文件
```bash
# 在 src/drizzle/migrations/ 目录下创建迁移文件
# 例如: 0002_seed_meal_recipe_cases.sql
```

### 步骤 2：将数据转换为 SQL 文件
参考下面的 `export-cases-to-sql.js` 脚本

### 步骤 3：提交到 Git
```bash
git add src/drizzle/migrations/0002_seed_meal_recipe_cases.sql
git commit -m "Add meal & recipe test cases"
git push
```

### 步骤 4：其他开发者运行迁移
```bash
npx wrangler d1 execute eval-evaluations --local --file=src/drizzle/migrations/0002_seed_meal_recipe_cases.sql
```

---

## 方法 3：创建可复用的种子数据脚本

创建一个脚本，让团队成员可以随时导入测试数据。

参考 `seed-meal-recipe-cases.js`

---

## 推荐方案

- **生产环境**: 使用方法 1，直接同步到 Cloudflare D1 远程数据库
- **团队开发**: 使用方法 2，通过迁移文件分享数据结构和初始数据
- **测试数据**: 使用方法 3，创建种子数据脚本

---

## 注意事项

1. **不要提交 `.wrangler` 目录到 Git**
2. **敏感数据不应该放在迁移文件中**（避免提交到 Git）
3. **远程数据库操作需谨慎**，建议先在本地测试
4. **大量数据应分批导入**，避免超时
