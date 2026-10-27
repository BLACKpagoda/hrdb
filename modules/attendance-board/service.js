// 考勤看板 - 服务层
// 数据来源：hrdb 现有表（由 modules/attendance-sync 维护），不做任何钉钉 API 调用
// 口径约定（见 API_CONTRACT.md 第十三章）：
//   - 出勤率 ×100 保留 1 位小数
//   - 请假时长单位小时 = SUM(duration_percent)/100*8（8 小时/天）
//   - 异常人次仅统计 valid_exception=true（已剔除审批抵消）
//   - 所有人员统计过滤 employment_status='在岗' AND sync_status='matched'
//   - departmentPath 前缀匹配：= $N OR LIKE $N || '%'
//   - 加班/外出/补卡为数据缺口，返回空数据结构（前端已兼容"暂无数据"）

const db = require('../../db');

/* ==================== 通用工具 ==================== */

// 数值转换（pg 的 NUMERIC 返回字符串）
function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// 保留 1 位小数
function round1(v) {
  return Math.round(num(v) * 10) / 10;
}

// 部门路径前缀过滤条件（动态占位符编号）
// 用法：const params = [startDate, endDate]; const cond = deptFilter(departmentPath, 'r.department_path', params);
//       SQL 中日期固定为 $1/$2，dept 条件编号自动排在后
function deptFilter(departmentPath, column, params) {
  if (!departmentPath) return { sql: '' };
  params.push(departmentPath);
  const idx = params.length;
  return {
    sql: ` AND (${column} = $${idx} OR ${column} LIKE $${idx} || '%')`,
  };
}

// 日期参数校验
function assertDateRange({ startDate, endDate }) {
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    const err = new Error('请提供 startDate 和 endDate 参数（格式：YYYY-MM-DD）');
    err.statusCode = 400;
    throw err;
  }
}

// 在岗过滤 JOIN（r/l 为业务表别名）
const ACTIVE_JOIN = (alias) =>
  `JOIN dingtalk_user_mapping m ON m.dingtalk_userid = ${alias}.dingtalk_userid
     AND m.employment_status = '在岗' AND m.sync_status = 'matched'`;

// 加班/外出/补卡数据缺口（契约 13.5：先返回空数据，前端显示"暂无数据"）
const EMPTY_OVERTIME_STATS = {
  totalDuration: 0,
  dailyAvg: 0,
  departmentRank: [],
  typeBreakdown: { workday: 0, weekend: 0, holiday: 0 },
};
const EMPTY_OUTING_STATS = { totalCount: 0, totalDuration: 0, departmentRank: [] };

// 时间戳 → 'HH:mm'
function fmtHHmm(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 日期 → 'YYYY-MM-DD'
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 异常类型（严重度：旷工 > 缺卡 > 迟到 > 早退）
function pickAbnormalType(row) {
  if (row.is_absent) return '旷工';
  if (num(row.lack_card_count) > 0) return '缺卡';
  if (num(row.late_count) > 0) return '迟到';
  if (num(row.early_leave_count) > 0) return '早退';
  return '';
}

// 异常时长（分钟）：旷工按半天 240 分钟估算，缺卡无时长记 0
function pickAbnormalDuration(type, row) {
  if (type === '旷工') return 240;
  if (type === '迟到') return num(row.late_minutes);
  if (type === '早退') return num(row.early_leave_minutes);
  return 0;
}

/* ==================== 板块0：筛选选项 ==================== */

async function getBoardOptions() {
  const { rows } = await db.query(`
    SELECT DISTINCT department_path
    FROM dingtalk_user_mapping
    WHERE employment_status = '在岗'
      AND department_path IS NOT NULL
    ORDER BY department_path
  `);
  return {
    departments: rows.map(r => ({ path: r.department_path, name: r.department_path })),
  };
}

/* ==================== 板块1：考勤总览 KPI + 状态分布 ==================== */

async function getBoardOverview({ startDate, endDate, departmentPath }) {
  assertDateRange({ startDate, endDate });

  // 1. 应出勤/实际出勤（部门日汇总表聚合）
  const params1 = [startDate, endDate];
  const cond1 = deptFilter(departmentPath, 'd.department_path', params1);
  const { rows: kpiRows } = await db.query(`
    SELECT
      COALESCE(SUM(d.expected_count), 0) AS should_attend,
      COALESCE(SUM(d.actual_count), 0) AS actual_attend
    FROM attendance_department_daily d
    WHERE d.stat_date >= $1 AND d.stat_date <= $2${cond1.sql}
  `, params1);

  const shouldAttendCount = num(kpiRows[0].should_attend);
  const actualAttendCount = num(kpiRows[0].actual_attend);

  // 2. 异常人次 + 按 check_in_time_result 统计状态分布
  // lateCount/earlyLeaveCount 保留字段级别汇总（异常次数），但 statusDistribution 的各分项
  // 用 DISTINCT 人次（一个人一天迟到多次只算 1 人·次迟到状态）
  const params2 = [startDate, endDate];
  const cond2 = deptFilter(departmentPath, 'r.department_path', params2);
  const { rows: abnRows } = await db.query(`
    SELECT
      COALESCE(SUM(r.late_count), 0) AS late_count,
      COALESCE(SUM(r.early_leave_count), 0) AS early_leave_count,
      COALESCE(SUM(r.lack_card_count), 0) AS miss_card_count,
      COUNT(*) FILTER (WHERE r.is_absent) AS absent_count
    FROM attendance_daily_result r
    ${ACTIVE_JOIN('r')}
    WHERE r.attendance_date >= $1 AND r.attendance_date <= $2
      AND r.valid_exception = TRUE${cond2.sql}
  `, params2);

  // 按 check_in_time_result 聚合状态分布的人次
  const { rows: distRows } = await db.query(`
    SELECT
      r.check_in_time_result,
      COUNT(*) AS cnt
    FROM attendance_daily_result r
    ${ACTIVE_JOIN('r')}
    WHERE r.attendance_date >= $1 AND r.attendance_date <= $2${cond2.sql}
    GROUP BY r.check_in_time_result
  `, params2);

  const distMap = {};
  distRows.forEach(r => { distMap[r.check_in_time_result] = num(r.cnt); });

  const lateCount = num(abnRows[0].late_count);
  const earlyLeaveCount = num(abnRows[0].early_leave_count);
  const missCardCount = num(abnRows[0].miss_card_count);
  const absentCount = num(abnRows[0].absent_count);

  // 3. 请假时长（小时）+ 请感人·天（按请假单与查询区间的交集折算，避免长单如产假全额计入窗口）
  const params3 = [startDate, endDate];
  const cond3 = deptFilter(departmentPath, 'l.department_path', params3);
  const { rows: leaveRows } = await db.query(`
    SELECT
      SUM(COALESCE(GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          LEAST(l.end_time, ($2::date + interval '1 day')) - GREATEST(l.start_time, $1::date)
        )) / 86400.0
      ), l.duration_percent / 100.0, 0)) * 8 AS leave_hours,
      COUNT(*) AS leave_days_count
    FROM attendance_leave_status l
    ${ACTIVE_JOIN('l')}
    WHERE l.attendance_date >= $1 AND l.attendance_date <= $2${cond3.sql}
  `, params3);

  const leaveHours = round1(leaveRows[0].leave_hours);
  const leaveDaysCount = num(leaveRows[0].leave_days_count);

  // 出勤率 ×100 保留 1 位
  const attendanceRate = shouldAttendCount > 0
    ? round1(actualAttendCount * 100 / shouldAttendCount)
    : 0;

  const kpi = {
    shouldAttendCount,
    actualAttendCount,
    attendanceRate,
    lateCount,
    earlyLeaveCount,
    missCardCount,
    absentCount,
    leaveDuration: leaveHours,
    overtimeDuration: 0, // 数据缺口（契约 13.5-②）
    outingCount: 0,      // 数据缺口（契约 13.5-③）
  };

  // 4. 状态分布（固定 6 项，互斥口径：按 check_in_time_result 分组）
  // 正常 = Normal，迟到 = Late + SeriousLate，缺卡 = NotSigned，旷工 = Absenteeism
  // 早退从 early_leave_count > 0 的行 DISTINCT 统计，请假从 leave_status 统计
  const normalCount = distMap['Normal'] || 0;
  const lateDistCount = (distMap['Late'] || 0) + (distMap['SeriousLate'] || 0);
  const missCardDistCount = distMap['NotSigned'] || 0;
  const absentDistCount = distMap['Absenteeism'] || 0;

  // 早退人次：early_leave_count > 0 的 DISTINCT 行
  const { rows: earlyRows } = await db.query(`
    SELECT COUNT(*) AS cnt
    FROM attendance_daily_result r
    ${ACTIVE_JOIN('r')}
    WHERE r.attendance_date >= $1 AND r.attendance_date <= $2
      AND r.early_leave_count > 0${cond2.sql}
  `, params2);
  const earlyDistCount = num(earlyRows[0].cnt);

  // 请假人次：leave_status 与查询区间有交集的记录数
  const { rows: leaveDistRows } = await db.query(`
    SELECT COUNT(*) AS cnt
    FROM attendance_leave_status l
    ${ACTIVE_JOIN('l')}
    WHERE l.attendance_date >= $1 AND l.attendance_date <= $2${cond3.sql}
  `, params3);
  const leaveDistCount = num(leaveDistRows[0].cnt);

  const statusDistribution = [
    { name: '正常', value: normalCount },
    { name: '迟到', value: lateDistCount },
    { name: '早退', value: earlyDistCount },
    { name: '缺卡', value: missCardDistCount },
    { name: '请假', value: leaveDistCount },
    { name: '旷工', value: absentDistCount },
  ];

  return { kpi, statusDistribution };
}

/* ==================== 板块2：部门维度统计 ==================== */

async function getBoardDepartmentStats({ startDate, endDate, departmentPath }) {
  assertDateRange({ startDate, endDate });

  // 1. 部门聚合（部门日汇总表）
  const params1 = [startDate, endDate];
  const cond1 = deptFilter(departmentPath, 'd.department_path', params1);
  const { rows: statRows } = await db.query(`
    SELECT
      d.department_path,
      SUM(d.expected_count) AS expected_count,
      SUM(d.actual_count) AS actual_count,
      COALESCE(SUM(d.late_total), 0) AS late_total,
      COALESCE(SUM(d.early_leave_total), 0) AS early_leave_total,
      COALESCE(SUM(d.lack_card_total), 0) AS miss_card_total,
      COALESCE(SUM(d.absent_total), 0) AS absent_total
    FROM attendance_department_daily d
    WHERE d.stat_date >= $1 AND d.stat_date <= $2${cond1.sql}
    GROUP BY d.department_path
  `, params1);

  // 2. 各部门在岗人数（按部门精确值统计 mapping）
  const { rows: hcRows } = await db.query(`
    SELECT department_path, COUNT(*) AS headcount
    FROM dingtalk_user_mapping
    WHERE employment_status = '在岗' AND sync_status = 'matched'
      AND department_path IS NOT NULL
    GROUP BY department_path
  `);

  // 3. 各部门请假时长（小时）
  const params3 = [startDate, endDate];
  const cond3 = deptFilter(departmentPath, 'l.department_path', params3);
  const { rows: leaveRows } = await db.query(`
    SELECT l.department_path, SUM(l.duration_percent) / 100.0 * 8 AS leave_hours
    FROM attendance_leave_status l
    ${ACTIVE_JOIN('l')}
    WHERE l.attendance_date >= $1 AND l.attendance_date <= $2${cond3.sql}
    GROUP BY l.department_path
  `, params3);

  // 部门在岗人数按前缀归属（mapping 的粒度可能与汇总路径不完全一致）
  const headcountOf = (path) => hcRows.reduce((sum, r) => {
    return (r.department_path === path || r.department_path.startsWith(path)) ? sum + num(r.headcount) : sum;
  }, 0);

  const leaveMap = new Map(leaveRows.map(r => [r.department_path, num(r.leave_hours)]));

  const list = statRows.map(r => {
    const expected = num(r.expected_count);
    const actual = num(r.actual_count);
    return {
      departmentPath: r.department_path,
      departmentName: r.department_path,
      headcount: headcountOf(r.department_path),
      actualAttendCount: actual,
      attendanceRate: expected > 0 ? round1(actual * 100 / expected) : 0,
      lateCount: num(r.late_total),
      earlyLeaveCount: num(r.early_leave_total),
      missCardCount: num(r.miss_card_total),
      absentCount: num(r.absent_total),
      leaveDuration: round1(leaveMap.get(r.department_path) || 0),
      overtimeDuration: 0, // 数据缺口（契约 13.5-②）
    };
  });

  // 按出勤率降序（前端部门出勤率排名柱状图）
  list.sort((a, b) => b.attendanceRate - a.attendanceRate);
  return list;
}

/* ==================== 板块3：异常考勤 ==================== */

// 3-1 高频迟到 TOP
async function getAbnormalLateRank({ startDate, endDate, departmentPath, limit }) {
  assertDateRange({ startDate, endDate });
  const params = [startDate, endDate];
  const cond = deptFilter(departmentPath, 'r.department_path', params);
  const topN = Math.min(Math.max(parseInt(limit) || 10, 1), 100);

  const { rows } = await db.query(`
    SELECT
      r.dingtalk_userid AS user_id,
      COALESCE(m.employee_name, r.employee_name, '') AS user_name,
      COALESCE(r.department_path, m.department_path, '') AS department_name,
      SUM(r.late_count) AS late_count,
      SUM(r.late_minutes) AS late_duration
    FROM attendance_daily_result r
    ${ACTIVE_JOIN('r')}
    WHERE r.attendance_date >= $1 AND r.attendance_date <= $2
      AND r.valid_exception = TRUE AND r.late_count > 0${cond.sql}
    GROUP BY r.dingtalk_userid, COALESCE(m.employee_name, r.employee_name, ''), COALESCE(r.department_path, m.department_path, '')
    ORDER BY late_count DESC, late_duration DESC
    LIMIT ${topN}
  `, params);

  return rows.map(r => ({
    userId: r.user_id,
    userName: r.user_name,
    departmentName: r.department_name,
    lateCount: num(r.late_count),
    lateDuration: num(r.late_duration),
  }));
}

// 3-2 高频缺卡 TOP
async function getAbnormalMisscardRank({ startDate, endDate, departmentPath, limit }) {
  assertDateRange({ startDate, endDate });
  const params = [startDate, endDate];
  const cond = deptFilter(departmentPath, 'r.department_path', params);
  const topN = Math.min(Math.max(parseInt(limit) || 10, 1), 100);

  const { rows } = await db.query(`
    SELECT
      r.dingtalk_userid AS user_id,
      COALESCE(m.employee_name, r.employee_name, '') AS user_name,
      COALESCE(r.department_path, m.department_path, '') AS department_name,
      SUM(r.lack_card_count) AS misscard_count
    FROM attendance_daily_result r
    ${ACTIVE_JOIN('r')}
    WHERE r.attendance_date >= $1 AND r.attendance_date <= $2
      AND r.valid_exception = TRUE AND r.lack_card_count > 0${cond.sql}
    GROUP BY r.dingtalk_userid, COALESCE(m.employee_name, r.employee_name, ''), COALESCE(r.department_path, m.department_path, '')
    ORDER BY misscard_count DESC
    LIMIT ${topN}
  `, params);

  return rows.map(r => ({
    userId: r.user_id,
    userName: r.user_name,
    departmentName: r.department_name,
    misscardCount: num(r.misscard_count),
  }));
}

// 3-3 旷工人员清单
async function getAbnormalAbsentList({ startDate, endDate, departmentPath }) {
  assertDateRange({ startDate, endDate });
  const params = [startDate, endDate];
  const cond = deptFilter(departmentPath, 'r.department_path', params);

  const { rows } = await db.query(`
    SELECT
      r.dingtalk_userid AS user_id,
      COALESCE(m.employee_name, r.employee_name, '') AS user_name,
      COALESCE(r.department_path, m.department_path, '') AS department_name,
      r.attendance_date
    FROM attendance_daily_result r
    ${ACTIVE_JOIN('r')}
    WHERE r.attendance_date >= $1 AND r.attendance_date <= $2
      AND r.is_absent = TRUE AND r.valid_exception = TRUE${cond.sql}
    ORDER BY r.attendance_date DESC
  `, params);

  // reason：无有效审批抵消（valid_exception=true 意味着未关联审批），固定文案
  return rows.map(r => ({
    userId: r.user_id,
    userName: r.user_name,
    departmentName: r.department_name,
    date: fmtDate(r.attendance_date),
    reason: '旷工（无请假/加班审批抵消）',
  }));
}

// 3-4 异常明细（分页，含被审批抵消的异常）
async function getAbnormalDetail({ startDate, endDate, departmentPath, page, size }) {
  assertDateRange({ startDate, endDate });
  const pageNo = Math.max(parseInt(page) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(size) || 15, 1), 200);
  const params = [startDate, endDate];
  const cond = deptFilter(departmentPath, 'r.department_path', params);

  const where = `
    WHERE r.attendance_date >= $1 AND r.attendance_date <= $2
      AND (r.late_count > 0 OR r.early_leave_count > 0 OR r.lack_card_count > 0 OR r.is_absent)${cond.sql}
  `;

  const { rows: countRows } = await db.query(`
    SELECT COUNT(*) AS total FROM attendance_daily_result r ${ACTIVE_JOIN('r')} ${where}
  `, params);
  const total = num(countRows[0].total);

  const { rows } = await db.query(`
    SELECT
      r.dingtalk_userid AS user_id,
      COALESCE(m.employee_name, r.employee_name, '') AS user_name,
      COALESCE(r.department_path, m.department_path, '') AS department_name,
      r.attendance_date,
      r.late_count, r.early_leave_count, r.lack_card_count, r.is_absent,
      r.late_minutes, r.early_leave_minutes,
      r.has_approval_cancel, r.valid_exception
    FROM attendance_daily_result r
    ${ACTIVE_JOIN('r')}
    ${where}
    ORDER BY r.attendance_date DESC, r.dingtalk_userid
    LIMIT ${pageSize} OFFSET ${(pageNo - 1) * pageSize}
  `, params);

  const list = rows.map(r => {
    const abnormalType = pickAbnormalType(r);
    return {
      userId: r.user_id,
      userName: r.user_name,
      departmentName: r.department_name,
      date: fmtDate(r.attendance_date),
      abnormalType,
      duration: pickAbnormalDuration(abnormalType, r),
      hasApprovalCancel: !!r.has_approval_cancel,
      validException: !!r.valid_exception,
    };
  });

  return { list, total };
}

// 3-5 补卡申请列表（数据缺口 ①：暂无补卡表，返回空数组）
async function getAbnormalResubmitList() {
  return [];
}

/* ==================== 板块4：请假 / 加班 / 外出 ==================== */

// 4-1 请假统计
async function getLeaveStats({ startDate, endDate, departmentPath }) {
  assertDateRange({ startDate, endDate });
  const params1 = [startDate, endDate];
  const cond1 = deptFilter(departmentPath, 'l.department_path', params1);

  const { rows: typeRows } = await db.query(`
    SELECT
      COALESCE(NULLIF(t.leave_name, ''), l.leave_code, '其他') AS type,
      SUM(COALESCE(GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          LEAST(l.end_time, ($2::date + interval '1 day')) - GREATEST(l.start_time, $1::date)
        )) / 86400.0
      ), l.duration_percent / 100.0, 0)) * 8 AS duration,
      COUNT(*) AS count
    FROM attendance_leave_status l
    ${ACTIVE_JOIN('l')}
    LEFT JOIN attendance_leave_type t ON t.leave_code = l.leave_code
    WHERE l.attendance_date >= $1 AND l.attendance_date <= $2${cond1.sql}
    GROUP BY 1
    ORDER BY duration DESC
  `, params1);

  const params2 = [startDate, endDate];
  const cond2 = deptFilter(departmentPath, 'l.department_path', params2);
  const { rows: deptRows } = await db.query(`
    SELECT
      COALESCE(l.department_path, m.department_path, '') AS department_name,
      SUM(COALESCE(GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          LEAST(l.end_time, ($2::date + interval '1 day')) - GREATEST(l.start_time, $1::date)
        )) / 86400.0
      ), l.duration_percent / 100.0, 0)) * 8 AS duration
    FROM attendance_leave_status l
    ${ACTIVE_JOIN('l')}
    WHERE l.attendance_date >= $1 AND l.attendance_date <= $2${cond2.sql}
    GROUP BY 1
    ORDER BY duration DESC
  `, params2);

  return {
    typeDistribution: typeRows.map(r => ({
      type: r.type,
      duration: round1(r.duration),
      count: num(r.count),
    })),
    departmentRank: deptRows.map(r => ({
      departmentName: r.department_name,
      duration: round1(r.duration),
    })),
  };
}

// 4-2 加班统计（数据缺口 ②：暂无加班表，返回空数据）
async function getOvertimeStats() {
  return { ...EMPTY_OVERTIME_STATS };
}

// 4-3 外出/出差统计（数据缺口 ③：暂无外出表，返回空数据）
async function getOutingStats() {
  return { ...EMPTY_OUTING_STATS };
}

// 4-4 请假/加班单据明细（分页）
async function getLeaveOvertimeDetail({ startDate, endDate, type, departmentPath, page, size }) {
  assertDateRange({ startDate, endDate });

  if (type === 'overtime') {
    // 数据缺口 ②：暂无加班表
    return { list: [], total: 0 };
  }

  const pageNo = Math.max(parseInt(page) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(size) || 15, 1), 200);
  const params = [startDate, endDate];
  const cond = deptFilter(departmentPath, 'l.department_path', params);

  const where = `
    WHERE l.attendance_date >= $1 AND l.attendance_date <= $2${cond.sql}
  `;

  const { rows: countRows } = await db.query(`
    SELECT COUNT(*) AS total FROM attendance_leave_status l ${ACTIVE_JOIN('l')} ${where}
  `, params);
  const total = num(countRows[0].total);

  const { rows } = await db.query(`
    SELECT
      l.dingtalk_userid AS user_id,
      COALESCE(m.employee_name, l.employee_name, '') AS user_name,
      COALESCE(l.department_path, m.department_path, '') AS department_name,
      COALESCE(NULLIF(t.leave_name, ''), l.leave_code, '其他') AS leave_type,
      l.start_time, l.end_time,
      COALESCE(GREATEST(
        0,
        EXTRACT(EPOCH FROM (
          LEAST(l.end_time, ($2::date + interval '1 day')) - GREATEST(l.start_time, $1::date)
        )) / 86400.0
      ), l.duration_percent / 100.0, 0) * 8 AS duration
    FROM attendance_leave_status l
    ${ACTIVE_JOIN('l')}
    LEFT JOIN attendance_leave_type t ON t.leave_code = l.leave_code
    ${where}
    ORDER BY l.start_time DESC NULLS LAST
    LIMIT ${pageSize} OFFSET ${(pageNo - 1) * pageSize}
  `, params);

  const list = rows.map(r => ({
    userId: r.user_id,
    userName: r.user_name,
    departmentName: r.department_name,
    leaveType: r.leave_type,
    startTime: r.start_time ? new Date(r.start_time).toLocaleString('zh-CN', { hour12: false }) : '',
    endTime: r.end_time ? new Date(r.end_time).toLocaleString('zh-CN', { hour12: false }) : '',
    duration: round1(r.duration),
    status: 'approved', // 钉钉 getleavestatus 同步的均为已审批生效的请假
  }));

  return { list, total };
}

/* ==================== 板块5：趋势分析 ==================== */

async function getBoardTrend({ startDate, endDate, departmentPath }) {
  assertDateRange({ startDate, endDate });
  const params = [startDate, endDate];
  const cond = deptFilter(departmentPath, 'd.department_path', params);

  const { rows } = await db.query(`
    SELECT
      TO_CHAR(d.stat_date, 'YYYY-MM-DD') AS date,
      CASE WHEN SUM(d.expected_count) > 0
        THEN ROUND(SUM(d.actual_count) * 100.0 / SUM(d.expected_count), 1)
        ELSE 0 END AS attendance_rate,
      COALESCE(SUM(d.late_total), 0) AS late_count,
      COALESCE(SUM(d.lack_card_total), 0) AS misscard_count,
      COALESCE(SUM(d.absent_total), 0) AS absent_count
    FROM attendance_department_daily d
    WHERE d.stat_date >= $1 AND d.stat_date <= $2${cond.sql}
    GROUP BY d.stat_date
    ORDER BY d.stat_date
  `, params);

  return rows.map(r => ({
    date: r.date,
    attendanceRate: num(r.attendance_rate),
    lateCount: num(r.late_count),
    misscardCount: num(r.misscard_count),
    absentCount: num(r.absent_count),
  }));
}

/* ==================== 板块6：人员明细 ==================== */

// 6-1 人员明细列表（员工月汇总表，区间跨月聚合，分页）
async function getEmployeeAttendanceList({ startDate, endDate, page, size, departmentPath, keyword }) {
  assertDateRange({ startDate, endDate });
  const pageNo = Math.max(parseInt(page) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(size) || 15, 1), 200);
  const startMonth = startDate.substring(0, 7);
  const endMonth = endDate.substring(0, 7);

  const params = [startMonth, endMonth];
  const cond = deptFilter(departmentPath, 'em.department_path', params);

  let keywordSql = '';
  if (keyword) {
    params.push(`%${keyword}%`);
    keywordSql = ` AND (em.employee_name ILIKE $${params.length} OR em.employee_id ILIKE $${params.length})`;
  }

  const where = `
    WHERE em.year_month >= $1 AND em.year_month <= $2${cond.sql}${keywordSql}
  `;

  const { rows: countRows } = await db.query(`
    SELECT COUNT(DISTINCT em.employee_id) AS total
    FROM attendance_employee_monthly em
    ${where}
  `, params);
  const total = num(countRows[0].total);

  const { rows } = await db.query(`
    SELECT
      em.employee_id AS user_id,
      MAX(em.employee_name) AS user_name,
      MAX(em.department_path) AS department_name,
      MAX(e.position_name) AS job_title,
      SUM(em.late_count) AS late_count,
      SUM(em.early_leave_count) AS early_leave_count,
      SUM(em.lack_card_count) AS miss_card_count,
      SUM(em.absent_days) AS absent_count,
      SUM(em.leave_days) AS leave_days
    FROM attendance_employee_monthly em
    LEFT JOIN employees e ON e.employee_id = em.employee_id
    ${where}
    GROUP BY em.employee_id
    ORDER BY late_count DESC, user_id
    LIMIT ${pageSize} OFFSET ${(pageNo - 1) * pageSize}
  `, params);

  return {
    list: rows.map(r => ({
      userId: r.user_id,
      userName: r.user_name || '',
      employeeId: r.user_id,
      departmentName: r.department_name || '',
      jobTitle: r.job_title || '',
      lateCount: num(r.late_count),
      earlyLeaveCount: num(r.early_leave_count),
      misscardCount: num(r.miss_card_count),
      absentCount: num(r.absent_count),
      leaveDays: round1(r.leave_days),
      overtimeHours: 0, // 数据缺口（契约 13.5-②）
    })),
    total,
  };
}

// 6-2 个人考勤日历（按月）
async function getEmployeeCalendar({ userId, month }) {
  if (!userId || !month || !/^\d{4}-\d{2}$/.test(month)) {
    const err = new Error('请提供 userId 和 month 参数（month 格式：YYYY-MM）');
    err.statusCode = 400;
    throw err;
  }

  // 当月起止（左闭右开）
  const monthStart = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

  // 前端传的 userId 是员工ID（employee_id），对 jobnumber 匹配的人其真实 dingtalk_userid
  // 是长 ID，与员工ID不同。必须先经映射表解析，否则查不到日报 → 日历整天显示"休息"
  let dingtalkUserid = userId;
  const { rows: mapRows } = await db.query(
    'SELECT dingtalk_userid FROM dingtalk_user_mapping WHERE employee_id = $1 LIMIT 1',
    [userId]
  );
  if (mapRows.length > 0 && mapRows[0].dingtalk_userid) {
    dingtalkUserid = mapRows[0].dingtalk_userid;
  }

  // 日级结果
  const { rows: dailyRows } = await db.query(`
    SELECT attendance_date, check_in_actual_time, check_out_actual_time,
      late_count, early_leave_count, lack_card_count, is_absent,
      late_minutes, early_leave_minutes,
      has_approval_cancel, valid_exception
    FROM attendance_daily_result
    WHERE dingtalk_userid = $1 AND attendance_date >= $2 AND attendance_date < $3
    ORDER BY attendance_date
  `, [dingtalkUserid, monthStart, nextMonth]);

  // 请假记录
  const { rows: leaveRows } = await db.query(`
    SELECT attendance_date, leave_code, duration_percent
    FROM attendance_leave_status
    WHERE dingtalk_userid = $1 AND attendance_date >= $2 AND attendance_date < $3
  `, [dingtalkUserid, monthStart, nextMonth]);

  // 按日期建索引
  const dailyMap = new Map(dailyRows.map(r => [fmtDate(r.attendance_date), r]));
  const leaveMap = new Map();
  for (const r of leaveRows) {
    const d = fmtDate(r.attendance_date);
    if (!leaveMap.has(d)) leaveMap.set(d, []);
    leaveMap.get(d).push(r);
  }

  // 当月天数
  const daysInMonth = new Date(y, m, 0).getDate();

  const calendar = [];
  const summary = { lateCount: 0, earlyLeaveCount: 0, misscardCount: 0, absentCount: 0, leaveDays: 0, overtimeHours: 0 };

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const daily = dailyMap.get(date);
    const leaves = leaveMap.get(date) || [];
    const hasLeave = leaves.length > 0;

    let workStatus = '正常';
    let abnormalType = '';

    if (!daily) {
      // 钉钉侧无打卡要求的日期（无日级记录）
      workStatus = hasLeave ? '请假' : '休息';
    } else if (daily.valid_exception) {
      // 有效异常（严重度：旷工 > 缺卡 > 迟到 > 早退）
      abnormalType = pickAbnormalType(daily);
      workStatus = abnormalType || '正常';
    } else if (hasLeave) {
      workStatus = '请假';
    }

    if (daily && daily.valid_exception) {
      summary.lateCount += num(daily.late_count);
      summary.earlyLeaveCount += num(daily.early_leave_count);
      summary.misscardCount += num(daily.lack_card_count);
      if (daily.is_absent) summary.absentCount += 1;
    }
    if (hasLeave) {
      for (const lv of leaves) summary.leaveDays += num(lv.duration_percent) / 100;
    }

    calendar.push({
      date,
      workStatus,
      checkIn: daily ? fmtHHmm(daily.check_in_actual_time) : '',
      checkOut: daily ? fmtHHmm(daily.check_out_actual_time) : '',
      abnormalType,
      hasLeave,
      hasOvertime: false, // 数据缺口（契约 13.5-②）
      hasOuting: false,   // 数据缺口（契约 13.5-③）
    });
  }

  summary.leaveDays = round1(summary.leaveDays);

  return { calendar, summary };
}

/* ==================== 导出（Excel 文件流，用 exceljs） ==================== */

async function exportEmployeeReport({ userId, startDate, endDate }) {
  if (!userId || !startDate || !endDate) {
    const err = new Error('请提供 userId、startDate 和 endDate 参数');
    err.statusCode = 400;
    throw err;
  }

  // 前端传的 userId 是员工ID（employee_id），与日历接口同样需先经映射表解析成
  // 真实 dingtalk_userid，否则 jobnumber 匹配的人导出的报表全是空/休息
  let dingtalkUserid = userId;
  const { rows: idRows } = await db.query(
    'SELECT dingtalk_userid, employee_name FROM dingtalk_user_mapping WHERE employee_id = $1 LIMIT 1',
    [userId]
  );
  if (idRows.length > 0 && idRows[0].dingtalk_userid) {
    dingtalkUserid = idRows[0].dingtalk_userid;
  }
  const userName = idRows[0]?.employee_name || userId;

  // 日级明细
  const { rows: dailyRows } = await db.query(`
    SELECT attendance_date, check_in_actual_time, check_out_actual_time,
      late_count, early_leave_count, lack_card_count, is_absent,
      late_minutes, early_leave_minutes, has_approval_cancel, valid_exception
    FROM attendance_daily_result
    WHERE dingtalk_userid = $1 AND attendance_date >= $2 AND attendance_date <= $3
    ORDER BY attendance_date
  `, [dingtalkUserid, startDate, endDate]);

  const { rows: leaveRows } = await db.query(`
    SELECT attendance_date, leave_code, duration_percent
    FROM attendance_leave_status
    WHERE dingtalk_userid = $1 AND attendance_date >= $2 AND attendance_date <= $3
  `, [dingtalkUserid, startDate, endDate]);
  const leaveMap = new Map();
  for (const r of leaveRows) {
    const d = fmtDate(r.attendance_date);
    leaveMap.set(d, (leaveMap.get(d) || 0) + num(r.duration_percent) / 100);
  }

  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('考勤明细');

  sheet.columns = [
    { header: '日期', key: 'date', width: 14 },
    { header: '上班打卡', key: 'checkIn', width: 12 },
    { header: '下班打卡', key: 'checkOut', width: 12 },
    { header: '工作状态', key: 'workStatus', width: 10 },
    { header: '异常类型', key: 'abnormalType', width: 10 },
    { header: '迟到(分钟)', key: 'lateMin', width: 12 },
    { header: '早退(分钟)', key: 'earlyMin', width: 12 },
    { header: '请假(小时)', key: 'leaveHours', width: 12 },
    { header: '审批抵消', key: 'approval', width: 10 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const r of dailyRows) {
    const date = fmtDate(r.attendance_date);
    const abnormalType = r.valid_exception ? pickAbnormalType(r) : '';
    const leaveHours = leaveMap.get(date) || 0;
    sheet.addRow({
      date,
      checkIn: fmtHHmm(r.check_in_actual_time),
      checkOut: fmtHHmm(r.check_out_actual_time),
      workStatus: r.valid_exception && abnormalType ? abnormalType : (leaveHours > 0 ? '请假' : '正常'),
      abnormalType,
      lateMin: num(r.late_minutes),
      earlyMin: num(r.early_leave_minutes),
      leaveHours: round1(leaveHours),
      approval: r.has_approval_cancel ? '是' : '',
    });
  }

  if (dailyRows.length === 0) {
    sheet.addRow({ date: `${startDate} ~ ${endDate} 无考勤数据` });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buffer),
    filename: `考勤明细_${userName}_${startDate}_${endDate}.xlsx`,
  };
}

async function exportDepartmentStats({ startDate, endDate, departmentPath }) {
  const list = await getBoardDepartmentStats({ startDate, endDate, departmentPath });

  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('部门考勤汇总');

  sheet.columns = [
    { header: '部门', key: 'dept', width: 28 },
    { header: '在岗人数', key: 'headcount', width: 10 },
    { header: '实际出勤(人·天)', key: 'actual', width: 16 },
    { header: '出勤率(%)', key: 'rate', width: 12 },
    { header: '迟到(人次)', key: 'late', width: 12 },
    { header: '早退(人次)', key: 'early', width: 12 },
    { header: '缺卡(人次)', key: 'miss', width: 12 },
    { header: '旷工(人次)', key: 'absent', width: 12 },
    { header: '请假时长(小时)', key: 'leave', width: 14 },
    { header: '加班时长(小时)', key: 'overtime', width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const it of list) {
    sheet.addRow({
      dept: it.departmentPath,
      headcount: it.headcount,
      actual: it.actualAttendCount,
      rate: it.attendanceRate,
      late: it.lateCount,
      early: it.earlyLeaveCount,
      miss: it.missCardCount,
      absent: it.absentCount,
      leave: it.leaveDuration,
      overtime: it.overtimeDuration,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buffer),
    filename: `部门考勤汇总_${startDate}_${endDate}.xlsx`,
  };
}

module.exports = {
  getBoardOptions,
  getBoardOverview,
  getBoardDepartmentStats,
  getAbnormalLateRank,
  getAbnormalMisscardRank,
  getAbnormalAbsentList,
  getAbnormalDetail,
  getAbnormalResubmitList,
  getLeaveStats,
  getOvertimeStats,
  getOutingStats,
  getLeaveOvertimeDetail,
  getBoardTrend,
  getEmployeeAttendanceList,
  getEmployeeCalendar,
  exportEmployeeReport,
  exportDepartmentStats,
};
