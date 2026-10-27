// 统一响应格式：{ code, msg, data }
// 与前端 src/utils/request.js 响应拦截器对齐：code === 200 时返回 data，否则 reject msg
// 同时兼容前端组件中 `response.data.data` 的访问方式（始终保留 data 字段）

const success = (res, data = null, msg = '操作成功') => {
  return res.json({ code: 200, msg, data });
};

const fail = (res, msg = '操作失败', code = 500) => {
  // 兼容外部传入非标准 HTTP 状态码（如业务自定义错误码），统一兜底到 500
  const httpCode = (code >= 100 && code < 600) ? code : 500;
  return res.status(httpCode).json({ code, msg, data: null });
};

module.exports = { success, fail };
