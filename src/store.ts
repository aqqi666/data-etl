import { create } from 'zustand';
import type { ChatMessage, ContentBlock, EtlStep } from './types';
import type { ConversationTurn } from './api';
import { fetchChatWithModel } from './api';
import { useProcessedTableStore } from './processedTableStore';
import { useSchemaStore } from './schemaStore';

let msgId = 0;
const nextId = () => `msg-${++msgId}`;

function sysMsg(...contents: ContentBlock[]): ChatMessage {
  return { id: nextId(), role: 'system', contents, timestamp: Date.now() };
}
function userMsg(text: string): ChatMessage {
  return { id: nextId(), role: 'user', contents: [{ type: 'text', text }], timestamp: Date.now() };
}

interface AppState {
  dashboardId: string | null;
  step: EtlStep;
  connectionString: string | null;
  messages: ChatMessage[];
  isProcessing: boolean;

  loadForDashboard: (dashboardId: string) => void;
  sendMessage: (text: string) => void;
  reset: () => void;
}

/** 开场语 */
function getIntroMessage(): ChatMessage {
  const text = `欢迎使用智能 ETL 助手。

通过自然语言对话，你可以快速完成数据建模与加工流程：
• 连接数据库
• 选择基表
• 定义目标表结构
• 建立字段映射
• 自动校验与异常溯源

第一次使用？输入「**操作指南**」获取演示说明。
或直接提供 MySQL 连接串，立即开始构建你的数据任务。例如：\n\`mysql://username:password@host:3306/database_name\``;
  return {
    id: 'intro',
    role: 'system',
    contents: [{ type: 'text' as const, text }],
    timestamp: Date.now(),
  };
}

/** 操作指南：自我对答演示的每条消息（用于流式追加） */
function getDemoConversationMessages(): ChatMessage[] {
  const t = Date.now();
  const msg = (id: string, role: 'system' | 'user', text: string): ChatMessage => ({
    id,
    role,
    contents: [{ type: 'text' as const, text }],
    timestamp: t,
  });
  return [
    msg('demo-0', 'system', '下面是一段**自问自答演示**（编造库表），带您走完从连接、选表、建表、映射到验证的全流程。\n\n请先在下方输入您的 **MySQL 连接串**；演示中将使用示例连接串继续。'),
    msg('demo-1', 'user', 'mysql://user:pass@host:3306/demo'),
    msg('demo-2', 'system', '连接成功。接下来请告诉我你想基于哪个库的哪张表做数据加工？'),
    msg('demo-3', 'user', '用 demo.orders 做加工'),
    msg('demo-4', 'system', '已查询表 `demo`.`orders` 的结构和前 10 条数据。\n\n**验证 SQL（表结构）**：\n```sql\nDESCRIBE `demo`.`orders`;\n```\n\n**实际返回（表结构）**：\n\n| Field | Type | Null | Key | Default | Extra |\n|-------|------|------|-----|---------|-------|\n| order_id | int | NO | PRI | NULL | auto_increment |\n| user_id | int | YES | | NULL | |\n| amount | decimal(10,2) | YES | | NULL | |\n| created_at | datetime | YES | | NULL | |\n\n**SQL 返回码**：DESCRIBE 执行成功，返回列数: 4。\n\n基表已确认，请描述目标表要有哪些字段。'),
    msg('demo-5', 'user', '目标表 demo.order_summary 要有 user_id、总金额 total_amount、笔数 order_count'),
    msg('demo-6', 'system', '生成建表 SQL 如下，请确认后说「确认建表」执行。\n\n```sql\nCREATE TABLE `demo`.`order_summary` (\n  `user_id` int DEFAULT NULL COMMENT \'用户ID\',\n  `total_amount` decimal(14,2) DEFAULT NULL COMMENT \'总金额\',\n  `order_count` int DEFAULT NULL COMMENT \'订单笔数\'\n) COMMENT=\'按用户汇总订单\';\n```'),
    msg('demo-7', 'user', '确认建表'),
    msg('demo-8', 'system', '建表成功。目标表已创建，请描述每个字段的数据来源与加工逻辑。'),
    msg('demo-9', 'user', 'user_id 取基表 user_id，总金额按 user_id 汇总 amount，笔数按 user_id 数订单'),
    msg('demo-10', 'system', '已生成数据映射 SQL，确认后说「执行」即可。\n\n```sql\nINSERT INTO `demo`.`order_summary` (`user_id`, `total_amount`, `order_count`)\nSELECT `user_id`, SUM(`amount`) AS total_amount, COUNT(*) AS order_count\nFROM `demo`.`orders`\nGROUP BY `user_id`;\n```'),
    msg('demo-11', 'user', '执行'),
    msg('demo-12', 'system', '执行完成。**SQL 返回码**：影响行数: 42。\n\n数据已写入目标表，可以发送「开始验证」检查数据质量。'),
    msg('demo-13', 'user', '开始验证'),
    msg('demo-14', 'system', '已对目标表 `demo`.`order_summary` 做空值分析。\n\n| column | nullCount | nullRate |\n|--------|-----------|----------|\n| user_id | 0 | 0.00% |\n| total_amount | 0 | 0.00% |\n| order_count | 0 | 0.00% |\n\n**SQL 返回码**：执行成功，总行数: 42。各列无空值，数据正常。'),
    msg('demo-15', 'system', '以上就是完整流程。\n\n现在，请在下方输入 MySQL 连接串，例如：\n`mysql://username:password@host:3306/database_name`\n开始构建数据任务。'),
  ];
}

function getDefaultState() {
  return {
    dashboardId: null as string | null,
    step: 1 as EtlStep,
    connectionString: null as string | null,
    messages: [getIntroMessage()],
    isProcessing: false,
  };
}

function looksLikeConnectionString(s: string): boolean {
  if (/^mysql:\/\//i.test(s) || (/^[a-z]+:\/\//i.test(s) && s.includes('@') && /:\d+/.test(s))) return true;
  return /mysql\s+.+-h\s+/i.test(s) && (/-u\s/i.test(s) || /-u'/.test(s));
}

/** 从对话历史中提取已加工表信息（含字段映射） */
function extractProcessedTableFromReply(reply: string, allMessages: ChatMessage[]): {
  database: string; table: string; sourceTables: string[];
  fieldMappings: { targetField: string; sourceTable: string; sourceExpr: string; transform: string }[];
  insertSql: string;
} | null {
  // 检测 INSERT 执行成功（步骤4完成标志）
  const insertSuccess = /执行完成|影响行数|数据已写入/i.test(reply) && /INSERT\s+INTO/i.test(reply);
  // 检测建表成功
  const createSuccess = /建表成功|表已创建/i.test(reply);

  if (!insertSuccess && !createSuccess) return null;

  // 从回复或历史消息中提取目标表名 `db`.`table` 或 db.table
  const allText = allMessages.map(m =>
    m.contents.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map(c => c.text).join('')
  ).join('\n') + '\n' + reply;

  // 匹配 CREATE TABLE `db`.`table` 或 INSERT INTO `db`.`table`
  const tableMatch = allText.match(/(?:CREATE\s+TABLE|INSERT\s+INTO)\s+`([^`]+)`\s*\.\s*`([^`]+)`/i);
  if (!tableMatch) return null;

  const database = tableMatch[1];
  const table = tableMatch[2];

  // 提取完整的 INSERT SQL
  let insertSql = '';
  const insertMatch = allText.match(/INSERT\s+INTO\s+`[^`]+`\s*\.\s*`[^`]+`[^;]*;?/i);
  if (insertMatch) insertSql = insertMatch[0].trim();

  // 提取基表来源（FROM / JOIN `db`.`table`）
  const sourceTables: string[] = [];
  const fromJoinMatches = allText.matchAll(/(?:FROM|JOIN)\s+`([^`]+)`\s*\.\s*`([^`]+)`/gi);
  for (const m of fromJoinMatches) {
    const src = `${m[1]}.${m[2]}`;
    if (src !== `${database}.${table}` && !sourceTables.includes(src)) {
      sourceTables.push(src);
    }
  }

  // 提取字段映射：从 INSERT INTO ... (fields) SELECT ... 中解析
  const fieldMappings: { targetField: string; sourceTable: string; sourceExpr: string; transform: string }[] = [];

  // 提取目标字段列表
  const insertFieldsMatch = insertSql.match(/INSERT\s+INTO\s+`[^`]+`\s*\.\s*`[^`]+`\s*\(([^)]+)\)/i);
  // 提取 SELECT 部分
  const selectMatch = insertSql.match(/SELECT\s+([\s\S]+?)\s+FROM\s+/i);

  if (insertFieldsMatch && selectMatch) {
    const targetFields = insertFieldsMatch[1].split(',').map(f => f.trim().replace(/`/g, ''));
    const selectExprs = splitSelectExprs(selectMatch[1]);

    for (let i = 0; i < targetFields.length && i < selectExprs.length; i++) {
      const expr = selectExprs[i].trim();
      // 判断是否有聚合函数
      const aggMatch = expr.match(/^(SUM|COUNT|AVG|MAX|MIN|GROUP_CONCAT)\s*\(/i);
      const transform = aggMatch ? aggMatch[1].toUpperCase() : '直接映射';

      // 提取来源字段（简单匹配 `field` 或 alias.`field`）
      const fieldRef = expr.match(/`([^`]+)`\s*\)/i) || expr.match(/`([^`]+)`/i);
      const sourceExpr = fieldRef ? fieldRef[1] : expr.replace(/\s+AS\s+\w+$/i, '').trim();

      // 尝试匹配来源表
      const tableRef = expr.match(/`([^`]+)`\s*\.\s*`([^`]+)`/);
      const sourceTable = tableRef
        ? `${tableRef[1]}.${tableRef[2]}`
        : sourceTables.length > 0 ? sourceTables[0] : '';

      fieldMappings.push({ targetField: targetFields[i], sourceTable, sourceExpr, transform });
    }
  }

  return { database, table, sourceTables, fieldMappings, insertSql };
}

/** 拆分 SELECT 表达式列表（处理嵌套括号内的逗号） */
function splitSelectExprs(selectPart: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of selectPart) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current);
  return result;
}

function wantsDemoGuide(text: string): boolean {
  const t = text.trim();
  return /操作指南|看演示|看指南|^演示$|^指南$/.test(t) || /^[1一]\.?\s*看/.test(t);
}

function getDemoMessageDelay(msg: ChatMessage): number {
  const base = 1200;
  if (msg.role === 'user') return base;
  const text = msg.contents[0]?.type === 'text' ? msg.contents[0].text : '';
  const len = text.length;
  const extra = Math.min(3500, Math.floor(len / 50) * 250);
  return base + extra;
}

/** 持久化当前 dashboard 的聊天状态 */
function persistState(state: { dashboardId: string | null; step: EtlStep; connectionString: string | null; messages: ChatMessage[] }) {
  if (!state.dashboardId) return;
  const key = `etl-chat-${state.dashboardId}`;
  localStorage.setItem(key, JSON.stringify({
    step: state.step,
    connectionString: state.connectionString,
    messages: state.messages,
  }));
}

function loadState(dashboardId: string): { step: EtlStep; connectionString: string | null; messages: ChatMessage[] } | null {
  try {
    const raw = localStorage.getItem(`etl-chat-${dashboardId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const useStore = create<AppState>((set, get) => ({
  ...getDefaultState(),

  loadForDashboard: (dashboardId: string) => {
    msgId = 0;
    const saved = loadState(dashboardId);
    if (saved) {
      // 恢复 msgId
      const maxId = saved.messages.reduce((max, m) => {
        const match = m.id.match(/^msg-(\d+)$/);
        return match ? Math.max(max, parseInt(match[1])) : max;
      }, 0);
      msgId = maxId;
      set({
        dashboardId,
        step: saved.step,
        connectionString: saved.connectionString,
        messages: saved.messages,
        isProcessing: false,
      });
      // 恢复连接后自动加载库表树
      if (saved.connectionString) {
        useSchemaStore.getState().fetchTree(saved.connectionString);
      }
    } else {
      set({
        ...getDefaultState(),
        dashboardId,
      });
    }
  },

  sendMessage: (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const { messages, step, dashboardId } = get();
    const newMessages = [...messages, userMsg(trimmed)];
    set({ messages: newMessages, isProcessing: true });
    persistState({ ...get(), messages: newMessages });

    if (step === 1 && wantsDemoGuide(trimmed)) {
      const demoList = getDemoConversationMessages();
      let idx = 0;
      const run = () => {
        if (idx >= demoList.length) {
          set({ isProcessing: false });
          persistState(get());
          return;
        }
        const next = { ...demoList[idx], id: `demo-${idx}-${Date.now()}` };
        set((s) => ({ messages: [...s.messages, next] }));
        const delay = getDemoMessageDelay(demoList[idx]);
        idx += 1;
        setTimeout(run, delay);
      };
      setTimeout(run, getDemoMessageDelay(demoList[0]));
      return;
    }

    const buildConversation = (): ConversationTurn[] =>
      get()
        .messages.filter((msg) => !msg.id.startsWith('demo-') && msg.id !== 'intro')
        .map((msg) => {
          const t = msg.contents
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
            .trim();
          if (!t) return null;
          return { role: msg.role === 'user' ? ('user' as const) : ('assistant' as const), content: t };
        })
        .filter((t): t is ConversationTurn => t !== null);

    (async () => {
      try {
        const conversation = buildConversation();
        const selected = Array.from(useSchemaStore.getState().selectedTables);
        const res = await fetchChatWithModel(conversation, {
          connectionString: get().connectionString || undefined,
          currentStep: get().step,
          selectedTables: selected.length > 0 ? selected : undefined,
        });

        const updatedMessages = [...get().messages];
        updatedMessages.push(sysMsg({ type: 'text', text: res.reply }));

        const updates: Partial<AppState> = { messages: updatedMessages, isProcessing: false };

        if (res.connectionReceived && looksLikeConnectionString(trimmed)) {
          updates.connectionString = trimmed;
          // 自动加载库表树
          useSchemaStore.getState().fetchTree(trimmed);
        }
        if (res.currentStep && res.currentStep >= 1 && res.currentStep <= 6) {
          updates.step = res.currentStep as EtlStep;
        }

        set(updates);
        persistState({ ...get(), ...updates } as any);

        // 检测是否有新的已加工表
        const dashId = get().dashboardId;
        if (dashId) {
          const processed = extractProcessedTableFromReply(res.reply, get().messages);
          if (processed) {
            useProcessedTableStore.getState().addOrUpdate({
              dashboardId: dashId,
              database: processed.database,
              table: processed.table,
              sourceTables: processed.sourceTables,
              fieldMappings: processed.fieldMappings,
              insertSql: processed.insertSql,
              processedAt: Date.now(),
            });
          }
        }
      } catch (err) {
        const updatedMessages = [...get().messages];
        const errText = err instanceof Error ? err.message : '请求失败';
        updatedMessages.push(
          sysMsg({ type: 'text', text: `对话服务暂不可用：${errText}\n\n请检查后端与 DeepSeek 配置。` }),
        );
        set({ messages: updatedMessages, isProcessing: false });
        persistState(get());
      }
    })();
  },

  reset: () => {
    const { dashboardId } = get();
    msgId = 0;
    const fresh = { ...getDefaultState(), dashboardId };
    set(fresh);
    persistState(fresh);
  },
}));
