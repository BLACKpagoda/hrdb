// 考勤Excel导入 - 路由层
const express = require('express');
const router = express.Router();
const multer = require('multer');
const attendanceController = require('./controller');
const attendanceService = require('./service');
const { success, fail } = require('../../common/response');

// 文件上传配置：使用内存存储，req.file 会包含 buffer 字段
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 5. 考勤数据导入（分析餐补用）
router.post('/attendance/import', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const month = req.body.month;
    const result = await attendanceController.importAttendance(file, month);
    success(res, result, '考勤导入成功');
  } catch (error) {
    console.error('考勤导入错误:', error);
    fail(res, error.message, error.statusCode || 500);
  }
});

// 6. 考勤数据导入（原始考勤数据导入到月份动态表）
router.post('/attendance/excel', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return fail(res, '请上传考勤Excel文件', 400);
    }
    const { month } = req.body;
    const result = await attendanceService.importRawAttendanceData(req.file.buffer, month);
    success(res, result, '考勤数据导入成功');
  } catch (error) {
    console.error('导入失败:', error);
    fail(res, error.message, error.statusCode || 500);
  }
});

module.exports = router;
