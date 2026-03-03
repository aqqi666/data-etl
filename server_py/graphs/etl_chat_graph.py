"""ETL conversation LangGraph state graph.

Migrated from server.js lines 367-648 (POST /api/chat handler).
"""

import json
import logging
import re
from typing import TypedDict, Optional

from langgraph.graph import StateGraph, END

logger = logging.getLogger("etl.graph")

from db.connection import looks_like_connection_string, test_connection, get_connection_config
from db.operations import run_database_operation, safe_identifier, VALID_INTENTS
from llm.client import call_llm
from llm.intent import extract_db_intent_from_model
from utils.formatters import rows_to_markdown_table
from utils.sql_parser import extract_table_refs_from_sql
from config import LLM_API_KEY


# ---------------------------------------------------------------------------
# State type
# ---------------------------------------------------------------------------

class ETLChatState(TypedDict):
    conversation: list
    context: dict  # {connectionString, currentStep, selectedTables}
    connection_string: Optional[str]
    should_test_connection: bool
    conn_str_to_test: Optional[str]
    connection_test_note: str
    connection_test_ok: bool
    last_user_content: str
    last_message_is_only_connection_string: bool
    current_step_hint: int
    selected_tables: list
    db_intent: dict
    db_operation_note: str
    render_blocks: dict  # {block_id: actual_content} for placeholder replacement
    selected_tables_note: str
    llm_response: dict


# ---------------------------------------------------------------------------
# Node 1: parse_input
# ---------------------------------------------------------------------------

async def parse_input(state: dict) -> dict:
    """Extract and compute all fields from conversation and context."""
    conversation = state.get("conversation", [])
    context = state.get("context", {}) or {}

    connection_string_from_context = context.get("connectionString") or None
    current_step_hint = int(context.get("currentStep", 0) or 0)
    selected_tables = context.get("selectedTables", [])
    if not isinstance(selected_tables, list):
        selected_tables = []

    user_messages = [
        (t.get("content") or "").strip()
        for t in conversation
        if t.get("role") == "user"
    ]
    last_user_content = user_messages[-1] if user_messages else ""

    # Find the last user message that looks like a connection string
    last_connection_string_in_chat = None
    for msg in reversed(user_messages):
        if looks_like_connection_string(msg):
            last_connection_string_in_chat = msg
            break

    connection_string = (
        connection_string_from_context
        or last_connection_string_in_chat
        or None
    )

    # Determine shouldTestConnection
    should_test_connection = bool(
        (last_user_content and looks_like_connection_string(last_user_content))
        or (
            last_user_content
            and re.search(r"测试|试一下|验证|检查", last_user_content)
            and re.search(r"连接|连接串|连通", last_user_content)
            and last_connection_string_in_chat
        )
    )

    # Determine connStrToTest
    if looks_like_connection_string(last_user_content):
        conn_str_to_test = last_user_content
    else:
        conn_str_to_test = last_connection_string_in_chat

    # Determine lastMessageIsOnlyConnectionString
    last_message_is_only_connection_string = bool(
        last_user_content
        and looks_like_connection_string(last_user_content)
        and len(last_user_content.strip()) < 500
    )

    return {
        "connection_string": connection_string,
        "should_test_connection": should_test_connection,
        "conn_str_to_test": conn_str_to_test,
        "connection_test_note": "",
        "connection_test_ok": False,
        "last_user_content": last_user_content,
        "last_message_is_only_connection_string": last_message_is_only_connection_string,
        "current_step_hint": current_step_hint,
        "selected_tables": selected_tables,
        "db_intent": {"intent": None, "params": {}},
        "db_operation_note": "",
        "render_blocks": {},
        "selected_tables_note": "",
    }


# ---------------------------------------------------------------------------
# Node 2: test_connection_node
# ---------------------------------------------------------------------------

async def test_connection_node(state: dict) -> dict:
    """Test the MySQL connection if requested."""
    should_test = state.get("should_test_connection", False)
    conn_str_to_test = state.get("conn_str_to_test")

    if not should_test or not conn_str_to_test:
        return {"connection_test_note": "", "connection_test_ok": False}

    try:
        test_result = await test_connection(conn_str_to_test)
        connection_test_ok = bool(test_result.get("ok"))
        if test_result.get("ok"):
            connection_test_note = (
                "\n\n**【连接测试结果】** 连通性测试：**成功**。"
            )
        else:
            connection_test_note = (
                f'\n\n**【连接测试结果】** 连通性测试：**失败**，原因：{test_result.get("message")}'
            )
    except Exception as e:
        connection_test_ok = False
        connection_test_note = f"\n\n**【连接测试结果】** 异常：{e}"

    return {
        "connection_test_note": connection_test_note,
        "connection_test_ok": connection_test_ok,
    }


# ---------------------------------------------------------------------------
# Node 3: extract_intent_node
# ---------------------------------------------------------------------------

async def extract_intent_node(state: dict) -> dict:
    """Extract the database operation intent from the conversation."""
    connection_string = state.get("connection_string")
    last_user_content = state.get("last_user_content", "")
    last_message_is_only_connection_string = state.get(
        "last_message_is_only_connection_string", False
    )
    conversation = state.get("conversation", [])

    if (
        connection_string
        and last_user_content
        and not last_message_is_only_connection_string
    ):
        db_intent = await extract_db_intent_from_model(conversation, LLM_API_KEY)
    else:
        logger.info("[Intent] 跳过意图提取: conn=%s user=%s only_conn=%s",
                    bool(connection_string), bool(last_user_content), last_message_is_only_connection_string)
        db_intent = {"intent": None, "params": {}}

    return {"db_intent": db_intent}


# ---------------------------------------------------------------------------
# Node 4: execute_db_operation_node
# ---------------------------------------------------------------------------

async def execute_db_operation_node(state: dict) -> dict:
    """Execute the database operation based on the extracted intent.

    Produces:
    - render_blocks: dict mapping block IDs to their full markdown content.
      The LLM will reference these via {{BLOCK_ID}} placeholders; the backend
      replaces them after the LLM responds.
    - db_operation_note: a compact summary for the LLM prompt listing
      available block IDs (no full data).
    """
    connection_string = state.get("connection_string")
    db_intent = state.get("db_intent", {})
    selected_tables = state.get("selected_tables", [])

    if not connection_string or not db_intent.get("intent"):
        return {"db_operation_note": "", "render_blocks": {}}

    # Helper: escape identifier
    def _esc(n):
        s = safe_identifier(n)
        return f"`{s}`" if s else ""

    db = safe_identifier(db_intent.get("params", {}).get("database")) or None
    tbl = safe_identifier(db_intent.get("params", {}).get("table")) or None
    full_tbl = ""
    if tbl:
        full_tbl = f"{_esc(db)}.{_esc(tbl)}" if db else _esc(tbl)

    # Parse selectedTables into {db -> set(tables)} mapping
    selected_db_tables = {}  # db -> set of tables
    for st in selected_tables:
        dot = st.find(".")
        if dot > 0:
            sdb = st[:dot]
            stbl = st[dot + 1 :]
            if sdb not in selected_db_tables:
                selected_db_tables[sdb] = set()
            selected_db_tables[sdb].add(stbl)
    has_selection = len(selected_db_tables) > 0

    intent = db_intent["intent"]
    params = db_intent.get("params", {})
    render_blocks: dict[str, str] = {}
    db_operation_note = ""

    # ── describeTable: dual query (schema + preview) ──
    if intent == "describeTable":
        schema_result = await run_database_operation(
            connection_string, "describeTable", params
        )
        preview_result = await run_database_operation(
            connection_string, "previewData", {**params, "limit": 10}
        )
        sql_describe = f"DESCRIBE {full_tbl};"
        sql_preview = f"SELECT * FROM {full_tbl} LIMIT 10;"
        available = []
        return_codes = []

        if schema_result.get("ok"):
            cols = (schema_result.get("data") or {}).get("columns", [])
            table_schema = rows_to_markdown_table(
                cols, ["Field", "Type", "Null", "Key", "Default", "Extra"]
            )
            return_codes.append(f"DESCRIBE 执行成功，返回列数: {len(cols)}")
            render_blocks["SQL_SCHEMA"] = f"```sql\n{sql_describe}\n```"
            render_blocks["TABLE_SCHEMA"] = table_schema
            available.append("SQL_SCHEMA: DESCRIBE语句")
            available.append(f"TABLE_SCHEMA: 表结构({len(cols)}列)")
        else:
            err = (schema_result.get("error") or "")
            return_codes.append(f"DESCRIBE 执行失败: {err}")
            render_blocks["ERR_SCHEMA"] = f"**表结构查询失败**：{err}"
            available.append("ERR_SCHEMA: 表结构查询失败信息")

        if preview_result.get("ok"):
            rows = (preview_result.get("data") or {}).get("rows", [])
            table_preview = rows_to_markdown_table(rows)
            return_codes.append(f"SELECT 执行成功，返回行数: {len(rows)}")
            render_blocks["SQL_PREVIEW"] = f"```sql\n{sql_preview}\n```"
            render_blocks["DATA_PREVIEW"] = table_preview
            available.append("SQL_PREVIEW: SELECT预览语句")
            available.append(f"DATA_PREVIEW: 前10条数据({len(rows)}行)")
        else:
            err = (preview_result.get("error") or "")
            return_codes.append(f"SELECT 执行失败: {err}")
            render_blocks["ERR_PREVIEW"] = f"**数据预览失败**：{err}"
            available.append("ERR_PREVIEW: 数据预览失败信息")

        render_blocks["RETURN_CODE"] = "；".join(return_codes)
        available.append("RETURN_CODE: SQL返回码")

        db_operation_note = (
            f"\n\n**【数据库操作结果】** 已查询表 {full_tbl} 的结构和数据预览。\n"
            f"可用数据块：\n" + "\n".join(f"- {a}" for a in available)
        )

    # ── All other intents ──
    else:
        op_result = await run_database_operation(connection_string, intent, params)

        if op_result.get("ok"):
            d = op_result.get("data", {}) or {}
            available = []

            if intent == "listDatabases":
                databases = d.get("databases", [])
                if has_selection:
                    databases = [
                        item
                        for item in databases
                        if item.get("database") in selected_db_tables
                    ]
                sql = (
                    "SHOW DATABASES;（已按用户选择过滤）"
                    if has_selection
                    else "SHOW DATABASES;（并 SHOW TABLES FROM 各库统计表数）"
                )
                table = rows_to_markdown_table(databases, ["database", "tableCount"])
                code = f"执行成功，返回数据库数: {len(databases)}"
                render_blocks["SQL_1"] = f"```sql\n{sql}\n```"
                render_blocks["TABLE_1"] = table
                render_blocks["RETURN_CODE"] = code
                available.append("SQL_1: 查询SQL")
                available.append(f"TABLE_1: 数据库列表({len(databases)}个)")
                available.append("RETURN_CODE: SQL返回码")

            elif intent == "listTables":
                tables = d.get("tables", [])
                query_db = db or None
                if has_selection and query_db and query_db in selected_db_tables:
                    allowed = selected_db_tables[query_db]
                    tables = [t for t in tables if t in allowed]
                elif has_selection and not query_db:
                    tables = []
                sql = f"SHOW TABLES FROM {_esc(db)};" if db else "SHOW TABLES;"
                rows = [{"表名": t} for t in tables]
                table = rows_to_markdown_table(rows, ["表名"])
                code = f"执行成功，返回表数量: {len(d.get('tables', []))}"
                render_blocks["SQL_1"] = f"```sql\n{sql}\n```"
                render_blocks["TABLE_1"] = table
                render_blocks["RETURN_CODE"] = code
                available.append("SQL_1: 查询SQL")
                available.append(f"TABLE_1: 表列表({len(tables)}个)")
                available.append("RETURN_CODE: SQL返回码")

            elif intent == "previewData":
                limit = min(int(params.get("limit") or 10), 50)
                sql = f"SELECT * FROM {full_tbl} LIMIT {limit};"
                table = rows_to_markdown_table(d.get("rows", []))
                row_count = d.get("rowCount", len(d.get("rows", [])))
                code = f"执行成功，返回行数: {row_count}"
                render_blocks["SQL_1"] = f"```sql\n{sql}\n```"
                render_blocks["TABLE_1"] = table
                render_blocks["RETURN_CODE"] = code
                available.append("SQL_1: 查询SQL")
                available.append(f"TABLE_1: 数据预览({row_count}行)")
                available.append("RETURN_CODE: SQL返回码")

            elif intent == "analyzeNulls":
                sql = (
                    f"SELECT COUNT(*) AS total FROM {full_tbl}; "
                    f"以及各列空值统计的 SELECT SUM(CASE WHEN 列 IS NULL THEN 1 ELSE 0 END)... FROM {full_tbl};"
                )
                table = rows_to_markdown_table(
                    d.get("columns", []), ["column", "nullCount", "nullRate"]
                )
                total_rows = d.get("totalRows", "-")
                col_count = len(d.get("columns", []))
                code = f"执行成功，总行数: {total_rows}，统计列数: {col_count}"
                render_blocks["SQL_1"] = f"```sql\n{sql}\n```"
                render_blocks["TABLE_1"] = table
                render_blocks["RETURN_CODE"] = code
                available.append("SQL_1: 空值分析SQL")
                available.append(f"TABLE_1: 空值统计表({col_count}列)")
                available.append("RETURN_CODE: SQL返回码")

            elif intent == "executeSQL" and d.get("rows") is not None and len(d.get("rows", [])) > 0:
                sql = str(params.get("sql") or "").strip()
                table = rows_to_markdown_table(d["rows"])
                exec_summary = d.get("executionSummary", {}) or {}
                code = exec_summary.get("message") or f"执行成功，返回行数: {len(d['rows'])}"
                render_blocks["SQL_1"] = f"```sql\n{sql}\n```"
                render_blocks["TABLE_1"] = table
                render_blocks["RETURN_CODE"] = code
                available.append("SQL_1: 执行的SQL")
                available.append(f"TABLE_1: 查询结果({len(d['rows'])}行)")
                available.append("RETURN_CODE: SQL返回码")

            elif intent == "executeSQL":
                sql = str(params.get("sql") or "").strip()
                exec_summary = d.get("executionSummary", {}) or {}
                code = exec_summary.get("message") or "执行完成。"
                render_blocks["SQL_1"] = f"```sql\n{sql}\n```"
                render_blocks["RETURN_CODE"] = code
                available.append("SQL_1: 执行的SQL")
                available.append("RETURN_CODE: SQL返回码")

            else:
                render_blocks["DATA_JSON"] = f"```json\n{json.dumps(d, ensure_ascii=False, indent=2)}\n```"
                available.append("DATA_JSON: 返回数据")

            db_operation_note = (
                f'\n\n**【数据库操作结果】** 执行「{intent}」**成功**。\n'
                f"可用数据块：\n" + "\n".join(f"- {a}" for a in available)
            )

        else:
            # ── Operation failed ──
            err_msg = op_result.get("error", "")
            is_column_error = bool(
                re.search(
                    r"column\s+['\`]?\w+['\`]?\s+does not exist"
                    r"|Unknown column"
                    r"|doesn't have column"
                    r"|invalid input.*column",
                    err_msg,
                    re.IGNORECASE,
                )
            )

            schema_block = ""
            if intent == "executeSQL" and is_column_error and params.get("sql"):
                table_refs = extract_table_refs_from_sql(params["sql"])
                schema_parts = []
                block_idx = 1
                for ref in table_refs:
                    desc = await run_database_operation(
                        connection_string,
                        "describeTable",
                        {"database": ref.get("database"), "table": ref["table"]},
                    )
                    if (
                        desc.get("ok")
                        and desc.get("data")
                        and desc["data"].get("columns")
                    ):
                        full_name = (
                            f'{ref["database"]}.{ref["table"]}'
                            if ref.get("database")
                            else ref["table"]
                        )
                        table_schema = rows_to_markdown_table(
                            desc["data"]["columns"],
                            ["Field", "Type", "Null", "Key", "Default", "Extra"],
                        )
                        bid = f"FIX_SCHEMA_{block_idx}"
                        render_blocks[bid] = f"**表 {full_name} 的真实结构**：\n{table_schema}"
                        schema_parts.append(f"- {bid}: 表 {full_name} 的结构({len(desc['data']['columns'])}列)")
                        block_idx += 1
                if schema_parts:
                    schema_block = (
                        "\n\n**【自我纠正】** 已根据失败 SQL 自动查询涉及表的结构（真实列名）。"
                        "你**必须**在回复中：(1) 如实转述失败原因；"
                        "(2) 根据下方真实列名写出**修正后的完整 SQL**（代码块）；"
                        "(3) 明确提示用户「请再次执行上述 SQL」直至成功。"
                        "不得只建议用户自己去 DESCRIBE，而要直接给出可执行的修正 SQL。\n"
                        "可用数据块（使用 {{BLOCK_ID}} 引用）：\n" + "\n".join(schema_parts)
                    )

            db_operation_note = (
                f'\n\n**【数据库操作结果】** 执行「{intent}」**失败**。\n'
                f"**失败原因（你必须原样或完整转述给用户，不得隐瞒、不得声称成功）**：\n"
                f"{err_msg}\n\n"
                f"请根据上述原因给出修改建议（如：SQL 语法、表名/库名、权限、列名不存在等），"
                f"并请用户修正后重试。{schema_block}"
            )

    if render_blocks:
        logger.info("[DB] intent=%s blocks=%s", intent, list(render_blocks.keys()))

    return {"db_operation_note": db_operation_note, "render_blocks": render_blocks}


# ---------------------------------------------------------------------------
# Node 5: build_prompt_and_call_llm_node
# ---------------------------------------------------------------------------

async def build_prompt_and_call_llm_node(state: dict) -> dict:
    """Build system prompt and call the LLM."""
    conversation = state.get("conversation", [])
    selected_tables = state.get("selected_tables", [])
    current_step_hint = state.get("current_step_hint", 0)
    connection_test_note = state.get("connection_test_note", "")
    connection_test_ok = state.get("connection_test_ok", False)
    db_operation_note = state.get("db_operation_note", "")
    render_blocks = state.get("render_blocks", {})

    # Build selectedTablesNote
    if len(selected_tables) > 0:
        selected_tables_note = (
            f'\n**【用户已选中的库表（必须严格遵守）】**：{", ".join(selected_tables)}\n'
            "用户在界面上勾选了以上库表，你**只能**使用这些库表进行操作和讨论。"
            "不要提及或建议用户使用未选中的库表。"
            "当用户说「看看有哪些表」「有哪些库」时，只展示选中范围内的库表。\n"
        )
    else:
        selected_tables_note = ""

    # Build system prompt - verbatim from JS source (server.js lines 539-612)
    system_prompt = f"""你是智能数据 ETL 助手，帮助用户通过对话完成完整的 ETL 流程。
{selected_tables_note}
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
- 若无法判断则保持上一轮 currentStep（前端上一轮传入的 currentStep 为 {current_step_hint}，若为 0 则默认 1）。
当用户完成一步后，在回复末尾**自然提示下一步可做的操作**，但不要跳步。

**硬性约定（必须遵守）**：
- **一切会修改库表或数据的操作（DDL 与 DML）都必须先展示完整 SQL 并获用户明确确认后才能执行。** 包括：CREATE TABLE、CREATE DATABASE、INSERT INTO ... SELECT 等。你先展示 SQL 并提示「请确认后说「确认」或「执行」」，只有用户明确回复「确认」「执行」「可以」后才会真实执行。只读操作（如 SELECT、DESCRIBE、SHOW）可直接执行，无需确认。
- 所有 SQL、DDL、DML 必须**严格符合 MySQL 语法**（仅使用 MySQL 支持的类型、函数、写法）。
- 所有库/表操作均在**用户提供的连接上真实执行**，由后端连接用户库执行，不模拟、不造假。

**【数据块引用机制】**：
当【数据库操作结果】中列出了「可用数据块」时，你**必须使用 `{{BLOCK_ID}}` 占位符**来引用数据，**严禁**自己手写或复制表格/SQL内容。
示例：若可用数据块有 SQL_SCHEMA、TABLE_SCHEMA、RETURN_CODE，你的回复应为：
"表结构如下：\n\n{{SQL_SCHEMA}}\n\n{{TABLE_SCHEMA}}\n\n执行成功，{{RETURN_CODE}}"
后端会自动将 `{{BLOCK_ID}}` 替换为真实内容。这样做的好处是：数据 100% 准确，不会出错。
**注意**：
- 只引用【数据库操作结果】中列出的 BLOCK_ID，不要编造不存在的 ID
- 你只需要写自然语言 + {{BLOCK_ID}} 占位符，不要自己写表格或 SQL 代码块
- 失败场景下的错误信息块（如 ERR_SCHEMA、FIX_SCHEMA_*）也用 {{ID}} 引用

- **凡涉及表数据验证、数据展示的回答**（如：表结构、前 N 条数据、空值分析、库表列表、任意 SELECT 结果），回复中**禁止出现 JSON**，必须严格按以下顺序且用**表格**展示数据：(1) **验证/执行的 SQL**（用 ```sql 代码块写出）；(2) **实际返回的表格**（用 markdown 表格，表头与数据行清晰对齐）；(3) **SQL 返回码**（如：执行成功，返回行数/列数/影响行数）。**表格内容必须严格根据【数据库操作结果】中给出的执行结果**：逐行逐列照实填写，不得自行编造、补全、推测或改写任何单元格；若某列为空则写空，不得虚构行列或数据。当有「可用数据块」时，直接用 {{BLOCK_ID}} 引用即可。
- **SQL 执行失败时**：若上方【数据库操作结果】标明**失败**，你必须 (1) **如实、完整**地把失败原因输出给用户（不得隐瞒、不得改写为"成功"）；(2) **禁止**以任何方式声称"执行成功""已完成""已创建"等；(3) **自我纠正**：若失败原因为「列不存在」「Unknown column」等且上方已注入**涉及表的结构（已自动查询）**，你须**直接**在回复中给出根据真实列名修正后的**完整可执行 SQL**（代码块），并明确提示用户「请再次执行上述 SQL」，直至成功；不得只建议用户自己去查表或只贴 DESCRIBE 让用户执行。若为其他错误类型，给出修改建议并请用户修正后重试。
- 只有后端明确返回成功时，才可在回复中说"成功"；否则一律按失败处理并输出真实原因。
{connection_test_note}
{db_operation_note}

**各步骤引导说明**：

**第1步：连接数据库**
- 用户提供 MySQL 连接串（URL 如 mysql://user:pass@host:port/db 或命令行形式）。
- 若有【连接测试结果】且成功 → 回复「连接成功。」并**自然引导**进入第 2 步（如：「接下来请告诉我你想基于哪个库的哪张表做数据加工？」）。
- 若测连失败 → 如实说明错误信息，提示用户检查连接串或权限。
- 若本轮用户发送了连接串，必须设置 "connectionReceived": true。

**第2步：选择基表**
- 围绕「有哪些库」「某个库下有哪些表」「我要用哪张表」这类问题回答。
- 若有 describeTable 相关的【数据库操作结果】→ 必须先写出验证 SQL，再以**表格**形式展示表结构和前 10 条数据（禁止用 JSON）；分析只基于真实数据，不得编造。有「可用数据块」时直接用 {{BLOCK_ID}} 引用。
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
- 若有表数据相关的【数据库操作结果】→ 必须先写出**验证 SQL**，再以**表格**形式展示实际返回，**禁止**用 JSON。有「可用数据块」时直接用 {{BLOCK_ID}} 引用。
- 若发现异常，自然引导进入第 6 步（如：「发现 xxx 字段空值较多，可以说"追溯 xxx 字段"去源表排查原因。」）。

**第6步：异常溯源**
- 用户提到「去源表看看」「追溯某字段」「检查基表数据」时，查询并展示基表真实数据。
- 回复中必须写出**验证 SQL**并以**表格**展示实际查询结果，禁止 JSON、不得编造；对比目标表和基表的数据情况分析原因。

**通用回复规则**：
1. 用中文回复，简洁友好。**因无「下一步」按钮，你必须在对话中提示用户下一步该干啥**：根据当前步骤和对话理解，在回复中自然说明「接下来可以输入/做什么」（不写死话术，灵活提醒）。
2. **你执行的每一个 SQL 都必须在回复中给出返回结果**：SELECT 须有表格 + 返回行数；INSERT 等须明确写出**SQL 返回码**。**禁止**只写「正在执行」而不写执行结果。有「可用数据块」时用 {{BLOCK_ID}} 引用。
3. 若有【数据库操作结果】且为**失败**，必须**如实输出失败原因**，并给出**自我纠正**建议。
4. 若本轮**没有【数据库操作结果】**，**不得声称**已执行任何数据库操作。
5. 若用户发送了 MySQL 连接串，设置 "connectionReceived": true。
6. **所有会修改库表或数据的操作（DDL、DML）**：建库、建表、INSERT INTO ... SELECT 等，都必须**先展示 SQL 并提示用户确认**，只有用户明确回复「确认」「执行」「可以」后才会真实执行。不得在用户未确认时执行任何写操作。

**输出格式**：只返回一个 JSON 对象，不要 markdown 代码块：
{{"reply":"你的回复内容（可含 markdown 格式化，有可用数据块时用 {{BLOCK_ID}} 引用）","connectionReceived":false,"currentStep":1}}
**重要**：
- currentStep 必须填入你判断的当前步骤（1～6 的整数），前端会根据它更新进度条。
- reply 里涉及表数据时，必须是「SQL 代码块 + markdown 表格 + 返回码」三部分，禁止 JSON。**有可用数据块时用 {{BLOCK_ID}} 引用，表格内容必须与【数据库操作结果】完全一致，不得编造。**"""

    messages = [
        {"role": "system", "content": system_prompt},
        *[{"role": t["role"], "content": t["content"]} for t in conversation],
    ]

    try:
        result = await call_llm(messages, temperature=0.3, max_tokens=4096, caller="etl_chat")
        if not result.get("ok"):
            return {
                "llm_response": {
                    "_error": result.get("error") or "LLM 请求失败",
                    "_status": result.get("status", 500),
                }
            }

        content = (result.get("content") or "").strip()
        json_match = re.search(r"\{[\s\S]*\}", content)
        out = {
            "reply": content,
            "connectionReceived": False,
            "currentStep": current_step_hint or 1,
        }

        if json_match:
            try:
                parsed = json.loads(json_match.group(0))
                if isinstance(parsed.get("reply"), str):
                    out["reply"] = parsed["reply"]
                if parsed.get("connectionReceived"):
                    out["connectionReceived"] = True
                cs = parsed.get("currentStep")
                if isinstance(cs, (int, float)) and 1 <= cs <= 6:
                    out["currentStep"] = int(cs)
            except (json.JSONDecodeError, ValueError):
                pass

        # Replace {BLOCK_ID} / {{BLOCK_ID}} placeholders with actual content
        if render_blocks:
            reply = out["reply"]
            for bid, content_val in render_blocks.items():
                reply = reply.replace("{{" + bid + "}}", content_val)
                reply = reply.replace("{" + bid + "}", content_val)
            out["reply"] = reply

        logger.info("[ETL] step=%d reply_len=%d blocks_replaced=%s",
                    out["currentStep"], len(out["reply"]), list(render_blocks.keys()) if render_blocks else [])

        return {
            "llm_response": {
                "reply": out["reply"],
                "connectionReceived": out["connectionReceived"],
                "connectionTestOk": connection_test_ok,
                "currentStep": out["currentStep"],
            }
        }

    except Exception as e:
        return {
            "llm_response": {
                "_error": str(e) or "LLM 请求失败",
                "_status": 500,
            }
        }


# ---------------------------------------------------------------------------
# Routing functions
# ---------------------------------------------------------------------------

def should_test_connection_router(state: dict) -> str:
    """Route after parse_input: test connection or skip to intent extraction."""
    if state.get("should_test_connection"):
        logger.info("[Router] parse_input → test_connection")
        return "test_connection"
    logger.info("[Router] parse_input → extract_intent (skip connection test)")
    return "extract_intent"


def should_extract_intent_router(state: dict) -> str:
    """Route after test_connection: extract intent or skip to LLM."""
    connection_string = state.get("connection_string")
    last_user_content = state.get("last_user_content", "")
    last_message_is_only = state.get("last_message_is_only_connection_string", False)
    if connection_string and last_user_content and not last_message_is_only:
        logger.info("[Router] test_connection → extract_intent")
        return "extract_intent"
    logger.info("[Router] test_connection → build_prompt_and_call_llm (skip intent)")
    return "build_prompt_and_call_llm"


def has_valid_intent_router(state: dict) -> str:
    """Route after extract_intent: execute DB op or skip to LLM."""
    db_intent = state.get("db_intent", {})
    connection_string = state.get("connection_string")
    if connection_string and db_intent.get("intent"):
        logger.info("[Router] extract_intent → execute_db_operation (intent=%s)", db_intent["intent"])
        return "execute_db_operation"
    logger.info("[Router] extract_intent → build_prompt_and_call_llm (no intent)")
    return "build_prompt_and_call_llm"


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_etl_chat_graph():
    """Build and compile the ETL chat LangGraph state graph."""
    graph = StateGraph(ETLChatState)

    # Add nodes
    graph.add_node("parse_input", parse_input)
    graph.add_node("test_connection", test_connection_node)
    graph.add_node("extract_intent", extract_intent_node)
    graph.add_node("execute_db_operation", execute_db_operation_node)
    graph.add_node("build_prompt_and_call_llm", build_prompt_and_call_llm_node)

    # Set entry point
    graph.set_entry_point("parse_input")

    # Conditional edges from parse_input
    graph.add_conditional_edges(
        "parse_input",
        should_test_connection_router,
        {
            "test_connection": "test_connection",
            "extract_intent": "extract_intent",
        },
    )

    # Conditional edges from test_connection
    graph.add_conditional_edges(
        "test_connection",
        should_extract_intent_router,
        {
            "extract_intent": "extract_intent",
            "build_prompt_and_call_llm": "build_prompt_and_call_llm",
        },
    )

    # Conditional edges from extract_intent
    graph.add_conditional_edges(
        "extract_intent",
        has_valid_intent_router,
        {
            "execute_db_operation": "execute_db_operation",
            "build_prompt_and_call_llm": "build_prompt_and_call_llm",
        },
    )

    # execute_db_operation always goes to build_prompt_and_call_llm
    graph.add_edge("execute_db_operation", "build_prompt_and_call_llm")

    # build_prompt_and_call_llm always ends
    graph.add_edge("build_prompt_and_call_llm", END)

    return graph.compile()
