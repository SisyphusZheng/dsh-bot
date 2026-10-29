"""Capture boundaries, deterministic quiet windows and user-owned queue changes."""
import unittest
from speech_intake import SpeechAssembly, PendingInputs, needs_confirmation


class Assembly(unittest.TestCase):
    def setUp(self):
        self.clock=0
        self.speech=SpeechAssembly(now=lambda:self.clock)

    def add(self,text,item,mode='hold',capture='c'):
        return self.speech.add(text,{'capture_id':capture,'utterance_id':item,'input_mode':mode})

    def test_hold_merges_finals_until_release_and_rejects_duplicate_late_items(self):
        self.add('请帮我','1');self.clock=2;self.add('整理报告。','2')
        self.clock=10;self.assertEqual(self.speech.ready(),[])
        self.speech.release('c');self.clock=10.7
        result=self.speech.ready();self.assertEqual(result[0][0],'请帮我整理报告。')
        self.assertEqual(result[0][1]['segments'],2)
        self.assertFalse(self.add('迟到的第三个片段','3'))
        self.assertEqual(self.speech.ready(),[])

    def test_toggle_quiet_window_groups_only_adjacent_segments(self):
        self.add('就是','1','toggle');self.clock=.4;self.add('最后一个选项。','2','toggle')
        self.clock=.8;self.assertEqual(self.speech.ready(),[])
        self.clock=1.1;first=self.speech.ready()[0]
        self.assertEqual(first[0],'就是最后一个选项。')
        self.add('再打开浏览器','3','toggle');self.clock=2
        second=self.speech.ready()[0];self.assertNotEqual(first[1]['speech_id'],second[1]['speech_id'])

    def test_cumulative_revision_and_duplicate_provider_item_do_not_repeat_words(self):
        self.add('请整理','1');self.add('请整理报告','2')
        self.assertFalse(self.add('请整理报告','2'))
        self.speech.release('c');self.clock=1
        self.assertEqual(self.speech.ready()[0][0],'请整理报告')

    def test_distinct_captures_never_merge_and_discard_cannot_flush(self):
        self.add('旧录音','1');self.add('新的录音','2',capture='new')
        self.speech.release('c',discard=True);self.speech.release('new');self.clock=1
        self.assertEqual([text for text,_ in self.speech.ready()],['新的录音'])

    def test_bad_tunables_and_oversized_input_fail_explicitly(self):
        with self.assertRaises(ValueError):SpeechAssembly(settle=0)
        with self.assertRaises(ValueError):self.add('x'*20001,'1')

    def test_short_ambiguous_inputs_require_confirmation_but_valid_greetings_and_actions_survive(self):
        for text in ['就是。','是。','呃，任务也停。','任务也挺。','啊，听一下。']:
            self.assertTrue(needs_confirmation(text),text)
        for text in ['你好','我在','打开QQ','请帮我写一段介绍','今天天气怎么样？']:
            self.assertFalse(needs_confirmation(text),text)


class Queue(unittest.TestCase):
    def setUp(self):
        self.clock=0;self.q=PendingInputs(limit=2,ttl=10,now=lambda:self.clock)

    def test_full_queue_does_not_drop_existing_requests(self):
        self.q.append('打开浏览器');self.q.append('写报告')
        with self.assertRaises(ValueError):self.q.append('第三条')
        self.assertEqual(list(self.q),['打开浏览器','写报告'])

    def test_edit_delete_and_confirmation_require_exact_revision_and_identity(self):
        item=self.q.append('错误输入',confirm=True);revision=self.q.revision
        self.assertIsNone(self.q.take())
        with self.assertRaises(ValueError):self.q.edit(item['id'],revision-1,'edit','新指令')
        self.q.edit(item['id'],revision,'edit','整理报告')
        with self.assertRaises(ValueError):self.q.edit(item['id'],revision,'delete')
        self.assertEqual(self.q.take()['text'],'整理报告')
        with self.assertRaises(ValueError):self.q.edit(item['id'],self.q.revision,'confirm')

    def test_expired_input_waits_for_explicit_confirmation_and_preserves_order(self):
        item=self.q.append('旧指令');self.q.append('第二条');self.clock=11
        self.assertIsNone(self.q.take());self.assertTrue(self.q.snapshot()['entries'][0]['needsConfirmation'])
        self.q.edit(item['id'],self.q.revision,'confirm')
        self.assertEqual(self.q.take()['text'],'旧指令')
        self.assertIsNone(self.q.take())

    def test_quarantine_preserves_text_without_automatic_replay(self):
        self.q.append('待执行');self.q.quarantine()
        self.assertEqual(list(self.q),['待执行']);self.assertIsNone(self.q.take())

    def test_explicit_busy_response_can_restore_exact_unadmitted_item(self):
        item=self.q.append('请求',{'capture_id':'c'})
        taken=self.q.take();self.q.restore(taken)
        self.assertEqual(self.q.take()['id'],item['id'])
