"""Use Pipecat's maintained speech filter; visual/Session Markdown stays intact."""
import unittest
from dashscope_services import DashScopeTTSService


class SpeechText(unittest.IsolatedAsyncioTestCase):
    async def test_actual_tts_filter_removes_formatting_and_keeps_words(self):
        tts = DashScopeTTSService(api_key='fixture')
        for source, words in [
            ('**优点**', ['优点']),
            ('- **缺点一：** 配置复杂。', ['缺点一', '配置复杂']),
            ('## 结论\n使用 `report.docx`。', ['结论', 'report.docx']),
            ('[查看报告](https://example.com/report)', ['查看报告']),
        ]:
            spoken = await tts._filter_text(source)
            self.assertNotIn('**', spoken)
            self.assertNotIn('`', spoken)
            self.assertNotIn('##', spoken)
            for word in words:
                self.assertIn(word, spoken)

    async def test_sentence_aggregation_fragments_keep_spoken_content(self):
        tts = DashScopeTTSService(api_key='fixture')
        chunks = ['**优点：速度快。', '** 缺点：价格高。']
        spoken = ''.join([await tts._filter_text(text) for text in chunks])
        self.assertNotIn('*', spoken)
        self.assertIn('速度快', spoken)
        self.assertIn('价格高', spoken)


    async def test_line_breaks_and_list_markers_are_not_sent_to_tts(self):
        tts = DashScopeTTSService(api_key='fixture')
        for source, words in [
            ('\n后台作业：无\n', ['后台作业', '无']),
            ('- 项目一\n- 项目二\n', ['项目一', '项目二']),
            ('## 标题\n正文第一句\n正文第二句', ['标题', '正文第一句', '正文第二句']),
        ]:
            spoken = await tts._filter_text(source)
            self.assertNotIn('\n', spoken)
            self.assertNotIn('**', spoken)
            for word in words:
                self.assertIn(word, spoken)
