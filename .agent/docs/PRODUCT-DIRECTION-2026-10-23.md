# dsh-bot 产品方向决策文档（已拍板）

日期：2026-10-23
状态：**产品负责人已拍板。本文为最终方向记录，执行以本文为准。**
决策：**A + D；B 作为开发验证手段；放弃 C。**

---

## 0. 最终决策摘要

**dsh-bot = DSH 原生产品化发行版**：一个品牌 App · 一个 Agent · 一套会话 · 一个产品生命周期。

- 以 DSH 为唯一 Agent 核心，复用 DSH 已有的会话、工具、审批与工作区能力；
- 通过 first-party 插件实现dsh-bot、语音和产品集成；
- 使用品牌化桌面应用统一交付（内置固定版本 DSH Runtime，用户不需要另装 DSH）；
- 复用 dsh-pet 中合适的桌宠表现层技术，但不继承其独立聊天与记忆架构；
- Hindsight 作为本地长期记忆，由产品集成层统一管理访问、生命周期与用户操作。

| 原方案 | 最终决定 | 用途 |
|---|---|---|
| A：插件内核 + 品牌 App | **采用** | 最终产品的交付和品牌方向 |
| B：纯插件 | **保留为开发手段** | 在 stock DSH 上快速验证集成与接口 |
| C：大 fork + 第二 App | **放弃** | 不再延续多运行时、多设置架构 |
| D：dsh-pet + 自研语音插件 | **部分采用（与 A 组合）** | 复用桌宠表现层，不复用其独立聊天/记忆体系 |

---

## 1. 目标产品形态

```
dsh-bot.app（唯一安装包、品牌、设置、权限入口与更新生命周期）
├─ DSH Runtime（内置固定版本；唯一 Agent · 主会话 · 工具 · Skills · 审批 · 工作区）
├─ WhaleGirl First-party Plugin
│   ├─ host 半侧：语音接入 · 产品事件桥 · 人格 · 审批 UX · 记忆集成
│   ├─ 桌面层：独立桌面进程（透明置顶窗口 · 桌宠/气泡/托盘/通知/语音）· onboarding · 设置页
│   └─ 桌面层与 DSH 之间通过本机通信契约（消息流/会话/审批/取消/状态事件）交互
└─ Hindsight：本地长期记忆（由产品集成层统一管理）
```

### 四条不可妥协的架构规则

1. **DSH 是唯一 Agent**。不再让 qwen-audio-agent 维护自己的权威 Agent、会话、记忆和任务回合。
2. **dsh-bot 是真正的独立产品**。用户只需安装 dsh-bot，不需要另外安装或管理 DSH；品牌层不能只是启动外部 DSH 的快捷方式。品牌 App 必须负责管理内置的固定版本 DSH Runtime，并统一进程、数据和更新。
3. **桌宠是表现层，不是产品核心**。复用 dsh-pet 的技术资产，但不把产品架构建立在桌宠的独立聊天逻辑上。
4. **不重写 DSH 的核心能力**。优先复用上游和官方扩展点；只有遇到经过验证、无法通过扩展解决的阻塞问题，才重新评估必要的最小补丁。

> 这不是方案 C 的大 fork：它是以 DSH 为基础、通过有限产品集成和品牌化发行交付的方案。

---

## 2. 遇到的问题（事实记录，保留供后续参考）

### 2.1 架构层面

当前（旧）产品由 4 个运行时通过桥接粘合：DSH fork 壳、qwen-audio-agent（另一个完整 Agent 产品）、第二个桌宠 Electron App、Host Integration 桥。由此产生：跨运行时竞态、设置/状态分裂、维护成本高。

### 2.2 真实故障记录（2026-10-22 ~ 10-23 实测）

1. **自打断（self-barge-in）**：qwen realtime 把用户新一句话标记为"打断上一轮"，排队逻辑信了该标记，用户请求被排队，DSH 未收到。
2. **回复槽卡死（response_slot_recovery）**：取消后 response slot 卡住，DSH 回答只显示、未被朗读。
3. **中断被误报**：语音被中断（aborted）被当成"后台不可用"，桌宠念出"后台暂时不可用，我不会自己执行"。
4. **取消任务导致工具报错**：语音插话取消正在跑的 DSH turn，DSH 出现 `Error: terminal send aborted`。
5. **回声/自身提示音被识别**：TTS 播报被麦克风听回，触发新一轮对话。
6. **交互问题**：常驻提示、点麦克风松开即取消、按 Option 无反应（Electron 无法全局注册纯修饰键）。
7. **设置/状态分裂**：Bot 设置（自建服务）、DSH 设置、qwen 设置、桌宠 userData 四处；改一项需重启/relaunch。
8. **开发路径不可打包**：koffi、Hindsight venv、语音运行时、桌宠 App 均未产品化。

### 2.3 认知修正

- 早期"因 DSH React tree 无法插入所以做不了桌宠 UI"的判断不完整：
  - 做不到：把桌宠做成 DSH React 组件树内的一等公民（无官方 React 插槽）；
  - 做得到：插件在页面挂独立根节点（固定定位、独立渲染），不触碰 DSH React tree；桌面透明置顶用薄 Electron helper；
  - dsh-pet（MIT）已在 `dsh-v0.2.1-rc.2` 上验证该插件形态。

---

## 3. 语音路线（已拍板）

**首个稳定 MVP：分离式 ASR + TTS，DashScope 语音服务作为首选验证路线；保留 Qwen Realtime 作为后续可替换实现，不再把现有 qwen-audio-agent 整体当作语音底座。**

理由：当前最严重的问题不是缺少会说话的模型，而是两个运行时同时控制对话回合（自打断、取消错误、播报状态卡死）。

具体做法：

- ASR：用户语音 → 输入文本；
- DSH：决定如何理解、执行和回复；
- TTS：只负责朗读 DSH 的最终回复；
- 由**统一状态机**控制开始、打断、取消、恢复和结束；
- 先交付可中断、可恢复的语音交互；真正的低延迟全双工体验必须通过测试达标，不能只凭服务商描述认定；
- 若 DashScope 无法达到可接受的延迟与语音体验，再在**同一套 `VoiceEngine` 契约**下验证 Qwen Realtime；不再让第二套 Agent 进入产品核心。

---

## 4. 执行顺序（冻结）

| 阶段 | 内容 | 门槛 |
|---|---|---|
| **M1** | **stock DSH 集成验证**：first-party 插件、固定 DSH 主会话、本机通信契约、文本请求 → DSH → UI 完整链路（页面内 overlay 仅为能力探针，非产品形态） | M1 验证通过，才进入 M2 |
| M2 | 语音契约与确定性 E2E：ASR → DSH → TTS，统一回合状态机，验证打断/取消/恢复/回声抑制/工具执行安全 | E2E 达标 |
| M3 | 品牌 App 与运行时整合：统一 DSH、插件、Helper、Hindsight 的启动、设置、权限、数据目录与故障恢复 | 单一生命周期可用 |
| M4 | 桌面产品 MVP：主对话区、角色人格、长期记忆、审批、桌宠交互；一个应用完成完整任务 | 产品级验收 |
| M5 | 打包与发布门禁：签名、公证、干净环境安装、自动更新、回滚、卸载、真实 macOS 权限行为 | 发布门禁通过 |

> 以上是执行顺序，不代表任何阶段已通过验收；以实际 M1 验证结果作为进入后续工程的门槛。

---

## 5. 现在明确不要做的事

- 不要继续修补 qwen-audio-agent 的独立 Agent 回合机制，试图让它与 DSH 长期共存；
- 不要重新开发一套会话、工具执行或审批引擎；
- 不要现在重写完整的 OpenElement Client；先复用现有 DSH UI，确保主路径可用；
- 不要把 dsh-pet 的 `memory.json` 扩展成整个产品的长期记忆引擎；
- 不要在语音 E2E、单一会话和统一生命周期通过验收前，继续增加主动陪伴、多平台或复杂人格功能。

---

## 6. 当前状态与下一步

- 旧架构（方案 C）冻结：不再在其上打补丁；现有代码/证据归档保留。

### M1 执行结果（2026-10-23，stock DSH 0.2.1-rc.2 实测）

隔离环境：`DSH_HOME=/tmp/whalegirl-m1/home`，stock 安装版 CLI `dsh web --no-open --port 53999`，Chrome + CDP 验证 UI；插件 `whalegirl-m1` 通过 `dsh plugin --profile web add file:` 安装。

| 验证项 | 结果 |
|---|---|
| first-party 插件安装并加载到 stock DSH | **PASS**（`--dump-config` 可见；host 日志 `bridge listening`） |
| host 半侧创建固定 DSH 主会话 | **PASS**（固定 `whalegirl-m1-main`，会话文件落盘，且 attach 到 workspace，UI 侧边栏出现 `dsh-bot` 工作区） |
| 页面内 overlay（仅技术探针，非产品形态） | **PASS**（CDP `[data-whalegirl-m1]` 存在）；产品桌宠为独立桌面窗口（M3 实现） |
| 文本请求 → DSH 会话 | **PASS**（POST /turn 200，用户消息写入会话 jsonl） |
| DSH 助手回复 → UI | **BLOCKED**：插件创建的 agent 在 prompt 组装报 `prompt variable "{{model}}" has no value (deployment:persona-prefix)`；官方 UI 聊天路径正常（说明模型/部署上下文来自官方 session 创建路径，插件还没镜像） |
| dsh-pet 表现层（已判定不采用） | 曾验证可装可渲染；产品负责人判定不达标，**不再复用其窗口/动画/产品逻辑**，仅保留插件事件/状态映射/Helper 通信作技术参考 |

详细证据：`m4/evidence/M1-STOCK-DSH-RESULT.json`、`m4/evidence/M1-STOCK-DSH-UI.png`。

**M1 结论：4/5 通过，1 项阻塞（插件创建 agent 的模型/部署上下文）。进入 M2 前必须先解决该阻塞并重跑「文本→DSH→回复→UI」。**

### 下一步（按产品负责人指示）

- **产品体验主参考：Coopanion**（只参考设计/交互/功能取舍，不复制 AGPL 代码与素材）；
- **dsh-pet 只作辅助技术参考**：DSH 插件事件、状态映射、桌面 Helper 通信；不用其窗口/动画/产品逻辑，不复制素材；
- 桌宠层 = **独立桌面进程/透明置顶窗口**（不是 DSH 页面内 overlay），通过本机通信契约与 DSH 交互；全部自研；
- 语音：DashScope 实时语音先做全双工原型（M2），豆包实时语音作为对照；
- 当前进行：M2 语音全双工原型。

---

## 7. 参考与证据

- dsh-pet（MIT，插件 + 薄 Electron helper）：https://github.com/PC2005-cloud/dsh-pet
- DSH 上游：https://github.com/deepseek-ai/deepseek-harness（pin `dsh-v0.2.1-rc.2`）
- 现有 fork（旧架构，已冻结）：`$HOME/projects/dsh-bot`（`nisse/main`，`f029de8e56`）
- 项目与证据：`$HOME/projects/dsh-bot-workspace/m4/bot-evidence/`
  - `VOICE-CALL-SELF-BARGEIN-FIX.json`、`VOICE-RETURN-E2E.json`、`QWEN-ROUTE-C-FIX.json`、`VOICE-UX-ROUND2-RESULT.json`
  - `BOT-CONVERSATION-AREA-MEMORY.json`、`BOT-SETTINGS-ROUND3-INTEGRATION.json`
- 旧方案审计：`m4/PRODUCT-SHELL-RESULT.md`、`AUDIT-2026-10-22-PM.md`
