const XLSX = require('xlsx');
const moment = require('moment');
const db = require('../db');

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
  const daysInMonth = 30;
  // 新的正则表达式，用于匹配调休、外出、出差、休息等特殊事件及时长
  const eventRegex = /(调休|外出|出差|休息)(\d{2}-\d{2} \d{2}:\d{2}到\d{2}-\d{2} \d{2}:\d{2})?\s*(\d+(?:\.\d+)?)\s*小时?/i;
  const restRegex = /休息/i;

  for (let day = 1; day <= daysInMonth; day++) {
    const colName = day.toString();
    const record = row[colName];
    if (!record) continue;

    const date = `2025-09-${String(day).padStart(2, '0')}`;
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
      // 休息事件：默认标记为“休息”，时长后续通过打卡计算
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

            // 出差：默认算出勤（可根据需求调整，如“出差需工作≥4小时”）
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

module.exports = {
  parseAttendanceData,
  calculateAttendance,
  getStandardWorkdays
};