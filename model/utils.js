// 月份中文映射（与excelImporter保持一致）
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

// 获取月份的天数
const getDaysInMonth = (year, month) => {
  return new Date(year, month, 0).getDate();
};

// 生成日期字段名（如"日1_六"）
const getDateFieldName = (dateStr) => {
  const [year, month, day] = dateStr.split('-');
  const date = new Date(dateStr);
  const dayOfWeek = date.getDay(); // 0=周日，6=周六
  let suffix = '';
  if (dayOfWeek === 6) suffix = '_六';
  if (dayOfWeek === 0) suffix = '_日';
  return `日${day}${suffix}`;
};

// 生成目标表名（如"十一月考勤"）
const getTargetTableName = (month) => {
  const [, monthNum] = month.split('-'); // 输入格式：YYYY-MM
  return `"${monthChineseMap[monthNum]}考勤"`;
};

// 格式化年月（YYYYMM）
const formatYearMonthCode = (month) => {
  return month.replace('-', '');
};

module.exports = {
  monthChineseMap,
  getDaysInMonth,
  getDateFieldName,
  getTargetTableName,
  formatYearMonthCode
};