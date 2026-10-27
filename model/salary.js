const XLSX = require('xlsx');
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

// 核心配置：完整映射salary_data表的174个字段
const CONFIG = {
  targetTable: 'salary_data', // 目标表名
  primaryKeys: ['员工ID', '期间'], 
  // Excel表头到数据库字段的完整映射（与建表字段一一对应）
  headerMap: {
    // 1. 基本信息类
    '序号': '序号',
    '员工ID': '员工ID',
    '身份证号': '身份证号',
    '职工证号': '职工证号',
    '银行帐号': '银行帐号',
    '姓名': '姓名',
    '性别': '性别',
    '出生日期': '出生日期',
    '参加工作时间': '参加工作时间',

    // 2. 组织与岗位信息类
    '薪资组': '薪资组',
    '公司': '公司',
    '五级部门': '五级部门',
    '四级部门': '四级部门',
    '三级部门': '三级部门',
    '二级部门': '二级部门',
    '一级部门': '一级部门',
    '薪资计划': '薪资计划',
    '岗': '岗',
    '级': '级',
    '期间': '期间',
    '人员分类': '人员分类',
    '人员类别标识': '人员类别标识',
    '三类人员': '三类人员',
    '岗位编码': '岗位编码',
    '岗位类别': '岗位类别',
    '岗位类别描述': '岗位类别描述',
    '职称': '职称',
    '职称描述': '职称描述',
    '职称级别': '职称级别',
    '职称级别描述': '职称级别描述',
    '工种代码': '工种代码',
    '工种代码描述': '工种代码描述',
    '职级': '职级',
    '职级描述': '职级描述',
    '外地标识': '外地标识',
    '工资制度': '工资制度',
    '职务代码': '职务代码',
    '职务代码描述': '职务代码描述',
    '职族': '职族',
    '职族描述': '职族描述',
    '职种': '职种',
    '职种描述': '职种描述',
    '职序': '职序',
    '职序描述': '职序描述',
    '工种分类': '工种分类',
    '工种分类描述': '工种分类描述',

    // 3. 基本工资构成类
    '岗位基础': '岗位基础',
    '岗位基础补充': '岗位基础补充',
    '年功工资': '年功工资',
    '积累工资': '积累工资',
    '能力工资': '能力工资',
    '技能工资': '技能工资',
    '岗位工资': '岗位工资',
    '浮动工资': '浮动工资',
    '工龄工资': '工龄工资',
    '应计工资': '应计工资',
    '不含2024年年终奖应计': '不含2024年年终奖应计',
    '不含2025年年终奖应计': '不含2025年年终奖应计',
    '劳务费合计': '劳务费合计',
    '上年月平均': '上年月平均',
    '粮煤补贴': '粮煤补贴',
    '生活补贴': '生活补贴',
    '工人技师': '工人技师',
    '教护龄': '教护龄',

    // 4. 奖金部分类
    '效益贡献': '效益贡献',
    '效益奖': '效益奖',
    '任期激励': '任期激励',
    '延期支付兑现部分': '延期支付兑现部分',
    '奖金': '奖金',
    '年终奖': '年终奖',
    '年终奖超临界': '年终奖超临界',
    '其他奖': '其他奖',
    '单项奖1': '单项奖1',
    '单项奖2': '单项奖2',
    '单项奖3': '单项奖3',
    '项目工资': '项目工资',
    '专家项目工资预留': '专家项目工资预留',
    '项目工资预留兑现': '项目工资预留兑现',
    '年终绩效奖': '年终绩效奖',
    '年终超额奖': '年终超额奖',
    '年终共创共享奖': '年终共创共享奖',
    '公司单项奖': '公司单项奖',
    '年终奖小计': '年终奖小计',

    // 5. 补贴津贴类
    '职务补贴': '职务补贴',
    '通讯补贴': '通讯补贴',
    '加班费': '加班费',
    '延时加班': '延时加班',
    '休息日加班': '休息日加班',
    '休假日加班': '休假日加班',
    '值班费': '值班费',
    '夜班津贴': '夜班津贴',
    '物价补贴': '物价补贴',
    '特殊津贴': '特殊津贴',
    '工伤补贴': '工伤补贴',
    '提租补贴': '提租补贴',
    '回民补贴工资': '回民补贴工资',
    '其他补贴1': '其他补贴1',
    '其他补贴2': '其他补贴2',
    '班车费': '班车费',
    '补工资': '补工资',
    '其他补贴3': '其他补贴3',
    '休假补偿': '休假补偿',
    '工长班长津贴': '工长班长津贴',
    '护理费': '护理费',
    '其他': '其他',
    '节假日补贴': '节假日补贴',
    '安家费': '安家费',
    '月奖预留': '月奖预留',
    '独生子女费': '独生子女费',
    '生育津贴': '生育津贴',
    '回民补贴福利': '回民补贴福利',
    '工伤津贴': '工伤津贴',
    '保健费': '保健费',
    '防暑降温费': '防暑降温费',
    '高温津贴': '高温津贴',
    '单身补贴': '单身补贴',
    '车辆补贴': '车辆补贴',
    '采暖费补贴': '采暖费补贴',

    // 6. 扣除项类
    '扣孕哺': '扣孕哺',
    '扣劳保': '扣劳保',
    '扣事假': '扣事假',
    '扣迟到早退': '扣迟到早退',
    '扣旷工': '扣旷工',
    '扣病假': '扣病假',
    '扣生育': '扣生育',
    '补扣工资': '补扣工资',
    '扣工资': '扣工资',
    '扣房费': '扣房费',
    '处罚': '处罚',
    '欠款': '欠款',
    '管理费': '管理费',
    '公积金': '公积金',
    '养老保险': '养老保险',
    '失业保险': '失业保险',
    '医疗保险': '医疗保险',
    '个人年金': '个人年金',
    '大病医疗': '大病医疗',
    '扣款1': '扣款1',
    '扣款3': '扣款3',
    '其他应计税项目': '其他应计税项目',
    '年终奖纳税调整额': '年终奖纳税调整额',
    '工会会费': '工会会费',
    '卫生费': '卫生费',
    '所得税': '所得税',
    '年终奖税': '年终奖税',
    '税后调整': '税后调整',
    '退个税': '退个税',
    '扣党费': '扣党费',

    // 7. 计算参数类
    '奖金系数1': '奖金系数1',
    '奖金系数2': '奖金系数2',
    '是否残疾': '是否残疾',
    '退休百分比': '退休百分比',
    '83号文': '83号文',
    '29号文': '29号文',
    '9号文': '9号文',
    '应计百分比': '应计百分比',
    '大病医疗企业': '大病医疗企业',
    '公积金企业': '公积金企业',
    '公积金基数': '公积金基数',
    '公积金封比': '公积金封比',
    '公积金封基': '公积金封基',
    '公积金超限': '公积金超限',
    '年金超限': '年金超限',
    '年金企业': '年金企业',
    '年金基数': '年金基数',
    '累计子女教育': '累计子女教育',
    '累计应纳税所得额': '累计应纳税所得额',
    '累计继续教育': '累计继续教育',
    '累计住房贷款利息': '累计住房贷款利息',
    '累计住房租金': '累计住房租金',
    '累计赡养老人': '累计赡养老人',
    '累计婴幼儿照护': '累计婴幼儿照护',
    '个人养老金扣除': '个人养老金扣除',
    '人员类别': '人员类别'
  }
};

/**
 * 转换Excel值为数据库兼容格式
 * @param {*} value Excel单元格值
 * @param {string} dbField 数据库字段名
 * @returns 转换后的值
 */
const transformValue = (value, dbField) => {
  // 空值处理
  if (value === null || value === undefined || value === '' || String(value).toLowerCase() === 'nan') {
    return null;
  }

  // 日期字段处理（适配Excel日期格式）
  const dateFields = ['出生日期', '参加工作时间', '期间'];
  if (dateFields.includes(dbField)) {
    if (typeof value === 'number') { // Excel日期是数字格式
      const date = XLSX.SSF.parse_date_code(value);
      return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    }
    const date = new Date(value);
    return date.toString() === 'Invalid Date' ? value : date.toISOString().split('T')[0];
  }

  // 数字字段处理（金额、编号等）
  const numberFields = [
    '序号', '员工ID', '五级部门', '四级部门', '三级部门', '二级部门', '一级部门', '级',
    '岗位基础', '岗位基础补充', '年功工资', '积累工资', '能力工资', '技能工资', '岗位工资',
    '浮动工资', '工龄工资', '应计工资', '不含2024年年终奖应计', '劳务费合计', '上年月平均',
    '粮煤补贴', '生活补贴', '工人技师', '教护龄', '效益贡献', '效益奖', '任期激励',
    '延期支付兑现部分', '奖金', '年终奖', '年终奖超临界', '其他奖', '单项奖1', '单项奖2',
    '单项奖3', '项目工资', '专家项目工资预留', '项目工资预留兑现', '年终绩效奖', '年终超额奖',
    '年终共创共享奖', '公司单项奖', '年终奖小计', '职务补贴', '通讯补贴', '加班费', '延时加班',
    '休息日加班', '休假日加班', '值班费', '夜班津贴', '物价补贴', '特殊津贴', '工伤补贴',
    '提租补贴', '回民补贴工资', '其他补贴1', '其他补贴2', '班车费', '补工资', '其他补贴3',
    '休假补偿', '工长班长津贴', '护理费', '其他', '节假日补贴', '安家费', '月奖预留',
    '独生子女费', '生育津贴', '回民补贴福利', '工伤津贴', '保健费', '防暑降温费', '高温津贴',
    '单身补贴', '车辆补贴', '采暖费补贴', '扣孕哺', '扣劳保', '扣事假', '扣迟到早退', '扣旷工',
    '扣病假', '扣生育', '补扣工资', '扣工资', '扣房费', '处罚', '欠款', '管理费', '公积金',
    '养老保险', '失业保险', '医疗保险', '个人年金', '大病医疗', '扣款1', '扣款3', '其他应计税项目',
    '年终奖纳税调整额', '工会会费', '卫生费', '所得税', '年终奖税', '税后调整', '退个税', '扣党费',
    '奖金系数1', '奖金系数2', '退休百分比', '83号文', '29号文', '9号文', '应计百分比',
    '大病医疗企业', '公积金企业', '公积金基数', '公积金封比', '公积金封基', '公积金超限',
    '年金超限', '年金企业', '年金基数', '累计子女教育', '累计应纳税所得额', '累计继续教育',
    '累计住房贷款利息', '累计住房租金', '累计赡养老人', '累计婴幼儿照护', '个人养老金扣除'
  ];
  if (numberFields.includes(dbField)) {
    const num = Number(value);
    return isNaN(num) ? value : num; // 无法转数字则保留原始值
  }

  // 字符串字段去空格
  return String(value).trim();
};

/**
 * 分批查询已存在的主键（解决大量数据查询参数超限问题）
 * @param {Array} allKeys 所有待检查的主键组合
 * @param {string} batchId 批次ID
 * @returns {Set} 已存在的主键集合
 */
const getExistKeys = async (allKeys, batchId) => {
  const KEY_BATCH_SIZE = 1000; // 每批查询1000个主键（可调整）
  const existKeys = new Set();

  // 分批处理所有主键
  for (let i = 0; i < allKeys.length; i += KEY_BATCH_SIZE) {
    const keyBatch = allKeys.slice(i, i + KEY_BATCH_SIZE); // 当前批次的主键
    console.log(`[${batchId}] 主键查询批次 ${Math.floor(i/KEY_BATCH_SIZE) + 1}，条数：${keyBatch.length}`);

    // 生成当前批次的查询SQL
    const placeholders = keyBatch.map((_, idx) => `$${idx + 1}`).join(','); // 占位符：$1,$2,...,$1000
    const pkConcat = CONFIG.primaryKeys.map(k => `COALESCE("${k}"::TEXT, '')`).join('||\'|\'||'); // 复合主键拼接逻辑
    const query = `
      SELECT ${pkConcat} AS "exist_key" 
      FROM "${CONFIG.targetTable}" 
      WHERE ${pkConcat} IN (${placeholders})
    `;

    try {
      const { rows } = await db.query(query, keyBatch);
      // 将查询到的已存在主键添加到集合
      rows.forEach(row => existKeys.add(row.exist_key));
    } catch (err) {
      throw new Error(`主键查询批次 ${Math.floor(i/KEY_BATCH_SIZE) + 1} 失败：${err.message}`);
    }
  }

  return existKeys;
};

/**
 * 批量插入数据（带事务和错误定位）
 * @param {Array} data 待插入数据
 * @param {string} batchId 批次ID
 * @returns 导入结果
 */
const batchInsert = async (data, batchId) => {
  if (!data.length) {
    return { success: true, newCount: 0, existCount: 0, message: '无有效数据' };
  }

  let newData = []; 
  // 生成复合主键（员工ID|期间）
  const getPrimaryKey = (row) => {
    CONFIG.primaryKeys.forEach(key => {
      if (row[key] === undefined || row[key] === null || row[key] === '') {
        throw new Error(`数据行缺少主键字段：${key}（Excel行号：${row.__rowIndex}）`);
      }
    });

    // 统一期间格式（如"2025年01月"→"2025-01"）
    const formatPeriod = (period) => {
      const str = String(period).trim();
      if (str.includes('年') && str.includes('月')) {
        const [year, month] = str.split('年');
        return `${year}-${month.replace('月', '').padStart(2, '0')}`;
      }
      if (str.includes('/')) {
        const [year, month] = str.split('/');
        return `${year}-${month.padStart(2, '0')}`;
      }
      return str;
    };

    const employeeId = String(row['员工ID']).trim();
    const period = formatPeriod(row['期间']);
    return `${employeeId}|${period}`;
  };

  try {
    // 1. 生成所有待检查的主键，并分批查询已存在的主键
    const allKeys = data.map(row => getPrimaryKey(row));
    const existKeys = await getExistKeys(allKeys, batchId); // 调用已定义的getExistKeys

    // 2. 过滤新数据（排除已存在的记录）
    newData = data.filter(row => !existKeys.has(getPrimaryKey(row)));
    const existCount = data.length - newData.length;

    if (newData.length === 0) {
      return { success: true, newCount: 0, existCount, message: '所有数据已存在' };
    }

    // 3. 分批插入新数据（每批50条）
    const BATCH_SIZE = 50; 
    let totalNewCount = 0;
    await db.query('BEGIN');

    for (let i = 0; i < newData.length; i += BATCH_SIZE) {
      const batch = newData.slice(i, i + BATCH_SIZE);
      console.log(`[${batchId}] 插入批次 ${Math.floor(i/BATCH_SIZE) + 1}，条数：${batch.length}`);

      // 统一期间格式（存入数据库时保持一致）
      const formatPeriod = (period) => {
        const str = String(period).trim();
        if (str.includes('年') && str.includes('月')) {
          const [year, month] = str.split('年');
          return `${year}-${month.replace('月', '').padStart(2, '0')}`;
        }
        if (str.includes('/')) {
          const [year, month] = str.split('/');
          return `${year}-${month.padStart(2, '0')}`;
        }
        return str;
      };

      // 生成当前批次的插入SQL
      const columns = Object.keys(batch[0]).filter(k => k !== '__rowIndex').map(col => `"${col}"`).join(',');
      const values = [];
      const valueParts = batch.map((row, rowIndex) => {
        return Object.keys(row).filter(k => k !== '__rowIndex').map((col, colIndex) => {
          const paramIndex = rowIndex * (Object.keys(row).length - 1) + colIndex + 1;
          // 期间字段单独处理格式
          const value = col === '期间' ? formatPeriod(row[col]) : transformValue(row[col], col);
          values.push(value);
          return `$${paramIndex}`;
        }).join(',');
      }).map(parts => `(${parts})`);

      const insertQuery = `
        INSERT INTO "${CONFIG.targetTable}" (${columns}) 
        VALUES ${valueParts.join(',')}
      `;

      const res = await db.query(insertQuery, values);
      totalNewCount += res.rowCount;
    }

    await db.query('COMMIT');

    return {
      success: true,
      newCount: totalNewCount,
      existCount,
      message: `导入成功：共${newData.length}条新数据，分${Math.ceil(newData.length/BATCH_SIZE)}批插入，新增${totalNewCount}条`
    };

  } catch (err) {
    await db.query('ROLLBACK');
    const errorMsg = `
      批次[${batchId}]导入失败！
      错误原因：${err.message}
      错误代码：${err.code || '未知'}
      总数据量：${data.length}条
    `.replace(/\n\s+/g, ' ').trim();
    console.error(`[${batchId}] 错误详情:`, err);
    return { success: false, message: errorMsg };
  }
};

/**
 * 解析Excel并导入到salary_data表
 * @param {Buffer} fileBuffer Excel文件缓冲
 * @param {string} fileName 文件名
 * @returns 导入结果
 */
const importSalaryData = async (fileBuffer, fileName) => {
  const batchId = uuidv4().slice(0, 8); // 8位批次ID，用于追踪
  try {
    if (!fileBuffer) throw new Error('文件为空');

    // 解析Excel
    const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0]; // 处理第一个工作表
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      return { [sheetName]: { success: false, message: `工作表[${sheetName}]为空` } };
    }

    // 转换为JSON（表头+数据行）
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false });
    if (jsonData.length < 2) { // 至少需要表头+1行数据
      return { [sheetName]: { success: false, message: '至少需要1行数据（含表头）' } };
    }

    // 解析表头和数据行
    const [headerRow, ...dataRows] = jsonData;
    const headers = headerRow.map(h => String(h).trim());
    console.log(`[${batchId}] 解析表头:`, headers);

    // 映射数据行（包含Excel原始行号，方便定位错误）
    const data = dataRows.map((row, rowIndex) => {
      const rowData = { __rowIndex: rowIndex + 2 }; // 行号=表头行(1)+数据行索引+1
      headers.forEach((header, colIndex) => {
        const dbField = CONFIG.headerMap[header];
        if (dbField) rowData[dbField] = row[colIndex]; // 只保留映射成功的字段
      });
      return rowData;
    }).filter(row => Object.keys(row).length > 1); // 过滤空行

    console.log(`[${batchId}] 有效数据: ${data.length}条`);
    const result = await batchInsert(data, batchId);
    return { [sheetName]: result };

  } catch (err) {
    const errorMsg = `批次[${batchId}]解析失败：${err.message}`;
    console.error(errorMsg, err);
    return { error: errorMsg };
  }
};

module.exports = { importSalaryData };