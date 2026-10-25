import asyncio
import time
import unittest
from unittest.mock import AsyncMock, patch
from dsh_bridge import DSHBridgeProcessor
from pipecat.frames.frames import VADUserStartedSpeakingFrame, InterimTranscriptionFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

class VoiceContract(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, heard, interrupted):
        p = DSHBridgeProcessor('/unused')
        p.push_frame = AsyncMock()
        p.broadcast_interruption = AsyncMock()
        p._send_rtvi = AsyncMock()
        p._current = {'turn_key':'test-1','request_id':'r1','audible':True,'text_started':True,'reply_text':'今天是晴天，适合出去散步。','cancelled':False}
        with patch.object(FrameProcessor, 'process_frame', new=AsyncMock()):
            await p.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
            p._barge_candidate['started_mono'] = time.monotonic() - 0.7
            await p.process_frame(InterimTranscriptionFrame(text=heard,user_id='u',timestamp='now'), FrameDirection.DOWNSTREAM)
            self.assertEqual(p.broadcast_interruption.await_count, int(interrupted))
            if interrupted:
                self.assertFalse(p._current['audible'])
                before = p.push_frame.await_count
                await p._handle_bridge_event(p._current, {'type':'text','text':'这是迟到的旧回答'})
                self.assertEqual(p.push_frame.await_count, before)
                self.assertEqual(p.metrics['late_text_dropped'], 1)
        p._cancel_barge_timeout()
        await asyncio.sleep(0)
    async def test_natural_barge_in(self):
        await self.exercise('我想换一个话题', True)
    async def test_explicit_interrupt(self):
        await self.exercise('等一下', True)
    async def test_echo_and_short_noise(self):
        await self.exercise('适合出去散步', False)
        await self.exercise('嗯', False)

if __name__ == '__main__': unittest.main()
