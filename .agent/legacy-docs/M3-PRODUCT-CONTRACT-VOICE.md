# M3 Product Contract：语音命令 / 配置 / 人格（草案 v0）

> 状态：M1 产出 → M3 设计输入（2026-10-21；v3 对齐）｜L1/L2 路由与会话管理见 [BOT-SESSION-ORCHESTRATION.md](BOT-SESSION-ORCHESTRATION.md)｜归属原则：DSH 唯一 Agent；Voice Runtime 只做音频与检测；
> 产品层/Host Integration 持有配置与人格权威。本文定义命令词、事件、归属与迁移步骤。

## 0. 原则

1. **能力不删，只迁移**：语音命令/人格/配置都保留，但不再长在 Voice Runtime 里；
2. **检测与执行分离**：Voice Runtime 只负责听到（ASR/停止短语/VAD），Product/Host Integration 决定做什么；
3. **单一配置权威**：模型/工作区/会话/人格只有一份存储，Voice Runtime 不持久化业务配置；
4. **安全默认**：涉及凭据、权限、always-allow、删除/覆盖/高危操作的命令，语音不得单独批准，必须 UI 二次确认；
5. **可审计**：每条命令产生带 commandId/sessionId/turnId 的事件，结果与来源（voice/ui）可追溯。

## 1. 归属矩阵

| 能力 | Voice Runtime | Host Integration（DSH 内） | 产品层/Electron | DSH |
|---|---|---|---|---|
| 语音检测（ASR/停止短语/VAD） | ✅ | — | — | — |
| 反射反馈（确认音/固定语/停止播报） | ✅（本地） | — | 触发 | — |
| 配置存储与校验（模型/工作区/会话/人格） | — | ✅ | UI 编辑/展示 | 读取应用 |
| 命令意图解析（语音） | 只转写 | ✅（contract 服务） | 兜底/确认 | — |
| 人格注入（system prompt section） | — | ✅ | UI 编辑 | ✅ 生效 |
| 任务执行/工具/审批/取消终态 | — | 映射 | 转发/展示 | ✅ |
| 设置 UI/确认弹窗 | — | — | ✅ | — |

## 2. 命令分类与命令表

### C0 反射/控制（Voice Runtime 本地或产品层，无 LLM）

| 意图 | 示例命令词 | 归属 | 行为 | 风险 |
|---|---|---|---|---|
| `control.stop_speaking` | 「停一下」「别说了」「安静」 | Voice Runtime 检测 → 产品层执行 | 只停止播放；**不取消任务**（S1） | 低 |
| `control.cancel_task` | 「取消这个任务」「别做了」 | 产品层 → Host Integration → DSH cancel | 取消 DSH turn；终态 aborted；播报确认 | 中（需回执） |
| `control.emergency_stop` | 「急停」「全部停下」 | 产品层（独立入口/按键） | 停播报 + 取消任务 + 暂停新任务 | 高（需明确 UI 状态） |
| `control.wake/sleep` | 「在吗」「睡吧」 | Voice Runtime/产品层 | 唤醒/休眠，不进入 DSH turn | 低 |
| `control.mute` | 「静音」「声音大点」 | 产品层 | 音量/静音（本地） | 低 |

> 停止/取消/急停必须三态分离，事件带 `commandId` 与 `turnId`。

### C1 状态查询（Host Integration 回答 + TTS 播报）

| 意图 | 示例 | 返回 |
|---|---|---|
| `config.query_model` | 「默认模型是什么」 | provider/model/effort |
| `config.query_workspace` | 「默认工作区是哪儿」 | 绝对路径 |
| `config.query_session` | 「默认会话是哪个」 | sessionId/自动 |
| `persona.query` | 「你现在的人设是什么」 | name/tone 摘要（不读 instructions 全文） |
| `task.status` | 「刚才做到哪了」「任务好了吗」 | 最近任务状态/结果摘要（来自 DSH） |

### C2 配置变更（Host Integration 校验并落库；变更回读确认）

| 意图 | 示例 | 约束 |
|---|---|---|
| `config.set_model` | 「把默认模型设为 DS Pro 4」/「思考强度改成低」 | 模型/effort 必须在允许列表；回读确认 |
| `config.set_workspace` | 「默认工作区设为 /path」 | 绝对路径、须存在/可写；回读确认 |
| `config.set_session` | 「新建会话」「默认会话恢复自动」 | 影响下一 turn；不做静默切换 |
| `config.set_permission_mode` | 「权限改成只读」 | 高危：必须 UI 二次确认（语音只说“需要你在设置里确认”） |
| `policy.always_allow.*` | 「以后都允许这个工具」 | **语音禁止单独生效**；只提示去 UI/审批弹窗确认 |
| `memory.clear` / `memory.delete` | 「忘掉刚才那件事」 | 高危：UI 确认 + 审计 |

### C3 人格（Host Integration 存储，DSH system prompt section 生效）

| 意图 | 示例 | 约束 |
|---|---|---|
| `persona.set_name` | 「你叫大肥鱼」 | ≤80 字；回读 |
| `persona.set_style` | 「说话简短一点」「别卖萌」 | 归入 tone/instructions 模板；长度上限；回读 |
| `persona.preset` | 「用温柔一点的人设」 | 预置模板 id；产品层可编辑 |
| `persona.reset` | 「恢复默认人设」 | 回读确认 |

> 人格只影响“怎么说”，不影响“说什么”；事实/任务仍由 DSH 回答。

## 3. 事件契约（产品层 ↔ Host Integration ↔ Voice Runtime）

统一信封：`{ v: 1, eventId, ts, sessionId?, turnId?, commandId?, source: 'voice'|'ui'|'system', payload }`

| 事件 | 方向 | 关键字段 | 说明 |
|---|---|---|---|
| `voice.command.detected` | Voice → Product | `intent, transcript, args, confidence, commandId, sessionId, turnId` | 只表示“听到”，不代表执行 |
| `product.command.accepted` | Product → Host/Voice | `commandId, intent, normalizedArgs` | 开始执行 |
| `product.command.result` | Host → Product | `commandId, ok, result, errorCode?, readbackText?` | 结果与要播报的文本 |
| `config.changed` | Host → Product/DSH | `scope, key, oldValue, newValue, version, source` | 单一权威变更广播 |
| `persona.updated` | Host → Product/DSH | `fields, version, source` | 下一 turn 生效 |
| `task.status.changed` | DSH → Product | `turnId, state, summary` | 已存在 turn/status 事件的映射 |
| `error` | 任意 | `code, message, retryable, commandId?` | 见错误码 |

错误码：`COMMAND_UNKNOWN`、`NEEDS_CONFIRMATION`、`INVALID_VALUE`、`FORBIDDEN`、`BACKEND_UNAVAILABLE`、`CANCELLED`、`SUPERSEDED`、`CONFLICT_VERSION`。

幂等/并发：`commandId` 幂等；`config.changed` 带 `version`（CAS）；新命令 supersede 旧命令（与 T8 一致）。

## 4. 语音交互规则

1. **回读确认**：配置/人格变更后 TTS 回读新值（“好，默认模型改成 DS Pro 4了”）；
2. **不读敏感内容**：不回读 API Key/token/审批原文/完整指令；
3. **安全确认**：权限模式、always-allow、删除类操作只说“请到设置/弹窗确认”，不得语音代批；
4. **未知命令**：不得静默吞掉，转普通 DSH turn（避免误判“停车怎么走”类句子）；
5. **停止/取消**：见 C0；停止播报与取消任务必须产生不同事件与不同播报；
6. **迟到/重复命令**：带 `commandId` 去重；旧命令超时/被 supersede 后不得再播放结果（S5）。

## 5. 迁移步骤

| 阶段 | 动作 | 产物 |
|---|---|---|
| P0（当前） | 命令仍实现于 qwen-audio-agent 的 `nisse-bridge-turn`；加 **adapter** 映射到本契约事件 | 契约事件日志（可与现有日志并存） |
| P1（M3） | Host Integration 提供 `config/persona` 服务与 contract endpoints；Voice Runtime 只发 `voice.command.detected` | 单一配置权威；设置页面读同一服务 |
| P2（M4） | 产品层设置 UI 为编辑主入口；语音只做查询/常用变更；删除 Voice Runtime 内旧业务分支 | 旧命令代码下线；契约测试全绿 |

验收：命令表逐条测试（语音/文本两条通道）；配置变更持久化并影响下一 turn；人格变更在 system prompt 生效；
停止/取消/急停三态事件正确；迟到/重复/并发命令不产生重复播报；安全命令均需 UI 确认。

## 6. 未决问题

1. 配置权威存储位置：Host Integration 的 DSH 侧 vs 产品层（建议 Host Integration，产品层只做 UI）；
2. 人格字段 schema（name/tone/instructions/preset）与长度限制；
3. 语音命令意图识别：规则词表 vs 轻量分类器 vs DSH fast lane；
4. 多会话（fast lane/task lane）下配置与人格的一致性策略。
