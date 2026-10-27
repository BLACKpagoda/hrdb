// 花名册管理 - 控制器层
// 职责：导入花名册 Excel → 解析 → UPSERT 到 employee_roster 表
// 花名册用于精准匹配钉钉用户（多级降级匹配），替代旧版 userid===employee_id 假设
//
// 解析策略（兼容真实 HR 花名册的各种格式）：
//   1. 扫描前 10 行自动定位表头行（跳过大标题/合并单元格行）
//   2. 模糊匹配列名（工号/员工编号/职工编号、姓名/名字、手机/电话等中英文变体）
//   3. 状态值标准化（在职→在岗，离职/退休→不在岗）

const XLSX = require('xlsx');
const db = require('../../db');
const { success, fail } = require('../../common/response');

async function importRoster(req, res) {
  if (!req.file || !req.file.buffer) {
    return fail(res, '未获取到文件，请重新选择 Excel', 400);
  }
  const fileName = req.file.originalname || '花名册.xlsx';
  const month = req.body.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return fail(res, '请提供 month 参数（格式 YYYY-MM）', 400);
  }

  console.log(`[花名册] 开始解析: ${fileName}, 月份=${month}, buffer=${req.file.buffer.length} bytes`);

  // 解析 Excel 为二维数组（raw:false 取格式化后的文本，避免大数字精度丢失）
  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

  if (aoa.length === 0) {
    return fail(res, 'Excel 内容为空', 400);
  }

  // 扫描前 10 行定位表头行（要求同时命中"工号类"和"姓名类"列）
  let headerIdx = -1;
  let colMap = null;
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    const detected = detectHeader(aoa[i]);
    if (detected) {
      headerIdx = i;
      colMap = detected;
      break;
    }
  }

  if (!colMap) {
    const preview = aoa.slice(0, 3).map(r => JSON.stringify(r.slice(0, 15))).join('\n');
    return fail(res, `无法识别表头：前 10 行中没找到同时包含"工号"和"姓名"的行。前 3 行内容：\n${preview}`, 400);
  }

  console.log(`  [花名册] 表头在第 ${headerIdx + 1} 行，列映射: ${JSON.stringify(colMap)}`);

  // 从表头下一行开始提取数据
  const get = (row, field) => {
    const idx = colMap[field];
    if (idx === undefined) return '';
    return String(row[idx] ?? '').trim().replace(/\.0+$/, '');
  };

  const dataRows = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const row = aoa[i];
    const employeeId = get(row, 'employee_id');
    const fullName = get(row, 'full_name');
    if (!employeeId && !fullName) { skipped++; continue; } // 空行/合计行
    if (!employeeId || !fullName) { skipped++; continue; } // 缺关键字段

    const rawStatus = get(row, 'employment_status');
    dataRows.push({
      employee_id: employeeId,
      full_name: fullName,
      department: get(row, 'department'),
      mobile: get(row, 'mobile').replace(/[\s\-]/g, ''),
      id_card: get(row, 'id_card').replace(/\s/g, '').toUpperCase(),
      employment_status: normalizeStatus(rawStatus),
    });
  }

  if (dataRows.length === 0) {
    return fail(res, `表头识别成功但无有效数据行（共扫描 ${aoa.length - headerIdx - 1} 行，跳过 ${skipped} 行）。请确认数据行有工号和姓名`, 400);
  }

  // 按工号去重（同一工号保留最后一条，避免 ON CONFLICT 同语句内冲突报错）
  const dedupMap = new Map();
  for (const r of dataRows) dedupMap.set(r.employee_id, r);
  const dupCount = dataRows.length - dedupMap.size;
  const finalRows = Array.from(dedupMap.values());
  console.log(`  [花名册] 去重前 ${dataRows.length} 行，去重 ${dupCount} 行，最终 ${finalRows.length} 行`);

  console.log(`  [花名册] 跳过 ${skipped} 行（空行/缺关键字段）`);

  // 批量 UPSERT（注意占位符编号 = j * 7，每行 7 个参数）
  const BATCH = 200;
  let inserted = 0;

  for (let i = 0; i < finalRows.length; i += BATCH) {
    const batch = finalRows.slice(i, i + BATCH);
    const values = [];
    const placeholders = batch.map((r, j) => {
      const idx = j * 7;
      values.push(
        r.employee_id, r.full_name, r.department,
        r.mobile, r.id_card, r.employment_status, month
      );
      return `($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`;
    });

    await db.query(`
      INSERT INTO employee_roster (employee_id, full_name, department, mobile, id_card, employment_status, year_month)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (employee_id, year_month) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        department = EXCLUDED.department,
        mobile = EXCLUDED.mobile,
        id_card = EXCLUDED.id_card,
        employment_status = EXCLUDED.employment_status
    `, values);
    inserted += batch.length;
  }

  console.log(`  [花名册] 导入完成: ${inserted} 条（${month}）`);

  success(res, {
    total: aoa.length,
    inserted,
    skipped,
    month,
    headerRow: headerIdx + 1,
    columns: colMap,
  }, `花名册导入成功：${inserted} 条记录（${month}）`);
}

/** 查看花名册概况（各月人数） */
async function getRosterStats(req, res) {
  const { rows } = await db.query(`
    SELECT year_month,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE employment_status = '在岗') AS active,
           COUNT(*) FILTER (WHERE mobile IS NOT NULL AND mobile <> '') AS has_mobile
    FROM employee_roster
    GROUP BY year_month
    ORDER BY year_month DESC
  `);
  success(res, rows);
}

/**
 * 识别一行是否为表头，返回 { 字段 → 列下标 } 映射
 * 真实花名册（2026年3月花名册.xls）表头样例（第7行）：
 *   ["员工 ID（人事）","姓名","性别（人事）","身份证号（人事）","出生日期","年龄（人事）",
 *    "在岗状态（人事）","民族","在册状态","公司（组织）","部门描述","部门路径",...]
 * 命中规则（label 已去除空格/括号，按单元格依次判断，一个单元格只归一个字段）：
 *   工号类：员工 ID / 工号 / 员工编号 / 职工编号 / 人员编号 / employee id / emp id
 *   姓名类：姓名 / 名字 / 员工姓名 / name
 *   手机类：手机 / 电话 / mobile / phone
 *   证件类：身份证 / 证件号 / id card
 *   状态类：状态 / 在职 / status（"在岗状态（人事）"先命中，"在册状态"不会覆盖）
 *   部门类：单独二轮处理，优先"部门路径"（完整层级），否则取其他含"部门"的列
 */
function detectHeader(cells) {
  const map = {};
  const has = (f) => map[f] !== undefined;

  const labels = cells.map(c => String(c ?? '').replace(/[\s（）()：:，,]/g, ''));

  for (let idx = 0; idx < labels.length; idx++) {
    const label = labels[idx];
    if (!label) continue;

    if (!has('employee_id') && /(员工.?id|工号|职工编号|员工编号|人员编号|employee.?id|emp.?id)/i.test(label)) {
      map.employee_id = idx;
    } else if (!has('full_name') && /^(姓名|名字|员工姓名|人员姓名)$|^(full.?name|name)$/i.test(label)) {
      map.full_name = idx;
    } else if (!has('mobile') && /(手机|电话|mobile|phone)/i.test(label)) {
      map.mobile = idx;
    } else if (!has('id_card') && /(身份证|证件号|id.?card)/i.test(label)) {
      map.id_card = idx;
    } else if (!has('employment_status') && /(状态|在职|status)/i.test(label)) {
      map.employment_status = idx;
    }
  }

  // 部门列二轮处理：优先"部门路径"，否则退而取其他含"部门"的列（如"部门描述"）
  const pathIdx = labels.findIndex(l => /部门路径|dept.?path/i.test(l));
  if (pathIdx >= 0) {
    map.department = pathIdx;
  } else {
    const anyDeptIdx = labels.findIndex(l => /部门|dept|department/i.test(l));
    if (anyDeptIdx >= 0) map.department = anyDeptIdx;
  }

  return (map.employee_id !== undefined && map.full_name !== undefined) ? map : null;
}

/** 状态值标准化：在职→在岗，离职/退休等→不在岗，空→在岗 */
function normalizeStatus(raw) {
  const s = String(raw || '').trim();
  if (!s) return '在岗';
  if (/离|退|解除|终止|辞/.test(s)) return '不在岗';
  return '在岗';
}

module.exports = {
  importRoster,
  getRosterStats,
};
