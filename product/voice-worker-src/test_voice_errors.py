"""Focused checks for actionable voice diagnostics and the direct-provider policy."""
from __future__ import annotations

import asyncio
import json
import unittest

from websockets.protocol import State

import voice_errors
from voice_errors import (
    VoiceProviderError,
    build_payload,
    classify,
    health_view,
    redact,
    report,
    set_reporter,
)

PROXY_ERROR = "Error setting up processor: connecting through a SOCKS proxy requires python-socks"


class ClassifyTests(unittest.TestCase):
    def test_proxy_socks_failure(self):
        self.assertEqual(classify(RuntimeError(PROXY_ERROR)), "proxy")

    def test_proxy_from_cause_chain(self):
        root = RuntimeError(PROXY_ERROR)
        wrapped = RuntimeError("Error setting up processor")
        wrapped.__cause__ = root
        self.assertEqual(classify(wrapped), "proxy")

    def test_auth(self):
        self.assertEqual(classify(RuntimeError("401 Unauthorized: invalid api key")), "auth")

    def test_quota(self):
        self.assertEqual(classify(RuntimeError("429 rate limit / insufficient balance")), "quota")

    def test_permission(self):
        self.assertEqual(classify(RuntimeError("NotAllowedError: microphone permission denied")), "permission")

    def test_network_dns(self):
        self.assertEqual(classify(RuntimeError("[Errno 8] getaddrinfo failed: Name or service not known")), "network")

    def test_network_timeout(self):
        self.assertEqual(classify(asyncio.TimeoutError("timed out")), "network")

    def test_provider_5xx(self):
        self.assertEqual(classify(RuntimeError("503 Service Unavailable")), "provider")

    def test_host_link_failure_is_classified_as_host_not_provider(self):
        from host_client_v2 import HostUnavailable
        self.assertEqual(classify(HostUnavailable("host request failed")), "host")
        self.assertEqual(classify(RuntimeError("host stream unavailable (HTTP 503)")), "host")
        self.assertEqual(classify(RuntimeError("bridge descriptor not found")), "host")
        payload = build_payload(HostUnavailable("host request failed"), "host")
        self.assertEqual(payload["kind"], "host")
        self.assertIn("宿主", payload["action"])

    def test_unknown(self):
        self.assertEqual(classify(RuntimeError("boom")), "unknown")

    def test_payload_is_actionable_and_bounded(self):
        payload = build_payload(RuntimeError(PROXY_ERROR + " " + "x" * 9000), "asr")
        self.assertEqual(payload["kind"], "proxy")
        self.assertTrue(payload["diagId"].startswith("ve-"))
        self.assertTrue(payload["retryable"])
        self.assertLessEqual(len(payload["detail"]), 4000)
        self.assertIn("代理", payload["action"])

    def test_health_projection_never_exposes_detail(self):
        payload = build_payload(RuntimeError(PROXY_ERROR), "asr")
        view = health_view(payload)
        assert view is not None
        self.assertNotIn("detail", view)
        self.assertEqual(view["kind"], "proxy")
        self.assertIn("diagId", view)

    def test_redaction_removes_credentials(self):
        text = redact("Authorization: Bearer abcdef1234567890 api_key=sk-live-123456789 token=zzz")
        self.assertNotIn("abcdef1234567890", text)
        self.assertNotIn("sk-live-123456789", text)
        self.assertIn("[redacted]", text)


class ReporterTests(unittest.IsolatedAsyncioTestCase):
    async def test_report_forwards_redacted_payload(self):
        seen = []

        async def sink(payload):
            seen.append(payload)

        set_reporter(sink)
        try:
            payload = await report(RuntimeError("401 Unauthorized Bearer abcdef1234567890"), "asr")
        finally:
            set_reporter(None)
        self.assertEqual(payload["kind"], "auth")
        self.assertEqual(len(seen), 1)
        self.assertNotIn("abcdef1234567890", json.dumps(seen[0]))


class _FakeWebSocket:
    state = State.OPEN

    def __init__(self, events):
        self._events = list(events)
        self.sent = []
        self.closed = False

    async def recv(self):
        return self._events.pop(0)

    async def send(self, data):
        self.sent.append(json.loads(data))

    async def close(self):
        self.closed = True


class ProviderConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_asr_and_tts_connect_directly_without_ambient_proxy(self):
        from dashscope_services import DashScopeASRService, DashScopeTTSService

        captured = []

        async def fake_connect(uri, **kwargs):
            captured.append(kwargs)
            if "/api-ws" in uri:
                pass
            return _FakeWebSocket([
                json.dumps({"type": "session.created"}),
                json.dumps({"type": "session.updated", "session": {"voice": "Cherry", "sample_rate": 24000}}),
            ])

        asr = DashScopeASRService(api_key="fixture-key")
        asr._websocket_connect = fake_connect
        await asr._connect_websocket_locked()

        tts = DashScopeTTSService(api_key="fixture-key")
        tts._websocket_connect = fake_connect
        await tts._connect_websocket_locked()

        self.assertEqual(len(captured), 2)
        for kwargs in captured:
            self.assertIsNone(kwargs.get("proxy"), "provider WebSocket must not adopt the system proxy")

    async def test_proxy_failure_is_classified_and_reported(self):
        from dashscope_services import DashScopeASRService

        seen = []

        async def sink(payload):
            seen.append(payload)

        async def failing_connect(uri, **kwargs):
            raise RuntimeError(PROXY_ERROR)

        asr = DashScopeASRService(api_key="fixture-key")
        asr._websocket_connect = failing_connect
        set_reporter(sink)
        try:
            with self.assertRaises(VoiceProviderError) as caught:
                await asr._connect_websocket()
        finally:
            set_reporter(None)
        self.assertEqual(caught.exception.payload["kind"], "proxy")
        self.assertEqual(seen[0]["kind"], "proxy")
        self.assertEqual(seen[0]["diagId"], caught.exception.payload["diagId"])


class HealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_and_stats_expose_expected_views(self):
        import server

        payload = build_payload(RuntimeError(PROXY_ERROR), "asr")
        server.LAST_VOICE_ERROR = payload
        try:
            body = await server.health()
        finally:
            server.LAST_VOICE_ERROR = None
        self.assertEqual(body["last_error"]["kind"], "proxy")
        self.assertNotIn("detail", body["last_error"])
        stats = server._session_stats({"last_error": payload})
        self.assertEqual(stats["last_error"]["detail"], payload["detail"])


if __name__ == "__main__":
    unittest.main()
