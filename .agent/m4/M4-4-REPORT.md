# M4-4 报告：停止播报 vs 取消任务（运行期/状态机，2026-10-22）

> 状态：**运行期语义 PASS；UI 三态/急停待产品层（M5）**
> 证据：`m4/evidence/M4-STOP-RESULT.json`（2/2 PASS）；Voice Runtime 协议 + 状态机测试。

## 1. 验证

| 步骤 | 结果 |
|---|---|
| voice.start → listening；tts.speak → speaking | PASS |
| barge_in/tts.stop → speech_stopped + 回到 listening；**不发送 cancel**（任务不被取消） | PASS |
| 状态机 listening→speaking→thinking/working→idle 合法转换 | PASS |
| Host Integration 取消长任务 → aborted/idle（M4 paths/security 已测） | PASS（历史） |

## 2. 未完成

- 产品层 UI 的三态入口（停止播报/取消任务/急停）与视觉反馈；
- 急停（全停）端到端；
- 真实语音下的音频停止时延（需麦克风，M3 真机测试）。
