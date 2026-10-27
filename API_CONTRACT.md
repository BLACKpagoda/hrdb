# 前后端 API 对接契约

> 本文档记录 hrdb 后端与 hr-front 前端的接口对接关系。
> 任何新会话读取本文件即可恢复对接上下文，不依赖对话记忆。

## 项目位置

| 项目 | 路径 | 技术栈 |
|------|------|--------|
| 后端 hrdb | `d:\personnelDep\hrdb` | Node.js + Express + PostgreSQL |
| 前端 hr-front | `D:\personnelDep\hr-front` | React 19 + Antd + react-router-dom 6 |

## 启动方式

| 端 | 命令 | 端口 |
|----|------|------|
| 后端 | `npm run dev`（nodemon）或 `npm start` | **3001**（由 `.env` 的 `PORT=3001` 控制） |
| 前端 | `npm start`（react-scripts） | 3000（CRA 默认） |

## 端口约定（已修复）

- 后端 [bin/www](bin/www) 通过 `process.env.PORT || '3000'` 读取端口
- [.env](.env) 配置 `PORT=3001`，使后端监听 3001
- 前端 [src/utils/request.js](../hr-front/src/utils/request.js) `baseURL: 'http://localhost:3001'` 与后端对齐
- 前端页面跑在 3000，后端 API 跑在 3001，**互不冲突，前端零改动即可联调**

## 接口对接全表

| 前端调用方 | HTTP 方法 & 路径 | 后端处理文件 | 用途 |
|-----------|------------------|--------------|------|
| `pages/SalaryAnalysis/SalaryAnalysis.jsx` | `GET /salary-periods` | `modules/salary/routes.js` | 获取薪酬期间列表 |
| `pages/SalaryAnalysis/SalaryAnalysis.jsx` | `GET /salary-all-data` | `modules/salary/routes.js` | 全期间薪酬汇总 |
| `pages/SalaryAnalysis/SalaryAnalysis.jsx` | `GET /salary-summary` | `modules/salary/routes.js` | 维度筛选薪酬汇总 |
| `pages/EmployeeManagement/EmployeeManagement.jsx` | `GET /personnel/list?page&size` | `routes/index.js` | 员工列表分页 |
| `components/Import/EmployeeImport.jsx` | `POST /import-employees` (multipart) | `routes/index.js` | PS 系统 Excel 导入 |
| `components/Import/AttendanceImport.jsx` | `POST /attendance/excel` (multipart) | `modules/attendance-excel/routes.js` | 原始考勤 Excel 导入 |
| `pages/Attendance/Attendance.jsx` | `POST /attendance/import` (multipart) | `modules/attendance-excel/routes.js` | 餐补分析考勤导入 |
| `components/Import/SalaryImport.jsx` | `POST /import-salary` (multipart) | `modules/salary/routes.js` | 薪酬 Excel 导入 |
| `pages/Fanruan/Fanruan.jsx` | `POST /export-fanruan` (multipart) | `routes/index.js` | 帆软指标 Excel 导入 |
| `pages/DataSync/DataSync.jsx` | `POST /sync` | `modules/attendance-sync/routes.js` | 钉钉考勤同步 |

## ⚠️ 已知前端 Bug

- [components/Sync/sync.jsx:18](../hr-front/src/components/Sync/sync.jsx#L18) 用 `GET /sync`，但后端 `/sync` 是 **POST** 接口，会失败
  - 不过 `pages/DataSync/DataSync.jsx` 用的是正确的 `POST /sync`，所以这个 `Sync.jsx` 组件可能是废弃版本
  - 且在 [App.jsx](../hr-front/src/App.jsx) 中 `// import Sync from './components/Sync/sync';` 是被注释掉的

## 后端接口结构（重构后）

```
app.js                          Express 入口（中间件、路由挂载、DB 连接测试）
├── bin/www                     HTTP 服务器启动（监听 PORT=3001）
├── db.js                       PostgreSQL 连接池（query/connect/transaction）
├── .env                        环境变量（PORT、DB、DingTalk密钥）
├── nodemon.json                nodemon 配置（监听关键目录）
│
├── config/
│   └── holidays.js             法定假日配置（2025+2026）
│
├── common/
│   ├── monthMap.js             月份中文映射工具（getTargetTableName 等）
│   └── response.js             统一响应格式 helper（success/fail）
│
├── modules/                    ★ 三大业务模块（routes→controller→service 三层）
│   ├── attendance-sync/        钉钉考勤同步
│   │   ├── routes.js           POST /sync
│   │   ├── controller.js       同步流程编排、状态管理
│   │   └── service.js          钉钉 API 调用、数据入库
│   ├── salary/                 薪酬数据管理
│   │   ├── routes.js           GET /salary-all-data、/salary-summary、/salary-periods；POST /import-salary
│   │   ├── controller.js       查询编排、维度筛选
│   │   └── service.js          174字段映射、Excel解析、批量入库
│   └── attendance-excel/       考勤 Excel 导入
│       ├── routes.js           POST /attendance/import、/attendance/excel
│       ├── controller.js       餐补分析、工作日初始化
│       └── service.js          打卡解析、动态表入库
│
├── routes/
│   ├── index.js                主路由（挂载三大模块 + 3 个保留接口）
│   │   ├── POST /export-fanruan   帆软导入（保留接口）
│   │   ├── POST /import-employees PS 员工导入（保留接口）
│   │   └── GET /personnel/list    员工列表（保留接口）
│   └── users.js                Express 脚手架遗留（未使用，可删）
│
└── model/                      历史遗留文件（重构前的旧代码）
    ├── dingtalk.js             ❌ 已被 modules/attendance-sync/service.js 替代
    ├── salary.js               ❌ 已被 modules/salary/service.js 替代
    ├── analyze.js              ❌ 已合并入 modules/attendance-excel/service.js
    ├── excelImporter.js        ❌ 已合并入 modules/attendance-excel/service.js
    ├── model.js                ❌ 仅 createTables，未使用
    ├── utils.js                ❌ 工具函数，未使用
    ├── fanruanExport.js        ✅ 仍在用（被 /export-fanruan 调用）
    └── export.js               ✅ 仍在用（被 /import-employees 调用）
```

### 数据流

```
前端请求 → app.js (cors/json/log)
       → routes/index.js
       → modules/{xxx}/routes.js       参数校验、HTTP 响应
       → modules/{xxx}/controller.js   流程编排、状态管理
       → modules/{xxx}/service.js       DB 操作、第三方 API
       → db.js (pg Pool) → PostgreSQL
```

## 前端路由结构

| 路径 | 页面组件 | 调用接口 |
|------|---------|---------|
| `/` | `Dashboard` | - |
| `/employees` | `EmployeeManagement` | `/personnel/list` |
| `/attendance` | `Attendance` | `/attendance/import` |
| `/import` | `ImportData` | （聚合多个 Import 组件） |
| `/sync` | `DataSync` | `/sync` |
| `/settings` | `SystemSettings` | - |
| `/fanruan` | `Fanruan` | `/export-fanruan` |
| `/salary-analysis` | `SalaryAnalysis` | `/salary-periods`、`/salary-all-data`、`/salary-summary` |

## 响应格式约定（已统一）

所有后端接口统一返回：

```json
{ "code": 200, "msg": "操作成功", "data": {...} }       // 成功
{ "code": 500, "msg": "失败原因", "data": null }       // 失败
```

由 [common/response.js](common/response.js) 的 `success(res, data, msg)` 和 `fail(res, msg, code)` 统一生成。

前端 [utils/request.js](../hr-front/src/utils/request.js) 响应拦截器 `code === 200` 时返回 `data`，否则 `reject msg`。
**注意**：直接用 `axios` 调用的组件（如 `SalaryAnalysis.jsx`）访问的是 `response.data.data`（axios 把整个 body 包在 `.data` 下，再取业务 `data`）——对此格式变化免疫，无需改造。

## 待处理项

1. ~~端口不一致~~（已修复，见上方"端口约定"）
2. **废弃 Sync 组件**：`components/Sync/sync.jsx` 可删
3. **`/import-employees` 的 `req.file.path` bug**：multer 用 memoryStorage，应传 `buffer`（详见 [routes/index.js](routes/index.js)）。但 `model/export.js` 的 `importEmployeesFromExcel(filePath)` 内部用 `fs.existsSync`，只支持路径。修复需改为临时文件方案或改 service 支持 buffer
4. **`attendance-excel/service.js` 中 `extractDailyRecords` 日期硬编码**：仅适用于 2025-09，需改为根据 month 动态生成

## 十三、考勤看板接口对接（AttendanceBoard）— 已实现

> 对应前端 `src/pages/AttendanceBoard/` 与 `src/api/attendance.js`（前端契约文档第十三章）。
> 后端模块：`modules/attendance-board/{routes,controller,service}.js`，已在 `routes/index.js` 挂载。

### 13.1 接口实现清单（17 个全部完成）

| 前端调用 | HTTP & 路径 | 数据来源 | 状态 |
|---------|------------|---------|------|
| `getBoardOptions()` | `GET /attendance/board/options` | `dingtalk_user_mapping`（在岗 DISTINCT department_path） | ✅ |
| `getBoardOverview(params)` | `GET /attendance/board/overview` | `attendance_department_daily`（应/实出勤）+ `attendance_daily_result`（valid_exception 异常人次）+ `attendance_leave_status`（请假，区间交集口径） | ✅ |
| `getBoardDepartmentStats(params)` | `GET /attendance/board/department-stats` | `attendance_department_daily` GROUP BY department_path + mapping headcount + leave_status | ✅ |
| `getAbnormalLateRank(params)` | `GET /attendance/board/abnormal/late-rank` | `attendance_daily_result` WHERE valid_exception AND late_count>0 | ✅ |
| `getAbnormalMisscardRank(params)` | `GET /attendance/board/abnormal/misscard-rank` | 同上 lack_card_count>0 | ✅ |
| `getAbnormalAbsentList(params)` | `GET /attendance/board/abnormal/absent-list` | 同上 is_absent，reason 固定文案 | ✅ |
| `getAbnormalDetail(params)` | `GET /attendance/board/abnormal/detail` | 分页；返回全部异常（含被抵消的），abnormalType 按旷工>缺卡>迟到>早退取最严重，旷工 duration=240 分钟 | ✅ |
| `getAbnormalResubmitList(params)` | `GET /attendance/board/abnormal/resubmit-list` | 数据缺口①，返回 `[]` | ✅ 空数据 |
| `getLeaveStats(params)` | `GET /attendance/board/leave/stats` | `attendance_leave_status`，duration 按**请假单与查询区间交集**折算小时（÷86400×8），防长单（产假）全额计入短窗口 | ✅ |
| `getOvertimeStats(params)` | `GET /attendance/board/overtime/stats` | 数据缺口②，返回全 0 结构 | ✅ 空数据 |
| `getOutingStats(params)` | `GET /attendance/board/outing/stats` | 数据缺口③，返回全 0 结构 | ✅ 空数据 |
| `getLeaveOvertimeDetail(params)` | `GET /attendance/board/leave-overtime/detail` | type=leave 查 leave_status（status 固定 approved）；type=overtime 返回空 | ✅ |
| `getBoardTrend(params)` | `GET /attendance/board/trend` | `attendance_department_daily` GROUP BY stat_date | ✅ |
| `getEmployeeAttendanceList(params)` | `GET /attendance/board/employee/list` | `attendance_employee_monthly` 跨月聚合 + keyword ILIKE + LEFT JOIN employees 取 position_name 为 jobTitle | ✅ |
| `getEmployeeCalendar(params)` | `GET /attendance/board/employee/calendar` | `attendance_daily_result` + `attendance_leave_status`；无日级记录=休息，checkIn/Out 格式 HH:mm | ✅ |
| `exportEmployeeReport(params)` | `GET /attendance/board/employee/export` | exceljs 生成 xlsx 文件流（Content-Disposition RFC5987 中文文件名） | ✅ |
| `exportDepartmentStats(params)` | `GET /attendance/board/department-stats/export` | 同 department-stats 数据 → xlsx 流 | ✅ |

### 13.2 已实现的口径约定

- 出勤率 ×100 保留 1 位小数；请假/加班小时、迟到/早退分钟
- 异常人次仅统计 `valid_exception=true`（审批抵消已剔除）；异常明细列表返回全部异常并携带 `hasApprovalCancel`/`validException` 字段供前端展示
- 在岗过滤：`employment_status='在岗' AND sync_status='matched'`（JOIN dingtalk_user_mapping）
- departmentPath 前缀匹配：`column = $N OR column LIKE $N || '%'`（占位符动态编号）
- 加班/外出/补卡为数据缺口，返回空数据结构（前端显示"暂无数据"），待补钉钉同步后替换

### 13.3 数据链修复记录（2026-09-01）

- **问题**：PS `employees` 表的 `department_path`/`position_name` 为空，同步时覆盖了 `dingtalk_user_mapping.department_path`，连带 `enrichWithMapping` 把 `attendance_daily_result` 的部门也清空，导致看板 options/headcount/部门筛选失效
- **修复**：
  1. `attendance-sync/service.js` 的 `getAllCompanyUsers` 改为在部门树遍历时构建 `userid → 钉钉部门路径` 映射（`/topapi/v2/department/listsub` 递归 + `/topapi/user/listid` 按部门拉人，零额外 API 调用），`syncUserMapping` 钉钉部门优先、PS 兜底
  2. `enrichWithMapping` 改为 COALESCE 只补空、不覆盖已有部门
  3. `jobTitle`（position_name）PS 侧无数据，暂返回空字符串
- **数据依赖**：看板数据范围由 `/sync` 同步决定；当前正在扩展至 2026-03~08（6 个月），钉钉 API 限制半年以前数据不可查（errcode 850002），实际可获取约 5 个月

### 13.4 联调重测记录（2026-09-01，17/17 通过）

| 板块 | 接口 | 结果 |
| --- | --- | --- |
| 筛选选项 | `/attendance/board/options` | ✅ 部门 254 个 |
| 总览 | `/attendance/board/overview` | ✅ 应出勤 24606 / 实际 16473 / 请假 2120.8h（区间交集口径生效） |
| 部门统计 | `/attendance/board/department-stats` | ✅ array[254] |
| 异常排行/明细 | late-rank / misscard-rank / absent-list / detail / resubmit-list | ✅（absent、resubmit 为 0/空数组属正常） |
| 请假/加班/外出 | leave/stats、overtime/stats、outing/stats、leave-overtime/detail | ✅（加班/外出按契约 13.5 返回空数据） |
| 趋势/人员明细 | trend、employee/list、employee/calendar | ✅ trend 7 天 |
| 导出 | department-stats/export、employee/export（需 userId） | ✅ 19KB / 7KB xlsx |

### 13.5 KingbaseES Oracle 模式空串陷阱（重要，2026-09-01 定位）

- **现象**：`dingtalk_user_mapping` 中在岗人员 `department_path` 明明有值（hex 为正确 UTF-8），但 `WHERE department_path IS NOT NULL AND department_path <> ''` 恒返回 0 行；行级求值 `department_path <> ''` 结果为 **NULL** 而非 true/false
- **根因**：本库为人大金仓 KingbaseES 的 **Oracle 兼容模式**——空字符串字面量 `''` 等价于 **NULL**，`col <> ''` 即 `col <> NULL` 恒为未知
- **规则**：SQL 一律**不要用 `= ''` / `<> ''` / `!= ''` 做空串比较**（写入的空串本就存为 NULL，`IS NOT NULL` 已涵盖）；`NULLIF(x, '')`、`COALESCE(x, '')` 在该模式下语义不变可保留
- **修复**：`attendance-board/service.js` 两处 `department_path <> ''` 改为仅 `IS NOT NULL`，options 部门列表恢复 254 个

### 13.6 异步同步模式（方案B，2026-09-01 实施）

- **变更原因**：6 个月全量同步耗时 30+ 分钟，同步阻塞 HTTP 连接导致前端 30 秒超时
- **新接口**：
  - `POST /sync` → 立即返回 `{ jobId, message }`，后台异步执行 `fullSync`
  - `GET /sync/status/:jobId` → 返回 `{ status, progress, stage, logs[], result, error }`
- **前端适配**：DataSync.jsx 改用轮询（3 秒间隔），实时显示后端进度和日志
- **进度回报**：`fullSync` 增加 `onProgress` 回调，在各阶段（Token 5% → 部门树 15% → 人员映射 25% → 打卡 55% → 请假 70% → 回填 80% → 汇总 95% → 完成 100%）更新状态
- **文件变更**：新建 `jobManager.js`（内存态任务管理），修改 `controller.js`（异步入口 + 状态查询），`routes.js`（新增 status 路由），`service.js`（fullSync 加 onProgress）

### 13.7 钉钉 API 半年查询限制（2026-09-01 发现）

- **errcode 850002**：`禁止查询半年以前的数据`——打卡结果 API `/attendance/list` 只允许查询近 6 个月数据
- **影响**：2026-09-01 发起同步，2026-03-01~03-07 的数据被拒绝；实际可获取约 5 个月（2026-03-08 ~ 2026-08-31）
- **对策**：同步脚本已对 API 错误容错（跳过拒绝的日期批次继续后续），不影响整体同步

### 13.8 旧表清理（2026-09-01 执行）

已删除 21 张废弃表：
- 月度宽表 12 张：`yykq1, eykq2, sykq3, sykq4, wykq5, lykq6, qykq7, bykq8, jykq9, sykq10, syykq11, seykq12`
- 旧考勤表 9 张：`daily_attendance, attendance_summary, leave_records, overtime_records, attendance_columns, attendance_records, attendance_sync_errors, employee_attendance_summary, standard_workdays`

### 13.9 前端默认日期范围优化（2026-09-01 实施）

- 看板默认周期从"本月"改为"上月"
- 初始化时查询 `/sync/coverage` 获取数据覆盖范围，若当前月无数据则自动跳转到有数据的最后一个月
- 筛选区新增紫色标签显示数据范围（min_date ~ max_date）
