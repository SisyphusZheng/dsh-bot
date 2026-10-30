"""Media safety is preserved after moving business routing to the Host.

CapturePolicy still owns per-connection capture identity, mute/finish/discard
scoping and delayed-final isolation; the media bridge still filters echoes and
only plays what the Host commands.
"""
import json
import unittest
from unittest.mock import AsyncMock, patch

from capture_policy import CapturePolicy
from pipecat.frames.frames import LLMFullResponseEndFrame
from testsupport import (
    feed,
    frame,
    host_command,
    make_bridge,
    pushed,
    teardown_bridge,
)


class CapturePolicyTests(unittest.TestCase):
    def test_hold_is_closed_until_explicit_start_and_release_closes_it(self):
        p = CapturePolicy(required=True)
        self.assertFalse(p.append())
        self.assertTrue(p.control('start', 'c1'))
        self.assertTrue(p.append())
        p.control('finish', 'c1')
        self.assertFalse(p.append())
        self.assertTrue(p.commit())
        self.assertFalse(p.commit())
        self.assertEqual(p.transcript('u1', final=True), 'c1')

    def test_cancelled_capture_cannot_submit_a_delayed_final_or_be_reopened(self):
        p = CapturePolicy(required=True)
        p.control('start', 'c1'); p.append(); p.commit()
        self.assertEqual(p.transcript('u1'), 'c1')
        p.control('discard', 'c1'); p.control('start', 'c2'); p.append(); p.commit()
        self.assertIsNone(p.transcript('u1', final=True))
        self.assertEqual(p.transcript('u2', final=True), 'c2')
        self.assertFalse(p.control('start', 'c1'))
        self.assertTrue(p.enabled)

    def test_stale_release_never_mutes_a_new_capture(self):
        p = CapturePolicy(required=True)
        p.control('start', 'c1'); p.control('start', 'c2'); p.control('discard', 'c1')
        self.assertTrue(p.enabled)
        self.assertEqual(p.current, 'c2')
        # Unknown media actions are rejected, not interpreted as business cancels.
        self.assertFalse(p.control('cancel-agent', 'c2'))

    def test_always_mode_retains_successive_utterances(self):
        p = CapturePolicy(required=True); p.control('start', 'always')
        for i in range(3):
            p.append(); p.commit()
            self.assertEqual(p.transcript(str(i), final=True), 'always')


class VoiceAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_welcome_echo_and_fillers_never_start_work_or_cancel(self):
        greeting = "你好，我在呢。想聊什么？"
        await host_command(self.bridge, 1, "speech.append",
                           {"turnId": "sess-1:welcome", "text": greeting, "seq": 1})
        for text in ["嗯", "嗯。", "啊", "你好，我在呢。想聊什么？", "你好我在呢想聊什么"]:
            await feed(self.bridge, frame(text, utterance_id="utt-" + text))
        self.assertEqual(self.host.payloads("voice.facts"), [])
        self.bridge.broadcast_interruption.assert_not_awaited()
        self.assertEqual(self.host.typed("voice.facts"), [])

    async def test_short_reply_is_not_mistaken_for_active_reply_echo(self):
        await host_command(self.bridge, 1, "speech.append", {
            "turnId": "sess-1:1",
            "text": "好的，我这就帮你打开浏览器并整理下载目录。",
            "seq": 1,
        })
        await host_command(self.bridge, 2, "speech.end",
                           {"turnId": "sess-1:1", "reason": "turn-end"})
        await feed(self.bridge, frame("打开浏览器", utterance_id="utt-1"))
        self.assertEqual(len(self.host.payloads("voice.facts")), 1)
        # A long contiguous fragment of the spoken reply is still echo.
        await feed(self.bridge, frame("我这就帮你打开浏览器", utterance_id="utt-2"))
        self.assertEqual(len(self.host.payloads("voice.facts")), 1)
        self.assertEqual(self.bridge.metrics["echo_transcript_dropped"], 1)

    async def test_host_speech_end_flushes_tts_before_turn_finishes(self):
        await host_command(self.bridge, 1, "speech.append",
                           {"turnId": "sess-1:1", "text": "我先查看文件。", "seq": 1})
        await host_command(self.bridge, 2, "speech.end",
                           {"turnId": "sess-1:1", "reason": "assistant-step-end"})
        self.assertIsInstance(pushed(self.bridge, LLMFullResponseEndFrame)[0],
                              LLMFullResponseEndFrame)
        self.assertEqual(self.bridge.metrics["playbacks_ended"], 1)

    async def test_valid_transcript_preserves_capture_identity_without_queue(self):
        await feed(self.bridge, frame("打开浏览器", capture_id="c1", utterance_id="u1"))
        fact = self.host.payloads("voice.facts")[0]
        self.assertEqual(fact["capture"]["captureId"], "c1")
        self.assertEqual(fact["items"][0]["utteranceId"], "u1")
        self.assertEqual(fact["items"][0]["kind"], "asr.final")
        self.assertEqual(self.host.command_types(), {"voice.facts"})


class ASRReceiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_delayed_cancelled_provider_final_is_dropped_before_bridge(self):
        from dashscope_services import DashScopeASRService
        with patch.dict('os.environ', {'DSH_CAPTURE_CONTROL': '1'}):
            service = DashScopeASRService(api_key='fixture-key')
        service.confirm_finalize = lambda: None
        service.push_frame = AsyncMock()
        service.capture.control('start', 'old'); service.capture.append(); service.capture.commit()
        service.capture.transcript('provider-old')
        service.capture.control('discard', 'old')
        service.capture.control('start', 'new'); service.capture.append(); service.capture.commit()
        service._websocket = AsyncMock()
        service._websocket.recv.side_effect = [
            json.dumps({'type': 'conversation.item.input_audio_transcription.completed',
                        'item_id': 'provider-old', 'transcript': '不应提交的旧录音'}),
            json.dumps({'type': 'conversation.item.input_audio_transcription.completed',
                        'item_id': 'provider-new', 'transcript': '新的请求'}),
            RuntimeError('fixture connection ended'),
        ]
        await service._receive_messages()
        self.assertEqual(service.push_frame.await_count, 1)
        transcript = service.push_frame.call_args.args[0]
        self.assertEqual(transcript.text, '新的请求')
        self.assertEqual(transcript.metadata['capture_id'], 'new')
        self.assertEqual(transcript.metadata['utterance_id'], 'provider-new')

    async def test_audio_drain_keeps_capture_identity_for_late_finals(self):
        from dashscope_services import DashScopeASRService
        with patch.dict('os.environ', {'DSH_CAPTURE_CONTROL': '1'}):
            service = DashScopeASRService(api_key='fixture-key')
        service.confirm_finalize = lambda: None
        service.push_frame = AsyncMock()
        service.capture.control('start', 'c1', 'hold')
        service.capture.append(); service.capture.commit()
        service.capture.transcript('provider-1')
        service.capture.control('finish', 'c1')  # drain window: capture identity stays
        service._websocket = AsyncMock()
        service._websocket.recv.side_effect = [
            json.dumps({'type': 'conversation.item.input_audio_transcription.completed',
                        'item_id': 'provider-1', 'transcript': '松键后的最终句'}),
            RuntimeError('fixture connection ended'),
        ]
        await service._receive_messages()
        self.assertEqual(service.push_frame.await_count, 1)
        self.assertEqual(service.push_frame.call_args.args[0].metadata['capture_id'], 'c1')


if __name__ == '__main__':
    unittest.main()
