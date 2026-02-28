import { create } from 'zustand';
import type { ChatMessage, ContentBlock, EtlStep } from './types';
import type { ConversationTurn } from './api';
import { fetchChatWithModel } from './api';

let msgId = 0;
const nextId = () => `msg-${++msgId}`;

function sysMsg(...contents: ContentBlock[]): ChatMessage {
  return { id: nextId(), role: 'system', contents, timestamp: Date.now() };
}
function userMsg(text: string): ChatMessage {
  return { id: nextId(), role: 'user', contents: [{ type: 'text', text }], timestamp: Date.now() };
}

interface AppState {
  step: EtlStep;
  connectionString: string | null;
  messages: ChatMessage[];
  isProcessing: boolean;

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

const initialState = {
  step: 1 as EtlStep,
  connectionString: null as string | null,
  messages: [getIntroMessage()],
  isProcessing: false,
};

function looksLikeConnectionString(s: string): boolean {
  if (/^mysql:\/\//i.test(s) || (/^[a-z]+:\/\//i.test(s) && s.includes('@') && /:\d+/.test(s))) return true;
  return /mysql\s+.+-h\s+/i.test(s) && (/-u\s/i.test(s) || /-u'/.test(s));
}

function wantsDemoGuide(text: string): boolean {
  const t = text.trim();
  return /操作指南|看演示|看指南|^演示$|^指南$/.test(t) || /^[1一]\.?\s*看/.test(t);
}

/** 演示每条消息的展示间隔（ms）：助手回复按内容长度加长，符合阅读节奏 */
function getDemoMessageDelay(msg: ChatMessage): number {
  const base = 1200;
  if (msg.role === 'user') return base;
  const text = msg.contents[0]?.type === 'text' ? msg.contents[0].text : '';
  const len = text.length;
  const extra = Math.min(3500, Math.floor(len / 50) * 250);
  return base + extra;
}

export const useStore = create<AppState>((set, get) => ({
  ...initialState,

  sendMessage: (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const { messages, step } = get();
    set({ messages: [...messages, userMsg(trimmed)], isProcessing: true });

    if (step === 1 && wantsDemoGuide(trimmed)) {
      const demoList = getDemoConversationMessages();
      let idx = 0;
      const run = () => {
        if (idx >= demoList.length) {
          set({ isProcessing: false });
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
        const res = await fetchChatWithModel(conversation, {
          connectionString: get().connectionString || undefined,
          currentStep: get().step,
        });

        const newMessages = [...get().messages];
        newMessages.push(sysMsg({ type: 'text', text: res.reply }));

        const updates: Partial<AppState> = { messages: newMessages, isProcessing: false };

        if (res.connectionReceived && looksLikeConnectionString(trimmed)) {
          updates.connectionString = trimmed;
        }
        if (res.currentStep && res.currentStep >= 1 && res.currentStep <= 6) {
          updates.step = res.currentStep as EtlStep;
        }

        set(updates);
      } catch (err) {
        const newMessages = [...get().messages];
        const errText = err instanceof Error ? err.message : '请求失败';
        newMessages.push(
          sysMsg({ type: 'text', text: `对话服务暂不可用：${errText}\n\n请检查后端与 DeepSeek 配置。` }),
        );
        set({ messages: newMessages, isProcessing: false });
      }
    })();
  },

  reset: () => {
    msgId = 0;
    set({ ...initialState, messages: [getIntroMessage()] });
  },
}));
