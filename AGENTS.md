# hrdb — HR 人事数据后端

> 本文件供 AI 编码助手（DSH / Trae / Cursor 等）在开工前读取。
> 人读也适用。改代码前请先看完「关键约定」和「Git 工作流」。

## 一句话定位

Express 单体后端，为前端 `D:\personnelDep\hr-front` 提供 REST API。数据源是**钉钉考勤**与**人大金仓数据库**，业务覆盖考勤同步与看板、薪酬导入分析、花名册、Excel 导入导出。

配套契约文档：[API_CONTRACT.md](API_CONTRACT.md)（前后端接口全表 + 历史踩坑记录，**改接口必须同步更新它**）。

## 技术栈（以实际代码为准，非 package.json 声称）

| 项 | 实际情况 |
|----|---------|
| 运行时 | Node.js 23，Express 4.16 |
| 数据库 | **人大金仓 KingbaseES（Oracle 兼容模式）**，经 `pg` 连接池访问（[db.js](db.js)）。**不是原生 PostgreSQL**，语法陷阱见下 |
| Excel | `xlsx` 读、`exceljs` 写/导出文件流 |
| 钉钉 | **裸 axios 直连 `https://oapi.dingtalk.com`**（见 `modules/attendance-sync/service.js`）|
| 未使用依赖 | `knex`、`bullmq`、`@alicloud/dingtalk` 等在 `package.json` 里但全代码库**从未 require**；同步任务靠 `modules/attendance-sync/jobManager.js` 的**内存态** job 管理，**没有 Redis、没有队列** |

## 启动

```bash
npm install
npm run dev        # nodemon，读 nodemon.json，默认监听 3001
npm start          # 等价，无热重载
```

端口来自 `.env` 的 `PORT=3001`（`bin/www` 里 `process.env.PORT || '3000'`）。

`.env` **不入库**，首次部署需自行创建，键名如下（值找负责人要）：

```
DINGTALK_APP_KEY / DINGTALK_APP_SECRET
DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_DATABASE
PORT=3001
```

## 架构

```
app.js                    Express 入口：CORS、json、morgan、挂载路由、DB 连通性自检
bin/www                   HTTP server，监听 PORT
db.js                     pg 连接池，导出 query / connect / transaction / close
common/response.js        统一响应 success(res,data,msg) / fail(res,msg,code)
common/monthMap.js        月份→表名等工具
config/holidays.js        法定节假日（2025/2026）

routes/index.js           主路由：挂载各 module + 3 个保留接口
modules/<业务>/
  routes.js               参数校验 + HTTP 响应
  controller.js           流程编排
  service.js              DB 操作 + 第三方 API
```

请求链路：`routes/index.js` → `modules/*/routes.js` → `controller.js` → `service.js` → `db.js`。

**新增功能 = 新增一个 `modules/<name>/` 三层目录 + 在 [routes/index.js](routes/index.js) 加一行挂载**，不要在 `routes/index.js` 里堆业务逻辑。

### `model/` 是历史遗留区

重构前的旧代码，**不要往里面加新东西**：

- 已被 `modules/` 取代、**可删**：`dingtalk.js`、`salary.js`、`analyze.js`、`excelImporter.js`、`model.js`、`utils.js`
- **仍在用**：`fanruanExport.js`（被 `/export-fanruan` 调）、`export.js`（被 `/import-employees` 调）

## 接口清单（33 个，代码实测）

考勤看板 `modules/attendance-board/`（17 个，全部 GET）
```
/attendance/board/options
/attendance/board/overview
/attendance/board/department-stats        /attendance/board/department-stats/export
/attendance/board/abnormal/late-rank      /attendance/board/abnormal/misscard-rank
/attendance/board/abnormal/absent-list    /attendance/board/abnormal/detail
/attendance/board/abnormal/resubmit-list
/attendance/board/leave/stats             /attendance/board/overtime/stats
/attendance/board/outing/stats            /attendance/board/leave-overtime/detail
/attendance/board/trend
/attendance/board/employee/list           /attendance/board/employee/calendar
/attendance/board/employee/export
```

其余
```
POST /sync                     钉钉考勤同步（异步，立即返回 jobId）
GET  /sync/status/:jobId       同步进度轮询
GET  /sync/mapping-stats       人员映射统计
GET  /sync/coverage            数据覆盖日期范围
POST /attendance/import        餐补分析考勤导入
POST /attendance/excel         原始考勤 Excel 导入
GET  /salary-all-data  /salary-summary  /salary-periods
POST /import-salary
POST /roster/import    GET /roster/stats
POST /export-fanruan          帆软指标导入
POST /import-employees        PS 员工导入
GET  /personnel/list          员工列表分页
```

## 关键约定（改代码前必读）

1. **KingbaseES Oracle 模式的空串陷阱**（曾导致看板部门筛选全空）
   空字符串 `''` 等价于 `NULL`，`col <> ''` 恒为未知、永远筛不出行。
   **禁止写 `= ''` / `<> ''` / `!= ''`**，判空只写 `col IS NOT NULL`。
   `NULLIF(x,'')`、`COALESCE(x,'')` 语义不变，可保留。

2. **统一响应格式**，只能通过 `common/response.js`：
   ```js
   success(res, data, msg)   // → { code: 200, msg, data }
   fail(res, msg, code)      // → { code, msg, data: null }，同时作为 HTTP 状态码
   ```
   不要 `res.json()` 手写结构，前端拦截器依赖 `code` 字段。

3. **薪酬模块返回中文列名**（SQL 里 `SELECT "期间", "公司" ...` 原样透传），前端按中文键读取。
   `modules/salary` 里的中文列名**不要重命名、不要翻译**。

4. **文件上传一律 `multer.memoryStorage()`**，内容在 `req.file.buffer`，**没有 `req.file.path`**。
   唯一还在踩坑的是 `/import-employees`（见待办）。

5. **出勤率口径**：库里 `attendance_rate` 是 0–1 小数，**接口返回前 ×100 保留 1 位小数**（0.9635 → 96.4）。

6. **在岗过滤**：人员维度统计必须 `employment_status = '在岗'` 且 `sync_status = 'matched'`。

7. **异常判定不要自己算**：迟到/旷工是否被审批抵消，用库里 `has_approval_cancel` / `valid_exception` 字段。
   取最严重类型时按 `旷工 > 缺卡 > 迟到 > 早退`。

8. **部门筛选是前缀匹配**：`department_path = $1 OR department_path LIKE $1 || '%'`。

9. **钉钉 API 只允许查近 6 个月**，超出报 `errcode 850002`，同步必须对这类错误容错跳过。

## 已知待办 / 技术债

| # | 问题 | 位置 |
|---|------|------|
| 1 | `req.file.path` 为 undefined（memoryStorage 下不存在），而 `model/export.js` 用 `fs.existsSync` 只接受路径 → `/import-employees` 实际不可用 | `routes/index.js` + `model/export.js` |
| 2 | `extractDailyRecords` 日期硬编码只适用 2025-09，应按 month 动态生成 | `modules/attendance-excel/service.js` |
| 3 | `app.js` 有**两处** `app.use(cors(...))`，第二个把 origin 收窄成只剩 `localhost:3000`，前者配置被覆盖 | [app.js](app.js) |
| 4 | 脚手架遗留，未使用可删 | `routes/users.js` |
| 5 | 6 个死文件可删 | `model/` 见上 |
| 6 | 未使用依赖可删 | `knex`、`bullmq`、`@alicloud/*` |
| 7 | `.git` 有 **35MB**，因 `uploads/` 下 9 个二进制曾入库（现已 gitignore，但历史仍在） | 仓库历史 |

## 验证（改完必须跑，不许只靠读代码判断）

```bash
# 1. 语法
node --check modules/xxx/service.js

# 2. 能否加载全部模块（会连一次库，只读 SELECT 1+1）
node -e "require('./app'); console.log('ok')"

# 3. 起服务后打接口
npm run dev
curl http://localhost:3001/attendance/board/options
```

## Git 工作流（重要）

**master 始终保持可运行，不直接提交。**

```bash
git checkout -b feat/简短描述      # 或 fix/、docs/
# ... 改代码 + 跑上面的验证 ...
git add -A && git commit -m "feat: 做了什么"
git push -u origin feat/简短描述   # 推的是分支，不是 master
# 然后在 GitHub 开 PR 合回 master
```

硬性红线：

- **不直接 push 到 master**，不走 `git push origin master`
- **不 force push**，不改写已推送的历史
- 一次任务一个分支，不要在同一分支堆不相关的改动
- 提交前确认 `git status` 里没有 `.env`、`uploads/`、`db_export/` 这类不该入库的东西

## 与 AI 协作须知

- **数据库是准生产库**：只读查询（SELECT）可自由执行；`INSERT/UPDATE/DELETE/DDL`、批量导入、`/sync` 全量同步**必须先说明再动手**。
- `.env` 里的值和真实业务数据（员工姓名、手机号、薪酬）**不要打印到对话或日志**。
- 改接口路径/参数/返回字段时，同步更新 [API_CONTRACT.md](API_CONTRACT.md)，否则前端会踩空。
