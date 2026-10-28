import asyncio
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from dsh_bridge import DSHBridgeProcessor
from voice_commands import control_kind
from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame, VADUserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection


class Controls(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.processors = []

    def make(self):
        p = DSHBridgeProcessor('/unused'); self.processors.append(p)
        p._send_rtvi = AsyncMock(); p.push_frame = AsyncMock(); p.push_error_frame = AsyncMock()
        p.broadcast_interruption = AsyncMock(); p._cancel_current = AsyncMock()
        p._bridge_request = AsyncMock(return_value={'ok': True, 'requests': []})
        return p

    async def asyncTearDown(self):
        for p in self.processors:
            timer = p._barge_timeout_task
            p._cancel_barge_timeout()
            if timer is not None:
                await asyncio.gather(timer, return_exceptions=True)
            await p._close_session()
        await asyncio.sleep(0)

    async def test_stop_aliases_are_consumed_without_new_turn_or_task_cancellation(self):
        p = self.make(); p._current = {'turn_key': 'v', 'audible': True}; p._start_next_turn = AsyncMock()
        with patch.object(FrameProcessor, 'process_frame', new=AsyncMock()):
            for text in ['停止', '取消', '不用了', '别播', '打断', '先停', '停啊', '停吧', 'stop']:
                await p.process_frame(TranscriptionFrame(text, 'u', 'now'), FrameDirection.DOWNSTREAM)
        self.assertFalse(p._pending); self.assertFalse(p._current['audible'])
        p._cancel_current.assert_not_awaited(); p._start_next_turn.assert_not_awaited()

    async def test_explicit_task_stop_preserves_unstarted_queue(self):
        p = self.make(); p._current = {'audible': True}; p._pending.append('next')
        self.assertTrue(await p._handle_control('停止任务', {}))
        p._cancel_current.assert_awaited_once(); self.assertEqual(list(p._pending), ['next'])

    async def test_late_stop_does_not_target_successor(self):
        p = self.make(); old = {}; p._current = {'audible': True}
        p._utterance_targets['c:u'] = {'current': old, 'requests': None, 'task': None}
        await p._handle_control('停止任务', {'capture_id': 'c', 'utterance_id': 'u'})
        p._cancel_current.assert_not_awaited(); p._bridge_request.assert_not_awaited()

    async def test_voice_approval_bypasses_queue_and_only_answers_once(self):
        p = self.make(); p._current = {}; p._pending.append('next')
        p._utterance_targets['c:u'] = {'current': p._current, 'requests': [{'id': 'a', 'sessionId': 's', 'kind': 'approval'}], 'task': None}
        metadata = {'capture_id': 'c', 'utterance_id': 'u'}
        await p._handle_control('允许。', metadata); await p._handle_control('允许。', metadata)
        p._bridge_request.assert_awaited_once_with('POST', '/approval', {'id': 'a', 'sessionId': 's', 'decision': 'allow'})
        self.assertEqual(list(p._pending), ['next'])

    async def test_reject_is_not_allow(self):
        p = self.make(); p._bridge_request.side_effect = [{'requests': [{'id': 'a', 'sessionId': 's', 'kind': 'approval'}]}, {'ok': True}]
        await p._handle_control('不允许', {})
        self.assertEqual(p._bridge_request.call_args.args[2]['decision'], 'reject')

    async def test_ambiguous_missing_multiple_or_stale_approvals_grant_nothing(self):
        for text, requests in [('好像可以', [{'kind': 'approval'}]), ('允许', []), ('允许', [{'kind': 'approval'}, {'kind': 'approval'}])]:
            p = self.make(); p._bridge_request.return_value = {'requests': requests}
            self.assertTrue(await p._handle_control(text, {})); self.assertEqual(p._bridge_request.await_count, 1)
        p = self.make(); p._bridge_request.side_effect = RuntimeError('stale')
        self.assertTrue(await p._handle_control('允许一次', {})); self.assertFalse(p._pending)

    async def test_yes_no_remain_ordinary_answers_without_pending_approval(self):
        p = self.make()
        self.assertFalse(await p._handle_control('是', {})); self.assertFalse(await p._handle_control('否', {}))

    async def test_busy_ordinary_work_is_queued_with_ack(self):
        p = self.make(); p._current = {'turn_key': 'v'}
        with patch.object(FrameProcessor, 'process_frame', new=AsyncMock()):
            await p.process_frame(TranscriptionFrame('整理我的下载文件', 'u', 'now'), FrameDirection.DOWNSTREAM)
        self.assertEqual(list(p._pending), ['整理我的下载文件'])
        self.assertEqual(p._send_rtvi.call_args.args[0]['type'], 'task-queued')

    def test_no_substring_or_negation_match(self):
        for text in ['不要停止任务', '不要取消任务，打开浏览器', '解释 cancellation', '我不允许你这么做']:
            self.assertIsNone(control_kind(text))

    async def test_can_stop_main_window_task_using_exact_host_turn(self):
        p = self.make(); p._bridge_request.side_effect = [{'sessionId': 's', 'turn': 14, 'status': 'running'}, {'ok': True}]
        await p._handle_control('停止任务', {})
        p._cancel_current.assert_not_awaited()
        self.assertEqual(p._bridge_request.call_args.args, ('POST', '/cancel', {'sessionId': 's', 'turn': 14, 'source': 'voice-command'}))

    async def test_stale_main_window_snapshot_is_not_refreshed_and_applied_to_new_turn(self):
        p = self.make(); p._utterance_targets['c:u'] = {'current': None, 'requests': None, 'task': {'sessionId': 's', 'turn': 2, 'status': 'running'}}
        p._bridge_request.side_effect = RuntimeError('HTTP 409')
        await p._handle_control('停止任务', {'capture_id': 'c', 'utterance_id': 'u'})
        self.assertEqual(p._bridge_request.await_count, 1); self.assertEqual(p._bridge_request.call_args.args[2]['turn'], 2)

    async def test_recovery_requires_matching_terminal_request_and_never_replays(self):
        p = self.make(); p._quarantined = True; p._uncertain_request = {'sessionId': 's', 'clientTurnId': 'r'}; p._pending.append('queued')
        for request, status in [('new', 'idle'), ('r', 'running')]:
            p._bridge_request.return_value = {'sessionId': 's', 'clientTurnId': request, 'status': status, 'lastTurn': {'terminal': 'completed'}}
            await p._try_recover(); self.assertTrue(p._quarantined); self.assertEqual(len(p._pending), 1)
        p._bridge_request.return_value = {'sessionId': 's', 'clientTurnId': 'r', 'status': 'idle', 'lastTurn': {'terminal': 'completed'}}
        await p._try_recover(); self.assertFalse(p._quarantined); self.assertFalse(p._pending)

    async def test_cancel_before_admission_does_not_issue_unscoped_request(self):
        p = self.make(); p._current = {'turn_key': 'early', 'audible': True}
        p._load_descriptor = Mock(side_effect=AssertionError('unscoped cancellation'))
        await DSHBridgeProcessor._cancel_current(p)
        self.assertTrue(p._current['cancelled']); p._load_descriptor.assert_not_called()

    async def test_eof_without_terminal_event_blocks_queue(self):
        p = self.make(); p._load_descriptor = Mock(return_value={'port': 1, 'token': 'fixture'})
        async def frames():
            for event in [{'type': 'admitted', 'sessionId': 's', 'requestId': 'r'}, {'type': 'text', 'text': 'unfinished'}]:
                yield (json.dumps(event) + '\n').encode()
        response = AsyncMock(); response.status = 200; response.content = frames()
        context = AsyncMock(); context.__aenter__.return_value = response
        p._get_session = Mock(return_value=SimpleNamespace(post=Mock(return_value=context)))
        current = {'turn_key': 'v', 'audible': True, 'session_id': 's', 'reply_text': '', 'submitted_at': time.monotonic()}
        p._current = current; p._pending.append('must not start'); p.create_task = Mock()
        await p._run_turn(current, 'fixture')
        self.assertTrue(p._quarantined); self.assertEqual(p._quarantine_reason, 'execution-unknown')
        self.assertEqual(list(p._pending), ['must not start']); p.create_task.assert_not_called()

    async def test_more_than_two_echo_candidates_can_duck_and_restore(self):
        p = self.make(); p._current = {'turn_key': 'long', 'request_id': 'r', 'audible': True, 'text_started': True, 'reply_text': '今天是晴天适合出去散步'}
        with patch.object(FrameProcessor, 'process_frame', new=AsyncMock()):
            for _ in range(4):
                p._duck_state.setdefault('long', {'used': 0, 'cooldown_until': 0})['cooldown_until'] = 0
                await p.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
                p._barge_candidate['started_mono'] = time.monotonic() - .7
                await p.process_frame(InterimTranscriptionFrame('适合出去散步', 'u', 'now'), FrameDirection.DOWNSTREAM)
                await asyncio.sleep(0)
        self.assertEqual(p.metrics['duck_applied'], 4); self.assertEqual(p.metrics['barge_rejected_echo'], 4)

    async def test_cleanup_waits_for_barge_timer_and_refuses_late_work(self):
        p = self.make(); timer = asyncio.create_task(asyncio.sleep(1000)); p._barge_timeout_task = timer
        with patch.object(FrameProcessor, 'cleanup', new=AsyncMock()):
            await p.cleanup()
        self.assertTrue(timer.done()); self.assertTrue(p._closing)
        await p.process_frame(TranscriptionFrame('打开浏览器', 'u', 'now'), FrameDirection.DOWNSTREAM)
        self.assertFalse(p._pending)
