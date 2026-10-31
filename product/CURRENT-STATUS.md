# dsh-bot CURRENT-STATUS：唯一当前事实入口

**本文件是唯一当前事实入口；SHA/日期只在本文件维护。** 其它文档（[根 README](../README.md)、[README-MVP.zh.md](../README-MVP.zh.md)、[product/versions.json](versions.json)、[已批准版本计划](../docs/roadmap/README.zh.md)）只链接本文件，不再复制易过时的提交号、产物 SHA 与验收计数。

本文件是状态索引，不是发布声明，也不替代原始证据；结论升级必须来自新的命令输出或新证据文件，不能只改本文件的文字。状态词表：`PASS` / `FAIL` / `BLOCKED-ENVIRONMENT` / `BLOCKED-EXTERNAL` / `DEFERRED`；实现进度另用 `IMPLEMENTED` / `VERIFIED`；除 §7/§8 两节按 Lead 指示预留的结构外，本文件不保留其它占位。历史文档、`review/` 目录与既有证据保持原样，本文件只在"历史索引"给日期、提交与位置。

## 1. 当前开发提交与候选版本

| 项 | 值 |
|---|---|
| 唯一代码工作树 | `dsh-bot-closure`，分支 `work/0.0.1-closure-final` |
| 收尾基线（整合前） | `c772c2df6384c1eeef865a63a8afc0ee7c5b4a55`，tree `ac612185b53ed553acae9cc9727e4bf4bc798299`（`git rev-parse HEAD`，2026-10-31 09:47 +08 工作树干净） |
| 收尾最终提交（当前源码身份） | `089d598dfda1cf59eedb7c4b89d3a2b43a985af0`，tree `080b1c753b5c421ddf5f95c2a97c46b587c23dfe`；相对基线 `c772c2df…` 为 40 files changed, 5868 insertions(+), 242 deletions(-)（`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`git diff --shortstat c772c2df63 HEAD`）；分支 `work/0.0.1-closure-final`，**仅本地、未推送**，该提交后 `git status --porcelain` 为空（除本文件这次索引编辑） |
| 本索引更新 | 本文件这次修改位于 `089d598d…` 之后的一个文档提交，只改本文件、不改变源码身份；"当前开发提交"始终指 `089d598d…` |
| 本轮（第二轮）收尾提交 | **待 Lead 提供**：本轮源码身份与 tree（含 `unknown` 用户可见性修复，可能伴随构建产物变化）。未定稿前不写入；确定后替换本行并同步 §3/§4 的待更新项 |
| 候选产品版本 | `0.0.1-beta2`（产品版本与 Runtime 版本独立） |
| Runtime | DeepSeek Harness `0.2.1-rc.3`，tag `dsh-v0.2.1-rc.3`，commit `1f81c047fc48fa190a683e469daa699857e9afe8` |
| 候选包 | 本仓库不存放 DMG；最近候选与证据包位于工作树外的私密证据区（见 §2），文件名 `dsh-bot-0.0.1-beta2-7d15cb18-mac-arm64-unsigned.dmg` |
| 发布状态 | 未打 tag、未建 Release、未公证；分支仅本地、未推送；合并由 Lead 与用户决定，本文件不预判 |

版本身份：`product/versions.json` 与 `apps/desktop/package.json` 均为 `0.0.1-beta2`，Runtime 固定 `0.2.1-rc.3`。**构建/打包身份对新源码尚未验证**：新源码 `089d598d…` 无对应 DMG，见 §2.1 与 §4 G0；用例与包证据仍绑定旧源码 `7d15cb18…` 的候选。

## 2. 最近验收提交及产物 SHA

| 项 | 值 |
|---|---|
| 最近一次完成的原生打包验收 | 运行 `acceptance-1793379224`，`status=PASS`，15/15 阶段 PASS，`updatedAt=2026-10-30T16:55:22.138Z`（= 2026-10-31 00:55 +08） |
| 验收绑定源码 | `7d15cb1878a9bb9896199ee285ebeb71708315fb`，tree `201562bdb61b75a88fa3f7a63342f8cac81c1cc6`（= 收尾基线 `c772c2df…` 的父提交） |
| 产物 DMG | `dsh-bot-0.0.1-beta2-7d15cb18-mac-arm64-unsigned.dmg`，702,399,055 B |
| 产物 SHA-256 | `dda3e8ec6a2cc461ab66e64f330a904f501c4fed59ba93fa6ea56e16a9075b82`（`shasum -a 256` 于 2026-10-31 09:49 +08 复核，与 RESULTS.json、构建 manifest、gate-map 三处记录一致） |
| 自动化门禁 | B2-G01…B2-G18 = 18/18 PASS（automated evidence level，0 FAIL）；边界 16×`BLOCKED-ENVIRONMENT`、8×`BLOCKED-EXTERNAL`、1×`DEFERRED` |
| 三轮回放 | 3/3 轮 PASS，均首次启动成功，每轮同一 DMG SHA；包内 app.asar sha `da923fe8497f3f62d17ba31393ea76f3d4a2797374299411275c26240463e7db` |
| 声学与原生边界 | 同候选 RESULTS.json：`voice = BLOCKED-EXTERNAL`（真实 provider/麦克风未测）；`nativePointerAndTcc = DEFERRED`（物理点击穿透、Spaces、TCC 需人工） |
| 证据位置 | 私密证据区 `dsh-bot-candidates/beta2/7d15cb18/`（`FINAL-REPORT.md`、`gate-map.json`、`stability-summary.json`、`SHA256SUMS`）；原始日志在 beta2 构建工作树 `.agent/evidence/beta2/run-20261030T142317Z/` 与 `.mvv-build/acceptance-1793379224/`。以上均未提交入库 |

### 2.1 最近验收绑定 ≠ 当前开发身份

- 相对验收绑定源码，收尾基线 `c772c2df…` 只改 4 个验收工具脚本：`product/tools/accept-beta2-macos.sh`、`product/tools/accept-native-beta2.mjs`、`product/tools/gate-map.mjs`、`product/tools/stability-beta2.mjs`（`git diff --stat 7d15cb18 c772c2df` → 4 files changed, 479 insertions(+), 109 deletions(-)），不改变打包字节。
- 收尾最终提交 `089d598d…`（相对基线 40 files / +5868 / −242）已产生，**无对应 DMG/打包验收**。因此当前状态是：**工程门禁证据绑定 `7d15cb18…` 候选（旧源码）；收尾源码身份 `089d598d…` 尚无打包验收**。
- 不得把 `c772c2df…`、`089d598d…` 或后续文档提交称为"当前候选已验收"。Stage D 重建后，新 DMG 必须重跑 `accept-macos.sh` / `accept-beta2-macos.sh`、`gate-map.mjs` 与三轮回放，才能替换 §2 的"最近验收"行；旧候选移入 §6.2。

## 3. E / U / R 三层状态

| 层 | 定义 | 状态 | 依据与缺口 |
|---|---|---|---|
| E：工程完成 | 实现与确定性测试、构建、原生启动/退出、基础记忆存储与检索闭环 | **源码级门禁 PASS（含安全 S1–S3 与协议 F1）；打包验收未重做** | 源码级：S1–S3、F1、G5 与构建/单测/冒烟实测见 §4 与 §4.2。打包：最近验收绑定 `7d15cb18…` 候选（旧源码，DMG `dda3e8ec…`）；收尾源码身份 `089d598d…` **尚无对应 DMG/打包验收**。不把 E 写成最终 PASS |
| U：内测可用 | E 加真实 Provider、真人语音、TCC、任务审批/取消、自然对话记忆与持续试用证据 | **未 PASS**（`BLOCKED-EXTERNAL` + `DEFERRED` + `NOT-STARTED`） | 真实 Provider/麦克风未测（`BLOCKED-EXTERNAL`）；TCC、点击穿透、Spaces、多屏 `DEFERRED`/`BLOCKED-ENVIRONMENT`；真实个人 Hindsight 库未验（验收只用隔离 run-local bank）；日常试用 G12 未开始（需 3–5 名用户一周） |
| R：公开发行 | 签名、公证、更新源与正式发布身份 | **NOT-STARTED** | 当前仅 ad-hoc 内部签名；无 Developer ID/公证、无更新 feed；bundle id `ai.nisse.app` 仍为内部暂定；B2-G17 = `DEFERRED` |

E PASS 不等于 U PASS，U PASS 不等于 R PASS。历史 PASS 不是当前 PASS；fixture/mock 证据不是真人或真实 Provider 证据。上表"E 层"的 PASS 是源码级门禁（含 S1–S3 与 F1），**不含打包验收**（未重做）；U/R 层结论不变。

**第二轮待更新项（未定稿，等 Lead 结论）**：①E 层——`unknown` 用户可见性修复合并后，复核 E 层是否仍为源码级 PASS（含 S1–S3/F1 是否受影响）；②U 层——`unknown` 相关用户可见性证据待登记（见 §7）；③R 层不变。

## 4. 核心门禁及明确缺口

门禁编号沿用收尾计划书 §6（G0–G12）与 §3–§5（S1–S3、F1）；状态只来自列出的证据。

| 门禁 | 状态 | 证据 | 明确缺口 |
|---|---|---|---|
| G0 身份与构建 | NOT-VERIFIED（新源码无包） | 身份证据仅对旧候选成立：`7d15cb18…` + DMG `dda3e8ec…` 与 manifest/gate-map 一致 | 新源码 `089d598d…` 无 DMG；Stage D 重建并重跑打包验收前不得沿用旧 PASS |
| G1 安装与首启 | PASS | 15/15 阶段含 `native-signatures`、`first-launchservices`、`first-bridge`、`first-web-boot-and-navigation`、`first-memory` | 隔离 user-data（非隔离 HOME 沙箱）；真实账户安装属 U |
| G2 首次配置 | BLOCKED-EXTERNAL | 自动验收无真实 Key 引导 | 无预置 Key 的引导、错误 Key 恢复、凭据无泄露需用户 Key |
| G3 文本任务 | 夹具级 PASS；真实 Provider `BLOCKED-EXTERNAL` | gate-map B2-G04（Mock Provider）；`verify-local` 全套 | 真实 DSH 工具任务与真实终态需真实 Key |
| G4 真人语音 | BLOCKED-EXTERNAL | RESULTS.json `voice` 字段 | 真麦克风→ASR→DSH→TTS、连续十轮、回声/打断 |
| G5 审批安全 | 源码级 PASS（S1 证据）；真实双窗口人工竞速 = BLOCKED-EXTERNAL | S1 源码级 PASS（见 §4.1）；B2-G01 自动化证据 PASS（host kernel 级） | 真实双窗口/多端竞速尚需人工验收；S1 边界见 §4.1 |
| G6 取消与恢复 | 自动化 PASS；真实 Provider `BLOCKED-EXTERNAL` | gate-map B2-G07、B2-G08 | 真实 Provider 下的取消确认仍需活体 turn |
| G7 记忆体验 | 包内写入/跨会话/重启召回 PASS（隔离 bank）；真实个人库 `BLOCKED-ENVIRONMENT` | 15 阶段中 `memory-write-and-cross-session`、`memory-restart-recall` | 真实个人 Hindsight 库、查看/纠正/删除/导出、备份恢复待验 |
| G8 故障恢复 | 夹具级 PASS | gate-map B2-G08、B2-G14（dev-doctor） | 网络/丢包真实故障注入 `BLOCKED-ENVIRONMENT` |
| G9 原生交互 | DEFERRED | RESULTS.json `nativePointerAndTcc`；gate-map 多显示器/全屏边界 | TCC、物理点击穿透、Spaces、多屏（本机单显示器） |
| G10 退出重启 | PASS | `first-shutdown`、`first-descriptor-cleanup`、`restart-shutdown`、`restart-descriptor-cleanup` | — |
| G11 复测稳定 | PASS | 三轮回放 3/3 首次成功、同一 DMG SHA | 长期稳定不属于三轮机械冒烟 |
| G12 日常试用 | NOT-STARTED | — | 作者连续使用 + 3–5 名技术友好用户一周（需用户招募同意） |
| S1 默认权限与越界审批 | PASS（源码级） | 收尾 S1 修复与副作用断言测试（Lead 整合，命令见 §9） | 仅覆盖已声明支持的执行入口（fs 工具族、bash 工具）；不构成"任意恶意程序"的证明；未覆盖 MCP 工具子进程（默认未挂载）、持久终端、computer-use/CUA/browser-use（未挂载，屏幕开关仅尽力而为）、PTC `run_code`（静态确认有 policy，未跑真实用例）；迁移提示载体较窄（`permission-migration.json`、`/bot/status.permissionNotice`、audit、`/health.agent.permission`） |
| S2 取消入口统一 | PASS（源码级） | 收尾 S2 修复与测试（Lead 整合） | breaking change：未升级旧客户端会收到 `400 CANCEL_TARGET_REQUIRED` + `upgrade` 提示；legacy 客户端"先读 `/task-state` 再取消"之间若 turn 结束会得到 `STALE_TURN`（不取消，而非取消错的） |
| S3 凭据并发与原子性 | PASS（源码级，未降级） | 收敛到"同一写入协议 + 同一把锁"（`withFileLock(<doc>.lock)` + `writeFileAtomic`，Desktop 等待 40s > 上游持有 30s）；负向对照：无锁写法 10 轮×8 进程丢 32/80 refs → 修复后 0 | 唯一 `DEFERRED`：Desktop 写路径不保留 `.credentials.yaml` 注释/排版（键值与顶层字段不丢）；存储是 0600 私有文件，不是 Keychain 加密 |
| F1 正式状态与桌面投影 | PASS（协议/投影级） | 四句验收均成立：两个界面不会批准不同操作；旧选项序号不会回答新问题；重连不自动重放任务（含崩溃 `unknown` 与优雅 `cancelled` 两类 Host 级证据）；UI 不伪造完成（投影级） | 既有缺口：`snapshot@1` 的 `interactions` 不投影 `unknown`（基线即如此，非本次引入）→ `DEFERRED`；unknown 语义在 registry 层正确 |
| B2-G01…G18（自动化） | 18/18 PASS（automated evidence level） | `gate-map.json`（sourceCommit `7d15cb18…`，artifactSha256 一致） | 绑定旧候选源码 `7d15cb18…`，不作为新源码 `089d598d…` 的证据；其中 B2-G01/G03/G07、B2-G15 的结论层级见 §4.1 |

**第二轮待更新项（未定稿，等 Lead 结论）**：①F1 行——`snapshot@1` 的 `interactions` 不投影 `unknown` 的既有 `DEFERRED` 是否被本轮修复关闭；②G0 仍为 NOT-VERIFIED，直到 Stage D 重建；③B2 行——若本轮构建产物变化，旧候选绑定注记需复核；④`unknown` 修复与回滚演练的登记结构见 §7/§8。

### 4.1 S1–S3 / F1 结论明细（Lead 整合，源码级）

- **S1 默认权限与越界审批：PASS（源码级）**。覆盖范围仅为已声明支持的执行入口：文件系统工具族与 bash 工具；不构成"任意恶意程序"的证明。未覆盖入口：MCP 工具子进程（默认未挂载）、持久终端、computer-use/CUA/browser-use（未挂载，屏幕权限开关仅尽力而为）、PTC `run_code`（静态确认存在 policy，未跑真实用例）。迁移提示载体较窄：`permission-migration.json`、`/bot/status.permissionNotice`、audit、`/health.agent.permission`。
- **S2 取消入口统一：PASS（源码级）**。breaking change：未升级的旧客户端会收到 `400 CANCEL_TARGET_REQUIRED` + `upgrade` 提示；legacy 客户端"先读 `/task-state` 再取消"之间若 turn 已结束，会得到 `STALE_TURN`（拒绝取消，而不是取消错的任务）。
- **S3 凭据并发与原子性：PASS（源码级，未降级）**。收敛到"同一写入协议 + 同一把锁"（`withFileLock(<doc>.lock)` + `writeFileAtomic`；Desktop 等待 40s > 上游持有 30s）。负向对照：无锁写法 10 轮 × 8 进程丢 32/80 refs → 修复后 0。唯一 `DEFERRED`：Desktop 写路径不保留 `.credentials.yaml` 注释与排版（键值与顶层字段不丢）。存储是 0600 私有文件，不是 Keychain 加密。
- **F1 正式状态与桌面投影：PASS（协议/投影级）**。四句验收成立：两个界面不会批准不同操作；旧选项序号不会回答新问题；重连不自动重放任务（含崩溃 `unknown` 与优雅 `cancelled` 两类 Host 级证据）；UI 不伪造完成（投影级）。既有缺口（基线即如此，非本次引入）：`snapshot@1` 的 `interactions` 不投影 `unknown` → `DEFERRED`；unknown 语义在 registry 层正确。

### 4.2 本轮实测（源码级；命令见 §9）

- `node --test product/pet/tests/*.test.mjs nisse/packages/host-integration/tests/*.test.mjs product/tools/tests/*.test.mjs` → **369/369 pass，exit 0**（host-integration 单包 161 → 224）。
- `pnpm run build` → **9 gates passed / 0 failed，exit 0**。
- `NODE_USE_ENV_PROXY=0 pnpm exec vitest run --maxWorkers=1 <verify-local 的 spec 列表，含新增 7 spec>` → **29 files + 1 skipped / 524 tests pass，exit 0**（基线 23 files / 480 tests）。**1 个 skip 必须按原样理解**：`apps/desktop/tests/f1-m2-memory-e2e.spec.ts` 使用 `describe.skipIf(!ENABLED)`，需要 `CLOSURE_M2_ROOT` 提供隔离 Hindsight；未设置时跳过而不是假装通过；提供运行环境后的终版重跑为 1/1 PASS。
- `node product/tools/smoke-host.mjs` 与 `node product/tools/smoke-host.mjs --default-provider` → 均 **exit 0**；`smoke-wake-word`、`smoke-pet-ui`、`check-built-resources` → 均 **exit 0**。
- `node product/tools/dev-doctor.mjs --json` → **exit 1 = BLOCKED-ENVIRONMENT**：3 项 FAIL 全部是隔离工作树缺 dev 构建输入（Electron 可执行文件、`.mvv-build/memory`、`.mvv-build/voice-venv`），不是代码回归；补齐命令：`bash product/tools/build-memory.sh` 与 `uv` 语音环境准备。
- 语音 Python 单测 → **BLOCKED-ENVIRONMENT**（无 voice venv；beta2 基线 101 cases OK）。

文档门禁（本文件改动前实测）：`verify-product-docs` → exit 0；`verify-upstream` → exit 0（16347 official files / 47 explicit product overrides）。KNOWN-DEVIATION（改动前既有、独立于本次收尾，不改写、不冒充已修复）：全库 `verify-translation-pairing` exit 1（9 处产品新增 zh-only 文档，缺英文对与 `.i18n.yaml`）；`verify-repository-references` exit 1（**180 处改动前既有 + 33 处本索引 = 213**；早期 206 是索引上一版测量值。归因与处置方案见私密 `round2/GATE-DEVIATION-PROPOSAL.md`，A/B/C 均未实施）；`verify-md-wrap` 报告 `README.md:126` / `README.zh.md:126` 两个既有 HTML 锚点行。索引记录提交号与上游"维护文件禁止记录 commit"规则的冲突需要 Lead/上游策略决定；**不得删除索引里的提交身份来掩盖该偏差**，只能按提案改变身份存放位置/形式或对明确范围做规则适配。

## 5. 用户需配合事项

1. **真实 Provider / API key 授权**：在 DSH 设置 → Bot 填入 LLM 与 DashScope Key（或提供测试 Key），解锁 G2/G3/G4 与真实语音链路；凭据与费用归用户，产品不代持。
2. **真实麦克风与真人语音**：安静环境、外放回声、耳机、连续十轮、抢话、停止播报分别验证（G4/G5）。
3. **TCC / 点击穿透 / Spaces / 多屏 / 物理拖动**：在 Finder 与系统设置中人工授权并操作，提供截图或录屏（G9）；本机为单显示器，多屏项记录为 `BLOCKED-ENVIRONMENT`。
4. **批准 Stage D 打包构建**：用收尾源码身份 `089d598d…` 重建 DMG 并重跑打包验收；需要释放 **≥ 20 GiB 磁盘** + 数小时窗口（当前可用约 10 GiB）。未批准前，新源码不存在可绑定的打包证据。
5. **批准 4 条旧产物删除**：合计 **5.61 GiB**，需逐条确认；当前 **0 条已删**。确认前保持 `WAITING-USER`。
6. **回滚基线拍板**：是否把 `0.0.1-beta-f801a59b`（DMG `7acadd6b…`，702,230,791 B）定为正式回滚基线——它是当前唯一"有验收记录 + 有产物哈希"的上一已验收候选；数据格式 beta1↔beta2 兼容性尚未验证（见 §6.3）。
7. **发布授权（签名/公证/更新源）**：R 层需要 Apple Developer 账号与证书、公证流程与正式更新 feed 决策。
8. **试用招募（G12）**：作者连续使用并记录，随后 3–5 名技术友好用户一周试用；需要用户同意招募渠道与试用数据范围。
9. **远期路线变更批准**：变更提案在私密交接目录 `ROADMAP-CHANGE-PROPOSAL.md`，状态 `PENDING-USER-APPROVAL`；未批准前不修改权威路线图文件。

## 6. 当前下一步与历史索引

### 6.1 当前下一步

| 步骤 | 工作 | 依赖 | 完成判据 |
|---|---|---|---|
| 1 | 整合 S1–S3 与 F1 的结论：逐项给 PASS/FAIL/BLOCKED 与缺口，更新 §4 | — | **已完成**：见 §4、§4.1（源码级 PASS 与边界） |
| 2 | 生成唯一收尾提交并填写 §1 | 步骤 1 | **已完成**：`089d598d…`（40 files / +5868 / −242）；本文件更新在随后一个文档提交 |
| 3 | Stage D：用新源码身份重建 DMG，重跑 `accept-macos.sh`、`gate-map.mjs`、三轮回放 | 用户配合项 4（≥ 20 GiB 磁盘 + 数小时窗口） | 新 DMG SHA 与 sourceCommit 一并替换 §2；旧候选入 §6.2 |
| 4 | 真实 Key / 真人语音 / TCC 人工验收 | 用户配合项 1–3 | G2–G5、G9 有绑定同一产物的证据 |
| 5 | 试用与体验指标 | 用户配合项 8 | G12 与计划书 §6.1 指标有分母与失败定义 |
| 6 | 旧产物清理执行、路线变更批准 | 用户配合项 5、9 | 清理记录与批准状态可复核 |
| 7 | 回滚基线定案 | 用户配合项 6 | 正式回滚点写入 §6.3 与 §8.1（回滚演练结论） |

每一步只更新本文件对应行；其它文档不复制这些数字。

### 6.2 历史索引（只读，保持原样）

| 日期 | 里程碑 | 绑定提交 / 产物 | 结论 | 位置 |
|---|---|---|---|---|
| 2026-10-24 | v0.1 内部 MVP（Runtime rc.2） | 产品 0.1.0；现存 DMG 实测 SHA-256 `2ee96bb2…`（文档记录 `120e7b83…`，重建后未回写，差异如实保留） | INTERNAL MVP — CONDITIONAL，P-M1…P-M7 多为 IN PROGRESS | [.agent/docs/MVP-ACCEPTANCE-0.1.md](../.agent/docs/MVP-ACCEPTANCE-0.1.md)、`nisse/dist/v0.1/` |
| 2026-10-27 | beta1 线路与已批准 0.0.1–1.0 任务书 | 基线 tag `0.0.1-beta1` = `de5f10dc…` | 计划冻结，不是实现 | [docs/roadmap/README.zh.md](../docs/roadmap/README.zh.md)、[docs/roadmap/baseline.json](../docs/roadmap/baseline.json)、[README-MVP.zh.md](../README-MVP.zh.md) |
| 2026-10-29 | `0.0.1-beta` 候选系列原生验收 | `f3b593b2…`、`4aa3b8d3…`、`63bb2c43…`、`c2ae35b2…`、`f801a59b…`（各有 review 目录与 DMG SHA） | 各轮自动验收 15/15 PASS；真人声学/Provider 仍阻塞 | [review/](../review/) 各 `STATUS*.md` |
| 2026-10-30 | beta2 候选 2 | `6a6cdfd8…`；DMG SHA-256 `377345c6…` | SUPERSEDED（被候选 3 取代：候选 3 之前的 `7d15cb18` 修复了 `/health` 安装路径脱敏与桌面存在性推导后重建） | 私密证据 `dsh-bot-candidates/beta2/6a6cdfd8/` |
| 2026-10-31 00:55 +08 | beta2 候选 3（最近验收） | `7d15cb18…`；DMG SHA-256 `dda3e8ec…` | PASS（自动 15/15 + B2 18/18 + 稳定 3/3） | 见 §2 |
| 2026-10-31 | 交付 HEAD（仅验收工具改动） | `c772c2df…` | 不改变打包字节，不是新候选 | 私密证据 `FINAL-REPORT.md` |

历史记录保持原样：上表只新增日期、提交与位置，不重写任何历史结论；历史失败（例如候选 3 的 G18 首轮夹具下只有 1/3 回放、之后修复夹具侧激活时序才 3/3；v0.1 的 BLOCKED 项）继续记录在各自文档中。

### 6.3 回滚基线状态

| 项 | 状态 | 证据 |
|---|---|---|
| 上一已验收候选（当前唯一"有验收记录 + 有产物哈希"） | 可用；是否定为正式回滚基线需用户拍板（见 §5 第 6 项） | `0.0.1-beta` 构建 `f801a59ba957e01418d70ea8d44f55b965d10117`；DMG 实测 SHA-256 `7acadd6b…`、702,230,791 B；绑 `acceptance-1793287717/RESULTS.json` 15/15 PASS（[验收记录](../review/0.0.1-mac-bubble-level-2026-10-29/STATUS.zh.md) 写 702,229,423 B，与实测不一致，以实测为准） |
| 仅构建可验证的回滚点 | 构建可验证，验收记录未绑定 | beta2 候选 2 `6a6cdfd8…`，DMG 实测 SHA-256 `377345c6…`、702,479,827 B |
| 记录中的回滚包（`76d13562…`） | ROLLBACK-RECORD-DRIFT + VERIFIED-AT-ALTERNATE-PATH | 记录路径失效（`nisse/dist/v0.0.1-beta/` 现只剩 `SHA256SUMS.txt`，记录路径 `$HOME/projects/dsh-bot-workspace/dist/…` 本机不存在），但 DMG 在本机替代路径存在且可验证：`nisse-dsh/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg`，实测 **SHA-256 `76d13562…`、779,421,007 B**（与记录值及 `nisse/versions.json.sizeBytes` 一致）。**不是"文件缺失/不可验证"** |
| `nisse/dist/rc3-closure/` 同名 DMG | 未验收，不作为回滚包 | 实测 SHA-256 `6dc0db38…`（不是 `76d13562…`）；来源是 2026-10-25/26 本地构建（`mvp/rc3-closure` @ `8c34e669…`），材料目录中的本地验收报告（`nisse/review/rc3-closure-2026-10-25/LEAD-LOCAL-ACCEPTANCE.zh.md`，非本仓库文件）结论为"不建议按已交付 MVP Candidate 接受"（4 个 High 未解决），仅核心运行链路实测通过 |
| 回滚链完整性（计划书 §8.3） | **有条件 SATISFIED** | 有可验证的上一已验收候选（`f801a59b`）+ 仅构建可验证的候选（`6a6cdfd8`）；但数据格式 **beta1↔beta2 兼容性未验证**，且正式回滚基线尚未由用户拍板 |

## 7. 本轮 `unknown` 用户可见性修复（结构预留，待 Lead 提供）

> 本节按 Lead 指示预留登记结构；**内容留 TODO**，未获结论前不得填入推断值，也不得据本节修改 §3/§4 的结论。

| 字段 | 要登记的内容 | 状态 |
|---|---|---|
| 问题 | 用户可见的 `unknown`（任务/审批结果未知）在主窗口与气泡上的原状与缺口 | TODO：待 Lead 提供 |
| 修复范围 | 受影响模块/文件（Host 投影、pet/气泡、Desktop），以及是否改变 `snapshot@1`/协议语义 | TODO |
| 提交 | 本轮最终提交与 tree（与 §1"本轮（第二轮）收尾提交"一致） | TODO |
| 证据 | 新增/更新的测试名、运行命令、退出码（不得只写"已修复"） | TODO |
| 用户可见性验收 | 用户实际看到的状态；与"官方结果先到""Host 崩溃 unknown""优雅 cancelled"等既有证据的关系 | TODO |
| 结论 | `PASS` / `FAIL` / `BLOCKED-*`（含未覆盖边界） | TODO |
| 关联 | §4 F1 行 `snapshot@1 interactions` 不投影 `unknown` 的既有 `DEFERRED` 是否因此关闭 | TODO |

## 8. 回滚演练结论（结构预留，待 Lead 提供）

> 三个分类互斥：同一产物只能出现在一处；未演练的项写 `TODO` 或 `DEFERRED`，不得预设"可用"。

### 8.1 正式可用回滚基线

| 字段 | 要登记的内容 | 状态 |
|---|---|---|
| 产物 | DMG 路径、文件 SHA-256、字节数（产物 SHA-256 不触发提交身份门禁） | TODO |
| 绑定源码 | commit/tree 与验收记录（acceptance run id） | TODO |
| 数据格式兼容性 | beta1↔beta2 迁移/回滚是否有实测结论 | TODO |
| 演练证据 | 安装→启动→执行任务→退出→回滚→数据保留的全过程与退出码 | TODO |
| 结论 | `可用` / `不可用`（附理由） | TODO |

### 8.2 回滚候选

| 字段 | 要登记的内容 | 状态 |
|---|---|---|
| 产物 | DMG 路径、SHA-256、字节数 | TODO |
| 与基线差距 | 缺哪项证据（绑定源码/验收记录/数据格式兼容性）才不能升级为正式基线 | TODO |
| 结论 | `候选（待补齐 X）` | TODO |

### 8.3 不可回滚

| 字段 | 要登记的内容 | 状态 |
|---|---|---|
| 产物或记录 | 明确不可回滚的对象（例如记录与文件不一致、未验收） | TODO |
| 理由 | 为何不可回滚（哈希不符/文件缺失/版本不兼容/未验收） | TODO |
| 处置 | 保留原因、是否需要用户决策 | TODO |

## 9. 取数与复核

第一轮取数与门禁实测在 2026-10-31 09:43–10:06 +08；第二轮（收尾提交后）的权威事实与实测结果由 Lead 整合提供（2026-10-31），命令与结果如下。`<EVID>`、`<CANDIDATES>`、`<NISSE>`、`<NISSE_DSH>` 为私密证据区占位符（本文件不公开本机绝对路径）。

```bash
# 仓库身份与候选版本
git rev-parse HEAD; git rev-parse HEAD^{tree}; git rev-parse --abbrev-ref HEAD; git status --porcelain
git diff --stat 7d15cb18 c772c2df; git diff --shortstat c772c2df63 HEAD
node -p "require('./product/versions.json').product.version"     # 0.0.1-beta2
node -p "require('./apps/desktop/package.json').version"         # 0.0.1-beta2
node -p "JSON.stringify(require('./product/versions.json').runtime)"

# 最近验收（只读私密证据区）
node -p "const r=require('<EVID>/acceptance-1793379224/RESULTS.json'); [r.status,Object.keys(r.phases).length,r.sourceCommit,r.dmg.sha256,r.voice,r.nativePointerAndTcc].join(' | ')"
node -p "JSON.stringify(require('<EVID>/gate-map.json').summary)"
node -p "JSON.stringify(require('<CANDIDATES>/beta2/7d15cb18/stability-summary.json').overall)"
shasum -a 256 <CANDIDATES>/beta2/7d15cb18/*.dmg; stat -f "%z" <CANDIDATES>/beta2/7d15cb18/*.dmg

# 收尾源码级测试 / 构建 / 冒烟（本轮，Lead 整合）
node --test product/pet/tests/*.test.mjs nisse/packages/host-integration/tests/*.test.mjs product/tools/tests/*.test.mjs
pnpm run build
NODE_USE_ENV_PROXY=0 pnpm exec vitest run --maxWorkers=1 <verify-local 的 spec 列表，含新增 7 spec>
node product/tools/smoke-host.mjs; node product/tools/smoke-host.mjs --default-provider
node product/tools/smoke-wake-word.mjs; node product/tools/smoke-pet-ui.mjs; node product/tools/check-built-resources.mjs
node product/tools/dev-doctor.mjs --json

# 回滚点与漂移
shasum -a 256 <CANDIDATES>/0.0.1-beta-f801a59b/*.dmg
shasum -a 256 <CANDIDATES>/beta2/6a6cdfd8/*.dmg
ls -la <NISSE>/dist/v0.0.1-beta/; cat <NISSE>/dist/v0.0.1-beta/SHA256SUMS.txt
shasum -a 256 <NISSE>/dist/rc3-closure/*.dmg
shasum -a 256 <NISSE_DSH>/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg; stat -f "%z" <NISSE_DSH>/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg   # 76d13562…（779,421,007 B）
node -p "const r=require('<EVID>/acceptance-1793287717/RESULTS.json'); [r.status,Object.keys(r.phases).length].join(' | ')"
cat <NISSE>/dist/v0.1/SHA256SUMS.txt; shasum -a 256 <NISSE>/dist/v0.1/*.dmg

# 文档门禁
node product/tools/verify-product-docs.mjs    # exit 0
node product/tools/verify-upstream.mjs        # exit 0

# 门禁偏差取数（第二轮）
pnpm exec tsx scripts/verify-repository-references.ts   # exit 1；当前 213 处（180 既有 + 33 本索引）
pnpm exec tsx scripts/verify-translation-pairing.ts     # exit 1；9 处既有（英文对缺失）
pnpm exec tsx scripts/verify-md-wrap.ts                 # exit 1；2 处既有（README 两个 HTML 锚点行）
# 逐条归因脚本与 26→33 计数脚本见私密提案 GATE-DEVIATION-PROPOSAL.md 附录 A/B
```

## 10. 维护规则

- 只在打包验收、门禁结论或开发身份变化时改本文件；一行一处事实，不要把证据解释扩写成叙述。
- 任何重新构建都产生新身份：更新 §1/§2，并把上一候选移入 §6.2；不得只替换文字而保留旧 SHA。
- 不把历史 PASS 当当前 PASS；不把 fixture/mock 证据当真人或真实 Provider 证据；无法验证时写 `BLOCKED-*` / `DEFERRED`，不写"条件通过"。
- 改根 `README.md`、`README.zh.md`、`README.i18n.yaml` 后必须同步登记：在 `product/upstream-allowlist.json` 更新对应 blob SHA（`git hash-object <file>`），并用 `pnpm exec tsx scripts/verify-translation-pairing.ts --write README.md` 重录双语配对；否则 `verify-upstream` 或 `verify-translation-pairing` 会失败。
- 本文件自身的更新提交不改变源码身份（§1 的 `089d598d…`）；不需要因此重建或重新打包验收。
- 不得为让 `verify-repository-references` 变绿而删除或隐藏本文件中的提交身份；该门禁偏差（180 处改动前既有 + 33 处本索引）按私密提案 `round2/GATE-DEVIATION-PROPOSAL.md` 的评审结论处置，修改上游 `scripts/**` 必须经用户批准。
- 提交前分别运行 `node product/tools/verify-product-docs.mjs` 与 `node product/tools/verify-upstream.mjs`，两个都要 exit 0。
