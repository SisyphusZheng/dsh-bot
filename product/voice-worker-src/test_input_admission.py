"""Passive ASR never performs work or interrupts speech before intent is confirmed."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from capture_policy import CapturePolicy
from dsh_bridge import DSHBridgeProcessor
from input_admission import InputAdmission
from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame, VADUserStartedSpeakingFrame, TTSSpeakFrame
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection


class Admission(unittest.TestCase):
    def test_preview_expires_and_cannot_be_reused_or_replace_a_pending_input(self):
        clock = [0]
        gate = InputAdmission(now=lambda:clock[0])
        metadata = {'capture_id':'c','utterance_id':'u'}
        draft = gate.offer('这说不清楚', metadata)
        self.assertIsNone(gate.offer('背景里的第二句话', {**metadata, 'utterance_id':'u2'}))
        self.assertIsNone(gate.take('stale'))
        self.assertEqual(gate.take(draft['id'], '请整理报告')['text'], '请整理报告')
        self.assertIsNone(gate.take(draft['id']))
        self.assertIsNone(gate.offer('这说不清楚', metadata))
        draft = gate.offer('新的输入', {**metadata, 'utterance_id':'u3'})
        clock[0] = 31
        self.assertIsNone(gate.take(draft['id']))

    def test_discard_and_invalid_corrections_cannot_submit(self):
        for value in ['', ' ', [], 'x'*20001]:
            gate = InputAdmission()
            draft = gate.offer('打开浏览器', {'capture_id':'c','utterance_id':'u'})
            self.assertIsNone(gate.take(draft['id'], value))
            self.assertIsNone(gate.take(draft['id']))
        gate = InputAdmission()
        draft = gate.offer('环境声', {'capture_id':'c','utterance_id':'u'})
        self.assertFalse(gate.discard('old'))
        self.assertTrue(gate.discard(draft['id']))
        self.assertIsNone(gate.take(draft['id']))


class PassiveBridge(unittest.IsolatedAsyncioTestCase):
    def make(self, capture=None):
        p = DSHBridgeProcessor('/unused', capture=capture)
        p._send_rtvi = AsyncMock(); p.push_frame = AsyncMock(); p._start_next_turn = AsyncMock()
        p.broadcast_interruption = AsyncMock(); p._cancel_current = AsyncMock()
        p._bridge_request = AsyncMock(return_value={'requests': []})
        return p

    async def feed(self, p, text, utterance='u', mode='always', interim=False):
        frame = (InterimTranscriptionFrame if interim else TranscriptionFrame)(text,'u','now')
        frame.metadata.update(capture_id='c',utterance_id=utterance,input_mode=mode)
        with patch.object(FrameProcessor,'process_frame',new=AsyncMock()):
            await p.process_frame(frame,FrameDirection.DOWNSTREAM)

    async def test_reported_environment_phrases_do_not_start_work_or_stop_current_speech(self):
        for text in ['这说不清楚', '啊，听一下', '嗯，对你自己', '两米八，眼神里有杀气。']:
            p = self.make(); p._current = {'audible':True}
            await self.feed(p,text,interim=True)
            await self.feed(p,text)
            self.assertEqual(list(p._pending), [])
            self.assertTrue(p._current['audible'])
            p._start_next_turn.assert_not_awaited();p._cancel_current.assert_not_awaited();p.broadcast_interruption.assert_not_awaited()
            self.assertEqual(p._input_admission.draft['text'], text)

    async def test_passive_vad_does_not_duck_but_explicit_playback_stop_remains_available(self):
        capture = CapturePolicy(True);capture.control('start','c','always')
        p = self.make(capture);p._current = {'turn_key':'voice-1','text_started':True,'audible':True}
        with patch.object(FrameProcessor,'process_frame',new=AsyncMock()):
            await p.process_frame(VADUserStartedSpeakingFrame(),FrameDirection.DOWNSTREAM)
        self.assertIsNone(p._barge_candidate);p._send_rtvi.assert_not_awaited()
        await self.feed(p,'别说了')
        self.assertFalse(p._current['audible']);p._cancel_current.assert_not_awaited()

    async def test_confirm_is_single_use_and_correction_reaches_only_one_new_turn(self):
        p = self.make();await self.feed(p,'开错窗口')
        draft = p._input_admission.draft
        with patch.object(FrameProcessor,'process_frame',new=AsyncMock()):
            result = await asyncio.gather(p.confirm_input(draft['id'],'请整理报告'), p.confirm_input(draft['id']))
        self.assertEqual(result,[True,False])
        self.assertEqual(list(p._pending),['请整理报告'])
        p._start_next_turn.assert_awaited_once()

    async def test_spoken_confirmation_and_discard_never_become_separate_tasks(self):
        p = self.make();await self.feed(p,'打开浏览器')
        await self.feed(p,'取消输入','u2')
        self.assertIsNone(p._input_admission.draft);p._start_next_turn.assert_not_awaited()
        await self.feed(p,'写报告','u3');await self.feed(p,'确认发送','u4')
        self.assertEqual(list(p._pending),['写报告'])

    async def test_hold_intent_and_explicit_controls_preserve_previous_behavior(self):
        p = self.make();await self.feed(p,'打开浏览器',mode='hold')
        self.assertEqual(list(p._pending),['打开浏览器'])
        p = self.make();p._bridge_request.return_value={'requests':[{'id':'a','sessionId':'s','kind':'approval'}]}
        await self.feed(p,'允许一次')
        self.assertFalse(any(c.args[0]=='POST' for c in p._bridge_request.call_args_list))
        p._bridge_request.side_effect=[{'requests':[{'id':'a','sessionId':'s','kind':'approval'}]},{'ok':True}]
        await self.feed(p,'确认允许一次','u2')
        self.assertEqual(p._bridge_request.call_args.args,('POST','/approval',{'id':'a','sessionId':'s','decision':'allow'}))

    async def test_muted_or_superseded_capture_cannot_confirm_an_old_draft(self):
        capture=CapturePolicy(True);capture.control('start','c','always')
        p=self.make(capture);await self.feed(p,'打开浏览器')
        draft=p._input_admission.draft
        capture.control('finish','c')
        self.assertFalse(await p.confirm_input(draft['id']))
        await self.feed(p,'迟到的环境声','late')
        self.assertIsNone(p._input_admission.draft);p._start_next_turn.assert_not_awaited()
        self.assertFalse(capture.control('start','new','invented-mode'))
        capture.control('start','new','hold')
        await self.feed(p,'旧录音文本','old')
        self.assertIsNone(p._input_admission.draft)

    async def test_pending_desktop_approval_and_question_are_spoken_once_without_private_parameters(self):
        p = self.make()
        for request in [
            {'id':'a','sessionId':'s','kind':'approval','operation':{'arguments':{'command':'PRIVATE-COMMAND'}}},
            {'id':'q','sessionId':'s','kind':'question','questions':[{'question':'文档用什么内容？','options':[{'label':'之前的文章'},{'label':'新文章'}]}]},
        ]:
            p._bridge_request.return_value={'requests':[request]}
            before=p.push_frame.await_count
            await p.announce_pending();await p.announce_pending()
            self.assertEqual(p.push_frame.await_count,before+1)
            frame=p.push_frame.call_args.args[0];self.assertIsInstance(frame,TTSSpeakFrame)
            self.assertNotIn('PRIVATE-COMMAND',frame.text)
        self.assertIn('之前的文章',p.push_frame.call_args.args[0].text)
        p._bridge_request.return_value={'requests':[]}
        before=p.push_frame.await_count;await p.announce_pending()
        self.assertEqual(p.push_frame.await_count,before)
