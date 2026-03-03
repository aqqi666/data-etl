import time
import logging

from openai import AsyncOpenAI, APIStatusError
from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL

logger = logging.getLogger("etl.llm")

_client = AsyncOpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)


async def call_llm(messages: list, temperature: float = None, max_tokens: int = None, caller: str = "") -> dict:
    """
    统一的 LLM API 调用（OpenAI 兼容接口）。
    返回 {"ok": bool, "content": str, "error": str, "status": int|None}
    """
    kwargs = {"model": LLM_MODEL, "messages": messages, "stream": False}
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens

    start = time.time()
    try:
        response = await _client.chat.completions.create(**kwargs)
        elapsed = int((time.time() - start) * 1000)
        content = response.choices[0].message.content
        usage = response.usage
        logger.info(
            "[LLM] %s | %dms | in=%d out=%d total=%d | model=%s\n[LLM] output: %s",
            caller or "unknown",
            elapsed,
            usage.prompt_tokens if usage else 0,
            usage.completion_tokens if usage else 0,
            usage.total_tokens if usage else 0,
            LLM_MODEL,
            content,
        )
        return {"ok": True, "content": content, "error": ""}
    except APIStatusError as e:
        elapsed = int((time.time() - start) * 1000)
        logger.error("[LLM] %s | %dms | ERROR %d: %s", caller or "unknown", elapsed, e.status_code, e.message)
        return {"ok": False, "content": "", "error": e.message, "status": e.status_code}
    except Exception as e:
        elapsed = int((time.time() - start) * 1000)
        logger.error("[LLM] %s | %dms | ERROR: %s", caller or "unknown", elapsed, str(e))
        return {"ok": False, "content": "", "error": str(e)}
