const XLSX = require('xlsx');
const db = require('../db');

// 每批插入行数
const BATCH_SIZE = 100;

// 月份中文映射（用于生成表名）
const monthChineseMap = {
  '01': '一月',
  '02': '二月',
  '03': '三月',
  '04': '四月',
  '05': '五月',
  '06': '六月',
  '07': '七月',
  '08': '八月',
  '09': '九月',
  '10': '十月',
  '11': '十一月',
  '12': '十二月'
};

// 获取月份的天数（用于生成日期字段）
const getDaysInMonth = (year, month) => {
  return new Date(year, month, 0).getDate(); // 月份从1开始，0表示上月最后一天
};

const importAttendanceData = async (req, res) => {
  try {
    // 1. 基础验证 + 获取月份信息
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请上传考勤Excel文件' });
    }
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: '请提供正确格式的月份（YYYY-MM）' });
    }
    const [year, monthNum] = month.split('-'); // 拆分年份和月份（如2025-08 → year=2025, monthNum=08）
    const monthCode = month.replace('-', ''); // 202508
    const monthChinese = monthChineseMap[monthNum]; // 八月
    const targetTable = `"${monthChinese}考勤"`; // 表名："八月考勤"
    const totalDays = getDaysInMonth(year, parseInt(monthNum)); // 该月总天数（如8月31天）
    console.log(`当前导入月份：${month}，表名：${targetTable}，总天数：${totalDays}`);

    // 2. 解析Excel
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = '月度汇总';
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      return res.status(400).json({ success: false, error: 'Excel中未找到"月度汇总"工作表' });
    }

    // 3. 提取数据和表头
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    if (jsonData.length < 2) {
      return res.status(400).json({ success: false, error: 'Excel中未包含有效数据' });
    }
    const headerRow = jsonData[0];
    const dataRows = jsonData.slice(1);
    const totalColumns = headerRow.length;
    console.log(`Excel表头总列数：${totalColumns}`);

    // 4. 动态生成表字段（核心：根据月份天数生成日期字段）
    // 4.1 固定字段（非日期字段，与之前一致）
    const fixedFields = [
      '姓名', '考勤组', '部门', '工号', '职位', 'UserId',
      '出勤天数', '休息天数', '工作时长', '迟到次数', '迟到时长',
      '严重迟到次数', '严重迟到时长', '旷工迟到次数', '早退次数', '早退时长',
      '上班缺卡次数', '下班缺卡次数', '旷工天数', '出差时长', '外出时长',
      '事假_小时', '病假_小时', '调休_小时', '年假_天', '产假_天',
      '陪产假_天', '婚假_天', '例假_天', '丧假_天', '哺乳假_小时',
      '探亲假_天', '节育假_天', '女员工产前检查假_天', '男职工护理假_天', '其他_天',
      '临时公出回来下班打卡_小时', '加班总时长', '工作日转加班费', '休息日转加班费',
      '节假日转加班费', '工作日转调休', '休息日转调休', '节假日转调休'
    ];

    // 4.2 动态生成日期字段（日1 ~ 日31_六/日，根据月份天数）
    const dateFields = [];
    // 假设Excel中日期列从第45列开始（索引44），与之前的结构一致
    for (let i = 1; i <= totalDays; i++) {
      // 判断该日期是周六还是周日（用于生成字段名，如“日6_六”）
      const date = new Date(`${year}-${monthNum}-${i}`);
      const day = date.getDay(); // 0=周日，6=周六
      let suffix = '';
      if (day === 6) suffix = '_六';
      if (day === 0) suffix = '_日';
      dateFields.push(`日${i}${suffix}`);
    }

    // 4.3 完整字段列表（固定字段 + 日期字段 + 月份）
    const tableFields = [...fixedFields, ...dateFields, '月份'];
    console.log(`动态生成字段总数：${tableFields.length}（固定字段${fixedFields.length} + 日期字段${dateFields.length} + 月份1）`);

    // 5. 处理数据（与之前逻辑一致，按列索引映射）
    const importData = [];
    dataRows.forEach((row, rowIndex) => {
      const rowNum = rowIndex + 2;
      if (row.length !== totalColumns) {
        console.warn(`第${rowNum}行数据列数异常（${row.length}列），已跳过`);
        return;
      }

      const rowData = {};
      row.forEach((cell, colIndex) => {
        const field = tableFields[colIndex];
        if (!field) return;

        // 空值处理
        if (cell === null || cell === undefined || String(cell).trim() === '' || String(cell).toLowerCase() === 'nan') {
          rowData[field] = null;
          return;
        }

        // 数值字段处理（固定字段中的数值列）
        if (fixedFields.includes(field) && fixedFields.indexOf(field) >= 6) { // 固定字段中第7个及以后是数值
          const num = parseFloat(String(cell).replace(/[^\d.-]/g, ''));
          rowData[field] = isNaN(num) ? String(cell).trim() : (num > 99999.99 ? 99999.99 : num);
          return;
        }

        // 字符串字段（日期字段和其他字符串）
        rowData[field] = String(cell).trim();
      });
      rowData['月份'] = monthCode; // 补充月份字段
      importData.push(rowData);
    });

    console.log(`有效数据行数：${importData.length}，分${Math.ceil(importData.length / BATCH_SIZE)}批导入`);
    if (importData.length === 0) {
      return res.status(400).json({ success: false, error: '未解析到有效考勤数据' });
    }

    // 6. 分批次插入（表名动态化）
    let totalInserted = 0;
    await db.query('BEGIN');

    for (let i = 0; i < importData.length; i += BATCH_SIZE) {
      const batch = importData.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      console.log(`开始导入第${batchNum}批（${batch.length}行）`);

      // 生成占位符和值
      const placeholders = batch.map((_, idx) => 
        `(${Array.from({ length: tableFields.length }, (_, j) => `$${idx * tableFields.length + j + 1}`).join(',')})`
      ).join(',');
      const values = batch.flatMap(row => tableFields.map(field => row[field]));

      // 插入SQL（表名使用动态生成的targetTable）
      const insertSql = `
        INSERT INTO ${targetTable} (${tableFields.map(f => `"${f}"`).join(',')})
        VALUES ${placeholders}
        ON CONFLICT ("UserId", "月份") DO UPDATE SET
          ${tableFields.map(f => `"${f}" = EXCLUDED."${f}"`).join(',')}
      `;
      const result = await db.query(insertSql, values);
      totalInserted += result.rowCount;
      console.log(`第${batchNum}批导入完成，本批成功${result.rowCount}行`);
    }

    await db.query('COMMIT');
    console.log(`所有批次导入完成，总成功${totalInserted}行`);

    res.json({
      success: true,
      message: `【${monthChinese}】考勤数据导入成功，共${totalInserted}条记录`,
      successCount: totalInserted,
      totalRows: importData.length,
      month: month
    });

  } catch (error) {
    await db.query('ROLLBACK');
    console.error('导入失败:', error);
    res.status(500).json({ 
      success: false, 
      error: `导入失败：${error.message}，已回滚所有数据` 
    });
  }
};

module.exports = { importAttendanceData };