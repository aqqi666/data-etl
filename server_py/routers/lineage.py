from fastapi import APIRouter
from fastapi.responses import JSONResponse
from config import LLM_API_KEY
from llm.client import call_llm
from db.operations import run_database_operation
from utils.sql_parser import extract_table_refs_from_sql
import re
import json
import hashlib

router = APIRouter()

# ────────── 缓存 ──────────
# 用于缓存血缘分析结果，避免重复调用 LLM
_lineage_cache: dict[str, dict] = {}
_metric_lineage_cache: dict[str, dict] = {}


def _make_cache_key(data: dict) -> str:
    """根据请求参数生成缓存 key"""
    raw = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.md5(raw.encode()).hexdigest()


def _classify_table_role_in_sql(sql: str, ref: dict) -> str:
    """判断一个表在 SQL 中是基表（FROM）还是维表（JOIN）。
    通过检查该表名在 SQL 中首次出现时的上下文来判断。"""
    table_name = ref.get('table', '')
    database = ref.get('database', '')

    # 构建可能的表名匹配模式
    patterns = []
    if database:
        patterns.append(f'`{database}`.`{table_name}`')
        patterns.append(f'{database}.{table_name}')
    patterns.append(f'`{table_name}`')
    patterns.append(table_name)

    sql_upper = sql.upper()

    for pat in patterns:
        idx = sql.find(pat)
        if idx < 0:
            idx = sql_upper.find(pat.upper())
        if idx >= 0:
            # 查看该表名前面最近的关键字
            prefix = sql_upper[:idx].rstrip()
            if prefix.endswith('JOIN'):
                return '维表'
            if prefix.endswith('FROM'):
                return '基表'
            # LEFT/RIGHT/INNER/CROSS JOIN
            if re.search(r'(LEFT|RIGHT|INNER|CROSS|FULL)\s+JOIN\s*$', prefix):
                return '维表'

    return '基表'


# ────────── POST /api/lineage — 解析 SQL 返回数据血缘 ──────────

@router.post("/api/lineage")
async def lineage(request_body: dict):
    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "DEEPSEEK_API_KEY not configured"})

    sql = request_body.get('sql')
    connection_string = request_body.get('connectionString')
    target_table = request_body.get('targetTable')

    if not sql:
        return JSONResponse(status_code=400, content={"error": "Missing sql"})

    # 获取涉及表的结构
    schema_info = ''
    if connection_string:
        table_refs = extract_table_refs_from_sql(sql)
        for ref in table_refs:
            result = await run_database_operation(
                connection_string, 'describeTable',
                {'database': ref['database'], 'table': ref['table']},
            )
            if result['ok']:
                cols = result['data'].get('columns') or []
                full_name = f'{ref["database"]}.{ref["table"]}' if ref['database'] else ref['table']
                col_list = '\n'.join(
                    f'  {c["Field"]} {c["Type"]}{" -- " + c["Comment"] if c.get("Comment") else ""}'
                    for c in cols
                )
                schema_info += f'\n\u8868 {full_name}:\n{col_list}\n'

    system_prompt = f'''\u4f60\u662f\u4e00\u4e2a SQL \u8840\u7f18\u5206\u6790\u4e13\u5bb6\u3002\u5206\u6790\u4ee5\u4e0b INSERT INTO ... SELECT SQL\uff0c\u63d0\u53d6\u5b8c\u6574\u7684\u6570\u636e\u8840\u7f18\u5173\u7cfb\u3002

**SQL**:
```sql
{sql}
```

**\u6d89\u53ca\u8868\u7684\u7ed3\u6784**:
{schema_info or '\uff08\u672a\u63d0\u4f9b\uff09'}

**\u76ee\u6807\u8868**: {target_table or '\u4ece SQL \u4e2d\u63d0\u53d6'}

\u8bf7\u5206\u6790\u5e76\u8fd4\u56de JSON\uff08\u4e0d\u8981 markdown \u4ee3\u7801\u5757\uff09\uff0c\u683c\u5f0f\u5982\u4e0b\uff1a
{{
  "targetTable": "\u5e93\u540d.\u8868\u540d",
  "sourceTables": [
    {{
      "name": "\u5e93\u540d.\u8868\u540d",
      "alias": "SQL\u4e2d\u7684\u522b\u540d\uff08\u5982\u6709\uff09",
      "role": "\u57fa\u8868|\u7ef4\u8868|\u5173\u8054\u8868",
      "joinType": "LEFT JOIN|INNER JOIN|\u65e0\uff08\u4e3b\u8868\uff09",
      "joinCondition": "ON \u6761\u4ef6\uff08\u5982\u6709\uff09"
    }}
  ],
  "fieldMappings": [
    {{
      "targetField": "\u76ee\u6807\u5b57\u6bb5\u540d",
      "sourceTable": "\u6765\u6e90\u8868\u5168\u540d\uff08\u5e93\u540d.\u8868\u540d\uff09",
      "sourceField": "\u6765\u6e90\u5b57\u6bb5\u540d",
      "transform": "\u52a0\u5de5\u903b\u8f91\u63cf\u8ff0\uff0c\u5982\uff1a\u76f4\u63a5\u6620\u5c04\u3001SUM\u805a\u5408\u3001COUNT\u8ba1\u6570\u3001CASE WHEN\u6761\u4ef6\u8f6c\u6362\u3001LEFT JOIN\u5173\u8054\u53d6\u503c\u3001COALESCE\u7a7a\u503c\u5904\u7406 \u7b49",
      "expression": "\u539f\u59cbSQL\u8868\u8fbe\u5f0f\u7247\u6bb5"
    }}
  ],
  "joinRelations": [
    {{
      "leftTable": "\u5e93\u540d.\u8868\u540d",
      "rightTable": "\u5e93\u540d.\u8868\u540d",
      "joinType": "LEFT JOIN|INNER JOIN",
      "condition": "ON \u6761\u4ef6"
    }}
  ],
  "groupBy": "GROUP BY \u5b57\u6bb5\u5217\u8868\uff08\u5982\u6709\uff09",
  "filters": "WHERE \u6761\u4ef6\uff08\u5982\u6709\uff09"
}}

**\u8981\u6c42**\uff1a
- \u6bcf\u4e2a\u76ee\u6807\u5b57\u6bb5\u90fd\u5fc5\u987b\u8ffd\u6eaf\u5230\u5177\u4f53\u7684\u6765\u6e90\u8868\u548c\u6765\u6e90\u5b57\u6bb5
- \u5982\u679c\u4e00\u4e2a\u76ee\u6807\u5b57\u6bb5\u6d89\u53ca\u591a\u4e2a\u6765\u6e90\u8868/\u5b57\u6bb5\uff08\u5982 JOIN \u540e\u53d6\u503c\uff09\uff0c\u5217\u51fa\u4e3b\u8981\u6765\u6e90
- transform \u8981\u7528\u4e2d\u6587\u63cf\u8ff0\u6e05\u695a\u52a0\u5de5\u903b\u8f91
- \u7ef4\u8868\uff08\u901a\u8fc7 JOIN \u5173\u8054\u7684\u67e5\u627e\u8868\uff09\u7684 role \u6807\u8bb0\u4e3a\u201c\u7ef4\u8868\u201d
- \u4e3b\u8981\u6570\u636e\u6765\u6e90\u8868\u7684 role \u6807\u8bb0\u4e3a\u201c\u57fa\u8868\u201d
- sourceTables \u5fc5\u987b\u5305\u542b SQL \u4e2d FROM \u548c\u6240\u6709 JOIN \u6d89\u53ca\u7684\u8868'''

    # 检查缓存
    cache_key = _make_cache_key({'type': 'lineage', 'sql': sql, 'targetTable': target_table})
    if cache_key in _lineage_cache:
        return _lineage_cache[cache_key]

    try:
        llm_result = await call_llm(
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': '\u8bf7\u5206\u6790\u8fd9\u6761 SQL \u7684\u6570\u636e\u8840\u7f18\u5173\u7cfb\u3002'},
            ],
            temperature=0.1,
            max_tokens=4096,
        )
        if not llm_result['ok']:
            return JSONResponse(status_code=llm_result.get('status', 500), content={"error": llm_result['error'] or "\u8840\u7f18\u5206\u6790\u5931\u8d25"})

        content = (llm_result.get('content') or '').strip()
        json_match = re.search(r'\{[\s\S]*\}', content)
        if not json_match:
            return JSONResponse(status_code=500, content={"error": "\u6a21\u578b\u672a\u8fd4\u56de\u6709\u6548 JSON"})
        parsed = json.loads(json_match.group(0))
        _lineage_cache[cache_key] = parsed
        return parsed
    except Exception as e:
        print(f'[/api/lineage] {e}')
        return JSONResponse(status_code=500, content={"error": str(e) or "\u8840\u7f18\u5206\u6790\u5931\u8d25"})


# ────────── POST /api/metric-lineage — 指标全链路血缘 ──────────

@router.post("/api/metric-lineage")
async def metric_lineage(request_body: dict):
    if not LLM_API_KEY:
        return JSONResponse(status_code=503, content={"error": "DEEPSEEK_API_KEY not configured"})

    metric_def = request_body.get('metricDef')
    processed_tables = request_body.get('processedTables', [])
    connection_string = request_body.get('connectionString')

    if not metric_def:
        return JSONResponse(status_code=400, content={"error": "Missing metricDef"})

    # 收集所有相关的加工 SQL
    relevant_tables = metric_def.get('tables') or []
    all_processed = processed_tables or []

    # 直接匹配指标涉及的表
    direct_match = [
        pt for pt in all_processed
        if any(t == f'{pt["database"]}.{pt["table"]}' for t in relevant_tables)
    ]
    # 如果直接匹配为空，使用所有传入的加工表（前端已按 dashboard 过滤）
    relevant_processed = direct_match if len(direct_match) > 0 else all_processed

    # 从 insertSql 中解析出真正的源表（基表/维表），区分 FROM（基表）和 JOIN（维表）
    parsed_source_tables: list[dict] = []  # {name, role: 基表|维表, from_processed: 业务表名}
    processed_table_names = set()
    for pt in relevant_processed:
        pt_full = f'{pt["database"]}.{pt["table"]}'
        processed_table_names.add(pt_full)
        insert_sql = pt.get('insertSql') or ''
        if insert_sql:
            refs = extract_table_refs_from_sql(insert_sql)
            for ref in refs:
                ref_full = f'{ref["database"]}.{ref["table"]}' if ref.get('database') else ref['table']
                # 排除目标表本身（INSERT INTO 的目标）
                if ref_full == pt_full:
                    continue
                # 判断是 FROM（基表）还是 JOIN（维表）
                role = _classify_table_role_in_sql(insert_sql, ref)
                parsed_source_tables.append({
                    'name': ref_full,
                    'role': role,
                    'from_processed': pt_full,
                })

    # 去重
    seen_sources = set()
    unique_sources = []
    for s in parsed_source_tables:
        if s['name'] not in seen_sources:
            seen_sources.add(s['name'])
            unique_sources.append(s)

    # 获取表结构（包括解析出的真正源表）
    schema_info = ''
    if connection_string:
        all_tbls = set(relevant_tables)
        for s in unique_sources:
            all_tbls.add(s['name'])
        for pt in relevant_processed:
            for s in (pt.get('sourceTables') or []):
                all_tbls.add(s)
        for tbl in all_tbls:
            parts = tbl.split('.')
            if len(parts) == 2:
                result = await run_database_operation(
                    connection_string, 'describeTable',
                    {'database': parts[0], 'table': parts[1]},
                )
                if result['ok']:
                    cols_list = result['data'].get('columns') or []
                    col_str = '\n'.join(
                        f'  {c["Field"]} {c["Type"]}{" -- " + c["Comment"] if c.get("Comment") else ""}'
                        for c in cols_list
                    )
                    schema_info += f'\n\u8868 {tbl}:\n{col_str}\n'

    # 收集加工 SQL 和字段映射信息
    etl_info_parts = []
    for pt in relevant_processed:
        mapping_info = ''
        if isinstance(pt.get('fieldMappings'), list) and len(pt['fieldMappings']) > 0:
            mapping_lines = '\n'.join(
                f'    {fm["targetField"]} \u2190 {fm["sourceTable"]}.{fm["sourceExpr"]} ({fm["transform"]})'
                for fm in pt['fieldMappings']
            )
            mapping_info = f'  \u5b57\u6bb5\u6620\u5c04:\n{mapping_lines}'
        source_tables_str = ', '.join(pt.get('sourceTables') or [])
        entry = f'\u52a0\u5de5\u8868 {pt["database"]}.{pt["table"]}:\n  \u6765\u6e90\u8868: {source_tables_str}'
        if mapping_info:
            entry += '\n' + mapping_info
        entry += f'\n  \u52a0\u5de5SQL: {pt.get("insertSql") or "\u65e0"}'
        etl_info_parts.append(entry)
    etl_info = '\n\n'.join(etl_info_parts)

    # 构建从 SQL 解析出的源表清单，明确告知 LLM
    if unique_sources:
        parsed_source_info = '\n'.join(
            f'  - {s["name"]}（角色：{s["role"]}，用于加工 {s["from_processed"]}）'
            for s in unique_sources
        )
    else:
        parsed_source_info = '  （未从加工SQL中解析到源表）'

    metric_name = metric_def.get('name', '')
    metric_definition = metric_def.get('definition', '')
    metric_aggregation = metric_def.get('aggregation', '')
    metric_measure_field = metric_def.get('measureField', '')

    # 构建业务表名列表（用于在 prompt 中明确哪些是业务表）
    processed_names_list = ', '.join(processed_table_names) if processed_table_names else '（无）'

    system_prompt = f'''你是一个数据血缘分析专家。请分析指标的全链路血缘，从最底层的基表/维表到加工后的业务表，再到指标本身。

**指标信息**：
- 名称：{metric_name}
- 定义：{metric_definition}
- 聚合方式：{metric_aggregation}
- 度量字段：{metric_measure_field}
- 涉及表：{', '.join(relevant_tables)}

**ETL 加工信息（这是真实的加工记录）**：
{etl_info or '（无加工信息）'}

**从加工SQL中解析出的原始源表（已自动解析，请直接使用）**：
{parsed_source_info}

**已确认的加工业务表**：{processed_names_list}

**核心规则（必须严格遵守）**：
1. source 层（基表/维表）**必须**使用上方「从加工SQL中解析出的原始源表」中列出的表，这些是加工业务表的真正数据来源。
2. source 层的表**绝对不能**与 processed 层的业务表相同。如果一个表既出现在源表中又出现在业务表中，它只能放在 processed 层。
3. processed 层应放置指标直接涉及的加工业务表（即 {processed_names_list}）。
4. 如果没有从加工SQL中解析到源表，则指标涉及的表本身就是基表，直接放在 source 层，processed 层留空。
5. 只列出与该指标相关的字段，不要列出无关字段。

**表结构**：
{schema_info or '（未提供）'}

返回 JSON（不要 markdown 代码块）：
{{
  "layers": [
    {{
      "level": "source",
      "label": "基表/维表",
      "tables": [
        {{
          "name": "db.table",
          "role": "基表|维表",
          "fields": ["只列出与指标相关的字段"]
        }}
      ]
    }},
    {{
      "level": "processed",
      "label": "加工业务表",
      "tables": [
        {{
          "name": "db.table",
          "role": "业务表",
          "fields": ["只列出与指标相关的字段"]
        }}
      ]
    }},
    {{
      "level": "metric",
      "label": "指标",
      "tables": [
        {{
          "name": "{metric_name}",
          "role": "指标",
          "fields": ["{metric_aggregation}({metric_measure_field})"]
        }}
      ]
    }}
  ],
  "edges": [
    {{
      "from": {{"table": "源表名", "field": "源字段"}},
      "to": {{"table": "目标表名", "field": "目标字段"}},
      "transform": "加工逻辑（如直接映射、SUM、JOIN等）"
    }}
  ],
  "summary": "一句话总结该指标的数据流转路径"
}}'''

    # 检查缓存
    cache_key = _make_cache_key({
        'type': 'metric-lineage',
        'metric': metric_name,
        'tables': relevant_tables,
        'processed': [f'{pt["database"]}.{pt["table"]}' for pt in relevant_processed],
    })
    if cache_key in _metric_lineage_cache:
        return _metric_lineage_cache[cache_key]

    try:
        llm_result = await call_llm(
            messages=[
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': f'请分析指标「{metric_name}」的全链路血缘'},
            ],
            temperature=0.1,
            max_tokens=4096,
        )
        if not llm_result['ok']:
            return JSONResponse(status_code=llm_result.get('status', 500), content={"error": llm_result['error'] or "指标血缘分析失败"})

        content = (llm_result.get('content') or '').strip()
        json_match = re.search(r'\{[\s\S]*\}', content)
        if not json_match:
            return JSONResponse(status_code=500, content={"error": "模型未返回有效 JSON"})
        parsed = json.loads(json_match.group(0))
        _metric_lineage_cache[cache_key] = parsed
        return parsed
    except Exception as e:
        print(f'[/api/metric-lineage] {e}')
        return JSONResponse(status_code=500, content={"error": str(e) or "指标血缘分析失败"})
