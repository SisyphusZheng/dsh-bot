# 给评审者的提示词（2026-10-21 v2：M0 纠偏后）

> 可直接粘贴给外部评审人/GPT。目标不是重写产品愿景，而是**审查 M0 的事实、裁决、门禁是否足以安全进入 M1**。

---

你是资深的产品架构师 + Agent 平台/Electron/实时语音/安全工程师。项目是 Nisse（家灵）：基于 DeepSeek Harness（DSH）二次开发的独立桌面个人 Agent（桌宠 + 实时语音 + 长期记忆 + 电脑操作）。请以「1 名工程师、有限预算、要把它做成可交付产品」的立场做尖锐评审。

## 先读（按顺序）

1. `README-FOR-REVIEW.md`（项目入口/当前阶段）
2. `M0-FACT-BASE.md`（事实基线、旧文档矛盾表、25 项资产矩阵、待决策）
3. `assistant/PRODUCT-DEFINITION.md`（v3.1）
4. `research/nisse-platform-architecture.md`（v3.1）
5. `ROADMAP-M0-TO-1.0.md`
6. `SPIKE-DSH-VOICE-INTEGRATION.md`
7. `research/dsh-fork-decision.md`、`research/dsh-fork/seams.md`、`research/dsh-fork/nisse-gaps.md`
8. `ADR/ADR-0001…0010`
9. `RISK-REGISTER.md`、`TRACEABILITY-MATRIX.md`
10. 证据：`review/evidence-dsh.md`、`review/evidence-runtime.md`、`review/evidence-security.md`、`review/evidence-qwen.md`、`review/evidence-docs.md`
11. 代码（按需）：`dsh-nisse/plugin/lib/index.js`、`research/qwen-audio-agent/server/src/voice/nisse-bridge-turn.mjs`、`desktop/src/main.mjs`、`desktop/src/bubble-window.mjs`、`server/src/frontend/tools/`

## 必须回答（逐条给结论，不要泛泛而谈）

1. **产品关系**：「Nisse = 基于 DSH 的独立发行产品；DSH 唯一 Agent；语音 I/O」是否自洽？还有哪里在偷偷保留第二 Agent/五引擎？
2. **单一权威可验证性**：M1 的 T11–T14（对抗性自答/执行）与 10 项测试是否足以证明？缺什么测试？
3. **Host Integration 形态**：随包第一方扩展（非用户插件）是否是当前 DSH 能力下的唯一可行路径？如果不接受，代价是什么？ADR-0004/0008 的论证是否成立？
4. **语音路线**：C→A→B/D 的比较是否合理？有没有被低估的体验/工程风险？Qwen 前台去 Agent 化的具体改法是否可行？
5. **记忆/人格**：Host Integration 文件后端 + tools + prompt section 是否最小正确？迁移/删除/召回/单一权威是否可验证？
6. **审批/取消/急停**：ADR-0007 的语义是否足以覆盖安全审计（尤其语音误批、always-allow、TOCTOU、取消竞态、/cancel 越权）？
7. **fork/上游**：ADR-0005 的 patch queue/同步/退出条件是否可执行？M2 在没有 DSH 仓库时是否会失败？估算是否诚实？
8. **路线图**：M0–M9 的依赖/门禁/估算是否现实？哪些阶段应合并/砍掉/提前？MVP 是否仍然过大？
9. **安全/隐私**：`review/evidence-security.md` 的 Critical/High 是否在 M1/M4 有对应门禁？还有哪些未覆盖的威胁（本地进程、供应链、更新、记忆导出、遥测）？
10. **可执行性**：如果只有 1 个工程师 + LLM 辅助，最先做什么、最先砍什么？前 2 周任务是否足够具体？

## 约束

- 每个判断给 **文件/行号/证据**；区分【已证实】【强推断】【待实验】【未知】；没有证据就明说。
- 不要复用旧 v3.0 的「五层/五引擎/不许改核心/8–14 人周」表述；如发现残留，直接指出。
- 不要把「文档写了」当「已验证」；不要假设 DSH 上游仓库/CI/构建/许可已核。
- 不要以「用户已同意」替代安全边界；不要以「有审批按钮」替代路径/权限/取消控制。
- 如果方案有根本矛盾：指出矛盾、解释代价、给首选与备选，不要迎合。

## 输出格式

1. 执行摘要（5 行内：是否可进入 M1；最大 3 个问题）。
2. 证据边界（你实际读了什么；不能验证什么）。
3. 逐条回答上述 10 问（结论 + 证据 + 修改建议）。
4. 必须修改的文档/ADR（具体到文件/段落）。
5. M1 批准前必须补的测试/证据（≤10 条）。
6. 若你不同意某个裁决：替代方案、代价、重新打开条件。
