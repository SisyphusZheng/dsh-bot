# Nisse（家灵）项目入口：事实、架构与当前阶段

> 更新时间：2026-10-21（v3 修订：Route A + Hindsight + M1-A/B/C）｜版本参考：Nisse 2.3.1（原型）+ dsh-nisse 0.6（迁移参考）+ DSH 0.2.1-rc.2
> **本文件是项目唯一入口。** 架构/路线/风险/证据以此为准；旧 v3.0 文档已归档并标记 superseded。
> 如果只读三份：本文件 → `M0-FACT-BASE.md` → `ROADMAP-M0-TO-1.0.md`。

---

## 1. 一句话

**Nisse 是一款基于 DSH（DeepSeek Harness）二次开发的独立桌面个人 Agent 产品：桌宠身体 + 实时语音 + 长期记忆 + 真实电脑操作；DSH 是唯一 Agent 基座，语音是 I/O 子系统，Nisse 拥有自己的 Shell、产品层、安装包与发行节奏。**

不是 DSH 插件，不是用户另装 DSH 的薄壳。

---

## 2. 当前阶段（不要沿用旧标签）

| 判断 | 依据 |
|---|---|
| **内部可运行原型（Prototype / 内部 Alpha，Pre-MVP）** | 真机可运行：桌宠/气泡/托盘、DashScope 实时语音、唤醒词、打断、DSH 会话桥、单轮审批、记忆工作区文件、六版 DMG。见 `review/evidence-runtime.md` |
| **M1 完成（Conditional Go）** | M1-A PASS（语音/单权威/取消/停播报/审批）；M1-B 30/36 PASS + 6 UNVERIFIED（模型探针依赖）；M1-C 39/39 + 5/5 真实模型（3 项决策）。见 `M1-FINAL-REPORT.md` |
| **v3 冻结决策（2026-10-21）** | **Route A**：Bot 顶层逻辑编排，**不修改 DSH 核心**；**Hindsight** 唯一长期记忆后端（薄 MemoryAdapter）；M1 拆 M1-A（Voice）/ M1-B（Bot Session）/ M1-C（Hindsight） |
| **M2 完成（baseline，2026-10-21）** | fork `dsh-bot/deepseek-harness`；pin `dsh-v0.2.1-rc.2`；干净 install/typecheck/build/build:check 全绿；2 次上游 sync 演练 0 冲突；隔离 DSH_HOME+Nisse profile 冒烟 PASS；0 core patch。见 `m2/M2-FINAL-REPORT.md` |
| **M4 工程完成（2026-10-22）** | 主路径 1–4 文本 E2E、人格 5/5、Hindsight 记忆 5/5+3/3、安全/审计 6/6、E2E 套件 5/5；**真实语音/TCC + 7 天 dogfood 待用户**。见 `m4/M4-FINAL-REPORT.md` |
| **M3 计划内完成（prototype 级，2026-10-21）** | M3-1…M3-6 全部 PASS：Supervisor、Product Contract、Host Integration v0（7/7）、Voice Runtime 边界（6/6）、产品状态机（6/6）、双进程故障注入（5/5）；Electron Shell 原型已完成（单实例/托盘/监督/状态 UI/退出清理 3/3 PASS）；**真实音频/TCC 需用户真机配合**；完整产品 UI/记忆/人格属 M4。见 `m3/M3-FINAL-REPORT.md` |
| **不是 MVP** | 没有单安装包、独立 runtime、签名/更新、TCC 证据、单权威闭环 |
| **不是发布阶段** | 全 ad-hoc 签名、`spctl rejected`、updater 关闭 |

**真实完成度**：桌面/语音资产约 60–70% 可复用；产品级运行时/安装/安全/发行约 0–20%；**单一 Agent 权威 = 0（当前是双权威 + prompt 压制）**。

---

## 3. 最终架构（一页）

```
Nisse.app（一个产品）
├─ Electron main（Shell + 产品层 + Supervisor）
│   ├─ renderer（桌宠/面板/设置/记忆/审批）— sandbox，无 Node
│   ├─ DSH host 子进程（独立 DSH_HOME，Nisse profile）
│   │    └─ Nisse Host Integration（第一方、随包分发、非用户插件）：turn/事件/审批/取消/记忆/人格
│   └─ Voice Runtime 子进程（麦克风/播放/VAD/唤醒/ASR/TTS/打断/回声）— 无执行权
└─ 用户不需要安装/启动/配置 DSH 或插件
```

**责任**：DSH = Agent 决策/执行/会话/工具/审批门/取消终态；Host Integration = 集成层（不是第二 Agent）；产品层 = 状态/审批 UX/记忆 UX/人格 UI；Shell = 窗口/托盘/TCC/监督/更新；Voice = 音频 I/O；Release = 构建/签名/发布。

**契约**：类型化内部契约（IDs：`conversationId`/`sessionId`/`turn`/`turnId`/`voiceTurnId`/`approvalId`/`eventSeq`；命令/事件/错误见 `research/nisse-platform-architecture.md` §4 与 ADR-0008）。v1 不建公共 HTTP API。

**关键的 DSH 事实**（源码审计 `review/evidence-dsh.md`）：

- token 级流只在进程内 `agent/assistant-stream`；durable 消息不是逐 token；
- 审批只有 `allowed-once/rejected/cancelled/unavailable`，无 always-allow；
- 无 `dsh-memory`；记忆=session+compaction+AGENTS.md+MCP+skill；
- turn = 每会话自增整数；无 UUID task id；
- 外部 ACP/SDK/headless 不能同时提供「同会话+token 级+审批」；Host Integration 是必要的内部组件。
- 桌宠独立窗/托盘/品牌/安装/更新必须自有 Shell；CLI 拒绝 `--profile desktop`。

**语音/编排/记忆（v3 冻结）**：

- 语音：Qwen 只作音频 I/O（Route A 目标形态）；M1-A 已比较 C/A（见 `W4-COMPARISON.md`），T5/T7 待补测；
- 编排：Bot 是常驻顶层 main session/统一角色/逻辑协调层，由 Nisse/Host Integration 逻辑编排，**不修改 DSH 核心、不创建 session 父子树**（`BOT-SESSION-ORCHESTRATION.md`）；
- 记忆：**Hindsight** 固定为唯一长期记忆后端，薄 `MemoryAdapter`（`MEMORY-SERVICE-SPEC.md`）；旧文件工作区仅作迁移/备份/导出。

---

## 4. 证据边界（必须知道）

**本机可读/已核实**：

- `research/qwen-audio-agent`：完整 upstream v2.0.1 checkout（HEAD `a73bcbc`），Nisse 工作区改动 74 文件/+27036/−180；
- DSH 0.2.1-rc.2 安装包 app.asar 内 307 个 `@deepseek-ai` 包源码（只读审计）；
- `dsh-nisse` 0.6 插件源码与真实运行态 `/health`、网关日志；
- `m1a/` 535 个证据文件；`dist/` 六个 DMG；`~/Documents/Nisse` 记忆文件；
- 本次复跑单测：气泡/布局 26/26、语音重复 10/10、打断 22/22 PASS。

**不能验证（不要假设已验证）**：

- DSH 上游 git 历史/CI/最新版本；本机只有安装包，无源码树/lockfile；M2 构建未做；
- 从源码构建 DSH、跨版本 merge 成本；
- Apple 签名/公证（无证书；现有 DMG ad-hoc、`spctl rejected`）；
- 打包版真人麦克风 TCC（TCC.db 不可读；无授权日志）；
- Qwen 服务条款/模型转售授权/线上最新版本；
- 完整二进制 patch（仅有工作区与 5.3MB patch 文件）。

**报告口径提醒**：旧 `gate-report.md` 的「七门禁全 PASS」与 `m2-report.md` 的「M2 MVP 已交付」已被证据修正（G6 原始失败、G3 部分、TCC 未测、哈希漂移）。以 `review/evidence-runtime.md` 为准。

---

## 5. 文档地图（新）

| 路径 | 用途 |
|---|---|
| `M0-FACT-BASE.md` | **事实基线、矛盾表、25 项资产/差距矩阵、当前阶段、待决策** |
| `assistant/PRODUCT-DEFINITION.md` | 产品定义 v3.1（定位/用户/场景/原则/指标/非目标） |
| `research/nisse-platform-architecture.md` | 架构 v3.1（责任表/进程图/事件流/契约/数据边界） |
| `research/nisse-execution-plan.md` | 阶段索引/门禁摘要 |
| `ROADMAP-M0-TO-1.0.md` | 完整 M0–M9 工作包/测试/退出标准/估算 |
| `SPIKE-DSH-VOICE-INTEGRATION.md` | M1 实验规格（路线/10 项测试/判据/记录格式） |
| `research/dsh-fork-decision.md` | 受控 fork / patch queue / 上游同步 / 触发器 |
| `research/dsh-fork/seams.md` | DSH 接缝重分类（复用/改核心/Host Integration/产品层/Shell） |
| `research/dsh-fork/nisse-gaps.md` | 需求×现状×目标×测试 |
| `assistant/MASTER-CORRECTION-PROMPT-v3.md` | **v3 主提示词（用户 2026-10-21 提供；冻结 Route A + Hindsight）** |
| `M1-WORK-PACKAGES.md` | M1 任务书（M1-A/B/C、状态、剩余工作） |
| `M1-SPIKE-PROMPTS.md` | M1-A/B/C 三份阶段提示词 |
| `BOT-SESSION-ORCHESTRATION.md` | Route A 顶层 Bot 逻辑编排契约（会话/路由/摘要/接管/预算/审计） |
| `MEMORY-SERVICE-SPEC.md` | Hindsight + 薄 MemoryAdapter 规格（M1-C） |
| `DSH-API-CAPABILITY-MATRIX.md` | DSH API 能力审计（Route A/Bot/Hindsight 前置） |
| `M3-REQUIREMENTS-BOT-MEMORY.md` | Bot 与长期记忆需求定义（v3 对齐） |
| `M3-M4-DESIGN-INPUTS.md` | M3/M4 设计输入（性能/语音/编排/记忆/安全） |
| `M2-PLAN.md`、`m2/` | M2 准备：计划/模板/preflight |
| `ADR/ADR-0001…0010` | 关键决策记录（含备选/代价/重开条件） |
| `RISK-REGISTER.md` | 25 项风险、触发、缓解、门禁 |
| `TRACEABILITY-MATRIX.md` | 需求/安全/契约 → 测试 → 门禁 |
| `review/evidence-dsh.md` | DSH 0.2.1-rc.2 源码审计（带 path:line） |
| `review/evidence-runtime.md` | 真机/产物证据审计（带日志行/复跑命令） |
| `review/evidence-security.md` | 安全/隐私审计（C/H/M/L/G 发现、SEC 测试映射） |
| `review/evidence-qwen.md` | Qwen 前台双 Agent 取证（Lead 直接审计；原任务中断） |
| `research/archive/2026-10-21-v3.0/`、`assistant/archive/` | 历史 v3.0 原稿（superseded，不得作为当前依据） |

---

## 6. 本次 M0 修复了什么

1. **删除五引擎模型**：DSH 是固定 Agent 基座；Search/ComputerUse 是 DSH 工具，Memory 是 Host Integration 扩展，Voice 是 I/O；不存在「五个同级可替换引擎」。
2. **v3 冻结（覆盖旧表述）**：**当前 Route A 不修改 DSH 核心、不建 session 父子树**；fork/patch 决策推迟到 M2/M3，任何 core patch 必须重新获得用户批准并走 ADR-0005 patch queue。
3. **修正 fork 决策自相矛盾**：旧稿同时写 R2-N 推荐与 R2-O 已选；新稿只有单一结论与降级路径。
4. **修正产品关系**：Nisse 是独立发行产品；`dsh-nisse` 插件退役为迁移参考；最终运行时不要求用户安装插件。
5. **v3 冻结（覆盖旧表述）**：长期记忆后端固定 **Hindsight**（薄 MemoryAdapter，Host Integration 集成）；不做 Mem0 对照/自研完整引擎；旧文件工作区仅作迁移/备份/导出源。
6. **v3 修订路线**：M1 拆 **M1-A（Voice）+ M1-B（Bot Session Orchestration）+ M1-C（Hindsight Memory）** 三个 Spike；M2 = fork/build；不再先 fork。
7. **新增 v3 文档**：M1 任务书、三份阶段提示词、Bot 编排契约、Hindsight 记忆规格、DSH API 能力矩阵（见 §5）。
7. **修正阶段判断**：M0 重新定义并完成事实/裁决/风险；旧「M0 已冻结」作废。
8. **修正指标口径**：不再承诺未验证的 p50/p95、0 越权、100% 敏感画面；先基线后冻结。
9. **补充资产矩阵/风险/追溯/Spike 规格/首批任务**，可直接交给工程 LLM。

---

## 7. 关键决策与未决问题

**已定（ADR）**：独立产品关系；DSH 唯一 Agent；语音 I/O 边界；多进程运行时；受控 fork；记忆权威；审批/取消/急停语义；内部契约；macOS 优先；OE 延后。

**v3 冻结（已决定）**：Route A 顶层 Bot 逻辑编排（不改 DSH 核心）；Hindsight 唯一记忆后端；DSH 唯一 Agent；M1 拆 M1-A/B/C；
不把 Mem0 对照/泛化记忆选型/自研记忆引擎列入计划。

**仍待用户提供/批准**：DSH 上游仓库 + 网络/构建许可（M2）；M1-A 的 T5/T7 真机补测；Hindsight 获取/版本核实与联网许可（M1-C）。

---

## 8. 下一阶段与批准门

**M1 已启动（v3 结构）**：

- **M1-A（Voice）**：大部分完成；剩 T5 播报中打断、T7 审批语音、A/C 听感 → 正式 Go/No-Go；
- **M1-B（Bot Session Orchestration）**：**完成（Conditional Go）**——验收 30/36 PASS、0 FAIL、6 UNVERIFIED（模型探针依赖）；`spike/m1-bot/REPORT.md`；
- 最终总报告：[M1-FINAL-REPORT.md](M1-FINAL-REPORT.md)。
- **M1-C（Hindsight Memory）**：**完成（Conditional Go）**——v1.0.0 本地运行、薄 Adapter、39/39 确定性 + 5/5 真实 opencode-go、10k 基准/隐私/删除/迁移证据；3 项 M2/M4 决策：recall p95 目标、10k 存储、打包体积（`spike/m1-c-hindsight/REPORT.md`）；
- 三份阶段提示词：`M1-SPIKE-PROMPTS.md`；任务书：`M1-WORK-PACKAGES.md`。

**M1 任一 Spike No-Go/阻塞：停止并提交证据与替代方案，不得带病进入 M2。**

---

## 9. 给评审者/工程 LLM 的提醒

- 不要沿用旧 v3.0 的五层/五引擎/「不改核心」/「8–14 人周」表述；
- 不要把「文档写了」当作「已验证」；每个结论看证据等级；
- 不要把「有审批按钮」当作安全边界（见 `review/evidence-security.md`）；
- 不要在没有真实 DSH 仓库时假设构建/merge 可行；
- 不要在没有 TCC 实测时假设权限可用；
- 不要在没有单权威测试时进入 M2/M3。
