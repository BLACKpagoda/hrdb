// 薪酬数据管理 - 控制器层
// 迁移自 routes/index.js 中的 /salary-* 业务逻辑
const db = require('../../db');
const salaryService = require('./service');

// 1. 获取所有期间的薪酬明细汇总（用于累计和平均计算）
async function getAllSalaryData() {
  // 关键调整：确保按【期间+公司+人员类别】精确分组，人数和工资计算准确
  // 2026年期间使用 不含2025年年终奖应计，其他期间使用 不含2024年年终奖应计
  const { rows } = await db.query(
    `SELECT 
      "期间",
      "公司", 
      "人员类别",
      -- 核心区分逻辑：2026年取新字段，历史期间取旧字段
      SUM(
        CASE
          WHEN "期间" LIKE '2026%' THEN "不含2025年年终奖应计"
          ELSE "不含2024年年终奖应计"
        END
      ) AS "应计工资总和",
      COUNT(DISTINCT "员工ID") AS "人数"
     FROM salary_data 
     WHERE "期间" IS NOT NULL 
       AND "公司" IS NOT NULL 
       AND "人员类别" IS NOT NULL
     GROUP BY "期间", "公司", "人员类别"
     ORDER BY "期间" ASC
    `
  );
  return rows;
}

// 2. 获取薪酬汇总数据（按公司、人员类别等维度筛选）
async function getSalarySummary({ period, companies = [], categories = [] }) {
  if (!period) {
    const err = new Error('请指定期间（period）');
    err.statusCode = 400;
    throw err;
  }

  // 构建查询条件
  let queryParams = [period];
  let whereClause = 'WHERE "期间" = $1';
  let paramIndex = 2;

  // 公司筛选
  if (companies.length > 0) {
    const placeholders = companies.map((_, i) => `$${paramIndex + i}`).join(',');
    whereClause += ` AND "公司" IN (${placeholders})`;
    queryParams.push(...companies);
    paramIndex += companies.length;
  }

  // 人员类别筛选
  if (categories.length > 0) {
    const placeholders = categories.map((_, i) => `$${paramIndex + i}`).join(',');
    whereClause += ` AND "人员类别" IN (${placeholders})`;
    queryParams.push(...categories);
    paramIndex += categories.length;
  }

  // 查询原始数据（按公司、人员类别、期间分组，计算应计工资总和和人数）
  const { rows } = await db.query(
    `SELECT 
      "公司", 
      "人员类别", 
      "期间",
      SUM("不含2024年年终奖应计") as "应计工资总和",
      COUNT(DISTINCT "员工ID") as "人数"
     FROM salary_data 
     ${whereClause}
     GROUP BY "公司", "人员类别", "期间"
     ORDER BY "公司", "人员类别"`,
    queryParams
  );

  return rows;
}

// 3. 获取薪酬期间列表（用于前端筛选器）
async function getSalaryPeriods() {
  const { rows } = await db.query(
    `SELECT DISTINCT "期间" FROM salary_data ORDER BY "期间" DESC`
  );
  return rows.map(row => row.期间);
}

// 4. 导入薪酬数据（仅导入到 salary_data 表）
async function importSalaryData(fileBuffer, fileName) {
  return await salaryService.importSalaryData(fileBuffer, fileName);
}

module.exports = {
  getAllSalaryData,
  getSalarySummary,
  getSalaryPeriods,
  importSalaryData
};
