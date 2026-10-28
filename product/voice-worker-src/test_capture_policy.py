import time
import unittest
from unittest.mock import AsyncMock, patch
from capture_policy import CapturePolicy
from dsh_bridge import DSHBridgeProcessor, _is_cancel
from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame, LLMFullResponseEndFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection


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
        self.assertFalse(p.control('cancel-agent', 'c2'))

    def test_always_mode_retains_successive_utterances(self):
        p = CapturePolicy(required=True); p.control('start', 'always')
        for i in range(3):
            p.append(); p.commit()
            self.assertEqual(p.transcript(str(i), final=True), 'always')

    def test_cancel_is_an_explicit_command_not_a_substring(self):
        self.assertFalse(_is_cancel('停止。'))
        self.assertTrue(_is_cancel('停止任务。'))
        self.assertFalse(_is_cancel('cancel'))
        self.assertFalse(_is_cancel('不要取消任务，打开浏览器'))
        self.assertFalse(_is_cancel('解释 cancellation 是什么意思'))


class VoiceAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_welcome_echo_and_fillers_never_start_or_cancel_a_task(self):
        p = DSHBridgeProcessor('/unused'); p.set_greeting('你好，我在呢。想聊什么？'); p._bridge_request = AsyncMock(return_value={'requests': []})
        p.push_frame = AsyncMock(); p._start_next_turn = AsyncMock(); p._cancel_current = AsyncMock(); p._send_rtvi = AsyncMock()
        with patch.object(FrameProcessor, 'process_frame', new=AsyncMock()):
            for text in ['嗯', '嗯。', '啊', '你好，我在呢。想聊什么？', '你好我在呢想聊什么']:
                await p.process_frame(TranscriptionFrame(text, 'u', 'now'), FrameDirection.DOWNSTREAM)
            self.assertEqual(p._start_next_turn.await_count, 0)
            self.assertEqual(p._cancel_current.await_count, 0)
            self.assertEqual(p._send_rtvi.await_count, 0)
            # Short intentional replies are not blanket-filtered, including the
            # greeting's own words said back by the user.
            for text in ['是', '否', '打开浏览器', '你好', '我在', '想聊什么']:
                await p.process_frame(TranscriptionFrame(text, 'u', 'now'), FrameDirection.DOWNSTREAM)
            self.assertEqual(p._start_next_turn.await_count, 6)

    async def test_short_reply_is_not_mistaken_for_active_reply_echo(self):
        p = DSHBridgeProcessor('/unused')
        p.push_frame = AsyncMock(); p._start_next_turn = AsyncMock(); p._cancel_current = AsyncMock(); p._send_rtvi = AsyncMock()
        p._current = None
        p._last_barge_context = {
            "turn_key": "r1",
            "reply_text": "好的，我这就帮你打开浏览器并整理下载目录。",
            "audible": True,
            "ended_mono": time.monotonic(),
        }
        with patch.object(FrameProcessor, 'process_frame', new=AsyncMock()):
            await p.process_frame(TranscriptionFrame("打开浏览器", 'u', 'now'), FrameDirection.DOWNSTREAM)
            self.assertEqual(p._start_next_turn.await_count, 1)
            # A long contiguous fragment of the spoken reply is still echo.
            await p.process_frame(TranscriptionFrame("我这就帮你打开浏览器", 'u', 'now'), FrameDirection.DOWNSTREAM)
            self.assertEqual(p._start_next_turn.await_count, 1)

    async def test_assistant_step_end_flushes_tts_before_agent_turn_finishes(self):
        p = DSHBridgeProcessor('/unused'); p.push_frame = AsyncMock()
        current = {"turn_key": "r1", "audible": True}
        await p._handle_bridge_event(current, {"type": "text", "text": "我先查看文件。"})
        await p._handle_bridge_event(current, {"type": "assistant-end"})
        self.assertFalse(current["response_open"])
        self.assertIsInstance(p.push_frame.call_args.args[0], LLMFullResponseEndFrame)
        self.assertIsNone(current.get("completed"))

    async def test_valid_transcript_preserves_capture_identity(self):
        p = DSHBridgeProcessor('/unused'); p.push_frame = AsyncMock(); p._start_next_turn = AsyncMock(); p._send_rtvi = AsyncMock()
        frame = TranscriptionFrame('打开浏览器', 'u', 'now'); frame.metadata.update(capture_id='c1', utterance_id='u1')
        with patch.object(FrameProcessor, 'process_frame', new=AsyncMock()):
            await p.process_frame(frame, FrameDirection.DOWNSTREAM)
        self.assertEqual(p._send_rtvi.call_args.args[0]['captureId'], 'c1')
        self.assertTrue(p._send_rtvi.call_args.args[0]['final'])
        self.assertEqual(list(p._pending), ['打开浏览器'])

class ASRReceiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_delayed_cancelled_provider_final_is_dropped_before_bridge(self):
        import json
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
            json.dumps({'type':'conversation.item.input_audio_transcription.completed','item_id':'provider-old','transcript':'不应提交的旧录音'}),
            json.dumps({'type':'conversation.item.input_audio_transcription.completed','item_id':'provider-new','transcript':'新的请求'}),
            RuntimeError('fixture connection ended'),
        ]
        await service._receive_messages()
        self.assertEqual(service.push_frame.await_count, 1)
        frame = service.push_frame.call_args.args[0]
        self.assertEqual(frame.text, '新的请求')
        self.assertEqual(frame.metadata['capture_id'], 'new')
        self.assertEqual(frame.metadata['utterance_id'], 'provider-new')


if __name__ == '__main__':
    unittest.main()
