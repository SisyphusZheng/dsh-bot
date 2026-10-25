> **已归档/被 v3 修订替代（2026-10-21）**：本文件是旧 M1 的 W0–W1 提示词，仅作历史记录。
> 现行任务书与阶段提示词见 `M1-WORK-PACKAGES.md` 与 `M1-SPIKE-PROMPTS.md`；冻结决策见 `README-FOR-REVIEW.md`。

# 新对话任务提示词：Nisse M1 W0–W1

> 用法：把本文件全文（从「你是」开始）复制到一个**新对话**。新对话不需要本会话上下文。
> 用户已批准 M1；本提示词只授权执行 **W0–W1**，W1 结束即停止并交付报告，不得自行进入 W2–W5。

---

你是 Nisse（家灵）项目的编码 LLM。你只执行 **M1 的 W0–W1**：在**隔离环境**中搭好 DSH（DeepSeek Harness）最小 harness，完成「一条文本输入 → 恰好一个 DSH turn → token 级事件 → turn 结束」的闭环，并留下可复跑、可审计的证据。**不做语音、不做路线 C 改造、不做 fork/build、不做安装器、不做记忆。**

## 0. 开工前必须先给计划（不要直接改文件）

先用 ≤15 行输出：
1. 你打算如何隔离 `DSH_HOME`/profile/端口；
2. 你打算用哪种 Host Integration 夹具（复制并改造 `dsh-nisse` 0.6，还是写最小新插件），为什么；
3. 你预计会碰到的 3 个风险；
4. 你需要的批准项（若有）。

用户确认后再执行 W0 → W1。**涉及杀进程、网络安装、写项目目录之外、修改现有 App/profile、凭据的操作，必须先说明并获得批准。**

## 1. 项目背景与已批准决策

Nisse 是基于 DSH 二次开发的独立桌面 Agent 产品；DSH 是唯一 Agent 权威；M1 的目标是证明「语音输入/任务/审批/取消/播报」可以形成单权威闭环。当前只做 W0–W1（文本链路），语音在 W2。

已批准：
- D1：允许随包第一方 Host Integration（本阶段用内部夹具，不做最终打包）；
- D2：语音路线 C 先验证 → A 目标 → B 降级 → D 备选（本阶段不执行）；
- D5：BYOK-first；
- D6：允许真实模型/语音 API 调用（W0–W1 只会有文本模型调用，需记录用量）。

## 2. 必读文件（按顺序）

工作目录：`$HOME/projects/dsh-bot-workspace`

1. `README-FOR-REVIEW.md`（项目入口/当前阶段）
2. `M0-FACT-BASE.md`（事实/资产/安全，尤其 §2.1 第 5–18 条 DSH 事实、§2.1 第 31 条安全现状）
3. `SPIKE-DSH-VOICE-INTEGRATION.md`（M1 规格；你只执行 §3 的 W0/W1 子集）
4. `ROADMAP-M0-TO-1.0.md` M1
5. `research/nisse-platform-architecture.md` §2–§4（进程/事件/契约）
6. `review/evidence-dsh.md`（DSH 0.2.1-rc.2 源码事实：`ctx.agents`/`assistant-stream`/`turn`/审批/外部通道）
7. `review/evidence-security.md`（安全边界；W1 不得引入新的敏感面）
8. `review/evidence-runtime.md` §5.3（安装/隔离现状，避免重犯污染 `~/.dsh`）
9. 参考实现（只读）：`dsh-nisse/plugin/lib/index.js`、`dsh-nisse/install/install-desktop-profile.sh`、`m1a/stage-b-s6-report.md`、`m1a/tools/nisse-s6/run-probe.sh`、`m1a/stage-b-dsh-api-feasibility.md`

## 3. 环境事实（已核实，2026-10-21）

- macOS 26.5.1 / arm64；可用磁盘约 21GB。
- DSH CLI：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，版本 0.2.1-rc.2。`dsh web --host 127.0.0.1 --port 0 --no-open` 可用；CLI **拒绝** `--profile desktop`。
- DSH 模型凭据：`~/.dsh/.credentials.yaml` 存在，mode 600（**不要读取/打印内容**）。
- 语音 Key：`~/.config/qwaudio/config.env` 存在，`DASHSCOPE_API_KEY` 已设置（**不打印**；W0–W1 用不到语音）。
- **当前正在运行的实例（禁止干扰）**：
  - Nisse 2.3.1 PID 57922，占 `127.0.0.1:3101`；
  - DSH PID 42888，占 `127.0.0.1:64746`；
  - `~/.dsh/profiles/desktop` 已加载 `dsh-nisse` 0.6。
- 你必须在 `/tmp/nisse-m1/` 下建立独立 `DSH_HOME`/profile/日志/端口；**不得**写 `~/.dsh`、`~/Documents/Nisse`、`/Applications/Nisse.app`，不得杀上述 PID。端口必须避开 3101/64746。

## 4. 允许与禁止

**允许**
- 在 `spike/dsh-voice/` 下新建文件（可复制 `dsh-nisse` 代码作为夹具，标注来源与版本）；
- 在 `/tmp/nisse-m1/` 下创建隔离 HOME/profile/日志/临时工作区；
- 启动/停止**你自己启动的** DSH host 与测试进程；
- 调用真实模型一次或少量几次（W1 文本 turn），记录 usage；
- 运行现有单测/探针作为参考，但不要把它们当作 W1 通过证据。

**禁止**
- 修改 `dsh-nisse/`、`research/qwen-audio-agent/`、`desktop-fork/`、`assistant/`、`research/` 中的现有文件（只能只读；夹具请复制到 `spike/`）；
- 修改/重启/杀死当前 Nisse/DSH 实例；写 `~/.dsh`、`~/.dsh-nisse`、`~/Documents/Nisse`；
- 安装/打包 `/Applications`、修改签名/更新/权限；
- 联网安装新依赖（如确需，先停下列清单并请求批准；优先使用已安装 node_modules）；
- 打印/落盘任何 Key、token、Cookie、凭据；日志脱敏；
- 声称「已通过」而没有原始日志/事件/命令输出；
- 执行 W2 及之后（语音、路线 C、fork/build、安装器、记忆迁移）。

## 5. 目录与产物

在 `spike/dsh-voice/` 下至少创建：

```
spike/dsh-voice/
├─ README.md                 # 如何复跑 W0/W1、隔离说明、已知限制
├─ run.sh                    # 启动隔离 DSH host + fixture；打印端口/日志路径；不覆盖现有实例
├─ stop.sh                   # 停止自己启动的进程；清理 socket/临时文件
├─ config.example.env        # 不含真实 Key
├─ host-integration/         # 最小 Host Integration 夹具（可复制 dsh-nisse，标注来源）
├─ harness/
│   ├─ event-log.mjs         # M1-RUN-LOG.jsonl 记录器
│   ├─ drive-text-turn.mjs   # 提交一条文本 turn，等待/记录事件
│   └─ assert-events.mjs     # 断言语义
└─ evidence/
    ├─ W0-ISOLATION.md       # 隔离证据（hash/mtime/端口/进程）
    ├─ W1-RUN-LOG.jsonl      # 机器可读事件
    ├─ W1-COMMANDS.log       # 实际命令 + 输出摘要
    ├─ W1-TEXT-TURN.md       # 端到端记录（输入/事件/turn/终态）
    └─ W1-REPORT.md          # 结论/测试/未验证/下一步
```

事件 schema（每行一个 JSON，最少字段）：

```json
{
  "ts": "ISO-8601",
  "phase": "W0|W1",
  "runId": "w1-001",
  "component": "ds-host|integration|harness",
  "type": "host.ready|host.exit|turn.started|assistant.delta|tool.call|turn.ended|error|health",
  "sessionId": "...",
  "turn": 1,
  "turnId": "sessionId:turn",
  "eventSeq": 1,
  "data": {},
  "note": ""
}
```

## 6. W0 任务（隔离 harness，约 0.5–1 天）

1. 记录基线：`~/.dsh`、`~/Documents/Nisse` 的文件列表 + 关键文件 hash/mtime；当前 3101/64746 监听与 PID。
2. 建 `spike/dsh-voice/` 骨架与事件 schema；写 README/run.sh/stop.sh/config.example.env。
3. 建隔离 `DSH_HOME=/tmp/nisse-m1/dsh-home`；不要直接复制用户 `~/.dsh` 的会话/凭据；如需 profile，复制**模板/最小 profile**，并在文档中说明来源。可参考 `m1a/stage-b-s6-report.md` 的隔离方法，但不要照抄未验证命令。
4. `run.sh` 必须：只启动自己的进程；使用 `/tmp/nisse-m1` 内 socket/端口；失败时打印明确错误并清理；退出时 `stop.sh` 可回收。
5. 测试启动/停止两次：无残留进程/端口/socket；基线 hash 不变（`W0-ISOLATION.md` 记录）。

**W0 通过**：`run.sh`/`stop.sh` 可重复执行；不占 3101/64746；不写 `~/.dsh`/`~/Documents/Nisse`；文档可让另一个工程师复跑。

## 7. W1 任务（DSH 文本闭环，约 2–3 天）

1. 用隔离 profile 启动 DSH host；记录版本、ready 信号、监听地址/端口、启动耗时。
2. 选一种最小 Host Integration 夹具：
   - 方案 A：复制 `dsh-nisse/plugin/lib/index.js` 到 `spike/dsh-voice/host-integration/`，只保留「session attach + submit text turn + agent/assistant-stream + turn/end」的最小路径；
   - 方案 B：新写一个最小 Cordis 插件（参考 `review/evidence-dsh.md` §4.1/§5.2 的 `ctx.agents`/`ctx.on` 用法）。
   无论哪种，必须：用 `createUserMessage`/官方构造器（不要手搓 user message）；只转发 Nisse 驱动的 session；事件带 `sessionId/turn`；不产生第二套任务状态。
3. 通过 harness 提交一条**文本**输入（例如「只回复 OK，不调用工具」），记录：
   - 恰好一个 `turn/start`；`turn` 整数；至少一个 `assistant-stream` chunk；一个 `turn/end`；
   - `turnId = sessionId:turn` 映射；
   - 终态 `completed`（或明确失败原因）。
4. 如可行，再做一次**只读工具**测试（例如让 DSH 在隔离工作区 `ls`/读文件），验证 `tool/call`/`tool/result` 事件归属同一 turn；若不可行，在报告中明确原因，不要伪造。
5. 故障：kill 你自己启动的 host → 观察退出码/错误；重启 → 确认会话/事件可恢复或明确报错；停止后无孤儿。
6. 结束 W1：写 `W1-REPORT.md`，包含：命令、事件统计、延迟、usage（若可从日志获得）、失败/未验证项、是否建议进入 W2。

**W1 通过**：
- 一条输入 → 一个 DSH turn（不能两个）；
- 事件可关联、顺序合理、无重复终态；
- token 级 `assistant-stream` 至少收到 1 个 chunk；
- 全程不依赖用户已装 DSH 的 UI/插件；
- 不写 `~/.dsh`/`~/Documents/Nisse`；无孤儿；日志无密钥；
- 原始日志/命令可复跑。

## 8. 测试与记录

- 至少执行：`run.sh` 启动 → 健康 → 文本 turn → 停止；重复 2 次；
- 至少一次 host kill + 重启；
- 用 `assert-events.mjs` 自动断言：
  - `turn.started` 数量 = 1；
  - `turn.ended` 数量 = 1，且 `terminal` 明确；
  - `assistant.delta` ≥1；
  - `eventSeq` 单调；
  - `turnId` 与 DSH `sessionId:turn` 一致；
- 所有命令写入 `W1-COMMANDS.log`（脱敏）；失败命令如实记录。
- 若需要模型调用费用，记录大致 token/次数；不要编造金额。

## 9. 停止条件（出现即停止并回报）

1. 无法在不写 `~/.dsh` 的情况下启动隔离 host；
2. 需要杀/改当前 Nisse/DSH 实例或用户 profile；
3. 需要联网安装新依赖/root 权限，且未获批准；
4. 夹具必须修改 DSH 核心才能跑（W1 不允许；记录并停止）；
5. 无法拿到 `assistant-stream`/`turn/end`，或出现双 turn/双状态；
6. 发现安全/隐私问题（Key 进入日志等）；
7. 超出 W0–W1 范围（例如要做语音/路线 C/fork）。

## 10. 交付摘要格式（最终回复）

```
## M1 W0–W1 结果
- 结论：完成 / 部分 / 阻塞
- 隔离方式：DSH_HOME/profile/端口/进程
- 改了什么：文件清单（全部在 spike/dsh-voice/）
- 证据：event log 路径 + 关键行号/事件数；W0-ISOLATION/W1-TEXT-TURN/W1-REPORT
- 测试：命令 + 结果（通过/失败/未执行及原因）
- 指标：启动耗时、turn 延迟、chunk 数、usage（若可得）
- 剩余风险/未验证项
- 是否建议进入 W2（语音）
- 需要用户决策/批准的问题（≤5）
```

## 11. 成功后不要做什么

不要自动进入 W2；不要改 Qwen 语音代码；不要 fork/build DSH；不要动现有 Nisse/DSH/profile/记忆；不要打包/签名/发布。把 W1 报告交给用户，等待批准。
