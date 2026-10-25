# M1 最终报告（v3 结构：M1-A / M1-B / M1-C）

> 日期：2026-10-21｜环境：macOS 26.5.1 arm64｜DSH 0.2.1-rc.2（只读安装包）｜隔离 `DSH_HOME=/tmp/nisse-m1*`；
> 未修改 DSH 核心、未写用户 `~/.dsh`/`~/Documents/Nisse`、未触碰已装 Nisse/DSH。
> 依据：`M1-WORK-PACKAGES.md`、`M1-SPIKE-PROMPTS.md`、v3 主提示词（`assistant/MASTER-CORRECTION-PROMPT-v3.md`）。

## 1. 结论

| Spike | 结果 | 证据 |
|---|---|---|
| **M1-A DSH×Voice** | **PASS（2 caveat）**：单权威、T11–T14 19/19、取消 14/14、T5 停播报 1ms/不取消任务、T7 语音审批 allow/误批防护/超时 fail-closed | `spike/dsh-voice/evidence/M1-A-REPORT.md` 等 |
| **M1-B Bot Session Orchestration** | **30/36 PASS、0 FAIL、6 UNVERIFIED（Conditional Go）**：会话管理/路由/摘要/锁/预算/审计/隔离通过；6 项依赖模型主动调探针 | `spike/m1-bot/REPORT.md` |
| **M1-C Hindsight Memory** | **Conditional Go**：39/39 确定性 + 5/5 真实 opencode-go；10k 基准/隐私/删除/迁移齐全；3 项决策（recall p95、存储、打包） | `spike/m1-c-hindsight/REPORT.md` |

**M1 判定：架构方向 Go / 完整验收 Conditional。**
理由：三个 Spike 的“单权威/不改核心/隔离/可测试”核心假设均成立；未关闭项是：
1. M1-B 6 项 UNVERIFIED（测试驱动依赖，非代码失败；审批真实语音路径已在 M1-A T7 验证）；
2. M1-B 延迟目标未达成（L1 p50 4.8s、L2 18.99s；provider/effort 主导，需 M3 快车道）；
3. M1-C 3 项条件（recall p95 0.96s、10k 存储 233MB、打包 ~1.8GB+224MB）；
4. TCC 仅在 dev Electron 验证，签名包复测留 M3/M6；
5. M1-A 语音“拒绝”未单说（文本通道已验证）；barge-in“取消任务”未单独复测。

## 2. 跨 Spike 不变量

- **DSH 唯一 Agent**：A 路线 C 前台自答/越权工具 = 0；B 所有路由/摘要/锁/预算均为 Host Integration 逻辑层，无第二执行权威；
- **不修改 DSH 核心**：B 的 E1 通过（userStateLeaks=0、app.asar sha256 不变）；A 的 route C 补丁仅在 Qwen 语音仓副本；
- **Hindsight 仅记忆**：不参与规划/工具/路由/人格；记忆外发仅 retain→配置的 LLM；recall 本地零外连；
- **隔离**：所有 spike 使用 `/tmp` 独立 DSH_HOME/凭证只读副本；用户环境零写入。

## 3. 关键指标

| 项 | 实测 |
|---|---|
| M1-A 语音：说话结束→提交 DSH | 93–280ms（W3 7 轮）；W2 141ms |
| M1-A 播报中打断→音频停 | **1ms**（T5 retest） |
| M1-A 停播报不取消任务 | PASS（muted turn 继续完成 spoke:false） |
| M1-A 取消→DSH aborted / 取消后新工具 | PASS（14/14） |
| M1-B 本地元数据 p95 | 2ms |
| M1-B L1 首响应 p50/p95 | 4800 / 5367ms（目标 1.5/2.5s，未达） |
| M1-B L2 首响应 | 18985ms（目标 3s，未达） |
| M1-C 10k 写入 p95 | 31–34ms |
| M1-C recall p95 | 0.96s（默认 reranker）/130–136ms（关闭） |
| M1-C 10k 存储 | 233–235MB（memory_links 160MB） |

## 4. 下一步（M2 前）

1. M1-B 补确定性审批/并发/工具上限探针（6 项 UNVERIFIED）；
2. M1-A 可选：语音「取消这个任务」barge-in 复测；签名包 TCC 留 M3；
3. M1-C 3 项决策：recall 目标重定、link 阈值/真实数据校准、打包 PoC（单文件 vs slim）；
4. M2 正式构建仍等：DSH 上游仓库 + 网络/构建许可；
5. M3 快车道（L0/L1/L2）与 M3-M4-DESIGN-INPUTS P1–P9 落地。

## 5. 证据边界

- 已由 M1 实测：A 的语音/文本/取消/审批/停播报；B 的 30 个验收用例；C 的安装/运行/Adapter/基准；
- 未验证：B 的 6 项模型依赖用例；C 的 100k/备份恢复演练/真实 LLM 下 observations；A 的签名包 TCC；各 Spike 的跨设备/多平台；
- 本文不把“measured”写成“promised”，不把 UNVERIFIED 写成 PASS。

## 6. 证据索引

- M1-A：`spike/dsh-voice/evidence/M1-A-REPORT.md`、`W1/W2/W3/W4/W5`、`T5-RETEST-ASSERTIONS.json`、`T5-CLASSIFIER-UNIT.json`、`w3-t7*`；
- M1-B：`spike/m1-bot/REPORT.md`、`evidence/`；
- M1-C：`spike/m1-c-hindsight/{REPORT,C0-FACTS,EGRESS-PRIVACY}.md`、`results/`、`evidence/`；
- 设计输入：`M3-M4-DESIGN-INPUTS.md`、`M3-REQUIREMENTS-BOT-MEMORY.md`、`BOT-SESSION-ORCHESTRATION.md`、`MEMORY-SERVICE-SPEC.md`。
