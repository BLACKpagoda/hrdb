// 月份中文映射（用于动态生成考勤表名，如"八月考勤"）
// 统一维护，避免在多个文件中重复定义
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

// 获取目标表名（如"十一月考勤"），输入格式：YYYY-MM
const getTargetTableName = (month) => {
  const [, monthNum] = month.split('-');
  return `"${monthChineseMap[monthNum]}考勤"`;
};

// 获取月份的天数（year 为数字、month 为 1-12 的数字）
const getDaysInMonth = (year, month) => {
  return new Date(year, month, 0).getDate(); // 月份从1开始，0表示上月最后一天
};

module.exports = {
  monthChineseMap,
  getTargetTableName,
  getDaysInMonth
};
