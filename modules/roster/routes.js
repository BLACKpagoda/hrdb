// 花名册管理 - 路由层
// 接口：
//   POST /roster/import   — 上传花名册 Excel（multipart: file + month=YYYY-MM）
//   GET  /roster/stats    — 查看各月花名册概况
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { success, fail } = require('../../common/response');
const rosterController = require('./controller');

const storage = multer.memoryStorage();
const upload = multer({ storage });

router.post('/roster/import', upload.single('file'), async (req, res) => {
  try {
    await rosterController.importRoster(req, res);
  } catch (error) {
    console.error('[roster] 导入失败:', error);
    fail(res, error.message, 500);
  }
});

router.get('/roster/stats', async (req, res) => {
  try {
    await rosterController.getRosterStats(req, res);
  } catch (error) {
    fail(res, error.message, 500);
  }
});

module.exports = router;
