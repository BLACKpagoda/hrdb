// 主路由
// 仅做模块挂载 + 保留三个不属于三大模块的接口（帆软导出、员工导入、员工列表）
const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const { success, fail } = require('../common/response');

// 保留接口所需的 service
const fanruanExport = require('../model/fanruanExport');
const exportUtils = require('../model/export'); // 人员导入方法

// 文件上传配置：使用内存存储
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ============================================================================
// 一、挂载三大业务模块路由
// ============================================================================
router.use('/', require('../modules/attendance-sync/routes'));     // 钉钉考勤同步
router.use('/', require('../modules/salary/routes'));               // 薪酬数据管理
router.use('/', require('../modules/attendance-excel/routes'));     // 考勤Excel导入
router.use('/', require('../modules/attendance-board/routes'));     // 考勤看板（API_CONTRACT.md 第十三章）
router.use('/', require('../modules/roster/routes'));               // 花名册管理

// ============================================================================
// 二、保留接口（暂未归入三大模块，留在主路由）
// ============================================================================

// 导入数字化指标excel（帆软数据用）
router.post('/export-fanruan', upload.single('file'), async (req, res) => {
  try {
    // 1. 先强校验：确保file和buffer都存在
    if (!req.file) {
      return fail(res, '未获取到文件，请重新选择Excel', 400);
    }
    if (!req.file.buffer) {
      return fail(res, '文件损坏，无法解析', 400);
    }

    // 2. 正确获取文件名（从req.file.originalname拿，避免undefined）
    const fileName = req.file.originalname || '未知文件名.xlsx';
    console.log('当前解析文件：', fileName, 'buffer大小：', req.file.buffer.length); // 打印日志确认

    // 3. 调用model时，确保参数正确传递
    const result = await fanruanExport.importExcel(req.file.buffer, fileName);
    success(res, result, '导入成功');

  } catch (err) {
    fail(res, `导入失败：${err.message}`);
  }
});

// 导入Excel员工数据(PS系统的表)
router.post('/import-employees', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return fail(res, '请上传Excel文件', 400);
    }

    // 注意：multer 使用 memoryStorage 时 req.file.path 为 undefined，
    // 这里保留原行为，multer bug 单独处理（详见 API_CONTRACT.md）
    const filePath = req.file.path;
    const sheetName = req.body.sheetName || 0;
    const result = await exportUtils.importEmployeesFromExcel(filePath, sheetName);

    success(
      res,
      { details: result },
      `成功导入 ${result.success} 条记录，失败 ${result.errors.length} 条`
    );
  } catch (error) {
    console.error('导入失败:', error);
    fail(res, error.message);
  }
});

// 人员明细数据（展示PS系统数据）
router.get('/personnel/list', (req, res) => {
  // 1. 解析前端分页参数（严格匹配?page=1&size=10）
  const page = parseInt(req.query.page) || 1;
  const size = parseInt(req.query.size) || 10;
  const offset = (page - 1) * size; // 计算偏移量

  // 2. 第一步：查询总条数（用于前端分页）
  const countSql = 'SELECT COUNT(*) AS total FROM employees';
  db.query(countSql, (countErr, countResult) => {
    if (countErr) {
      return fail(res, `获取员工总数失败：${countErr.message}`);
    }
    const total = countResult.rows[0].total;

    // 3. 第二步：查询当前页数据（人大金仓分页语法）
    // 关键修改：MySQL的 LIMIT ?,? → 人大金仓的 LIMIT ? OFFSET ?
    const listSql = `SELECT * FROM employees LIMIT ${size} OFFSET ${offset}`;
    db.query(listSql, (listErr, listResult) => {
      if (listErr) {
        return fail(res, `获取员工列表失败：${listErr.message}`);
      }
      const pureEmployeeList = listResult.rows || [];
      success(res, { list: pureEmployeeList, total }, '获取员工信息成功');
    });
  });
});

module.exports = router;
