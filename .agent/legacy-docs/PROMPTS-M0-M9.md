# 分阶段交给编码 LLM 的提示词（M0–M9）

> 用法：一次只复制一个阶段给编码 LLM；每阶段验收后才能进入下一阶段。**禁止一次性执行多个阶段。**
> 通用约束（每份提示词开头默认包含）：
> - 工作区：`$HOME/projects/dsh-bot-workspace`（或真实仓库路径）。
> - 先读 `README-FOR-REVIEW.md`、`M0-FACT-BASE.md`、对应阶段文档；先给计划，再动手。
> - 不得编造文件/API/测试/构建结果；不得声称读过未提供的上游仓库。
> - 涉及文件删除、数据迁移、权限扩大、凭据、发布、推送上游、改变用户环境：**必须先说明并获得批准**。
> - 每阶段结束必须给「改了什么/证据/测试/剩余风险/下一步」摘要；测试失败/无法继续时停止并回报，不得静默跳过。

---

## 通用交付摘要格式

```
## 阶段：Mx
- 结论：完成 / 部分 / 阻塞
- 改了什么（文件/模块/关键决策）
- 证据（日志/截图/命令输出/测试报告路径）
- 测试结果（命令 + pass/fail + 关键指标）
- 剩余风险/未验证项
- 下一步建议（是否进入下一阶段）
- 需要用户决策的问题（≤5）
```

---

## M0 — 架构纠偏与文档一致性验证

**唯一目标**：验证 M0 事实/裁决/文档一致，确认没有继续沿用旧五引擎/双 Agent/假冻结/旧估算；不写产品代码。

**必读**：`README-FOR-REVIEW.md`、`M0-FACT-BASE.md`、`assistant/PRODUCT-DEFINITION.md`、`research/nisse-platform-architecture.md`、`research/nisse-execution-plan.md`、`research/dsh-fork-decision.md`、`research/dsh-fork/seams.md`、`research/dsh-fork/nisse-gaps.md`、`ROADMAP-M0-TO-1.0.md`、`SPIKE-DSH-VOICE-INTEGRATION.md`、`RISK-REGISTER.md`、`TRACEABILITY-MATRIX.md`、`ADR/*`、`review/evidence-*.md`。

**可改**：仅文档/索引/一致性修正；**禁改**：代码、配置、用户数据、DSH/Qwen 安装。

**任务**：
1. 全文 grep 旧表述：`五层`、`五个同级`、`AgentEngine`、`VoiceEngine`、`不修改 DSH 核心`、`不 hard fork`、`M0 已冻结`、`七门禁全 PASS`、`8–14 人周`、`16–28`、`50–100`；仅允许出现在历史档案/证据引用中。
2. 交叉引用检查：ADR ↔ 架构 ↔ 路线图 ↔ 风险/追溯 ↔ SPIKE 是否一致；发现冲突先列清单。
3. 证据等级抽查：随机挑 10 条「已证实」，按路径/行号复核；能复跑的单测复跑并记录。
4. 输出 `M0-CONSISTENCY-REPORT.md`：问题清单 + 修正 diff + 未决项。
5. 不启动 M1。

**测试**：grep 扫描；链接/路径存在性；单测复跑（若可）；文档内部引用检查。

**验收**：无上述旧表述（档案除外）；交叉引用无冲突；证据抽查无造假；报告包含「是否可批准 M1」结论。

**停止/回报**：发现无法消除的矛盾或证据造假 → 停止，列出证据与影响。

---

## M1 — DSH × Voice 最小集成 Spike

**唯一目标**：用最少代码证明「保留实时语音体验的同时，DSH 是唯一 Agent；语音输入/任务/审批/取消/播报形成一致闭环」。**不做** fork/build/安装器/完整 UI/记忆迁移/多平台。

**必读**：`SPIKE-DSH-VOICE-INTEGRATION.md`、`M0-FACT-BASE.md` §2.3/§7、`review/evidence-dsh.md` §3/§4、`review/evidence-qwen.md`、`review/evidence-security.md`、`review/evidence-runtime.md`、`ADR-0002/0003/0004/0007/0008`。

**可改**：仅 `spike/dsh-voice/`（或指定分支）与临时隔离目录；**禁改**：用户 `~/.dsh`、`~/Documents/Nisse`、`/Applications`、现有生产代码（除非明确批准）。

**前置**：用户回答 `M0-FACT-BASE.md` §7 D1–D6；真实 Key/麦克风；隔离 `DSH_HOME`。

**任务顺序**：
1. 建隔离 harness + `M1-RUN-LOG.jsonl` schema；记录启动/清理/隔离检查。
2. 启动 DSH host（隔离 profile）→ ready/版本/健康；提交文本 turn → 收事件/终态。
3. 接 Qwen voice：真实麦克风 → transcript → DSH → 播报；记录延迟。
4. 路线 C：结构性移除前台执行权（工具 allowlist/注册守卫、关闭记忆/任务队列）；跑对抗测试 T11–T14。
5. 路线 A 最小对照（音频 I/O + 确定性 TTS）；路线 B 降级测量；D 只做评估。
6. 执行 T1–T10、S1–S7；记录指标（首响分项/打断/取消/崩溃/TCC/资源/成本）。
7. 输出 `m1-spike-report.md`（按 SPIKE §9 模板）+ 路线 Go/No-Go。

**高风险/需批准**：真实 API 费用；真实麦克风；修改 Qwen fork 代码；安装/启动外部进程；任何写用户环境操作。

**产物**：spike 代码/脚本；事件日志；指标；TCC 记录；报告；问题清单。

**验收**：SPIKE §8 Go 判据全部满足；T1–T10/T11–T14/S1–S5 通过；无第二 Agent；不写 `~/.dsh`；路线结论明确。

**停止/回报**：C 失败且 A/D 不可行/超预算 → 停止，按 SPIKE §8 回报，不进入 M2。

---

## M2 — DSH 发行底座与可复现构建

**唯一目标**：证明 Nisse 能在干净环境从受控 fork 构建，且上游同步成本可测；不做产品 UI/记忆/安装器。

**必读**：`research/dsh-fork-decision.md`、`ADR-0005`、`ROADMAP` M2、`M0-FACT-BASE.md` §2.3、`review/evidence-dsh.md` §1/§2。

**前置**：M1 Go；DSH 上游仓库可获取（用户提供）；构建环境。

**可改**：fork 仓库/构建脚本/CI/`UPSTREAM.txt`/`nisse/patches/`；**禁改**：用户 `~/.dsh`、现有 App、用户数据。

**任务**：
1. 建立 fork/remote/分支/tag；`UPSTREAM.txt`；patch manifest 规范。
2. 干净环境构建上游基线（记录依赖/命令/耗时/失败/产物 sha）。
3. 加最小 Nisse 目录/profile；按需 patch（每个有测试/owner/删除条件）。
4. ≥2 个上游 release merge/rebase 演练（记录冲突/耗时/失败测试/新增 delta）。
5. 独立 `DSH_HOME` 启动测试；`~/.dsh` 零写入。
6. 许可/SBOM/第三方声明；品牌/账号/遥测裁剪结论。
7. CI：构建 + patch apply check + 烟雾；输出 `m2-report.md`。

**高风险/需批准**：网络 clone/依赖安装；修改构建环境；任何发布/推送；证书/签名（M6 才做）。

**测试**：干净构建；merge 后 DSH 测试 + Nisse 烟雾；隔离写入检测；许可清单核对。

**验收**：ROADMAP M2 退出标准；ADR-0005 阈值未触发或已触发并执行动作。

**停止/回报**：仓库不可得/构建不可复现/merge 成本超阈值 → 停止，按 ADR-0005 降级路径回报。

---

## M3 — 一体化 Runtime、Shell 与 Product Contract

**唯一目标**：一个 App 启动/监督 DSH+Voice，完成真实语音任务；不依赖用户 DSH；故障可见可恢复。**不做**完整 MVP/记忆/安全闭环/签名更新。

**必读**：`research/nisse-platform-architecture.md` §2–§5、`ADR-0004/0007/0008`、`ROADMAP` M3、`review/evidence-security.md`（SEC-11/12/13/14/18）、`review/evidence-runtime.md` §5。

**可改**：Nisse Shell/runtime/contracts/spike 集成层；**禁改**：用户 `~/.dsh`、生产发布物、用户数据。

**任务**：
1. Supervisor：启动/停止顺序、健康、单实例、退出清理、崩溃重启、孤儿回收。
2. DSH host 子进程：独立 `DSH_HOME`、发行 profile、Host Integration 打包、版本握手。
3. Voice Runtime 子进程：设备所有权、IPC、心跳、崩溃处理。
4. Product Contract v0 + 契约测试（ID/状态/命令/事件/错误）。
5. 产品层最小状态机 + UI 接入。
6. 故障注入矩阵（杀进程/断网/设备/版本）。
7. TCC/权限归因实测；`~/.dsh` 零污染测试。
8. 输出 `m3-report.md`。

**高风险/需批准**：修改系统权限；签名 helper；安装到 `/Applications`；杀进程测试仅限隔离环境。

**验收**：ROADMAP M3 退出标准；无孤儿/无污染/故障可见；一次语音任务无需 DSH UI。

**停止/回报**：DSH host 无法稳定嵌入/版本不兼容 → 停止，评估 core patch/替代，不进入 M4。

---

## M4 — MVP：主路径、人格、记忆、安全闭环

**唯一目标**：少量真实可用场景 + 安全/记忆闭环；不做漂亮首启/多平台/订阅/OE。

**必读**：`PRODUCT-DEFINITION` §5、`ADR-0006/0007`、`ROADMAP` M4、`review/evidence-security.md`（全部 SEC）、`review/evidence-runtime.md` §6、`TRACEABILITY-MATRIX`。

**可改**：产品代码/记忆模块/安全策略/测试；**禁改**：用户现有记忆/DSH 数据（迁移需备份与批准）。

**任务**：
1. 主路径 4 条（问答/搜索、低风险文件任务+审批、进度查询、打断/停止/取消/急停）。
2. 人格单一来源 + 编辑生效。
3. 记忆 v1：schema/tools/prompt section/迁移/查改删导出/删除召回验证。
4. 安全：审批绑定/过期/撤销、always-allow 作用域+审计、路径校验、取消竞态、L3 拒绝、日志脱敏。
5. E2E + 安全矩阵 + 7 天 dogfood。
6. 输出 `m4-report.md`。

**高风险/需批准**：记忆迁移（备份/回滚）、文件操作测试、权限扩大、真实用户数据（用合成数据）。

**验收**：ROADMAP M4 退出标准；安全 P0 全过；无阻塞缺陷；dogfood 记录。

**停止/回报**：主路径不可靠/安全 P0 无法修复 → 缩范围或停止，不进入 M5。

---

## M5–M6 — Alpha 产品体验与发行工程

**唯一目标**：M5 = 新用户能理解并使用；M6 = 可安装/签名/更新/回滚/卸载。**分开执行，不得合并为一次大改。**

**必读**：`ROADMAP` M5/M6、`PRODUCT-DEFINITION` §5、`ADR-0009`、`RISK-REGISTER` R13/R16/R18/R19、`review/evidence-runtime.md` §5。

**可改**：UI/首启/设置/安装/CI/签名/更新；**禁改**：核心 Agent 语义（除非缺陷）、用户记忆删除策略（需产品确认）。

**M5 任务**：首启向导、Key/语音/权限、状态可辨识、任务历史、错误引导、音频设备、性能基线、用户测试。
**M6 任务**：签名/公证/硬化、安装器、更新+回滚、卸载、版本矩阵、备份/迁移、SBOM/许可、遥测/隐私、支持文档、干净机测试。

**高风险/需批准**：证书/签名/公证；修改安装/卸载逻辑；更新 feed；任何发布。

**验收**：ROADMAP M5/M6 退出标准；干净 Mac 安装→首任务；升级失败回滚；卸载数据策略明确。

**停止/回报**：公证失败/更新不可回滚 → 暂停发布，修流水线。

---

## M7 — Beta / RC / 1.0 门禁

**唯一目标**：用真实使用与故障注入证明可靠性/可维护性/用户理解度；冻结范围。**不新增功能。**

**必读**：`ROADMAP` M7、`RISK-REGISTER`、`TRACEABILITY-MATRIX` §4、`review/evidence-security.md`。

**任务**：连续运行/长任务；故障注入（网络/模型/语音/DSH/磁盘/权限/睡眠/多显示器）；文件操作可逆/审批/取消竞态；记忆纠错/导出/删除/迁移；性能/资源/首响/打断；试点反馈；发布/回滚/上游同步演练；RC 范围冻结。

**验收**：ROADMAP M7 退出标准；无严重安全/数据丢失；发布/回滚/支持演练记录；RC 冻结。

**停止/回报**：出现严重安全/数据丢失/不可恢复故障 → 暂停发布，修根因。

---

## M8 — Windows / Linux

**唯一目标**：把「普通电脑用户」长期目标转为真实平台支持；不做「代码能编译」的假跨平台。

**必读**：`ADR-0009`、`ROADMAP` M8、`M0-FACT-BASE.md` §2.4、平台相关代码。

**前置**：macOS 1.0 发布；资源；需求证据。

**任务（Windows 先）**：输入控制/辅助功能/屏幕捕获 spike；窗口/托盘/热键/通知/自启动；音频/唤醒/本地依赖；安装器/签名/分发/更新/卸载；路径/权限/数据迁移；架构/硬件矩阵；独立测试矩阵/支持声明。Linux 仅评估。

**高风险/需批准**：系统级输入控制；签名/分发；平台权限；独立发布。

**验收**：平台 spike 通过；独立测试矩阵；支持声明；成本区间。不得用 Electron 跨平台替代平台能力验证。

---

## M9 — OpenElement Client Go/No-Go

**唯一目标**：以已稳定 Product Contract 为边界，评估 OE 一页重写是否值得；不重写 Shell/桌宠原生窗；不阻塞核心。

**必读**：`ADR-0008/0010`、`ROADMAP` M9、`research/nisse-platform-architecture.md` §4。

**任务**：一页 spike（设置或任务历史）；消费 Product Contract；对比现有 renderer 的首屏/交互/包体/构建/维护成本；Go/No-Go 与回退。

**高风险/需批准**：新增构建链/依赖；修改 renderer 架构；任何影响发布节奏的改动。

**验收**：一页可运行；成本对比报告；Go/No-Go 明确；可回退。

**停止/回报**：alpha 不稳定/构建链不可维护 → No-Go，保留现有 UI，不阻塞发布。

---

## 通用停止条件（所有阶段）

出现以下任一情况，停止并回报，不得继续：
1. 证据不足却要求宣称完成；
2. 测试失败无法在阶段预算内修复；
3. 需要修改用户数据/权限/发布/推送上游但未获批准；
4. 发现严重安全/数据丢失风险；
5. 阶段退出标准无法满足；
6. 上游/外部依赖不可得且无替代。
