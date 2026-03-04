from fastapi import APIRouter
from fastapi.responses import JSONResponse
from config import LLM_API_KEY
from llm.client import call_llm
import re
import json

router = APIRouter()


def build_system_prompt(target_table_name, target_fields, existing_mappings):
    mapped = [m for m in existing_mappings if m.get('status') != 'unmapped']
    field_list = '\n'.join(
        f'- {f["name"]} ({f["type"]}) {"— " + f["comment"] if f.get("comment") else ""}'
        for f in target_fields
    )

    mapped_str = f'**已映射的字段**：{", ".join(m["targetField"] for m in mapped)}' if mapped else ''

    return f'''你是一个数据 ETL 助手。用户正在为**目标表**的每个字段配置数据来源（库、表、字段或表达式）。

**目标表名**：{target_table_name}

**目标表字段列表**（name 为英文字段名，comment 为中文说明）：
{field_list}

{mapped_str}

**重要——一律用 JOIN 写法，禁止子查询；仅用 MySQL 语法**：
- sql 只能是「表别名.列名」或简单表达式（如 COALESCE、CAST、CONCAT 等 **MySQL 支持**的写法），**禁止**标量子查询。
- 用户用中文说字段时，对应到 comment 或 name 匹配的英文名。

**必须**返回合法 JSON，不要 markdown 代码块：
{{
  "mappings": [
    {{
      "targetField": "目标表字段英文名",
      "source": "库.表",
      "logic": "简短说明（含关联键）",
      "sql": "表别名.列名 或简单表达式"
    }}
  ]
}}

若无法对应到任何字段，返回 {{"mappings":[]}}'''


@router.post("/api/mapping")
async def mapping(request_body: dict):
    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "DEEPSEEK_API_KEY not configured"})

    message = request_body.get('message')
    conversation = request_body.get('conversation')
    target_table_name = request_body.get('targetTableName')
    target_fields = request_body.get('targetFields')
    existing_mappings = request_body.get('existingMappings', [])

    if not message or not target_table_name or not isinstance(target_fields, list):
        return JSONResponse(status_code=400, content={"error": "Missing message, targetTableName or targetFields"})

    system_prompt = build_system_prompt(
        target_table_name,
        target_fields,
        existing_mappings if isinstance(existing_mappings, list) else [],
    )

    if isinstance(conversation, list) and len(conversation) > 0:
        normalized = [
            {'role': t['role'], 'content': str(t.get('content') or '').strip()}
            for t in conversation
        ]
        normalized = [t for t in normalized if len(t['content']) > 0]
        while normalized and normalized[0]['role'] == 'assistant':
            normalized.pop(0)
        if not normalized:
            chat_messages = [
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': message},
            ]
        else:
            chat_messages = [{'role': 'system', 'content': system_prompt}] + normalized
    else:
        chat_messages = [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': message},
        ]

    try:
        result = await call_llm(chat_messages, temperature=0.2, max_tokens=4096)
        if not result['ok']:
            return JSONResponse(status_code=result.get('status', 500), content={"error": result['error'] or "DeepSeek 请求失败"})

        content = (result.get('content') or '').strip()
        parsed = {'mappings': []}
        json_match = re.search(r'\{[\s\S]*\}', content)
        if json_match:
            try:
                parsed = json.loads(json_match.group(0))
            except Exception:
                pass
        if not isinstance(parsed.get('mappings'), list):
            parsed['mappings'] = []
        return parsed
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e) or "DeepSeek 请求失败"})
