"""Worker no longer owns control classification, approval answering or queues.

Control-sounding utterances are ordinary ASR facts for the Host UtteranceRouter;
user-facing strings come from Host notices/playback commands. This file proves
the deletion both statically (no legacy handlers/endpoints in the worker) and
behaviorally (a control phrase produces facts, no business side effect).
"""
import inspect
import unittest

import dsh_bridge
import server
from dsh_bridge import VoiceMediaBridge
from pipecat.frames.frames import TextFrame
from testsupport import (
    feed,
    frame,
    host_command,
    make_bridge,
    pushed,
    rtvi,
    teardown_bridge,
)

FORBIDDEN_BRIDGE_ATTRS = (
    "_handle_control", "_answer_question", "announce_pending", "confirm_input",
    "discard_input", "enqueue_input", "publish_queue", "queue_control",
    "set_question_view", "_start_next_turn", "_run_turn", "set_greeting",
)
FORBIDDEN_BRIDGE_SOURCE = (
    "/approval", "/questions/answer", "/interactions", "/task-state",
    "/voice/turn", "/cancel", "control_kind", "InputAdmission", "PendingInputs",
    "SpeechAssembly", "needs_confirmation", "DSH_VOICE_GREETING",
    "approval-allow", "task-stop", "playback-stop", "question-answer",
    "input-confirmation", "queue-state", "control-result", "task-queued",
)
FORBIDDEN_SERVER_SOURCE = (
    "input-confirmation", "queue-control", "question-view", "playback-style",
    "interaction-prompt", "control-result", "task-queued", "announce_pending",
    "/approval", "/questions/answer", "/interactions", "/task-state", "/voice/turn",
)
BUSINESS_RTVI_TYPES = {
    "input-confirmation", "input-confirmation-ended", "queue-state",
    "question-answer", "interaction-prompt", "control-result", "task-queued",
    "playback-style", "question-view",
}


class StaticBoundary(unittest.TestCase):
    def test_bridge_has_no_business_handlers(self):
        for name in FORBIDDEN_BRIDGE_ATTRS:
            self.assertFalse(hasattr(VoiceMediaBridge, name), name)

    def test_bridge_source_has_no_business_routes_or_control_grammar(self):
        source = inspect.getsource(dsh_bridge)
        for needle in FORBIDDEN_BRIDGE_SOURCE:
            self.assertNotIn(needle, source, needle)

    def test_server_source_has_no_business_rtvi_or_endpoints(self):
        source = inspect.getsource(server)
        for needle in FORBIDDEN_SERVER_SOURCE:
            self.assertNotIn(needle, source, needle)

    def test_worker_health_projection_is_media_only(self):
        bridge, _host = make_bridge()
        state = bridge.health_state()
        self.assertEqual(set(state), {"connectionId", "transport", "host", "capture",
                                      "playback", "metrics"})
        self.assertNotIn("pending", state)
        self.assertNotIn("quarantine", state)


class ControlPhrasesAreFactsOnly(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    def assert_no_business_rtvi(self):
        for message_type in BUSINESS_RTVI_TYPES:
            self.assertEqual(rtvi(self.bridge, message_type), [], message_type)

    async def test_stop_task_phrase_is_only_an_asr_fact(self):
        await feed(self.bridge, frame("停止任务。"))
        payload = self.host.payloads("voice.facts")[0]
        self.assertEqual(payload["items"][0]["kind"], "asr.final")
        self.assertEqual(payload["items"][0]["text"], "停止任务。")
        self.assertEqual(self.host.command_types(), {"voice.facts"})
        self.assert_no_business_rtvi()
        self.bridge.broadcast_interruption.assert_not_awaited()

    async def test_approval_phrase_never_answers_and_never_grants(self):
        for text in ("确认允许一次", "拒绝这次", "我允许一次"):
            await feed(self.bridge, frame(text, utterance_id="utt-" + text))
        self.assertEqual(len(self.host.payloads("voice.facts")), 3)
        self.assertEqual(self.host.command_types(), {"voice.facts"})
        self.assert_no_business_rtvi()

    async def test_question_answer_phrase_is_not_answered_in_worker(self):
        await feed(self.bridge, frame("最后一个选项"))
        self.assertEqual(self.host.command_types(), {"voice.facts"})
        self.assert_no_business_rtvi()

    async def test_repeated_final_is_not_deduped_into_silence_by_worker(self):
        # The Host dedupes by utterance/item/revision; the worker must not swallow
        # a repeated final based on its own business memory.
        await feed(self.bridge, frame("停一下", utterance_id="utt-fixed"))
        await feed(self.bridge, frame("停一下", utterance_id="utt-fixed"))
        facts = self.host.payloads("voice.facts")
        self.assertEqual(len(facts), 2)
        self.assertEqual(facts[0]["items"][0]["revision"], 1)
        self.assertEqual(facts[1]["items"][0]["revision"], 2)

    async def test_host_notice_is_the_ux_string_source(self):
        await host_command(self.bridge, 1, "notice.show",
                           {"noticeId": "n-1", "text": "已停止播报；没有请求取消任务。",
                            "kind": "status"})
        notices = rtvi(self.bridge, "notice")
        self.assertEqual(len(notices), 1)
        self.assertEqual(notices[0]["text"], "已停止播报；没有请求取消任务。")
        self.assert_no_business_rtvi()


class GreetingIsHostTriggered(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_worker_reports_transport_and_plays_host_provided_greeting(self):
        await self.bridge.report_transport("connected")
        self.assertEqual(self.host.payloads("voice.session")[-1]["transport"], "connected")
        # No greeting is self-triggered by the worker...
        self.assertEqual(pushed(self.bridge, TextFrame), [])
        # ...the Host decides the trigger and supplies the persona text.
        await host_command(self.bridge, 1, "speech.append", {
            "turnId": "sess-1:welcome-worker-test-1",
            "text": "你好，我在呢。想聊什么？",
            "seq": 1,
        })
        frames = pushed(self.bridge, TextFrame)
        self.assertEqual([value.text for value in frames], ["你好，我在呢。想聊什么？"])
        self.assertEqual(rtvi(self.bridge, "playback-identity")[-1]["playbackId"],
                         "sess-1:welcome-worker-test-1")


if __name__ == "__main__":
    unittest.main()
