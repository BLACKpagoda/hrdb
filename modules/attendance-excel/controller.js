// 考勤Excel导入 - 控制器层
// 迁移自 controller/attendanceController.js，假期配置改用 config/holidays.js
const attendanceService = require('./service');
const db = require('../../db');
const moment = require('moment');
const holidayConfig = require('../../config/holidays');

// 批量生成指定月份的工作日数据（结合法定假日和调休配置）
async function initWorkdays(month) {
  const start = moment(month).startOf('month');
  const end = moment(month).endOf('month');
  const days = [];
  
  for (let m = moment(start); m.isSameOrBefore(end); m.add(1, 'day')) {
    // 生成YYYY-MM-DD格式的字符串
    const dateStr = m.format('YYYY-MM-DD'); 
    const dayOfWeek = m.day();
    let isWorkday;

    if (holidayConfig[dateStr]) {
      isWorkday = holidayConfig[dateStr].isWorkday;
    } else {
      isWorkday = dayOfWeek!== 0 && dayOfWeek!== 6;
    }

    days.push({ date: dateStr, isWorkday }); // 用字符串日期
  }
  
  // 插入数据库时使用字符串日期
  for (const day of days) {
    await db.query(
      `INSERT INTO standard_workdays (date, is_workday, remark) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (date) DO NOTHING`,
      [
        day.date, // 直接使用YYYY-MM-DD字符串
        day.isWorkday,
        holidayConfig[day.date]?.isHoliday? '法定假日' : 
        holidayConfig[day.date]?.isWorkday? '调休上班' : 
        (day.isWorkday? '正常工作日' : '正常休息日')
      ]
    );
  }
  
  console.log(`已初始化${month}的工作日数据，共${days.length}天`);
  return days;
}

// 导入考勤Excel（用于餐补分析）
async function importAttendance(file, month) {
  if (!file || !month) {
    const err = new Error('请提供文件和月份');
    err.statusCode = 400;
    throw err;
  }
  await initWorkdays(month); 
  // 解析考勤数据
  const attendanceData = attendanceService.parseAttendanceData(file.buffer);
  
  // 验证数据
  const errors = [];
  attendanceData.forEach((record, index) => {
    if (!record.employeeId) {
      errors.push(`第${index}行数据不完整：缺少员工`);
    }
  });
  
  // 计算出勤天数
  const attendanceSummary = await attendanceService.calculateAttendance(attendanceData, month);
  
  // 保存到数据库
  for (const summary of attendanceSummary) {
    await db.query(
      `INSERT INTO employee_attendance_summary 
       (employee_id, employee_name, month, actual_work_days, import_time)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (employee_id, month) 
       DO UPDATE SET actual_work_days = $4, import_time = NOW()`,
      [summary.employeeId, summary.employeeName, month, summary.actualWorkDays]
    );
  }

  return {
    successCount: attendanceData.length - errors.length,
    errors,
    attendanceSummary
  };
}

module.exports = {
  importAttendance,
  initWorkdays 
};
