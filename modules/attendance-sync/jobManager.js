// 同步任务管理器（内存态，进程重启后丢失）
// 用于 Plan B 异步同步模式：POST /sync 立即返回 jobId，前端轮询 GET /sync/status/:jobId

const jobs = new Map();
let jobCounter = 0;

/** 创建一个新任务，返回 jobId */
function createJob(meta = {}) {
  const jobId = `sync_${Date.now()}_${++jobCounter}`;
  jobs.set(jobId, {
    id: jobId,
    status: 'pending',     // pending → running → done | error
    progress: 0,            // 0~100
    stage: '排队中',         // 当前阶段描述
    logs: [],               // [{ time, message, type }]
    result: null,           // 同步完成后的统计数据
    error: null,
    startedAt: new Date(),
    completedAt: null,
    ...meta,
  });
  return jobId;
}

/** 更新任务状态 */
function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
    if (updates.status === 'done' || updates.status === 'error') {
      job.completedAt = new Date();
    }
  }
}

/** 追加一条日志（最多保留 200 条） */
function addLog(jobId, message, type = 'info') {
  const job = jobs.get(jobId);
  if (!job) return;
  job.logs.push({
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    message,
    type,
  });
  if (job.logs.length > 200) job.logs.shift();
}

/** 获取任务信息（脱敏，不暴露内部引用） */
function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    logs: job.logs,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

/** 清理 30 分钟前完成的任务 */
function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'error') {
      if (job.completedAt && now - new Date(job.completedAt).getTime() > 30 * 60 * 1000) {
        jobs.delete(id);
      }
    }
  }
}

module.exports = { createJob, updateJob, addLog, getJob, cleanupOldJobs };
