const axios = require('axios');
require('dotenv').config();

const DINGTALK_API = 'https://oapi.dingtalk.com';

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
    // 添加详细的日志输出
    // console.log('列定义API响应:', JSON.stringify(res.data, null, 2));

    // 检查是否有错误代码
    if (res.data.errcode && res.data.errcode !== 0) {
      throw new Error(`钉钉API错误: [${res.data.errcode}] ${res.data.errmsg}`);
    }

    // 尝试不同的响应路径
    return res.data.result;
  } catch (error) {
    console.error('获取部门列表失败:', error.response?.data || error.message);
    throw new Error(`获取部门列表失败: ${error.message}`);
  }
}
//3. 获取所有子部门（递归）
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
    // 验证并转换列数据
    const validatedColumns = res.data.result.columns.reduce((acc, col) => {
      // 如果列ID存在，则处理，并加入结果数组
      if (col.id) {
        acc.push({
          id: col.id,
          name: col.name || col.columnName || `未命名列_${col.id}`, // 在缺少名称时提供默认值
          type: col.type || col.dataType || 'string' // 默认数据类型为字符串
        });
      }
      // 如果没有ID，不进行处理
      return acc;
    }, []);
    // 检查是否有错误代码
    if (res.data.errcode && res.data.errcode !== 0) {
      throw new Error(`钉钉API错误: [${res.data.errcode}] ${res.data.errmsg}`);
    }
    return validatedColumns || [];
  } catch (error) {
    console.error('获取报表列定义失败:', error.response?.data || error.message);
    throw new Error(`获取报表列定义失败: ${error.message}`);
  }
}

// 6. 获取考勤报表数据（单用户处理）
async function getAttendanceData(token, userIds, columnIds, fromDate, toDate, columnDefinitions) {
  try {
    const COLUMN_BATCH_SIZE = 20; // 每次最多20个列ID
    let allAttendanceData = [];
    let dailyStatusRecords = [];
    let detailRecords = [];
    
    // 创建列ID到列定义的映射
    const columnIdToDefinition = {};
    for (const colDef of columnDefinitions) {
      columnIdToDefinition[colDef.id] = colDef;
    }
    
    // 处理每个用户
    for (const userId of userIds) {
      // 将列ID分成多个批次
      const columnBatches = [];
      for (let i = 0; i < columnIds.length; i += COLUMN_BATCH_SIZE) {
        columnBatches.push(columnIds.slice(i, i + COLUMN_BATCH_SIZE));
      }
      
      // 处理每个列ID批次
      for (const columnBatch of columnBatches) {
        const params = {
          userid: userId, // 单用户
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
              timeout: 10000 // 10秒超时
            });
            
            if (res.data.errcode && res.data.errcode !== 0) {
              if (res.data.errcode === 88) { // 限流错误码
                console.log(`API限流，等待后重试 (用户: ${userId}, 重试: ${retryCount + 1})`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // 等待2秒
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
                const record = {
                  user_id: val.user_id || userId, // 确保有用户ID
                  date: val.date,
                  column_id: columnId,
                  column_name: columnName,
                  value: val.value || ''
                };
                
                // 根据列名称分类存储
                if (columnName.includes('考勤状态') || columnName.includes('打卡结果')) {
                  dailyStatusRecords.push({
                    user_id: val.user_id || userId,
                    work_date: val.date,
                    check_status: val.value
                  });
                } 
                else if (columnName.includes('审批类型') || columnName.includes('审批状态')) {
                  // 更新每日状态记录
                  const existingIndex = dailyStatusRecords.findIndex(r => 
                    r.user_id === (val.user_id || userId) && r.work_date === val.date
                  );
                  
                  if (existingIndex >= 0) {
                    dailyStatusRecords[existingIndex].approve_type = val.value;
                  } else {
                    dailyStatusRecords.push({
                      user_id: val.user_id || userId,
                      work_date: val.date,
                      approve_type: val.value
                    });
                  }
                }
                else if (columnName.includes('处理类型') || columnName.includes('处理状态')) {
                  // 更新每日状态记录
                  const existingIndex = dailyStatusRecords.findIndex(r => 
                    r.user_id === (val.user_id || userId) && r.work_date === val.date
                  );
                  
                  if (existingIndex >= 0) {
                    dailyStatusRecords[existingIndex].proc_type = val.value;
                  } else {
                    dailyStatusRecords.push({
                      user_id: val.user_id || userId,
                      work_date: val.date,
                      proc_type: val.value
                    });
                  }
                }
                else if (columnName.includes('打卡时间') || columnName.includes('时间')) {
                  // 解析打卡类型
                  let checkType = 'Unknown';
                  if (columnName.includes('上班') || columnName.includes('OnDuty')) checkType = 'OnDuty';
                  if (columnName.includes('下班') || columnName.includes('OffDuty')) checkType = 'OffDuty';
                  
                  // 尝试提取基准时间
                  let baseCheckTime = null;
                  if (columnDef && columnDef.extras) {
                    try {
                      const extras = JSON.parse(columnDef.extras);
                      baseCheckTime = extras.baseCheckTime || null;
                    } catch (e) {
                      console.warn(`解析列额外信息失败: ${columnDef.extras}`);
                    }
                  }
                  
                  detailRecords.push({
                    user_id: val.user_id || userId,
                    record_date: val.date,
                    check_type: checkType,
                    user_check_time: val.value,
                    base_check_time: baseCheckTime
                  });
                }
                else if (columnName.includes('位置') || columnName.includes('地址')) {
                  // 更新打卡明细记录
                  const existingIndex = detailRecords.findIndex(r => 
                    r.user_id === (val.user_id || userId) && 
                    r.record_date === val.date
                  );
                  
                  if (existingIndex >= 0) {
                    detailRecords[existingIndex].location_result = val.value;
                  } else {
                    detailRecords.push({
                      user_id: val.user_id || userId,
                      record_date: val.date,
                      location_result: val.value
                    });
                  }
                }
                else if (columnName.includes('时间结果')) {
                  // 更新打卡明细记录
                  const existingIndex = detailRecords.findIndex(r => 
                    r.user_id === (val.user_id || userId) && 
                    r.record_date === val.date
                  );
                  
                  if (existingIndex >= 0) {
                    detailRecords[existingIndex].time_result = val.value;
                  } else {
                    detailRecords.push({
                      user_id: val.user_id || userId,
                      record_date: val.date,
                      time_result: val.value
                    });
                  }
                }
                else {
                  // 其他列数据存入原始表
                  allAttendanceData.push(record);
                }
              }
            }
            
            // 检查是否有更多数据
            hasMore = res.data.result.has_more || false;
            if (hasMore) {
              offset += res.data.result.column_vals.length;
              console.log(`用户 ${userId} 还有更多数据，偏移量: ${offset}`);
            }
            
            // 添加请求间隔，避免限流
            await new Promise(resolve => setTimeout(resolve, 500));
            
          } catch (error) {
            console.error(`处理用户 ${userId} 时出错:`, error.message);
            if (error.response && error.response.status === 429) {
              // 限流错误，等待后重试
              console.log(`API限流，等待后重试 (用户: ${userId}, 重试: ${retryCount + 1})`);
              await new Promise(resolve => setTimeout(resolve, 3000)); // 等待3秒
              retryCount++;
            } else {
              // 其他错误，跳过当前批次
              console.error(`跳过用户 ${userId} 的当前列批次`);
              hasMore = false;
            }
          }
        }
      }
      
      // 用户处理完成后添加延迟
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`获取数据完成:
      - 原始考勤记录: ${allAttendanceData.length} 条
      - 每日状态记录: ${dailyStatusRecords.length} 条
      - 打卡明细记录: ${detailRecords.length} 条`);
    
    return {
      allAttendanceData,   // 用于 attendance_records 表
      dailyStatusRecords,  // 用于 attendance_daily_status 表
      detailRecords        // 用于 attendance_details 表
    };
    
  } catch (error) {
    console.error('获取考勤数据失败:', error.response?.data || error.message);
    throw new Error(`获取考勤数据失败: ${error.message}`);
  }
}
// 7.保存考勤数据到三张表
async function saveAttendanceData(db, attendanceResult) {
  try {
    const { allAttendanceData, dailyStatusRecords, detailRecords } = attendanceResult;
    
    // 1. 保存原始考勤数据到 attendance_records 表
    for (const record of allAttendanceData) {
      await db.query(
        `INSERT INTO attendance_records 
         (user_id, record_date, column_id, column_name, value) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          record.user_id, 
          record.date, 
          record.column_id, 
          record.column_name, 
          record.value
        ]
      );
    }
    
    // 2. 保存每日状态到 attendance_daily_status 表
    const dailyStatusMap = new Map();
    for (const record of dailyStatusRecords) {
      const key = `${record.user_id}-${record.work_date}`;
      
      if (!dailyStatusMap.has(key)) {
        dailyStatusMap.set(key, {
          user_id: record.user_id,
          work_date: record.work_date,
          check_status: record.check_status || null,
          approve_type: record.approve_type || null,
          proc_type: record.proc_type || null
        });
      } else {
        const existing = dailyStatusMap.get(key);
        if (record.check_status) existing.check_status = record.check_status;
        if (record.approve_type) existing.approve_type = record.approve_type;
        if (record.proc_type) existing.proc_type = record.proc_type;
      }
    }
    
    for (const record of dailyStatusMap.values()) {
      await db.query(
        `INSERT INTO attendance_daily_status 
         (user_id, work_date, check_status, approve_type, proc_type) 
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, work_date) 
         DO UPDATE SET
           check_status = EXCLUDED.check_status,
           approve_type = EXCLUDED.approve_type,
           proc_type = EXCLUDED.proc_type`,
        [
          record.user_id,
          record.work_date,
          record.check_status,
          record.approve_type,
          record.proc_type
        ]
      );
    }
    
    // 3. 保存打卡明细到 attendance_details 表
    const detailMap = new Map();
    for (const record of detailRecords) {
      const key = `${record.user_id}-${record.record_date}-${record.check_type || 'default'}`;
      
      if (!detailMap.has(key)) {
        detailMap.set(key, {
          user_id: record.user_id,
          record_date: record.record_date,
          check_type: record.check_type || null,
          user_check_time: record.user_check_time || null,
          base_check_time: record.base_check_time || null,
          time_result: record.time_result || null,
          location_result: record.location_result || null
        });
      } else {
        const existing = detailMap.get(key);
        if (record.user_check_time) existing.user_check_time = record.user_check_time;
        if (record.base_check_time) existing.base_check_time = record.base_check_time;
        if (record.time_result) existing.time_result = record.time_result;
        if (record.location_result) existing.location_result = record.location_result;
      }
    }
    
    for (const record of detailMap.values()) {
      await db.query(
        `INSERT INTO attendance_details 
         (user_id, record_date, check_type, user_check_time, base_check_time, time_result, location_result) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, record_date, check_type) 
         DO UPDATE SET
           user_check_time = EXCLUDED.user_check_time,
           base_check_time = EXCLUDED.base_check_time,
           time_result = EXCLUDED.time_result,
           location_result = EXCLUDED.location_result`,
        [
          record.user_id,
          record.record_date,
          record.check_type,
          record.user_check_time,
          record.base_check_time,
          record.time_result,
          record.location_result
        ]
      );
    }
    
    // 4. 生成并保存月度汇总数据
    const summaryMap = new Map();
    
    // 从每日状态生成汇总
    for (const record of dailyStatusMap.values()) {
      const month = record.work_date.substring(0, 7); // YYYY-MM
      const key = `${record.user_id}-${month}`;
      
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          user_id: record.user_id,
          summary_month: month,
          late_count: 0,
          early_leave_count: 0,
          absent_count: 0,
          normal_count: 0
        });
      }
      
      const summary = summaryMap.get(key);
      
      if (record.check_status === 'Late') summary.late_count++;
      else if (record.check_status === 'Early') summary.early_leave_count++;
      else if (record.check_status === 'Absent') summary.absent_count++;
      else if (record.check_status === 'Normal') summary.normal_count++;
    }
    
    // 保存汇总数据
    for (const summary of summaryMap.values()) {
      await db.query(
        `INSERT INTO attendance_summary 
         (user_id, summary_month, late_count, early_leave_count, absent_count, normal_count) 
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, summary_month) 
         DO UPDATE SET
           late_count = EXCLUDED.late_count,
           early_leave_count = EXCLUDED.early_leave_count,
           absent_count = EXCLUDED.absent_count,
           normal_count = EXCLUDED.normal_count`,
        [
          summary.user_id,
          summary.summary_month,
          summary.late_count,
          summary.early_leave_count,
          summary.absent_count,
          summary.normal_count
        ]
      );
    }
    
    return {
      success: true,
      recordCount: allAttendanceData.length,
      dailyStatusCount: dailyStatusMap.size,
      detailCount: detailMap.size,
      summaryCount: summaryMap.size
    };
    
  } catch (error) {
    console.error('保存考勤数据失败:', error);
    throw new Error(`保存考勤数据失败: ${error.message}`);
  }
}

// 获取列定义的函数（假设您已经有这个函数）
async function getColumnDefinitions(token) {
  try {
    const res = await axios.post(`${DINGTALK_API}/topapi/attendance/getattcolumns`, {}, {
      params: { access_token: token }
    });
    
    if (res.data.errcode && res.data.errcode !== 0) {
      throw new Error(`获取列定义失败: [${res.data.errcode}] ${res.data.errmsg}`);
    }
    
    return res.data.result || [];
  } catch (error) {
    console.error('获取列定义失败:', error.response?.data || error.message);
    throw new Error(`获取列定义失败: ${error.message}`);
  }
}

// 日期格式化辅助函数
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = {
  getAccessToken,
  checkReportStatus,
  getDepartments,
  getAllCompanyUsers,
  getDepartmentUsers,
  getReportColumns,
  getAttendanceData,
  saveAttendanceData
};