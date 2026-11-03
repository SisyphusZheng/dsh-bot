# Agent Note：Voice capture boundaries and TTS fragment safety

Status: implemented

[English](2026-11-03-voice-capture-and-tts-boundaries.md) | 中文

## 问题

三个缺陷共享同一条边界：播报刚结束后开口，会被当成对已结束播放的打断，前两个字就确认了“打断”，压低音量并提前收尾录音；后半句在 capture 边界之后才到达，变成“迟到”草稿。另外，按住说话的 capture 只给慢 ASR 三秒窗口，TTS 又把纯标点或分句残留的片段发给 provider，收到零音频，回复中间出现静音空洞。

## 决策

只在播放真正进行中才生成 barge 候选；播放结束后的说话算新的一句话。hold drain 延长到六秒，慢的 final 留在本次 capture 内，不变成迟到草稿。TTS 去掉残留内联 Markdown 与句首标点，并跳过没有可朗读内容的片段，不发空请求。

## 考虑过的替代方案

- 保留播放尾窗、只对候选去重：早确认仍然会切断句子。
- 保留三秒 drain、让界面确认迟到文本：这正是用户报告的“只听到前两个字”。
- 对 TTS 空响应做重试：provider 行为不确定；安全规则是不发它读不出来的片段。

## 后果

在回复结束后马上说话会作为正常一轮提交，短回答不再被拆成草稿。真正迟到的 final 仍给一次性提示。provider 对极少数句子的空响应仍可能发生，已记录到本地 STT/TTS 的评估项。
