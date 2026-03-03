"""Metric conversation LangGraph state graph.

Migrated from server.js lines 1464-1727 (POST /api/metric-chat handler).
Linear graph: extract_intent_and_execute -> fetch_schema_context -> build_prompt_and_call_llm -> END
"""

import re
import json
from typing import TypedDict, Optional

from langgraph.graph import StateGraph, END

from db.connection import get_connection_config
from db.operations import run_database_operation, safe_identifier
from llm.client import call_llm
from llm.intent import extract_db_intent_from_model
from utils.formatters import rows_to_markdown_table
from utils.sql_parser import extract_table_refs_from_sql
from config import LLM_API_KEY


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class MetricChatState(TypedDict):
    conversation: list
    connection_string: Optional[str]
    selected_tables: list
    db_operation_note: str
    render_blocks: dict  # {block_id: actual_content} for placeholder replacement
    schema_context: str
    llm_response: dict


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _esc(name: str) -> str:
    s = safe_identifier(name)
    return f'`{s}`' if s else ''


# ---------------------------------------------------------------------------
# Node 1: extract_intent_and_execute
# ---------------------------------------------------------------------------

async def extract_intent_and_execute_node(state: MetricChatState) -> dict:
    connection_string = state.get('connection_string')
    conversation = state.get('conversation', [])
    selected = state.get('selected_tables', [])
    db_operation_note = ''
    render_blocks: dict[str, str] = {}

    if not connection_string:
        return {'db_operation_note': db_operation_note, 'render_blocks': render_blocks}

    db_intent = await extract_db_intent_from_model(conversation, LLM_API_KEY)

    if not db_intent.get('intent'):
        return {'db_operation_note': db_operation_note, 'render_blocks': render_blocks}

    intent = db_intent['intent']
    params = db_intent.get('params', {})
    db = safe_identifier(params.get('database')) or None
    tbl = safe_identifier(params.get('table')) or None
    full_tbl = ''
    if tbl:
        full_tbl = f'{_esc(db)}.{_esc(tbl)}' if db else _esc(tbl)

    # ── describeTable: schema + preview ──
    if intent == 'describeTable':
        schema_result = await run_database_operation(connection_string, 'describeTable', params)
        preview_result = await run_database_operation(connection_string, 'previewData', {**params, 'limit': 10})

        available = []
        return_codes = []

        if schema_result['ok']:
            cols = schema_result['data'].get('columns') or []
            table_schema = rows_to_markdown_table(cols, ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'])
            return_codes.append(f'DESCRIBE 执行成功，返回列数: {len(cols)}')
            render_blocks['SQL_SCHEMA'] = f'```sql\nDESCRIBE {full_tbl};\n```'
            render_blocks['TABLE_SCHEMA'] = table_schema
            available.append(f'SQL_SCHEMA: DESCRIBE语句')
            available.append(f'TABLE_SCHEMA: 表结构({len(cols)}列)')
        else:
            err = schema_result.get('error', '')
            return_codes.append(f'DESCRIBE 执行失败: {err}')
            render_blocks['ERR_SCHEMA'] = f'**表结构查询失败**：{err}'
            available.append('ERR_SCHEMA: 表结构查询失败信息')

        if preview_result['ok']:
            rows = preview_result['data'].get('rows') or []
            table_preview = rows_to_markdown_table(rows)
            return_codes.append(f'SELECT 执行成功，返回行数: {len(rows)}')
            render_blocks['SQL_PREVIEW'] = f'```sql\nSELECT * FROM {full_tbl} LIMIT 10;\n```'
            render_blocks['TABLE_PREVIEW'] = table_preview
            available.append('SQL_PREVIEW: SELECT预览语句')
            available.append(f'TABLE_PREVIEW: 前10条数据({len(rows)}行)')

        render_blocks['RETURN_CODE'] = '；'.join(return_codes)
        available.append('RETURN_CODE: SQL返回码')

        db_operation_note = (
            f'\n\n**【数据库操作结果】** 已查询表 {full_tbl} 的结构和数据预览。\n'
            f'可用数据块：\n' + '\n'.join(f'- {a}' for a in available)
        )
        return {'db_operation_note': db_operation_note, 'render_blocks': render_blocks}

    # ── All other intents ──
    op_result = await run_database_operation(connection_string, intent, params)

    if op_result['ok']:
        d = op_result['data']
        available = []

        if intent == 'listDatabases':
            databases = d.get('databases') or []
            if len(selected) > 0:
                selected_dbs = set(s.split('.')[0] for s in selected)
                databases = [item for item in databases if item.get('database') in selected_dbs]
            table = rows_to_markdown_table(databases, ['database', 'tableCount'])
            code = f'返回数据库数: {len(databases)}'
            render_blocks['TABLE_1'] = table
            render_blocks['RETURN_CODE'] = code
            available.append(f'TABLE_1: 数据库列表({len(databases)}个)')
            available.append('RETURN_CODE: SQL返回码')

        elif intent == 'listTables':
            tables = d.get('tables') or []
            if len(selected) > 0 and db:
                allowed_tables = set(
                    s.split('.')[1] for s in selected if s.startswith(db + '.')
                )
                if len(allowed_tables) > 0:
                    tables = [t for t in tables if t in allowed_tables]
            rows = [{'表名': t} for t in tables]
            table = rows_to_markdown_table(rows, ['表名'])
            code = f'返回表数量: {len(tables)}'
            render_blocks['TABLE_1'] = table
            render_blocks['RETURN_CODE'] = code
            available.append(f'TABLE_1: 表列表({len(tables)}个)')
            available.append('RETURN_CODE: SQL返回码')

        elif intent == 'previewData':
            table = rows_to_markdown_table(d.get('rows') or [])
            row_count = d.get('rowCount') if d.get('rowCount') is not None else len(d.get('rows') or [])
            code = f'返回行数: {row_count}'
            render_blocks['TABLE_1'] = table
            render_blocks['RETURN_CODE'] = code
            available.append(f'TABLE_1: 数据预览({row_count}行)')
            available.append('RETURN_CODE: SQL返回码')

        elif intent == 'analyzeNulls':
            table = rows_to_markdown_table(d.get('columns') or [], ['column', 'nullCount', 'nullRate'])
            total_rows = d.get('totalRows', '-')
            code = f'总行数: {total_rows}'
            render_blocks['TABLE_1'] = table
            render_blocks['RETURN_CODE'] = code
            available.append(f'TABLE_1: 空值统计表')
            available.append('RETURN_CODE: SQL返回码')

        elif intent == 'executeSQL' and d.get('rows') is not None and len(d.get('rows', [])) > 0:
            sql = str(params.get('sql') or '').strip()
            table = rows_to_markdown_table(d['rows'])
            exec_code = (d.get('executionSummary') or {}).get('message') or f'执行成功，返回行数: {len(d["rows"])}'
            render_blocks['SQL_1'] = f'```sql\n{sql}\n```'
            render_blocks['TABLE_1'] = table
            render_blocks['RETURN_CODE'] = exec_code
            available.append('SQL_1: 执行的SQL')
            available.append(f'TABLE_1: 查询结果({len(d["rows"])}行)')
            available.append('RETURN_CODE: SQL返回码')

        elif intent == 'executeSQL':
            sql = str(params.get('sql') or '').strip()
            exec_code = (d.get('executionSummary') or {}).get('message') or '执行完成。'
            render_blocks['SQL_1'] = f'```sql\n{sql}\n```'
            render_blocks['RETURN_CODE'] = exec_code
            available.append('SQL_1: 执行的SQL')
            available.append('RETURN_CODE: SQL返回码')

        elif intent == 'createTable':
            render_blocks['RESULT'] = d.get('message') or '表已创建'
            available.append('RESULT: 建表结果')

        elif intent == 'createDatabase':
            render_blocks['RESULT'] = d.get('message') or '数据库已创建'
            available.append('RESULT: 建库结果')

        else:
            render_blocks['DATA_JSON'] = f'```json\n{json.dumps(d, ensure_ascii=False, indent=2)}\n```'
            available.append('DATA_JSON: 返回数据')

        db_operation_note = (
            f'\n\n**【数据库操作结果】** 执行「{intent}」**成功**。\n'
            f'可用数据块：\n' + '\n'.join(f'- {a}' for a in available)
        )

    else:
        err_msg = op_result.get('error') or ''

        # Column-name error auto-correction
        schema_block = ''
        is_column_error = bool(re.search(
            r"column\s+['\`]?\w+['\`]?\s+does not exist|Unknown column|doesn't have column",
            err_msg,
            re.IGNORECASE,
        ))
        if intent == 'executeSQL' and is_column_error and params.get('sql'):
            table_refs = extract_table_refs_from_sql(params['sql'])
            block_idx = 1
            schema_avail = []
            for ref in table_refs:
                desc = await run_database_operation(
                    connection_string, 'describeTable',
                    {'database': ref.get('database'), 'table': ref['table']},
                )
                if desc['ok'] and desc.get('data') and desc['data'].get('columns'):
                    full_name = (
                        f'{ref["database"]}.{ref["table"]}' if ref.get('database') else ref['table']
                    )
                    table_schema = rows_to_markdown_table(
                        desc['data']['columns'],
                        ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'],
                    )
                    bid = f'FIX_SCHEMA_{block_idx}'
                    render_blocks[bid] = f'**表 {full_name} 的真实结构**：\n{table_schema}'
                    schema_avail.append(f'- {bid}: 表 {full_name} 的结构({len(desc["data"]["columns"])}列)')
                    block_idx += 1
            if len(schema_avail) > 0:
                schema_block = (
                    f'\n\n**【自我纠正】** 已自动查询涉及表的结构。'
                    f'请根据真实列名给出修正后的 SQL。\n\n'
                    '可用数据块（使用 {{BLOCK_ID}} 引用）：\n' + '\n'.join(schema_avail)
                )

        db_operation_note = (
            f'\n\n**【数据库操作结果】** 执行「{intent}」**失败**。\n'
            f'**失败原因**：{err_msg}\n'
            f'请如实告知用户失败原因并给出修改建议。{schema_block}'
        )

    return {'db_operation_note': db_operation_note, 'render_blocks': render_blocks}


# ---------------------------------------------------------------------------
# Node 2: fetch_schema_context
# ---------------------------------------------------------------------------

async def fetch_schema_context_node(state: MetricChatState) -> dict:
    connection_string = state.get('connection_string')
    selected = state.get('selected_tables', [])
    schema_context = ''

    if not connection_string:
        return {'schema_context': schema_context}

    if len(selected) > 0:
        # Query DESCRIBE for each selected table
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
        # Full scan
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
            pass  # ignore schema fetch errors

    return {'schema_context': schema_context}


# ---------------------------------------------------------------------------
# Node 3: build_prompt_and_call_llm
# ---------------------------------------------------------------------------

async def build_prompt_and_call_llm_node(state: MetricChatState) -> dict:
    conversation = state.get('conversation', [])
    selected = state.get('selected_tables', [])
    schema_context = state.get('schema_context', '')
    db_operation_note = state.get('db_operation_note', '')
    render_blocks = state.get('render_blocks', {})

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

## 能力一：数据加工（ETL）
你可以帮助用户完成完整的数据库操作，包括：
- 查看数据库列表、表列表、表结构、数据预览
- 创建数据库、创建表（需用户确认后执行）
- 执行 SQL 查询（SELECT 直接执行，INSERT/CREATE 等写操作需用户确认）
- 分析数据质量（空值率、异常值）
- 字段映射与数据加工（INSERT INTO ... SELECT）

**数据库操作规则**：
- 所有会修改库表或数据的操作（DDL、DML）必须先展示完整 SQL 并获用户确认后才能执行
- 只读操作（SELECT、DESCRIBE、SHOW）可直接执行
- 所有 SQL 必须严格符合 MySQL 语法
- 展示数据时必须用 markdown 表格，禁止 JSON
- 若有【数据库操作结果】，必须如实展示，不得编造

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
{db_operation_note}

**【数据块引用机制】**：
当【数据库操作结果】中列出了「可用数据块」时，你**必须使用 `{{BLOCK_ID}}` 占位符**来引用数据，**严禁**自己手写或复制表格/SQL内容。
后端会自动将 `{{BLOCK_ID}}` 替换为真实内容。只引用已列出的 BLOCK_ID，不要编造不存在的 ID。

**回复规则**：
- 用中文回复，简洁友好
- 若有【数据库操作结果】且为失败，必须如实输出失败原因
- 若有【数据库操作结果】且为成功，必须以 markdown 表格展示数据。有「可用数据块」时用 {{{{BLOCK_ID}}}} 引用
- 若本轮没有【数据库操作结果】，不得声称已执行任何数据库操作
- 所有写操作（CREATE TABLE、INSERT 等）必须先展示 SQL 并提示用户确认

**输出格式**：只返回一个 JSON 对象，不要 markdown 代码块：

当还在讨论或执行数据库操作时：
{{"reply":"你的回复（可含 markdown，有可用数据块时用 {{{{BLOCK_ID}}}} 引用）"}}

当用户确认指标后（用户明确说确认/可以/没问题）：
{{"reply":"指标已创建：xxx","metricDef":{{"name":"指标名称","definition":"指标计算逻辑描述","tables":["db.table1"],"aggregation":"SUM","measureField":"amount"}}}}

**aggregation 可选值**：SUM、COUNT、AVG、COUNT_DISTINCT、MAX、MIN
**measureField**：被聚合的字段名

**重要**：只有用户明确确认后才返回 metricDef。讨论阶段不要返回 metricDef。"""

    messages = [
        {'role': 'system', 'content': system_prompt},
        *[{'role': t['role'], 'content': t['content']} for t in conversation],
    ]

    result = await call_llm(messages, temperature=0.3, max_tokens=4096)

    if not result.get('ok'):
        return {
            'llm_response': {
                '_error': result.get('error') or '指标对话失败',
                '_status': result.get('status', 500),
            },
        }

    content = (result.get('content') or '').strip()
    json_match = re.search(r'\{[\s\S]*\}', content)
    out: dict = {'reply': content}
    if json_match:
        try:
            parsed = json.loads(json_match.group(0))
            if isinstance(parsed.get('reply'), str):
                out['reply'] = parsed['reply']
            if parsed.get('metricDef'):
                out['metricDef'] = parsed['metricDef']
        except (json.JSONDecodeError, ValueError):
            pass

    # Replace {{BLOCK_ID}} placeholders with actual content
    if render_blocks:
        reply = out['reply']
        for bid, content_val in render_blocks.items():
            reply = reply.replace('{{' + bid + '}}', content_val)
        out['reply'] = reply

    return {'llm_response': out}


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_metric_chat_graph():
    graph = StateGraph(MetricChatState)
    graph.add_node("extract_intent_and_execute", extract_intent_and_execute_node)
    graph.add_node("fetch_schema_context", fetch_schema_context_node)
    graph.add_node("build_prompt_and_call_llm", build_prompt_and_call_llm_node)

    graph.set_entry_point("extract_intent_and_execute")
    graph.add_edge("extract_intent_and_execute", "fetch_schema_context")
    graph.add_edge("fetch_schema_context", "build_prompt_and_call_llm")
    graph.add_edge("build_prompt_and_call_llm", END)

    return graph.compile()
