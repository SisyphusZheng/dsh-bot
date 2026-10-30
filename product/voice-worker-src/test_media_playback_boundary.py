"""Host -> worker media commands: identity, idempotency and isolation.

The worker executes media only. A late stop for an old playback never mutes a
new one, a media disconnect never cancels DSH work, and every command is acked
by commandId exactly once (duplicates are no-ops).
"""
import inspect
import unittest
from unittest.mock import AsyncMock, patch

from pipecat.frames.frames import (
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    TextFrame,
)
from pipecat.processors.frame_processor import FrameProcessor

import dsh_bridge
from capture_policy import CapturePolicy
from host_client_v2 import HostUnavailable
from testsupport import (
    FakeHost,
    feed,
    frame,
    host_command,
    make_bridge,
    pushed,
    rtvi,
    teardown_bridge,
)

TURN_1 = "sess-1:1"
TURN_2 = "sess-1:2"


def append(turn_id: str, text: str, seq: int) -> dict:
    return {"turnId": turn_id, "text": text, "seq": seq}


def ack_payloads(host: FakeHost) -> list[dict]:
    return host.payloads("presentation.ack")


class PlaybackIdentity(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    def text_frames(self):
        return [frame.text for frame in pushed(self.bridge, TextFrame)]

    async def test_speech_append_plays_host_text_with_playback_identity(self):
        await host_command(self.bridge, 1, "speech.append", append(TURN_1, "你好，我在呢。", 1))
        self.assertEqual(self.text_frames(), ["你好，我在呢。"])
        self.assertEqual(len(pushed(self.bridge, LLMFullResponseStartFrame)), 1)
        self.assertEqual(rtvi(self.bridge, "playback-identity")[0]["playbackId"], TURN_1)
        ack = ack_payloads(self.host)[-1]
        self.assertEqual(ack["commandId"], "host-cmd-1")
        self.assertEqual(ack["state"], "applied")
        # The ack carries the playback identity so the Host can settle its state.
        self.assertEqual(ack["playbackId"], TURN_1)
        self.assertEqual(self.bridge.metrics["playbacks_started"], 1)

    async def test_speech_end_closes_tts_without_cutting_audio(self):
        await host_command(self.bridge, 1, "speech.append", append(TURN_1, "先说一句。", 1))
        await host_command(self.bridge, 2, "speech.end", {"turnId": TURN_1, "reason": "turn-end"})
        self.assertEqual(len(pushed(self.bridge, LLMFullResponseEndFrame)), 1)
        self.bridge.broadcast_interruption.assert_not_awaited()
        self.assertEqual(self.bridge.metrics["playbacks_ended"], 1)
        self.assertEqual(self.bridge._playback, None)

    async def test_duplicate_command_id_is_a_noop_but_still_acked(self):
        command = {"commandId": "dup-1", "type": "speech.append", "payload": append(TURN_1, "只播一次。", 1)}
        await self.bridge._execute_command(command)
        await self.bridge._execute_command(command)
        self.assertEqual(self.text_frames(), ["只播一次。"])
        self.assertEqual(self.bridge.metrics["command_duplicates"], 1)
        acks = ack_payloads(self.host)
        self.assertEqual([ack["commandId"] for ack in acks], ["dup-1", "dup-1"])
        self.assertTrue(all(ack["state"] == "applied" for ack in acks))

    async def test_stale_speech_sequence_is_dropped(self):
        await host_command(self.bridge, 1, "speech.append", append(TURN_1, "第一句。", 2))
        await host_command(self.bridge, 2, "speech.append", append(TURN_1, "第二句。", 3))
        await host_command(self.bridge, 3, "speech.append", append(TURN_1, "重复句。", 3))
        self.assertEqual(self.text_frames(), ["第一句。", "第二句。"])
        self.assertEqual(self.bridge.metrics["duplicate_speech_dropped"], 1)
        self.assertEqual(ack_payloads(self.host)[-1]["detail"], "stale-seq-dropped")

    async def test_late_stop_for_old_playback_never_mutes_new_playback(self):
        await host_command(self.bridge, 1, "speech.append", append(TURN_1, "旧回答。", 1))
        await host_command(self.bridge, 2, "playback.stop", {"playbackId": TURN_1, "reason": "stop"})
        stops_after_first = self.bridge.broadcast_interruption.await_count
        self.assertEqual(stops_after_first, 1)
        await host_command(self.bridge, 3, "speech.append", append(TURN_2, "新回答。", 1))
        await host_command(self.bridge, 4, "playback.stop", {"playbackId": TURN_1, "reason": "late"})
        self.assertEqual(self.bridge.broadcast_interruption.await_count, stops_after_first)
        self.assertEqual(self.bridge._playback["playback_id"], TURN_2)
        self.assertTrue(self.bridge._playback["open"])
        self.assertEqual(self.bridge.metrics["stale_playback_stops"], 1)
        self.assertEqual(ack_payloads(self.host)[-1]["state"], "applied")
        self.assertEqual(ack_payloads(self.host)[-1]["detail"], "stale-playback-ignored")

    async def test_late_append_for_stopped_turn_is_dropped(self):
        await host_command(self.bridge, 1, "speech.append", append(TURN_1, "先说。", 1))
        await host_command(self.bridge, 2, "playback.stop", {"playbackId": TURN_1, "reason": "stop"})
        await host_command(self.bridge, 3, "speech.append", append(TURN_1, "迟到的旧音频。", 2))
        self.assertEqual(self.text_frames(), ["先说。"])
        self.assertEqual(self.bridge.metrics["late_speech_dropped"], 1)
        self.assertEqual(ack_payloads(self.host)[-1]["detail"], "stale-playback-dropped")

    async def test_stop_without_active_playback_is_applied_noop(self):
        await host_command(self.bridge, 1, "playback.stop", {"playbackId": "ghost", "reason": "stop"})
        self.assertEqual(ack_payloads(self.host)[-1]["state"], "applied")

    async def test_speech_end_for_unknown_turn_is_rejected(self):
        await host_command(self.bridge, 1, "speech.end", {"turnId": "sess-1:99", "reason": "end"})
        ack = ack_payloads(self.host)[-1]
        self.assertEqual(ack["state"], "rejected")
        self.assertEqual(ack["detail"], "unknown-playback")


class CaptureCommandScope(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.capture = CapturePolicy(required=True)
        self.bridge, self.host = make_bridge(capture=self.capture)

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_capture_cancel_only_affects_its_capture(self):
        self.capture.control("start", "cap-1", "hold")
        await host_command(self.bridge, 1, "capture.command",
                           {"action": "discard", "captureId": "cap-1"})
        self.assertFalse(self.capture.enabled)
        self.assertIn("cap-1", self.capture.revoked)
        self.capture.control("start", "cap-2", "toggle")
        await host_command(self.bridge, 2, "capture.command",
                           {"action": "discard", "captureId": "cap-1"})
        self.assertTrue(self.capture.enabled)
        self.assertEqual(self.capture.current, "cap-2")
        self.assertEqual(ack_payloads(self.host)[-1]["state"], "applied")
        self.assertEqual(rtvi(self.bridge, "capture-ack")[-1]["captureId"], "cap-1")

    async def test_invalid_capture_command_is_rejected_not_guessed(self):
        for payload in ({"action": "cancel-agent", "captureId": "cap-1"},
                        {"action": "start"}, {"action": "start", "captureId": ""}):
            await self.bridge._execute_command({
                "commandId": "bad-" + str(payload), "type": "capture.command", "payload": payload})
            self.assertEqual(ack_payloads(self.host)[-1]["state"], "rejected")


class NoticeAndBoundary(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_notice_show_forwards_host_text_and_acks(self):
        await host_command(self.bridge, 1, "notice.show",
                           {"noticeId": "n1", "text": "已请求停止任务，等待执行器确认。", "kind": "status"})
        notice = rtvi(self.bridge, "notice")[-1]
        self.assertEqual(notice["text"], "已请求停止任务，等待执行器确认。")
        self.assertEqual(notice["noticeId"], "n1")
        self.assertEqual(ack_payloads(self.host)[-1]["state"], "applied")

    async def test_worker_never_executes_business_commands(self):
        for command_type, payload in (
                ("control.cancel-task", {"sessionId": "sess-1"}),
                ("interaction.resolve", {"interactionId": "a", "decision": "allowed-once"}),
                ("queue.delete", {"id": "q1"}),
                ("input.confirm", {"id": "d1"}),
        ):
            await self.bridge._execute_command({
                "commandId": "biz-" + command_type, "type": command_type, "payload": payload})
            ack = ack_payloads(self.host)[-1]
            self.assertEqual(ack["state"], "rejected", command_type)
            self.assertEqual(ack["detail"], "unsupported-command-type", command_type)
            self.assertEqual(self.host.command_types(), {"presentation.ack"}, command_type)

    async def test_media_disconnect_reports_transport_and_never_cancels_work(self):
        await self.bridge.report_transport("connected")
        self.assertEqual(self.host.payloads("voice.session")[-1]["transport"], "connected")
        with patch.object(FrameProcessor, "cleanup", new=AsyncMock()):
            await self.bridge.cleanup()
        session = self.host.payloads("voice.session")[-1]
        self.assertEqual(session["transport"], "disconnected")
        self.assertIn("mediaState", session)
        allowed = {"voice.facts", "voice.session", "presentation.ack"}
        self.assertLessEqual(self.host.command_types(), allowed)
        self.assertNotIn("control.cancel-task", self.host.command_types())
        self.assertTrue(self.host.closed)

    async def test_receipt_commands_ride_facts_for_low_latency(self):
        self.host.receipts.append(self.host.receipt(
            None, status="accepted", result={"commands": [{
                "commandId": "receipt-cmd-1",
                "type": "speech.append",
                "payload": append(TURN_1, "从回执立刻播报。", 1),
            }]},))
        await feed(self.bridge, frame("停一下"))
        self.assertEqual(self.host.payloads("voice.facts")[0]["items"][0]["text"], "停一下")
        texts = [frame.text for frame in pushed(self.bridge, TextFrame)]
        self.assertEqual(texts, ["从回执立刻播报。"])
        acks = [ack["commandId"] for ack in ack_payloads(self.host)]
        self.assertEqual(acks, ["receipt-cmd-1"])

    async def test_ack_failure_is_counted_but_never_raised(self):
        self.host.fail_with = HostUnavailable("host request failed")
        await self.bridge._ack("unknown-command", "applied")
        self.assertEqual(self.bridge.metrics["ack_failures"], 1)
        self.host.fail_with = None

    async def test_earlier_turn_audio_text_is_not_reopened_after_end(self):
        await host_command(self.bridge, 1, "speech.append", append(TURN_1, "完整回答。", 1))
        await host_command(self.bridge, 2, "speech.end", {"turnId": TURN_1, "reason": "turn-end"})
        await host_command(self.bridge, 3, "speech.append", append(TURN_1, "迟到的尾句。", 2))
        texts = [frame.text for frame in pushed(self.bridge, TextFrame)]
        self.assertEqual(texts, ["完整回答。"])
        self.assertEqual(self.bridge.metrics["late_speech_dropped"], 1)


class SourceBoundary(unittest.TestCase):
    """Static proof: the media bridge source has no business endpoint calls."""

    def test_no_legacy_business_endpoints_in_worker_bridge(self):
        source = inspect.getsource(dsh_bridge)
        for path in ("/approval", "/questions/answer", "/interactions",
                     "/task-state", "/voice/turn", "/cancel"):
            self.assertNotIn(path, source, path)
        for symbol in ("control_kind", "InputAdmission", "PendingInputs",
                       "SpeechAssembly", "_answer_question", "_handle_control",
                       "announce_pending", "queue_control"):
            self.assertNotIn(symbol, source, symbol)

    def test_wake_phrase_and_queue_modules_are_gone(self):
        import importlib
        for module in ("voice_commands", "input_admission", "speech_intake", "wake_phrase"):
            with self.assertRaises(ModuleNotFoundError):
                importlib.import_module(module)


if __name__ == "__main__":
    unittest.main()
