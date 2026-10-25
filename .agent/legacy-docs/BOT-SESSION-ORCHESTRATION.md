# Bot Session Orchestration 契约（M1-B 草案 v0）

> 依据：v3 主提示词（Route A 冻结）｜状态：**M0/M1-B 草案，待能力审计后细化**
> 硬约束：Bot 是常驻顶层 **main session / 统一角色 / 逻辑协调层**；**不修改 DSH 核心、不创建 session 父子树**；
> 所有编排由 Nisse/Host Integration 通过现有 API 与版本化契约实现。接口缺口 → 停止并报告，不得改核心。

## 1. 角色

| 角色 | 职责 | 不拥有 |
|---|---|---|
| Bot（顶层 main session） | 身份/人格/长期记忆入口/固定工作区/默认 effort；L1 快速回答；会话路由；摘要；接管协调；预算上限 | 第二套任务/工具/审批权威；伪造 session 状态 |
| DSH root session | 项目/任务的会话权威：turn/工具/审批/取消/最终回复/compaction | 跨会话编排（由 Host Integration 提供） |
| Host Integration | session registry/index、路由执行、接管锁、摘要服务、预算、审计事件 | Agent 决策/工具执行 |
| Voice Runtime | 音频 I/O + L0 反射 | 会话管理/记忆/RAG |
| Product layer | UI/确认/设置/审批 UX | Agent 事实/会话事实 |

## 2. Session Registry（Nisse 侧索引，非 DSH 核心改动）

字段（示例）：
```ts
type SessionIndexEntry = {
  sessionId: string;            // DSH session id（权威）
  title: string;                // Nisse 展示标题（可编辑）
  projectId?: string;           // 项目/工作区标签
  workspace: string;            // 绝对路径
  status: 'idle'|'running'|'waiting-approval'|'error'|'unknown';
  lastActivityAt: string;       // ISO
  createdAt: string;
  owner: 'bot'|'user'|'takeover'; // 当前逻辑写者
  lock?: { holder: string; leaseUntil: string; reason: string };
  summaryRef?: string;          // 摘要存储引用
  dshMetaUpdatedAt?: string;    // 与 DSH 元数据同步时间
};
```
- 索引可重建（从 DSH session 列表 + 本地事件重建）；不复制 session 内容；
- 本地元数据操作 p95 <300ms；状态以 DSH 事件/查询为权威，索引允许“未知/过期”但不得伪装实时。

## 3. 操作

| 操作 | 输入 | 输出/规则 |
|---|---|---|
| `session.list` | 过滤/搜索/分页 | 索引条目；标注来源/新鲜度 |
| `session.get` | sessionId | 条目 + 最近状态（按需向 DSH 查询） |
| `session.create` | workspace/title/agentPreset/model/effort | 创建 DSH root session；写索引；审计 |
| `session.rename` | sessionId,title | 本地标题（可同步 DSH 标题若支持）；审计 |
| `session.archive` | sessionId | 从默认列表隐藏（不删除文件）；可恢复 |
| `session.route` | userText/turnId,target? | L1 直接回答 或 L2 指定/推荐 session；写审计 |
| `session.summarize` | sessionId,sinceTurn? | 摘要（带预算/来源/时间范围）；异步可查询 |
| `session.takeover` | sessionId,reason | idle 检查 + 单写者锁；成功后进入 active；失败明确报错 |
| `session.release` | sessionId | 交还/释放锁；审计 |
| `session.cancel` | sessionId,turnId? | 转发 DSH cancel；迟到结果丢弃 |
| `session.budget` | scope(Bot/session/subagent) | 查询/设置预算；超限降级策略 |

## 4. 路由规则（L1/L2）

1. 用户输入先到 Bot；Bot 可 L1 直接回答（仅限低风险/状态/人格/闲聊/元信息，事实须来自可验证来源）；
2. 任务/工具/文件/系统操作/复杂推理 → L2：指定 session 或推荐候选；
3. 明确指代（“Nisse 那个会话”“继续刚才的任务”）优先；歧义时询问/列候选；
4. **不得静默劫持**用户正在用的 session；路由到非当前 session 需用户可见确认（语音/气泡）；
5. 每次路由记录 `{turnId, decision, targetSessionId?, reason, userVisible}` 审计事件。

## 5. 摘要

- 输入：session id + 时间/turn 范围；输出：结构化摘要（做了什么/结果/待办/风险）+ 来源（sessionId/turn/ts）；
- token 预算固定；摘要生成可异步；过期摘要不得伪装实时状态（标注生成时间与范围）；
- 跨会话汇总只读摘要，不重放原始历史。

## 6. 接管与单写者锁

- 接管前提：目标 session 状态 idle 且无未完成 turn；
- 锁存储：Nisse 本地权威（SQLite/文件 + 租约）或 Host Integration；锁粒度 session；
- 字段：holder、leaseUntil、reason、heartbeat；过期回收；崩溃恢复时释放/标记；
- 同一 session 双写必须被拒绝（错误码 `SESSION_LOCKED`）；交还需要显式/幂等；
- 与 DSH 并发写：若 DSH 侧也允许写入，需以“单写者”产品策略约束（不依赖 DSH 核心改动）。

## 7. 预算

- 三层：Bot / session / subagent；维度：token、费用、时间、并发、工具调用次数；
- 采集：DSH 事件/usage + Host Integration 记录；预算可观察、可测试；
- 超限：降级（拒绝新任务/缩短回答/提示用户）并审计；不得静默超支。

## 8. 事件与错误

事件：`bot.route.decided`、`session.index.updated`、`session.summary.ready`、`session.lock.acquired|released|expired`、`session.takeover`、`session.budget.updated|exceeded`、`session.cancelled`。
错误码：`SESSION_NOT_FOUND`、`SESSION_LOCKED`、`SESSION_BUSY`、`ROUTING_AMBIGUOUS`、`BUDGET_EXCEEDED`、`DSH_UNAVAILABLE`、`SUMMARY_UNAVAILABLE`。

## 9. 失败与安全

- DSH 不可用：fail-closed，列表可显示“过期/未知”，路由/接管拒绝；
- 跨会话操作审计：谁（user/bot）、何时、哪两个 session、理由；
- 敏感 session（审批/凭据/敏感工作区）不进入摘要/跨会话提示，除非用户明确；
- 不修改 DSH 核心；若某项操作只能靠改核心实现 → 停止，记录阻塞与备选方案。

## 10. 待验证（M1-B B0）

- DSH 是否提供 session list/search/metadata/rename/archive API；`agents.roots()` 能拿到什么；
- 外部 resume/attach 的语义与限制（并发、事件、审批）；
- 状态/idle 判定；session title 存储位置；跨进程锁可行性；
- 以上未验证前，本契约中的相关操作标记“待实验”，不得宣称已支持。

## 11. 验收（M1-B）

见 `M1-WORK-PACKAGES.md` §3 B7；重点：≥3 session 管理、L1/L2 路由、不劫持、摘要来源、
接管单写者/冲突/崩溃恢复、预算降级、跨层审计、fail-closed、延迟基准、**未修改 DSH 核心**证据。
