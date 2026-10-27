const axios = require('axios');
require('dotenv').config();
const db = require('../db');
const moment = require('moment');

const DINGTALK_API = 'https://oapi.dingtalk.com';

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

// 获取目标表名（如"十一月考勤"）
const getTargetTableName = (month) => {
  const [, monthNum] = month.split('-'); // 输入格式：YYYY-MM
  return `"${monthChineseMap[monthNum]}考勤"`;
};

// 1. 获取Access Token
async function getAccessToken() {
  const res = await axios.get(`${DINGTALK_API}/gettoken`, {
    params: {
      appkey: process.env.DINGTALK_APP_KEY,
      appsecret: process.env.DINGTALK_APP_SECRET
    }
  });
  return res.data.access_token;
}

// 2. 检查智能报表状态
async function checkReportStatus(token) {
  const res = await axios.post(`${DINGTALK_API}/attendance/report/status`, null, {
    params: { access_token: token }
  });
  return res.data.result;
}

// 3. 获取部门列表
async function getDepartments(token) {
  try {
    const res = await axios.get(`${DINGTALK_API}/topapi/v2/department/listsub`, {
      params: { access_token: token }
    });

    if (res.data.errcode && res.data.errcode !== 0) {
      throw new Error(`钉钉API错误: [${res.data.errcode}] ${res.data.errmsg}`);
    }

    return res.data.result;
  } catch (error) {
    console.error('获取部门列表失败:', error.response?.data || error.message);
    throw new Error(`获取部门列表失败: ${error.message}`);
  }
}

// 3. 获取所有子部门（递归）
async function getAllSubDepartments(token, parentDeptId) {
  try {
    const response = await axios.get(`${DINGTALK_API}/topapi/v2/department/listsub`, {
      params: {
        access_token: token,
        dept_id: parentDeptId
      }
    });

    const result = response.data;
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`钉钉API错误: [${result.errcode}] ${result.errmsg}`);
    }

    const departments = result.result || [];
    let allDepartments = [{ dept_id: parentDeptId }]; // 包含当前部门

    // 递归获取所有子部门
    for (const dept of departments) {
      const subDepts = await getAllSubDepartments(token, dept.dept_id);
      allDepartments = allDepartments.concat(subDepts);
    }

    return allDepartments;
  } catch (error) {
    console.error(`获取子部门失败 (部门ID: ${parentDeptId}):`, error.response?.data || error.message);
    throw error;
  }
}

// 获取部门用户（带分页）
async function getDepartmentUsers(token, deptId) {
  let allUsers = [];
  let cursor = 0;
  let hasMore = true;

  try {
    while (hasMore) {
      const response = await axios.post(`${DINGTALK_API}/topapi/user/listid`, {
        dept_id: deptId,
        cursor: cursor,
        size: 100
      }, {
        params: {
          access_token: token
        }
      });

      const result = response.data;
      if (result.errcode && result.errcode !== 0) {
        throw new Error(`钉钉API错误: [${result.errcode}] ${result.errmsg}`);
      }

      const pageData = result.result || {};
      const users = pageData.userid_list || [];
      allUsers = allUsers.concat(users);

      hasMore = pageData.has_more || false;
      cursor = pageData.next_cursor || 0;

      // 避免频繁调用
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return allUsers;
  } catch (error) {
    console.error(`获取部门用户失败 (部门ID: ${deptId}):`, error.response?.data || error.message);
    throw error;
  }
}

// 获取全公司所有用户
async function getAllCompanyUsers(token) {
  try {
    // 1. 获取根部门ID（通常为1）
    const rootDeptId = 1;

    // 2. 递归获取所有部门
    const allDepartments = await getAllSubDepartments(token, rootDeptId);
    console.log(`获取到 ${allDepartments.length} 个部门`);

    // 3. 获取所有部门的用户
    const allUsers = [];
    const seenUserIds = new Set(); // 用于去重

    for (const dept of allDepartments) {
      const users = await getDepartmentUsers(token, dept.dept_id);

      for (const user of users) {
        if (user && !seenUserIds.has(user)) {
          seenUserIds.add(user);
          allUsers.push(user);
        }
      }

      // 添加延迟避免触发限流
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`共获取 ${allUsers.length} 名员工`);
    return allUsers;
  } catch (error) {
    console.error('获取全公司用户失败:', error.message);
    throw error;
  }
}

// 5. 获取报表列定义
async function getReportColumns(token) {
  try {
    const res = await axios.post(`${DINGTALK_API}/topapi/attendance/getattcolumns`, null, {
      params: { access_token: token }
    });
    
    if (res.data.errcode && res.data.errcode !== 0) {
      throw new Error(`钉钉API错误: [${res.data.errcode}] ${res.data.errmsg}`);
    }

    // 验证并转换列数据
    const validatedColumns = res.data.result.columns.reduce((acc, col) => {
      if (col.id) {
        acc.push({
          id: col.id,
          name: col.name || col.columnName || `未命名列_${col.id}`,
          type: col.type || col.dataType || 'string'
        });
      }
      return acc;
    }, []);
    
    return validatedColumns || [];
  } catch (error) {
    console.error('获取报表列定义失败:', error.response?.data || error.message);
    throw new Error(`获取报表列定义失败: ${error.message}`);
  }
}

// 格式化日期为YYYY-MM-DD
function formatDate(date) {
  return moment(date).format('YYYY-MM-DD');
}

// 获取用户详细信息（用于获取姓名、部门等基础信息）
async function getUserInfo(token, userId) {
  try {
    const res = await axios.get(`${DINGTALK_API}/user/get`, {
      params: {
        access_token: token,
        userid: userId
      }
    });
    
    if (res.data.errcode && res.data.errcode !== 0) {
      throw new Error(`获取用户信息失败: [${res.data.errcode}] ${res.data.errmsg}`);
    }
    
    return res.data;
  } catch (error) {
    console.error(`获取用户 ${userId} 信息失败:`, error.message);
    throw error;
  }
}

// 6. 获取考勤报表数据并保存到数据库
async function getAttendanceData(token, userIds, columnIds, fromDate, toDate, columnDefinitions, state, isDailyUpdate) {
  try {
    const COLUMN_BATCH_SIZE = 20; // 每次最多20个列ID
    const from = moment(fromDate);
    const to = moment(toDate);
    const month = from.format('YYYY-MM'); // 获取月份用于表名
    const targetTable = getTargetTableName(month);
    const monthCode = month.replace('-', ''); // 生成月份代码（如202311）
    
    // 创建列ID到列定义的映射
    const columnIdToDefinition = {};
    for (const colDef of columnDefinitions) {
      columnIdToDefinition[colDef.id] = colDef;
    }
    
    // 准备存储所有用户的考勤数据
    const attendanceRecords = {};
    
    // 处理每个用户
    for (const userId of userIds) {
      // 检查状态，跳过已处理或错误的用户
      if (state && state.isUserProcessed(userId)) {
        console.log(`用户 ${userId} 已处理，跳过`);
        continue;
      }
      
      try {
        // 获取用户详细信息
        const userInfo = await getUserInfo(token, userId);
        
        // 初始化用户考勤记录
        attendanceRecords[userId] = {
          "姓名": userInfo.name || '',
          "考勤组": '',
          "部门": userInfo.department && userInfo.department.length > 0 ? userInfo.department[0] : '',
          "工号": userInfo.jobnumber || '',
          "职位": userInfo.position || '',
          "UserId": userId,
          "月份": monthCode,
          
          // 初始化数值型字段为0
          "出勤天数": 0,
          "休息天数": 0,
          "工作时长": 0,
          "迟到次数": 0,
          "迟到时长": 0,
          "严重迟到次数": 0,
          "严重迟到时长": 0,
          "旷工迟到次数": 0,
          "早退次数": 0,
          "早退时长": 0,
          "上班缺卡次数": 0,
          "下班缺卡次数": 0,
          "旷工天数": 0,
          "出差时长": 0,
          "外出时长": 0,
          "事假_小时": 0,
          "病假_小时": 0,
          "调休_小时": 0,
          "年假_天": 0,
          "产假_天": 0,
          "陪产假_天": 0,
          "婚假_天": 0,
          "例假_天": 0,
          "丧假_天": 0,
          "哺乳假_小时": 0,
          "探亲假_天": 0,
          "节育假_天": 0,
          "女员工产前检查假_天": 0,
          "男职工护理假_天": 0,
          "其他_天": 0,
          "临时公出回来下班打卡_小时": 0,
          "加班总时长": 0,
          "工作日转加班费": 0,
          "休息日转加班费": 0,
          "节假日转加班费": 0,
          "工作日转调休": 0,
          "休息日转调休": 0,
          "节假日转调休": 0
        };
        
        // 初始化日期字段
        const daysInMonth = moment(month, 'YYYY-MM').daysInMonth();
        for (let day = 1; day <= daysInMonth; day++) {
          const date = moment(`${month}-${day}`, 'YYYY-MM-DD');
          const dayOfWeek = date.day();
          let suffix = '';
          if (dayOfWeek === 6) suffix = '_六';
          if (dayOfWeek === 0) suffix = '_日';
          attendanceRecords[userId][`日${day}${suffix}`] = '';
        }
        
        // 将列ID分成多个批次
        const columnBatches = [];
        for (let i = 0; i < columnIds.length; i += COLUMN_BATCH_SIZE) {
          columnBatches.push(columnIds.slice(i, i + COLUMN_BATCH_SIZE));
        }
        
        // 处理每个列ID批次
        for (const columnBatch of columnBatches) {
          const params = {
            userid: userId,
            column_id_list: columnBatch.join(','),
            from_date: formatDate(fromDate),
            to_date: formatDate(toDate),
          };
          
          let hasMore = true;
          let offset = 0;
          let retryCount = 0;
          const maxRetries = 3;
          
          while (hasMore && retryCount < maxRetries) {
            try {
              params.offset = offset;
              const res = await axios.post(`${DINGTALK_API}/topapi/attendance/getcolumnval`, params, {
                params: { access_token: token },
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000
              });
              
              if (res.data.errcode && res.data.errcode !== 0) {
                if (res.data.errcode === 88) { // 限流错误码
                  console.log(`API限流，等待后重试 (用户: ${userId}, 重试: ${retryCount + 1})`);
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  retryCount++;
                  continue;
                }
                throw new Error(`钉钉API错误: [${res.data.errcode}] ${res.data.errmsg}`);
              }
              
              // 重置重试计数
              retryCount = 0;
              
              // 解析返回的数据
              const columnVals = res.data.result.column_vals || [];
              
              // 处理每一列的数据
              for (const columnData of columnVals) {
                const columnId = columnData.column_vo.id;
                const columnDef = columnIdToDefinition[columnId];
                const columnName = columnDef ? columnDef.name : `未知列_${columnId}`;
                
                // 处理该列下的所有值
                for (const val of columnData.column_vals) {
                  const recordDate = moment(val.date);
                  const day = recordDate.date();
                  const dayOfWeek = recordDate.day();
                  let suffix = '';
                  if (dayOfWeek === 6) suffix = '_六';
                  if (dayOfWeek === 0) suffix = '_日';
                  const dateField = `日${day}${suffix}`;
                  
                  // 保存每日考勤记录
                  if (attendanceRecords[userId][dateField] && attendanceRecords[userId][dateField] !== '') {
                    attendanceRecords[userId][dateField] += `; ${val.value}`;
                  } else {
                    attendanceRecords[userId][dateField] = val.value || '';
                  }
                  
                  // 根据列名更新汇总数据
                  switch (true) {
                    case columnName.includes('出勤天数'):
                      attendanceRecords[userId]['出勤天数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('休息天数'):
                      attendanceRecords[userId]['休息天数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('工作时长'):
                      attendanceRecords[userId]['工作时长'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('迟到次数'):
                      attendanceRecords[userId]['迟到次数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('迟到时长'):
                      attendanceRecords[userId]['迟到时长'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('严重迟到次数'):
                      attendanceRecords[userId]['严重迟到次数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('严重迟到时长'):
                      attendanceRecords[userId]['严重迟到时长'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('旷工迟到次数'):
                      attendanceRecords[userId]['旷工迟到次数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('早退次数'):
                      attendanceRecords[userId]['早退次数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('早退时长'):
                      attendanceRecords[userId]['早退时长'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('上班缺卡次数'):
                      attendanceRecords[userId]['上班缺卡次数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('下班缺卡次数'):
                      attendanceRecords[userId]['下班缺卡次数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('旷工天数'):
                      attendanceRecords[userId]['旷工天数'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('出差时长'):
                      attendanceRecords[userId]['出差时长'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('外出时长'):
                      attendanceRecords[userId]['外出时长'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('事假'):
                      attendanceRecords[userId]['事假_小时'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('病假'):
                      attendanceRecords[userId]['病假_小时'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('调休') && columnName.includes('小时'):
                      attendanceRecords[userId]['调休_小时'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('年假'):
                      attendanceRecords[userId]['年假_天'] = parseFloat(val.value) || 0;
                      break;
                    case columnName.includes('加班总时长'):
                      attendanceRecords[userId]['加班总时长'] = parseFloat(val.value) || 0;
                      break;
                    // 可以根据需要添加更多字段映射
                  }
                }
              }
              
              hasMore = res.data.result.has_more || false;
              offset = res.data.result.next_offset || 0;
              
              // 避免频繁调用
              await new Promise(resolve => setTimeout(resolve, 300));
            } catch (error) {
              console.error(`处理用户 ${userId} 数据时出错:`, error.message);
              retryCount++;
              if (retryCount >= maxRetries) {
                throw error;
              }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
        
        // 标记用户为已处理
        if (state) {
          state.markUserProcessed(userId);
        }
        console.log(`用户 ${userId} 考勤数据处理完成`);
        
      } catch (error) {
        console.error(`处理用户 ${userId} 时发生错误:`, error.message);
        if (state) {
          state.markUserAsError(userId);
        }
      }
    }
    
    // 批量保存到数据库
    const recordsArray = Object.values(attendanceRecords);
    if (recordsArray.length > 0) {
      await saveAttendanceToDB(recordsArray, targetTable);
    }
    
    return recordsArray.length;
  } catch (error) {
    console.error('获取考勤数据失败:', error.message);
    throw error;
  }
}

// 保存考勤数据到数据库
async function saveAttendanceToDB(records, tableName) {
  const BATCH_SIZE = 50;
  const totalRecords = records.length;
  let totalInserted = 0;
  
  try {
    await db.query('BEGIN');
    
    // 获取表字段列表（从第一条记录的键中获取）
    const fields = Object.keys(records[0]);
    
    // 分批次插入
    for (let i = 0; i < totalRecords; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      
      // 生成占位符
      const placeholders = batch.map((_, idx) => 
        `(${fields.map((_, j) => `$${idx * fields.length + j + 1}`).join(',')})`
      ).join(',');
      
      // 准备值数组
      const values = [];
      batch.forEach(record => {
        fields.forEach(field => {
          values.push(record[field] !== undefined ? record[field] : null);
        });
      });
      
      // 构建SQL
      const insertSql = `
        INSERT INTO ${tableName} (${fields.map(f => `"${f}"`).join(',')})
        VALUES ${placeholders}
        ON CONFLICT ("UserId", "月份") DO UPDATE SET
          ${fields.map(f => `"${f}" = EXCLUDED."${f}"`).join(',')}
      `;
      
      const result = await db.query(insertSql, values);
      totalInserted += result.rowCount;
      console.log(`已插入/更新 ${result.rowCount} 条记录，累计 ${totalInserted}/${totalRecords}`);
    }
    
    await db.query('COMMIT');
    console.log(`所有考勤数据已保存到 ${tableName}，共 ${totalInserted} 条记录`);
    return totalInserted;
  } catch (error) {
    await db.query('ROLLBACK');
    console.error(`保存考勤数据到数据库失败:`, error.message);
    throw error;
  }
}

// 更新考勤汇总（根据新表结构调整）
async function updateAttendanceSummary(db, month) {
  const monthChinese = monthChineseMap[month.split('-')[1]];
  const sourceTable = `"${monthChinese}考勤"`;
  
  try {
    // 这里可以添加月度汇总逻辑，如果需要的话
    console.log(`已完成 ${month} 考勤数据汇总更新`);
  } catch (error) {
    console.error(`更新 ${month} 考勤汇总失败:`, error.message);
    throw error;
  }
}

module.exports = {
  getAccessToken,
  checkReportStatus,
  getDepartments,
  getAllSubDepartments,
  getDepartmentUsers,
  getAllCompanyUsers,
  getReportColumns,
  getAttendanceData,
  updateAttendanceSummary
};