# R1b 记忆质量与数据生命周期验证计划

状态：**BLOCKED（等真实 provider 凭据 + A 流打包产物）**。本轮只完成设计与脚本规格，不跑真实 LLM。
目标：证明产品形态的内置记忆在**真实模型**下满足「跨会话记得住、检索准、可纠正/删除、可备份恢复、敏感信息写前拦截」，而不是只有 mock LLM 的离线功能验证。

## 0. 前置条件（全部满足才解除 BLOCKED）

1. 真实 LLM provider key（DeepSeek/OpenAI 兼容均可）通过产品 SecretStore 写入，**不得**明文落 `config.json`；测试机可用临时 key，但不得进入仓库/日志。
2. Hindsight 服务端配置 `HINDSIGHT_API_LLM_PROVIDER=<真实 provider>` + `HINDSIGHT_API_LLM_MODEL` + `HINDSIGHT_API_LLM_API_KEY`（仅进程 env，测试结束后清除）。
3. A 流交付的打包产物（`WhaleGirlBot.app`，含 `Resources/memory/**`）可安装启动，记忆状态机为 ready。
4. 隔离数据根：每次场景使用全新 `<userData>/dsh-home/memory`，禁止使用用户真实记忆数据；真实 key 只用于本次测试。
5. 网络仅允许 LLM provider 出站；模型/DB 仍离线（`HF_HUB_OFFLINE=1`，pg0 预置）。

## 1. 数据集：≥10 条中文记忆（跨会话）

写入 12 条（`namespace=global`，kind 覆盖 fact/preference/profile/entity/project）：

| # | kind | 文本（示例） | 召回探针 |
|---|---|---|---|
| 1 | fact | 我家住在杭州西湖区，平时骑自行车上班。 | 我家住哪？ |
| 2 | preference | 我喜欢喝龙井茶，不加糖。 | 我喝什么茶？ |
| 3 | profile | 我的职业是产品经理，工作日早上九点开会。 | 我做什么工作？ |
| 4 | entity | 我养了一只叫「团子」的橘猫。 | 我的猫叫什么？ |
| 5 | preference | 我对花生过敏，点餐要避开。 | 我有什么忌口？ |
| 6 | project | 我正在做 WhaleGirl Bot 的语音周报功能。 | 我最近在做什么项目？ |
| 7 | fact | 我妹妹叫林小雨，在上海读研究生。 | 我妹妹在哪读书？ |
| 8 | preference | 周末我习惯去滨江骑行。 | 我周末喜欢做什么？ |
| 9 | profile | 我晚上十一点半睡觉，早上七点起床。 | 我的作息？ |
| 10 | fact | 我的车牌尾号是 7，周三限行。 | 我的车哪天限行？ |
| 11 | preference | 我不喜欢别人叫我「老板」，叫我名字就行。 | 怎么称呼我？ |
| 12 | episode | 上周六我和朋友去西湖边看了音乐喷泉。 | 上周六我做了什么？ |

负例（不应召回本用户记忆）：`今天天气怎么样？`、`帮我写一段 Python 快速排序`。
改写/同义探针：`住在哪儿`、`喝啥茶`、`职业`（验证 embedding 泛化，不要求 100%）。

## 2. 指标（每条探针记录）

- `recall@3`：期望记忆在 top-3 是否命中；`top1_score`、`top1_text`。
- 精确率：top-3 中无关记忆条数；**误召回率** = 探针返回里不含期望事实的会话占比。
- 延迟：recall p50/p95（每条探针跑 3 次，丢弃首次 warm-up）。
- 跨会话：DSH 会话 A 写入 → 重启应用/新建 DSH 会话 B → 会话 B 追问，回答必须体现记忆（人工判定 + 记录原始回复）。
- 纠正/删除：`/correct` 后旧文本不可召回且新文本可召回；`/delete` 后 `/list` total 下降且探针返回 0。
- 敏感拦截：写入 API key/身份证/密码类文本必须 400（`SENSITIVE`），且不产生 document；`/list` 前后 count 不变。
- 备份恢复：`/export` 产出可解析；恢复后 12 条全量可 `list`、探针 recall@3 ≥ 低于 20% 丢分；两次重启后仍可召回。
- 真实 provider 时延/费用：记录每次 retain 的 LLM token usage 与总费用（Hindsight usage 字段）。

## 3. 场景矩阵

| 场景 | 步骤 | 通过标准 |
|---|---|---|
| S1 写入 | 逐条 `POST /write`（真实 provider） | 12/12 `itemsWritten≥1`；无 5xx |
| S2 即时召回 | 14 条探针 | recall@3 ≥ 11/12；负例误召回 0 |
| S3 冷重启 | 杀进程→冷启动（数据保留） | `/health` ≤ 60s；12 条可 list |
| S4 跨会话 | 新 DSH 会话追问 5 条 | 5/5 回答体现记忆（人工 rubric） |
| S5 纠正 | `/correct` 改「住在杭州」→「搬到上海」 | 旧「杭州」不可召回；「上海」可召回 |
| S6 删除 | `/delete` + `/forget` 硬删 document | `/list` total 归零；探针 0 命中 |
| S7 备份恢复 | `/export` → 清空数据根 → 重启 → 恢复 | 12 条全量 + 探针命中率 ≥ 基线 S2 的 80% |
| S8 敏感拦截 | 写 API key、身份证号、密码 3 类 | 3/3 400 SENSITIVE；count 不变；日志无原文 |
| S9 provider 故障 | 断网/错 key 后 retain | fail-soft：记忆写失败但 Bot 主链路可用，UI 有原因 |
| S10 关闭记忆 | `memory.enabled=false` | 进程停止、无残留；语音主链路正常 |

人工判定项（S4 回答质量、S8 日志无敏感原文）需截图/原文，不得只记录程序断言。

## 4. 脚本设计

新增（不修改已有 m4 测试）：`m4/test-memory-r1b.mjs`
- 复用 `m4/memory/sidecar.mjs` 的 HTTP 契约；通过 env 接收 `MEMORY_SIDECAR_URL`/`MEMORY_TOKEN`/`MEMORY_BANK`（由产品 `runtime.json` 或测试包装器提供），不直接读内部文件。
- 子命令：`--write-only`、`--probes`、`--lifecycle`、`--sensitive`、`--backup`、`--all`。
- 每步写 `m4/evidence/R1B-<step>.json`：`{scenario, datasetHash, startedAt, records:[{step, request(redacted), status, latencyMs, result}], verdict}`；日志/原始回复另存 `m4/evidence/r1b-logs/`。
- 敏感测试的 key/身份证使用**假值但符合格式**（如 `sk-test-…`），避免真实凭据。
- 判定代码与数据分离：`PASS/FAIL/CONDITION` 由断言函数产出，人工项写 `manual: pending`。
- 运行入口：`node m4/test-memory-r1b.mjs --all --base http://127.0.0.1:<sidecar> --token <token>`。
- 证据归档：`m4/evidence/R1B-VALIDATION.json`（汇总）+ `m4/evidence/r1b-*/`。

## 5. 执行顺序与产出

1. 用户提供真实 key（SecretStore 写入）→ 解除 BLOCKED。
2. A 流打包产物安装，记忆进入 ready。
3. 跑 S1→S6（约 30–45 分钟，含 2 次重启）。
4. 跑 S7 备份恢复（约 15 分钟）。
5. 跑 S8→S10（约 15 分钟）+ S4 人工跨会话脚本（约 10 分钟）。
6. 产出 `docs/reports/R1B-RESULT.md` + `m4/evidence/R1B-VALIDATION.json`，逐项 PASS/FAIL/CONDITION/BLOCKED。

**当前结论：BLOCKED（无真实 provider key、无 A 流打包产物）。** 解阻塞条件即 §0；在解除前不得宣称 P-M1 记忆质量通过，也不得用本次 mock-LLM 的离线证据替代。
