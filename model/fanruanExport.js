const { Pool } = require('pg');
const XLSX = require('xlsx');
const fs = require('fs').promises;
const path = require('path');
const db = require('../db');
require('dotenv').config();

// 数据库连接配置
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: false
});

// 工作表 -> 数据库表名映射
const sheetToTable = {
    '劳率': '劳率',
    '优化人数': '优化人数',
    '两级后备储备率': '两级后备储备率',
    '人工成本': '人工成本',
    '分类各层级人员工资水平分析': '分类各层级人员工资水平分析',
    '人事费用率': '人事费用率',
    '工资': '工资'
};
// 各表的主键字段映射（与之前定义的主键约束一致）
const tablePrimaryKeys = {
  '劳率': ['月份', '事业部'],
  '优化人数': ['月份', '事业部'],
  '两级后备储备率': ['月份', '指标类型'],
  '人工成本': ['年份', '月份', '事业部', '指标名称'],
  '分类各层级人员工资水平分析': ['事业部', '累计目前月份', '人员类别'],
  '人事费用率': ['年份', '月份', '事业部'],
  '工资': ['年份', '月份', '事业部']
};

// 数据类型转换
const transformValue = (value, column) => {
    if (value === null || value === undefined || value === 'nan' || value === '') return null;
    // 数值型字段转换
    if (['工资总额', '平均人数', '平均工资', '2025年完成情况（环比）', '年度预算', '实际完成', '当月实际'].includes(column)) {
        return parseFloat(value) || null;
    }
    return value.toString().trim(); // 其他字段转字符串
};

// 批量插入数据
const batchInsert = async (tableName, data) => {
  if (!data.length) return { success: true, newCount: 0, existCount: 0, message: '无数据导入' };

  try {
    // 1. 获取当前表的主键字段（如分类表的['事业部', '累计目前月份', '人员类别']）
    const primaryKeys = tablePrimaryKeys[tableName];
    if (!primaryKeys || primaryKeys.length === 0) {
      throw new Error(`未配置表${tableName}的主键字段，请检查tablePrimaryKeys`);
    }

    // 2. 提取待插入数据的主键组合（并过滤无效数据）
    const dataWithKey = data.map((row, index) => {
      // 生成主键组合字符串（如"铸锻公司||1-9月||首席"）
      const keyParts = primaryKeys.map(key => {
        const value = row[key]?.toString().trim() || '';
        return value;
      });
      const key = keyParts.join('||'); // 用特殊符号分隔，避免字段值拼接冲突
      return { row, key, index };
    });

    // 3. 批量查询数据库中已存在的主键（避免逐条查询，提高效率）
    const allKeys = dataWithKey.map(item => item.key);
    // 构建查询条件：主键组合 IN (所有待查的key)
    const placeholders = allKeys.map((_, i) => `$${i + 1}`).join(',');
    const query = `
      SELECT 
        ${primaryKeys.map(k => `"${k}"`).join(',')}, 
        ${primaryKeys.map(k => `COALESCE("${k}"::TEXT, '')`).join('||\'||\'')} AS "key" 
      FROM "${tableName}" 
      WHERE ${primaryKeys.map(k => `COALESCE("${k}"::TEXT, '')`).join('||\'||\'')} IN (${placeholders})
    `;
    const { rows: existRows } = await db.query(query, allKeys);
    // 提取已存在的key（用于后续过滤）
    const existKeys = new Set(existRows.map(row => row.key));

    // 4. 区分“新数据”和“重复数据”
    const newData = []; // 数据库中不存在的，需要插入
    const existDataCount = 0; // 已存在的数量（只统计，不插入）
    dataWithKey.forEach(item => {
      if (existKeys.has(item.key)) {
        // 重复数据：不插入，仅计数
        existDataCount++;
      } else {
        // 新数据：加入插入列表
        newData.push(item.row);
      }
    });

    // 5. 插入新数据（如果有）
    let newCount = 0;
    if (newData.length > 0) {
      await db.query('BEGIN');
      const columns = Object.keys(newData[0]).map(col => `"${col}"`).join(',');
      const placeholders = newData.map((_, i) => 
        `(${Object.keys(newData[0]).map((_, j) => `$${i * Object.keys(newData[0]).length + j + 1}`).join(',')})`
      ).join(',');
      const values = newData.flatMap(row => 
        Object.entries(row).map(([col, val]) => transformValue(val, col))
      );
      const res = await db.query(`INSERT INTO "${tableName}" (${columns}) VALUES ${placeholders}`, values);
      await db.query('COMMIT');
      newCount = res.rowCount;
    }

    // 6. 返回结果：新插入数量 + 已存在数量（不报错）
    return {
      success: true,
      newCount: newCount, // 本次新插入的条数
      existCount: existDataCount, // 已存在的重复条数
      message: `导入完成：新增${newCount}条，${existDataCount}条数据已存在`
    };

  } catch (err) {
    await db.query('ROLLBACK');
    return { 
      success: false, 
      message: `导入失败：${err.message}` // 只有非重复的错误才会报错（如格式错误）
    };
  } 
};
// 解析Excel并导入
const importExcel = async (fileBuffer, fileName) => {
    try {
        // 1. 先校验buffer是否有效（避免空buffer）
        if (!fileBuffer || fileBuffer.length === 0) {
            throw new Error('文件数据为空，无法解析');
        }

        // 2. 解析Excel（加错误捕获，确认解析成功）
        let workbook;
        try {
            workbook = XLSX.read(fileBuffer, { type: 'buffer' }); // 核心：type必须是'buffer'
        } catch (parseErr) {
            throw new Error(`Excel解析失败（可能文件损坏或格式错误）：${parseErr.message}`);
        }

        // 3. 校验workbook是否有工作表
        if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
            throw new Error(`Excel文件无工作表（文件：${fileName}）`);
        }

        const result = {};
        // 遍历所有工作表
        for (const sheetName of workbook.SheetNames) {
            const tableName = sheetToTable[sheetName];
            if (!tableName) {
                result[sheetName] = { success: false, message: '无对应数据表' };
                continue;
            }

            // 4. 校验工作表是否有效，避免undefined
            const worksheet = workbook.Sheets[sheetName];
            if (!worksheet) {
                result[sheetName] = { success: false, message: '工作表为空' };
                continue;
            }

            // 5. 解析数据并强校验（关键：避免jsonData是undefined）
            //   const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })
                .filter(row => {
                    // 判断一行是否“全为空”：去掉所有空值后如果长度为0，就是空行
                    const nonEmptyValues = row.filter(cell => cell != null && cell !== '' && cell.toString().trim() !== '');
                    return nonEmptyValues.length > 0; // 只保留有非空值的行
                });
            if (!Array.isArray(jsonData) || jsonData.length === 0) {
                result[sheetName] = { success: false, message: '工作表无数据' };
                continue;
            }

            // 6. 处理表头（现在jsonData肯定是数组，且有长度，访问[0]不会报错）
            const headers = jsonData[0].filter(h => h); // 过滤空表头
            if (headers.length === 0) {
                result[sheetName] = { success: false, message: '工作表无有效表头' };
                continue;
            }

            // 处理数据行
            const rows = jsonData.slice(1).map(row => {
                const rowObj = {};
                headers.forEach((header, idx) => {
                    rowObj[header] = row[idx] || null; // 空值处理，避免undefined
                });
                return rowObj;
            });

            // 插入数据库
            result[sheetName] = await batchInsert(tableName, rows);
        }

        return result;
    } catch (err) {
        // 明确报错文件名称（不再是undefined）
        throw new Error(`${err.message}（文件：${fileName}）`);
    }
};

module.exports = { importExcel };