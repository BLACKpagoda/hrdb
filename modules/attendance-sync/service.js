// =============================================================================
// 钉钉考勤看板同步服务 - 核心层
// 
// 与旧版 service.js 的区别：
//   旧：用智能报表 API（getattcolumns + getcolumnval）拉原始列值，自己拼装
//   新：用打卡结果 API（/attendance/list），钉钉已算好迟到旷工 + 关联审批抵消
//       + 请假状态 API（/topapi/attendance/getleavestatus）
//
// 数据流：
//   1. getAccessToken → 2. syncUserMapping（UserId↔employee_id映射）
//   → 3. syncCheckResults（打卡结果 /attendance/list）
//   → 4. syncLeaveStatus（请假状态 /getleavestatus）
//   → 5. calcSummary（汇总层预计算）
// =============================================================================

const axios = require('axios');
require('dotenv').config();
const db = require('../../db');
const moment = require('moment');

const DINGTALK_API = 'https://oapi.dingtalk.com';

// 批处理常量（钉钉 API 硬限制）
const BATCH_USER_SIZE = 50;       // /attendance/list 最多 50 人一批
const BATCH_LEAVE_USER_SIZE = 100; // /getleavestatus 最多 100 人一批
const MAX_DATE_RANGE_DAYS = 7;     // /attendance/list 最多 7 天间隔
const API_DELAY_MS = 400;         // API 调用间隔（ms），避免限流

// =============================================================================
// 一、钉钉基础 API（复用旧逻辑，稳定可靠）
// =============================================================================

/** 获取 Access Token */
async function getAccessToken() {
  const res = await axios.get(`${DINGTALK_API}/gettoken`, {
    params: {
      appkey: process.env.DINGTALK_APP_KEY,
      appsecret: process.env.DINGTALK_APP_SECRET
    }
  });
  if (res.data.errcode && res.data.errcode !== 0) {
    throw new Error(`获取 access_token 失败: [${res.data.errcode}] ${res.data.errmsg}`);
  }
  return res.data.access_token;
}

/** 递归获取全公司 UserId 列表 + 每人所属部门路径 */
async function getAllCompanyUsers(token) {
  const rootDeptId = 1;
  const allUsers = new Set();
  const userDeptMap = new Map(); // userid → 部门路径（空格分隔多级，与看板历史口径一致）

  // 递归遍历部门树，返回带路径的部门列表 [{ dept_id, path }]
  async function fetchDeptTree(parentId, parentPath) {
    const res = await axios.get(`${DINGTALK_API}/topapi/v2/department/listsub`, {
      params: { access_token: token, dept_id: parentId }
    });
    if (res.data.errcode && res.data.errcode !== 0) return [];
    const subs = res.data.result || [];
    const all = [];
    for (const dept of subs) {
      const path = parentPath ? `${parentPath} ${dept.name}` : dept.name;
      all.push({ dept_id: dept.dept_id, path });
      all.push(...await fetchDeptTree(dept.dept_id, path));
    }
    return all;
  }

  const allDepts = await fetchDeptTree(rootDeptId, '');
  console.log(`[基础] 获取到 ${allDepts.length} 个部门，开始拉取用户...`);

  // 按部门拉取用户，同时记录 userid → 部门路径
  for (const { dept_id, path } of allDepts) {
    let cursor = 0;
    let hasMore = true;
    while (hasMore) {
      const res = await axios.post(`${DINGTALK_API}/topapi/user/listid`, {
        dept_id, cursor, size: 100
      }, { params: { access_token: token } });

      if (res.data.errcode && res.data.errcode !== 0) break;

      const userIds = (res.data.result?.userid_list) || [];
      userIds.forEach(uid => {
        allUsers.add(uid);
        // 一人多部门时保留首次出现的路径（层级较浅的主部门优先，因树先序遍历）
        // 部门路径截取前2级（合并到事业部/大部门级，不拆到车间/科室）
        if (!userDeptMap.has(uid)) userDeptMap.set(uid, truncateDeptPath(path));
      });

      hasMore = res.data.result?.has_more || false;
      cursor = res.data.result?.next_cursor || 0;
      await sleep(API_DELAY_MS);
    }
  }

  const users = Array.from(allUsers);
  console.log(`[基础] 共获取 ${users.length} 名员工 UserId（其中 ${userDeptMap.size} 人有部门路径）`);
  return { users, userDeptMap };
}

/** 获取单个用户详情（含 jobnumber 用于映射） */
async function getUserInfo(token, userId) {
  const res = await axios.get(`${DINGTALK_API}/user/get`, {
    params: { access_token: token, userid: userId }
  });
  if (res.data.errcode && res.data.errcode !== 0) {
    console.warn(`[用户] 获取用户 ${userId} 信息失败: ${res.data.errmsg}`);
    return null;
  }
  return res.data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 部门路径截取前1级（合并到事业部/大部门级，不拆到科室/车间） */
function truncateDeptPath(path) {
  if (!path) return '';
  const parts = path.split(' ');
  return parts.slice(0, 1).join(' ');
}

/** 编辑距离是否 ≤1（等长比较不同字符数；长度差1比较删增一位） */
function editDistanceLE1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false;
    }
    return diff === 1;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; }
    else {
      if (skipped) return false;
      skipped = true; j++;
    }
  }
  return true;
}

/**
 * 姓名相似判断（宽松，容忍同音字/账号别名后缀）：
 * 归一化空白后：完全相等 / 互为包含（"于洋" vs "于洋_压铸"）/ 编辑距离≤1（"王富胜" vs "王福胜"）
 * 用于钉钉姓名 ↔ 花名册姓名的匹配佐证，防止工号/手机号撞号错配
 */
function nameSimilar(a, b) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  return editDistanceLE1(x, y);
}

// =============================================================================
// 二、人员同步 — 钉钉 UserId ↔ 花名册 employee_id 映射
//
// 实测结论（本企业钉钉环境）：
//   - topapi/v2/user/listpage 不可用（errcode=22 Invalid method）
//   - topapi/v2/user/get 单人详情可用（历史验证能拿到 jobnumber）
//   - 多数员工 userid === 工号（历史验证 ~3580/6040 直接相等）
//
// 两轮匹配策略：
//   第一轮（零 API 成本）：userid 直接查花名册工号索引
//   第二轮（仅对未命中者）：逐人调 v2/user/get 拿 jobnumber/手机号/姓名
//     → jobnumber 匹配 → 手机号匹配 → 姓名+部门组合匹配
//   仍未命中 → unmatched（不参与看板统计）
// =============================================================================

/** 获取单个用户详情（v2 优先，失败降级旧版；errcode 88 限流自动重试） */
async function getUserDetail(token, userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(`${DINGTALK_API}/topapi/v2/user/get`, {
        params: { access_token: token, userid: userId },
        timeout: 15000
      });
      const { errcode, errmsg, result } = res.data;
      if (!errcode || errcode === 0) {
        return {
          name: result?.name || '',
          mobile: result?.mobile || '',
          jobnumber: result?.job_number || '',
        };
      }
      if (errcode === 88) { // 限流，退避重试
        await sleep(1000 * (attempt + 1));
        continue;
      }
      console.warn(`  [用户] ${userId} 详情失败: [${errcode}] ${errmsg}`);
      return null;
    } catch (e) {
      if (attempt === 2) {
        console.warn(`  [用户] ${userId} 详情异常: ${e.message}`);
        return null;
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

/**
 * 批量同步钉钉用户到 mapping 表（两轮匹配，见节头注释）
 * 部门路径：钉钉通讯录优先（截取前2级），花名册部门作为兜底
 */
async function syncUserMapping(token, dingtalkUserIds, userDeptMap) {
  console.log(`\n[同步] 开始人员映射同步（${dingtalkUserIds.length} 人，两轮匹配花名册）...`);

  // 1. 加载花名册，建立多级索引
  const rosterByEmployeeId = new Map(); // employee_id → roster
  const rosterByMobile = new Map();     // mobile → roster
  const rosterByNameDept = new Map();   // "姓名|截取2级部门" → roster（组合键，降低重名风险）

  const { rows: rosterRows } = await db.query(`
    SELECT DISTINCT ON (employee_id)
      employee_id, full_name, department, mobile, id_card, employment_status
    FROM employee_roster
    WHERE employment_status = '在岗'
    ORDER BY employee_id, year_month DESC
  `);

  const fmtMobile = (m) => (m || '').replace(/[\s\-+]/g, '').replace(/^86/, '');

  for (const r of rosterRows) {
    rosterByEmployeeId.set(r.employee_id, r);

    const mobile = fmtMobile(r.mobile);
    if (mobile.length >= 7) rosterByMobile.set(mobile, r);

    if (r.full_name) {
      const deptKey = truncateDeptPath(r.department || '');
      rosterByNameDept.set(`${r.full_name}|${deptKey}`, r);
    }
  }
  console.log(`  [花名册] 在岗 ${rosterRows.length} 人 | 工号索引 ${rosterByEmployeeId.size} | 手机号 ${rosterByMobile.size} | 姓名+部门 ${rosterByNameDept.size}`);

  // 2. 第一轮：userid 直接当员工ID 匹配（零匹配成本，但需拉详情校验姓名）
  //    花名册关键列是「员工 ID（人事）」，多数员工钉钉 userid === 员工ID
  const resultMap = new Map(); // userid → { roster, method, name, detail }
  const needDetail = [];       // 第一轮未命中，需要逐人拉详情
  const preDetailMap = new Map(); // 直配校验时已拉的详情，第二轮复用避免重复调用

  for (const userId of dingtalkUserIds) {
    const roster = rosterByEmployeeId.get(userId);
    if (roster) {
      resultMap.set(userId, { roster, method: 'userid_id' });
    } else {
      needDetail.push(userId);
    }
  }
  console.log(`  [第一轮] userid≈员工ID 直配命中 ${resultMap.size} 人，需拉详情 ${needDetail.length} 人`);

  // 2.5 直配者全量姓名校验：防止 userid 撞上「他人员工ID」的错配
  //     实测案例：userid=10085371（钉钉姓名"初轶鹏"）撞花名册员工ID 10085371（刘继彪）
  let directFail = 0;
  const directIds = Array.from(resultMap.keys());
  for (let i = 0; i < directIds.length; i++) {
    const userId = directIds[i];
    const entry = resultMap.get(userId);
    const detail = await getUserDetail(token, userId);
    await sleep(API_DELAY_MS);

    if (detail && !nameSimilar(detail.name || '', entry.roster.full_name)) {
      // 姓名对不上 → 撞号错配，剔除直配结果，转入第二轮用详情重新匹配
      resultMap.delete(userId);
      directFail++;
      preDetailMap.set(userId, detail);
      needDetail.push(userId);
    } else if (detail) {
      entry.detail = detail; // 存证，入库写 dingtalk_name / jobnumber
    }

    if ((i + 1) % 200 === 0) {
      console.log(`  [直配校验] 进度 ${i + 1}/${directIds.length} | 剔除撞号错配 ${directFail} 人`);
    }
  }
  console.log(`  [直配校验] 完成 | 剔除撞号错配 ${directFail} 人`);

  // 3. 第二轮：未命中者逐人拉详情 → jobnumber / 手机号 / 姓名+部门 匹配
  const matchMethods = { userid_id: resultMap.size, jobnumber: 0, mobile: 0, name_dept: 0 };
  let detailFail = 0;

  for (let i = 0; i < needDetail.length; i++) {
    const userId = needDetail[i];
    const detail = preDetailMap.get(userId) || await getUserDetail(token, userId);
    await sleep(API_DELAY_MS);

    const dingName = detail?.name || '';
    const dingMobile = fmtMobile(detail?.mobile);
    const dingJobnumber = (detail?.jobnumber || '').trim();
    const dingDept = truncateDeptPath(userDeptMap?.get(userId) || '');

    let roster = null;
    let method = '';

    // 1级：钉钉 jobnumber → 花名册员工ID（工号与"员工 ID（人事）"同体系时命中，姓名佐证防撞号）
    if (dingJobnumber && rosterByEmployeeId.has(dingJobnumber)) {
      const cand = rosterByEmployeeId.get(dingJobnumber);
      if (nameSimilar(dingName, cand.full_name)) {
        roster = cand;
        method = 'jobnumber';
      }
    }
    // 2级：手机号（同样需姓名佐证）
    if (!roster && dingMobile && rosterByMobile.has(dingMobile)) {
      const cand = rosterByMobile.get(dingMobile);
      if (nameSimilar(dingName, cand.full_name)) {
        roster = cand;
        method = 'mobile';
      }
    }
    // 3级：姓名 + 部门前2级组合（降低重名风险）
    if (!roster && dingName) {
      const hit = rosterByNameDept.get(`${dingName}|${dingDept}`);
      if (hit) {
        roster = hit;
        method = 'name_dept';
      }
    }

    if (roster) {
      resultMap.set(userId, { roster, method, name: dingName, detail });
      matchMethods[method]++;
    } else if (!detail) {
      detailFail++;
    }

    if ((i + 1) % 200 === 0) {
      console.log(`  [第二轮] 进度 ${i + 1}/${needDetail.length} | 补充命中 ${matchMethods.jobnumber + matchMethods.mobile + matchMethods.name_dept}`);
    }
  }
  console.log(`  [第二轮] 完成 | jobnumber=${matchMethods.jobnumber} mobile=${matchMethods.mobile} 姓名+部门=${matchMethods.name_dept} | 详情获取失败 ${detailFail} 人`);

  // 3.5 冲突仲裁：同一花名册员工ID 被多个钉钉账号命中时，保留证据最强的一个
  //     典型场景：① 一人多钉钉账号（副账号 jobnumber 与主账号相同）
  //              ② userid 撞上他人花名册员工ID 的错配（第一轮直配无姓名校验）
  const byEmployee = new Map(); // employee_id → [{ userId, entry }]
  for (const [userId, entry] of resultMap) {
    const eid = entry.roster.employee_id;
    if (!byEmployee.has(eid)) byEmployee.set(eid, []);
    byEmployee.get(eid).push({ userId, entry });
  }

  let demoted = 0;
  for (const [eid, list] of byEmployee) {
    if (list.length <= 1) continue;
    // 组内无详情者补拉（第一轮直配者没有 detail）
    for (const item of list) {
      if (!item.entry.detail) {
        item.entry.detail = await getUserDetail(token, item.userId);
        await sleep(API_DELAY_MS);
      }
    }
    // 评分：jobnumber===员工ID(4，强键) > 姓名佐证(2) > userid直配历史规律(1)
    const scored = list.map(item => {
      const d = item.entry.detail;
      let s = 0;
      if (d && (d.jobnumber || '').trim() === eid) s += 4;
      if (d && nameSimilar(d.name || '', item.entry.roster.full_name)) s += 2;
      if (item.entry.method === 'userid_id') s += 1;
      return { ...item, score: s };
    });
    scored.sort((a, b) => b.score - a.score);
    // 只保留得分最高者（并列时保留先出现的，即主部门账号），其余降级为 unmatched
    for (let k = 1; k < scored.length; k++) {
      resultMap.delete(scored[k].userId);
      demoted++;
      console.log(`  [仲裁] ${eid} ${scored[k].entry.roster.full_name}: 钉钉账号 ${scored[k].userId} 降级（得分${scored[k].score} < ${scored[0].score}）`);
    }
  }
  if (demoted > 0) console.log(`  [仲裁] 冲突处理完成，降级 ${demoted} 个账号`);

  // 4. 全量入库（含未命中者，标记 unmatched 保留记录）
  const UPSERT_BATCH = 300;
  let matched = 0, unmatched = 0;

  for (let i = 0; i < dingtalkUserIds.length; i += UPSERT_BATCH) {
    const batch = dingtalkUserIds.slice(i, i + UPSERT_BATCH);
    const values = batch.map(userId => {
      const hit = resultMap.get(userId);
      const roster = hit?.roster || null;
      const name = roster ? roster.full_name : (hit?.name || '');
      // 部门路径：钉钉通讯录优先（已截2级），花名册部门兜底
      const rawPath = (userDeptMap && userDeptMap.get(userId)) || (roster ? roster.department : '') || '';
      const deptPath = truncateDeptPath(rawPath);
      const syncStatus = roster ? 'matched' : 'unmatched';
      const matchMethod = hit?.method || '';
      const dingName = hit?.detail?.name || hit?.name || '';
      const dingJobnumber = hit?.detail?.jobnumber || '';

      if (roster) matched++;
      else unmatched++;

      return [
        userId,
        roster ? roster.employee_id : '',
        name,
        deptPath,
        dingJobnumber,
        roster ? roster.employment_status : null,
        syncStatus,
        matchMethod,
        dingName,
      ];
    });

    const placeholders = values.map((_, idx) =>
      `($${idx * 9 + 1}, $${idx * 9 + 2}, $${idx * 9 + 3}, $${idx * 9 + 4}, $${idx * 9 + 5}, $${idx * 9 + 6}, $${idx * 9 + 7}, $${idx * 9 + 8}, $${idx * 9 + 9})`
    ).join(',');
    const flat = values.flat();

    await db.query(`
      INSERT INTO dingtalk_user_mapping
        (dingtalk_userid, employee_id, employee_name, department_path, jobnumber, employment_status, sync_status, match_method, dingtalk_name)
      VALUES ${placeholders}
      ON CONFLICT (dingtalk_userid) DO UPDATE SET
        employee_id = EXCLUDED.employee_id,
        employee_name = EXCLUDED.employee_name,
        department_path = EXCLUDED.department_path,
        jobnumber = EXCLUDED.jobnumber,
        employment_status = EXCLUDED.employment_status,
        sync_status = EXCLUDED.sync_status,
        match_method = EXCLUDED.match_method,
        dingtalk_name = EXCLUDED.dingtalk_name,
        updated_at = NOW()
    `, flat);
  }

  console.log(`[同步] 人员映射完成：matched=${matched}, unmatched=${unmatched}`);

  // 4.5 清理不在本次钉钉通讯录中的旧映射（离职/删号账号），避免残留 matched 影响统计
  const staleRes = await db.query(`
    UPDATE dingtalk_user_mapping
    SET sync_status = 'unmatched', updated_at = NOW()
    WHERE sync_status = 'matched'
      AND NOT (dingtalk_userid = ANY($1::varchar[]))
  `, [dingtalkUserIds]);
  if (staleRes.rowCount > 0) {
    console.log(`  [清理] ${staleRes.rowCount} 个不在钉钉通讯录的残留账号置为 unmatched`);
  }

  console.log(`  [匹配方式] userid≈工号=${matchMethods.userid_id}, jobnumber=${matchMethods.jobnumber}, 手机号=${matchMethods.mobile}, 姓名+部门=${matchMethods.name_dept}`);
  return { matched, unmatched, matchMethods };
}

// =============================================================================
// 三、打卡结果同步 — 钉钉 /attendance/list API
// =============================================================================

/**
 * 调用钉钉获取打卡结果 API
 * URL: POST https://oapi.dingtalk.com/attendance/list?access_token=xxx
 * 限制：userIdList ≤ 50 人, workDateFrom ~ workDateTo ≤ 7 天, limit ≤ 50
 * 
 * 返回原始 API 记录数组，每条含 checkType(OnDuty/OffDuty), timeResult, procInstId 等
 */
async function getCheckResultsRaw(token, userIds, fromDate, toDate) {
  const url = `${DINGTALK_API}/attendance/list`;
  const from = moment(fromDate).format('YYYY-MM-DD HH:mm:ss');
  const to = moment(toDate).format('YYYY-MM-DD HH:mm:ss');

  let allRecords = [];
  const limit = 50;

  for (let i = 0; i < userIds.length; i += BATCH_USER_SIZE) {
    const batchUserIds = userIds.slice(i, i + BATCH_USER_SIZE);
    let offset = 0;

    while (true) {
      let retry = 0;
      let resp;

      while (retry < 3) {
        try {
          resp = await axios.post(url, {
            workDateFrom: from,
            workDateTo: to,
            userIdList: batchUserIds,
            offset,
            limit
          }, {
            params: { access_token: token },
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
          });
          break;
        } catch (err) {
          retry++;
          await sleep(1000);
          if (retry >= 3) {
            throw new Error(`打卡结果 API 调用失败（重试3次）: ${err.message}`);
          }
        }
      }

      const data = resp.data;
      if (data.errcode && data.errcode !== 0) {
        // 88 = 限流
        if (data.errcode === 88) {
          console.warn('  [限流] 等待2秒后重试');
          await sleep(2000);
          continue;
        }
        console.warn(`  [API] 打卡结果错误 [${data.errcode}] ${data.errmsg}`);
        break;
      }

      const records = data.recordresult || [];
      allRecords = allRecords.concat(records);

      if (!data.hasMore || records.length < limit) break;
      offset += limit;
      await sleep(API_DELAY_MS);
    }

    await sleep(API_DELAY_MS);
  }

  return allRecords;
}

/**
 * 将钉钉原始打卡记录转为"一行一人一天"的日级结果
 * 钉钉对同一天同一人返回两条记录（OnDuty上班 + OffDuty下班），合并后方便帆软按天聚合
 * 
 * 转换逻辑：
 *   - 按 (userId, date) 分组
 *   - OnDuty 映射到 check_in_* 字段
 *   - OffDuty 映射到 check_out_* 字段
 *   - 用 procInstId 判断异常是否已被审批抵消
 *   - 计算迟到/早退时长（分钟）
 */
function mergeRecordsToDaily(records) {
  const grouped = {}; // key = `${userId}|${date}`

  for (const rec of records) {
    const userId = rec.userId;
    // workDate 返回毫秒时间戳，转 YYYY-MM-DD
    const date = moment(rec.workDate).format('YYYY-MM-DD');
    const key = `${userId}|${date}`;

    if (!grouped[key]) {
      grouped[key] = {
        dingtalk_userid: userId,
        attendance_date: date,
        // 上班
        check_in_base_time: null,
        check_in_actual_time: null,
        check_in_time_result: null,
        check_in_location_result: null,
        check_in_proc_inst_id: null,
        // 下班
        check_out_base_time: null,
        check_out_actual_time: null,
        check_out_time_result: null,
        check_out_location_result: null,
        check_out_proc_inst_id: null,
      };
    }

    const row = grouped[key];
    const baseTime = rec.baseCheckTime ? moment(Number(rec.baseCheckTime)).toISOString() : null;
    const actualTime = rec.userCheckTime ? moment(Number(rec.userCheckTime)).toISOString() : null;
    const timeResult = rec.timeResult || null;
    const locResult = rec.locationResult || null;
    const procInstId = rec.procInstId || null;

    if (rec.checkType === 'OnDuty') {
      row.check_in_base_time = baseTime;
      row.check_in_actual_time = actualTime;
      row.check_in_time_result = timeResult;
      row.check_in_location_result = locResult;
      row.check_in_proc_inst_id = procInstId;
    } else if (rec.checkType === 'OffDuty') {
      row.check_out_base_time = baseTime;
      row.check_out_actual_time = actualTime;
      row.check_out_time_result = timeResult;
      row.check_out_location_result = locResult;
      row.check_out_proc_inst_id = procInstId;
    }
  }

  // 计算汇总字段
  const dailyResults = [];
  for (const key of Object.keys(grouped)) {
    const row = grouped[key];

    // 迟到/早退时长计算
    let lateMin = 0, earlyMin = 0;
    let lateCount = 0, earlyLeaveCount = 0, lackCardCount = 0;
    let isAbsent = false;
    let hasApprovalCancel = false;

    const checkFields = [
      { timeResult: row.check_in_time_result, base: row.check_in_base_time, actual: row.check_in_actual_time, procInstId: row.check_in_proc_inst_id, label: '上班' },
      { timeResult: row.check_out_time_result, base: row.check_out_base_time, actual: row.check_out_actual_time, procInstId: row.check_out_proc_inst_id, label: '下班' },
    ];

    for (const f of checkFields) {
      if (!f.timeResult) continue;

      if (f.procInstId) hasApprovalCancel = true;

      if (f.timeResult === 'Late' || f.timeResult === 'SeriousLate') {
        lateCount++;
        if (f.base && f.actual) {
          lateMin += Math.max(0, Math.round((moment(f.actual) - moment(f.base)) / 60000));
        }
      } else if (f.timeResult === 'Absenteeism') {
        lateCount++;
        isAbsent = true;
      } else if (f.timeResult === 'Early') {
        earlyLeaveCount++;
        if (f.base && f.actual) {
          earlyMin += Math.max(0, Math.round((moment(f.base) - moment(f.actual)) / 60000));
        }
      } else if (f.timeResult === 'NotSigned') {
        lackCardCount++;
      }
    }

    // 有效异常 = 有迟到/早退/缺卡/旷工 且 没有审批抵消
    const hasAnyException = lateCount > 0 || earlyLeaveCount > 0 || lackCardCount > 0 || isAbsent;
    const validException = hasAnyException && !hasApprovalCancel;

    row.late_minutes = lateMin;
    row.early_leave_minutes = earlyMin;
    row.late_count = lateCount;
    row.early_leave_count = earlyLeaveCount;
    row.lack_card_count = lackCardCount;
    row.is_absent = isAbsent;
    row.has_approval_cancel = hasApprovalCancel;
    row.valid_exception = validException;

    dailyResults.push(row);
  }

  return dailyResults;
}

/** 批量写入 attendance_daily_result */
async function saveDailyResults(results) {
  if (results.length === 0) return 0;

  const BATCH = 200;
  let totalInserted = 0;

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);

    // 构建 UPSERT SQL
    const cols = [
      'dingtalk_userid', 'attendance_date',
      'check_in_base_time', 'check_in_actual_time', 'check_in_time_result', 'check_in_location_result', 'check_in_proc_inst_id',
      'check_out_base_time', 'check_out_actual_time', 'check_out_time_result', 'check_out_location_result', 'check_out_proc_inst_id',
      'late_minutes', 'early_leave_minutes', 'late_count', 'early_leave_count', 'lack_card_count', 'is_absent',
      'has_approval_cancel', 'valid_exception',
    ];

    const placeholders = batch.map((_, idx) =>
      `(${cols.map((_, j) => `$${idx * cols.length + j + 1}`).join(',')})`
    ).join(',');

    const flat = batch.flatMap(row => cols.map(col => row[col] ?? null));

    const upsert = `
      INSERT INTO attendance_daily_result (${cols.map(c => `"${c}"`).join(',')})
      VALUES ${placeholders}
      ON CONFLICT (dingtalk_userid, attendance_date) DO UPDATE SET
        check_in_base_time = EXCLUDED.check_in_base_time,
        check_in_actual_time = EXCLUDED.check_in_actual_time,
        check_in_time_result = EXCLUDED.check_in_time_result,
        check_in_location_result = EXCLUDED.check_in_location_result,
        check_in_proc_inst_id = EXCLUDED.check_in_proc_inst_id,
        check_out_base_time = EXCLUDED.check_out_base_time,
        check_out_actual_time = EXCLUDED.check_out_actual_time,
        check_out_time_result = EXCLUDED.check_out_time_result,
        check_out_location_result = EXCLUDED.check_out_location_result,
        check_out_proc_inst_id = EXCLUDED.check_out_proc_inst_id,
        late_minutes = EXCLUDED.late_minutes,
        early_leave_minutes = EXCLUDED.early_leave_minutes,
        late_count = EXCLUDED.late_count,
        early_leave_count = EXCLUDED.early_leave_count,
        lack_card_count = EXCLUDED.lack_card_count,
        is_absent = EXCLUDED.is_absent,
        has_approval_cancel = EXCLUDED.has_approval_cancel,
        valid_exception = EXCLUDED.valid_exception,
        updated_at = NOW()
    `;

    const res = await db.query(upsert, flat);
    totalInserted += res.rowCount;
  }

  return totalInserted;
}

/**
 * 主流程：同步打卡结果
 * 按"7天一批 × 50人一批"的节奏分批调用钉钉 API
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} toDate - YYYY-MM-DD
 * @param {string[]} mappingUserIds - 已匹配的钉钉 UserId 列表
 */
async function syncCheckResults(token, fromDate, toDate, mappingUserIds) {
  console.log(`\n[同步] 开始打卡结果同步 (${fromDate} ~ ${toDate}, ${mappingUserIds.length} 人)`);

  const start = moment(fromDate);
  const end = moment(toDate);
  let totalRecords = 0;
  let totalRows = 0;

  // 按 7 天切分日期范围
  let cursor = start.clone();
  while (cursor.isSameOrBefore(end)) {
    // 每批最多 7 天
    let batchEnd = cursor.clone().add(MAX_DATE_RANGE_DAYS - 1, 'days');
    if (batchEnd.isAfter(end)) batchEnd = end.clone();

    const dateFrom = cursor.format('YYYY-MM-DD');
    const dateTo = batchEnd.format('YYYY-MM-DD');
    const daysDiff = batchEnd.diff(cursor, 'days') + 1;

    console.log(`  [打卡] ${dateFrom} ~ ${dateTo} (${daysDiff} 天)`);

    // 拉钉钉原始记录
    const rawRecords = await getCheckResultsRaw(token, mappingUserIds, dateFrom, dateTo);
    totalRecords += rawRecords.length;

    // 合并 OnDuty/OffDuty → 一行一人一天
    const dailyResults = mergeRecordsToDaily(rawRecords);

    // 批量入库
    const saved = await saveDailyResults(dailyResults);
    totalRows += saved;

    console.log(`    → 获取 ${rawRecords.length} 条原始记录，合并为 ${dailyResults.length} 行日级结果，写入 ${saved} 行`);

    cursor = batchEnd.clone().add(1, 'days');
    await sleep(API_DELAY_MS);
  }

  console.log(`[同步] 打卡结果完成：${totalRecords} 条原始记录 → ${totalRows} 行日级结果`);
  return { rawRecords: totalRecords, dailyRows: totalRows };
}

// =============================================================================
// 四、请假状态同步 — 钉钉 /topapi/attendance/getleavestatus
// =============================================================================

/**
 * 同步请假类型名称映射（leave_code → leave_name）
 * URL: POST /topapi/attendance/vacation/type/list（查询假期规则列表）
 * 权限：钉钉假期读权限；op_userid 必须是拥有 OA 审批应用权限的管理员
 * 看板"请假类型占比"需要可读名称，钉钉请假单里只有 leave_code（UUID）
 */
async function syncLeaveTypes(token) {
  console.log('\n[同步] 开始请假类型同步...');

  // 1. 取企业管理员列表（任选一个作为 op_userid）
  const adminRes = await axios.post(
    `${DINGTALK_API}/topapi/user/listadmin`,
    { size: 100 },
    { params: { access_token: token }, timeout: 15000 }
  );
  if (adminRes.data.errcode && adminRes.data.errcode !== 0) {
    throw new Error(`获取管理员列表失败: [${adminRes.data.errcode}] ${adminRes.data.errmsg}`);
  }
  // 兼容两种结构：result 直接是数组，或 result.list
  const rawAdmins = adminRes.data.result;
  const admins = Array.isArray(rawAdmins) ? rawAdmins : (rawAdmins?.list || []);
  if (admins.length === 0) {
    throw new Error('企业无管理员，无法调用假期规则接口（op_userid 必填）');
  }
  // 优先选主管理员（sys_level=1，更可能有 OA 审批权限）
  const primary = admins.find(a => a.sys_level === 1) || admins[0];
  const opUserid = primary.userid;

  // 2. 查询假期规则列表（result 直接是数组，无分页）
  const res = await axios.post(
    `${DINGTALK_API}/topapi/attendance/vacation/type/list`,
    { op_userid: opUserid, vacation_source: 'all' },
    {
      params: { access_token: token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    }
  );
  const data = res.data;
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`获取假期规则失败: [${data.errcode}] ${data.errmsg}`);
  }
  const list = Array.isArray(data.result) ? data.result : [];

  for (const t of list) {
    if (!t.leave_code) continue;
    await db.query(`
      INSERT INTO attendance_leave_type (leave_code, leave_name, view_unit, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (leave_code) DO UPDATE SET
        leave_name = EXCLUDED.leave_name,
        view_unit = EXCLUDED.view_unit,
        updated_at = NOW()
    `, [t.leave_code, t.leave_name || '', t.leave_view_unit || '']);
  }

  console.log(`[同步] 请假类型完成：${list.length} 条（op_userid=${opUserid}）`);
  return list.length;
}

/**
 * 获取指定人员在指定时间段的请假状态
 * URL: POST /topapi/attendance/getleavestatus
 * 限制：userid_list ≤ 100 人, 时间范围 ≤ 180 天
 */
async function syncLeaveStatus(token, fromDate, toDate, mappingUserIds) {
  console.log(`\n[同步] 开始请假状态同步 (${fromDate} ~ ${toDate})`);

  const startTime = moment(fromDate).valueOf();
  const endTime = moment(toDate).endOf('day').valueOf();
  let totalSaved = 0;

  for (let i = 0; i < mappingUserIds.length; i += BATCH_LEAVE_USER_SIZE) {
    const batch = mappingUserIds.slice(i, i + BATCH_LEAVE_USER_SIZE);
    const useridList = batch.join(',');

    let offset = 0, hasMore = true, retry = 0;

    while (hasMore) {
      let resp;
      try {
        resp = await axios.post(
          `${DINGTALK_API}/topapi/attendance/getleavestatus`,
          {
            userid_list: useridList,
            start_time: startTime,
            end_time: endTime,
            offset,
            size: 20
          },
          {
            params: { access_token: token },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000
          }
        );
      } catch (err) {
        retry++;
        if (retry >= 3) break;
        await sleep(1000);
        continue;
      }

      const data = resp.data;
      if (data.errcode && data.errcode !== 0) {
        console.warn(`  [请假] API错误 [${data.errcode}] ${data.errmsg}`);
        break;
      }

      const leaveList = data.result?.leave_status || [];
      // 入库
      if (leaveList.length > 0) {
        // 同一批返回里可能出现同 (userid, 日期, 假别) 的多条记录（如同一天两个相同假别审批），
        // INSERT ... ON CONFLICT DO UPDATE 不允许同一行被影响两次，必须先按唯一键去重
        const dedupMap = new Map();
        leaveList.forEach(l => {
          const leaveDate = moment(l.start_time).format('YYYY-MM-DD');
          const key = `${l.userid}|${leaveDate}|${l.leave_code || ''}`;
          dedupMap.set(key, [
            l.userid,
            leaveDate,
            l.leave_code || '',
            l.duration_percent || 0,
            l.duration_unit || 'percent_day',
            l.start_time ? new Date(l.start_time).toISOString() : null,
            l.end_time ? new Date(l.end_time).toISOString() : null,
          ]);
        });
        const values = [...dedupMap.values()];

        if (values.length > 0) {
          const placeholders = values.map((_, idx) =>
            `($${idx * 7 + 1}, $${idx * 7 + 2}::date, $${idx * 7 + 3}, $${idx * 7 + 4}::numeric, $${idx * 7 + 5}, $${idx * 7 + 6}, $${idx * 7 + 7})`
          ).join(',');
          const flat = values.flat();

          await db.query(`
            INSERT INTO attendance_leave_status
              (dingtalk_userid, attendance_date, leave_code, duration_percent, duration_unit, start_time, end_time)
            VALUES ${placeholders}
            ON CONFLICT (dingtalk_userid, attendance_date, leave_code) DO UPDATE SET
              duration_percent = EXCLUDED.duration_percent,
              duration_unit = EXCLUDED.duration_unit,
              start_time = EXCLUDED.start_time,
              end_time = EXCLUDED.end_time
          `, flat);
          totalSaved += values.length;
        }
      }

      hasMore = data.result?.has_more || false;
      offset += 20;
      await sleep(API_DELAY_MS);
    }

    await sleep(API_DELAY_MS);
    const progress = Math.min(i + BATCH_LEAVE_USER_SIZE, mappingUserIds.length);
    if (progress % 500 === 0 || progress === mappingUserIds.length) {
      console.log(`  [请假] 进度 ${progress}/${mappingUserIds.length}, 已保存 ${totalSaved} 条`);
    }
  }

  console.log(`[同步] 请假状态完成：${totalSaved} 条`);
  return totalSaved;
}

// =============================================================================
// 五、汇总计算 — 帆软看板预计算层
// =============================================================================

/**
 * 计算指定日期的部门日汇总
 * 从 attendance_daily_result + dingtalk_user_mapping JOIN 按部门聚合
 */
async function calcDepartmentDaily(dateStr) {
  console.log(`  [汇总] 部门日汇总 ${dateStr}`);

  // 先清空当天数据
  await db.query('DELETE FROM attendance_department_daily WHERE stat_date = $1', [dateStr]);

  // 聚合计算
  // 口径：expected_count = 当天钉钉生成考勤日报的人数（INNER JOIN daily_result），
  //       actual_count = check_in_time_result 不是 NotSigned（缺卡）也不是 Absenteeism（旷工）的人，
  //       这样出勤率 = 正常出勤/(正常+迟到+早退+请假)，有请假审批的人算出勤
  const result = await db.query(`
    INSERT INTO attendance_department_daily
      (stat_date, department_path, expected_count, actual_count, attendance_rate,
       late_total, early_leave_total, lack_card_total, absent_total, leave_total_days)
    SELECT
      $1::date AS stat_date,
      COALESCE(m.department_path, '') AS department_path,
      COUNT(DISTINCT r.dingtalk_userid) AS expected_count,
      COUNT(DISTINCT r.dingtalk_userid) FILTER (WHERE r.check_in_time_result != 'NotSigned' AND r.check_in_time_result != 'Absenteeism') AS actual_count,
      CASE WHEN COUNT(DISTINCT r.dingtalk_userid) > 0
        THEN ROUND((COUNT(DISTINCT r.dingtalk_userid) FILTER (WHERE r.check_in_time_result != 'NotSigned' AND r.check_in_time_result != 'Absenteeism'))::numeric / COUNT(DISTINCT r.dingtalk_userid), 4)
        ELSE 0
      END AS attendance_rate,
      SUM(r.late_count) AS late_total,
      SUM(r.early_leave_count) AS early_leave_total,
      SUM(r.lack_card_count) AS lack_card_total,
      SUM(CASE WHEN r.is_absent THEN 1 ELSE 0 END) AS absent_total,
      COALESCE(SUM(l.duration_percent / 100.0), 0) AS leave_total_days
    FROM (
      -- 同一员工ID 多钉钉账号时只取最新一条映射，防止部门人数重复计数
      SELECT DISTINCT ON (m.employee_id)
        m.dingtalk_userid, m.employee_id, m.department_path
      FROM dingtalk_user_mapping m
      WHERE m.sync_status = 'matched' AND m.employment_status = '在岗' AND m.employee_id IS NOT NULL
      ORDER BY m.employee_id, m.updated_at DESC
    ) m
    INNER JOIN attendance_daily_result r
      ON r.dingtalk_userid = m.dingtalk_userid AND r.attendance_date = $1::date
    LEFT JOIN attendance_leave_status l
      ON l.dingtalk_userid = m.dingtalk_userid AND l.attendance_date = $1::date
    GROUP BY COALESCE(m.department_path, '')
  `, [dateStr]);

  await db.query('UPDATE attendance_department_daily SET updated_at = NOW() WHERE stat_date = $1', [dateStr]);
  return result.rowCount || 0; // pg 库 INSERT 语句没有 RETURNING 时 rows 是空的，影响行数在 rowCount
}

/**
 * 计算指定月份的员工月汇总
 */
async function calcEmployeeMonthly(yearMonth) {
  console.log(`  [汇总] 员工月汇总 ${yearMonth}`);

  // 先清空当月数据
  await db.query('DELETE FROM attendance_employee_monthly WHERE year_month = $1', [yearMonth]);

  // 计算当月起止日期（用 date_trunc 正确处理 28/29/30/31 天）
  // $1 = '2026-04', firstDay = '2026-04-01', lastDay = '2026-04-30'
  // 口径：INNER JOIN daily_result → 只统计当月有考勤记录的员工，
  //       expected_work_days = 钉钉生成考勤日报的天数（含请假/加班），
  //       actual_work_days = 其中有打卡的天数
  //       整月无考勤的员工（如离职未更新 mapping）不会出现在月汇总里
  const result = await db.query(`
    INSERT INTO attendance_employee_monthly
      (employee_id, employee_name, department_path, year_month,
       expected_work_days, actual_work_days, attendance_rate,
       late_count, late_duration_min, early_leave_count, early_leave_duration_min,
       lack_card_count, absent_days, leave_days)
    SELECT
      m.employee_id,
      m.employee_name,
      m.department_path,
      $1 AS year_month,
      COUNT(DISTINCT r.attendance_date) AS expected_work_days,
      COUNT(DISTINCT r.attendance_date) FILTER (WHERE r.check_in_time_result != 'NotSigned' AND r.check_in_time_result != 'Absenteeism') AS actual_work_days,
      CASE WHEN COUNT(DISTINCT r.attendance_date) > 0
        THEN ROUND((COUNT(DISTINCT r.attendance_date) FILTER (WHERE r.check_in_time_result != 'NotSigned' AND r.check_in_time_result != 'Absenteeism'))::numeric / COUNT(DISTINCT r.attendance_date), 4)
        ELSE 0
      END AS attendance_rate,
      SUM(COALESCE(r.late_count, 0)) AS late_count,
      SUM(COALESCE(r.late_minutes, 0)) AS late_duration_min,
      SUM(COALESCE(r.early_leave_count, 0)) AS early_leave_count,
      SUM(COALESCE(r.early_leave_minutes, 0)) AS early_leave_duration_min,
      SUM(COALESCE(r.lack_card_count, 0)) AS lack_card_count,
      SUM(CASE WHEN r.is_absent THEN 1 ELSE 0 END) AS absent_days,
      COALESCE(SUM(l.duration_percent / 100.0), 0) AS leave_days
    FROM (
      -- 同一员工ID 多钉钉账号时只取最新一条映射，保证每工号一行（唯一约束 employee_id+year_month）
      SELECT DISTINCT ON (m.employee_id)
        m.dingtalk_userid, m.employee_id, m.employee_name, m.department_path
      FROM dingtalk_user_mapping m
      WHERE m.sync_status = 'matched' AND m.employment_status = '在岗' AND m.employee_id IS NOT NULL
      ORDER BY m.employee_id, m.updated_at DESC
    ) m
    INNER JOIN attendance_daily_result r
      ON r.dingtalk_userid = m.dingtalk_userid
      AND r.attendance_date >= date_trunc('month', ($1 || '-01')::date)
      AND r.attendance_date <  date_trunc('month', ($1 || '-01')::date) + interval '1 month'
    LEFT JOIN attendance_leave_status l
      ON l.dingtalk_userid = m.dingtalk_userid
      AND l.attendance_date >= date_trunc('month', ($1 || '-01')::date)
      AND l.attendance_date <  date_trunc('month', ($1 || '-01')::date) + interval '1 month'
    GROUP BY m.employee_id, m.employee_name, m.department_path
  `, [yearMonth]);

  await db.query('UPDATE attendance_employee_monthly SET updated_at = NOW() WHERE year_month = $1', [yearMonth]);
  return result.rowCount || 0;
}

/** 批量计算日期范围内的汇总数据 */
async function calcSummary(fromDate, toDate) {
  console.log(`\n[汇总] 开始汇总计算 (${fromDate} ~ ${toDate})`);

  const deptDates = [];
  let d = moment(fromDate);
  const end = moment(toDate);
  while (d.isSameOrBefore(end)) {
    deptDates.push(d.format('YYYY-MM-DD'));
    d.add(1, 'day');
  }

  let deptCount = 0;
  for (const date of deptDates) {
    const cnt = await calcDepartmentDaily(date);
    deptCount += cnt;
  }
  console.log(`  部门日汇总：${deptDates.length} 天 × ${deptCount} 行部门数据`);

  // 员工月汇总（只算涉及的月份）
  const yearMonths = new Set();
  for (const date of deptDates) {
    yearMonths.add(date.substring(0, 7));
  }

  let empCount = 0;
  for (const ym of yearMonths) {
    const cnt = await calcEmployeeMonthly(ym);
    empCount += cnt;
  }
  console.log(`  员工月汇总：${yearMonths.size} 月 × ${empCount} 行员工数据`);

  return { deptDays: deptDates.length, deptRows: deptCount, empMonths: yearMonths.size, empRows: empCount };
}

// =============================================================================
// 六、主流程编排 — 全量同步
// =============================================================================

/**
 * 全量同步考勤数据主入口
 * @param {Object} params
 * @param {string} params.fromDate - YYYY-MM-DD
 * @param {string} params.toDate - YYYY-MM-DD
 * @param {boolean} params.refreshMapping - 是否强制刷新人员映射（默认 true）
 * @param {function} [params.onProgress] - 进度回调 ({ stage, progress, message, type })
 */
async function fullSync({ fromDate, toDate, refreshMapping = true, onProgress }) {
  // 进度回调安全包装（onProgress 不传时静默跳过）
  const report = (stage, progress, message, type = 'info') => {
    if (typeof onProgress === 'function') {
      try { onProgress({ stage, progress, message, type }); } catch (_) {}
    }
  };

  report('初始化', 0, `开始同步 ${fromDate} ~ ${toDate}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`钉钉考勤看板 - 全量同步启动`);
  console.log(`时间范围：${fromDate} ~ ${toDate}`);
  console.log(`${'='.repeat(60)}`);

  const token = await getAccessToken();
  console.log(`[Token] 获取成功`);
  report('获取Token', 5, 'Token 获取成功');

  // 步骤 1：获取全公司 UserId（附带每人钉钉部门路径）
  report('拉取部门树', 10, '开始拉取钉钉部门树和用户列表...');
  const { users: allUserIds, userDeptMap } = await getAllCompanyUsers(token);
  report('拉取部门树', 15, `获取 ${allUserIds.length} 名员工`);

  // 步骤 2：人员映射（UserId ↔ employee_id）
  if (refreshMapping) {
    report('人员映射', 18, '开始同步人员映射...');
    await syncUserMapping(token, allUserIds, userDeptMap);
  }
  report('人员映射', 25, '人员映射完成');

  // 只同步已匹配的在岗人员
  const { rows: mappingRows } = await db.query(
    "SELECT dingtalk_userid FROM dingtalk_user_mapping WHERE sync_status = 'matched' AND employment_status = '在岗'"
  );
  const mappingUserIds = mappingRows.map(r => r.dingtalk_userid);
  console.log(`\n[筛选] 已匹配在岗人员：${mappingUserIds.length} / ${allUserIds.length}`);

  if (mappingUserIds.length === 0) {
    console.warn('⚠️ 没有匹配到任何在岗人员，可能 jobnumber 和 employees.employee_id 对不上');
    console.warn('   检查钉钉用户 jobnumber 字段值和 PS 系统 employees 表 employee_id 格式是否一致');
  }

  // 步骤 3：打卡结果同步
  report('打卡结果同步', 30, `开始同步打卡结果（${mappingUserIds.length} 人）...`);
  const checkStats = await syncCheckResults(token, fromDate, toDate, mappingUserIds);
  report('打卡结果同步', 55, `打卡完成：${checkStats.rawRecords} 条原始 → ${checkStats.dailyRows} 行日级`);

  // 步骤 4：请假类型名称 + 请假状态同步
  // 类型名称依赖"钉钉假期读权限"(qyapi_holiday_readonly)，未开通时不阻断整体同步
  report('请假同步', 58, '开始请假类型和状态同步...');
  try {
    await syncLeaveTypes(token);
  } catch (e) {
    console.warn(`  ⚠️ 请假类型同步跳过：${e.message}`);
  }
  const leaveStats = await syncLeaveStatus(token, fromDate, toDate, mappingUserIds);
  report('请假同步', 70, `请假状态完成：${leaveStats} 条`);

  // 步骤 5：写入 employee_name / department_path 冗余（从 mapping 表回填）
  report('数据回填', 75, '从 mapping 表回填冗余字段...');
  await enrichWithMapping();
  report('数据回填', 80, '回填完成');

  // 步骤 6：汇总计算
  report('汇总计算', 82, '开始部门日汇总和员工月汇总...');
  const summaryStats = await calcSummary(fromDate, toDate);
  report('汇总计算', 95, `汇总完成：${summaryStats.deptRows} 行部门日 / ${summaryStats.empRows} 行员工月`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ 全量同步完成`);
  console.log(`  打卡结果：${checkStats.rawRecords} 条原始 → ${checkStats.dailyRows} 行日级`);
  console.log(`  请假状态：${leaveStats} 条`);
  console.log(`  部门日汇总：${summaryStats.deptDays} 天 × ${summaryStats.deptRows} 行`);
  console.log(`  员工月汇总：${summaryStats.empMonths} 月 × ${summaryStats.empRows} 行`);
  console.log(`${'='.repeat(60)}`);

  report('完成', 100, `同步完成：匹配 ${mappingUserIds.length} 人，打卡 ${checkStats.dailyRows} 行，请假 ${leaveStats} 条`, 'success');

  return {
    timeRange: { fromDate, toDate },
    matchedUsers: mappingUserIds.length,
    checkStats,
    leaveStats,
    summaryStats
  };
}

/** 从 mapping 表回填 employee_name / department_path / employee_id 到打卡结果表和请假表
 *  部门路径直接覆盖（mapping 表已截取前2级，需覆盖旧的长路径数据） */
async function enrichWithMapping() {
  console.log('  [回填] 从 mapping 表回填冗余字段到 attendance_daily_result / attendance_leave_status...');

  const res = await db.query(`
    UPDATE attendance_daily_result r
    SET employee_id = COALESCE(NULLIF(m.employee_id, ''), r.employee_id),
        employee_name = COALESCE(NULLIF(m.employee_name, ''), r.employee_name),
        department_path = COALESCE(NULLIF(m.department_path, ''), r.department_path),
        updated_at = NOW()
    FROM dingtalk_user_mapping m
    WHERE r.dingtalk_userid = m.dingtalk_userid
      AND m.sync_status = 'matched'
  `);
  console.log(`    → 打卡结果表更新 ${res.rowCount} 行`);

  // 请假表：getleavestatus 不带部门/姓名，全部依赖 mapping 回填
  const resLeave = await db.query(`
    UPDATE attendance_leave_status l
    SET employee_id = COALESCE(NULLIF(m.employee_id, ''), l.employee_id),
        employee_name = COALESCE(NULLIF(m.employee_name, ''), l.employee_name),
        department_path = COALESCE(NULLIF(m.department_path, ''), l.department_path)
    FROM dingtalk_user_mapping m
    WHERE l.dingtalk_userid = m.dingtalk_userid
      AND m.sync_status = 'matched'
  `);
  console.log(`    → 请假表更新 ${resLeave.rowCount} 行`);
}

// =============================================================================
// 旧 API 函数（废弃保留引用，不再被调用）
// =============================================================================

module.exports = {
  // 基础 API
  getAccessToken,
  getAllCompanyUsers,
  getUserInfo,

  // 新同步流程
  syncUserMapping,
  syncCheckResults,
  syncLeaveTypes,
  syncLeaveStatus,
  calcSummary,
  fullSync,

  // 内部工具
  mergeRecordsToDaily,
  saveDailyResults,
  enrichWithMapping,
  calcDepartmentDaily,
  calcEmployeeMonthly,
};
