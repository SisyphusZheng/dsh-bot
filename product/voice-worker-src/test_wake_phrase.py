import unittest
from wake_phrase import WakePhrase

class WakePhraseTest(unittest.TestCase):
    def test_default_direct_conversation(self):
        self.assertEqual(WakePhrase().admit('查天气', now=1), '查天气')

    def test_address_phrase_and_followup_window(self):
        gate = WakePhrase('小鲸鱼')
        self.assertIsNone(gate.admit('这是背景说话', now=1))
        self.assertEqual(gate.admit('小鲸鱼，查天气', now=2), '查天气')
        self.assertEqual(gate.admit('那明天呢', now=20), '那明天呢')
        self.assertIsNone(gate.admit('另一个人说话', now=51))
        self.assertEqual(gate.admit('小鲸鱼', now=52), '')

    def test_active_turn_keeps_interruption_available(self):
        gate = WakePhrase('小鲸鱼')
        self.assertEqual(gate.admit('我想换个话题', active=True, now=100), '我想换个话题')
