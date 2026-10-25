# M4 主路径报告（文本注入 E2E，2026-10-22）

> 状态：**M4-1/2/3 + M4-4 取消部分完成（text-level）**｜环境：fork 构建产物 + Nisse profile + Host Integration v0 + 隔离 DSH_HOME。
> 说明：真实语音/TCC 需用户真机，当前用 WS/文本注入替代语音输入；审批/取消/工具执行走真实 DSH 路径。

## 1. 验收（6/6 PASS）

| 步骤 | 覆盖 | 结果 | 耗时 |
|---|---|---|---|
| setup-host | profile/DSH host/Host Integration/session | PASS | 1.4s |
| path1-qa | 主路径 1：DSH 回答（非前台自答） | PASS | 3.0s |
| path2a-inside-workspace-file | 主路径 2：工作区内写文件（无审批） | PASS | 7.6s |
| path2b-outside-approval-allow | 主路径 2：工作区外写 → 审批 allow → 文件创建 | PASS | 72.7s |
| path3-history | 主路径 3：历史（user/assistant/tool） | PASS | 5ms |
| path4-cancel | 主路径 4：长任务 → /cancel → idle | PASS | 1.2s |

- 证据：`m4/evidence/M4-PATHS-RESULT.json`；
- Host Integration 新增 `GET /history?limit=N`（最近 user/assistant/tool/approval/turn 摘要）；
- 审批 allow 路径真实写入了工作区外文件（随后清理）；拒绝路径已在 M3-3 验证。

## 2. 未覆盖/待办

- **真实语音**：当前用文本注入；麦克风/TCC/打断/回声需用户真机；
- **M4-4 停止播报≠取消任务**：Voice Runtime stub 已支持 barge_in/tts.stop，但产品层三态联动与 UI 待接；
- M4-5 人格、M4-6 Hindsight 记忆、M4-7 安全矩阵、M4-8 审计、M4-9 dogfood 未开始；
- 审计持久化（M4-8）未实现（当前只保留事件流/history）。

## 3. 结论

M4 主路径 1–4 的**文本/真实 DSH 执行**已验证；真实语音与产品 UI 是剩余工作。
