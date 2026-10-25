# M1 三份阶段提示词（M1-A / M1-B / M1-C）

> 依据：v3 主提示词 §11｜每阶段独立执行，验收后才进入下一阶段；涉及联网/安装/删除/权限/凭据必须先获批。
> 公共约束：DSH 唯一 Agent；不修改 DSH 核心；不改用户 `~/.dsh`/`~/Documents/Nisse`/已装 App；证据 discipline。

## M1-A：DSH × Voice Spike

**唯一目标**：在保留实时语音体验的前提下，证明 DSH 是唯一 Agent，语音输入→任务/审批/取消→播报形成可测试闭环。
**必读**：`README-FOR-REVIEW.md`、`M0-FACT-BASE.md`、`SPIKE-DSH-VOICE-INTEGRATION.md`、`M1-WORK-PACKAGES.md` §2、`spike/dsh-voice/evidence/*`、`DSH-API-CAPABILITY-MATRIX.md`。
**允许**：`spike/dsh-voice/**`、隔离 `/tmp/nisse-m1`、真实模型/语音调用（记录用量）；**禁止**：改 DSH 核心、改 Qwen 上游原仓库、写用户环境、杀用户实例。
**任务**：补测 T5（播报中打断 ≤500ms、停播报≠取消任务）、T7（审批绑定/并发/迟到/语音误批）；A/C 真机听感；收齐 T1–T14/S1–S5 证据；正式 Go/No-Go。
**产物**：`W*-REPORT` 更新、`m1-A-report.md`、事件日志/指标/TCC/证据索引。
**测试**：T1–T14、S1–S7（S6/S7 记录即可）、故障注入（杀 Voice/DSH/断网/设备）。
**验收**：SPIKE §8 Go 判据（T1–T10 全过、T11–T14、S1–S5）；单权威/隔离/无假状态。
**停止/回报**：需要改核心/用户环境/无法满足判据 → 停止，列证据/阻塞/替代与成本。

## M1-B：Bot Session Orchestration Spike

**唯一目标**：在不改 DSH 核心的前提下，验证 Bot 顶层逻辑编排的会话管理/路由/摘要/接管/单写者/预算/审计。
**必读**：`BOT-SESSION-ORCHESTRATION.md`、`DSH-API-CAPABILITY-MATRIX.md`、`M1-WORK-PACKAGES.md` §3、ADR-0002/0008、W1/W3 证据。
**允许**：`spike/dsh-voice/` 或新建 `spike/m1-bot/`、Host Integration 原型、隔离 DSH_HOME；**禁止**：改 DSH 核心、创建 session 父子树、第二 Agent、写用户数据。
**任务**：B0 能力审计→B1 会话索引→B2 L1/L2 路由→B3 摘要→B4 接管/单写者→B5 预算→B6 跨层审批/取消/审计→B7 测试。
**产物**：`BOT-SESSION-ORCHESTRATION.md` 定稿、Host Integration 原型、契约事件日志、验收报告。
**验收**：≥3 session 管理、L1/L2 路由、不劫持、摘要来源、接管/双写拒绝/崩溃恢复、预算降级、审计、fail-closed、延迟基准、**未改核心证据**。
**停止/回报**：关键能力只能靠改核心实现 → 停止并给阻塞矩阵/备选。

## M1-C：Hindsight Memory Spike

**唯一目标**：验证 Hindsight 作为唯一长期记忆后端可本地运行/薄 Adapter 集成/满足隐私/性能/删除/导出，并给 Go/No-Go。
**必读**：`MEMORY-SERVICE-SPEC.md`、`M1-WORK-PACKAGES.md` §4、M3 设计输入、ADR-0006；Hindsight 官方文档（先核实版本/许可）。
**允许**：隔离安装/运行 Hindsight、Adapter 代码、10k 测试集、隔离数据根；**禁止**：换其他记忆后端、自研完整引擎、把旧文件记忆当并行权威源、未经批准的数据外发。
**任务**：C0 事实核验（版本/许可/本地模式/SDK/依赖/资源）→C1 运行时监督→C2 Adapter→C3 行为（冲突/删除/迁移）→C4 基准→C5 隐私→C6 Go/No-Go。
**产物**：`MEMORY-SERVICE-SPEC.md` 定稿、Adapter、基准数据、隐私/迁移/删除证据、报告。
**验收**：search/write/forget/export 行为正确；单写者；敏感拒写；删除不可召回；10k 性能达标；迁移幂等可回滚；无暗中外发。
**停止/回报**：版本/许可/本地运行不可行，或性能/删除/隐私无法达标 → 提交证据与最小补救/成本，等用户裁决，不擅自换后端。
