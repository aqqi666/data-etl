import { create } from 'zustand';
import type { ChatMessage, EtlStep } from './types';
import type { ConversationTurn } from './api';
import { fetchChatWithModel } from './api';
import { useProcessedTableStore } from './processedTableStore';
import { useMetricDefStore } from './metricDefStore';
import { useSchemaStore } from './schemaStore';

let msgId = 0;
const nextId = () => `msg-${++msgId}`;

function sysMsg(text: string): ChatMessage {
  return { id: nextId(), role: 'system', contents: [{ type: 'text', text }], timestamp: Date.now() };
}
function userMsg(text: string): ChatMessage {
  return { id: nextId(), role: 'user', contents: [{ type: 'text', text }], timestamp: Date.now() };
}

// ─── Intro ───

function getIntroMessage(): ChatMessage {
  const text = `欢迎使用智能数据助手。

我同时具备**数据加工**和**指标定义**两种能力，你可以在同一对话中自由切换：

**数据加工**：查看库表、建表、字段映射、数据验证、异常溯源
**指标定义**：根据表结构定义度量指标，自动关联已加工的业务表

你可以直接描述需求，比如：
- 「看看有哪些库和表」
- 「基于 xxx 表建一张目标表」
- 「我想定义一个收入指标」

第一次使用？输入「**操作指南**」获取演示说明。
或直接提供 MySQL 连接串开始：\`mysql://username:password@host:3306/database_name\``;
  return { id: 'intro', role: 'system', contents: [{ type: 'text' as const, text }], timestamp: Date.now() };
}

// ─── Demo ───

function getDemoConversationMessages(): ChatMessage[] {
  const t = Date.now();
  const msg = (id: string, role: 'system' | 'user', text: string): ChatMessage => ({
    id, role, contents: [{ type: 'text' as const, text }], timestamp: t,
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

// ─── Helpers ───

function looksLikeConnectionString(s: string): boolean {
  if (/^mysql:\/\//i.test(s) || (/^[a-z]+:\/\//i.test(s) && s.includes('@') && /:\d+/.test(s))) return true;
  return /mysql\s+.+-h\s+/i.test(s) && (/-u\s/i.test(s) || /-u'/.test(s));
}

function wantsDemoGuide(text: string): boolean {
  const t = text.trim();
  return /操作指南|看演示|看指南|^演示$|^指南$/.test(t) || /^[1一]\.?\s*看/.test(t);
}

function getDemoMessageDelay(msg: ChatMessage): number {
  const base = 1200;
  if (msg.role === 'user') return base;
  const text = msg.contents[0]?.type === 'text' ? msg.contents[0].text : '';
  const extra = Math.min(3500, Math.floor(text.length / 50) * 250);
  return base + extra;
}

// ─── Cross-context ───

function buildProcessedTablesSummary(dashboardId: string): string {
  const tables = useProcessedTableStore.getState().getByDashboard(dashboardId);
  if (tables.length === 0) return '';
  return tables.map(t => {
    const lines = [`- ${t.database}.${t.table}（来源：${t.sourceTables.join(', ') || '未知'}）`];
    if (t.fieldMappings.length > 0) {
      lines.push('  字段映射：' + t.fieldMappings.map(f =>
        `${f.targetField} ← ${f.sourceTable}.${f.sourceExpr}${f.transform ? '(' + f.transform + ')' : ''}`
      ).join('；'));
    }
    if (t.insertSql) {
      lines.push('  加工SQL：' + t.insertSql.replace(/\n/g, ' ').slice(0, 200));
    }
    return lines.join('\n');
  }).join('\n');
}

function buildMetricDefsSummary(dashboardId: string): string {
  const defs = useMetricDefStore.getState().getByDashboard(dashboardId);
  if (defs.length === 0) return '';
  return defs.map(d =>
    `- ${d.name}：${d.definition}，聚合=${d.aggregation}(${d.measureField})，涉及表 ${d.tables.join(', ')}`
  ).join('\n');
}

// ─── Persistence ───

const STORAGE_PREFIX = 'etl-unified-chat-';

interface PersistedData {
  step: EtlStep;
  connectionString: string | null;
  messages: ChatMessage[];
}

function persistState(dashboardId: string, data: PersistedData) {
  try {
    localStorage.setItem(STORAGE_PREFIX + dashboardId, JSON.stringify(data));
  } catch { /* ignore */ }
}

function loadState(dashboardId: string): PersistedData | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + dashboardId);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

/** 从旧 store 迁移数据 */
function migrateOldData(dashboardId: string): PersistedData | null {
  try {
    const etlRaw = localStorage.getItem(`etl-chat-${dashboardId}`);
    const metricRaw = localStorage.getItem(`etl-metric-chat-${dashboardId}`);
    if (!etlRaw && !metricRaw) return null;

    let etlMessages: ChatMessage[] = [];
    let step: EtlStep = 1;
    let connectionString: string | null = null;

    if (etlRaw) {
      const etlData = JSON.parse(etlRaw);
      etlMessages = (etlData.messages || []).filter((m: ChatMessage) => m.id !== 'intro');
      step = etlData.step || 1;
      connectionString = etlData.connectionString || null;
    }

    let metricMessages: ChatMessage[] = [];
    if (metricRaw) {
      metricMessages = (JSON.parse(metricRaw) as ChatMessage[]).filter((m: ChatMessage) => m.id !== 'mc-intro');
    }

    // 合并按时间排序
    const allMessages = [...etlMessages, ...metricMessages].sort((a, b) => a.timestamp - b.timestamp);
    if (allMessages.length === 0) return null;

    return { step, connectionString, messages: allMessages };
  } catch {
    return null;
  }
}

// ─── Store ───

interface UnifiedChatState {
  dashboardId: string | null;
  step: EtlStep;
  connectionString: string | null;
  messages: ChatMessage[];
  isProcessing: boolean;

  loadForDashboard: (dashboardId: string) => void;
  sendMessage: (text: string) => void;
  reset: () => void;
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

function toPersist(s: { step: EtlStep; connectionString: string | null; messages: ChatMessage[] }): PersistedData {
  return { step: s.step, connectionString: s.connectionString, messages: s.messages };
}

export const useUnifiedChatStore = create<UnifiedChatState>((set, get) => ({
  ...getDefaultState(),

  loadForDashboard: (dashboardId: string) => {
    msgId = 0;

    let saved = loadState(dashboardId);
    if (!saved) {
      saved = migrateOldData(dashboardId);
      if (saved) persistState(dashboardId, saved);
    }

    if (saved && saved.messages.length > 0) {
      const maxId = saved.messages.reduce((max, m) => {
        const match = m.id.match(/^msg-(\d+)$/);
        return match ? Math.max(max, parseInt(match[1])) : max;
      }, 0);
      msgId = maxId;
      set({
        dashboardId,
        step: saved.step || 1,
        connectionString: saved.connectionString || null,
        messages: saved.messages,
        isProcessing: false,
      });
      if (saved.connectionString) {
        useSchemaStore.getState().fetchTree(saved.connectionString);
      }
    } else {
      set({ ...getDefaultState(), dashboardId });
    }
  },

  sendMessage: (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const { messages, step, dashboardId, connectionString } = get();
    const newMessages = [...messages, userMsg(trimmed)];
    set({ messages: newMessages, isProcessing: true });
    if (dashboardId) persistState(dashboardId, toPersist({ step, connectionString, messages: newMessages }));

    // 演示指南
    if (step === 1 && wantsDemoGuide(trimmed)) {
      const demoList = getDemoConversationMessages();
      let idx = 0;
      const run = () => {
        if (idx >= demoList.length) {
          set({ isProcessing: false });
          const s = get();
          if (s.dashboardId) persistState(s.dashboardId, toPersist(s));
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
        .messages.filter((m) => !m.id.startsWith('demo-') && m.id !== 'intro')
        .map((m) => {
          const t = m.contents
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
            .trim();
          if (!t) return null;
          return { role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: t };
        })
        .filter((t): t is ConversationTurn => t !== null);

    (async () => {
      try {
        const conversation = buildConversation();
        const selected = Array.from(useSchemaStore.getState().selectedTables);
        const currentDashboardId = get().dashboardId;

        const processedTablesSummary = currentDashboardId ? buildProcessedTablesSummary(currentDashboardId) : '';
        const metricDefsSummary = currentDashboardId ? buildMetricDefsSummary(currentDashboardId) : '';

        const res = await fetchChatWithModel(conversation, {
          connectionString: get().connectionString || undefined,
          currentStep: get().step,
          selectedTables: selected.length > 0 ? selected : undefined,
          processedTablesSummary: processedTablesSummary || undefined,
          metricDefsSummary: metricDefsSummary || undefined,
        });

        const updatedMessages = [...get().messages, sysMsg(res.reply)];
        const updates: Partial<UnifiedChatState> = { messages: updatedMessages, isProcessing: false };

        if (res.connectionReceived && looksLikeConnectionString(trimmed)) {
          updates.connectionString = trimmed;
          useSchemaStore.getState().fetchTree(trimmed);
        }
        if (res.currentStep && res.currentStep >= 1 && res.currentStep <= 6) {
          updates.step = res.currentStep as EtlStep;
        }

        set(updates);

        const dashId = get().dashboardId;

        if (dashId && res.processedTable) {
          const pt = res.processedTable;
          useProcessedTableStore.getState().addOrUpdate({
            dashboardId: dashId,
            database: pt.database,
            table: pt.table,
            sourceTables: pt.sourceTables,
            fieldMappings: pt.fieldMappings || [],
            insertSql: pt.insertSql,
            processedAt: Date.now(),
          });
        }

        if (dashId && res.metricDef) {
          const md = res.metricDef;
          useMetricDefStore.getState().add({
            dashboardId: dashId,
            name: md.name,
            definition: md.definition,
            tables: md.tables || [],
            aggregation: md.aggregation || 'SUM',
            measureField: md.measureField || '',
          });
        }

        const finalState = get();
        if (finalState.dashboardId) persistState(finalState.dashboardId, toPersist(finalState));
      } catch (err) {
        const errText = err instanceof Error ? err.message : '请求失败';
        const updatedMessages = [...get().messages, sysMsg(`对话服务暂不可用：${errText}\n\n请检查后端与 DeepSeek 配置。`)];
        set({ messages: updatedMessages, isProcessing: false });
        const s = get();
        if (s.dashboardId) persistState(s.dashboardId, toPersist(s));
      }
    })();
  },

  reset: () => {
    const { dashboardId } = get();
    msgId = 0;
    const fresh = { ...getDefaultState(), dashboardId };
    set(fresh);
    if (dashboardId) persistState(dashboardId, toPersist(fresh));
  },
}));
