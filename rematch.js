// 轻量重匹配脚本：花名册导入后，只重跑 人员映射 + 冗余回填 + 汇总重算
// 不重新拉取打卡原始数据（省 60 分钟），仅用钉钉通讯录 API 重建映射（约 40 分钟）
// 日志：直接 fs 写文件（rematch_log.txt），避免 stdout 管道缓冲导致"假卡死"
const fs = require('fs');
const db = require('./db');
const syncService = require('./modules/attendance-sync/service');

const LOG_FILE = 'rematch_log.txt';

// 劫持 console 输出到文件（service.js 里的 console.log 同步落盘）
['log', 'warn', 'error'].forEach(fn => {
  const orig = console[fn].bind(console);
  console[fn] = (...args) => {
    orig(...args);
    try {
      fs.appendFileSync(LOG_FILE, args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') + '\n');
    } catch (_) {}
  };
});

async function main() {
  console.log(`=== 轻量重匹配开始 ${new Date().toLocaleString()} ===`);

  // 1. 获取 access_token
  const token = await syncService.getAccessToken();
  console.log('[1/5] access_token 获取成功');

  // 2. 拉取钉钉部门树 + 用户列表（含部门路径）
  const { users, userDeptMap } = await syncService.getAllCompanyUsers(token);
  console.log(`[2/5] 钉钉用户 ${users.length} 人，部门路径 ${userDeptMap.size} 人`);

  // 3. 多级降级匹配花名册（工号 → 手机号 → 姓名+部门）
  const matchResult = await syncService.syncUserMapping(token, users, userDeptMap);
  console.log(`[3/5] 匹配完成: matched=${matchResult.matched}, unmatched=${matchResult.unmatched}`);
  console.log(`  匹配方式分布: ${JSON.stringify(matchResult.matchMethods)}`);

  // 4. 回填冗余字段到打卡/请假表（覆盖式，更新部门路径为前2级）
  await syncService.enrichWithMapping();
  console.log('[4/5] 冗余字段回填完成');

  // 5. 重算汇总层（部门日汇总 + 员工月汇总）
  await syncService.calcSummary('2026-03-07', '2026-08-31');
  console.log('[5/5] 汇总重算完成');

  // 最终验证
  const r = await db.query(`
    SELECT sync_status, employment_status, COUNT(*) AS cnt
    FROM dingtalk_user_mapping GROUP BY 1,2 ORDER BY 3 DESC
  `);
  console.log('\n=== 最终 mapping 状态 ===');
  r.rows.forEach(x => console.log(`  ${x.sync_status} / ${x.employment_status}: ${x.cnt}`));

  const d = await db.query(`
    SELECT array_length(string_to_array(department_path, ' '), 1) AS depth,
           COUNT(DISTINCT department_path) AS depts
    FROM dingtalk_user_mapping
    WHERE employment_status = '在岗' AND department_path IS NOT NULL
    GROUP BY 1 ORDER BY 1
  `);
  console.log('\n=== 部门层级分布（应为最多2级） ===');
  d.rows.forEach(x => console.log(`  ${x.depth}级: ${x.depts}个`));

  await db.close();
  console.log('\n=== 轻量重匹配全部完成 ===');
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
