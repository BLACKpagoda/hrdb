const express = require('express');
const router = express.Router();
const dingtalk = require('../model/dingtalk');
const exportUtils = require('../model/export'); // 导入export.js中的人员导入方法
const db = require('../db');
const { createTables } = require('../model/model');
const multer = require('multer'); // 确保正确导入multer库
const upload = multer({ dest: 'uploads/' });


// 同步考勤数据
router.get('/sync', async (req, res) => {
  try {
    // 0. 创建数据库表
    await createTables();

    // 1. 获取Access Token
    const token = await dingtalk.getAccessToken();
    // 2. 获取所有用户ID
    try {
      const allUsers = await dingtalk.getAllCompanyUsers(token);
      console.log('成功获取所有用户:', allUsers);
      // 3. 获取报表列定义
      const columns = await dingtalk.getReportColumns(token);
      // 4.保存列定义到数据库
      for (const col of columns) {
        await db.query(
          `INSERT INTO attendance_columns (column_id, column_name, data_type) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (column_id) DO UPDATE 
         SET column_name = EXCLUDED.column_name, data_type = EXCLUDED.data_type`,
          [col.id, col.name, col.type]
        );
      }
      // 5. 获取考勤数据（最近31天）
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - 30);

      const columnIds = columns.map(c => c.id);

      // 使用新的考勤数据获取方法
      const attendanceResult = await dingtalk.getAttendanceData(
        token,
        allUsers,
        columnIds,
        startDate,
        endDate,
        columns
      );
      // 6. 保存考勤数据
      const saveResult = await dingtalk.saveAttendanceData(db, attendanceResult);

      res.json({
        success: true,
        message: `考勤数据保存成功:
        - 原始记录: ${saveResult.recordCount} 条
        - 每日状态: ${saveResult.dailyStatusCount} 条
        - 打卡明细: ${saveResult.detailCount} 条
        - 月度汇总: ${saveResult.summaryCount} 条`,
        ...saveResult
      });

    } catch (error) {
      console.error('主流程错误:', error);
    }
  } catch (error) {
    console.error('同步失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 导入Excel员工数据
router.post('/import-employees', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '请上传Excel文件'
      });
    }

    const filePath = req.file.path;
    const sheetName = req.body.sheetName || 0; // 从前端获取工作表名称或索引
    const result = await exportUtils.importEmployeesFromExcel(filePath);

    res.json({
      success: true,
      message: `成功导入 ${result.success} 条记录，失败 ${result.errors.length} 条`,
      details: result
    });
  } catch (error) {
    console.error('导入失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 获取导入状态
router.get('/import-status', async (req, res) => {
  try {
    const status = await exportUtils.getImportStatus();
    res.json(status);
  } catch (error) {
    console.error('获取导入状态失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 日期格式化辅助函数
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

module.exports = router;