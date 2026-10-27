// 钉钉考勤同步 - 路由层（新版）
// 接口：
//   POST /sync                 — 异步启动全量同步，立即返回 jobId
//   GET  /sync/status/:jobId   — 轮询同步任务进度
//   GET  /sync/mapping-stats   — 查看人员映射统计
//   GET  /sync/coverage        — 查看已同步数据覆盖范围
const express = require('express');
const router = express.Router();
const attendanceController = require('./controller');
const { success, fail } = require('../../common/response');

// POST /sync — 异步启动全量同步（方案B）
// 请求体：{ "fromDate": "2026-03-01", "toDate": "2026-03-31", "refreshMapping": true }
// 同时兼容旧参数名 { "startDate": ..., "endDate": ... }
router.post('/sync', async (req, res) => {
  try {
    const body = req.body || {};
    // 兼容新旧参数名
    const fromDate = body.fromDate || body.startDate;
    const toDate = body.toDate || body.endDate;
    const refreshMapping = body.refreshMapping !== false; // 默认 true

    console.log(`\n[路由] 收到同步请求: ${fromDate} ~ ${toDate}, refreshMapping=${refreshMapping}`);

    const result = attendanceController.syncAttendanceAsync({ fromDate, toDate, refreshMapping });
    success(res, result, result.message);
  } catch (error) {
    console.error('❌ 同步启动失败:', error);
    fail(res, error.message, error.statusCode || 500);
  }
});

// GET /sync/status/:jobId — 轮询同步任务状态
router.get('/sync/status/:jobId', async (req, res) => {
  try {
    const status = attendanceController.getSyncStatus(req.params.jobId);
    success(res, status);
  } catch (error) {
    fail(res, error.message, error.statusCode || 500);
  }
});

// GET /sync/mapping-stats — 人员映射统计
router.get('/sync/mapping-stats', async (req, res) => {
  try {
    const stats = await attendanceController.getMappingStats();
    success(res, stats);
  } catch (error) {
    fail(res, error.message, error.statusCode || 500);
  }
});

// GET /sync/coverage — 已同步数据覆盖范围
router.get('/sync/coverage', async (req, res) => {
  try {
    const coverage = await attendanceController.getDataCoverage();
    success(res, coverage);
  } catch (error) {
    fail(res, error.message, error.statusCode || 500);
  }
});

module.exports = router;
