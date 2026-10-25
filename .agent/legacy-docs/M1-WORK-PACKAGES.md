# M1 任务书（v3 修订）：DSH × Voice + Bot 编排 + Hindsight 记忆

> 依据：`Nisse-Master-Correction-and-Delivery-Prompt-v3.md`（2026-10-21，用户提供）
> 冻结决策：**Route A（Bot 顶层逻辑编排，不修改 DSH 核心）**；**Hindsight 为唯一长期记忆后端**；
> DSH 唯一 Agent 权威；M1 拆为 **M1-A（Voice）/ M1-B（Bot Session）/ M1-C（Hindsight Memory）** 三个最小 Spike。
> 历史：W0–W5 是旧 M1 拆解，其成果并入 M1-A（见 §2 映射）；旧文档中与 v3 冲突处，以 v3 与本文为准。

## 0. 冻结约束（先读）

1. **不修改 DSH 核心、不改变“每个 session 都是 root”的语义**；Bot 是常驻顶层 main session/统一角色/逻辑协调层，
   由 Nisse/Host Integration 通过现有 API 与版本化契约实现逻辑编排。若接口缺口导致无法安全实现，
   **停止并提交证据、阻塞项与备选方案**，不得自行改核心、不得假装能力已存在。
2. **Hindsight 固定为长期记忆后端**；Nisse 只做薄 `MemoryAdapter`（search/write/forget/export）。
   不安排 Mem0 对照/泛化记忆选型，不自建完整记忆引擎，不并行维护第二套自动写入的权威记忆库。
3. 单一权威：DSH 负责 Agent 决策/会话/工具/审批/取消/最终回复/session history & compaction；
   Voice 只做音频 I/O；Hindsight 只做长期记忆；Bot 不做第二套任务执行。
4. 证据纪律：每项标注“已证实/强推断/待实验/需用户决策”；不得编造上游能力/测试结果/许可证结论。
5. 安全贯穿：审批/取消/急停/路径/敏感信息/日志脱敏/凭据，不靠“用户已同意”替代边界。

## 1. M1 结构

| Spike | 目标 | 当前状态 |
|---|---|---|
| **M1-A：DSH × Voice** | 单一 Agent 主路径；语音→DSH→工具/审批→语音/气泡；打断/取消/重复/崩溃；路线比较（C/A/B/D） | **大部分完成**（W0–W5 证据，见 §2）；剩 T5/T7、A/C 听感、正式 Go 判定 |
| **M1-B：Bot Session Orchestration** | 不修改 DSH 核心的前提下，验证 Bot 的会话管理/路由/摘要/接管/单写者/预算/审计 | **完成（Conditional Go）**：验收 30/36 PASS、0 FAIL、6 UNVERIFIED（模型探针依赖）；`spike/m1-bot/REPORT.md` |
| **M1-C：Hindsight Memory** | 固定版本 Hindsight 本地运行 + 薄 MemoryAdapter + 数据/删除/导出/冲突/预算/性能 | **完成（Conditional Go）**：39/39 确定性 + 5/5 真实 opencode-go；证据 `spike/m1-c-hindsight/REPORT.md`；3 项条件见 §4 |

M1 Go/No-Go = A/B/C 三个 Spike 各自通过 + 单权威/安全/隔离证据齐全（不允许“带病进 M2”）。

## 2. M1-A 已完成工作（旧 W0–W5 映射）

| 旧工作包 | 内容 | 结果/证据 |
|---|---|---|
| W0 | 隔离环境、基线、事件 schema、run/stop | 完成：`spike/dsh-voice/evidence/W0-ISOLATION.md` |
| W1 | DSH 文本闭环（turn/事件/工具/崩溃/隔离） | 完成：`W1-REPORT.md`、`W1-RUN-LOG.jsonl`（152 事件） |
| W2 | 真实语音闭环（Qwen realtime + 隔离 DSH；TTS/打断/TCC） | 首轮完成：`W2-REPORT.md`（说话结束→提交 141ms、首 token 3.61s、取消 15ms） |
| W3 | 路线 C 去执行权 + T11–T14 对抗 + 启动硬校验 + 取消回归 | 完成：`W3-REPORT.md`（T11–T14 19/19、取消 14/14） |
| W4 | 路线 A 最小实现 + C/A 指标 + B/D 评估 | 数据级完成：`W4-COMPARISON.md`、`W4-ROUTE-D-OPTIONS.md` |
| W5 | T1–T10/T11–T14/S 项汇总、故障注入、总报告 | 报告完成：`m1-spike-report.md`（结论 **Conditional**；T5/T7/S2–S5 待补） |

**M1-A 剩余（必须做，决定正式 Go）**：
1. T5：播报进行中打断（音频 ≤500ms 停止）与「停止播报 ≠ 取消任务」语义；
2. T7：审批归属/并发/迟到/语音误批（隔离 profile 需要有可触发审批的工具与答复通道）；
3. A/C 真机听感对比（10–15 分钟）；
4. 结论：T1–T10 + S1–S5 全过后才可正式 Go（当前 Conditional）。

## 3. M1-B：Bot Session Orchestration（任务清单）

**前置**：`DSH-API-CAPABILITY-MATRIX.md` 完成（哪些能力原生/可由 Host Integration 实现/阻塞）。
**产出**：`BOT-SESSION-ORCHESTRATION.md` 契约 + Host Integration 原型 + 测试证据。

1. **B0 能力审计**：session 列表/元数据/创建/重命名/归档/恢复/接管/状态查询/标题/工作区；
   标注证据等级；缺口只允许走 Host Integration 或停止，不改 DSH 核心。
2. **B1 会话索引**：Nisse 本地维护元数据索引（id/标题/状态/工作区/最后活动/项目标签）；
   与 DSH 原生元数据区分；本地操作 p95 <300ms；可重建。
3. **B2 路由 L1/L2**：L1 快速回答（小上下文/低 effort，仍由 DSH 产生）；L2 路由到指定/推荐 session；
   支持“去 Nisse 那个会话”“继续刚才那个任务”；歧义询问/候选；**不得静默劫持**；路由理由/目标/确认可审计。
4. **B3 汇总**：按需/定期 session 摘要（token 预算）；带来源 session/turn/时间范围；区分历史摘要/实时状态/推断；
   取不到实时状态时明确说明。
5. **B4 接管/单写者**：仅 idle；锁的权威存储/持有者/租约/过期/释放/崩溃恢复；同一 session 不得双写；
   冲突明确报错或让用户选择。
6. **B5 三层预算**：Bot/session/subagent 的 token/时间/并发/工具调用预算；可观察、可测试、可审计；超限降级；
   不重复计数。
7. **B6 审批/取消/审计跨层**：审批绑定发起 session/任务/动作/参数摘要/有效期；高危语音批准需 UI 二次确认；
   停止/取消/急停跨层传播；迟到结果丢弃；DSH 不可用 fail-closed。
8. **B7 测试/验收**：≥3 session 列出/搜索/创建/重命名/归档；L1/L2 路由；指定/模糊指代；不劫持；
   摘要来源/时间；接管阻止双写/冲突恢复；预算触发降级；跨层审计；DSH 不可用 fail-closed；
   L1 p50≤1.5s/p95≤2.5s、L2≤3s 的可重复基准（目标待测量，非已达成承诺）。

## 4. M1-C：Hindsight Memory（已完成，Conditional Go）

**结果（2026-10-21）**：Hindsight v1.0.0（MIT，commit `39c65ffe…`）+ 薄 MemoryAdapter；39/39 确定性测试、5/5 真实 opencode-go 测试通过；10k 基准/隐私/删除/迁移证据齐全。
**3 项条件（不阻塞完成，M2/M4 前需决策）**：
1. recall p95 目标：默认本地 reranker p95 ~0.96s（目标 <100ms）；关闭 reranker p95 130–136ms → M4 重定目标或调默认；
2. 10k 存储 ~233MB（目标 <200MB；`memory_links` 占 160–162MB，阈值 0.999 时 157MB）→ 真实数据校准/link 调参；
3. 打包：pip 运行时 ~1.8GB + 模型 224MB，无官方单文件 server → M2 做打包 PoC（单文件 vs slim+外部 embedding）。
证据：`spike/m1-c-hindsight/REPORT.md`、`C0-FACTS.md`、`EGRESS-PRIVACY.md`、`results/`。

**前置**：用户批准联网/获取固定版本 Hindsight（版本、许可、本地运行方式、Node SDK/API 需按官方文档核验）。
**产出**：`MEMORY-SERVICE-SPEC.md` + 薄 MemoryAdapter + 基准/隐私/删除证据 + Go/No-Go。

1. **C0 事实核验**：固定版本/许可/发布节奏；本地运行模式/进程/存储依赖/资源；Node/TS SDK 能力；
   数据根/备份/恢复/迁移/删除/升级；LLM/Embedding 外发与费用；打包/安装依赖（避免用户另装 Python/DB）。
2. **C1 本地运行时**：Supervisor 启动/健康/停止/重启/升级；数据根在 Nisse 自有数据目录（spike 用隔离 /tmp）；
   支持备份/恢复/回滚演练。
3. **C2 MemoryAdapter**：映射 `memory_search/write/forget/export`；命名空间（全局/项目/session）+ 来源 session/turn；
   单写者；敏感信息写入拦截；错误映射（不假装成功）；不重写 Hindsight 的提取/索引/检索算法。
4. **C3 行为**：显式“记住”+ 设置编辑；自动抽取可开关可审计；去重/合并/冲突/时间有效性/superseded；
   用户查看/修改/删除/导出；**删除后不可召回**验证；旧 `~/Documents/Nisse` 幂等迁移且可回滚。
5. **C4 性能/质量**：10k 条测试集（M4 前 100k）；检索 p95 <100ms、写入 <200ms（不含 LLM 抽取）、
   存储 <200MB、digest ≤500–1000 tokens；记录机器规格/版本/数据集/冷热/并发/召回质量。
6. **C5 隐私**：数据外发清单；优先复用 DSH/Nisse 已配置模型与凭据，不暗中新增 Key；日志不含记忆原文/密钥。
7. **C6 Go/No-Go**：按 v3 §14.8；No-Go 时提交证据/阻塞/最小补救与成本，等待用户裁决，不得擅自换后端或自研引擎。

## 5. M1 退出与 Go/No-Go

- M1-A：T1–T10 全过（含 T5 播报中打断、T7 审批）+ T11–T14 + S1–S5（S6/S7 记录）；
- M1-B：B7 验收全过，且证明**未修改 DSH 核心**、无第二 Agent/双写；
- M1-C：Hindsight Go 条件全过，Adapter 行为/性能/隐私/删除验证通过；
- 三者任一 No-Go/阻塞：停止并提交证据与替代方案，不得带病进 M2。

## 5.5 M1 最终状态（2026-10-21）

- **M1-A PASS**（2 caveat）→ `spike/dsh-voice/evidence/M1-A-REPORT.md`
- **M1-B Conditional Go**（30 PASS / 0 FAIL / 6 UNVERIFIED）→ `spike/m1-bot/REPORT.md`
- **M1-C Conditional Go**（39/39 + 5/5；3 项决策）→ `spike/m1-c-hindsight/REPORT.md`
- **M1 判定：架构方向 Go / 完整验收 Conditional** → 总报告 `M1-FINAL-REPORT.md`
- 未关闭：M1-B 6 项探针（审批/并发/工具上限）、M1-B 延迟目标、M1-C 3 项条件、签名包 TCC、M1-A 语音“拒绝/取消任务”可补测。

## 6. 当前状态与下一批任务（按依赖）

1. M1-A 收尾：T5（需 10 分钟真机）+ T7（需配置审批触发工具）→ 正式 Go 判定；
2. M1-B：先出 `DSH-API-CAPABILITY-MATRIX.md`（只读审计，无需用户），再实现 session 索引/路由/接管原型；
3. M1-C：先核实 Hindsight 版本/许可/本地运行/Node 接入（需用户批准联网/获取），再实现 Adapter 与 10k 基准；
4. M2 准备：已有 `M2-PLAN.md`/`m2/` 脚手架；正式构建仍等用户提供 DSH 上游仓库与网络许可；
5. 文档：`BOT-SESSION-ORCHESTRATION.md`、`MEMORY-SERVICE-SPEC.md` 随 M1-B/C 落地细化。

## 7. 明确不做（M1）

- 不修改 DSH 核心；不创建 DSH session 父子树；
- 不做第二个 Agent / Qwen 前台自主回答/执行；
- 不做 Mem0 对照/自研完整记忆引擎/第二套向量库；
- 不做完整 UI/安装器/签名/更新（M5/M6）；
- 不做 Windows/Linux（M8）；不让 OpenElement 阻塞核心（M9）；
- 不把估算写成承诺。
