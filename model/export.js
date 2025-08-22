const ExcelJS = require('exceljs');
const db = require('../db'); // 导入现有的数据库连接模块
const fs = require('fs'); // 添加文件系统模块用于检查文件存在性

class EmployeeImporter {
    constructor() {
        this.importLog = [];
    }


    // 添加列名映射函数
    mapColumnNames(excelColumns) {
        // Excel列名到数据库列名的映射
        const columnMapping = {
            '员工 ID（人事）': 'employee_id',
            '姓名': 'full_name',
            '性别（人事）': 'gender',
            '身份证号（人事）': 'id_number',
            '出生日期': 'birth_date',
            '年龄（人事）': 'age',
            '在岗状态（人事）': 'employment_status',
            '民族': 'ethnicity',
            '在册状态': 'registered_status',
            '公司（组织）': 'company',
            '部门描述': 'department_description',
            '部门路径': 'department_path',
            '人员分类': 'employee_category',
            '职位名称（人事）': 'position_name',
            '工种': 'job_type',
            '职级': 'job_level',
            '最高职称': 'highest_title',
            '获得时间': 'title_obtained_date',
            '职业技能等级': 'skill_level',
            '发证时间': 'skill_certificate_date',
            '用工形式': 'employment_form',
            '参加工作时间': 'work_start_date',
            '岗别（薪酬）': 'post_category',
            '岗级（薪酬）': 'post_level',
            '学校': 'school',
            '学历': 'education',
            '专业': 'major',
            '婚姻状况（人事）': 'marital_status',
            '政治面貌（人事）': 'political_status',
            '电话（人事）': 'phone',
            '家庭地址': 'home_address',
            '籍贯（人事）': 'native_place',
            '出生地点（人事）': 'birthplace',
            '列入预备党员日期（党建）': 'probationary_party_date',
            '政治面貌开始日期': 'political_start_date',
            '首次入一汽时间（人事）': 'first_join_date',
            '操作（人事）': 'last_operation',
            '操作原因（人事）': 'operation_reason',
            '人员来源': 'employee_source',
            '职务代码（组织）': 'position_code',
            '职种（组织）': 'job_category',
            '职序（组织）': 'job_sequence',
            '职族': 'job_family',
            '离职原因': 'resignation_reason',
            '调动明细原因': 'transfer_reason',
            '离职地城市': 'resignation_city',
            // 添加更多映射...
        };

        return excelColumns.map(col => {
            // 去除可能的空格和特殊字符
            const cleanCol = col.trim();
            return columnMapping[cleanCol] || cleanCol;
        });
    }
    /**
     * 从Excel导入员工数据
     * @param {string} filePath Excel文件路径
     * @param {string|number} sheetName 工作表名称或索引，默认为第一个工作表
     * @returns {Promise<{success: number, errors: Array, total: number}>} 导入结果
     */
    async importEmployeesFromExcel(filePath, sheetName = 0) {
        try {
            console.log(`开始读取Excel文件: ${filePath}`);

            // 检查文件是否存在
            if (!fs.existsSync(filePath)) {
                throw new Error(`文件不存在: ${filePath}`);
            }

            // 读取Excel文件
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(filePath);

            // 检查工作簿是否有工作表
            if (workbook.worksheets.length === 0) {
                throw new Error('Excel文件中没有工作表');
            }

            // 获取工作表
            let worksheet;
            if (typeof sheetName === 'number') {
                // 使用数字索引获取工作表
                if (sheetName < 0 || sheetName >= workbook.worksheets.length) {
                    throw new Error(`工作表索引 ${sheetName} 超出范围。文件中有 ${workbook.worksheets.length} 个工作表`);
                }
                worksheet = workbook.worksheets[sheetName];
            } else {
                // 使用名称获取工作表
                worksheet = workbook.getWorksheet(sheetName);
                if (!worksheet) {
                    throw new Error(`找不到名称为 "${sheetName}" 的工作表`);
                }
            }

            // 获取表头
            const headerRow = worksheet.getRow(1);
            const excelHeaders = []
            headerRow.eachCell((cell, colNumber) => {
                excelHeaders[colNumber] = cell.value;
            });

            // 映射列名到数据库列名
            const dbHeaders = this.mapColumnNames(excelHeaders.filter(Boolean));
            console.log('Excel列名:', excelHeaders.filter(Boolean));
            console.log('映射后的数据库列名:', dbHeaders);


            // 检查数据库表结构
            const tableStructure = await this.checkTableStructure();
            const dbColumns = tableStructure.map(col => col.column_name);

            // 验证映射后的列名是否存在于数据库中
            const missingColumns = dbHeaders.filter(header =>
                header && !dbColumns.includes(header)
            );
            if (missingColumns.length > 0) {
                console.error('以下列在数据库中不存在:', missingColumns);
                throw new Error(`数据库表中缺少以下列: ${missingColumns.join(', ')}`);
            }
            // 准备批量插入数据
            const employees = [];

            worksheet.eachRow((row, rowIndex) => {
                if (rowIndex === 1) return; // 跳过表头行

                const employee = {};

                // 使用映射后的列名
                row.eachCell((cell, colNumber) => {
                    const excelHeader = excelHeaders[colNumber];
                    if (excelHeader) {
                        const dbHeader = this.mapColumnNames([excelHeader])[0];
                        employee[dbHeader] = cell.value;
                    }
                });

                // 添加时间戳
                employee.created_time = new Date();
                employee.modified_time = new Date();

                employees.push(employee);
            });

            console.log(`成功读取 ${employees.length} 条员工记录`);

            // 如果没有数据，直接返回
            if (employees.length === 0) {
                return {
                    success: 0,
                    errors: [{ error: "Excel文件中没有数据" }],
                    total: 0
                };
            }

            // 批量插入数据库
            const batchSize = 100;
            let successCount = 0;
            const errors = [];

            for (let i = 0; i < employees.length; i += batchSize) {
                const batch = employees.slice(i, i + batchSize);

                try {
                    // 使用现有的db模块进行批量插入
                    await this.batchInsertEmployees(batch);

                    successCount += batch.length;
                    console.log(`已插入 ${successCount}/${employees.length} 条记录`);

                    // 记录成功导入
                    this.importLog.push({
                        timestamp: new Date(),
                        type: 'import',
                        records: batch.length,
                        status: 'success'
                    });
                } catch (error) {
                    console.error(`批量插入失败 (记录 ${i}-${i + batch.length - 1}):`, error.message);
                    errors.push({
                        range: `${i}-${i + batch.length - 1}`,
                        error: error.message
                    });

                    // 记录失败导入
                    this.importLog.push({
                        timestamp: new Date(),
                        type: 'import',
                        records: batch.length,
                        status: 'error',
                        error: error.message
                    });

                    // 如果批量插入失败，尝试逐条插入
                    for (let j = 0; j < batch.length; j++) {
                        try {
                            await this.insertEmployee(batch[j]);
                            successCount++;
                        } catch (singleError) {
                            errors.push({
                                record: i + j,
                                employee_id: batch[j].employee_id,
                                error: singleError.message
                            });
                        }
                    }
                }
            }

            return {
                success: successCount,
                errors: errors,
                total: employees.length
            };

        } catch (error) {
            console.error('导入员工数据失败:', error);

            // 记录错误
            this.importLog.push({
                timestamp: new Date(),
                type: 'import',
                status: 'error',
                error: error.message
            });

            throw error;
        }
    }

    /**
     * 获取Excel文件中的工作表列表
     * @param {string} filePath Excel文件路径
     * @returns {Promise<Array>} 工作表名称列表
     */
    async getWorksheetNames(filePath) {
        try {
            // 检查文件是否存在
            if (!fs.existsSync(filePath)) {
                throw new Error(`文件不存在: ${filePath}`);
            }

            // 读取Excel文件
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(filePath);

            // 返回工作表名称列表
            return workbook.worksheets.map((ws, index) => ({
                index: index,
                name: ws.name
            }));
        } catch (error) {
            console.error('获取工作表列表失败:', error);
            throw error;
        }
    }

    /**
     * 批量插入员工数据
     * @param {Array} employees 员工数据数组
     */
    async batchInsertEmployees(employees) {
        if (employees.length === 0) return;

        // 构建插入语句
        const columns = Object.keys(employees[0]);

        // 确保列名使用双引号，避免关键字冲突
        const quotedColumns = columns.map(col => `"${col}"`);

        // 构建占位符
        const placeholders = employees.map((_, index) =>
            `(${columns.map((_, colIndex) => `$${index * columns.length + colIndex + 1}`).join(', ')})`
        ).join(', ');

        // 提取值
        const values = employees.flatMap(emp =>
            columns.map(col => emp[col])
        );

        // 构建ON CONFLICT子句
        const setClause = columns
            .filter(col => col !== 'employee_id') // 排除主键
            .map(col => `"${col}" = EXCLUDED."${col}"`)
            .join(', ');

        // 构建完整的SQL语句
        const query = `
        INSERT INTO employees (${quotedColumns.join(', ')})
        VALUES ${placeholders}
        ON CONFLICT (employee_id) 
        DO UPDATE SET ${setClause}
    `;

        console.log('执行的SQL语句:', query); // 调试用
        console.log('参数数量:', values.length); // 调试用

        await db.query(query, values);
    }

    /**
     * 插入单个员工数据
     * @param {Object} employee 员工数据
     */
    async insertEmployee(employee) {
        const columns = Object.keys(employee);

        // 确保列名使用双引号
        const quotedColumns = columns.map(col => `"${col}"`);
        const values = columns.map(col => employee[col]);
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');

        // 构建ON CONFLICT子句
        const setClause = columns
            .filter(col => col !== 'employee_id') // 排除主键
            .map(col => `"${col}" = EXCLUDED."${col}"`)
            .join(', ');

        // 构建完整的SQL语句
        const query = `
        INSERT INTO employees (${quotedColumns.join(', ')})
        VALUES (${placeholders})
        ON CONFLICT ("employee_id") 
        DO UPDATE SET ${setClause}
    `;

        await db.query(query, values);
    }

    /**
     * 获取导入状态
     */
    async getImportStatus() {
        try {
            // 获取员工数量
            const result = await db.query('SELECT COUNT(*) as count FROM employees');
            const employeeCount = result.rows[0]?.count || 0;

            // 获取最近导入记录
            const recentImports = this.importLog
                .filter(log => log.type === 'import')
                .slice(-10); // 最近10条记录

            return {
                total_employees: employeeCount,
                recent_imports: recentImports,
                status: 'active'
            };
        } catch (error) {
            console.error('获取导入状态失败:', error);
            throw error;
        }
    }

    // 添加一个方法来检查数据库表结构
    async checkTableStructure() {
        try {
            // 查询表结构
            const result = await db.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'employees'
            ORDER BY ordinal_position
        `);

            console.log('数据库表结构:');
            result.rows.forEach(row => {
                console.log(`- ${row.column_name}: ${row.data_type}`);
            });

            return result.rows;
        } catch (error) {
            console.error('检查表结构失败:', error);
            throw error;
        }
    }
}

// 创建单例实例
const importer = new EmployeeImporter();

// 导出方法
module.exports = {
    importEmployeesFromExcel: (filePath, sheetName) => importer.importEmployeesFromExcel(filePath, sheetName),
    getWorksheetNames: (filePath) => importer.getWorksheetNames(filePath),
    getImportStatus: () => importer.getImportStatus()
}