// 考勤看板 - 路由层
// 17 个接口与前端 src/api/attendance.js 一一对应（契约：API_CONTRACT.md 第十三章）
// 响应：JSON 接口统一 { code, msg, data }；导出接口直接返回 Excel 文件流

const express = require('express');
const router = express.Router();
const { success, fail } = require('../../common/response');
const controller = require('./controller');

// 包装 async handler：业务错误统一走 fail
const wrap = (fn) => async (req, res) => {
  try {
    const data = await fn(req, res);
    success(res, data);
  } catch (error) {
    console.error(`[attendance-board] ${req.method} ${req.path} 失败:`, error.message);
    fail(res, error.message, error.statusCode || 500);
  }
};

// 文件流响应：Content-Disposition 文件名按 RFC 5987 编码（支持中文）
const sendFile = (res, { buffer, filename }) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(buffer);
};

/* ==================== 板块0：筛选选项 ==================== */
router.get('/attendance/board/options', wrap(controller.getBoardOptions));

/* ==================== 板块1：总览 KPI + 状态分布 ==================== */
router.get('/attendance/board/overview', wrap(controller.getBoardOverview));

/* ==================== 板块2：部门统计 ==================== */
router.get('/attendance/board/department-stats', wrap(controller.getBoardDepartmentStats));
router.get('/attendance/board/department-stats/export', async (req, res) => {
  try {
    const file = await controller.exportDepartmentStats(req, res);
    sendFile(res, file);
  } catch (error) {
    console.error('[attendance-board] 部门汇总导出失败:', error.message);
    fail(res, error.message, error.statusCode || 500);
  }
});

/* ==================== 板块3：异常考勤 ==================== */
router.get('/attendance/board/abnormal/late-rank', wrap(controller.getAbnormalLateRank));
router.get('/attendance/board/abnormal/misscard-rank', wrap(controller.getAbnormalMisscardRank));
router.get('/attendance/board/abnormal/absent-list', wrap(controller.getAbnormalAbsentList));
router.get('/attendance/board/abnormal/detail', wrap(controller.getAbnormalDetail));
router.get('/attendance/board/abnormal/resubmit-list', wrap(controller.getAbnormalResubmitList));

/* ==================== 板块4：请假 / 加班 / 外出 ==================== */
router.get('/attendance/board/leave/stats', wrap(controller.getLeaveStats));
router.get('/attendance/board/overtime/stats', wrap(controller.getOvertimeStats));
router.get('/attendance/board/outing/stats', wrap(controller.getOutingStats));
router.get('/attendance/board/leave-overtime/detail', wrap(controller.getLeaveOvertimeDetail));

/* ==================== 板块5：趋势分析 ==================== */
router.get('/attendance/board/trend', wrap(controller.getBoardTrend));

/* ==================== 板块6：人员明细 ==================== */
router.get('/attendance/board/employee/list', wrap(controller.getEmployeeAttendanceList));
router.get('/attendance/board/employee/calendar', wrap(controller.getEmployeeCalendar));
router.get('/attendance/board/employee/export', async (req, res) => {
  try {
    const file = await controller.exportEmployeeReport(req, res);
    sendFile(res, file);
  } catch (error) {
    console.error('[attendance-board] 个人报表导出失败:', error.message);
    fail(res, error.message, error.statusCode || 500);
  }
});

module.exports = router;
