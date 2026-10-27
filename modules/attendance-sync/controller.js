// 钉钉考勤同步 - 控制器层（新版）
// 流程：getAccessToken → getAllCompanyUsers → syncUserMapping → syncCheckResults → syncLeaveStatus → calcSummary
// 方案B：POST /sync 立即返回 jobId，后台异步执行，前端轮询 GET /sync/status/:jobId
const syncService = require('./service');
const { createJob, updateJob, addLog, getJob, cleanupOldJobs } = require('./jobManager');

/**
 * 校验同步参数（供同步/异步入口复用）
 */
function validateSyncParams({ fromDate, toDate }) {
  if (!fromDate || !toDate) {
    const err = new Error('请提供 fromDate 和 toDate 参数（格式：YYYY-MM-DD）');
    err.statusCode = 400;
    throw err;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    const err = new Error('日期格式错误，请使用 YYYY-MM-DD 格式');
    err.statusCode = 400;
    throw err;
  }
  const from = new Date(fromDate);
  const to = new Date(toDate);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    const err = new Error('无效的日期');
    err.statusCode = 400;
    throw err;
  }
  if (from > to) {
    const err = new Error('fromDate 不能晚于 toDate');
    err.statusCode = 400;
    throw err;
  }
}

/**
 * 异步同步入口（方案B）
 * 创建任务 → 后台 fire-and-forget 执行 fullSync → 立即返回 jobId
 */
function syncAttendanceAsync({ fromDate, toDate, refreshMapping = true }) {
  validateSyncParams({ fromDate, toDate });

  const jobId = createJob({ stage: '初始化', progress: 0 });
  updateJob(jobId, { status: 'running', stage: '初始化', progress: 0 });
  addLog(jobId, `开始同步 ${fromDate} ~ ${toDate}`);

  // 后台异步执行（不 await，立即返回 jobId）
  syncService.fullSync({
    fromDate,
    toDate,
    refreshMapping,
    onProgress: ({ stage, progress, message, type }) => {
      updateJob(jobId, { stage, progress });
      addLog(jobId, message, type);
    },
  }).then(result => {
    updateJob(jobId, {
      status: 'done',
      progress: 100,
      stage: '完成',
      result: {
        message: `考勤数据同步完成（${fromDate} ~ ${toDate}）`,
        ...result,
      },
    });
    addLog(jobId, '同步完成', 'success');
  }).catch(error => {
    updateJob(jobId, {
      status: 'error',
      stage: '失败',
      error: error.message,
    });
    addLog(jobId, `同步失败：${error.message}`, 'error');
  });

  // 定期清理旧任务
  cleanupOldJobs();

  return { jobId, message: `同步已启动（${fromDate} ~ ${toDate}）` };
}

/**
 * 查询任务状态
 */
function getSyncStatus(jobId) {
  const job = getJob(jobId);
  if (!job) {
    const err = new Error(`任务 ${jobId} 不存在或已过期`);
    err.statusCode = 404;
    throw err;
  }
  return job;
}

/** 获取当前 mapping 统计（用于查看人员匹配情况） */
async function getMappingStats() {
  const db = require('../../db');
  const { rows } = await db.query(`
    SELECT sync_status, employment_status, COUNT(*) as cnt
    FROM dingtalk_user_mapping
    GROUP BY sync_status, employment_status
    ORDER BY sync_status, employment_status
  `);

  const summary = {
    total: 0,
    matched: 0,
    unmatched: 0,
    activeMatched: 0,
    left: 0,
  };

  for (const row of rows) {
    summary.total += parseInt(row.cnt);
    if (row.sync_status === 'matched') {
      summary.matched += parseInt(row.cnt);
      if (row.employment_status === '在岗') {
        summary.activeMatched += parseInt(row.cnt);
      } else if (row.employment_status === '离职') {
        summary.left += parseInt(row.cnt);
      }
    } else {
      summary.unmatched += parseInt(row.cnt);
    }
  }

  return summary;
}

/** 获取同步覆盖的数据范围（用于看板前检查有多少数据） */
async function getDataCoverage() {
  const db = require('../../db');

  const { rows: dailyRange } = await db.query(`
    SELECT 
      MIN(attendance_date) as min_date,
      MAX(attendance_date) as max_date,
      COUNT(*) as total_rows
    FROM attendance_daily_result
  `);

  const { rows: leaveRange } = await db.query(`
    SELECT 
      MIN(attendance_date) as min_date,
      MAX(attendance_date) as max_date,
      COUNT(*) as total_rows
    FROM attendance_leave_status
  `);

  const { rows: deptRange } = await db.query(`
    SELECT 
      MIN(stat_date) as min_date,
      MAX(stat_date) as max_date,
      COUNT(*) as total_rows
    FROM attendance_department_daily
  `);

  const { rows: empRange } = await db.query(`
    SELECT 
      MIN(year_month) as min_month,
      MAX(year_month) as max_month,
      COUNT(*) as total_rows
    FROM attendance_employee_monthly
  `);

  return {
    daily_result: dailyRange[0],
    leave_status: leaveRange[0],
    dept_daily: deptRange[0],
    emp_monthly: empRange[0],
  };
}

module.exports = {
  syncAttendanceAsync,
  getSyncStatus,
  getMappingStats,
  getDataCoverage,
};
