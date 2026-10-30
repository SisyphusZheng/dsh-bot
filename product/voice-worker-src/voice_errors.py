"""Classify voice-provider failures into actionable, secret-free diagnostics.

The pet bubble only needs ``summary``/``action``/``diagId``; the bounded rotating
diagnostic log keeps the redacted ``detail`` (full exception chain) so a native
failure can be diagnosed without reproducing it. The provider API key must never
appear in either channel: every detail string passes :func:`redact`.
"""
from __future__ import annotations

import re
import time
import uuid

KINDS = ("proxy", "network", "auth", "quota", "permission", "host", "provider", "unknown")

SUMMARY = {
    "proxy": "语音连接被本机代理拦截",
    "network": "无法连接语音服务（网络或 DNS）",
    "auth": "语音服务鉴权失败",
    "quota": "语音服务额度不足或被限流",
    "permission": "麦克风权限或音频设备不可用",
    "host": "本地桌宠服务连接中断",
    "provider": "语音服务暂时不可用",
    "unknown": "语音服务连接失败",
}

ACTION = {
    "proxy": "本版语音直连，不经过系统代理。请关闭系统 SOCKS/HTTPS 代理，或为该语音域名设置 NO_PROXY，然后点“重试”。",
    "network": "请检查网络、DNS 或代理设置，然后点“重试”。",
    "auth": "请到 DSH → Bot 设置检查语音 API Key 是否有效，保存后点“重试”。",
    "quota": "请检查 DashScope 账户余额/并发额度，或稍后点“重试”。",
    "permission": "请在系统设置中允许麦克风权限，或检查音频设备后点“重试”。",
    "host": "请确认桌宠宿主仍在运行；连接恢复后会自动重连。",
    "provider": "服务端暂时异常，请稍后点“重试”；持续失败请把诊断 ID 发给维护者。",
    "unknown": "请点“重试”；持续失败请把诊断 ID 和诊断日志发给维护者。",
}

_REDACTIONS = (
    (re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-+/=]+"), r"\1[redacted]"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-+/=]{8,}"), r"\1[redacted]"),
    (re.compile(r"(?i)((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;\"']+"), r"\1[redacted]"),
    (re.compile(r"(?i)([?&](?:api[_-]?key|token|key)=)[^&\s]+"), r"\1[redacted]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"), "[redacted]"),
)

# Order matters: proxy/websocket setup errors often contain generic network words,
# and auth/quota responses must win over the generic provider bucket.
_PATTERNS = (
    ("proxy", re.compile(
        r"socks proxy|python-socks|requires python-socks|proxy.*websocket|websocket.*proxy"
        r"|connect.*proxy|proxy.*(?:refused|unreachable|closed)", re.I)),
    ("auth", re.compile(
        r"401|403|unauthori[sz]ed|invalid.*(?:api[ _]?key|token)|incorrect api key"
        r"|authentication|access denied|forbidden", re.I)),
    ("quota", re.compile(
        r"429|quota|insufficient|balance|rate[ _-]?limit|too many requests|throttl", re.I)),
    ("permission", re.compile(
        r"notallowed|permission|tcc|microphone|audio[ _-]?device|device.*(?:unavailable|error)", re.I)),
    ("host", re.compile(
        r"host (?:request|stream|bridge|v2|state)|/v2/(?:command|snapshot|stream|events)"
        r"|bridge descriptor|dsh-bot-v1", re.I)),
    ("provider", re.compile(
        r"\b5\d\d\b|internal server|server error|bad gateway|service unavailable|overload", re.I)),
    ("network", re.compile(
        r"getaddrinfo|name or service not known|name resolution|dns|connection refused"
        r"|connection reset|connection closed|timeout|timed out|network|unreachable"
        r"|ssl|tls|certificate|econn|broken pipe|eof", re.I)),
)


def redact(text: str, limit: int = 4000) -> str:
    """Remove credential-shaped fragments and bound one diagnostic record."""
    value = str(text or "")
    for pattern, replacement in _REDACTIONS:
        value = pattern.sub(replacement, value)
    return value.replace("\x00", " ")[:limit]


def _exception_chain(exc: BaseException | None, depth: int = 8) -> str:
    """Render the full cause/context chain; the root cause is what matters."""
    seen: set[int] = set()
    parts: list[str] = []
    current: BaseException | None = exc
    while current is not None and id(current) not in seen and len(parts) < depth:
        seen.add(id(current))
        parts.append(f"{type(current).__name__}: {current}")
        current = current.__cause__ or current.__context__
    return "\n".join(parts)


def classify(exc: BaseException | None) -> str:
    text = _exception_chain(exc).lower()
    if not text:
        return "unknown"
    for kind, pattern in _PATTERNS:
        if pattern.search(text):
            return kind
    return "unknown"


def build_payload(exc: BaseException | None, source: str = "provider") -> dict:
    kind = classify(exc)
    return {
        "kind": kind,
        "summary": SUMMARY[kind],
        "action": ACTION[kind],
        "detail": redact(_exception_chain(exc)),
        "diagId": "ve-" + uuid.uuid4().hex[:12],
        "retryable": True,
        "source": source,
        "at": round(time.time() * 1000),
    }


class VoiceProviderError(RuntimeError):
    """A provider failure whose classification is safe to surface to the UI."""

    def __init__(self, payload: dict, cause: BaseException | None = None):
        super().__init__(str(payload.get("summary") or "voice provider error"))
        self.payload = payload
        if cause is not None:
            self.__cause__ = cause


_reporter = None


def set_reporter(callback) -> None:
    """Install (or clear) the async sink that forwards payloads to the client."""
    global _reporter
    _reporter = callback


def health_view(payload: dict | None) -> dict | None:
    """Minimal unauthenticated health projection: no redacted detail/stack."""
    if not payload:
        return None
    keys = ("kind", "summary", "diagId", "retryable", "source", "at")
    return {key: payload[key] for key in keys if key in payload}


async def report(exc: BaseException | None, source: str = "provider") -> dict:
    """Classify, log the redacted full chain, and forward the UI payload."""
    payload = build_payload(exc, source)
    line = (
        f"[voice-error] diag={payload['diagId']} kind={payload['kind']} "
        f"source={payload['source']} detail={payload['detail']}"
    )
    try:
        from loguru import logger

        logger.warning(line)
    except Exception:  # loguru is optional for unit tests
        print(line, flush=True)
    if _reporter is not None:
        try:
            await _reporter(payload)
        except Exception as error:  # never let notification hide the real failure
            try:
                print(f"[voice-error] notify failed: {error!r}", flush=True)
            except Exception:
                pass
    return payload
