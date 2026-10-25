# DSH API 能力矩阵（Route A / Bot / Hindsight 前置审计）

> 状态：M0/M1 前置审计草案（2026-10-21）｜证据等级：**已证实 / 强推断 / 待实验 / 阻塞**
> 依据：`review/evidence-dsh.md`（源码审计）、M1 W1–W3 实测、`dsh-nisse 0.6` 参考实现。
> **硬约束：不修改 DSH 核心**——标“阻塞”的项只能通过 Host Integration/产品层绕行，或停止并报告。

## 1. Agent / Session 基础

| 能力 | Route A/Bot 用途 | 证据/状态 | 备注 |
|---|---|---|---|
| 创建专用 agent session（指定 sessionId/meta.cwd/agentOptions） | Bot/L1/L2 会话 | **已证实**（M1 fixture `ctx.agents.create`） | 可用 |
| 提交 user message（官方 `createUserMessage`） | 输入路由 | **已证实**（M1） | 不手搓消息 |
| token 级 assistant-stream | 语音流式播报 | **已证实**（M1/W2） | 同进程 Host Integration 才拿得到 |
| durable `session/event`（turn/tool/approval/cancel） | 状态/审计 | **已证实**（M1） | 可回放/持久化 |
| agent cancel | 取消/打断 | **已证实**（M1：terminals aborted） | 协作式 |
| agent status idle/running | 状态 | **已证实**（M1） | |
| session resume | Bot 继续/接管 | **强推断**（`dsh-nisse` 使用 `ctx.agents.resume`；M1 未重测） | 待 M1-B 验证语义 |
| agent/session roots 列表 | 会话列表 | **强推断**（插件 `/sessions` 用 `ctx.agents.roots()`） | 返回形状/字段待实验 |
| session 历史读取（snapshotEvents/deriveMessages） | 摘要/迁移 | **强推断**（源码可见；M1 用 snapshotEvents） | 摘要仍需 LLM |
| 会话标题/元数据 | Bot 列表/搜索 | **待实验** | 是否有 rename API 未知 |
| 创建/重命名/归档/删除 session | Bot 会话管理 | **待实验/部分阻塞** | 若无 API：只做 Nisse 侧索引与归档隐藏，不删 DSH 数据 |
| 跨 session 搜索 | Bot 汇总 | **待实验** | 可能需本地索引/FTS，不能依赖核心 |
| 外部/多客户端接入（Web API） | 产品层/外部 | **待实验**（Web Host `$events` 私有协议） | 非稳定契约，仅 POC |
| 同会话并发写 | 接管锁 | **阻塞（无原生锁）** | 需产品层单写者锁 + 用户可见策略 |

## 2. 模型 / 工具 / 审批 / 预算

| 能力 | 用途 | 证据/状态 | 备注 |
|---|---|---|---|
| provider/model/reasoningEffort per session | Bot/session effort | **已证实**（agentOptions；M1 实测） | |
| 工具开关/agentPreset | L1 最小工具面 | **强推断**（meta.agentPreset；M0 审计） | 可用 preset/工具配置 |
| 工具调用事件/结果归属 turn | 审计 | **已证实**（M1） | |
| 审批事件 + 应答（waterfall） | 语音审批 | **已证实**（事件/插件参考）；**语音答复未实测（T7）** | 高危需 UI 二次确认 |
| approval always-allow 规则 | 策略 | **部分**（dsh-nisse 在插件侧管理规则） | DSH 原生无 always-allow |
| 取消后迟到结果丢弃 | 一致性 | **已证实**（M1/T8 supersede；W3 取消） | |
| token/费用预算 | 三层预算 | **待实验** | usage 可见；无原生 per-agent 预算限制 |
| 工具结果裁剪/compaction | 上下文控制 | **强推断**（DSH compaction 可配置） | 需实测配置项 |
| 记忆 | 长期记忆 | **仅 Hindsight 外部** | DSH 无记忆服务；不得依赖核心 |

## 3. 结论

1. **Route A 的“逻辑编排”可以不改核心起步**：会话创建/消息/事件/工具/审批/取消已证实；列表/恢复/标题/归档需 M1-B 实验；
2. **单写者锁、跨 session 搜索、预算限制** 属于 Host Integration/产品层职责，不能假设 DSH 提供；
3. **禁止**为“session 父子树/跨 session 事务”改核心；如阻塞，输出证据与备选（产品层绕行/缩小范围）。
