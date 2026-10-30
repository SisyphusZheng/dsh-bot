"""Passive input is Host-owned: the worker only reports ASR/capture facts.

After the beta2 migration the worker has no draft, queue, confirmation or
answer path: passive (always-mode) speech becomes a fact, and the Host decides
whether it is confirmed, routed or ignored. Media admission (capture identity,
echo rejection, discard) stays in the worker.
"""
import unittest

from capture_policy import CapturePolicy
from testsupport import (
    feed,
    frame,
    host_command,
    make_bridge,
    rtvi,
    teardown_bridge,
)

BUSINESS_ATTRS = (
    "_pending", "_input_admission", "_speech", "_queue_session_id",
    "confirm_input", "discard_input", "enqueue_input", "_start_next_turn",
)


class PassiveInput(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.capture = CapturePolicy(required=True)
        self.capture.control("start", "cap-passive", "always")
        self.bridge, self.host = make_bridge(capture=self.capture)

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_worker_has_no_queue_or_draft_api(self):
        for name in BUSINESS_ATTRS:
            self.assertFalse(hasattr(self.bridge, name), name)

    async def test_passive_final_produces_only_a_fact(self):
        await feed(self.bridge, frame("打开浏览器", capture_id="cap-passive", mode="always"))
        facts = self.host.payloads("voice.facts")
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["capture"]["mode"], "always")
        self.assertEqual(facts[0]["items"][0]["kind"], "asr.final")
        self.assertEqual(self.host.command_types(), {"voice.facts"})
        for message_type in ("input-confirmation", "queue-state", "control-result"):
            self.assertEqual(rtvi(self.bridge, message_type), [], message_type)

    async def test_short_yes_without_a_pending_approval_is_a_fact(self):
        await feed(self.bridge, frame("是", capture_id="cap-passive", mode="always"))
        self.assertEqual(self.host.payloads("voice.facts")[0]["items"][0]["text"], "是")
        self.assertEqual(self.host.command_types(), {"voice.facts"})

    async def test_empty_or_filler_final_never_becomes_a_fact(self):
        await feed(self.bridge, frame("嗯。", capture_id="cap-passive", mode="always"))
        self.assertEqual(self.host.payloads("voice.facts"), [])
        rejected = rtvi(self.bridge, "capture-rejected")
        self.assertEqual(rejected[-1]["captureId"], "cap-passive")

    async def test_no_fabricated_request_or_answer_identity(self):
        await feed(self.bridge, frame("确认允许一次", capture_id="cap-passive", mode="always"))
        payload = self.host.payloads("voice.facts")[0]
        serialized = str(payload)
        for fabricated in ("requestId", "clientTurnId", "answerId", "interactionId",
                           "decision", "approval"):
            self.assertNotIn(f'"{fabricated}"', serialized, fabricated)


class EchoAndMediaSafety(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_greeting_echo_never_becomes_an_input_fact(self):
        greeting = "你好，我在呢。想聊什么，或者有什么需要我帮忙的？"
        await host_command(self.bridge, 1, "speech.append",
                           {"turnId": "sess-1:welcome", "text": greeting, "seq": 1})
        await host_command(self.bridge, 2, "speech.end",
                           {"turnId": "sess-1:welcome", "reason": "greeting"})
        await feed(self.bridge, frame(greeting))
        self.assertEqual(self.host.payloads("voice.facts"), [])
        self.assertEqual(self.bridge.metrics["echo_transcript_dropped"], 1)
        self.assertEqual(rtvi(self.bridge, "capture-rejected")[-1]["captureId"], "cap-1")

    async def test_short_legitimate_reply_after_greeting_is_admitted(self):
        greeting = "你好，我在呢。想聊什么，或者有什么需要我帮忙的？"
        await host_command(self.bridge, 1, "speech.append",
                           {"turnId": "sess-1:welcome", "text": greeting, "seq": 1})
        await host_command(self.bridge, 2, "speech.end",
                           {"turnId": "sess-1:welcome", "reason": "greeting"})
        for text in ("你好", "我在", "想聊什么"):
            await feed(self.bridge, frame(text, utterance_id="utt-" + text))
        self.assertEqual(
            [payload["items"][0]["text"] for payload in self.host.payloads("voice.facts")],
            ["你好", "我在", "想聊什么"],
        )

    async def test_muted_capture_audio_is_not_admitted(self):
        self.capture = CapturePolicy(required=True)
        self.capture.control("start", "cap-1", "always")
        self.capture.control("finish", "cap-1")
        self.assertFalse(self.capture.append())
        self.assertFalse(self.capture.enabled)

    async def test_delayed_final_for_cancelled_capture_is_dropped_by_asr_layer(self):
        # The ASR service consults CapturePolicy before forwarding a transcript;
        # a cancelled capture can therefore never reach the fact path.
        self.capture = CapturePolicy(required=True)
        self.capture.control("start", "cap-old", "hold")
        self.capture.append()
        self.capture.commit()
        self.capture.transcript("provider-old")
        self.capture.control("discard", "cap-old")
        self.capture.control("start", "cap-new", "hold")
        self.capture.append()
        self.capture.commit()
        self.assertIsNone(self.capture.transcript("provider-old", final=True))
        self.assertEqual(self.capture.transcript("provider-new", final=True), "cap-new")


if __name__ == "__main__":
    unittest.main()
