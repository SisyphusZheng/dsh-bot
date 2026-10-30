"""Media contract: barge-in/duck remain media effects; the Host owns stopping.

The worker may duck the current playback when VAD detects speech and restore it
when the audio turns out to be an echo, but it must not decide a business stop:
that arrives as a ``playback.stop`` command with a playbackId.
"""
import time
import unittest
from unittest.mock import AsyncMock, patch

from pipecat.frames.frames import (
    InterimTranscriptionFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from testsupport import (
    host_command,
    make_bridge,
    rtvi,
    teardown_bridge,
)

TURN_1 = "sess-1:1"


class BargeMedia(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge, self.host = make_bridge()

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def start_playback(self, text="今天是晴天，适合出去散步。"):
        await host_command(self.bridge, 1, "speech.append",
                           {"turnId": TURN_1, "text": text, "seq": 1})
        self.bridge.push_frame.reset_mock()

    async def vad_start(self):
        with patch.object(FrameProcessor, "process_frame", new=AsyncMock()):
            await self.bridge.process_frame(VADUserStartedSpeakingFrame(),
                                            FrameDirection.DOWNSTREAM)

    async def interim(self, text, *, age=0.7):
        candidate = self.bridge._barge_candidate
        self.assertIsNotNone(candidate)
        candidate["started_mono"] = time.monotonic() - age
        with patch.object(FrameProcessor, "process_frame", new=AsyncMock()):
            await self.bridge.process_frame(
                InterimTranscriptionFrame(text, "test-user", "now"), FrameDirection.DOWNSTREAM)

    async def test_vad_ducks_playback_but_never_stops_it_locally(self):
        await self.start_playback()
        await self.vad_start()
        duck = rtvi(self.bridge, "duck-playback")
        self.assertEqual(len(duck), 1)
        self.assertEqual(duck[0]["playbackId"], TURN_1)
        self.assertEqual(duck[0]["factor"], 0.3)
        self.bridge.broadcast_interruption.assert_not_awaited()

    async def test_confirmed_barge_in_is_reported_as_media_effect_only(self):
        await self.start_playback()
        await self.vad_start()
        await self.interim("我想换一个话题")
        confirmed = rtvi(self.bridge, "barge-in-confirmed")
        self.assertEqual(len(confirmed), 1)
        self.assertEqual(confirmed[0]["playbackId"], TURN_1)
        # A barge-in is not a business stop: the Host decides via playback.stop.
        self.bridge.broadcast_interruption.assert_not_awaited()
        self.assertTrue(self.bridge._playback["open"])

    async def test_echo_restores_volume_without_confirmation(self):
        await self.start_playback()
        await self.vad_start()
        await self.interim("适合出去散步")
        self.assertEqual(rtvi(self.bridge, "barge-in-confirmed"), [])
        self.assertEqual(rtvi(self.bridge, "restore-playback")[-1]["playbackId"], TURN_1)
        self.assertEqual(self.bridge.metrics["barge_rejected_echo"], 1)
        self.assertFalse(self.bridge._playback["stopped"])

    async def test_filler_partial_never_confirms(self):
        await self.start_playback()
        await self.vad_start()
        await self.interim("嗯", age=0.7)
        self.assertEqual(self.bridge.metrics["barge_confirmed"], 0)
        self.assertEqual(rtvi(self.bridge, "barge-in-confirmed"), [])

    async def test_barge_in_never_issues_business_commands(self):
        await self.start_playback()
        await self.vad_start()
        await self.interim("等一下")
        # Facts may be reported, but no business command/ack for the barge effect.
        for command in self.host.commands:
            self.assertIn(command["type"], {"voice.facts", "presentation.ack"})

    async def test_host_stop_command_cancels_duck_and_stops_named_playback(self):
        await self.start_playback()
        await self.vad_start()
        await host_command(self.bridge, 2, "playback.stop",
                           {"playbackId": TURN_1, "reason": "user-stop"})
        self.bridge.broadcast_interruption.assert_awaited_once()
        self.assertTrue(self.bridge._barge_candidate is None)
        self.assertEqual(rtvi(self.bridge, "stop-playback")[-1]["playbackId"], TURN_1)


class PassiveVad(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from capture_policy import CapturePolicy
        self.capture = CapturePolicy(required=True)
        self.capture.control("start", "c1", "always")
        self.bridge, self.host = make_bridge(capture=self.capture)

    async def asyncTearDown(self):
        await teardown_bridge(self.bridge)

    async def test_passive_listening_vad_never_ducks_or_confirms(self):
        await host_command(self.bridge, 1, "speech.append",
                           {"turnId": TURN_1, "text": "正在播报内容。", "seq": 1})
        with patch.object(FrameProcessor, "process_frame", new=AsyncMock()):
            await self.bridge.process_frame(VADUserStartedSpeakingFrame(),
                                            FrameDirection.DOWNSTREAM)
        self.assertIsNone(self.bridge._barge_candidate)
        self.assertEqual(rtvi(self.bridge, "duck-playback"), [])


if __name__ == "__main__":
    unittest.main()
