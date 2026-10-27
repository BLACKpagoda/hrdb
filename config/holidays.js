// 法定节假日及调休配置
// 格式：{ 日期: { isHoliday: 是否法定假, isWorkday: 是否调休上班 } }
// 未列出的日期按周末规则判断（周六日休息，工作日上班）
//
// 维护说明：
// - 每年国务院发布下一年度放假安排后，补充对应年份配置
// - isHoliday=true 表示法定假日（休息），isWorkday=true 表示调休补班

const holidayConfig = {
  // ============== 2025 年 ==============
  '2025-01-01': { isHoliday: true, isWorkday: false },
  '2025-01-02': { isHoliday: true, isWorkday: false },
  '2025-01-03': { isHoliday: true, isWorkday: false },
  '2025-01-05': { isHoliday: false, isWorkday: true }, // 元旦调休上班

  // 春节：1月28日-2月3日放假（除夕至初六），1月26日（周日）、2月8日（周六）调休上班
  '2025-01-28': { isHoliday: true, isWorkday: false }, // 除夕
  '2025-01-29': { isHoliday: true, isWorkday: false }, // 初一
  '2025-01-30': { isHoliday: true, isWorkday: false }, // 初二
  '2025-01-31': { isHoliday: true, isWorkday: false }, // 初三
  '2025-02-01': { isHoliday: true, isWorkday: false }, // 初四
  '2025-02-02': { isHoliday: true, isWorkday: false }, // 初五
  '2025-02-03': { isHoliday: true, isWorkday: false }, // 初六
  '2025-01-26': { isHoliday: false, isWorkday: true }, // 调休上班
  '2025-02-08': { isHoliday: false, isWorkday: true }, // 调休上班

  // 清明节：4月4日-6日放假，4月7日（周一）调休上班
  '2025-04-04': { isHoliday: true, isWorkday: false },
  '2025-04-05': { isHoliday: true, isWorkday: false },
  '2025-04-06': { isHoliday: true, isWorkday: false },
  '2025-04-07': { isHoliday: false, isWorkday: true }, // 调休上班

  // 劳动节：5月1日-5日放假，4月27日（周日）、5月10日（周六）调休上班
  '2025-05-01': { isHoliday: true, isWorkday: false },
  '2025-05-02': { isHoliday: true, isWorkday: false },
  '2025-05-03': { isHoliday: true, isWorkday: false },
  '2025-05-04': { isHoliday: true, isWorkday: false },
  '2025-05-05': { isHoliday: true, isWorkday: false },
  '2025-04-27': { isHoliday: false, isWorkday: true }, // 调休上班
  '2025-05-10': { isHoliday: false, isWorkday: true }, // 调休上班

  // 端午节：6月1日-3日放假（含周末）
  '2025-06-01': { isHoliday: true, isWorkday: false },
  '2025-06-02': { isHoliday: true, isWorkday: false },
  '2025-06-03': { isHoliday: true, isWorkday: false },

  // 国庆节：10月1日-7日放假，9月28日（周日）、10月11日（周六）调休上班
  '2025-10-01': { isHoliday: true, isWorkday: false },
  '2025-10-02': { isHoliday: true, isWorkday: false },
  '2025-10-03': { isHoliday: true, isWorkday: false },
  '2025-10-04': { isHoliday: true, isWorkday: false },
  '2025-10-05': { isHoliday: true, isWorkday: false },
  '2025-10-06': { isHoliday: true, isWorkday: false },
  '2025-10-07': { isHoliday: true, isWorkday: false },
  '2025-09-28': { isHoliday: false, isWorkday: true }, // 调休上班
  '2025-10-11': { isHoliday: false, isWorkday: true }, // 调休上班

  // ============== 2026 年 ==============
  // 依据国务院办公厅发布的 2026 年放假安排
  // 元旦：1月1日放假
  '2026-01-01': { isHoliday: true, isWorkday: false },

  // 春节：2月17日（除夕）-2月23日放假，2月14日（周六）、2月15日（周日）调休上班
  '2026-02-17': { isHoliday: true, isWorkday: false }, // 除夕
  '2026-02-18': { isHoliday: true, isWorkday: false }, // 初一
  '2026-02-19': { isHoliday: true, isWorkday: false }, // 初二
  '2026-02-20': { isHoliday: true, isWorkday: false }, // 初三
  '2026-02-21': { isHoliday: true, isWorkday: false }, // 初四
  '2026-02-22': { isHoliday: true, isWorkday: false }, // 初五
  '2026-02-23': { isHoliday: true, isWorkday: false }, // 初六
  '2026-02-14': { isHoliday: false, isWorkday: true }, // 调休上班（周六）
  '2026-02-15': { isHoliday: false, isWorkday: true }, // 调休上班（周日）

  // 清明节：4月4日-6日放假（含周末），4月4日（周日）为法定假日
  '2026-04-04': { isHoliday: true, isWorkday: false },
  '2026-04-05': { isHoliday: true, isWorkday: false },
  '2026-04-06': { isHoliday: true, isWorkday: false },

  // 劳动节：5月1日放假，与周末连休（5月1日-3日）
  '2026-05-01': { isHoliday: true, isWorkday: false },
  '2026-05-02': { isHoliday: true, isWorkday: false },
  '2026-05-03': { isHoliday: true, isWorkday: false },

  // 端午节：6月19日-21日放假（含周末），6月19日（周五）为法定假日
  '2026-06-19': { isHoliday: true, isWorkday: false },
  '2026-06-20': { isHoliday: true, isWorkday: false },
  '2026-06-21': { isHoliday: true, isWorkday: false },

  // 中秋节：9月25日-27日放假（含周末），9月25日（周五）为法定假日
  '2026-09-25': { isHoliday: true, isWorkday: false },
  '2026-09-26': { isHoliday: true, isWorkday: false },
  '2026-09-27': { isHoliday: true, isWorkday: false },

  // 国庆节：10月1日-7日放假，9月26日（周六）调休上班（注：与中秋相邻安排）
  '2026-10-01': { isHoliday: true, isWorkday: false },
  '2026-10-02': { isHoliday: true, isWorkday: false },
  '2026-10-03': { isHoliday: true, isWorkday: false },
  '2026-10-04': { isHoliday: true, isWorkday: false },
  '2026-10-05': { isHoliday: true, isWorkday: false },
  '2026-10-06': { isHoliday: true, isWorkday: false },
  '2026-10-07': { isHoliday: true, isWorkday: false },
  '2026-10-10': { isHoliday: false, isWorkday: true } // 调休上班（周六）
};

module.exports = holidayConfig;
