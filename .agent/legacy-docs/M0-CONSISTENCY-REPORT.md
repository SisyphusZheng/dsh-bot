# M0 一致性检查报告

> 日期：2026-10-21｜执行：Lead｜目的：验证 M0 退出标准（`research/nisse-execution-plan.md` §3），判断是否可批准 M1。

## 1. 检查项与结果

| # | 检查 | 方法 | 结果 |
|---|---|---|---|
| 1 | 新文档不再要求「五个同级可替换引擎」 | grep 全量新文档 | **通过**：仅出现在「删除/不建/对比表/矛盾表」语境；无肯定性架构要求 |
| 2 | 不再把「不修改 DSH 核心」写成绝对禁令 | grep | **通过**：均表述为「允许必要修改 + patch queue」或矛盾表引用 |
| 3 | 不再把 QwenAudio 当第二 Agent 默认权威 | grep + 架构文档责任表 | **通过**：明确目标为 Voice I/O 无执行权；现状双权威写入事实基线 |
| 4 | 不再把「M0 已冻结」「七门禁全 PASS」「M2 MVP 已交付」当作事实 | grep | **通过**：仅作为旧文档引用/纠偏对象 |
| 5 | 旧估算 8–14/16–28/50–100 人周不再作为预算 | grep | **通过**：仅出现在矛盾表；新估算在 ROADMAP |
| 6 | 交叉引用一致 | 人工+脚本 | **通过**：ADR ↔ 架构 ↔ 路线图 ↔ 风险/追溯 ↔ Spike 互相引用；无相反结论 |
| 7 | 交付文件存在 | 脚本 | **通过**：README/M0-FACT-BASE/ROADMAP/SPIKE/RISK/TRACE/PROMPTS/ADR×10/证据×5 均存在 |
| 8 | 旧稿已归档且标 superseded | 检查 archive README | **通过**：`assistant/archive/PRODUCT-DEFINITION-v3.0.md`、`research/archive/2026-10-21-v3.0/` + README |
| 9 | 证据引用可定位 | 抽查 + 测试复跑 | **通过**：DSH/运行时/安全/Qwen/文档证据均带 path:line；三组单测复跑通过 |
| 10 | 旧路径引用已指向归档 | 脚本替换后检查 | **通过**：M0-FACT-BASE §3 与 evidence-docs 的行号引用均指向 archive 原件 |

## 2. 本次复跑测试（原始输出摘要）

```text
# research/qwen-audio-agent
node --test desktop/test/bubble-window.test.mjs web/test/orb-bubble.test.mjs desktop/test/desktop-surface-layout.test.mjs
→ tests 26 / pass 26 / fail 0

cd server && node --test test/nisse-voice-input-dedupe.test.mjs test/nisse-bridge-single-flight.test.mjs test/dsh-nisse-plugin-turn-events.test.mjs
→ tests 10 / pass 10 / fail 0

node --test test/stop-phrase-guard.test.mjs test/nisse-bridge-cancel.test.mjs test/barge-in-suppression.test.mjs test/realtime-input-runtime.test.mjs
→ tests 22 / pass 22 / fail 0
```

## 3. 仍存在但不阻塞 M0 的问题（转入 M1/M2/M3）

1. 打包版真人麦克风 TCC 无证据 → M1 必测。
2. G6 单客户端门禁实际失败 → 记录为历史事实；M3 重新设计。
3. 审批串轮/并发无测试 → M1/M4 必测。
4. app 级崩溃恢复未测 → M3。
5. 语音前台去执行权未实现 → M1 核心目标。
6. DSH 上游仓库不可得 → M2 前置决策（D3）。
7. 签名/公证未做 → M6。
8. 记忆写错工作区/双数据 → M4 迁移修复。

## 4. 结论

**M0 文档层退出标准满足；可以进入「M1 批准」环节，但不得直接开始 M1。**

需要用户：
1. 回答 `M0-FACT-BASE.md` §7 的 D1–D6；
2. 明确批准 M1 的范围/预算/停止条件（`SPIKE-DSH-VOICE-INTEGRATION.md` §0/§8）。

若用户不批准 M1，项目停在 M0，不继续改产品代码。

## 5. 证据索引

- `M0-FACT-BASE.md`（事实/矛盾/矩阵）
- `review/evidence-dsh.md`（DSH 源码）
- `review/evidence-runtime.md`（真机/产物）
- `review/evidence-security.md`（安全）
- `review/evidence-qwen.md`（语音双 Agent）
- `review/evidence-docs.md`（文档矛盾）
- `M0-CHANGES.diff`（旧稿→新稿 diff）
