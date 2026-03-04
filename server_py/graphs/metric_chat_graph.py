"""Metric conversation LangGraph state graph (tool calling 版本)."""

import re
import json
import logging
from typing import TypedDict, Optional

from langgraph.graph import StateGraph, END

logger = logging.getLogger("etl.metric_graph")

from db.connection import get_connection_config
from db.operations import run_database_operation, safe_identifier
from llm.client import call_llm
from llm.tools import SQL_TOOLS, execute_tool_call
from utils.formatters import rows_to_markdown_table


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class MetricChatState(TypedDict):
    conversation: list
    connection_string: Optional[str]
    selected_tables: list
    schema_context: str
    render_blocks: dict
    llm_response: dict


# ---------------------------------------------------------------------------
# Node 1: fetch_schema_context (保持不变)
# ---------------------------------------------------------------------------

async def fetch_schema_context_node(state: MetricChatState) -> dict:
    connection_string = state.get('connection_string')
    selected = state.get('selected_tables', [])
    schema_context = ''

    if not connection_string:
        return {'schema_context': schema_context}

    if len(selected) > 0:
        schema_lines = []
        for tbl in selected:
            parts = tbl.split('.')
            if len(parts) == 2:
                desc_result = await run_database_operation(
                    connection_string, 'describeTable',
                    {'database': parts[0], 'table': parts[1]},
                )
                if desc_result['ok'] and desc_result.get('data', {}).get('columns'):
                    cols = '\n'.join(
                        f'    {c["Field"]} {c["Type"]}'
                        f'{" -- " + c["Comment"] if c.get("Comment") else ""}'
                        for c in desc_result['data']['columns']
                    )
                    schema_lines.append(f'  {tbl}:\n{cols}')
        if len(schema_lines) > 0:
            schema_context = (
                f'\n\n**可用表结构（仅限用户选中的 {len(selected)} 张表，严禁使用其他表）**：\n'
                f'{chr(10).join(schema_lines)}'
            )
    else:
        try:
            db_result = await run_database_operation(connection_string, 'listDatabases', {})
            if db_result['ok']:
                system_dbs = {
                    'information_schema', 'mysql', 'performance_schema',
                    'sys', 'mo_catalog', 'system', 'system_metrics',
                }
                databases = [
                    d['database']
                    for d in (db_result['data'].get('databases') or [])
                    if d.get('database') and d['database'].lower() not in system_dbs
                ]

                schema_lines = []
                for db_name in databases[:10]:
                    tbl_result = await run_database_operation(
                        connection_string, 'listTables', {'database': db_name},
                    )
                    if tbl_result['ok'] and tbl_result['data'].get('tables'):
                        for tbl_name in tbl_result['data']['tables'][:20]:
                            desc_result = await run_database_operation(
                                connection_string, 'describeTable',
                                {'database': db_name, 'table': tbl_name},
                            )
                            if desc_result['ok'] and desc_result.get('data', {}).get('columns'):
                                cols = '\n'.join(
                                    f'    {c["Field"]} {c["Type"]}'
                                    f'{" -- " + c["Comment"] if c.get("Comment") else ""}'
                                    for c in desc_result['data']['columns']
                                )
                                schema_lines.append(f'  {db_name}.{tbl_name}:\n{cols}')

                if len(schema_lines) > 0:
                    schema_context = f'\n\n**可用表结构**：\n{chr(10).join(schema_lines)}'
        except Exception:
            pass

    return {'schema_context': schema_context}


# ---------------------------------------------------------------------------
# Node 2: tool_calling_loop_node
# ---------------------------------------------------------------------------

async def tool_calling_loop_node(state: MetricChatState) -> dict:
    """调用 LLM（带 execute_sql 工具），循环处理 tool calls。"""
    conversation = state.get('conversation', [])
    connection_string = state.get('connection_string')
    selected = state.get('selected_tables', [])
    schema_context = state.get('schema_context', '')

    render_blocks = {}
    block_counter = [1]

    selected_tables_restriction = ''
    if len(selected) > 0:
        selected_tables_restriction = (
            f'\n**【严格限制】用户已在界面上选中了 {len(selected)} 张表'
            f'（{", ".join(selected)}）。'
            f'你必须且只能使用上方列出的表进行分析和建议。'
            f'绝对不要提及、推测或建议任何未列出的表。**\n'
        )

    system_prompt = f"""你是一个智能数据助手，同时具备**数据加工（ETL）**和**指标定义**两种能力。
{selected_tables_restriction}

**你有一个工具 `execute_sql`**，可以在用户的 MySQL 数据库上执行任意 SQL。需要查数据、建库、建表、写入数据时，直接调用工具执行 SQL 即可。你可以多次调用工具来完成多步操作。

## 能力一：数据加工（ETL）
你可以帮助用户完成完整的数据库操作，包括：
- 查看数据库列表、表列表、表结构、数据预览
- 创建数据库、创建表（需用户确认后执行）
- 执行 SQL 查询（SELECT 直接执行，INSERT/CREATE 等写操作需用户确认）
- 分析数据质量（空值率、异常值）
- 字段映射与数据加工（INSERT INTO ... SELECT）

**数据库操作规则**：
- 所有会修改库表或数据的操作（DDL、DML）必须先展示完整 SQL 并获用户确认后才能调用工具执行
- 只读操作（SELECT、DESCRIBE、SHOW）可直接调用工具执行
- 所有 SQL 必须严格符合 MySQL 语法
- 展示数据时必须用 markdown 表格，禁止 JSON
- 若工具执行失败，必须如实展示失败原因，不得声称成功

## 能力二：指标定义
你可以帮助用户定义纯度量指标（不含维度）：
- 指标 = 一个度量（如"收入"、"订单量"、"活跃用户数"）
- 维度在后续"添加监控数据"时由用户指定
- 指标定义需要明确：指标名称、计算逻辑描述、聚合方式、度量字段、涉及的表

**指标定义流程**：
1. 用户描述想要的指标
2. 你根据可用表结构分析可用字段
3. 给出聚合方式和度量字段建议
4. 用户确认后生成指标定义

## 如何判断用户意图
- 用户说「看看有哪些库」「查看表结构」「建表」「执行SQL」「加工数据」等 → 数据加工能力
- 用户说「定义指标」「我想看收入」「统计订单量」「添加指标」等 → 指标定义能力
- 两种能力可以混合使用，比如用户可能先查看表结构再定义指标

{schema_context}

**【数据块引用机制】**：
execute_sql 工具返回的结果中会包含「数据块 ID」（如 TABLE_1、SQL_1），这些 ID 对应真实的查询结果数据。
你在最终回复中**必须使用 `{{BLOCK_ID}}` 占位符**来引用这些数据，**严禁**自己手写或复制表格/SQL内容。
后端会自动将 `{{BLOCK_ID}}` 替换为真实内容。只引用工具返回中列出的数据块 ID，不要编造不存在的 ID。

**回复规则**：
- 用中文回复，简洁友好
- 若工具执行失败，必须如实输出失败原因，不得声称成功
- 若工具执行成功，必须以 markdown 表格展示数据。用 {{BLOCK_ID}} 引用数据块
- 所有写操作（CREATE TABLE、INSERT 等）必须先展示 SQL 并提示用户确认
- **凡涉及表数据展示的回答**，回复中**禁止出现 JSON**，必须用「SQL 代码块 + markdown 表格 + 返回码」三部分展示
- 表格内容必须与工具返回结果完全一致，不得编造

**输出格式**：只返回一个 JSON 对象，不要 markdown 代码块：

当还在讨论或执行数据库操作时：
{{"reply":"你的回复（可含 markdown，用 {{BLOCK_ID}} 引用数据块）"}}

当用户确认指标后（用户明确说确认/可以/没问题）：
{{"reply":"指标已创建：xxx","metricDef":{{"name":"指标名称","definition":"指标计算逻辑描述","tables":["db.table1"],"aggregation":"SUM","measureField":"amount"}}}}

**aggregation 可选值**：SUM、COUNT、AVG、COUNT_DISTINCT、MAX、MIN
**measureField**：被聚合的字段名
**重要**：只有用户明确确认后才返回 metricDef。讨论阶段不要返回 metricDef。"""

    messages = [
        {'role': 'system', 'content': system_prompt},
        *[{'role': t['role'], 'content': t['content']} for t in conversation],
    ]

    tools = SQL_TOOLS if connection_string else None

    MAX_TOOL_ROUNDS = 5
    try:
        for round_i in range(MAX_TOOL_ROUNDS):
            result = await call_llm(
                messages, tools=tools,
                temperature=0.3, max_tokens=4096,
                caller=f"metric_chat_r{round_i}",
            )

            if not result.get('ok'):
                return {
                    'llm_response': {
                        '_error': result.get('error') or '指标对话失败',
                        '_status': result.get('status', 500),
                    }
                }

            tool_calls = result.get('tool_calls')

            if not tool_calls:
                return _process_metric_response(
                    result.get('content', ''), render_blocks,
                )

            messages.append({
                'role': 'assistant',
                'content': result.get('content'),
                'tool_calls': [
                    {
                        'id': tc.id,
                        'type': 'function',
                        'function': {
                            'name': tc.function.name,
                            'arguments': tc.function.arguments,
                        },
                    }
                    for tc in tool_calls
                ],
            })

            for tc in tool_calls:
                logger.info("[Tool] call: %s args=%s", tc.function.name, tc.function.arguments[:200])
                tool_result = await execute_tool_call(
                    tc, connection_string, render_blocks, block_counter,
                )
                logger.info("[Tool] result: %s", tool_result[:200])
                messages.append({
                    'role': 'tool',
                    'tool_call_id': tc.id,
                    'content': tool_result,
                })

        # 超过最大轮次
        result = await call_llm(
            messages, temperature=0.3, max_tokens=4096,
            caller="metric_chat_final",
        )
        content = result.get('content', '') if result.get('ok') else '对话处理超时，请重试。'
        return _process_metric_response(content, render_blocks)

    except Exception as e:
        logger.error("[Metric] tool_calling_loop error: %s", e)
        return {
            'llm_response': {
                '_error': str(e) or '指标对话失败',
                '_status': 500,
            }
        }


def _process_metric_response(content, render_blocks):
    """处理 LLM 最终回复：解析 JSON、替换占位符。"""
    content = (content or '').strip()
    json_match = re.search(r'\{[\s\S]*\}', content)
    out = {'reply': content}
    if json_match:
        try:
            parsed = json.loads(json_match.group(0))
            if isinstance(parsed.get('reply'), str):
                out['reply'] = parsed['reply']
            if parsed.get('metricDef'):
                out['metricDef'] = parsed['metricDef']
        except (json.JSONDecodeError, ValueError):
            pass

    if render_blocks:
        reply = out['reply']
        for bid, content_val in render_blocks.items():
            reply = reply.replace('{{' + bid + '}}', content_val)
            reply = reply.replace('{' + bid + '}', content_val)
        out['reply'] = reply

    logger.info("[Metric] reply_len=%d has_metricDef=%s blocks=%s",
                len(out['reply']), 'metricDef' in out,
                list(render_blocks.keys()) if render_blocks else [])

    return {'llm_response': out}


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_metric_chat_graph():
    graph = StateGraph(MetricChatState)
    graph.add_node("fetch_schema_context", fetch_schema_context_node)
    graph.add_node("tool_calling_loop", tool_calling_loop_node)

    graph.set_entry_point("fetch_schema_context")
    graph.add_edge("fetch_schema_context", "tool_calling_loop")
    graph.add_edge("tool_calling_loop", END)

    return graph.compile()
