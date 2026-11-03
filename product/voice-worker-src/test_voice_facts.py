"""Worker -> Host facts: identity, revision and nullable confidence.

These tests prove the worker reports capture/ASR facts instead of owning any
business decision: the payload has no routing, queue, approval or request ids.
"""
import asyncio
import re
import unittest
from datetime import datetime
from unittest.mock import AsyncMock, patch

from pipecat.frames.frames import (
    InterimTranscriptionFrame,
    TranscriptionFrame,
)

from capture_policy import CapturePolicy
from testsupport import (
    FakeHost,
    feed,
    frame,
    make_bridge,
    teardown_bridge,
)

FACT_KEYS = {"connectionId", "capture", "items", "release"}
CAPTURE_KEYS = {"captureId", "mode", "state"}
ITEM_KEYS = {"kind", "itemId", "utteranceId", "revision", "text", "at", "confidence"}
FORBIDDEN_KEYS = {
    "requestId", "clientTurnId", "turnId", "decision", "answer", "approval",
    "queue", "controlKind", "needsConfirmation", "view", "answerId", "intent",
}
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class FactShape(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    def facts(self):
        return self.host.payloads("voice.facts")

    async def test_partial_then_final_fact_shape_and_monotonic_revision(self):
        await feed(self.bridge, frame("请帮我", final=False, provider_item_id="item-9"))
        await feed(self.bridge, frame("请帮我整理报告。", final=True, provider_item_id="item-9"))
        facts = self.facts()
        self.assertEqual(len(facts), 2)
        for payload in facts:
            self.assertEqual(set(payload) - {"release"}, {"connectionId", "capture", "items"})
            self.assertEqual(set(payload["capture"]), CAPTURE_KEYS)
            self.assertEqual(payload["capture"]["captureId"], "cap-1")
            self.assertEqual(payload["capture"]["mode"], "toggle")
            self.assertEqual(payload["capture"]["state"], "transcribing")
            self.assertEqual(payload["connectionId"], "worker-test-1")
        partial_item, final_item = facts[0]["items"][0], facts[1]["items"][0]
        self.assertEqual(set(partial_item), {"kind", "itemId", "utteranceId", "revision", "text", "at"})
        self.assertEqual(partial_item["kind"], "asr.partial")
        self.assertEqual(final_item["kind"], "asr.final")
        self.assertEqual(partial_item["itemId"], "item-9")
        self.assertEqual(partial_item["utteranceId"], "utt-1")
        self.assertEqual(final_item["text"], "请帮我整理报告。")
        self.assertEqual(partial_item["revision"], 1)
        self.assertEqual(final_item["revision"], 2)
        self.assertRegex(partial_item["at"], ISO_RE)
        datetime.fromisoformat(partial_item["at"].replace("Z", "+00:00"))
        self.assertNotIn("confidence", partial_item)
        self.assertNotIn("confidence", final_item)

    async def test_provider_confidence_is_passed_through_but_never_invented(self):
        await feed(self.bridge, frame("打开浏览器", final=True, provider_item_id="item-c",
                                      confidence=0.82))
        await feed(self.bridge, frame("再打开设置", final=True, provider_item_id="item-d",
                                      utterance_id="utt-d"))
        facts = self.facts()
        self.assertEqual(facts[0]["items"][0]["confidence"], 0.82)
        self.assertNotIn("confidence", facts[1]["items"][0])
        self.assertIsInstance(facts[0]["items"][0]["confidence"], float)

    async def test_duplicate_partial_text_is_not_reported_twice(self):
        await feed(self.bridge, frame("请帮我", final=False))
        await feed(self.bridge, frame("请帮我", final=False))
        self.assertEqual(len(self.facts()), 1)
        self.assertEqual(self.bridge.metrics["duplicate_partials"], 1)

    async def test_same_provider_item_in_distinct_captures_keeps_identity(self):
        await feed(self.bridge, frame("第一句", final=True, capture_id="cap-a",
                                      provider_item_id="shared"))
        await feed(self.bridge, frame("第二句", final=True, capture_id="cap-b",
                                      provider_item_id="shared"))
        facts = self.facts()
        self.assertEqual(facts[0]["capture"]["captureId"], "cap-a")
        self.assertEqual(facts[1]["capture"]["captureId"], "cap-b")
        self.assertEqual(facts[0]["items"][0]["revision"], 1)
        self.assertEqual(facts[1]["items"][0]["revision"], 1)

    async def test_capture_release_and_discard_facts_keep_reason(self):
        await self.bridge.capture_changed("start", "cap-1", "hold")
        await self.bridge.capture_changed("finish", "cap-1")
        await self.bridge.capture_changed("discard", "cap-2")
        facts = self.facts()
        self.assertEqual(facts[0]["capture"]["state"], "listening")
        self.assertEqual(facts[0]["items"], [])
        self.assertNotIn("release", facts[0])
        self.assertEqual(facts[1]["release"], {"captureId": "cap-1", "reason": "release"})
        self.assertEqual(facts[1]["capture"]["state"], "closing")
        self.assertEqual(facts[2]["release"], {"captureId": "cap-2", "reason": "discard"})
        self.assertEqual(facts[2]["capture"]["state"], "off")

    async def test_payload_never_carries_business_fields_or_fabricated_ids(self):
        await feed(self.bridge, frame("停止任务"))
        await feed(self.bridge, frame("确认允许一次", utterance_id="utt-2"))
        await self.bridge.capture_changed("discard", "cap-1")
        facts = self.facts()
        self.assertEqual(len(facts), 3)
        serialized = str(facts)
        for forbidden in FORBIDDEN_KEYS:
            self.assertNotIn(f'"{forbidden}"', serialized, forbidden)
        for payload in facts:
            self.assertLessEqual(set(payload), FACT_KEYS)
            for item in payload["items"]:
                self.assertLessEqual(set(item), ITEM_KEYS)
        for command in self.host.typed("voice.facts"):
            # commandId belongs to the protocol client, not to the fact payload.
            self.assertIsNone(command["command_id"])

    async def test_transcript_without_capture_identity_is_not_invented(self):
        orphan = TranscriptionFrame("打开浏览器", "test-user", "now")
        await feed(self.bridge, orphan)
        self.assertEqual(self.facts(), [])
        self.assertEqual(self.bridge.metrics["facts_without_capture"], 1)

    async def test_fact_send_failure_is_counted_and_not_reported_as_success(self):
        from host_client_v2 import HostUnavailable
        self.host.fail_with = HostUnavailable("host request failed")
        await feed(self.bridge, frame("打开浏览器"))
        self.assertEqual(self.bridge.metrics["facts_failed"], 1)
        self.assertEqual(self.bridge.metrics["facts_sent"], 0)
        self.assertEqual(len(self.host.typed("voice.facts")), 1)
        self.assertIsNone(self.host.typed("voice.facts")[0]["command_id"],
                          "the bridge delegates commandId generation to the protocol client")


class CaptureIdentityGate(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.capture = CapturePolicy(required=True)
        self.capture.control("start", "cap-hold", "hold")
        self.bridge, self.host = make_bridge(capture=self.capture)

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_audio_gate_does_not_admit_muted_capture(self):
        self.capture.control("finish", "cap-hold")
        self.assertFalse(self.capture.append())

    async def test_facts_use_shared_capture_identity_not_a_new_one(self):
        await feed(self.bridge, frame("整理下载目录", capture_id="cap-hold", mode="hold"))
        payload = self.host.payloads("voice.facts")[0]
        self.assertEqual(payload["capture"]["captureId"], "cap-hold")
        self.assertEqual(payload["capture"]["mode"], "hold")
        self.assertEqual(payload["items"][0]["kind"], "asr.final")

    async def test_cancelled_capture_is_dropped_by_asr_layer_and_cannot_reopen(self):
        self.capture.control("discard", "cap-hold")
        self.capture.control("start", "cap-new", "toggle")
        self.assertFalse(self.capture.control("start", "cap-hold", "hold"))
        self.assertTrue(self.capture.enabled)
        self.assertEqual(self.capture.current, "cap-new")


if __name__ == "__main__":
    unittest.main()


class CaptureModeFacts(unittest.IsolatedAsyncioTestCase):
    """Release/discard facts must keep the mode the user started with.

    The WebRTC release message carries no mode. Defaulting it to "always" used
    to rewrite the Host projection mid-capture, so a later final looked like an
    always-listening utterance (confirmation draft) and the wrong mode was
    persisted for the next launch.
    """

    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge(capture=CapturePolicy(required=True))

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_finish_without_mode_keeps_the_start_mode(self):
        await self.bridge.capture_changed("start", "cap-hold", "hold")
        await self.bridge.capture_changed("finish", "cap-hold")
        facts = self.host.payloads("voice.facts")
        self.assertEqual([f["capture"]["mode"] for f in facts], ["hold", "hold"])
        self.assertEqual(facts[-1]["capture"]["state"], "closing")
        self.assertEqual(facts[-1]["release"], {"captureId": "cap-hold", "reason": "release"})

    async def test_discard_without_mode_keeps_the_start_mode(self):
        await self.bridge.capture_changed("start", "cap-toggle", "toggle")
        await self.bridge.capture_changed("discard", "cap-toggle")
        facts = self.host.payloads("voice.facts")
        self.assertEqual([f["capture"]["mode"] for f in facts], ["toggle", "toggle"])
        self.assertEqual(facts[-1]["release"]["reason"], "discard")

    async def test_an_explicit_valid_mode_still_updates_the_projection(self):
        await self.bridge.capture_changed("start", "cap-mode", "hold")
        await self.bridge.capture_changed("start", "cap-mode-2", "always")
        modes = [f["capture"]["mode"] for f in self.host.payloads("voice.facts")]
        self.assertEqual(modes, ["hold", "always"])


class ShutdownNoise(unittest.IsolatedAsyncioTestCase):
    """Stopping the app must not surface a "voice connection failed" bubble.

    The Host bridge closes before the worker finishes its teardown, so the
    persisted SSE stream ends mid-transfer (ClientPayloadError/TransferEncoding
    Error). That is expected during an intentional stop and must never be
    reported to the user as a retryable voice failure.
    """

    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_host_link_failure_during_shutdown_is_suppressed(self):
        import dsh_bridge
        from host_client_v2 import HostUnavailable

        reported = []

        async def record(*args, **kwargs):
            reported.append((args, kwargs))

        with patch.object(dsh_bridge, "report_voice_error", new=record):
            self.bridge._closing = True
            self.bridge._host_error_reported_at = 0.0
            self.bridge._report_host_error(HostUnavailable("host event stream closed", kind="network"))
            await asyncio.sleep(0)
            self.assertEqual(reported, [],
                             "shutdown-time Host stream truncation must not reach the UI")
            self.assertEqual(self.bridge._host_error_reported_at, 0.0)

            # A single transient drop is retried silently; only a repeatedly failing
            # link is user-actionable.
            self.bridge._closing = False
            self.bridge._report_host_error(HostUnavailable("host event stream closed", kind="network"), consecutive=1)
            await asyncio.sleep(0)
            self.assertEqual(reported, [], "one transient drop must stay silent")

            # After teardown completes a repeated classified failure is reportable again.
            self.bridge._report_host_error(HostUnavailable("host event stream closed", kind="network"), consecutive=2)
            await asyncio.sleep(0)
            self.assertEqual(len(reported), 1)
