# M4 计划：MVP（主路径、人格、记忆、安全闭环）

> 状态：**工程/自动化验收完成（2026-10-22）；真实语音/TCC + 7 天 dogfood 待用户**｜前置：M3 计划内工作包 + Electron Shell 原型完成；真实音频/TCC 待用户。
> 目标：macOS、BYOK、内部可日常 dogfood 的 MVP：少量真实端到端场景 + 人格/记忆/安全闭环；无安装器/签名（M5/M6）。
> 依据：ROADMAP M4、M3-M4-DESIGN-INPUTS、MEMORY-SERVICE-SPEC、BOT-SESSION-ORCHESTRATION。

## 1. 工作包与验收

| # | 工作包 | 交付 | 验收 |
|---|---|---|---|
| M4-1 | 主路径 1：问答/搜索 → DSH 回答 → 语音+气泡 | Host Integration E2E + Shell 状态 | ✅ 文本 E2E PASS；真实语音待用户 |
| M4-2 | 主路径 2：低风险文件任务 → 审批（如需）→ 执行 → 汇报 | 文件任务 E2E（允许/拒绝、路径校验） | 工作区内写成功；工作区外需审批；拒绝不执行；审计记录 |
| M4-3 | 主路径 3：任务进度/「刚才做了什么」 | 历史/摘要接口 | ✅ `/history` E2E PASS；摘要/时序增强待 M4 |
| M4-4 | 主路径 4：打断/停止/取消/急停三分语义 + UI | Host Integration/状态机/Shell | 取消 PASS；停止播报/急停/UI 待接 |
| M4-5 | 人格：单一来源、编辑、下一轮生效 | persona config/prompt section | ✅ 5/5 PASS（dispose/resume 刷新，下一轮生效） |
| M4-6 | 记忆 v1：Hindsight 薄 Adapter + tools + 迁移/删除/导出 | memory service + tests | 写入/召回/删除不召回/导出；单写者；敏感拦截 |
| M4-7 | 安全：审批绑定/过期/撤销、always-allow scope+TTL、路径校验、取消后无动作、日志脱敏、L3 默认拒绝 | 安全实现 + 测试矩阵 | ✅ v0：工具级策略/TTL/撤销/审计 PASS；路径级 scope 受 DSH reason 截断限制（记录） |
| M4-8 | 审计：审批/取消/急停/记忆变更本地记录 | audit JSONL | ✅ audit.jsonl + /audit；秘密扫描 PASS |
| M4-9 | E2E + 安全测试套件 + dogfood | 测试 harness/report | 8 主路径可复现；P0 全过；dogfood 需用户 |

## 2. 执行策略（当前无用户）

- 先用 **文本注入** E2E 覆盖主路径 1–4、审批/取消/审计/记忆；真实麦克风/TCC 留待用户配合；
- 记忆使用 Hindsight mock 模式（零外发）做功能/删除/导出测试；真实 LLM 门禁可选；
- 安全负例优先（路径 `..`/symlink/工作区外、审批串轮、取消竞态）；
- 7 天 dogfood / 真实语音 demo 需要用户，届时报告阻塞。

## 3. 当前进展

- [x] M4-1/2/3 文本 E2E + M4-4 取消（6/6 PASS；真实语音/停止播报待接）
- [x] M4-5 persona（5/5 PASS）
- [x] M4-6 Hindsight memory v1（Adapter 5/5；Host Integration 代理/digest 3/3）
- [x] M4-7 security v0（工具级 always-allow/TTL/撤销/审批绑定；6/6 PASS；路径级 scope 限制已记录）
- [x] M4-8 audit（audit.jsonl + /audit；秘密扫描 PASS）
- [x] M4-9 E2E/安全套件（6/6 测试文件 PASS）；`M4-FINAL-REPORT.md`；dogfood 待用户
