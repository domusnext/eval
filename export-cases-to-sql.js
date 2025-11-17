/**
 * 导出当前数据库中的 cases 为 SQL INSERT 语句
 * 用于创建数据库迁移或种子数据
 */

const { exec } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');

const execAsync = promisify(exec);

async function exportCasesToSQL() {
  try {
    console.log('正在从本地数据库导出 cases...');

    // 查询所有 cases
    const { stdout } = await execAsync(
      'npx wrangler d1 execute eval-evaluations --local --command "SELECT * FROM evaluation_cases ORDER BY order_index" --json'
    );

    // 解析 JSON 输出
    const output = JSON.parse(stdout);
    const cases = output[0]?.results || [];

    console.log(`找到 ${cases.length} 个 cases`);

    if (cases.length === 0) {
      console.log('没有找到任何 cases');
      return;
    }

    // 生成 SQL INSERT 语句
    const sqlStatements = cases.map(caseData => {
      const escapedTitle = caseData.title.replace(/'/g, "''");
      const escapedDescription = (caseData.description || '').replace(/'/g, "''");
      const escapedUserMessage = caseData.user_message_json.replace(/'/g, "''");
      const escapedEvalRule = (caseData.eval_rule || '').replace(/'/g, "''");
      const escapedMetadata = caseData.metadata_json.replace(/'/g, "''");

      return `INSERT INTO evaluation_cases (id, root_context_id, title, description, user_message_json, eval_rule, metadata_json, order_index, created_at, updated_at) VALUES ('${caseData.id}', '${caseData.root_context_id}', '${escapedTitle}', '${escapedDescription}', '${escapedUserMessage}', '${escapedEvalRule}', '${escapedMetadata}', ${caseData.order_index}, ${caseData.created_at}, ${caseData.updated_at});`;
    });

    // 添加头部注释
    const header = `-- Exported Cases Data
-- Generated at: ${new Date().toISOString()}
-- Total cases: ${cases.length}
--
-- 使用方法：
-- 本地数据库: npx wrangler d1 execute eval-evaluations --local --file=exported-cases.sql
-- 远程数据库: npx wrangler d1 execute eval-evaluations --remote --file=exported-cases.sql
--

`;

    const sqlContent = header + sqlStatements.join('\n');

    // 保存到文件
    fs.writeFileSync('exported-cases.sql', sqlContent);

    console.log('✅ 导出完成！');
    console.log(`📄 文件: exported-cases.sql`);
    console.log(`📊 共 ${cases.length} 条记录`);
    console.log('');
    console.log('下一步操作：');
    console.log('1. 上传到远程数据库:');
    console.log('   npx wrangler d1 execute eval-evaluations --remote --file=exported-cases.sql');
    console.log('');
    console.log('2. 或创建迁移文件:');
    console.log('   cp exported-cases.sql src/drizzle/migrations/0002_seed_cases.sql');
    console.log('   git add src/drizzle/migrations/0002_seed_cases.sql');
    console.log('   git commit -m "Add seed cases data"');

  } catch (error) {
    console.error('导出失败:', error.message);
    process.exit(1);
  }
}

exportCasesToSQL();
