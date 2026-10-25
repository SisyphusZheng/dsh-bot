# M4-5 报告：人格单一来源与下一轮生效（2026-10-22）

> 状态：**完成**｜实现：Host Integration v0 persona 持久化 + agent-scoped system prompt section + 换人格时 dispose/resume 刷新。
> 验收：`m4/evidence/M4-PERSONA-RESULT.json` **5/5 PASS**。

## 1. 行为

- persona 存储：`$DSH_HOME/nisse/persona.json`（name/personality/tone/instructions，长度限制）；
- 默认人格：Nisse（自然/可靠/简短）；
- `GET /persona` / `POST /persona`；
- 创建/恢复 agent 时通过 `ctx.agents.create({setup})` 注册 `nisse-persona` system prompt section（order 120，只作用于该专用会话）；
- 修改人格后：dispose 当前 agent → 同一 sessionId 通过 `ctx.agents.resume` 恢复（带新 prompt section）；下一轮生效；
- 人格只影响“怎么说”，事实/工具仍来自 DSH。

## 2. 验收

| 步骤 | 结果 |
|---|---|
| 默认人格读取 | PASS |
| 设置「回答末尾加【蓝】」→ 下一轮回答含【蓝】 | PASS（4.1s） |
| 再改为【橙】→ 下一轮含【橙】且不含【蓝】 | PASS（3.6s） |
| persona.json 持久化 | PASS |

## 3. 说明

- 当前 persona 通过 Host Integration 的 IPC 读写；产品层设置 UI（M5）后续接入；
- 换人格会短暂 dispose/resume agent；对话历史保留（同一 sessionId），但会多一个停顿；
- 未测：并发 turn 中换人格（需串行化策略，M4-9/M5）。
