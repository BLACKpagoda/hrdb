// 考勤看板 - 控制器层
// 职责：解析/校验 HTTP 查询参数，调用 service，统一走 common/response.js 返回
// 契约：API_CONTRACT.md 第十三章（与前端 src/api/attendance.js 字段一一对应）

const boardService = require('./service');

/** 提取通用查询参数 */
function parseCommonQuery(query) {
  return {
    startDate: query.startDate,
    endDate: query.endDate,
    departmentPath: query.departmentPath || '',
  };
}

/** 分页参数 */
function parsePageQuery(query) {
  return {
    page: query.page,
    size: query.size,
  };
}

/* 板块0：筛选选项 */
async function getBoardOptions(req, res, next) {
  const data = await boardService.getBoardOptions();
  return data;
}

/* 板块1：总览 KPI + 状态分布 */
async function getBoardOverview(req, res, next) {
  return boardService.getBoardOverview(parseCommonQuery(req.query));
}

/* 板块2：部门统计 */
async function getBoardDepartmentStats(req, res, next) {
  return boardService.getBoardDepartmentStats(parseCommonQuery(req.query));
}

/* 板块3-1：迟到 TOP */
async function getAbnormalLateRank(req, res, next) {
  return boardService.getAbnormalLateRank({
    ...parseCommonQuery(req.query),
    limit: req.query.limit,
  });
}

/* 板块3-2：缺卡 TOP */
async function getAbnormalMisscardRank(req, res, next) {
  return boardService.getAbnormalMisscardRank({
    ...parseCommonQuery(req.query),
    limit: req.query.limit,
  });
}

/* 板块3-3：旷工清单 */
async function getAbnormalAbsentList(req, res, next) {
  return boardService.getAbnormalAbsentList(parseCommonQuery(req.query));
}

/* 板块3-4：异常明细（分页） */
async function getAbnormalDetail(req, res, next) {
  return boardService.getAbnormalDetail({
    ...parseCommonQuery(req.query),
    ...parsePageQuery(req.query),
  });
}

/* 板块3-5：补卡列表（缺口①，空数组） */
async function getAbnormalResubmitList(req, res, next) {
  return boardService.getAbnormalResubmitList({
    startDate: req.query.startDate,
    endDate: req.query.endDate,
    status: req.query.status,
  });
}

/* 板块4-1：请假统计 */
async function getLeaveStats(req, res, next) {
  return boardService.getLeaveStats(parseCommonQuery(req.query));
}

/* 板块4-2：加班统计（缺口②，空数据） */
async function getOvertimeStats(req, res, next) {
  return boardService.getOvertimeStats(parseCommonQuery(req.query));
}

/* 板块4-3：外出统计（缺口③，空数据） */
async function getOutingStats(req, res, next) {
  return boardService.getOutingStats(parseCommonQuery(req.query));
}

/* 板块4-4：请假/加班明细（分页） */
async function getLeaveOvertimeDetail(req, res, next) {
  return boardService.getLeaveOvertimeDetail({
    ...parseCommonQuery(req.query),
    type: req.query.type || 'leave',
    ...parsePageQuery(req.query),
  });
}

/* 板块5：趋势分析 */
async function getBoardTrend(req, res, next) {
  return boardService.getBoardTrend(parseCommonQuery(req.query));
}

/* 板块6-1：人员明细列表（分页） */
async function getEmployeeAttendanceList(req, res, next) {
  return boardService.getEmployeeAttendanceList({
    ...parseCommonQuery(req.query),
    ...parsePageQuery(req.query),
    keyword: req.query.keyword || '',
  });
}

/* 板块6-2：个人考勤日历 */
async function getEmployeeCalendar(req, res, next) {
  return boardService.getEmployeeCalendar({
    userId: req.query.userId,
    month: req.query.month,
  });
}

/* 板块6-3：导出个人考勤报表（Excel 文件流） */
async function exportEmployeeReport(req, res, next) {
  return boardService.exportEmployeeReport({
    userId: req.query.userId,
    startDate: req.query.startDate,
    endDate: req.query.endDate,
  });
}

/* 板块6-4：导出部门汇总（Excel 文件流） */
async function exportDepartmentStats(req, res, next) {
  return boardService.exportDepartmentStats(parseCommonQuery(req.query));
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
