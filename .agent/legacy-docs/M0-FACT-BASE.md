# M0 事实基线、证据边界与资产/差距矩阵

> 状态：M0 交付物（2026-10-21）｜评审小组：Lead + 5 名证据审计员
> 本文件是 M0 的**唯一事实入口**。所有架构裁决、路线图与文档修订必须以本文件为准；与本文件冲突的旧文档表述一律视为过时。
> 关联证据：`review/evidence-dsh.md`（DSH 安装包源码审计）、`review/evidence-runtime.md`（真机/产物证据审计）；`review/evidence-qwen.md`、`review/evidence-docs.md`、`review/evidence-security.md` 为补充证据（均已产出；若个别结论不完整，以本文件已列证据为准）。
> **v3 更新（2026-10-21，优先级高于本文件旧表述）**：当前架构冻结为 **Route A**（Bot 顶层逻辑编排，**不修改 DSH 核心**、
> 不创建 session 父子树）+ **Hindsight 唯一长期记忆后端**（薄 MemoryAdapter）；M1 拆为 M1-A/B/C 三个 Spike。
> 文中「Host Integration 文件后端作为记忆权威」「必要时允许改核心」等一般性表述被覆盖；以 `README-FOR-REVIEW.md`、
> `M1-WORK-PACKAGES.md`、`BOT-SESSION-ORCHESTRATION.md`、`MEMORY-SERVICE-SPEC.md` 为准。
> 证据分级：**【已证实】** 本次直接读源码/日志/产物或复跑测试；**【强推断】** 由已证实事实推出、未端到端复现；**【待实验】** 必须跑实验才能定论；**【未知】** 无材料可验证。

---

## 0. 一句话结论

项目不是「空想」，也不是「MVP」：它是**已有真机运行能力的内部原型（Prototype / 内部 Alpha）**，桌面壳、实时语音、审批、桥、记忆工作区都真实跑过；但**产品级单一 Agent 权威未成立**、**旧架构文档自相矛盾**、**真机/发行证据被报告口径夸大**、**没有可复现的构建与发布门禁**。因此当前真实阶段是 **Pre-M1（M0 纠偏未完成）**，不能按旧文档的「M0 已冻结、进入 M1 fork」继续。

---

## 1. 审查范围与证据边界

### 1.1 实际可访问的对象

| 对象 | 实际情况 | 本次审查方式 |
|---|---|---|
| 项目工作区 | `$HOME/projects/dsh-bot-workspace`，**不是 git 仓库**（无 `.git`），无分支/HEAD/CI 可查 | 全量文件清点、报告/日志/产物读取 |
| Nisse 客户端源码 | `research/qwen-audio-agent/`：完整 upstream v2.0.1 checkout（HEAD detached `a73bcbc`，origin `github.com/QwenAudio/qwen-audio-agent`），工作区含 Nisse 改动 **74 files / +27036 / −180**（`git diff` 实测） | 源码、`git diff`、tests、package.json、README/docs |
| 已安装 Nisse | `/Applications/Nisse.app` 2.3.1；`dist/` 六个 DMG（2.0.1–2.3.1，139.7–155.4MB） | `hdiutil`/`PlistBuddy`/`codesign`/`spctl`/sha256；未启动 GUI |
| DSH 安装包 | `/Applications/DeepSeek Harness.app` 0.2.1-rc.2（app.asar 182MB）；**没有 DSH 上游 git 仓库、没有源码树、没有 CI/测试/lockfile** | 用 Electron RunAsNode 只读读取 asar 内 307 个 `@deepseek-ai` 包源码（`review/evidence-dsh.md`） |
| DSH CLI | `runtime/cli/bin/dsh` 0.2.1-rc.2；`dsh --help`、`dsh web --help` 实测 | 只读命令 |
| `dsh-nisse` 插件 | v0.6.0，`plugin/lib/index.js` 1637 行 + `memory-workspace.js` 231 行；本机真实 desktop profile 已加载，`/health` 显示 `turnScopedEvents=true` | 源码 + 运行态只读探测 |
| Qwen 语音运行态 | `~/.config/qwaudio/state/desktop/logs/gateway.log` 有真实 DashScope 回合、11 次 duplicate-skip、54 次 bridge cancel、8 次审批 | 日志计数与抽样 |
| 记忆工作区 | `~/Documents/Nisse/`（USER/MEMORY/WORKLOG/PROJECTS/NOTES）已 seed；但真实会话语义落到 `~/Documents/deepseek-harness/default-workspace/` | 文件读取 + `/health` 的 `resolved.workspace` |
| 真机测试证据 | `m1a/` 535 个文件（21 篇报告 3389 行 + 489 证据：189 log/207 png/69 json），`m1a/evidence/SHA256SUMS` 364 条 | 逐项回读；复跑 3 组单测（26/26、10/10、22/22 PASS） |
| 历史产品文档 | v0.1/v1.1/v2.0/v2.1/v3.0；`.plan/nisse-one-long-term.md`；`research/coopanion-vs-nisse.md` | 全文/关键段落；v3.0 已归档 |

### 1.2 明确不能验证的内容（不得假装已验证）

1. **DSH 上游 git 历史、真实改动集、CI、测试、发布流程**：本机只有安装包；`dshBuildCommit=332895e0…` 对应的提交无法核对。`seams.md` 引用的 `/tmp/dsh-src@687f282` 今日不在，本文件只把其中结论标为「研究文档证据，待复核」。
2. **DSH 最新版本、npm registry 类型包、线上许可/EULA/品牌政策**：未联网核查。
3. **从 DSH 源码构建**：没有源码树、没有 lockfile/构建脚本，M2 的「干净环境构建」完全未验证。
4. **Qwen Audio 上游之外的完整上下文**：本机有 v2.0.1 完整 checkout，但没有其 GitHub Actions/在线最新版本；服务条款/模型转售授权未验证。
5. **Apple 签名/公证**：无证书、无公证记录；现有 DMG 全为 ad-hoc 签名，`spctl` rejected。
6. **真实用户 TCC 归因**：TCC.db 读取被系统拒绝；打包版真人麦克风授权无日志。
7. **完整 5.3MB 二进制 patch**：本机有工作区与 `desktop-fork/patches/0001-nisse-mvp.patch`（本文件以实测 patch 为准），但没有独立二进制资源仓库。
8. **任何「线上最新」结论**：本文件一切版本/许可数字都来自本机，不代表上游当前状态。

### 1.3 证据等级定义

- **【已证实】**：本次亲自读到的源码/日志/安装包，或本次复跑通过的测试；给出可复现命令或文件行号。
- **【强推断】**：原始证据支持，但未做受控复现；需要 M1/M3 实验确认。
- **【待实验】**：只有设计/单测/口头说明，必须跑真实实验。
- **【未知】**：无任何可用证据；不得在文档中假设。

---

## 2. 事实清单

### 2.1 已证实（本次直接验证）

**A. 项目与资产**

1. 工作区无 git，版本管理缺失；`research/qwen-audio-agent` 是唯一带 git 的源码树（upstream v2.0.1，HEAD `a73bcbc`）。
2. Nisse 2.3.1 安装态存在；`/Applications/Nisse.app` 的 `app.asar` 与 `dist/nisse-2.3.1-mac-arm64.dmg` 内 asar sha256 一致（`2ad25953…`），说明当前安装包即该产物。
3. 六版 DMG 均可挂载；Info.plist/AppId/麦克风文案正确；但**全部 ad-hoc 签名**（`TeamIdentifier=not set`），`spctl -a` → **rejected**，不可对外分发。
4. Nisse.app 安装体积约 337MB（asar 约 35MB）；运行实例主进程 RSS 75.8MB + 6 helper ≈ 360MiB；DMG 139.7–155.4MB。**没有冷启动/内存/体积门禁数据**。
5. Qwen fork 的 patch 在干净 upstream 树 `git apply --check --binary` 通过（本次复验 exit 0），patch sha256 `6c219247…` 与 2.3.1 报告一致。
6. `dsh-nisse` 0.6.0 已加载到真实 desktop profile；`/health` 返回 `memoryWorkspace=true`、`turnScopedEvents=true`、`cancel=true`；真实网关日志有 8 次审批请求/答复、11 次 `voice_delegate_duplicate_skipped`、54 次 `bridge_turn_cancelled`。
7. 真实 Qwen 语音链路工作：DashScope 已连接，真实会话日志有 `voice-<ts>-N` 回合；`desktop-fork-run.log` 有 2 个真实 VAD 回合 `response.done hasAudio:true`（环境声触发，非受控对话）。
8. 复跑单测：气泡/布局 26/26 PASS；语音重复 10/10 PASS；打断/停止短语 22/22 PASS。

**B. DSH 平台（`review/evidence-dsh.md`，逐条带 asar 路径/行号）**

9. DSH 0.2.1-rc.2；307 个 `@deepseek-ai` 包；license 303 MIT / 2 MPL-2.0 / 2 BSD-3-Clause；**asar 内无根 NOTICE/LICENSE**；依赖全部精确版本，**无 lockfile**；**所有 `.d.ts` 缺失**，第三方开发无类型。
10. Agent 决策核心是公开的进程内 Cordis 服务：`ctx.agents`（create/resume/get/roots/followup/steer/inject/cancel）、`ctx.sessions`（事件溯源）、`ctx.tools`、`ctx.approval`、`ctx.systemPrompt`、`ctx.llm`、`agentDefaultModel`。
11. **turn 是每会话自增整数**（`turn/start {turn}`、`step/start {turn,step}`、`turn/end {turn, reason}`）；**没有 UUID 形式的 task id**；`turn/end.reason.kind` ∈ `completed|error|aborted|blocked|forked`。
12. token 级流只在进程内 `agent/assistant-stream`（start/chunk/end 帧）；durable `assistant/message` 是提交后压缩流，不是逐 token 直播；README 明确 live 事件不是回放源。
13. 审批 = `ctx.approval`（`dsh-user-approval`）：`allowed-once / rejected / cancelled / unavailable`；**没有 allow-always、规则存储、撤销、grant store**；请求必须落在 open turn 内；无 answerer 时 fail-closed 为 `unavailable`。`dsh-authorization` 是凭据登录流，**不是工具审批**。
14. **没有 `dsh-memory` 包**；DSH 的「记忆」= session 日志 + compaction + AGENTS.md + MCP resources + skills；Nisse 的 USER/MEMORY/WORKLOG 是纯产品层文件（`memory-workspace.js` 零 DSH 依赖）。
15. 外部进程集成只有 4 条路：进程内插件（唯一同时做到同会话 + token 级 + 审批接管）、ACP（仅 committed，有 `request_permission`）、SDK（全量 durable 事件，但无审批）、headless `--json`（提交后投影，无逐 token）。Web Host 的 `$events`/`session.follow` 是私有协议，只建议 POC。
16. 桌宠独立透明窗、托盘、开机自启、品牌/安装器/强制更新门**必须由自有壳或 fork 壳实现**：DSH 安装包 `lib/main.js` 有 `BrowserWindow/Tray/ipcMain`，但无插件开窗 API、无 `setLoginItemSettings`/`globalShortcut`；CLI 显式拒绝 `--profile desktop`。
17. DSH 发行物没有可用的公开「本地受信任客户端 API」：外部客户端要拿 token 级/审批，只能走进程内扩展或私有 Web 协议；没有公开稳定性承诺。
18. `dsh-nisse` 插件依赖面大多有随包 README（叠加风险中高），但有 4 个灰色/高风险点：手搓 user message 直塞 `followup`、依赖 `payload.agent` 隐式注入与 assistant-stream 帧字段、`workspaceRegistry.initializeDefault` 代码有文档无、`agent.status` 字符串。

**C. 现有语音与桌面实现**

19. Qwen Audio v2.0.1 的 architecture 明确是「前台 realtime Agent + 后台 Agent（ACP/A2A/…）」：README 写「可直接回答的问题立即回答；需要工具/持续处理时交给后台 Agent」。
20. 前台 Agent 有自己的工具与任务/记忆：`docs/frontend-agent-roadmap.md` 定位「一个完整的、可调教的 Agent」，基础工具含 `spawn_thinking / schedule_reminder / cancel_agent_task / get_agent_task_status / memory / notes / respond_permission`；`config/frontend-agent/PROMPT.md` 写「`spawn_thinking` 是唯一的内容与执行入口；所有问题都通过它交给后台」「不要调用前端检索、搜索、记忆、笔记、时间、提醒等工具（本部署已移除）」「所有实质性回答都来自后台 DSH 的结果」。
21. Nisse 的 `PROMPT.md` 是**行为约束**，不是权限边界：它要求前台不得自答，但前台模型仍具备生成回复与控制工具的能力；`.env.example` 提供 `QWEN_AUDIO_SCHEDULE_TOOL_ENABLED`/`WEB_TOOLS`/`KNOWLEDGE`/`NOTES`/`RECALL` 等关闭开关，说明工具可配置禁用，但 `spawn_thinking` 等控制面工具仍存在。
22. 语音重复播报根因链（`voice-repeat-diagnosis.md` §2）：同一 gateway turn 重复 final → bridge turn 无单飞 → 插件按 session 广播、事件不带 turnId → 每个 SSE 订阅者各自 TTS。修复为 A–E 五层；本次复跑单测 10/10 PASS；真实网关日志仍有 11 次 `voice_delegate_duplicate_skipped`（触发源仍在，播报层已防）；**0 次 superseded / speech-duplicate**；插件 0.6 的 turnId 过滤已激活但**重启后未做真机重复场景复测**。
23. 停止播报与取消任务已分离：G4 日志 `PASS: playback stopped but task completed`；说「停一下」触发 `bridge_turn_cancelling reason=stop_phrase` → 取消后播「已停止。」；但**点dsh-bot只停音频、不取消任务**，用户可能误以为任务已停。
24. 审批链路可用（单轮）：真实日志 8 请求 / 8 答复；`nisse_computer` 写工作区外文件会触发审批，reject 后文件不落盘；**审批串轮/并发无任何测试证据**（S2 自列未验证）。
25. 记忆工作区：`~/Documents/Nisse` 已 seed；但真实 resume 会话的 `resolved.workspace=$HOME/Documents/deepseek-harness/default-workspace`，该目录下另有 USER/MEMORY/WORKLOG，WORKLOG 5.6KB 真实流水；**「专用工作区隔离」不成立，MEMORY.md 仍为模板**；模型主动写长期记忆未证实。
26. 安装/隔离：插件以 **symlink** 进入 `~/.dsh/profiles/desktop`，并新增多个 `~/.dsh/profiles/nisse-*`；profile 记录的版本是 0.0.1、运行版是 0.6.0；`~/Library/Application Support/Nisse/dsh-plugin-backups/` 不存在。**产品路径污染了用户 `~/.dsh`**；S6/S7 的「隔离 PASS」只针对测试 harness。
27. 崩溃恢复只到 spike/gateway 级（G1/G7 PASS：退避 1/2/4/8/16s、give-up 明确、kill 后约 1.7s 恢复）；**app 级崩溃恢复未测**；`desktop.log` 有一次 `runtime.start_failed 内嵌 Gateway 启动超时`，无自动恢复证据。
28. G6 单客户端门禁**原始不通过**：`g6-driver.log:14 FAIL single-client invariant: activeClients=0 voiceReady=2`；第一方 WebUI 实际 takeover（`explicitTakeover:true`）。报告却写「任何时刻 activeClients=1」，且引用的 `g6-webui-takeover-finding.md` 不存在。
29. 2.0.1 DMG 同一文件名有 **7 个互相矛盾的「最终 sha256」**；2.1.0 之后的构建日志缺失；2.3.1 的 `geometryChanged=false` 声称无日志存档，截图自认是合成图。
30. 唤醒词：离线 KWS 可用（合成音频 4/4 命中），但对照样本「周望军」也命中（1 例误唤醒）；真人唤醒未测。
31. 安全/权限现状：Electron 窗口配置 `contextIsolation:true / nodeIntegration:false / sandbox:true`（主窗与气泡窗均如此，属良好实践）；loopback 桥 token 为 `randomUUID()`、监听 `127.0.0.1:0`、`bridge.json` 先写后 chmod 0600；`?token=` query 也被接受；**语音审批解析过宽**：待审批时语句含「好/是/可以/行」即 allow 且该语句被吞（C-01，Critical）；`nisse_computer` 写路径零校验（H-01）；`always-allow` 用 `reason` 子串+目录前缀，空前缀/`..`/symlink 可逃逸（H-02），语音撤销只清本地文件（H-03）；`/cancel` 未确认后端停止即合成 idle（H-04）；`/health` 免认证且无 Host/Origin 校验（M-01）；WORKLOG 明文存语音原话（M-04）；`qwaudio://connect` 深链可无确认改网关（M-08）；SSE replay/日志含 userText/reason（L-04/L-05）。详见 `review/evidence-security.md`。
32. 现有应用更新器被显式关闭（`main.mjs:1640 enabled:false`）；但产物 `Contents/Resources/app-update.yml` 仍指向上游 QwenAudio 仓库（若误启用会拉第三方源）；所有 DMG 为本地 ad-hoc 构建、`spctl rejected`，无 CI 签名/公证/自有更新 feed。

### 2.2 强推断（需要 M1/M3 验证）

1. 以 Nisse 自有 Electron 壳 + 内置 DSH runtime + 第一方 Host Integration，可以在不装用户 DSH 的前提下完成「一个 App」；S3/S6 已用独立 `DSH_HOME`/复制的 profile 预演过启动真实 Host。
2. 语音前台可以通过结构性移除（工具白名单 + 关闭记忆/任务队列 + 抑制自主回复）降级为「无执行权的语音呈现层」，但当前只证明了 prompt 级约束，未证明权限级隔离。
3. 以「会话 + turn 整数 + requestId」为主键，可以在 Nisse 层建立可测试的 turn 关联；`voiceTurnId` 只作为产品关联，不替代 DSH 终态。
4. 记忆可以由 Nisse 第一方 DSH Host Integration 以「文件 + tools + prompt section」实现，不需要第二套记忆系统，也不需要通用 provider 平台。
5. 审批的 always-allow 可以由 Nisse 策略层实现（代答 DSH 的一次性审批），但必须绑定工具、参数摘要、作用域、过期、审计；否则不能接受。
6. 通过受控 fork + patch queue 可以跟踪上游；但真实 merge 成本必须用 M2 演练测量，不能沿用旧文档的数字。

### 2.3 待实验（M1/M2/M3 的必做项）

1. 语音前台能否在不破坏链路的情况下移除全部执行类工具/记忆/任务队列，且通过对抗性「直接自答/自行执行」测试。
2. 语音 TTS 是否能用 DSH 文本进行确定性/半确定性播报（而非模型自由转述），质量与延迟是否可接受。
3. DSH Host Integration 的进程内扩展 + 本机 IPC 能否稳定启动、握手、崩溃恢复、版本兼容；是否必须 patch 核心。
4. TCC 归因：Nisse.app 启动的子进程申请辅助功能/屏幕录制，系统算给谁；一次授权能否覆盖。
5. DSH 从源码构建：克隆上游、pin tag、构建、运行测试、产物与安装包一致性；上游仓库当前不可得，M2 前置。
6. 上游 merge 成本：2 个 release 的 merge/rebase/构建/测试演练，冲突数与工程人日。
7. 打包体积/冷启动/内存门禁；内嵌 runtime 后实际值。
8. 记忆迁移：`~/Documents/Nisse` 与 `default-workspace` 两份数据的 schema、去重、冲突、删除验证。
9. 审批并发/串轮/语音误识别/重放；取消与工具启动竞态；急停后无新动作。
10. 真实麦克风 TCC + 打包版端到端语音（当前只有 devBypass/环境声/文本输入证据）。
11. 第一方 WebUI/其他客户端与 Nisse 同时在线时的 peer/takeover 语义。
12. macOS 签名/公证/更新/回滚；`~/.dsh` 零污染（当前反向证据）。

### 2.4 未知（不能在文档里假设）

- DSH 上游是否允许/容忍下游再分发其品牌、账号、遥测、更新服务；是否有 EULA 约束。
- DSH 下一版是否保留当前 Cordis 服务/事件/帧字段；是否有弃用计划。
- Qwen Audio 上游是否会继续维护；其模型/DashScope 服务条款是否允许 Nisse 的商业模式（转售/中继）。
- Apple Developer 账号/证书/公证与分发渠道是否就绪。
- Windows/Linux 的输入控制、屏幕捕获、音频、签名/更新成本。
- 真实用户对「语音审批」「桌宠 + 电脑操作」的接受度与付费意愿。

---

## 3. 旧文档矛盾表（必须在 M0 修正）

> 只列会改变工程判断的矛盾；原文引用均带 path:line。完整清单见各文档档案与 `review/evidence-docs.md`（若补充）。

| # | 矛盾 | 旧文档原文/位置 | 与事实/目标冲突 | 裁决 |
|---|---|---|---|---|
| C1 | **五个同级可替换引擎 vs DSH 唯一 Agent 权威** | `assistant/archive/PRODUCT-DEFINITION-v3.0.md:36`「Agent / Voice / ComputerUse / Search / Memory 五类引擎，插件化接入」；`:141`「AgentEngine / VoiceEngine / ComputerUseEngine / SearchEngine / MemoryEngine 契约；可替换/降级」；`:212-214` 五层图中把 AgentEngine 与 VoiceEngine 并列为 L1 引擎；`research/archive/2026-10-21-v3.0/nisse-platform-architecture.md:8`「把 DSH、QwenAudio 等能力当作可插拔的发动机」；`:14`「我们不改它们的核心，只做适配层」 | DSH 是唯一决策/执行权威；Search/ComputerUse 是 DSH 工具，Memory 是 DSH 受控扩展，Voice 是 I/O 子系统；把它们做成同级可替换引擎会产生第二权威/过度抽象 | 删除「五引擎」；改为「1 个 Agent 基座（DSH）+ 1 个语音 I/O 子系统 + Nisse 产品层 + Electron Shell + 发布工程」；见 ADR-0001/0002/0003 |
| C2 | **「不 hard fork / 核心不改」vs 受控 fork 发行底座** | `assistant/archive/PRODUCT-DEFINITION-v3.0.md:110`「不在核心上做 hard fork」、`:117`「不 hard fork DSH 核心/agent loop」、`:224`「核心不改」；`research/archive/2026-10-21-v3.0/nisse-platform-architecture.md:14`「我们不改它们的核心」、`:171`「不修改 DSH 核心」；但 `:203` 又写「R2-O…允许必要的源码级更改」；`research/archive/2026-10-21-v3.0/dsh-fork-decision.md:11`「用户已拍板 R2-O…允许必要源码级更改」 | 绝对禁止改核心与「基于 DSH 二次开发的独立产品」矛盾；Nisse 的桌面壳/启动/本地 API/记忆扩展可能需要 core patch | 改为「尽可能复用上游；必要修改有证据、有测试、有 patch/delta 记录和同步策略」；见 ADR-0005 |
| C3 | **同一份 fork 决策文档里两套相反结论** | `research/archive/2026-10-21-v3.0/dsh-fork-decision.md:11`「用户已拍板 R2-O」；`:16`「解法不是 fork DSH 本身」；`:20-22`「推荐 R2-N…不 fork 源码」；`:83` 表里 R2-N「推荐」；`:92`「R2-O 已选」；`:180-181`「不 hard fork / 不 fork 桌面壳」；`:208` 又问用户「是否同意不 fork 源码走 R2-N」 | 文档自身不可执行；工程 LLM 会同时读到两套相反指令 | 归档旧稿；重写为单一结论（受控 distro fork 方向 + M2 实测校准），见 `dsh-fork-decision.md` 新稿 |
| C4 | **QwenAudio 是「第一套嘴耳」vs 其自身是完整前台 Agent** | `assistant/archive/PRODUCT-DEFINITION-v3.0.md:13`「QwenAudio 是第一套嘴耳」、`:34`「VoiceEngine 接口化，QwenAudio 可替换」；但 `research/qwen-audio-agent/README.md` 明确「前台负责 realtime 对话，可立即回答」；`config/frontend-agent/PROMPT.md:11/34` 要求所有 turn 走 `spawn_thinking`；`docs/frontend-agent-roadmap.md:3` 明确前台是「完整的、可调教的 Agent」；`voice-repeat-diagnosis.md` §2 证明双播来自两套播报管线 | 「嘴耳」是目标，不是现状；当前语音前台仍有工具/记忆/任务/自主回答能力，只是被 prompt 压制 | 明确「现状 = 双权威、靠 prompt 压制；目标 = 语音 I/O 无执行权」；M1 用结构性移除 + 对抗测试验证；见 ADR-0002/0003 |
| C5 | **「M0 已冻结/已完成」vs 实际矛盾未清** | `assistant/archive/PRODUCT-DEFINITION-v3.0.md:26`「M0 定义与路线已冻结」、`:292`「M0 决策 ✅ 本文件冻结」；`research/archive/2026-10-21-v3.0/nisse-execution-plan.md:64`「M0 决策…本文（已）」 | 旧 M0 未做事实盘点、未修正 C1–C4、未设语音单权威门禁；「冻结」不成立 | 重新定义 M0 为「事实基线 + 架构裁决 + 文档修订 + 风险登记」；本文件即 M0 产物；旧稿归档 |
| C6 | **旧路线顺序：fork/build 先于语音单 Agent 验证** | `research/archive/2026-10-21-v3.0/nisse-execution-plan.md:16-24` 工作流 A 是 fork/merge/build；`:66-67` M1=发行底座、M2=一体化 spike；`research/archive/2026-10-21-v3.0/dsh-fork-decision.md:22` 先做 10 天 S1（R2-N） | 首个技术门槛是「语音 I/O + DSH 单权威闭环」，不是 fork/build；若语音不可拆，fork 白做 | 重排：M1 = DSH×Voice Spike；M2 = fork/build/upstream；见 ROADMAP |
| C7 | **记忆归属：DSH 域 vs 现有 Nisse 文件工作区（两套）** | `assistant/archive/PRODUCT-DEFINITION-v3.0.md:355` D5「Memory 归属 DSH 域：新建 dsh-memory 服务+provider」；`research/archive/2026-10-21-v3.0/nisse-platform-architecture.md:123-126`「新增 dsh-memory 模块 + MemoryEngine」；但 `dsh-nisse/plugin/lib/memory-workspace.js` 零 DSH 依赖、真实会话写到 `default-workspace`；DSH 无 `dsh-memory` 包 | 目标「单一记忆权威」未实现；现有实现是第二套记忆；且「新建通用 provider 平台」是过度设计 | 记忆权威 = Nisse 第一方 DSH Host Integration 内的文件后端（tools + prompt section），Nisse UI 只做控制；不建 provider 市场；见 ADR-0006 |
| C8 | **产品定位：独立产品 vs 插件** | `assistant/archive/PRODUCT-DEFINITION-v3.0.md:13`「一个 App…DSH 是内置大脑」；但 `dsh-nisse/README.md:1-7`「dsh-nisse 是 DeepSeek Harness 的 Host 插件，不是独立应用」「Nisse 桌面dsh-bot：参考语音壳/客户端，不是产品本体」 | 代码/README 仍以插件为产品本体；与最终产品意图冲突 | 插件 0.6 退役为迁移参考；最终运行时用 Nisse 自有壳 + 发行包内置 Host Integration；见 ADR-0001/0004 |
| C9 | **「一个 App/不污染 ~/.dsh」vs 实际安装/记忆路径** | `assistant/archive/PRODUCT-DEFINITION-v3.0.md:152/255`「不要求用户装 DSH…不写 ~/.dsh」；但 `review/evidence-runtime.md` §3/§5 实测：插件 symlink 进 `~/.dsh/profiles/desktop`、新增 `nisse-*` profile、记忆写入共享 `default-workspace` | 反向证据；当前实现不满足产品承诺 | M3 重做隔离（独立 DSH_HOME + 应用数据根）；M4 迁移记忆并验证删除/召回 |
| C10 | **旧估算被当作可靠预算** | `research/archive/2026-10-21-v3.0/dsh-fork-decision.md:21` 8–14 人周、`:83-84` 16–28 / 21–36 / 50–100、`:115` 10–18 一次性 + 16–34/年 | 旧口径只覆盖 fork/接入，不含语音单 Agent 化、记忆迁移、安全、发行、真机测试；且基于未验证的 R2-N/R2-O 假设 | 不得作为 1.0 预算；本文件与 ROADMAP 重新给区间/假设/置信度 |
| C11 | **「取消后越权动作 0 / 敏感画面 100% / 审计 100%」被写成指标** | `assistant/archive/PRODUCT-DEFINITION-v3.0.md:315`「取消后越权动作 0」；`:325`「审计覆盖率 100%、敏感画面拦截率 100%」；`:313`「p50<2s/p95<2.5s」 | 无测试方法/覆盖范围；旧实测简单问答 4–6s、工具任务 10–15s（nisse-gaps N11） | 改为「目标 + 可验证方法 + 基线后再冻结阈值」；禁止 0/100% 承诺 |
| C12 | **「五层架构 L3 不依赖 L0/L1」vs 实际产品层直接消费 DSH/文件** | `research/archive/2026-10-21-v3.0/nisse-platform-architecture.md:47`「L3 只依赖 L2 接口，不 import L0/L1」；但现状 Nisse 客户端直接读插件 HTTP、直接依赖 DSH 语义；文档自身又把 Memory 放 L3 | 抽象未落地，反而掩盖真实耦合 | 删除五层教条；按「DSH 域 / Nisse 产品层 / Shell / Voice / 发布工程」划分责任；接口按真实进程边界定义 |
| C13 | **OpenElement「重写桌面端+Web端+桌宠」vs「不阻塞核心」** | `research/archive/2026-10-21-v3.0/nisse-platform-architecture.md:202`「L4 Client 全部可换 OE」；`research/archive/2026-10-21-v3.0/nisse-execution-plan.md:46-52` OE 并行 4–8 周 | OE alpha；当前无 Product API 消费者；重写桌宠原生窗不可行（Electron 原生职责） | OE 只在 M9 做一页 spike；桌宠/气泡窗口不交给 OE；见 ADR-0010 |
| C14 | **「七门禁全 PASS / M2 MVP 已交付」vs 原始证据** | `m1a/gate-report.md:17` 称「任何时刻 activeClients=1」；`m1a/m2-report.md:5` 称「M2 MVP 已交付」 | G6 原始日志 `FAIL single-client invariant`；M2 自认 TCC 未验证、unsigned、插件未随包；`spctl rejected` | 报告口径降级为「协议/基座 GO；真机验收另立门禁」；本文件 §2 已修正 |
| C15 | **dsh-fork-decision 的路线对比与「已选 R2-O」并存** | 同上 C3；另 `research/archive/2026-10-21-v3.0/nisse-gaps.md:167`「表态：选 R2」、`:170-172` 条件式建议 | 工程 LLM 会按 R2-N 实施 | 统一为「受控上游跟踪型发行 fork」方向；R2-N 仅作为降级备选写入 ADR-0005 |

---

## 4. 资产与差距矩阵

> 目标归属：**DSH** = DSH 内核/发行层；**Host Integration** = 随 Nisse 分发、运行在 DSH Host 内的第一方扩展；**Nisse 产品层** = 产品状态/审批 UX/记忆 UX/人格 UI；**Shell** = Electron 原生职责；**Voice** = 语音 I/O 子系统；**Release** = 构建/签名/更新/回滚。
> 迁移方式：KEEP=保留；ADAPT=改造后迁移；REWRITE=重写；RETIRE=退役；MIGRATE=数据迁移。

| # | 功能/资产 | 当前位置 | 证据 | 状态 | 可复用度 | 目标归属 | 迁移方式 | 主要风险 | 验收测试 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 透明置顶桌宠窗、拖拽、点击/穿透 | `research/qwen-audio-agent/desktop/src/main.mjs`、`orb-*.mjs` | 真机 `desktop-fork-windows.txt` layer=3 172×204；本机 2.3.1 运行 | 已实现 | 高 | Shell | KEEP/ADAPT（并入 Nisse 自有壳） | Electron 版本/多显示器；与 DSH runtime 版本共存 | 窗口几何、点击穿透、跨 Space、多显示器、拖拽不误触 |
| 2 | 头顶气泡独立窗 | `desktop/src/bubble-window.mjs` 等 6 文件 | 单测 26/26；合成截图；无真机几何日志 | 已实现（真机仅演示） | 高 | Shell | KEEP | 跟随/边界/多显示器；报告声称的 geometry 证据缺失 | CDP 250ms 采样窗口 bounds + 截图；拖动/边缘/多显示器 |
| 3 | 托盘/菜单栏/设置页/热键/i18n | `desktop/src/main.mjs`、`settings-store`、i18n | 截图 + 基座实测 | 已实现 | 高 | Shell | KEEP | macOS 权限/菜单栏空间；Windows 另做 | 托盘菜单、设置持久化、热键冲突、权限引导 |
| 4 | 实时语音链路（DashScope realtime、全双工、打断、音色） | `research/qwen-audio-agent/server/src/voice/**` | 真实网关日志/连接；VAD 偶发；单测 22/22 | 已实现 | 高 | Voice | ADAPT（去 Agent 化） | 双 Agent 残留；DashScope 条款/成本；回声/打断质量 | M1 十项测试 + 延迟/打断/回声指标 |
| 5 | 唤醒词（sherpa-onnx 本地 KWS） | `desktop/src/wake-word/**`；33MB 模型 | `wake_word.ready`；合成音频 4/4；1 例误唤醒 | 已实现 | 高 | Voice | KEEP | 真人误唤醒率；模型下载/体积；中英文限制 | 真人样本集误唤醒/漏唤醒；模型校验/离线可用 |
| 6 | 停止短语/打断/取消（stop-phrase、bridge cancel） | `server/src/voice/stop-phrase.mjs`、`nisse-bridge-turn.mjs` | G4 PASS；s8b 日志；22/22 单测 | 已实现 | 中高 | Nisse 产品层 + Voice + DSH | ADAPT | 停止播报 vs 取消语义；点dsh-bot只停音频；取消竞态 | 停止播报任务继续；取消后无新动作；迟到事件不播 |
| 7 | `dsh-nisse` 插件桥（loopback HTTP+SSE、token、turnId、审批、always-allow） | `dsh-nisse/plugin/lib/index.js`（1637 行） | 真机已加载；8 审批；单测/探针；G6 失败 | 已实现（原型） | 高（逻辑）/低（形态） | Host Integration + 产品层 | ADAPT（拆分为第一方 Host Integration，非用户插件） | rc API 漂移；手搓 message；无沙箱；symlink/版本不一致 | 契约测试、版本握手、崩溃恢复、审批绑定 |
| 8 | 语音回合桥（turnId、单飞、generation、SSE 去重） | `server/src/voice/nisse-bridge-turn.mjs`、`nisse-bridge-client.mjs` | 单测 10/10；真实 duplicate-skip 11 次 | 已实现 | 中高 | Voice ↔ 产品层 | ADAPT（改为 voiceTurnId ↔ DSH turn 映射） | 第二套任务状态；重复 final 仍出现；迟到事件 | 并发/迟到/重复 turn 测试；一次输入一个 turn |
| 9 | 记忆工作区（USER/MEMORY/WORKLOG/PROJECTS） | `dsh-nisse/plugin/lib/memory-workspace.js`；`~/Documents/Nisse`；`default-workspace` | 文件已 seed；WORKLOG 真实；MEMORY 模板；隔离失败 | 部分 | 中高（文件内核） | Host Integration（DSH 域） | MIGRATE + ADAPT | 两套数据；用户修改被覆盖；删除/召回未验证 | schema/迁移/冲突/删除/导出/密钥过滤测试 |
| 10 | 人格注入 | 插件 `systemPrompt.section`（order 120/130）+ `config/frontend-agent/ASSISTANT.md` | 代码；无「人格一致」测试 | 部分 | 中 | DSH preset/persona + 产品 UI | REWRITE（单一来源） | prompt section 冲突；前台/后台人格漂移 | 人格一致性测试；修改后下一轮生效；历史不污染 |
| 11 | DSH 会话/任务/工具/审批/取消 | DSH 0.2.1-rc.2 | `review/evidence-dsh.md` §3 | 已实现（上游） | 最高 | DSH | KEEP | rc API 不稳；外部通道能力不足；审批无 always-allow | 契约测试；版本钉死；升级回归 |
| 12 | 独立 DSH_HOME/profile 预演 | S3/S6 harness、`~/.dsh/profiles/nisse-*` | S6 ISO PASS；生产路径未隔离 | 部分 | 中 | Shell/Release | REWRITE（产品级隔离） | 污染 ~/.dsh；凭据/会话串；迁移 | 启动后 `~/.dsh` 零写入；独立凭据/会话；卸载清理 |
| 13 | DMG 构建/打包 | `desktop-fork/build.sh`、electron-builder | 六版可挂载；adhoc；构建日志缺失；2.0.1 哈希 7 值 | 部分 | 中 | Release | REWRITE（可复现 + 签名） | 不可分发；无 CI；构建非幂等 | 干净环境构建、产物 sha 清单、签名/公证、安装 |
| 14 | 安装/回滚脚本 | `dsh-nisse/install/*.sh` | 备份+plugin add+改 package.json；实机为 symlink | 原型 | 低 | Release | RETIRE/REWRITE | 依赖用户 DSH；无事务；污染 profile | 安装/卸载/回滚演练；无残留；不写 ~/.dsh |
| 15 | 回归/探针工具 | `spike/tools/*`、`m1a/tools/nisse-s6/s7`、`m1a/evidence` | 本次复跑 3 组单测 PASS | 已实现 | 高 | Test/SRE | KEEP/ADAPT | 依赖本地端口/Key；未 CI 化 | CI 化；契约/回归门禁；证据归档规范 |
| 16 | 产品/架构/研究报告 | `assistant/`、`research/`、`m1a/` | 本文件 §3；报告口径夸大 | 部分 | 中 | 文档 | REWRITE/归档 | 自相矛盾；旧估算误导；夸大结论 | 文档一致性扫描；M0 退出标准 |
| 17 | Qwen fork patch + UPSTREAM | `desktop-fork/patches/0001-nisse-mvp.patch`（74 文件/+27036/−180）；`build.sh` | patch apply check 通过；构建树干净 | 已实现 | 高 | Release | KEEP/ADAPT | 未 commit/tag；工作树与 patch 一致性仅间接；上游停更 | patch 可复现应用；与工作树逐字节一致；license/NOTICE |
| 18 | 品牌/皮肤 | `research/skins/whale-girl-test`、内置 skin | 2.3.1 实机；MIT 署名 | 原型 | 中 | Nisse 产品层 | KEEP | 占位美术；品牌/商标；最终素材版权 | 资产来源清单；NOTICE；视觉验收 |
| 19 | OpenElement | 本机 `~/Documents/projects/openelement`（独立项目） | 未在本项目集成 | 未开始 | 未知 | 可选 Client | DEFER | alpha；构建链；与 Electron 兼容 | M9 一页 spike Go/No-Go |
| 20 | TCC/系统权限 | 六版 Info.plist 有麦克风文案 | 无打包版真人授权日志；TCC.db 不可读 | 未验证 | 中 | Shell | REWRITE/验证 | 子进程归因；辅助功能/屏幕录制；权限撤销 | M1 TCC 实测；权限拒绝/撤销恢复 |
| 21 | 审批安全控制（风险分级/always-allow/审计/急停） | 插件 approval + 产品层策略 | 单轮审批可用；always-allow 弱；并发/审计/急停缺失 | 部分 | 中 | 产品层 + DSH 执行门 | ADAPT/REWRITE | 语音误批；作用域/过期；审计缺失；L3 无策略 | M4 安全测试矩阵；审批绑定/过期/撤销；急停 |
| 22 | 更新/回滚/签名/公证 | `main.mjs:1640` updater disabled；无证书 | `spctl rejected` | 缺失 | 低 | Release | NEW | 证书等待；更新完整性；回滚；卸载数据策略 | M6 干净机安装/升级失败回滚/卸载；公证 |
| 23 | 测试/CI/契约 | 零散单测/探针；无 CI | 3 组单测复跑 PASS；无仓库级 CI | 缺失 | 低 | Test/SRE | NEW | 无基线；环境依赖；误报 | CI 跑 DSH 测试 + Nisse 契约/回归；门禁 |
| 24 | 产品 UI（renderer/仪表/任务历史/记忆管理） | 现有 React/sprite（Qwen fork） | 设置页截图；任务卡有原型 | 部分 | 中 | Nisse 产品层 | ADAPT | 与 Shell/契约耦合；可访问性；OE 不确定 | M5 用户测试；状态可辨识；首启向导 |
| 25 | 统一 turn/task/approval/event 契约 | 无 | 插件用客户端字符串 turnId；DSH turn 为整数 | 缺失 | — | Nisse 产品层 + Host Integration | NEW | 串轮/重复/迟到；ID 权威不清 | 契约测试；并发/重复/重放；M1 十项 |

---

## 5. 当前阶段判断（不沿用文档标签）

**判定：内部可运行原型（Prototype / 内部 Alpha），Pre-MVP，且 M0 纠偏尚未完成。**

依据：

1. 已有真实可运行能力：透明置顶桌宠、独立气泡、托盘/设置、真实 DashScope 语音、唤醒词、打断、停止短语、DSH 会话桥、单轮审批、记忆工作区文件、六版可挂载 DMG。
2. 但产品形态不成立：用户需已装 DSH，插件 symlink 改 `~/.dsh`，必须重启 DSH，"一个 App/一个安装包/不污染"均不成立。
3. 单一 Agent 权威不成立：语音前台仍是完整 Agent（工具/记忆/任务/自主回答），只靠 prompt 压制；重复播报根因就在双管线。
4. 产品级运行时不存在：没有自有 Supervisor、独立 DSH_HOME 产品路径、版本握手、崩溃恢复、安装器、签名/公证/更新。
5. 证据质量不足：G6 不通过、G3/G2 部分、TCC 无证据、审批串轮无测试、哈希漂移、构建日志缺失。
6. 文档不能指导实施：五引擎/双结论/旧估算/「M0 已冻结」等矛盾未清。

因此：
- **不是 M1 完成**（旧 M1a 是「语音壳 + ACP/插件桥」可行性验证，不是新定义的「DSH 单权威语音闭环」）。
- **不是 MVP**（旧 M2「MVP 已交付」口径夸大；MVP 定义见 ROADMAP M4）。
- **不是发布阶段**（无签名/公证/更新/门禁）。
- **M0 必须先把事实、裁决、文档修订、风险登记完成**，再批准 M1。

---

## 6. M0 退出前必须补的证据 / 动作

1. 旧文档修订（本包已执行，见 README-FOR-REVIEW.md 的变更清单）：五引擎、双结论、旧估算、M0 冻结、插件本体表述全部清除。
2. 单一权威裁决写入 ADR-0001/0002/0003，并在 README/ PRODUCT-DEFINITION/architecture 中一致引用。
3. 资产矩阵（本文件 §4）与风险登记册、追溯矩阵建立。
4. M1 Spike 规格通过评审（含 10 项测试、失败判据、回退路线）。
5. 文档一致性扫描通过：全仓 grep 不得再出现「五个同级引擎」「AgentEngine 可替换」「QwenAudio 是第二 Agent（作为目标）」「不修改 DSH 核心（绝对）」「M0 已冻结」「7 门禁全 PASS」等表述（历史档案除外）。
6. 明确「需要用户决策」的 6 项（见 §7）并在批准 M1 时一并回答。

---

## 7. 需要用户决策的事项（尽量少，已给首选）

| # | 问题 | 首选 | 备选/代价 |
|---|---|---|---|
| D1 | 最终运行时是否允许随安装包内置 **Nisse Host Integration**（第一方 DSH 扩展，用户不可安装/替换，随 runtime 锁定）？ | **允许**（否则拿不到同会话 + token 级 + 审批接管；见 evidence-dsh §4.4） | 不允许 → 只能用 ACP/SDK（丢 token 级或审批）或窄范围 core patch（增加 fork 维护） |
| D2 | M1 语音路线首选？ | **C（保留 Qwen realtime 但结构性移除执行权）验证最快；A（Qwen 纯语音 I/O + 确定性 TTS）作为目标形态；B 仅降级；D 为 C/A 失败备选** | 直接做 A/D 更干净但周期长；直接做 B 不满足实时体验 |
| D3 | M2 前能否提供/授权获取 **DSH 上游仓库**（clone 权限或已 clone 的源码树）？ | 需要；否则 M2/M5 无法成立 | 无仓库 → 只能 pin npm runtime，放弃源码 fork/核心修改，重评路线 |
| D4 | 是否有 Apple Developer 账号/证书，用于签名与公证？ | 若有，M6 可并行；若无，先做 ad-hoc 内部包，1.0 前必须解决 | 无证书 → 无法对外发布，只能内部测试 |
| D5 | 1.0 商业模式是否维持 **BYOK-first**（不做订阅/语音转售）？ | 是（显著降低合规/后端/条款风险） | 订阅/中继 → 增加 Nisse Cloud、计费、条款与隐私工作，M6 之后另立项 |
| D6 | M1 是否允许使用真实模型/语音 API 产生少量费用与真实麦克风测试？ | 是（否则无法验证核心体验） | 不允许 → M1 只能做协议/假音频验证，不能宣布通过 |

---

## 8. 关联

- 架构裁决：`ADR/ADR-0001`…`ADR-0010`
- 路线图：`ROADMAP-M0-TO-1.0.md`
- Spike 规格：`SPIKE-DSH-VOICE-INTEGRATION.md`
- 风险：`RISK-REGISTER.md`；追溯：`TRACEABILITY-MATRIX.md`
- 证据：`review/evidence-dsh.md`、`review/evidence-runtime.md`（补充证据文件如存在则一并引用）
