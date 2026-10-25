# M4-7/8 报告：安全策略与审计（2026-10-22）

> 状态：**完成（v0，工具级策略）**｜验收：`m4/evidence/M4-SECURITY-AUDIT-RESULT.json` **6/6 PASS**。

## 1. 实现

- **audit**：`$DSH_HOME/nisse/audit.jsonl`，记录 `approval.requested/decided`、`session.cancelled`、`persona.changed`、`policy.added/removed/auto_allow`；`GET /audit` 查询；
- **always-allow**：`/policies` 支持 `toolName`、`pathPrefix`、`reasonPattern`、`ttlMs`、`expiresAt`；审批 handler 先匹配未过期策略，命中则 `allowed-once` 并审计；DELETE 撤销；过期自动清理；
- **审批绑定**：approvalId 由 Host Integration 生成；错误 id 返回 404；decision 只影响对应挂起审批；
- **秘密扫描**：audit/host log 不含 bridge token、`sk-…`、`OPENCODE_GO_API_KEY=…`。

## 2. 验收

| 步骤 | 结果 | 说明 |
|---|---|---|
| always-allow（工具级，TTL 60s） | PASS | 工作区外 write 自动放行并创建文件；无 approval 弹窗；audit `policy.auto_allow` |
| revocation | PASS | 删除策略后再写 → approval.requested；错误 approvalId 404；拒绝不写文件 |
| TTL expiry | PASS | TTL 800ms 过期后写 → 需审批；过期规则不在列表 |
| 取消 + 人格审计 | PASS | audit 含 session.cancelled/persona.changed/approval.* |
| 秘密扫描 | PASS | audit/host log 无 token/key |

## 3. 已知限制（重要）

- DSH 的 approval reason 是**自然语言且会被截断**，Host Integration 无法从 reason 稳定解析完整路径；因此 v0 always-allow 的 scope 实际是**工具级**（`pathPrefix` 仅在 reason 文本包含时生效，不保证）。真正的路径级策略需要 DSH 结构化审批元数据或 Host Integration 在提交前预判（M4-9/M5 安全增强）。
- L3 默认拒绝、审批过期/撤销的完整矩阵仍需安全测试套件覆盖；
- 高危操作 UI 二次确认属于产品层（M4-4/UI）。
