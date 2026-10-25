# Memory Service Spec（M1-C 草案 v0）：Hindsight + 薄 MemoryAdapter

> 依据：v3 主提示词第四部分（Hindsight 冻结）｜状态：**M0/M1-C 草案，待事实核验**
> 硬约束：Hindsight 是唯一长期记忆后端；Nisse **不自研完整记忆引擎、不做 Mem0 对照**；
> DSH 仍是唯一 Agent；Hindsight 只负责长期记忆，不负责规划/工具/Bot 路由/人格权威。
> 证据纪律：Hindsight 的版本/许可/本地运行/SDK/依赖必须实测核验，本文不得当作已验证事实。

## 1. 边界

| 组件 | 负责 | 不负责 |
|---|---|---|
| DSH | 会话/上下文/compaction/Agent/Tool/审批/最终回复 | 长期记忆 |
| Hindsight（本地运行时） | 记忆抽取/索引/检索/存储（按其能力） | Agent 规划/工具执行/人格/Bot 路由 |
| MemoryAdapter（Nisse/Host Integration 薄层） | 接口映射、命名空间、单写者、敏感拦截、导出/迁移、错误映射 | 重写提取/索引/检索算法 |
| 旧 `~/Documents/Nisse` 文件 | **仅迁移/备份/人工检查/导出源** | 不再作为自动写入的权威记忆源 |

## 2. 事实核验清单（C0，必须先做）

1. 固定版本、发布渠道、许可（代码/模型/依赖）与商用条款；
2. 官方本地运行方式：进程/容器/DB/模型依赖；是否需要 Python/Node 服务；资源（内存/磁盘/端口）；
3. Node/TypeScript SDK 或 HTTP API：search/write/delete/export/health/version；
4. 数据目录/备份/恢复/迁移/升级/回滚；
5. LLM/Embedding 调用与外发（端点/凭据/费用/可离线性）；
6. 安装包交付方式（避免要求用户另装运行时）；签名/更新影响；
7. 安全/隐私默认值；日志是否含记忆原文；删除语义是否彻底。
> 以上任一项不满足且无法安全补救 → 停止并提交 No-Go 证据，不擅自换后端。

## 3. MemoryAdapter 接口（草案）

```ts
interface MemoryAdapter {
  health(): Promise<{ ok: boolean; version?: string; degraded?: string }>;
  search(q: { query: string; namespaces?: string[]; kinds?: string[]; limit?: number; budgetTokens?: number; asOf?: string }): Promise<MemoryHit[]>;
  write(items: MemoryWrite[], opts: { writer: 'bot'|'ui'|'migration'; source?: { sessionId?: string; turnId?: string }; idempotencyKey?: string }): Promise<MemoryWriteResult>;
  forget(filter: { ids?: string[]; query?: string; namespaces?: string[]; before?: string }): Promise<{ deleted: number; verified: boolean }>;
  export(q?: { namespaces?: string[]; format?: 'jsonl'|'markdown' }): Promise<{ path: string; count: number }>;
}
type MemoryHit = { id: string; kind: string; text: string; score: number; validFrom?: string; validTo?: string; confidence?: number; source?: {sessionId?: string; turnId?: string}; updatedAt: string };
type MemoryWrite = { kind: 'profile'|'fact'|'entity'|'episode'|'project'|'skill'|'preference'; text: string; entities?: string[]; validFrom?: string; confidence?: number; namespace?: string };
```

## 4. 数据模型与命名空间

- 类型：profile/preference（画像/偏好）、fact/entity（事实/实体/关系）、episode（会话/任务摘要）、
  project/worklog（项目/工作流水）、skill/procedure（可复用流程，可选）；
- 命名空间：`global` / `project:<id>` / `session:<id>`；
- 来源：source sessionId/turnId、writer、createdAt；有效期 validFrom/validTo、confidence、supersededBy；
- 敏感信息（Key/token/密码/身份证等）**写入前拦截**；记忆原文不得进入普通日志/遥测。

## 5. 写入与冲突

- 入口：显式“记住这个”/设置编辑（UI）；自动抽取（可开关、可审计；由 Hindsight 或 Bot 触发，Adapter 只转发）；
- 单写者：默认 Bot/Host Integration 写；subagent 只读（需要写时走主会话/显式授权）；
- 冲突：新事实与旧事实冲突不静默覆盖；按时间有效性标记 superseded 或询问用户；
- 幂等：idempotencyKey；失败不假装成功；重试安全；
- 迁移：旧 `~/Documents/Nisse` USER/MEMORY/WORKLOG/PROJECTS 一次性迁移，幂等/可回滚/可验证。

## 6. 读取与注入

- 检索：关键词+语义混合（以 Hindsight 能力为准）；按相关性/时间/置信度；返回当前有效版本；
- 注入：Bot system prompt 常驻 digest ≤500–1000 tokens + `memory_search` 工具按需；
- 子会话：默认只读项目/全局；不注入敏感记忆；
- 过期/删除后不可召回（缓存需失效）。

## 7. 运行时与交付

- Hindsight 作为 Nisse 管理的本地运行时/依赖（Supervisor 生命周期），固定版本；
- 数据根：Nisse 自有目录（M1 spike 用隔离 /tmp）；备份/恢复/升级/回滚有演练；
- 打包：不要求用户另装 Python/DB；若需运行时依赖，随安装包附带并验证签名/许可；
- 资源：记录空载/1k/10k/100k 的内存、CPU、磁盘、冷启动。

## 8. 性能与质量基准

| 指标 | 目标（待实测校准） |
|---|---|
| 检索 p95（10k/100k） | <100ms / <300ms |
| 写入延迟（不含 LLM 抽取） | <200ms |
| digest token | ≤500–1000 |
| 存储占用（典型 10k） | <200MB |
| 召回质量 | 人工标注集 recall@k/precision；冲突/时效正确率 |
| 删除验证 | 删除后检索/直查均不可召回 |
| 冷启动 | 记录（打包/首启体验） |

## 9. Go / No-Go（按 v3 §14.8）

- Go：版本固定/许可可用；本地运行可靠；Adapter 行为/性能/隐私/删除/迁移全过；打包交付可行；
- No-Go：存在无法补救的许可/隐私/运行依赖/性能/删除缺陷 → 提交证据、影响、最小补救方案与维护成本，等用户裁决；
- **不得**擅自换用其他后端或扩大为自研完整记忆引擎。

## 10. 开放问题

1. Hindsight 的官方 Node 集成方式与版本；2. 其抽取/索引是否使用外部 LLM/Embedding（费用/外发）；
3. 单写者/并发保证由谁提供；4. 数据迁移工具与格式；5. 打包体积/启动成本；6. 100k 规模上限与清理策略。


## 11. M1-C 实测结论（2026-10-21，更新开放问题）

- **Node 集成**：官方 `@vectorize-io/hindsight-client==1.0.0`（MIT，零依赖）可用；
- **LLM/Embedding 外发**：retain 会把记忆文本发往配置的 LLM（opencode-go/deepseek）；recall 本地零外部连接（lsof 证据）；首启下载 224MB 模型；无遥测/Cloud；
- **单写者**：Hindsight 本身无单写者，Adapter 以角色策略 + 跨进程 lease 实现（已验证）；
- **迁移/导出/删除**：bank 备份/恢复、native ZIP 导出、删除后不可召回已测；
- **性能**：10k 写入 p95 31–34ms；recall 默认 reranker p95 0.96s、关闭 130–136ms；存储 233MB（link 占 160MB）；
- **打包**：pip 运行时 ~1.8GB + 模型 224MB；无官方单文件 server（darwin-arm64 release 是 CLI client）→ M2 PoC；
- **100k**：未测；
- **日志**：server INFO 日志含 recall **query** 文本（不含记忆正文/密钥）→ M4 需日志脱敏策略。
- 详见 `spike/m1-c-hindsight/{REPORT.md,C0-FACTS.md,EGRESS-PRIVACY.md}`。
