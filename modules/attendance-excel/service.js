// 考勤Excel导入 - 业务服务层
// 合并自 model/analyze.js（餐补分析）和 model/excelImporter.js（原始考勤导入）
const XLSX = require('xlsx');
const moment = require('moment');
const db = require('../../db');
const { monthChineseMap, getTargetTableName, getDaysInMonth } = require('../../common/monthMap');

// ============================================================================
// 一、餐补分析相关（迁移自 analyze.js）
// ============================================================================

// 获取指定月份的标准工作日
async function getStandardWorkdays(month) {
  const startDate = moment(month).startOf('month').format('YYYY-MM-DD');
  const endDate = moment(month).endOf('month').format('YYYY-MM-DD');

  const result = await db.query(
    'SELECT date, is_workday FROM standard_workdays WHERE date BETWEEN $1 AND $2',
    [startDate, endDate]
  );

  // 关键：将date转换为YYYY-MM-DD字符串作为键
  return result.rows.reduce((map, item) => {
    // 无论数据库返回的date是Date对象还是字符串，统一格式化为YYYY-MM-DD
    const dateStr = moment(item.date).format('YYYY-MM-DD');
    map[dateStr] = item.is_workday;
    return map;
  }, {});
}

// 解析考勤数据
function parseAttendanceData(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];

  // 解析为JSON
  const jsonData = XLSX.utils.sheet_to_json(worksheet);

  // 假设钉钉导出的格式包含以下字段：员工ID、员工姓名、打卡日期、打卡时间列表
  return jsonData.map(row => ({
    employeeId: row['工号'] || row['UserId'],
    employeeName: row['姓名'],
    // 从考勤结果列提取打卡日期和时间
    dailyRecords: extractDailyRecords(row)
  }));
}

// 从考勤结果列提取每日打卡记录
function extractDailyRecords(row) {
  const dailyRecords = [];
  // TODO: 此处硬编码为2025年9月、固定30天，仅适用于该月份的Excel格式。
  //       后续应根据传入的 year/month 动态生成日期与天数。
  const yearMonth = '2025-09';
  const daysInMonth = 30;
  // 新的正则表达式，用于匹配调休、外出、出差、休息等特殊事件及时长
  const eventRegex = /(调休|外出|出差|休息)(\d{2}-\d{2} \d{2}:\d{2}到\d{2}-\d{2} \d{2}:\d{2})?\s*(\d+(?:\.\d+)?)\s*小时?/i;
  const restRegex = /休息/i;

  for (let day = 1; day <= daysInMonth; day++) {
    const colName = day.toString();
    const record = row[colName];
    if (!record) continue;

    const date = `${yearMonth}-${String(day).padStart(2, '0')}`;
    const dailyRecord = {
      checkDate: moment(date).format('YYYY-MM-DD'),
      checkTimes: [],
      specialEvents: []
    };

    // 提取打卡时间
    const timeMatch = record.match(/\((.*)\)/);
    if (timeMatch) {
      const times = timeMatch[1].split(',')
       .map(time => time.trim())
       .filter(time => time!== '-');
      dailyRecord.checkTimes = times.map(time => moment(`${date} ${time}`, 'YYYY-MM-DD HH:mm'));
    }

    // 提取特殊事件（含休息）
    const eventMatch = record.match(eventRegex);
    if (eventMatch) {
      const type = eventMatch[1];
      const duration = parseFloat(eventMatch[3]);
      dailyRecord.specialEvents.push({ type, duration });
    } else if (restRegex.test(record)) {
      // 休息事件：默认标记为"休息"，时长后续通过打卡计算
      dailyRecord.specialEvents.push({ type: '休息', duration: 0 }); 
    }

    dailyRecords.push(dailyRecord);
  }
  return dailyRecords;
}

// 计算单日工作时长（小时）
function calculateWorkHours(checkTimes) {
  if (checkTimes.length < 2) return 0;

  // 排序打卡时间
  checkTimes.sort((a, b) => a - b);

  // 取最早的上班时间和最晚的下班时间
  const firstCheck = checkTimes[0];
  const lastCheck = checkTimes[checkTimes.length - 1];

  // 计算小时差
  const duration = moment.duration(lastCheck.diff(firstCheck));
  return duration.asHours();
}

// 计算员工出勤天数
async function calculateAttendance(attendanceData, month) {
  const standardWorkdays = await getStandardWorkdays(month);
  
  const employeeGroups = {};
  attendanceData.forEach(record => {
    if (!employeeGroups[record.employeeId]) {
      employeeGroups[record.employeeId] = {
        employeeId: record.employeeId,
        employeeName: record.employeeName,
        dailyRecords: []
      };
    }
    employeeGroups[record.employeeId].dailyRecords.push(...record.dailyRecords);
  });
  
  return Object.values(employeeGroups).map(employee => {
    let actualWorkDays = 0;
    
    employee.dailyRecords.forEach(record => {
      const { checkDate, checkTimes, specialEvents } = record;
      const isWorkday = standardWorkdays[checkDate];
      const workHours = calculateWorkHours(checkTimes); // 计算当天实际打卡时长
      let isCounted = false; // 是否算出勤（默认否）

      // 1. 优先处理特殊事件
      if (specialEvents.length > 0) {
        specialEvents.forEach(event => {
          switch (event.type) {
            // 调休：>4小时不算出勤，否则按正常规则
            case '调休':
              if (event.duration <= 4) {
                // 调休≤4小时，按正常工作日/非工作日规则判断
                // isCounted = isWorkday ? (8-event.duration) > 0.5 : (8-event.duration) >= 4;
                isCounted = (8-event.duration) >=4
              } else {
                isCounted = false; // 调休>4小时不算出勤
              }
              break;

            // 外出：>4小时不算出勤，否则按正常规则
            case '外出':
              if (event.duration <= 4) {
                // isCounted = isWorkday ? workHours > 0.5 : workHours >= 4;
                isCounted = (8-event.duration) >=4
              } else {
                isCounted = false; // 外出>4小时不算出勤
              }
              break;

            // 出差：默认算出勤（可根据需求调整，如"出差需工作≥4小时"）
            case '出差':
              isCounted = true;
              break;

            // 休息：关键修改！有打卡且时长>4小时 → 算出勤
            case '休息':
              // 有打卡记录且工作时长>4小时 → 算出勤；否则不算
              isCounted = checkTimes.length > 0 && workHours > 4;
              break;
          }
        });
      } 
      // 2. 无特殊事件：按原规则判断
      else {
        isCounted = isWorkday ? workHours > 0.5 : workHours >= 4;
      }

      // 统计出勤天数
      if (isCounted) {
        actualWorkDays++;
      }

      // 日志：方便核对（可选）
      console.log(`
        员工：${employee.employeeName}
        日期：${checkDate}
        特殊事件：${JSON.stringify(specialEvents)}
        工作时长：${workHours.toFixed(2)}小时
        是否算出勤：${isCounted}
        当前出勤天数：${actualWorkDays}
      `);
    });
    
    return {
      employeeId: employee.employeeId,
      employeeName: employee.employeeName,
      actualWorkDays
    };
  });
}

// ============================================================================
// 二、原始考勤Excel导入相关（迁移自 excelImporter.js）
// ============================================================================

// 每批插入行数
const BATCH_SIZE = 100;

// 导入原始考勤数据到月份动态表（如"八月考勤"）
// 参数：fileBuffer（Excel缓冲区）、month（YYYY-MM格式）
// 返回：{ successCount, totalRows, month, monthChinese }
async function importRawAttendanceData(fileBuffer, month) {
  // 1. 基础验证 + 获取月份信息
  if (!fileBuffer) {
    const err = new Error('请上传考勤Excel文件');
    err.statusCode = 400;
    throw err;
  }
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    const err = new Error('请提供正确格式的月份（YYYY-MM）');
    err.statusCode = 400;
    throw err;
  }

  const [year, monthNum] = month.split('-'); // 拆分年份和月份（如2025-08 → year=2025, monthNum=08）
  const monthCode = month.replace('-', ''); // 202508
  const monthChinese = monthChineseMap[monthNum]; // 八月
  const targetTable = getTargetTableName(month); // 表名："八月考勤"
  const totalDays = getDaysInMonth(parseInt(year), parseInt(monthNum)); // 该月总天数（如8月31天）
  console.log(`当前导入月份：${month}，表名：${targetTable}，总天数：${totalDays}`);

  // 2. 解析Excel
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = '月度汇总';
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    const err = new Error('Excel中未找到"月度汇总"工作表');
    err.statusCode = 400;
    throw err;
  }

  // 3. 提取数据和表头
  const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  if (jsonData.length < 2) {
    const err = new Error('Excel中未包含有效数据');
    err.statusCode = 400;
    throw err;
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
    // 判断该日期是周六还是周日（用于生成字段名，如"日6_六"）
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
    const err = new Error('未解析到有效考勤数据');
    err.statusCode = 400;
    throw err;
  }

  // 6. 分批次插入（表名动态化）
  let totalInserted = 0;
  await db.query('BEGIN');

  try {
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

    return {
      successCount: totalInserted,
      totalRows: importData.length,
      month,
      monthChinese,
      message: `【${monthChinese}】考勤数据导入成功，共${totalInserted}条记录`
    };
  } catch (error) {
    await db.query('ROLLBACK');
    console.error('导入失败:', error);
    throw new Error(`导入失败：${error.message}，已回滚所有数据`);
  }
}

module.exports = {
  // 餐补分析相关
  parseAttendanceData,
  calculateAttendance,
  getStandardWorkdays,
  // 原始考勤导入相关
  importRawAttendanceData
};
