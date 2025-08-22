const db = require('../db');

// 创建考勤报表表
async function createTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_columns (
      column_id VARCHAR(50) PRIMARY KEY,
      column_name VARCHAR(100) NOT NULL,
      data_type VARCHAR(50) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      record_id SERIAL PRIMARY KEY,
      user_id VARCHAR(50) NOT NULL,
      record_date DATE NOT NULL,
      column_id VARCHAR(50) REFERENCES attendance_columns(column_id),
      value TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

module.exports = { createTables };