import time
import logging

from openai import AsyncOpenAI, APIStatusError
from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL

logger = logging.getLogger("etl.llm")

_client = AsyncOpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)


async def call_llm(
    messages: list,
    temperature: float = None,
    max_tokens: int = None,
    caller: str = "",
    tools: list = None,
) -> dict:
    """
    统一的 LLM API 调用（OpenAI 兼容接口）。

    当 tools 为 None 时（旧模式）：
        返回 {"ok", "content", "error", "status"}

    当 tools 非空时（tool calling 模式）：
        返回 {"ok", "content", "tool_calls", "finish_reason", "raw_message", "error"}
    """
    kwargs = {"model": LLM_MODEL, "messages": messages, "stream": False}
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if tools:
        kwargs["tools"] = tools
        # qwen3 thinking 模式与 tool calling 冲突，需关闭
        kwargs["extra_body"] = {"enable_thinking": False}

    start = time.time()
    try:
        response = await _client.chat.completions.create(**kwargs)
        elapsed = int((time.time() - start) * 1000)
        message = response.choices[0].message
        finish_reason = response.choices[0].finish_reason
        usage = response.usage

        tool_calls = message.tool_calls
        n_tools = len(tool_calls) if tool_calls else 0

        logger.info(
            "[LLM] %s | %dms | in=%d out=%d total=%d | model=%s | finish=%s tools=%d\n[LLM] output: %s",
            caller or "unknown",
            elapsed,
            usage.prompt_tokens if usage else 0,
            usage.completion_tokens if usage else 0,
            usage.total_tokens if usage else 0,
            LLM_MODEL,
            finish_reason,
            n_tools,
            message.content if message.content else f"[{n_tools} tool calls]",
        )

        if tools is not None:
            return {
                "ok": True,
                "content": message.content,
                "tool_calls": tool_calls,
                "finish_reason": finish_reason,
                "raw_message": message,
                "error": "",
            }
        else:
            return {"ok": True, "content": message.content, "error": ""}

    except APIStatusError as e:
        elapsed = int((time.time() - start) * 1000)
        logger.error("[LLM] %s | %dms | ERROR %d: %s", caller or "unknown", elapsed, e.status_code, e.message)
        return {"ok": False, "content": "", "error": e.message, "status": e.status_code}
    except Exception as e:
        elapsed = int((time.time() - start) * 1000)
        logger.error("[LLM] %s | %dms | ERROR: %s", caller or "unknown", elapsed, str(e))
        return {"ok": False, "content": "", "error": str(e)}
