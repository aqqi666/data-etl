import re
import logging
from llm.client import call_llm
from db.operations import VALID_INTENTS

logger = logging.getLogger("etl.intent")


async def extract_db_intent_from_model(conversation, api_key, chat_url=None):
    """
    从对话中解析用户的数据库操作意图。
    返回 {"intent": str|None, "params": dict}
    - 仅取最后 8 条消息
    - temperature=0.1, max_tokens=1024
    - 解析失败返回 {"intent": None, "params": {}}
    """
    if not api_key or not isinstance(conversation, list) or len(conversation) == 0:
        return {'intent': None, 'params': {}}

    system_content = '''你是一个意图解析器。根据用户与助手的对话，判断用户**最后一条消息**是否需要对 MySQL 数据库执行操作。

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
{"intent":"xxx"|null,"params":{}}'''

    messages = [
        {'role': 'system', 'content': system_content},
        *[{'role': t['role'], 'content': t['content']} for t in conversation[-8:]],
    ]

    try:
        result = await call_llm(messages, temperature=0.1, max_tokens=1024, caller="intent")
        if not result.get('ok'):
            return {'intent': None, 'params': {}}
        content = (result.get('content') or '').strip()
        json_match = re.search(r'\{[\s\S]*\}', content)
        if not json_match:
            logger.info("[Intent] 未匹配到 JSON，raw=%s", content[:200])
            return {'intent': None, 'params': {}}
        import json
        out = json.loads(json_match.group(0))
        intent = out.get('intent') if out.get('intent') in VALID_INTENTS else None
        params = out.get('params', {})
        if not isinstance(params, dict):
            params = {}
        logger.info("[Intent] intent=%s params=%s", intent, params)
        return {'intent': intent, 'params': params}
    except Exception as e:
        logger.error("[Intent] 解析异常: %s", e)
        return {'intent': None, 'params': {}}
