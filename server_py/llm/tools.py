"""execute_sql tool 定义 + 执行器。"""

import json
import re
import logging
import asyncio
import aiomysql

from db.connection import get_connection_config
from utils.formatters import rows_to_markdown_table

logger = logging.getLogger("etl.tools")

# ---------------------------------------------------------------------------
# Tool 定义
# ---------------------------------------------------------------------------

EXECUTE_SQL_TOOL = {
    "type": "function",
    "function": {
        "name": "execute_sql",
        "description": (
            "在用户的 MySQL 数据库上执行 SQL 语句。"
            "支持：SELECT、SHOW、DESCRIBE、CREATE DATABASE、CREATE TABLE、INSERT INTO...SELECT 等。"
            "禁止：DROP、TRUNCATE、DELETE、UPDATE。"
            "每次只执行一条 SQL，需要多条时请多次调用。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "要执行的完整 SQL 语句",
                }
            },
            "required": ["sql"],
        },
    },
}

SQL_TOOLS = [EXECUTE_SQL_TOOL]

# 禁止的 SQL 模式
_FORBIDDEN = re.compile(r"\b(DROP|TRUNCATE|DELETE|UPDATE)\b", re.IGNORECASE)


# ---------------------------------------------------------------------------
# 执行器
# ---------------------------------------------------------------------------

async def execute_tool_call(
    tool_call,
    connection_string: str,
    render_blocks: dict,
    block_counter: list,  # [int] 可变计数器
) -> str:
    """
    执行单个 tool_call，返回给 LLM 的文本摘要。
    完整数据存入 render_blocks。
    """
    try:
        args = json.loads(tool_call.function.arguments)
    except (json.JSONDecodeError, AttributeError):
        return "参数解析失败"

    sql = str(args.get("sql", "")).strip()
    if not sql:
        return "SQL 为空"

    # 安全检查
    if _FORBIDDEN.search(sql):
        return f"安全限制：禁止执行 DROP/TRUNCATE/DELETE/UPDATE 语句"

    # 解析连接
    parsed = get_connection_config(connection_string)
    if not parsed:
        return "连接串格式无法解析"

    conn = None
    try:
        conn = await asyncio.wait_for(
            aiomysql.connect(
                host=parsed["host"],
                port=parsed["port"],
                user=parsed["user"],
                password=parsed["password"],
                db=parsed.get("database") or None,
                connect_timeout=10,
            ),
            timeout=10,
        )
        cur = await conn.cursor(aiomysql.DictCursor)
        await cur.execute(sql)

        is_write = bool(re.match(r"^\s*(INSERT|REPLACE|CREATE|ALTER)", sql, re.IGNORECASE))

        if is_write:
            await conn.commit()
            affected = cur.rowcount
            n = block_counter[0]
            block_counter[0] = n + 1
            bid = f"SQL_{n}"
            render_blocks[bid] = f"```sql\n{sql}\n```"
            return f"执行成功，影响行数: {affected}。数据块: {bid}（执行的SQL）"
        else:
            rows = await cur.fetchall()
            row_count = len(rows) if rows else 0

            n = block_counter[0]
            # SQL 块
            sql_bid = f"SQL_{n}"
            render_blocks[sql_bid] = f"```sql\n{sql}\n```"
            block_counter[0] = n + 1

            if row_count > 0:
                # 数据块
                tn = block_counter[0]
                table_bid = f"TABLE_{tn}"
                render_blocks[table_bid] = rows_to_markdown_table(rows[:100])
                block_counter[0] = tn + 1
                return (
                    f"查询成功，返回 {row_count} 行。"
                    f"数据块: {sql_bid}（SQL）, {table_bid}（结果表格，{row_count}行）"
                )
            else:
                return f"查询成功，返回 0 行。数据块: {sql_bid}（SQL）"

    except Exception as e:
        logger.error("[Tool] execute_sql error: %s", e)
        return f"执行失败，错误信息：\n{e}"
    finally:
        if conn:
            conn.close()
