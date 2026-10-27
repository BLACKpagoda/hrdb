/**
 * 考勤看板新数据模型建表脚本
 * 运行方式：node model/init_attendance_tables.js
 * 
 * 废弃旧表（可选，手动确认后再跑 DROP）：
 *   daily_attendance, attendance_summary, leave_records, overtime_records,
 *   attendance_columns, attendance_records, attendance_sync_errors,
 *   employee_attendance_summary, standard_workdays,
 *   yykq1, sykq3, sykq4, wykq5, lykq6, qykq7, bykq8, jykq9, sykq10, syykq11, seykq12
 */

const db = require('../db');

async function initTables() {
  console.log('=== 开始创建考勤看板新数据模型 ===\n');

  // 1. 钉钉用户映射表（UserId ↔ 花名册员工ID）
  await db.query(`
    CREATE TABLE IF NOT EXISTS dingtalk_user_mapping (
      id SERIAL PRIMARY KEY,
      dingtalk_userid VARCHAR(64) UNIQUE NOT NULL,
      employee_id VARCHAR(32),
      employee_name VARCHAR(64),
      department_path VARCHAR(256),
      jobnumber VARCHAR(32),
      employment_status VARCHAR(32),
      sync_status VARCHAR(16) DEFAULT 'pending',
      match_method VARCHAR(16),
      dingtalk_name VARCHAR(64),
      remark TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  console.log('✅ dingtalk_user_mapping 创建完成');

  // 旧库补列（CREATE TABLE IF NOT EXISTS 不会给已有表加列）
  await db.query('ALTER TABLE dingtalk_user_mapping ADD COLUMN IF NOT EXISTS match_method VARCHAR(16)');
  await db.query('ALTER TABLE dingtalk_user_mapping ADD COLUMN IF NOT EXISTS dingtalk_name VARCHAR(64)');

  // 2. 考勤日级结果表（帆软核心数据源，一行=一人=一天）
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_daily_result (
      id BIGSERIAL PRIMARY KEY,
      employee_id VARCHAR(32),
      dingtalk_userid VARCHAR(64) NOT NULL,
      employee_name VARCHAR(64),
      department_path VARCHAR(256),
      attendance_date DATE NOT NULL,

      -- 上班打卡
      check_in_base_time TIMESTAMP WITH TIME ZONE,
      check_in_actual_time TIMESTAMP WITH TIME ZONE,
      check_in_time_result VARCHAR(32),
      check_in_location_result VARCHAR(32),
      check_in_proc_inst_id VARCHAR(128),

      -- 下班打卡
      check_out_base_time TIMESTAMP WITH TIME ZONE,
      check_out_actual_time TIMESTAMP WITH TIME ZONE,
      check_out_time_result VARCHAR(32),
      check_out_location_result VARCHAR(32),
      check_out_proc_inst_id VARCHAR(128),

      -- 当日迟到早退时长（分钟）
      late_minutes INTEGER DEFAULT 0,
      early_leave_minutes INTEGER DEFAULT 0,

      -- 汇总字段
      late_count INTEGER DEFAULT 0,
      early_leave_count INTEGER DEFAULT 0,
      lack_card_count INTEGER DEFAULT 0,
      is_absent BOOLEAN DEFAULT FALSE,

      -- 异常抵消标记（procInstId 非空表示关联了请假/加班审批）
      has_approval_cancel BOOLEAN DEFAULT FALSE,
      valid_exception BOOLEAN DEFAULT FALSE,

      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

      UNIQUE(dingtalk_userid, attendance_date)
    )
  `);
  console.log('✅ attendance_daily_result 创建完成');

  // 3. 请假状态表（钉钉 getleavestatus）
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_leave_status (
      id BIGSERIAL PRIMARY KEY,
      employee_id VARCHAR(32),
      dingtalk_userid VARCHAR(64) NOT NULL,
      employee_name VARCHAR(64),
      department_path VARCHAR(256),
      attendance_date DATE NOT NULL,
      leave_code VARCHAR(64),
      duration_percent NUMERIC(10,2),
      duration_unit VARCHAR(32),
      start_time TIMESTAMP WITH TIME ZONE,
      end_time TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

      UNIQUE(dingtalk_userid, attendance_date, leave_code)
    )
  `);
  console.log('✅ attendance_leave_status 创建完成');

  // 2.1 花名册表（每月从公司 HR 系统导出，含手机号用于精准匹配钉钉用户）
  await db.query(`
    CREATE TABLE IF NOT EXISTS employee_roster (
      id BIGSERIAL PRIMARY KEY,
      employee_id VARCHAR(32) NOT NULL,
      full_name VARCHAR(64) NOT NULL,
      department VARCHAR(128),
      mobile VARCHAR(20),
      id_card VARCHAR(20),
      employment_status VARCHAR(32) DEFAULT '在岗',
      year_month VARCHAR(7) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE(employee_id, year_month)
    )
  `);
  console.log('✅ employee_roster 创建完成');

  // 3.1 请假类型名称映射表（钉钉 getleavetypelist，leave_code → 可读名称）
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_leave_type (
      leave_code VARCHAR(64) PRIMARY KEY,
      leave_name VARCHAR(128),
      view_unit VARCHAR(32),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  console.log('✅ attendance_leave_type 创建完成');

  // 4. 部门日汇总表（看板板块1/2用）
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_department_daily (
      id BIGSERIAL PRIMARY KEY,
      stat_date DATE NOT NULL,
      department_path VARCHAR(256) NOT NULL,
      expected_count INTEGER DEFAULT 0,
      actual_count INTEGER DEFAULT 0,
      attendance_rate NUMERIC(5,4) DEFAULT 0,
      late_total INTEGER DEFAULT 0,
      early_leave_total INTEGER DEFAULT 0,
      lack_card_total INTEGER DEFAULT 0,
      absent_total INTEGER DEFAULT 0,
      leave_total_days NUMERIC(10,2) DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

      UNIQUE(stat_date, department_path)
    )
  `);
  console.log('✅ attendance_department_daily 创建完成');

  // 5. 员工月汇总表（看板板块3/6用）
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_employee_monthly (
      id BIGSERIAL PRIMARY KEY,
      employee_id VARCHAR(32) NOT NULL,
      employee_name VARCHAR(64),
      department_path VARCHAR(256),
      year_month VARCHAR(7) NOT NULL,
      expected_work_days INTEGER DEFAULT 0,
      actual_work_days INTEGER DEFAULT 0,
      attendance_rate NUMERIC(5,4) DEFAULT 0,
      late_count INTEGER DEFAULT 0,
      late_duration_min INTEGER DEFAULT 0,
      early_leave_count INTEGER DEFAULT 0,
      early_leave_duration_min INTEGER DEFAULT 0,
      lack_card_count INTEGER DEFAULT 0,
      absent_days NUMERIC(5,2) DEFAULT 0,
      leave_days NUMERIC(10,2) DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

      UNIQUE(employee_id, year_month)
    )
  `);
  console.log('✅ attendance_employee_monthly 创建完成');

  // 创建索引（帆软查询高频字段）
  console.log('\n=== 创建索引 ===');

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_daily_date ON attendance_daily_result(attendance_date)',
    'CREATE INDEX IF NOT EXISTS idx_daily_employee ON attendance_daily_result(employee_id)',
    'CREATE INDEX IF NOT EXISTS idx_daily_dept ON attendance_daily_result(department_path)',
    'CREATE INDEX IF NOT EXISTS idx_daily_exception ON attendance_daily_result(valid_exception)',
    'CREATE INDEX IF NOT EXISTS idx_daily_date_range ON attendance_daily_result(attendance_date DESC)',
    'CREATE INDEX IF NOT EXISTS idx_daily_user_date ON attendance_daily_result(dingtalk_userid, attendance_date)',

    'CREATE INDEX IF NOT EXISTS idx_leave_date ON attendance_leave_status(attendance_date)',
    'CREATE INDEX IF NOT EXISTS idx_leave_employee ON attendance_leave_status(employee_id)',

    'CREATE INDEX IF NOT EXISTS idx_dept_daily_date ON attendance_department_daily(stat_date)',
    'CREATE INDEX IF NOT EXISTS idx_dept_daily_dept ON attendance_department_daily(department_path)',

    'CREATE INDEX IF NOT EXISTS idx_emp_monthly_year ON attendance_employee_monthly(year_month)',
    'CREATE INDEX IF NOT EXISTS idx_emp_monthly_dept ON attendance_employee_monthly(department_path)',
    'CREATE INDEX IF NOT EXISTS idx_emp_monthly_emp ON attendance_employee_monthly(employee_id)',
  ];

  for (const sql of indexes) {
    await db.query(sql);
    const name = sql.match(/idx_\w+/)[0];
    console.log(`  ✅ ${name}`);
  }

  console.log('\n=== 建表完成 ===');
  db.close();
}

initTables().catch(err => {
  console.error('❌ 建表失败:', err);
  db.close();
  process.exit(1);
});
