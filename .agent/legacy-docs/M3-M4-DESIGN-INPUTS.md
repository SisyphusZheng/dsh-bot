# M3/M4 设计输入：来自 M1 Spike 的性能、语音架构与安全结论

> 状态：M1 产出（2026-10-21）｜输入给 M3（一体化 Runtime/Shell/Contract）与 M4（MVP 主路径/人格/记忆/安全）
> 依据：`spike/dsh-voice/evidence/`（W0–W3 报告、OPT-DIAGNOSIS、W4-COMPARISON、W4-ROUTE-D-OPTIONS、PRODUCT-BACKLOG-M4-M5）
> 原则：DSH 是唯一 Agent；Voice Runtime 只做音频 I/O 与呈现；所有优化不得引入第二套任务状态。

## 1. 性能优化清单（M4 必须落地，M3 提供机制）

| # | 优化项 | 具体要求 | 建议落点 | 依据 |
|---|---|---|---|---|
| P1 | **语音会话生命周期** | 专用会话上限：≤20 turn 或 ≤50k token；超限自动压缩/摘要或换新专用会话；不得无限累积 | Host Integration + 产品层会话管理 | 安装版 105 turn/4.7MB 历史，TTFT 10–58s；新会话 2–7s（OPT-DIAGNOSIS） |
| P2 | **Voice 最小 agent preset** | 语音会话只保留主路径工具（工作区读写、按需搜索），关闭 subagent/workflow/skill/todo/goal 等；工具 schema 27→≤8 | 发行 profile + agentPreset | 27 工具/16.7KB schema 每请求重放 |
| P3 | **reasoningEffort 策略** | 默认低/中（如 provider 默认或 low）；仅任务复杂时升档；语音快问快答不得默认 max | 产品设置 + agentOptions | desktop 默认 max 拉长首 token |
| P4 | **实验插件裁剪** | 发行 profile 关闭 CoT 翻译等 experimental 插件，或完全异步、可配置关闭 | 发行层 profile | 历史 325 次 translator 请求 |
| P5 | **工具结果裁剪** | 启用 compaction/tool-result-pruner；语音会话限制单工具输出大小 | DSH compaction 配置 | 381 次 tool call 累积 |
| P6 | **语音回答长度预算** | 先结论、超长询问是否继续；默认单轮播报 ≤20–30s；分段播报 | 产品层 prompt + TTS 队列 | W2 首轮播报 ~55s |
| P7 | **Provider 健康与重试** | 429/503 快速失败/切路由；重试预算与退避；保持 prompt 前缀稳定提高 cache 命中 | Voice Runtime / LLM 路由 | 安装版 turn 62 503；历史 31 次 429 |
| P8 | **标题/摘要异步化** | 语音会话不阻塞生成 LLM session title（或关闭/异步） | Host Integration/profile | 19 次 title-llm-request |
| P9 | **基线指标与回归门禁** | M4 建立首响分项（确认音/首 token/首可听句/完成）p50/p95 看板；相对 2.3.1 不得退化 | 测试/CI | W2/W4 指标框架 |

## 2. 语音架构结论（输入 M3）

1. **DSH 不能替代 Voice Runtime**：DSH 无麦克风/VAD/唤醒/流式 ASR/TTS/播放/打断/回声；实验 STT 仅批量 WAV、无 TTS。Voice Runtime 必须保留（qwen-audio-agent 剥离前台 agent 或 Route D 薄运行时）。
2. **推荐形态**：Voice Runtime 子进程（无 session/task/工具执行权）+ Host Integration（bridge/turn/事件/审批/取消）+ 产品层状态机 + Electron Shell（TCC/设备/窗口）。
3. **路线 C 硬约束保留**：前端工具定义/执行双重 allowlist、动态工具源禁用、memory provider 关闭、桥不可用 fail-closed、route C 配置违规拒绝启动（W3 已实现，M3 合并）。
4. **TCC 归因**：麦克风由宿主 Nisse.app（签名包）申请，Voice/DSH 子进程不单独持有；M3/M6 用签名包复测（dev Electron 授权不迁移）。
5. **Route D 备选**：若需摆脱 qwen-audio-agent，采用「sherpa-onnx 流式 ASR/KWS/VAD + 薄协调层 + TTS」PoC（W4-ROUTE-D-OPTIONS.md 方案 C），但设备/TCC/回声/打断状态机仍需自建，风险高；M3 先复用 qwen-audio-agent 音频层。

## 3. 安全/控制面输入（M4）

- 审批：DSH `ctx.approval` 一次性裁决；产品层必须实现 always-allow 的 tool+scope+TTL 与撤销（S3），语音误批防护（S2：普通语句不得批准）；
- 停止/打断/取消三态分离（S1）：停止播报不得取消任务；取消必须到达 DSH 且取消后无新工具动作；急停需要独立入口；
- 路径负例（S4）：`..`/symlink/工作区外写入必须被拒绝并明确原因；
- 迟到审批/迟到 delta（S5）：取消后到达的审批/增量一律丢弃，不重复播报；
- 日志/凭据（S7）：日志无 Key/token/审批原文；记忆无密钥。

## 4. UX 输入（M4/M5）

- 气泡问题清单：`PRODUCT-BACKLOG-M4-M5.md` UI-B1…B8（阴影/尖角/点击/actions 协议/皮肤 offset/headroom/回归）；
- 语音交互：进度确认语 + 流式 TTS（W2/W3 已验证）；打断语义按 S1 修正；回答长度按 P6；
- 双应用共存：避免与用户已装 DSH/Nisse 争抢全局快捷键/麦克风（M3 单实例与 TCC 边界）。

## 5. 未验证项 / 待 M3 决策

1. Route A vs C 的真机听感对比（需 10–15 分钟麦克风测试）；
2. Route B（DSH 批量 STT + 外部 TTS）数据与成本；
3. 语音审批（允许/拒绝）端到端；
4. 播报中打断 ≤500ms 实测；
5. TCC 在签名包下的授权/撤销行为。

## 6. 证据索引

- `spike/dsh-voice/evidence/W2-REPORT.md`（语音闭环/TCC/问题）
- `spike/dsh-voice/evidence/W3-REPORT.md`（route C 守卫/T11–T14/取消）
- `spike/dsh-voice/evidence/OPT-DIAGNOSIS.md`（安装版慢的根因与优化清单）
- `spike/dsh-voice/evidence/W4-COMPARISON.md`、`W4-PLAN.md`、`W4-ROUTE-D-OPTIONS.md`
- `PRODUCT-BACKLOG-M4-M5.md`（气泡/交互待办）


## 7. Voice Runtime 复用策略（qwen-audio-agent fork，M3 设计输入）

**事实核查（本机仓库）**：
- `qwen-audio-agent` 本体 **Apache-2.0**（`LICENSE`/`NOTICE`/`THIRD_PARTY_NOTICES.md`）；
- Nisse 已有 fork 说明 `NISSE-NOTICE.md`：品牌替换、dsh-bot皮肤、默认配置等修改；
- dsh-bot素材为 **MIT**（vlln/whale-girl，Sam Gao）；唤醒词拼音数据 pypinyin **MIT**；
- DashScope Realtime 是**云服务**，不随 Apache-2.0 授权，需单独遵守服务条款；
- 结论：**可以 vendor/fork、剔除不需要的部分自用**，但必须保留许可/NOTICE 并声明修改。

**建议保留（Voice Runtime 核心，约占现有代码的音频 I/O 面）**：
1. 设备/麦克风/TCC/播放（Electron 壳内音频路径）；
2. 唤醒词：sherpa-onnx KWS + 唤醒词短语转换；
3. Realtime provider 适配层（DashScope ASR/TTS、连接/重连/音频帧）；
4. 音频播放/打断/回声处理相关运行时；
5. 健康检查、日志、最小配置/凭据边界；
6. 与 Host Integration 的本地 IPC/协议客户端（由 Nisse 定义，不沿用其业务 gateway）。

**建议剔除/替换（避免第二 Agent 与产品无关面）**：
1. 前台模型 Agent：系统提示、工具注册/执行、记忆、任务队列、审批代答逻辑（改由 DSH/Host Integration 承担）；
2. ACP/OpenCode/OpenClaw/Codex/Claude 等后台适配器与安装器；
3. 产品品牌/更新/市场/遥测/多平台（mobile/webui/tui）等与 M3 无关模块；
4. 语音命令/人格/配置中心等业务逻辑（移到产品层或 Host Integration）；
5. 我们不需要的示例、演示、docs 站点与发布脚本。

> **注意：上表的“剔除”是能力迁移，不是删除功能。** 语音命令/人格/配置这些能力我们都需要，
> 只是不应继续长在 Voice Runtime 里：
>
> | 能力 | 旧实现位置（qwen-audio-agent 前台） | 新归属（M3/M4） |
> |---|---|---|
> | 停止/取消/打断/急停 | `nisse-bridge-turn` 里处理 | Voice Runtime 只做检测（VAD/stop 短语/按键）；**动作**由产品层/Host Integration 执行 |
> | 产品配置命令（模型/工作区/会话/人格） | 前台语音命令 + 本地配置文件 | Host Integration / 产品层：转成 DSH config / 产品设置；语音确认用 TTS 播报 |
> | 任务类指令（打开浏览器/文件/搜索） | 前台工具或 ACP | DSH agent + tools（唯一执行权威） |
> | 人格/语气/记忆 | 前台 persona 配置 + 插件 | Host Integration（system prompt section）+ 产品设置 UI；Voice Runtime 只管 TTS 音色参数 |
> | 配置中心/设置 UI | gateway 内嵌 | 产品层 Electron 设置页 |
>
> M3 可以先在裁剪后的 fork 里保留一个薄 `product-command-adapter` 过渡，接口按 Product Contract 定义，
> M4 再迁到 Host Integration/产品层；**能力不做减法，只做归属调整**。

**边界设计**：
- Voice Runtime 作为**独立子进程**（M3 工作包 3），只持有音频设备与音频管线；
- 不持有 session/turn/task/工具执行权；与 DSH 的唯一通道是 Host Integration 的本地 IPC；
- 产品层负责状态机（listening/thinking/speaking/error）、审批/停止/取消的用户交互。

**许可与维护动作（M3/M6 必做）**：
- 保留 `LICENSE`、`NOTICE`、`NISSE-NOTICE.md`、`THIRD_PARTY_NOTICES.md`，在 NISSE-NOTICE 中列明删除/修改范围；
- 不使用会让用户误以为官方 Qwen 产品的品牌/商标标识；
- fork 采用 pinned upstream + patch queue（与 M2 DSH fork 同一纪律），记录 upstream commit 与 delta；
- 发布前核对 DashScope/语音模型服务条款与再分发限制；
- 对剔除后的代码做 SBOM 与许可证扫描（M6）。

**备选**：若未来要完全摆脱该 fork，走 Route D（sherpa-onnx 流式 ASR/KWS/VAD + 薄协调层 + TTS，见
`spike/dsh-voice/evidence/W4-ROUTE-D-OPTIONS.md` 方案 C），但设备/TCC/回声/打断需自建，M3 仍建议先复用。


## 8. 响应速度与单权威兼顾：分层响应（M3 设计输入）

目标：在不引入第二 Agent、不重开前台内容生成的前提下，把“感知响应”拉到接近实时语音产品：

| 层 | 职责 | 归属 | 延时目标（p50/p95） |
|---|---|---|---|
| **L0 反射层** | 唤醒确认、确认音、固定确认语（“好，我看看”）、停止播报、音量/静音 | Voice Runtime 本地（无 LLM） | 确认音 ≤300ms；停止 ≤500ms |
| **L1 快车道** | 低风险社交/状态查询/简短对话：独立 DSH 会话，最小上下文+最少工具+低 effort，预热点火 | DSH（仍是唯一 Agent） | 首段可听 ≤1.5s / ≤2.5s |
| **L2 任务车道** | 任务/工具/审批/长回答：正常 DSH 会话，进度事件 + 流式 TTS | DSH | 首段可听 ≤3s（含 filler），最终按任务 |

关键原则：
- **L1/L2 都是 DSH 会话**，只是预设不同（context/tools/effort 不同）→ 单权威不破；
- 路由由产品层按意图白名单决定（规则词表/轻量分类器），**不让实时模型决定内容**；
- L1 只允许：问候、状态查询、人格查询、简单确认、闲聊模板；**禁止事实性/任务性/工具性回答**，越界转 L2；
- 配置/人格等命令走 Product Contract（`M3-PRODUCT-CONTRACT-VOICE.md`），由 Host Integration 执行，不经过 L1；
- 预热：保持 L1 会话与 provider 连接温热、prompt 前缀稳定（cache 友好）、ASR endpoint ≤300–500ms、句级流式 TTS；
- 一致性：L1→L2 交棒时带摘要/最近上下文，避免“两个脑子”；配置/人格只有一份权威。

预期收益：保留单权威/工具/审批/长任务优势，同时把“打招呼、问一句、停止”等高频交互压到亚秒–1.5 秒级；
代价：多一个信使会话（成本/复杂度）、需要意图路由与越界转交测试。

## 9. Voice Runtime 打包形态：独立子进程 vs DSH 插件（可行性结论）

**结论：不要把音频管线做成 DSH 进程内插件；Voice Runtime 保持独立子进程。**

原因：
1. **音频 API 与 TCC**：DSH host 是 Electron-as-node，没有 Web Audio / renderer 音频 API；麦克风/播放需要宿主 App（Nisse.app）身份与 TCC，进程内插件拿不到干净归属；
2. **崩溃隔离**：音频/设备/回声代码崩溃不应带崩 DSH agent；子进程可重启（M3 工作包 3）；
3. **生命周期**：设备独占、休眠/唤醒、更新时 Voice 与 DSH 独立启停更安全；
4. **上游边界**：DSH 只提供 agent/session/事件/审批接缝，不提供音频/设备/TTS seam；把音频塞进插件等于在 DSH 内自建一套无契约能力；
5. **产品契约**：Voice Runtime 只做音频 I/O 与检测，Host Integration 在 DSH 内做映射，产品层做状态机——边界清晰。

可行的“插件化”部分：
- **Host Integration 插件**（DSH 内）：bridge/turn/事件/审批/取消映射、config/persona 服务（M3 继续）；
- **Voice Runtime 作为独立子进程**，由 Electron Shell 监督（M3），通过本地 IPC 与 Host Integration/产品层通信；
- 可选：DSH 插件只做“Voice Runtime supervisor/IPC 代理”，不加载音频库本身。

因此“把 qwenaudio 拆了做成 DSH 插件”只有 **桥接/监督层** 可行；**音频运行时本体仍应是独立进程**。

## 10. Product Contract（语音命令/配置/人格）

见 [M3-PRODUCT-CONTRACT-VOICE.md](M3-PRODUCT-CONTRACT-VOICE.md)（命令词、事件、归属、迁移步骤、验收）。


## 11. “Main Bot + Sub Sessions” 方案评估（用户 2026-10-21 提议）

用户提议：在 DSH 之上固定一个长期存在的“Bot”（共享 DSH 长期 memory、参考 qwen-audio 的人格化/记忆化、
固定 Bot 工作区、自己默认思考强度且可选），作为中间层负责快速反应、调用 skill、汇总 session、接管具体 session；
Bot 与具体 DSH session 的关系是 main/sub。

**结论：方向正确，但必须落成“DSH 内的 main session + subagent/任务 session”，不能是 DSH 外的第二个模型 Agent。**

### 好的点
1. 与分层响应（L0/L1/L2）天然吻合：Main Bot ≈ L1 快车道，Sub sessions ≈ L2 任务车道；
2. 人格/记忆/工作区/effort 有单一归属；长期 memory 可跨 session 复用（避免每个 task session 重新灌输）；
3. 快速反应与重任务解耦：main 保持小上下文/低 effort，重任务下放 sub，主上下文不被工具结果污染；
4. skill 与 session 汇总集中到 main，产品体验连续（“刚才那件事怎么样了”）；
5. DSH 原生有 subagent 机制（`dsh-subagent`，父/子会话、血缘、结果回传），不必自造会话层级；
6. 接管具体 session = resume/attach，DSH 已支持，可做“主 Bot 代管”。

### 风险/代价
1. **第二 Agent 风险**：如果 Main Bot 是 DSH 之外的独立模型进程，会重新引入双权威；必须是 **DSH 内的 main session/agent**；
2. **长期 memory 的并发写**：DSH 无 memory 服务；文件式记忆（USER/MEMORY/WORKLOG/PROJECTS）需要唯一写者/锁/版本，
   否则 main/sub 并发写会冲突（ADR-0006 已要求记忆权威归 Host Integration）；
3. **main 上下文增长**：main 若什么都接，会重复安装版慢的问题；必须设会话上限/压缩/只读摘要；
4. **session 接管冲突**：同一 session 不能双写；接管前必须确保原会话 idle，使用单写者锁；
5. **子会话结果合并**：subagent 结果需要摘要/校验，避免 main “转述失真”；
6. **成本**：两个以上会话并行/预热会提高 token 与内存；
7. **测试复杂度**：会话层级、记忆一致性、接管/取消/审批跨会话的合同测试显著增加。

### 建议的落地形态（M3）
- **Main Bot**：固定 DSH 专用会话（小上下文、默认低/中 effort、可配置），承载人格/记忆读取、快速对话、skill 路由、session 汇总；
- **Sub sessions**：通过 DSH subagent（或任务会话）执行具体任务；父/子血缘与结果回传用 DSH 事件；
- **长期 memory**：Host Integration 统一存储（文件 + system prompt section），main 读写、sub 只读注入；写操作单写者+审计；
- **路由**：产品层/主会话按意图选择 main 快速回答 vs 下放 sub；L0 本地反射处理停止/确认；
- **接管**：显式 resume + 单写者锁；禁止同一 session 并发写；
- **effort**：main 默认可配置，sub 可按任务覆盖（DSH agentOptions 已支持）。
- **验收**：单权威（T11–T14 仍 0 越权）、主/子结果一致、记忆无丢写、接管不双写、快速响应 p50 达标。

### 待决
1. Main Bot 用独立 session 还是 DSH 的 “root agent”；2. subagent tool 与显式任务会话的取舍；
3. memory schema/写锁实现（Host Integration）；4. 主/子会话恢复与迁移策略；5. 与 Route C/A 前台音频层的关系（Voice Runtime 仍只做 I/O）。


## 12. 长期记忆设计（M3 输入；回应用户“文本是不是落后了”）

**结论：纯文本文件作为唯一长期记忆确实不够，但文本仍应保留为“人类可读/可导出层”；建议 Host Integration 侧采用“三层混合存储 + 检索注入”。**

### 12.1 为什么纯文本不够
- 文本（USER.md/MEMORY.md/WORKLOG.md/PROJECTS.md）优点：可读、可编辑、可移植、可审计；
- 不足：条目多时无高效检索、无冲突/置信度/衰减、无 provenance、易重复/矛盾、token 注入要么全量要么漏；
- qwen-audio 的文本记忆适合小规模人格/偏好，不适合“长期、跨 session、任务型”记忆。

### 12.2 推荐结构（Host Integration 记忆服务，单一权威）
1. **Episodic（事件/会话记忆）**：turn/session 摘要、时间、参与实体、来源 session/turn；append-only；可回链原始 session；
2. **Semantic（事实/偏好/实体）**：结构化条目（kind: fact/preference/entity/skill/relationship），字段：
   `id, kind, text, entities, confidence, source, created_at, updated_at, last_used_at, ttl/decay, status(active|superseded)`；
3. **Curated files（人类层）**：USER.md/MEMORY.md/WORKLOG.md/PROJECTS.md 作为**导出视图/人工编辑入口**，
   与 DB 双向同步（AI 写 DB，用户改文件时以文件优先并记录 diff）。

**索引与检索**：SQLite（FTS5 全文 + 可选 vector 扩展/sqlite-vec）或等价本地存储；
embedding 用本地模型（Apple Silicon 可用 MLX/ONNX，如 bge 系列）或按需 provider；
检索 = 关键词 + 向量混合，按 token 预算注入（system prompt 里的 memory digest ≤500–1000 tok + `memory_search` 工具按需取详情）。

**写入管线**（避免脏记忆）：
- 触发：turn/session 结束或显式“记住这个”；
- 抽取：LLM 产出候选（事实/偏好/待办/实体）→ 去重/合并/冲突检测 → 置信度 → 写入并带 provenance；
- 冲突：新条目与旧条目不静默覆盖；标记 superseded 或 ask user；
- 敏感：密钥/凭据永不入库；隐私字段可 TTL/加密；
- 审计：每次写/删/合并可追溯；用户可查看/编辑/删除/导出。

**读取与权限**：
- Main Bot（常驻 main session）：读 memory digest + `memory_search`；**默认唯一写者**；
- Sub sessions（任务会话）：默认**只读**注入/检索；需要写时走主会话或显式授权；
- DSH：session 内的上下文压缩（compaction）与长期记忆分离——前者服务单会话，后者服务跨会话。

### 12.3 与 Main Bot（常驻 main session）的关系
- Main Bot 是**常驻的 DSH main session/角色**（不是 DSH 外第二 Agent）：持有固定 persona/workspace/effort、memory digest；
- 任务下放 sub sessions；main 负责汇总/接管；接管前确保 idle + 单写者锁；
- Main 的上下文仍需压缩/摘要（否则重蹈安装版 105-turn 慢），但“身份/角色”长期存在，不靠换 session 实现。

### 12.4 分阶段
- M3：SQLite+文件导出 + memory digest + `memory_search/write` 工具 + 单写者；
- M4：抽取/合并/冲突/衰减管线、审批联动（“记住这个”确认）、sub 只读策略；
- M5：记忆 UI（查看/编辑/删除/导出）、召回质量与 token 成本回归。

### 12.5 验收/指标
- 召回：recall@k / precision（人工标注 50–100 条）；注入 token 成本；写延迟；
- 冲突/重复率；删除/导出可用性；无密钥入库；1k/10k 条规模下检索 p95。


## 13. 三层金字塔：Bot（顶层 main session）→ 会话 → 子会话/子代理

> **v3 冻结（2026-10-21）**：采用 Route A 逻辑编排；Bot 是常驻的顶层 main session/统一角色/逻辑协调层，
> **不修改 DSH 核心、不改变“每个 session 都是 root”的语义**；接口缺口 → 停止并报告，不得改核心。
> 契约见 [BOT-SESSION-ORCHESTRATION.md](BOT-SESSION-ORCHESTRATION.md)。

用户澄清：DSH 现状是“每个 session 各自是 main session、可再派 subagent”；期望在**所有 session 之上**再有一个
**Bot 作为顶层 main session**，形成三层金字塔：

```
第 3 层（顶层）  Bot：全局 main session（身份/人格/长期记忆/工作区/默认 effort；路由、汇总、接管）
第 2 层          DSH 会话：每个项目/任务一个 session（自己的 main，可派 subagent）
第 1 层          子会话/子代理：具体执行单元（DSH subagent / 任务会话）
```

**结论：理解正确，可行；但建议做成“编排层”而不是强改 DSH 的 session 父子关系。**

### 两种实现路线
| 路线 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A. 逻辑编排（推荐） | Bot 是一个常驻 DSH 会话，通过 Host Integration 的 **session 管理工具**（list/attach/resume/summarize/route/budget）管理其它 root sessions；三层是“协调关系”，不是硬父子 | 不改 DSH 核心；保留 session 一等公民语义；可渐进实现 | 需要 Host Integration 提供 session registry/attach 接口；预算/权限/取消需跨层契约 |
| B. 硬父子（Team/Session 树） | 让每个 session 成为 Bot 的子 agent（类似 Team Lead + teammates），Bot 直接 spawn/管理 worker sessions | 血缘/事件天然统一；DSH 已有 agent-team 实验能力可借鉴 | 会改变 session 语义（root→child）；独立会话/UI/持久化/审批/compaction 都被绑定到父会话；上游改动大 |

**用户已确认采用 A（逻辑编排）**。若未来要“Bot 直接创建/回收会话”，用 DSH agent-team/Team Lead 作为 B 的受控子集，而不是把全部历史 session 强行变成子节点。

### 必须定义的跨层契约
1. **身份/配置继承**：Bot 拥有全局 persona/memory/workspace/effort；session 可覆盖；subagent 继承 session；
2. **session registry**：id/标题/状态/工作区/最后活动/血缘；Bot 可 list/attach/resume；
3. **接管**：只能接管 idle session；单写者锁；接管后原 owner 退出；
4. **汇总**：Bot 读取 session 摘要（不是全量历史）；需要跨 session 记忆时走 memory 服务；
5. **预算/配额**：Bot/session/subagent 三层 token/费用预算与超限策略；
6. **审批/取消传播**：审批归属发起 session；取消/急停跨层可达；迟到结果按 turnId 丢弃；
7. **安全**：Bot 不能绕过审批/权限；记忆写入默认 Bot/Host Integration 单写者。

### 与现有能力的关系
- DSH 已有：session、subagent（父/子）、agent-team（lead/teammates）、session resume；
- 因此金字塔**不需要 DSH 核心改动**即可用“Bot 会话 + session 管理工具 + subagent”拼出来；
- 需要新增的是 Host Integration 的 session 管理面（M3 Product Contract 扩展）与产品层 UI（会话列表/切换）。

## 14. 长期记忆：Hindsight 固定后端（v3 冻结）

> **v3 冻结决策**：长期记忆后端固定为 **Hindsight**，通过薄 `MemoryAdapter` 集成；
> 不再做 Mem0 对照/泛化选型，不自建完整记忆引擎；DSH 仍是唯一 Agent，Hindsight 只负责长期记忆。
> 旧 `~/Documents/Nisse` 文件仅作为迁移/备份/人工检查/导出源，不再与 Hindsight 并行自动写入。
> 规格见 [MEMORY-SERVICE-SPEC.md](MEMORY-SERVICE-SPEC.md)；M1-C 必须先核验版本/许可/本地运行/SDK/依赖/资源，
> 未验证前不得宣称“已支持/可打包”。

要点（与 §12 的通用设计一致，但实现固定为 Hindsight）：
1. Adapter 只做映射：search/write/forget/export、命名空间、来源 session/turn、单写者、敏感拦截、错误映射；
2. 运行时由 Nisse Supervisor 管理（固定版本、本地数据根、备份/恢复/升级/回滚）；
3. 检索注入：digest ≤500–1000 tokens + 按需 `memory_search`；子会话只读；
4. 单写者：默认 Bot/Host Integration；冲突/时间有效性/删除不可召回/导出可迁移；
5. 性能/隐私/许可/外发范围必须实测并写进 M1-C 报告；No-Go 时提交证据与补救，等用户裁决，不擅自换后端。
