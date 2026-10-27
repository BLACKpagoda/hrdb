// 薪酬数据管理 - 路由层
const express = require('express');
const router = express.Router();
const multer = require('multer');
const salaryController = require('./controller');
const { success, fail } = require('../../common/response');

// 文件上传配置：使用内存存储，req.file 会包含 buffer 字段
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// 1. 获取所有期间的薪酬明细汇总（用于累计和平均计算）
router.get('/salary-all-data', async (req, res) => {
  try {
    const data = await salaryController.getAllSalaryData();
    success(res, data, '获取薪酬数据成功');
  } catch (error) {
    console.error('获取全量薪酬数据失败:', error);
    fail(res, `获取数据失败：${error.message}`);
  }
});

// 2. 获取薪酬汇总数据（按部门/类别等维度）
router.get('/salary-summary', async (req, res) => {
  try {
    const {
      period, // 期间（必填）
      companies = [], // 前端转换后的数据库公司列表（如["一汽锻造（吉林）有限公司", ...]）
      categories = [] // 前端转换后的数据库人员类别列表（如["11-高级技能师", ...]）
    } = req.query;

    const data = await salaryController.getSalarySummary({
      period,
      companies: Array.isArray(companies) ? companies : [companies].filter(Boolean),
      categories: Array.isArray(categories) ? categories : [categories].filter(Boolean)
    });

    success(res, data, '获取薪酬汇总成功');
  } catch (error) {
    console.error('获取薪酬汇总数据失败:', error);
    fail(res, error.message, error.statusCode || 500);
  }
});

// 3. 获取薪酬期间列表（用于前端筛选器）
router.get('/salary-periods', async (req, res) => {
  try {
    const data = await salaryController.getSalaryPeriods();
    success(res, data, '获取期间列表成功');
  } catch (error) {
    console.error('获取薪酬期间列表失败:', error);
    fail(res, error.message);
  }
});

// 4. 薪酬数据导入接口（仅导入到 salary_data 表，薪酬原始数据）
router.post('/import-salary', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return fail(res, '未获取到文件，请重新选择Excel', 400);
    }
    if (!req.file.buffer) {
      return fail(res, '文件损坏，无法解析', 400);
    }

    const fileName = req.file.originalname || '未知文件名.xlsx';
    const result = await salaryController.importSalaryData(req.file.buffer, fileName);

    // 导入结果形如 { [sheet名]: { success, newCount, existCount, message } } 或 { error }
    const sheetResult = result && result.error
      ? { success: false, message: result.error }
      : (Object.values(result || {})[0] || {});

    if (sheetResult.success === false) {
      return fail(res, sheetResult.message || '薪酬数据导入失败');
    }
    success(res, result, '薪酬数据导入成功');
  } catch (err) {
    fail(res, `薪酬数据导入失败：${err.message}`);
  }
});

module.exports = router;
