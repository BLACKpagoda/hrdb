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
}

module.exports = { createTables };