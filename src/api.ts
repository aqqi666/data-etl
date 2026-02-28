export interface MappingFromModel {
  targetField: string;
  source: string;
  logic: string;
  sql: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  connectionString?: string | null;
  /** 当前 ETL 步骤 1～6，后端仅执行本步操作 */
  currentStep?: number;
}

export interface ChatApiResponse {
  reply: string;
  connectionReceived?: boolean;
  /** 本轮是否有一次连接测试且为成功 */
  connectionTestOk?: boolean;
  /** 模型判断的当前步骤 1～6 */
  currentStep?: number;
}

export async function fetchChatWithModel(
  conversation: ConversationTurn[],
  context: ChatContext,
): Promise<ChatApiResponse> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation, context }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface MappingApiRequest {
  /** 当前轮用户输入（保留兼容） */
  message: string;
  /** 完整对话历史，供 DeepSeek 结合上下文理解与转换 */
  conversation?: ConversationTurn[];
  targetTableName: string;
  targetFields: { name: string; type: string; comment: string }[];
  existingMappings: { targetField: string; source: string; logic: string; sql: string; status: string }[];
}

export interface MappingApiResponse {
  mappings: MappingFromModel[];
}

export async function fetchMappingsFromModel(
  payload: MappingApiRequest,
): Promise<MappingApiResponse> {
  const res = await fetch('/api/mapping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface DmlApiRequest {
  targetTableFullName: string;
  mappings: { targetField: string; source: string; logic: string; sql: string }[];
}

export interface DmlApiResponse {
  dml: string;
}

export async function fetchDmlFromModel(payload: DmlApiRequest): Promise<DmlApiResponse> {
  const res = await fetch('/api/dml', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** 根据当前 SQL 让模型优化（如子查询改 JOIN） */
export async function fetchOptimizeDml(currentDml: string): Promise<DmlApiResponse> {
  const res = await fetch('/api/dml/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dml: currentDml }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}
