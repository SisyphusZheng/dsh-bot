# M3 需求定义：顶层 Bot（逻辑编排）+ 长期记忆

> 状态：需求定义（2026-10-21，用户确认路线 A 后）｜目的：先说清“我们要什么”，再选型/设计
> 关联：M3-M4-DESIGN-INPUTS §11–§14、M3-PRODUCT-CONTRACT-VOICE、ADR-0002/0004/0006/0008

## 一、顶层 Bot（Route A：逻辑编排）——我们要什么

**一句话**：Bot 是**常驻的顶层 main session/角色**，在 DSH 现有“每 session 各自 main”之上做**协调层**，
负责身份/记忆/工作区/effort、快速回答、路由任务、汇总会话、接管会话；不改变 DSH session 的 root 语义。

### 1. 身份与配置
- Bot 拥有：人格（name/personality/tone/instructions）、固定工作区、默认 reasoningEffort（可配）、长期记忆入口；
- session 可覆盖配置；subagent 继承 session；Bot 的 persona 是产品统一人格，不被 session 覆盖（可局部调整语气）。

### 2. 会话管理（session registry）
- 列出/搜索会话：id、标题、状态（idle/running/waiting-approval/error）、工作区、最后活动、归属项目；
- 创建/重命名/归档/删除（删除需确认）；会话与产品“项目/对话”映射；
- 元数据操作本地快速响应（<300ms），不阻塞语音。

### 3. 路由
- 用户输入先到 Bot：可自己快速回答（L1）或路由到指定/合适 session（L2）；
- 支持显式指定（“去 nisse 那个会话”“继续刚才那个任务”）；**不得静默劫持**用户正在用的 session；
- 路由结果与依据可审计（事件记录）。

### 4. 汇总
- 会话摘要：按需/定期生成（带 token 预算），Bot 可回答“今天都做了什么”“那个任务怎么样了”；
- 跨会话汇总不重放全量历史；摘要引用来源 session/turn。

### 5. 接管/继续
- 仅能接管 idle session；接管需单写者锁，原 owner 退出；
- 支持交还/切换；冲突时明确报错，不双写；
- 接管动作可审计。

### 6. 能力与预算
- Bot 可调用 skill（DSH skill 工具）；复杂任务下放 session/subagent；
- 三层预算（Bot/session/subagent）token/费用上限与超限策略；超额提示与降级。

### 7. 审批/取消/急停
- 审批归属发起 session/agent；Bot 可展示/转述，但**语音批准高危操作仍需 UI 二次确认**；
- 停止/取消/急停跨层可达；取消后迟到结果丢弃（turnId 归属）。

### 8. 安全与失败
- Bot 不得绕过 DSH 审批/权限；跨会话操作有审计；
- DSH 不可用/超时：fail-closed，明确播报；不出现“假聆听/假执行”；
- 会话数据按项目隔离；Bot 的全局记忆读取需权限策略。

### 9. 非功能目标
- L1 首段可听 p50 ≤1.5s / p95 ≤2.5s；L2 首段 ≤3s（filler 掩盖）；
- Bot 常驻上下文 ≤ 预算（digest+最近对话），依赖 compaction；
- 重启后可恢复 session registry 与 Bot 状态；操作幂等；
- 不要求改 DSH 核心；Host Integration 契约版本化。

### 10. 验收（最小）
- 创建 3 个会话 → Bot 能列出/路由/汇总；接管 idle 会话成功且阻止双写；
- 跨层取消有效、迟到结果不播报；预算超限有提示；
- 延迟目标达标；审计事件完整。

## 二、长期记忆——我们要什么（v3 冻结：Hindsight）

> 后端固定 **Hindsight**（薄 MemoryAdapter）；不做 Mem0 对照、不自建完整引擎、不并行维护第二套自动写入的权威记忆库。
> 详细规格见 [MEMORY-SERVICE-SPEC.md](MEMORY-SERVICE-SPEC.md)。

1. **记忆类型**：画像/偏好、事实/实体（不含密钥）、事件/会话摘要、工作/项目、技能/流程。
2. **写入**：显式“记住这个”+ 设置编辑；自动抽取可开关可审计；去重/合并/冲突（不静默覆盖，按时间有效性 superseded）；
   用户可编辑/删除/导出；敏感信息写入拦截；默认单写者（Bot/Host Integration 写，subagent 只读）。
3. **读取**：命名空间（全局/项目/会话）；检索按相关性/时效/置信度；**digest token 预算 + 按需检索**；
   返回当前有效版本与来源 session/turn。
4. **生命周期**：valid_from/valid_to、confidence、来源、last_used；可配 TTL/衰减；固定/遗忘；JSONL/Markdown 导出。
5. **隐私**：本地优先；可选加密（Keychain）；日志不含记忆原文/密钥；用户可查看/删除/导出；M3 不做跨设备同步。
6. **性能/规模**：10k（M4 前 100k）检索 p95 目标 <100ms、写入 <200ms、典型存储 <200MB。
7. **集成**：Host Integration memory service + tools（search/write/forget/export）；
   DSH system prompt 注入 digest；与 DSH 会话内 compaction 分离；旧文件工作区只作迁移源。
8. **Go/No-Go 先决**：先核验 Hindsight 固定版本/许可/本地运行方式/Node SDK/依赖/数据外发/打包；
   不满足则提交证据等待用户裁决，不擅自换后端。

## 三、待你确认
1. Bot 需求（§一）是否准确/有遗漏（尤其：跨会话汇总、自动抽取开关、记忆可见性/隐私、三层预算）；
2. 是否要求“记忆跨设备同步”（M3 建议不做）；
3. 旧 `~/Documents/Nisse` 迁移范围（全部/仅 USER+MEMORY+WORKLOG+PROJECTS/先备份）。
