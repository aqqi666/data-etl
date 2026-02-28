const path = require('path');
const express = require('express');
const cors = require('cors');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

let mysql2;
try {
  mysql2 = require('mysql2/promise');
} catch (_) {}

function looksLikeConnectionString(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (/^mysql:\/\//i.test(s) || (/^[a-z]+:\/\//i.test(s) && s.includes('@') && /:\d+/.test(s))) return true;
  return /mysql\s+.+-h\s+/i.test(s) && (/-u\s/i.test(s) || /-u'/.test(s)) && (/-p\s/i.test(s) || /-p\S/.test(s));
}

function parseConnectionStringUrl(str) {
  const s = str.trim();
  try {
    const u = new URL(s);
    const type = (u.protocol || '').replace(':', '').toLowerCase();
    if (!type.includes('mysql')) return null;
    return {
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      database: (u.pathname || '/').replace(/^\//, '').replace(/\/$/, '') || null,
    };
  } catch (e) {
    return null;
  }
}

function parseMysqlCliConnectionString(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (!/mysql\s+/i.test(s)) return null;
  const hostMatch = s.match(/-h\s+(\S+)/i);
  const portMatch = s.match(/-P\s+(\d+)/i);
  const userMatch = s.match(/-u\s*'([^']*)'|-u\s*(\S+)/i);
  const passwordMatch = s.match(/-p\s*(\S+)/i) || s.match(/-p(\S+)/i);
  if (!hostMatch || !userMatch) return null;
  const host = hostMatch[1].trim();
  const port = portMatch ? Number(portMatch[1]) : 3306;
  const user = (userMatch[1] || userMatch[2] || '').trim();
  const password = (passwordMatch && (passwordMatch[1] || passwordMatch[2])) ? (passwordMatch[1] || passwordMatch[2]).trim() : '';
  const dbMatch = s.match(/-D\s+(\S+)/i);
  const database = dbMatch ? dbMatch[1].trim() : null;
  return { host, port, user, password, database };
}

function getConnectionConfig(connectionString) {
  if (!connectionString) return null;
  const urlParsed = parseConnectionStringUrl(connectionString);
  if (urlParsed) return urlParsed;
  return parseMysqlCliConnectionString(connectionString);
}

async function testConnection(connectionString) {
  const parsed = getConnectionConfig(connectionString);
  if (!parsed) {
    return { ok: false, message: '连接串格式无法解析' };
  }
  const { host, port, user, password, database } = parsed;
  if (!mysql2) return { ok: false, message: '服务端未安装 mysql2 驱动' };
  try {
    const conn = await Promise.race([
      mysql2.createConnection({ host, port, user, password, database: database || undefined, connectTimeout: 8000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 8000)),
    ]);
    await conn.ping();
    conn.destroy();
    return { ok: true, message: '连接成功' };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

function safeIdentifier(name) {
  if (!name || typeof name !== 'string') return null;
  const s = name.trim();
  return /^[a-zA-Z0-9_]+$/.test(s) ? s : null;
}

/** 从 CREATE TABLE DDL 中解析出目标库名（若为 db.table 形式）。返回库名或 null（表未指定库则用当前连接库） */
function extractDatabaseFromCreateTable(ddl) {
  const s = String(ddl).trim();
  const afterCreate = s.replace(/^\s*CREATE\s+TABLE\s+/i, '').trim();
  // 匹配 `db`.`tbl` 或 db.tbl 或 `db`.tbl 或 db.`tbl`，取第一个标识符为库名
  const m = afterCreate.match(/^(`[^`]+`|\w+)\s*\.\s*(`[^`]+`|\w+)/);
  if (!m) return null;
  const db = (m[1].startsWith('`') ? m[1].slice(1, -1) : m[1]).trim();
  return safeIdentifier(db) ? db : null;
}

async function getMysqlConnection(connectionString) {
  const parsed = getConnectionConfig(connectionString);
  if (!parsed) throw new Error('连接串格式无法解析');
  if (!mysql2) throw new Error('服务端未安装 mysql2 驱动');
  const { host, port, user, password, database } = parsed;
  return Promise.race([
    mysql2.createConnection({ host, port, user, password, database: database || undefined, connectTimeout: 10000 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 10000)),
  ]);
}

const VALID_INTENTS = ['createDatabase','listDatabases','listTables','describeTable','previewData','createTable','executeSQL','analyzeNulls'];

/** 从 SQL 中解析 FROM / JOIN 涉及的表，返回 { database, table } 列表（去重、合法标识符） */
function extractTableRefsFromSql(sql) {
  if (!sql || typeof sql !== 'string') return [];
  const refs = [];
  const re = /(?:FROM|JOIN)\s+(?:`([^`]+)`\.`([^`]+)`|([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)|`([^`]+)`|([a-zA-Z0-9_]+))/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    let database = null;
    let table = null;
    if (m[1] != null && m[2] != null) {
      database = m[1].trim();
      table = m[2].trim();
    } else if (m[3] != null && m[4] != null) {
      database = m[3].trim();
      table = m[4].trim();
    } else if (m[5] != null) {
      table = m[5].trim();
    } else if (m[6] != null) {
      table = m[6].trim();
    }
    if (table && /^[a-zA-Z0-9_]+$/.test(table) && (!database || /^[a-zA-Z0-9_]+$/.test(database))) {
      const key = (database ? database + '.' : '') + table;
      if (!refs.some((r) => (r.database || '') + '.' + r.table === key)) refs.push({ database: database || null, table });
    }
  }
  return refs;
}

/** 将行数据格式化为 Markdown 表格（用于注入给模型，模型必须用表格展示、禁止用 JSON） */
function rowsToMarkdownTable(rows, columns) {
  if (!rows || rows.length === 0) return '';
  const cols = columns || (Array.isArray(rows[0]) ? null : Object.keys(rows[0]));
  if (!cols || cols.length === 0) return '';
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const body = rows.map((r) => {
    const cells = Array.isArray(r) ? r : cols.map((c) => (r[c] == null ? '' : String(r[c])));
    return '| ' + cells.join(' | ') + ' |';
  }).join('\n');
  return header + '\n' + sep + '\n' + body;
}

/** 在用户提供的 MySQL 连接上真实执行库/表操作，所有 SQL 均为标准 MySQL 语法 */
async function runDatabaseOperation(connectionString, intent, params = {}) {
  let conn;
  try {
    conn = await getMysqlConnection(connectionString);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  const parsed = getConnectionConfig(connectionString);
  const database = parsed?.database || null;
  const esc = (n) => `\`${String(n).replace(/`/g, '``')}\``;

  try {
    if (intent === 'listDatabases') {
      const [rows] = await conn.query('SHOW DATABASES');
      const dbList = (rows || []).map((r) => r['Database'] || Object.values(r)[0]).filter(Boolean);
      const withCounts = [];
      for (const db of dbList) {
        if (!safeIdentifier(db)) continue;
        const [tblRows] = await conn.query(`SHOW TABLES FROM ${esc(db)}`);
        withCounts.push({ database: db, tableCount: Array.isArray(tblRows) ? tblRows.length : 0 });
      }
      return { ok: true, data: { databases: withCounts, totalDatabases: withCounts.length } };
    }

    if (intent === 'listTables') {
      const db = (params.database && safeIdentifier(params.database)) || (database && safeIdentifier(database));
      const sql = db ? `SHOW TABLES FROM ${esc(db)}` : 'SHOW TABLES';
      const [rows] = await conn.query(sql);
      const tables = (rows || []).map((r) => Object.values(r)[0]).filter(Boolean);
      return { ok: true, data: { database: db || database || '(当前库)', tables } };
    }

    if (intent === 'createDatabase' && params.name) {
      const name = safeIdentifier(params.name);
      if (!name) return { ok: false, error: '无效的数据库名（仅允许字母、数字、下划线）' };
      await conn.query(`CREATE DATABASE IF NOT EXISTS ${esc(name)}`);
      return { ok: true, data: { message: `数据库 ${name} 已创建` } };
    }

    if (intent === 'describeTable' && params.table) {
      const db = (params.database && safeIdentifier(params.database)) || (database && safeIdentifier(database));
      const tbl = safeIdentifier(params.table);
      if (!tbl) return { ok: false, error: '无效的表名' };
      const fullName = db ? `${esc(db)}.${esc(tbl)}` : esc(tbl);
      const [cols] = await conn.query(`DESCRIBE ${fullName}`);
      return { ok: true, data: { database: db || database, table: tbl, columns: cols } };
    }

    if (intent === 'previewData' && params.table) {
      const db = (params.database && safeIdentifier(params.database)) || (database && safeIdentifier(database));
      const tbl = safeIdentifier(params.table);
      if (!tbl) return { ok: false, error: '无效的表名' };
      const fullName = db ? `${esc(db)}.${esc(tbl)}` : esc(tbl);
      const limit = Math.min(Number(params.limit) || 10, 50);
      const [rows] = await conn.query(`SELECT * FROM ${fullName} LIMIT ${limit}`);
      return { ok: true, data: { database: db || database, table: tbl, rows, rowCount: Array.isArray(rows) ? rows.length : 0 } };
    }

    if (intent === 'createTable' && params.ddl) {
      const ddl = String(params.ddl).trim();
      if (!/^\s*CREATE\s+TABLE/i.test(ddl)) return { ok: false, error: 'DDL 必须以 CREATE TABLE 开头' };

      let databaseCreated = false;
      const targetDb = extractDatabaseFromCreateTable(ddl);
      if (targetDb) {
        const [dbRows] = await conn.query('SHOW DATABASES');
        const existing = (dbRows || []).map((r) => (r['Database'] || Object.values(r)[0])).filter(Boolean);
        if (!existing.includes(targetDb)) {
          await conn.query(`CREATE DATABASE ${esc(targetDb)}`);
          databaseCreated = true;
        }
      }

      await conn.query(ddl);
      return {
        ok: true,
        data: {
          message: databaseCreated ? `数据库已创建，表已创建` : `表已创建`,
          databaseCreated,
          ddl,
        },
      };
    }

    if (intent === 'executeSQL' && params.sql) {
      const sql = String(params.sql).trim();
      const forbidden = /\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i;
      if (forbidden.test(sql)) return { ok: false, error: '仅允许 SELECT / SHOW / DESCRIBE / CREATE / INSERT INTO ... SELECT 语句' };
      const [result] = await conn.query(sql);
      const isWrite = /^\s*(INSERT|REPLACE|DELETE|TRUNCATE)/i.test(sql);
      const affectedRows = result && typeof result.affectedRows === 'number' ? result.affectedRows : null;
      const insertId = result && (result.insertId !== undefined && result.insertId !== null) ? result.insertId : null;
      const executionSummary = isWrite
        ? { executed: true, affectedRows, insertId: insertId ?? undefined, message: `执行完成。影响行数: ${affectedRows ?? '-'}${insertId != null ? `，自增 ID: ${insertId}` : ''}` }
        : { executed: true, rowCount: Array.isArray(result) ? result.length : 0, message: `查询完成。返回行数: ${Array.isArray(result) ? result.length : 0}` };
      return {
        ok: true,
        data: {
          executionSummary,
          affectedRows: affectedRows ?? undefined,
          insertId: insertId ?? undefined,
          rows: Array.isArray(result) ? result.slice(0, 100) : undefined,
        },
      };
    }

    if (intent === 'analyzeNulls' && params.table) {
      const db = (params.database && safeIdentifier(params.database)) || (database && safeIdentifier(database));
      const tbl = safeIdentifier(params.table);
      if (!tbl) return { ok: false, error: '无效的表名' };
      const fullName = db ? `${esc(db)}.${esc(tbl)}` : esc(tbl);
      const [cols] = await conn.query(`DESCRIBE ${fullName}`);
      const colNames = cols.map((c) => c.Field);
      const [countRows] = await conn.query(`SELECT COUNT(*) AS total FROM ${fullName}`);
      const totalRows = countRows[0]?.total ?? 0;
      const nullChecks = colNames.map((c) => `SUM(CASE WHEN ${esc(c)} IS NULL THEN 1 ELSE 0 END) AS ${esc(c)}`).join(', ');
      const [nullRows] = await conn.query(`SELECT ${nullChecks} FROM ${fullName}`);
      const nullCounts = nullRows[0] || {};
      const analysis = colNames.map((c) => ({
        column: c,
        nullCount: Number(nullCounts[c] || 0),
        nullRate: totalRows > 0 ? ((Number(nullCounts[c] || 0) / totalRows) * 100).toFixed(2) + '%' : '0%',
      }));
      return { ok: true, data: { database: db || database, table: tbl, totalRows, columns: analysis } };
    }

    return { ok: false, error: '不支持的操作' };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    conn.destroy();
  }
}

async function extractDbIntentFromModel(conversation, DEEPSEEK_API_KEY, DEEPSEEK_CHAT_URL) {
  if (!DEEPSEEK_API_KEY || !Array.isArray(conversation) || conversation.length === 0) return { intent: null, params: {} };
  const systemContent = `你是一个意图解析器。根据用户与助手的对话，判断用户**最后一条消息**是否需要对 MySQL 数据库执行操作。

**支持的 intent 与 params**：
1. listDatabases - 列出数据库/有多少库/有哪些库等。params: {}
2. listTables - 列出表/show tables/有哪些表/某库下的表等。params: { database?: "库名" }
3. createDatabase - **仅当用户明确确认创建数据库时**（如回复「确认」「执行」「可以」），且助手**上一轮**消息中明确提到要创建的数据库名（如「将创建数据库 xxx」「建库 xxx」）。params: { name: "从助手上一轮消息中提取的库名" }。若用户只是首次说「建库 xxx」而助手尚未回复确认提示，则 intent 填 null。
4. describeTable - 查看表结构/describe/schema/看看这张表长什么样/基于某表做加工/用某表。params: { database?: "库名", table: "表名" }
5. previewData - 看前几条数据/preview/select/看看数据/给我看10条/去源表看一下。params: { database?: "库名", table: "表名", limit?: 10 }
6. createTable - **仅当用户明确确认建表时**（如「确认」「好的」「执行」「可以」），且助手**上一轮**消息中包含 CREATE TABLE 语句。params: { ddl: "完整的 CREATE TABLE SQL（从助手上一轮消息中提取）" }。
7. executeSQL - 分两类：(A) **只读 SQL**（SELECT、DESCRIBE、SHOW）：用户说出或确认要执行即可，params: { sql: "完整 SQL" }。(B) **写操作**（INSERT INTO ... SELECT 等）：**仅当用户明确说「确认」「执行」且助手上一轮消息中包含该写操作 SQL 时**，从助手消息中提取完整 SQL 填入 params.sql；若助手刚展示 INSERT SQL 而用户尚未回复确认，则 intent 填 null。用户说「执行」且上一轮是建表 DDL → createTable；上一轮是 INSERT/DML → executeSQL。
8. analyzeNulls - 分析空值/异常值/数据质量/验证结果/检查这张表。params: { database?: "库名", table: "表名" }

**特殊场景**：
- 用户说「基于 xxx 表做加工」「用 xxx 表」「我要加工 xxx 表」→ describeTable，后端会同时返回 schema 和前10条数据。
- 用户**首次**说「建库 xxx」→ intent 为 null（助手应先回复「将创建数据库 xxx，请确认后说「确认」或「执行」」）；用户**随后**说「确认」「执行」且助手上一轮提到要建该库 → createDatabase。
- 用户说「确认」「好的」「执行」且助手上一轮消息中包含 CREATE TABLE 语句 → createTable，从助手消息中提取完整 DDL 填入 params.ddl。
- 用户**首次**描述字段映射或助手**刚展示** INSERT INTO ... SELECT 而用户尚未说「确认」「执行」→ intent 填 null；用户**随后**说「确认」「执行」且助手上一轮包含该 INSERT/DML → executeSQL，从助手消息中提取完整 SQL。
- 若用户说「去源表看一下」「看看源数据有没有」「检查基表数据」→ previewData。
- 若用户在描述目标表的字段/schema（如「目标表要有 user_id, name, amount 这些字段」），这属于对话设计讨论，intent 为 null。

**要求**：
- 用户表述千奇百怪，理解语义即可。
- 不符合以上任何一项则 intent 填 null。
- 只返回一个 JSON 对象，不要 markdown 代码块。格式：
{"intent":"xxx"|null,"params":{}}`;

  const messages = [
    { role: 'system', content: systemContent },
    ...conversation.slice(-8).map((t) => ({ role: t.role, content: t.content })),
  ];

  try {
    const response = await fetch(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages, stream: false, temperature: 0.1, max_tokens: 1024 }),
    });
    const text = await response.text();
    if (!response.ok) return { intent: null, params: {} };
    let data;
    try { data = JSON.parse(text); } catch (_) { return { intent: null, params: {} }; }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { intent: null, params: {} };
    const out = JSON.parse(jsonMatch[0]);
    const intent = VALID_INTENTS.includes(out.intent) ? out.intent : null;
    const params = out.params && typeof out.params === 'object' ? out.params : {};
    return { intent, params };
  } catch (e) {
    console.error('[extractDbIntentFromModel]', e.message);
    return { intent: null, params: {} };
  }
}

// ── Express ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEEPSEEK_CHAT_URL = `${DEEPSEEK_BASE}/v1/chat/completions`;

app.get('/', (req, res) => {
  res.json({
    name: 'ETL API',
    message: '后端已运行',
    endpoints: {
      'POST /api/chat': 'ETL 六步对话',
      'POST /api/mapping': '字段映射',
      'POST /api/dml': '生成 DML',
      'GET /api/debug-deepseek': '测试 DeepSeek',
    },
  });
});

// ────────── /api/chat — ETL 六步对话主入口 ──────────
app.post('/api/chat', async (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'DEEPSEEK_API_KEY not configured' });

  const { conversation, context } = req.body;
  if (!Array.isArray(conversation) || conversation.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid conversation' });
  }
  const connectionStringFromContext = context?.connectionString || null;
  const currentStepHint = Number(context?.currentStep) || 0;
  const userMessages = conversation.filter((t) => t.role === 'user').map((t) => (t.content || '').trim());
  const lastUserContent = userMessages[userMessages.length - 1] || '';
  const lastConnectionStringInChat = [...userMessages].reverse().find(looksLikeConnectionString);
  const connectionString = connectionStringFromContext || lastConnectionStringInChat || null;

  // ── 连接测试 ──
  let connectionTestNote = '';
  let connectionTestOk = false;
  const shouldTestConnection =
    (lastUserContent && looksLikeConnectionString(lastUserContent)) ||
    (lastUserContent && /测试|试一下|验证|检查/.test(lastUserContent) && /连接|连接串|连通/.test(lastUserContent) && lastConnectionStringInChat);
  const connStrToTest = looksLikeConnectionString(lastUserContent) ? lastUserContent : lastConnectionStringInChat;
  if (shouldTestConnection && connStrToTest) {
    try {
      const testResult = await testConnection(connStrToTest);
      connectionTestOk = !!testResult.ok;
      connectionTestNote = testResult.ok
        ? '\n\n**【连接测试结果】** 连通性测试：**成功**。'
        : `\n\n**【连接测试结果】** 连通性测试：**失败**，原因：${testResult.message}`;
    } catch (e) {
      connectionTestNote = `\n\n**【连接测试结果】** 异常：${e.message || e}`;
    }
  }

  // ── 数据库操作 ──
  let dbOperationNote = '';
  const lastMessageIsOnlyConnectionString =
    lastUserContent && looksLikeConnectionString(lastUserContent) && lastUserContent.trim().length < 500;
  const dbIntent =
    connectionString && lastUserContent && !lastMessageIsOnlyConnectionString
      ? await extractDbIntentFromModel(conversation, DEEPSEEK_API_KEY, DEEPSEEK_CHAT_URL)
      : { intent: null, params: {} };

  if (connectionString && dbIntent.intent) {
    const esc = (n) => { const s = safeIdentifier(n); return s ? '`' + s + '`' : ''; };
    const db = safeIdentifier(dbIntent.params.database) || null;
    const tbl = safeIdentifier(dbIntent.params.table) || null;
    const fullTbl = tbl ? (db ? `${esc(db)}.${esc(tbl)}` : esc(tbl)) : '';

    if (dbIntent.intent === 'describeTable') {
      const schemaResult = await runDatabaseOperation(connectionString, 'describeTable', dbIntent.params);
      const previewResult = await runDatabaseOperation(connectionString, 'previewData', { ...dbIntent.params, limit: 10 });
      const parts = [];
      const sqlDescribe = `DESCRIBE ${fullTbl};`;
      const sqlPreview = `SELECT * FROM ${fullTbl} LIMIT 10;`;
      const returnCodes = [];
      if (schemaResult.ok) {
        const cols = schemaResult.data.columns || [];
        const tableSchema = rowsToMarkdownTable(cols, ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra']);
        returnCodes.push(`DESCRIBE 执行成功，返回列数: ${cols.length}`);
        parts.push(`**验证 SQL（表结构）**：\n\`\`\`sql\n${sqlDescribe}\n\`\`\`\n**实际返回（表结构）**：\n${tableSchema}`);
      } else {
        returnCodes.push(`DESCRIBE 执行失败: ${schemaResult.error}`);
        parts.push(`**表结构查询失败**：${schemaResult.error}`);
      }
      if (previewResult.ok) {
        const rows = previewResult.data.rows || [];
        const tablePreview = rowsToMarkdownTable(rows);
        returnCodes.push(`SELECT 执行成功，返回行数: ${rows.length}`);
        parts.push(`**验证 SQL（前10条数据）**：\n\`\`\`sql\n${sqlPreview}\n\`\`\`\n**实际返回（前10条数据）**：\n${tablePreview}`);
      } else {
        returnCodes.push(`SELECT 执行失败: ${previewResult.error}`);
        parts.push(`**数据预览失败**：${previewResult.error}`);
      }
      parts.push(`**SQL 返回码**：${returnCodes.join('；')}`);
      dbOperationNote = `\n\n**【数据库操作结果】** 已查询表结构和数据预览。你必须在回复中按顺序给出：(1) 验证 SQL（代码块）；(2) 实际返回的表格（用 markdown 表格，禁止 JSON）；(3) SQL 返回码。**表格内容必须与下方「实际返回」完全一致，不得编造或修改任何行列。**\n${parts.join('\n\n')}`;
    } else {
      const opResult = await runDatabaseOperation(connectionString, dbIntent.intent, dbIntent.params);
      if (opResult.ok) {
        const d = opResult.data;
        let sqlAndTable = '';
        if (dbIntent.intent === 'listDatabases') {
          const sql = 'SHOW DATABASES;（并 SHOW TABLES FROM 各库统计表数）';
          const table = rowsToMarkdownTable(d.databases || [], ['database', 'tableCount']);
          const code = `执行成功，返回数据库数: ${d.totalDatabases ?? (d.databases || []).length}`;
          sqlAndTable = `**验证 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'listTables') {
          const sql = db ? `SHOW TABLES FROM ${esc(db)};` : 'SHOW TABLES;';
          const rows = (d.tables || []).map((t) => ({ '表名': t }));
          const table = rowsToMarkdownTable(rows, ['表名']);
          const code = `执行成功，返回表数量: ${(d.tables || []).length}`;
          sqlAndTable = `**验证 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'previewData') {
          const sql = `SELECT * FROM ${fullTbl} LIMIT ${Math.min(Number(dbIntent.params.limit) || 10, 50)};`;
          const table = rowsToMarkdownTable(d.rows || []);
          const code = `执行成功，返回行数: ${d.rowCount ?? (d.rows || []).length}`;
          sqlAndTable = `**验证 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'analyzeNulls') {
          const sql = `SELECT COUNT(*) AS total FROM ${fullTbl}; 以及各列空值统计的 SELECT SUM(CASE WHEN 列 IS NULL THEN 1 ELSE 0 END)... FROM ${fullTbl};`;
          const table = rowsToMarkdownTable(d.columns || [], ['column', 'nullCount', 'nullRate']);
          const code = `执行成功，总行数: ${d.totalRows ?? '-'}，统计列数: ${(d.columns || []).length}`;
          sqlAndTable = `**验证 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回（空值统计）**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'executeSQL' && d.rows != null && d.rows.length > 0) {
          const sql = String(dbIntent.params.sql || '').trim();
          const table = rowsToMarkdownTable(d.rows);
          const code = d.executionSummary?.message || `执行成功，返回行数: ${d.rows.length}`;
          sqlAndTable = `**执行的 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**实际返回**：\n${table}\n\n**SQL 返回码**：${code}`;
        } else if (dbIntent.intent === 'executeSQL') {
          const sql = String(dbIntent.params.sql || '').trim();
          const code = d.executionSummary?.message || '执行完成。';
          sqlAndTable = `**执行的 SQL**：\n\`\`\`sql\n${sql}\n\`\`\`\n**SQL 返回码（你必须原样写进回复，不得只写「正在执行」而不写本行）**：${code}`;
        } else {
          sqlAndTable = `\n\`\`\`json\n${JSON.stringify(d, null, 2)}\n\`\`\``;
        }
        dbOperationNote = `\n\n**【数据库操作结果】** 执行「${dbIntent.intent}」**成功**。你必须在回复中按顺序给出：(1) 验证/执行的 SQL（代码块）；(2) 实际返回的**表格**（markdown 表格，禁止 JSON）；(3) SQL 返回码。**表格内容必须与下方「实际返回」完全一致，不得编造或修改任何行列。**\n${sqlAndTable}`;
      } else {
        const errMsg = opResult.error || '';
        const isColumnError = /column\s+['\`]?\w+['\`]?\s+does not exist|Unknown column|doesn't have column|invalid input.*column/i.test(errMsg);
        let schemaBlock = '';
        if (dbIntent.intent === 'executeSQL' && isColumnError && dbIntent.params.sql) {
          const tableRefs = extractTableRefsFromSql(dbIntent.params.sql);
          const schemaParts = [];
          for (const ref of tableRefs) {
            const desc = await runDatabaseOperation(connectionString, 'describeTable', { database: ref.database, table: ref.table });
            if (desc.ok && desc.data && desc.data.columns) {
              const fullName = ref.database ? `${ref.database}.${ref.table}` : ref.table;
              const tableSchema = rowsToMarkdownTable(desc.data.columns, ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra']);
              schemaParts.push(`**表 ${fullName} 的真实结构（已自动查询）**：\n${tableSchema}`);
            }
          }
          if (schemaParts.length > 0) {
            schemaBlock = `\n\n**【自我纠正】** 已根据失败 SQL 自动查询涉及表的结构（真实列名）。你**必须**在回复中：(1) 如实转述失败原因；(2) 根据下方真实列名写出**修正后的完整 SQL**（代码块）；(3) 明确提示用户「请再次执行上述 SQL」直至成功。不得只建议用户自己去 DESCRIBE，而要直接给出可执行的修正 SQL。\n\n${schemaParts.join('\n\n')}`;
          }
        }
        dbOperationNote = `\n\n**【数据库操作结果】** 执行「${dbIntent.intent}」**失败**。\n**失败原因（你必须原样或完整转述给用户，不得隐瞒、不得声称成功）**：\n${errMsg}\n\n请根据上述原因给出修改建议（如：SQL 语法、表名/库名、权限、列名不存在等），并请用户修正后重试。${schemaBlock}`;
      }
    }
  }

  const systemPrompt = `你是智能数据 ETL 助手，帮助用户通过对话完成完整的 ETL 流程。

**步骤自动判断**：ETL 流程有 6 步：1-连接数据库、2-选择基表、3-定义目标表、4-字段映射、5-数据验证、6-异常溯源。
你需要根据**对话上下文**自动判断当前处于哪一步（currentStep 字段，1～6），并在回复中自然引导用户完成当前步、过渡到下一步。

**重要：界面没有「下一步」按钮**。用户只能根据你在对话里的提示进行下一步操作，因此你**必须在回复中根据当前进度明确、自然地提示用户下一步可以做什么**（例如：连接成功后提示输入要加工的库/表、建表成功后提示描述字段映射、映射执行后提示可验证数据等）。**不要写死固定话术**，根据你对对话的理解灵活提醒，让用户知道「现在可以输入什么、做什么」即可。

判断规则：
- 尚未发送过连接串或连接未成功 → 1
- 连接成功但尚未选定基表 → 2
- 已选定基表、用户在讨论目标表字段或生成 CREATE TABLE → 3
- 目标表已建好、用户在讨论映射或生成 INSERT INTO ... SELECT → 4
- 映射已执行、用户在讨论验证/空值/数据质量 → 5
- 用户提到追溯/去源表看/检查基表 → 6
- 若无法判断则保持上一轮 currentStep（前端上一轮传入的 currentStep 为 ${currentStepHint}，若为 0 则默认 1）。
当用户完成一步后，在回复末尾**自然提示下一步可做的操作**，但不要跳步。

**硬性约定（必须遵守）**：
- **一切会修改库表或数据的操作（DDL 与 DML）都必须先展示完整 SQL 并获用户明确确认后才能执行。** 包括：CREATE TABLE、CREATE DATABASE、INSERT INTO ... SELECT 等。你先展示 SQL 并提示「请确认后说「确认」或「执行」」，只有用户明确回复「确认」「执行」「可以」后才会真实执行。只读操作（如 SELECT、DESCRIBE、SHOW）可直接执行，无需确认。
- 所有 SQL、DDL、DML 必须**严格符合 MySQL 语法**（仅使用 MySQL 支持的类型、函数、写法）。
- 所有库/表操作均在**用户提供的连接上真实执行**，由后端连接用户库执行，不模拟、不造假。
- **凡涉及表数据验证、数据展示的回答**（如：表结构、前 N 条数据、空值分析、库表列表、任意 SELECT 结果），回复中**禁止出现 JSON**，必须严格按以下顺序且用**表格**展示数据：(1) **验证/执行的 SQL**（用 \`\`\`sql 代码块写出）；(2) **实际返回的表格**（用 markdown 表格，表头与数据行清晰对齐）；(3) **SQL 返回码**（如：执行成功，返回行数/列数/影响行数）。**表格内容必须严格根据【数据库操作结果】中给出的执行结果**：逐行逐列照实填写，不得自行编造、补全、推测或改写任何单元格；若某列为空则写空，不得虚构行列或数据。
- **SQL 执行失败时**：若上方【数据库操作结果】标明**失败**，你必须 (1) **如实、完整**地把失败原因输出给用户（不得隐瞒、不得改写为“成功”）；(2) **禁止**以任何方式声称“执行成功”“已完成”“已创建”等；(3) **自我纠正**：若失败原因为「列不存在」「Unknown column」等且上方已注入**涉及表的结构（已自动查询）**，你须**直接**在回复中给出根据真实列名修正后的**完整可执行 SQL**（代码块），并明确提示用户「请再次执行上述 SQL」，直至成功；不得只建议用户自己去查表或只贴 DESCRIBE 让用户执行。若为其他错误类型，给出修改建议并请用户修正后重试。
- 只有后端明确返回成功时，才可在回复中说“成功”；否则一律按失败处理并输出真实原因。
${connectionTestNote}
${dbOperationNote}

**各步骤引导说明**：

**第1步：连接数据库**
- 用户提供 MySQL 连接串（URL 如 mysql://user:pass@host:port/db 或命令行形式）。
- 若有【连接测试结果】且成功 → 回复「连接成功。」并**自然引导**进入第 2 步（如：「接下来请告诉我你想基于哪个库的哪张表做数据加工？」）。
- 若测连失败 → 如实说明错误信息，提示用户检查连接串或权限。
- 若本轮用户发送了连接串，必须设置 "connectionReceived": true。

**第2步：选择基表**
- 围绕「有哪些库」「某个库下有哪些表」「我要用哪张表」这类问题回答。
- 若有 describeTable 相关的【数据库操作结果】→ 必须先写出验证 SQL，再以**表格**形式展示表结构和前 10 条数据（禁止用 JSON）；分析只基于真实数据，不得编造。
- **只要本轮展示了某张基表的结构/数据，回复末尾必须明确引导下一步**，例如：「基表已确认。接下来请描述目标表要有哪些字段（字段名、类型、含义），或说明要放在哪个库，我来生成建表语句。」不得只展示表结构而不提示用户下一步该干啥。

**第3步：定义目标表**
- 用户描述目标表字段后 → 你根据描述生成 **标准 MySQL** 的 CREATE TABLE 语句（仅用 MySQL 支持的类型，字段带 COMMENT，库名/表名可用反引号），**仅展示给用户，并明确提示「请确认后再执行」或「确认后请回复「确认」或「执行」」**；不得在用户未确认时执行建表。
- 只有用户明确回复「确认建表」「确认」「执行」「可以」等后，后端才会真实执行建表，你如实反馈结果。
- 建表成功后，自然引导进入第 4 步（如：「目标表已创建，请描述每个字段的数据来源与加工逻辑。」）。

**第4步：字段映射**
- 围绕「目标字段如何从基表/维表中取数、怎么加工」来对话。
- **维表/基表字段必须用真实列名**：写 JOIN、SELECT 时只能使用**已查询过的表结构**中的列名；若某维表尚未查过结构，**不得臆造列名**，应先让用户查看表结构，再根据真实列名写 DML。
- 用户描述字段映射后 → 你生成 **标准 MySQL** 的 INSERT INTO 目标表 SELECT ... FROM 基表 的 DML（JOIN 写法，禁止子查询），**仅展示完整 SQL，并明确提示「请确认后说「确认」或「执行」」**；不得在用户未确认时执行。只有用户明确回复「确认」「执行」后，后端才会执行该 DML。
- 执行后必须写出 SQL + SQL 返回码（影响行数等）。若执行失败且上方已注入涉及表的真实结构，须**直接给出修正后的完整 SQL** 并提示再次执行，直至成功。
- 映射执行成功后，自然引导进入第 5 步（如：「数据已写入目标表，可以发送"开始验证"检查数据质量。」）。

**第5步：数据验证**
- 围绕「目标表数据是否正常」「哪些字段空值多」「是否有异常值」来回答。
- 若有表数据相关的【数据库操作结果】→ 必须先写出**验证 SQL**，再以**表格**形式展示实际返回，**禁止**用 JSON。
- 若发现异常，自然引导进入第 6 步（如：「发现 xxx 字段空值较多，可以说"追溯 xxx 字段"去源表排查原因。」）。

**第6步：异常溯源**
- 用户提到「去源表看看」「追溯某字段」「检查基表数据」时，查询并展示基表真实数据。
- 回复中必须写出**验证 SQL**并以**表格**展示实际查询结果，禁止 JSON、不得编造；对比目标表和基表的数据情况分析原因。

**通用回复规则**：
1. 用中文回复，简洁友好。**因无「下一步」按钮，你必须在对话中提示用户下一步该干啥**：根据当前步骤和对话理解，在回复中自然说明「接下来可以输入/做什么」（不写死话术，灵活提醒）。
2. **你执行的每一个 SQL 都必须在回复中给出返回结果**：SELECT 须有表格 + 返回行数；INSERT 等须明确写出**SQL 返回码**。**禁止**只写「正在执行」而不写执行结果。
3. 若有【数据库操作结果】且为**失败**，必须**如实输出失败原因**，并给出**自我纠正**建议。
4. 若本轮**没有【数据库操作结果】**，**不得声称**已执行任何数据库操作。
5. 若用户发送了 MySQL 连接串，设置 "connectionReceived": true。
6. **所有会修改库表或数据的操作（DDL、DML）**：建库、建表、INSERT INTO ... SELECT 等，都必须**先展示 SQL 并提示用户确认**，只有用户明确回复「确认」「执行」「可以」后才会真实执行。不得在用户未确认时执行任何写操作。

**输出格式**：只返回一个 JSON 对象，不要 markdown 代码块：
{"reply":"你的回复内容（可含 markdown 格式化）","connectionReceived":false,"currentStep":1}
**重要**：
- currentStep 必须填入你判断的当前步骤（1～6 的整数），前端会根据它更新进度条。
- reply 里涉及表数据时，必须是「SQL 代码块 + markdown 表格 + 返回码」三部分，禁止 JSON。**表格内容必须与【数据库操作结果】完全一致，不得编造。**`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversation.map((t) => ({ role: t.role, content: t.content })),
  ];

  try {
    const response = await fetch(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages, stream: false, temperature: 0.3, max_tokens: 4096 }),
    });
    const errBody = await response.text();
    if (!response.ok) {
      let errMsg = errBody || response.statusText;
      try { const j = JSON.parse(errBody); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(errBody); } catch (e) { return res.status(500).json({ error: 'DeepSeek 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    let out = { reply: content, connectionReceived: false, currentStep: currentStepHint || 1 };
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.reply === 'string') out.reply = parsed.reply;
        if (parsed.connectionReceived) out.connectionReceived = true;
        if (parsed.currentStep >= 1 && parsed.currentStep <= 6) out.currentStep = parsed.currentStep;
      } catch (_) {}
    }
    return res.json({ ...out, connectionTestOk });
  } catch (e) {
    console.error('[DeepSeek /api/chat]', e.message);
    return res.status(500).json({ error: e.message || 'DeepSeek 请求失败' });
  }
});

// ────────── /api/mapping ──────────
function buildSystemPrompt(targetTableName, targetFields, existingMappings) {
  const mapped = existingMappings.filter(m => m.status !== 'unmapped');
  const fieldList = targetFields.map(f => `- ${f.name} (${f.type}) ${f.comment ? `— ${f.comment}` : ''}`).join('\n');

  return `你是一个数据 ETL 助手。用户正在为**目标表**的每个字段配置数据来源（库、表、字段或表达式）。

**目标表名**：${targetTableName}

**目标表字段列表**（name 为英文字段名，comment 为中文说明）：
${fieldList}

${mapped.length > 0 ? `**已映射的字段**：${mapped.map(m => m.targetField).join(', ')}` : ''}

**重要——一律用 JOIN 写法，禁止子查询；仅用 MySQL 语法**：
- sql 只能是「表别名.列名」或简单表达式（如 COALESCE、CAST、CONCAT 等 **MySQL 支持**的写法），**禁止**标量子查询。
- 用户用中文说字段时，对应到 comment 或 name 匹配的英文名。

**必须**返回合法 JSON，不要 markdown 代码块：
{
  "mappings": [
    {
      "targetField": "目标表字段英文名",
      "source": "库.表",
      "logic": "简短说明（含关联键）",
      "sql": "表别名.列名 或简单表达式"
    }
  ]
}

若无法对应到任何字段，返回 {"mappings":[]}`;
}

app.post('/api/mapping', async (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'DEEPSEEK_API_KEY not configured' });

  const { message, conversation, targetTableName, targetFields, existingMappings } = req.body;
  if (!message || !targetTableName || !Array.isArray(targetFields)) {
    return res.status(400).json({ error: 'Missing message, targetTableName or targetFields' });
  }

  const systemPrompt = buildSystemPrompt(targetTableName, targetFields, Array.isArray(existingMappings) ? existingMappings : []);
  let chatMessages;
  if (Array.isArray(conversation) && conversation.length > 0) {
    const normalized = conversation
      .map((t) => ({ role: t.role, content: String(t.content || '').trim() }))
      .filter((t) => t.content.length > 0);
    while (normalized.length > 0 && normalized[0].role === 'assistant') normalized.shift();
    chatMessages = normalized.length === 0
      ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }]
      : [{ role: 'system', content: systemPrompt }, ...normalized];
  } else {
    chatMessages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }];
  }

  try {
    const response = await fetch(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: chatMessages, stream: false, temperature: 0.2, max_tokens: 4096 }),
    });
    const errBody = await response.text();
    if (!response.ok) {
      let errMsg = errBody || response.statusText;
      try { const j = JSON.parse(errBody); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(errBody); } catch (e) { return res.status(500).json({ error: 'DeepSeek 返回格式异常' }); }
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    let parsed = { mappings: [] };
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) { try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {} }
    if (!Array.isArray(parsed.mappings)) parsed.mappings = [];
    return res.json(parsed);
  } catch (e) {
    console.error('[DeepSeek /api/mapping]', e.message);
    return res.status(500).json({ error: e.message || 'DeepSeek 请求失败' });
  }
});

// ────────── /api/dml ──────────
app.post('/api/dml', async (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'DEEPSEEK_API_KEY not configured' });

  const { targetTableFullName, mappings } = req.body;
  if (!targetTableFullName || !Array.isArray(mappings) || mappings.length === 0) {
    return res.status(400).json({ error: 'Missing targetTableFullName or mappings' });
  }

  const mappingList = mappings
    .map((m) => ({ targetField: m.targetField, source: m.source || '', logic: m.logic || '', sql: m.sql || m.targetField }))
    .filter((m) => m.targetField && m.sql);

  const systemPrompt = `你是 MySQL SQL 专家。生成**标准 MySQL 语法**的 DML：仅使用 MySQL 支持的类型与函数，表名/列名可用反引号。用多表 JOIN，禁止标量子查询。

**目标表**：${targetTableFullName}

**字段映射**：
${mappingList.map((m) => `- ${m.targetField}: source=${m.source}, logic=${m.logic}, sql=${m.sql}`).join('\n')}

**输出**：1) TRUNCATE TABLE 目标表; 2) INSERT INTO 目标表 (列...) SELECT ... FROM 主表 LEFT JOIN ... 只输出 MySQL 可执行的 SQL，无 markdown。`;

  try {
    const response = await fetch(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请用 JOIN 写法生成 DML。' },
        ],
        stream: false, temperature: 0.1, max_tokens: 4096,
      }),
    });
    const errBody = await response.text();
    if (!response.ok) {
      let errMsg = errBody || response.statusText;
      try { const j = JSON.parse(errBody); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(errBody); } catch (e) { return res.status(500).json({ error: 'DeepSeek 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    const dml = content.replace(/^```\w*\n?|```\s*$/g, '').trim();
    return res.json({ dml: dml || content });
  } catch (e) {
    console.error('[DeepSeek /api/dml]', e.message);
    return res.status(500).json({ error: e.message || 'DeepSeek 请求失败' });
  }
});

// ────────── /api/dml/optimize ──────────
app.post('/api/dml/optimize', async (req, res) => {
  if (!DEEPSEEK_API_KEY) return res.status(503).json({ error: 'DEEPSEEK_API_KEY not configured' });
  const { dml } = req.body;
  if (!dml || typeof dml !== 'string') return res.status(400).json({ error: 'Missing dml' });

  const systemPrompt = `你是 MySQL SQL 优化专家。将标量子查询改为 JOIN，保持语义不变。输出必须为**标准 MySQL 语法**、可直接在 MySQL 中执行。只输出优化后的完整 SQL，不要 markdown 或解释。`;
  try {
    const response = await fetch(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请优化：\n\n${dml}` },
        ],
        stream: false, temperature: 0.1, max_tokens: 4096,
      }),
    });
    const errBody = await response.text();
    if (!response.ok) {
      let errMsg = errBody || response.statusText;
      try { const j = JSON.parse(errBody); errMsg = j.error?.message || j.error || errMsg; } catch (_) {}
      return res.status(response.status).json({ error: errMsg });
    }
    let data;
    try { data = JSON.parse(errBody); } catch (e) { return res.status(500).json({ error: 'DeepSeek 返回格式异常' }); }
    const content = (data.choices?.[0]?.message?.content || '').trim();
    return res.json({ dml: content.replace(/^```\w*\n?|```\s*$/g, '').trim() || content });
  } catch (e) {
    console.error('[DeepSeek /api/dml/optimize]', e.message);
    return res.status(500).json({ error: e.message || 'DeepSeek 请求失败' });
  }
});

// ────────── /api/debug-deepseek ──────────
app.get('/api/debug-deepseek', async (req, res) => {
  const hasKey = !!DEEPSEEK_API_KEY;
  if (!hasKey) return res.json({ ok: false, reason: 'DEEPSEEK_API_KEY 未设置' });
  try {
    const response = await fetch(DEEPSEEK_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Say hello in one word.' }],
        stream: false,
      }),
    });
    const bodyText = await response.text();
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch (_) {}
    if (!response.ok) return res.json({ ok: false, status: response.status, body: bodyJson || bodyText });
    return res.json({ ok: true, reply: bodyJson?.choices?.[0]?.message?.content || bodyText?.slice(0, 200) });
  } catch (e) {
    return res.json({ ok: false, error: e.message, code: e.code });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`ETL API server http://localhost:${PORT}`);
  console.log(`  DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY ? '已设置' : '未设置'}`);
});
