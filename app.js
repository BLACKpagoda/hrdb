var createError = require('http-errors');
var express = require('express');
const cors = require('cors');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const db = require('./db');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));


// 详细CORS配置
const corsOptions = {
  origin: function (origin, callback) {
    // 允许的域名列表
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001'
    ];
    
    // 如果是开发环境或允许的域名，允许请求
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('不允许的跨域请求'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200 // 一些旧浏览器（IE11, various SmartTVs）choke on 204
};

// 应用CORS中间件
// 注：此处曾同时注册两个 cors()，后一个把 origin 收窄为仅 localhost:3000，
// 覆盖了上面的白名单（导致 127.0.0.1:3000 / localhost:3001 等来源全部被拒）。
// 已删除重复的那一个，只保留白名单版本。
app.use(cors(corsOptions));

app.use('/', indexRouter);
app.use('/users', usersRouter);

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  // CORS错误处理
  if (err.message === '不允许的跨域请求') {
    return res.status(403).json({
      success: false,
      error: '跨域请求被拒绝'
    });
  }
  
  res.status(500).json({
    success: false,
    error: err.message
  });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '接口不存在'
  });
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});
// 测试数据库连接
db.query('SELECT 1+1 AS result')
  .then(() => console.log('数据库连接成功'))
  .catch(err => console.error('数据库连接失败:', err));
// 注意：实际监听由 bin/www 完成，此处不再调用 app.listen 避免端口冲突

module.exports = app;
