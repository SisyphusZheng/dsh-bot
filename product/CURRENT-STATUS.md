# dsh-bot CURRENT-STATUS：唯一当前事实入口

**本文件是唯一当前事实入口；SHA/日期只在本文件维护。** 其它文档（[根 README](../README.md)、[README-MVP.zh.md](../README-MVP.zh.md)、[product/versions.json](versions.json)、[已批准版本计划](../docs/roadmap/README.zh.md)）只链接本文件，不再复制易过时的提交号、产物 SHA 与验收计数。

本文件是状态索引，不是发布声明，也不替代原始证据；结论升级必须来自新的命令输出或新证据文件，不能只改本文件的文字。状态词表：`PASS` / `FAIL` / `BLOCKED-ENVIRONMENT` / `BLOCKED-EXTERNAL` / `DEFERRED`；实现进度另用 `IMPLEMENTED` / `VERIFIED`；本文件不含待确认占位（§7/§8 已于 2026-10-31 登记结论）。历史文档、`review/` 目录与既有证据保持原样，本文件只在"历史索引"给日期、提交与位置。

## 1. 当前开发提交与候选版本

| 项 | 值 |
|---|---|
| 唯一代码工作树 | `dsh-bot-closure`，分支 `work/0.0.1-closure-final` |
| 收尾基线（整合前） | `c772c2df6384c1eeef865a63a8afc0ee7c5b4a55`，tree `ac612185b53ed553acae9cc9727e4bf4bc798299`（`git rev-parse HEAD`，2026-10-31 09:47 +08 工作树干净） |
| 上一轮源码身份（第一轮收尾） | `089d598dfda1cf59eedb7c4b89d3a2b43a985af0`，tree `080b1c753b5c421ddf5f95c2a97c46b587c23dfe`；其后的 `37dc00f30c` 是只改本索引的文档提交 |
| 当前源码身份（E 层验收绑定） | `40be8ef895e1344588b46a6d5a0198f688764f6e`，tree `156a09834908f127066705d893a79a34eff34965`；相对上轮 `37dc00f30c` 为 23 files changed, 2060 insertions(+), 65 deletions(-)（`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`git diff --shortstat 37dc00f30c 40be8ef8`）；分支 `work/0.0.1-closure-final`，**仅本地、未推送**，提交后 `git status --porcelain` 为空 |
| 本索引更新 | 本文件这次修改位于 `40be8ef8…` 之后的一个文档提交，只改本文件、不改变源码身份；"当前开发提交"始终指 `40be8ef8…` |
| 候选产品版本 | `0.0.1-beta2`（产品版本与 Runtime 版本独立） |
| Runtime | DeepSeek Harness `0.2.1-rc.3`，tag `dsh-v0.2.1-rc.3`，commit `1f81c047fc48fa190a683e469daa699857e9afe8` |
| 候选包 | 本仓库不存放 DMG；安装包在私密证据区 `dsh-bot-candidates/closure-40be8ef8/dsh-bot-0.0.1-beta2-40be8ef8-mac-arm64-unsigned.dmg`，**SHA-256 `10db0f13b36485359d4c26473ab212a295c5d644fe8348232dfa3f8dd1bf1071`、702,290,843 B**；ad-hoc 内部签名，`codesign --verify --deep --strict` 由验收 `native-signatures` 阶段判定 PASS；**未签名/未公证**（属 R 层）。构建清单 `macos-build.json`：sourceCommit `40be8ef8…`、createdAt `2026-10-31T05:58:48.891Z`（= 13:58 +08） |
| 构建入口 | `bash product/tools/build-macos.sh`（新增磁盘前置守卫；本轮在 13.8 GiB 可用时启动，`BUILD_MACOS_EXIT:0`） |
| 发布状态 | 未打 tag、未建 Release、未公证；分支仅本地、未推送；合并由 Lead 与用户决定，本文件不预判 |

版本身份：`product/versions.json` 与 `apps/desktop/package.json` 均为 `0.0.1-beta2`，Runtime 固定 `0.2.1-rc.3`。**当前候选的源码身份与安装包身份一致**：`gate-map.json` 记录 sourceCommit = workspaceHead = `40be8ef8…`、artifactVerified=true，`macos-build.json` 的 sourceCommit 相同（见 §2）。

## 2. 最近验收提交及产物 SHA

| 项 | 值 |
|---|---|
| 最近一次完成的原生打包验收 | 合并验收 `accept-beta2-macos.sh`：**overall PASS**；base 15/15 阶段 PASS（`native-signatures`、`first-launchservices`、`first-bridge`、`first-web-boot-and-navigation`、`first-memory`、`memory-write-and-cross-session`、`first-shutdown`、`first-descriptor-cleanup` 及 `restart-*` 共 15 项）；native 9/9 PASS（C0-preconditions、C0-launch-ready、C1-bubble-first-show、C2-bubble-above-main、C3-focus-non-steal、C4-edge-multi-display-geometry、C5-dev-missing-memory-diagnosis、C6-snapshot-connection、C7-exit-restart-cleanup）；`firstAttemptSuccess=true`，exit 0（2026-10-31，同一安装包） |
| 验收绑定源码 | `40be8ef895e1344588b46a6d5a0198f688764f6e`，tree `156a09834908f127066705d893a79a34eff34965` |
| 产物 DMG | `dsh-bot-0.0.1-beta2-40be8ef8-mac-arm64-unsigned.dmg`，702,290,843 B（`stat -f %z`） |
| 产物 SHA-256 | `10db0f13b36485359d4c26473ab212a295c5d644fe8348232dfa3f8dd1bf1071`；`gate-map.json` 记录 artifactVerified=true，`macos-build.json` 的 sourceCommit 与验收源码一致 |
| 自动化门禁 | B2-G01…B2-G18 = **18/18 PASS，0 FAIL**（`gate-map.mjs`）；边界 16×`BLOCKED-ENVIRONMENT`、8×`BLOCKED-EXTERNAL`、1×`DEFERRED` |
| 三轮回放 | `stability-beta2.mjs --rounds 3` → **3/3 PASS**，`firstAttemptSuccesses=3`、`sameShaEveryRound=true`，exit 0 |
| 一次失败后重跑（如实记录） | 首次验收在 `native-signatures` PASS 后 `first-launchservices` FAIL（`Host not ready`：磁盘刚完成 700MB DMG + 2.6GB app 构建、系统仍在索引，60s 启动窗口内 Host 未起）。日志保留于 `.agent/evidence/closure-2026-10-31/attempt1-launchservices-fail/`；磁盘静默后重跑即 15/15 PASS。**属环境时序问题，不是代码缺陷**（同一包手工启动 3 次均在 5–25s 内出现 `bridge.json`） |
| 声学与原生边界 | 真实 Provider / 麦克风未测 = `BLOCKED-EXTERNAL`；TCC、物理点击穿透、Spaces、多屏 = `DEFERRED`/`BLOCKED-ENVIRONMENT`（边界计数同上） |
| 证据位置 | 私密证据区 `dsh-bot-candidates/closure-40be8ef8/`（DMG、`macos-build.json`、验收与 gate-map/stability 输出）；失败重跑日志 `.agent/evidence/closure-2026-10-31/attempt1-launchservices-fail/`。均未提交入库 |

### 2.1 验收绑定与当前开发身份（本轮一致）

- 本轮候选 = 源码身份 `40be8ef8…`（tree `156a0983…`）+ 安装包 DMG `10db0f13…`；`gate-map.json` 记录 sourceCommit=workspaceHead=`40be8ef8…`、artifactVerified=true，`macos-build.json` sourceCommit 一致 → **源码与安装包身份一致**。
- 上一轮源码身份 `089d598d…` 与更早的 `7d15cb18…` 候选只作历史（§6.2）；不得把旧候选 PASS 当本轮；E 层结论只引用 §2 的安装包。
- 任何重构建都产生新身份：新 DMG 必须重跑 `accept-beta2-macos.sh`、`gate-map.mjs` 与三轮回放，并替换 §2 的"最近验收"行；旧候选移入 §6.2。

## 3. E / U / R 三层状态

| 层 | 定义 | 状态 | 依据与缺口 |
|---|---|---|---|
| E：工程完成 | 实现与确定性测试、构建、原生启动/退出、基础记忆存储与检索闭环 | **PASS**（同候选源码 + 安装包 + 15 阶段 + 9 原生检查 + 三轮稳定性 + 18/18 门禁，身份一致） | 见 §2、§4；E PASS 只表示工程门禁与打包验收成立，不代表 U 或 R |
| U：内测可用 | E 加真实 Provider、真人语音、TCC、任务审批/取消、自然对话记忆与持续试用证据 | **未 PASS**（`BLOCKED-EXTERNAL` + `DEFERRED` + `NOT-STARTED`） | 真实 Provider（G2/G3/G4）、真人语音十轮、TCC/点击穿透/Spaces（G9 `DEFERRED`）、日常试用 G12 `NOT-STARTED`；**不得把自动回放当作试用** |
| R：公开发行 | 签名、公证、更新源与正式发布身份 | **NOT-STARTED** | 当前仅 ad-hoc 内部签名；无 Developer ID/公证、无更新 feed；bundle id `ai.nisse.app` 仍为内部暂定；B2-G17 = `DEFERRED` |

E PASS 不等于 U PASS，U PASS 不等于 R PASS。历史 PASS 不是当前 PASS；fixture/mock 证据不是真人或真实 Provider 证据。本轮 E PASS 绑定同一源码与安装包（`40be8ef8…` / `10db0f13…`），不得读成 U 或 R。

## 4. 核心门禁及明确缺口

门禁编号沿用收尾计划书 §6（G0–G12）与 §3–§5（S1–S3、F1）；状态只来自列出的证据。

| 门禁 | 状态 | 证据 | 明确缺口 |
|---|---|---|---|
| G0 身份与构建 | PASS | 源码 `40be8ef8…` + DMG `10db0f13…`；`macos-build.json`/`gate-map.json` sourceCommit 一致，artifactVerified=true | — |
| G1 安装与首启 | PASS | base 15/15 含 `native-signatures`、`first-launchservices`、`first-bridge`、`first-web-boot-and-navigation`、`first-memory` | 隔离 user-data（非隔离 HOME 沙箱）；真实账户安装属 U |
| G2 首次配置 | BLOCKED-EXTERNAL | 自动验收无真实 Key 引导 | 无预置 Key 的引导、错误 Key 恢复、凭据无泄露需用户 Key |
| G3 文本任务 | 夹具级 PASS；真实 Provider `BLOCKED-EXTERNAL` | gate-map B2-G04（Mock Provider）；`verify-local` 全套 | 真实 DSH 工具任务与真实终态需真实 Key |
| G4 真人语音 | BLOCKED-EXTERNAL | 真实 Provider/麦克风未测 | 真麦克风→ASR→DSH→TTS、连续十轮、回声/打断 |
| G5 审批安全 | 源码级 PASS（S1 证据）；真实双窗口人工竞速 = BLOCKED-EXTERNAL | S1 源码级 PASS（见 §4.1）；B2-G01 自动化证据 PASS（host kernel 级） | 真实双窗口/多端竞速尚需人工验收；S1 边界见 §4.1 |
| G6 取消与恢复 | 自动化 PASS；真实 Provider `BLOCKED-EXTERNAL` | gate-map B2-G07、B2-G08 | 真实 Provider 下的取消确认仍需活体 turn |
| G7 记忆体验 | 包内写入/跨会话/重启召回 PASS（隔离 bank）；真实个人库 `BLOCKED-ENVIRONMENT` | 15 阶段中 `memory-write-and-cross-session`、`memory-restart-recall` | 真实个人 Hindsight 库、查看/纠正/删除/导出、备份恢复待验 |
| G8 故障恢复 | 夹具级 PASS | gate-map B2-G08、B2-G14（dev-doctor） | 网络/丢包真实故障注入 `BLOCKED-ENVIRONMENT` |
| G9 原生交互 | DEFERRED | gate-map 边界（16×环境、8×外部、1×延迟）；本机单显示器 | TCC、物理点击穿透、Spaces、多屏 |
| G10 退出重启 | PASS | `first-shutdown`、`first-descriptor-cleanup`、`restart-shutdown`、`restart-descriptor-cleanup` | — |
| G11 复测稳定 | PASS | 三轮回放 3/3 首次成功、同一 DMG SHA | 长期稳定不属于三轮机械冒烟 |
| G12 日常试用 | NOT-STARTED | — | 作者连续使用 + 3–5 名技术友好用户一周（需用户招募同意） |
| S1 默认权限与越界审批 | PASS（源码级） | 收尾 S1 修复与副作用断言测试（Lead 整合，命令见 §9） | 仅覆盖已声明支持的执行入口（fs 工具族、bash 工具）；不构成"任意恶意程序"的证明；未覆盖 MCP 工具子进程（默认未挂载）、持久终端、computer-use/CUA/browser-use（未挂载且验证不可达）、PTC `run_code`（静态确认有 policy，未跑真实用例）；`ptc-runtime/workflow` 为 **② 已挂载且受边界约束（端到端已实测）**：脚本 VM 无 `fs`；父会话沙箱策略经 `sandboxPolicy.resolve` 显式传给 PTC 运行时；无法约束时 fail-closed；上游 `host.spec.ts`/`workflow-ptc.spec.ts` 70/70 PASS；**端到端探针 20/20 PASS**（`workflow → agent() 子代理 → 工作区外写` 被沙箱拒绝、目标文件不存在、`guard_fault=0`），见 `round2/WORKFLOW-ENTRY-CLOSURE.md`；旧配置迁移**端到端已实测**（隔离 userData 预置 `danger-full-access` 受管块 → 启动当前候选 → 块被收紧为 `workspace-write`、`bot/permission-migration.json` 写入 from/to/notice、`/health.agent.permission` verified=true、优雅退出 descriptor 清理；真实数据根未被触碰），见 `round2/LEGACY-PROFILE-MIGRATION-E2E.md`；迁移提示载体较窄（`permission-migration.json`、`/bot/status.permissionNotice`、audit、`/health.agent.permission`） |
| S2 取消入口统一 | PASS（源码级） | 收尾 S2 修复与测试（Lead 整合） | breaking change：未升级旧客户端会收到 `400 CANCEL_TARGET_REQUIRED` + `upgrade` 提示；legacy 客户端"先读 `/task-state` 再取消"之间若 turn 结束会得到 `STALE_TURN`（不取消，而非取消错的） |
| S3 凭据并发与原子性 | PASS（源码级，未降级） | 收敛到"同一写入协议 + 同一把锁"（`withFileLock(<doc>.lock)` + `writeFileAtomic`，Desktop 等待 40s > 上游持有 30s）；负向对照：无锁写法 10 轮×8 进程丢 32/80 refs → 修复后 0；另核实 58 文件/21 处已推送 loopback token（内存态、随进程死亡失效、每次启动重新生成、仅同进程两个入口接受），真实云凭据 0，仓库仍私有 | 唯一 `DEFERRED`：Desktop 写路径不保留 `.credentials.yaml` 注释/排版（键值与顶层字段不丢）；存储是 0600 私有文件，不是 Keychain 加密 |
| F1 正式状态与桌面投影 | PASS（协议/投影级；unknown 投影已闭环） | 四句验收成立：两个界面不会批准不同操作；旧选项序号不会回答新问题；重连不自动重放任务（含崩溃 `unknown` 与优雅 `cancelled` 两类 Host 级证据）；UI 不伪造完成（投影级）。本轮 `snapshot@1` 新增可选 `interactions.unknown` 投影（见 §7） | 剩余限制：主窗口内不显示 unknown、精灵动画仍为 idle、提示为通知而非永久角标 |
| B2-G01…G18（自动化） | 18/18 PASS（automated evidence level） | `gate-map.json`：sourceCommit=`40be8ef8…`、workspaceHead=`40be8ef8…`、artifactSha256 与 §2 一致、artifactVerified=true | 其中 B2-G01/G03/G07、B2-G15 的证据层级见 §4.1；真实 Provider 行为仍属 U |

### 4.1 S1–S3 / F1 结论明细（源码级）

- **S1 默认权限与越界审批：PASS（源码级）**。覆盖范围仅为已声明支持的执行入口：文件系统工具族与 bash 工具；不构成"任意恶意程序"的证明。未覆盖入口：MCP 工具子进程（默认未挂载）、持久终端、computer-use/CUA/browser-use（未挂载且验证不可达）、PTC `run_code`（静态确认存在 policy，未跑真实用例）。`ptc-runtime/workflow` 为 **② 已挂载且受边界约束（端到端已实测）**（脚本 VM 无 `fs`；沙箱策略显式传播；无法约束时 fail-closed；上游 70/70 测试通过；**端到端 20/20 PASS**：workflow 子代理越界写被拒、无文件，见 `round2/WORKFLOW-ENTRY-CLOSURE.md`）。迁移提示载体较窄：`permission-migration.json`、`/bot/status.permissionNotice`、audit、`/health.agent.permission`。
- **S2 取消入口统一：PASS（源码级）**。breaking change：未升级的旧客户端会收到 `400 CANCEL_TARGET_REQUIRED` + `upgrade` 提示；legacy 客户端"先读 `/task-state` 再取消"之间若 turn 已结束，会得到 `STALE_TURN`（拒绝取消，而不是取消错的任务）。
- **S3 凭据并发与原子性：PASS（源码级，未降级）**。收敛到"同一写入协议 + 同一把锁"（`withFileLock(<doc>.lock)` + `writeFileAtomic`；Desktop 等待 40s > 上游持有 30s）。负向对照：无锁写法 10 轮 × 8 进程丢 32/80 refs → 修复后 0。唯一 `DEFERRED`：Desktop 写路径不保留 `.credentials.yaml` 注释与排版（键值与顶层字段不丢）。存储是 0600 私有文件，不是 Keychain 加密。另核实 58 文件 / 21 处已推送 loopback token：内存态、随进程死亡失效、每次启动重新生成、仅同进程两个入口接受；真实云凭据 0；仓库仍私有。
- **F1 正式状态与桌面投影：PASS（协议/投影级）**。四句验收成立：两个界面不会批准不同操作；旧选项序号不会回答新问题；重连不自动重放任务（含崩溃 `unknown` 与优雅 `cancelled` 两类 Host 级证据）；UI 不伪造完成（投影级）。本轮修复：`snapshot@1` 新增可选 `interactions.unknown`（`{id,kind,sessionId,reason,at,action:{id:'open-main',label}}`，≤8 条，schema 仍为 `snapshot@1`）；`displayMode='unknown'`；气泡一条中文"结果尚未确认" + 唯一动作"打开主窗口确认"；**不重放、不回答、不取消**。上轮 `interactions` 不投影 `unknown` 的 `DEFERRED` **CLOSED**；剩余限制：主窗口内不显示 unknown、精灵动画仍为 idle、提示为通知而非永久角标。

### 4.2 本轮实测（源码级；命令见 §9）

- `node --test product/pet/tests/*.test.mjs nisse/packages/host-integration/tests/*.test.mjs product/tools/tests/*.test.mjs` → **378/378 pass，exit 0**（构建前在 `40be8ef8` 干净树；host-integration 单包 **233/233**，含 `round2-unknown-ux.test.mjs` 9 例）。
- `pnpm run build` → **9/9 gates passed，exit 0**；`typecheck` → **5/5**。
- `NODE_USE_ENV_PROXY=0 pnpm exec vitest run --maxWorkers=1 <verify-local 的 spec 列表>` → **33 files + 2 显式 skip / 544 tests pass，exit 0**（含 `round2-unknown-ux.spec.ts` 6 例、真实双 Host 进程崩溃重启；`f1-host-restart-unknown.spec.ts` 把上轮"无 unknown 字段"断言翻转为新契约，2/2 PASS）。2 个 skip 为**显式** skip（含 `f1-m2-memory-e2e.spec.ts` 的 `describe.skipIf(!ENABLED)`，需 `CLOSURE_M2_ROOT` 提供隔离 Hindsight），未设置时跳过而不是假装通过。
- `node product/tools/smoke-host.mjs` 与 `node product/tools/smoke-host.mjs --default-provider` → 均 **exit 0**；`smoke-wake-word`、`smoke-pet-ui`、`check-built-resources` → 均 **exit 0**。
- `node product/tools/dev-doctor.mjs --json` → **exit 0 / status PASS**（8 PASS / 2 WARN / 9 UNKNOWN）。
- 语音 Python 单测不在本轮实测清单内，**未被本轮任何证据覆盖**（环境无 voice venv，沿用 `BLOCKED-ENVIRONMENT`；beta2 基线 101 cases OK）——不作为 E 层 PASS 依据。
- 构建入口：`bash product/tools/build-macos.sh` → `BUILD_MACOS_EXIT:0`（磁盘前置守卫通过）。

文档门禁（本轮实测）：`verify-product-docs` → exit 0；`verify-upstream` → exit 0（`apps/web/src/main.ts` 变更已重新登记 override）。KNOWN-DEVIATION（既有、独立于本轮，不改写、不冒充已修复）：全库 `verify-translation-pairing` exit 1（9 处产品新增 zh-only 文档，缺英文对与 `.i18n.yaml`）；`verify-repository-references` exit 1（**180 处改动前既有 + 42 处本索引 = 222**；上一版索引为 33 处，本轮新增身份引用后增加。明细见 §9 与私密 `round2/GATE-DEVIATION-PROPOSAL.md`；A/B/C 均未实施）；`verify-md-wrap` 报告 `README.md:126` / `README.zh.md:126` 两个既有 HTML 锚点行。索引记录提交号与上游"维护文件禁止记录 commit"规则的冲突需要 Lead/上游策略决定；**不得删除索引里的提交身份来掩盖该偏差**，只能按提案改变身份存放位置/形式或对明确范围做规则适配。

## 5. 用户需配合事项

1. **真实 Provider / API key 授权**：在 DSH 设置 → Bot 填入 LLM 与 DashScope Key（或提供测试 Key），解锁 G2/G3/G4 与真实语音链路；凭据与费用归用户，产品不代持。
2. **真实麦克风与真人语音**：安静环境、外放回声、耳机、连续十轮、抢话、停止播报分别验证（G4/G5）。
3. **TCC / 点击穿透 / Spaces / 多屏 / 物理拖动**：在 Finder 与系统设置中人工授权并操作，提供截图或录屏（G9）；本机为单显示器，多屏项记录为 `BLOCKED-ENVIRONMENT`。
4. **U 层真人验收（依赖第 1–3 项）**：真实 Provider 引导与文本任务、真人十轮语音、TCC 人工项——这是 U PASS 的前置，自动回放不能替代。
5. **回滚基线拍板**：是否把 `0.0.1-beta-f801a59b`（DMG `7acadd6b…`，702,230,791 B）定为正式回滚基线；当前分级为"**回滚候选（数据兼容双向 + 三轮稳定 + 凭据文件完整）**"（见 §8.2）：beta1↔beta2 **升级召回与降级启动+召回**均实测通过（`round2/DATA-COMPAT-DRILL.md`）；回滚包**三轮均首次启动就绪、跨轮记忆连续、退出清理干净**，且凭据文件三轮保持 **0600**、未知 ref **未被丢弃**（`round2/ROLLBACK-STABILITY.md`）；仍缺真实用户库（≈470 MiB）迁移、真实凭据往返（新写旧用）与更老版本组合，故仍不称"正式可用回滚基线"。
6. **Stage D 重构建（如源码再变）**：需释放 **≥ 20 GiB 磁盘** + 数小时窗口；本轮构建在 13.8 GiB 可用时通过磁盘守卫。
7. **发布授权（签名/公证/更新源）**：R 层需要 Apple Developer 账号与证书、公证流程与正式更新 feed 决策。
8. **试用招募（G12）**：作者连续使用并记录，随后 3–5 名技术友好用户一周试用；需要用户同意招募渠道与试用数据范围。
9. **远期路线变更批准**：变更提案在私密交接目录 `ROADMAP-CHANGE-PROPOSAL.md`，状态 **`PENDING-USER-APPROVAL`**；未批准前不修改权威路线图文件。

已完成（用户授权，2026-10-31）：旧产物 **4 条 DELETE-CANDIDATE 已删除**，`df` 净增 **4.16 GiB**；保留四包哈希复检完好（`7acadd6b…` / `377345c6…` / `dda3e8ec…` / `76d13562…`）；记录见私密 `round2/CLEANUP-EXECUTION.md`。

## 6. 当前下一步与历史索引

### 6.1 当前下一步

| 步骤 | 工作 | 依赖 | 完成判据 |
|---|---|---|---|
| 1 | 源码级门禁整合（S1–S3、F1、G5） | — | **已完成**：见 §4、§4.1 |
| 2 | 生成收尾提交并填写 §1 | 步骤 1 | **已完成**：`40be8ef8…`（相对上轮 23 files / +2060 / −65）；本文件更新在随后一个文档提交 |
| 3 | Stage D：同候选重建 DMG、打包验收、三轮回放、gate-map | 用户配合项 6（≥ 20 GiB 磁盘 + 数小时窗口） | **已完成**：15/15 + 9/9 + 3/3 + 18/18（§2） |
| 4 | U 层真人验收（真实 key / 语音 / TCC） | 用户配合项 1–4 | G2–G5、G9 有绑定同一产物的证据 |
| 5 | 试用与体验指标 | 用户配合项 8 | G12 与计划书 §6.1 指标有分母与失败定义 |
| 6 | 回滚演练补齐（数据兼容/真实用户库/凭据/回滚包三轮） | 用户配合项 5 | 产出后把 §8.2 升级为 §8.1 或维持候选并写明理由 |
| 7 | 发布授权、路线变更批准 | 用户配合项 7、9 | 批准记录可复核 |

每一步只更新本文件对应行；其它文档不复制这些数字。

### 6.2 历史索引（只读，保持原样）

| 日期 | 里程碑 | 绑定提交 / 产物 | 结论 | 位置 |
|---|---|---|---|---|
| 2026-10-24 | v0.1 内部 MVP（Runtime rc.2） | 产品 0.1.0；现存 DMG 实测 SHA-256 `2ee96bb2…`（文档记录 `120e7b83…`，重建后未回写，差异如实保留） | INTERNAL MVP — CONDITIONAL，P-M1…P-M7 多为 IN PROGRESS | [.agent/docs/MVP-ACCEPTANCE-0.1.md](../.agent/docs/MVP-ACCEPTANCE-0.1.md)、`nisse/dist/v0.1/` |
| 2026-10-27 | beta1 线路与已批准 0.0.1–1.0 任务书 | 基线 tag `0.0.1-beta1` = `de5f10dc…` | 计划冻结，不是实现 | [docs/roadmap/README.zh.md](../docs/roadmap/README.zh.md)、[docs/roadmap/baseline.json](../docs/roadmap/baseline.json)、[README-MVP.zh.md](../README-MVP.zh.md) |
| 2026-10-29 | `0.0.1-beta` 候选系列原生验收 | `f3b593b2…`、`4aa3b8d3…`、`63bb2c43…`、`c2ae35b2…`、`f801a59b…`（各有 review 目录与 DMG SHA） | 各轮自动验收 15/15 PASS；真人声学/Provider 仍阻塞 | [review/](../review/) 各 `STATUS*.md` |
| 2026-10-30 | beta2 候选 2 | `6a6cdfd8…`；DMG SHA-256 `377345c6…` | SUPERSEDED（被候选 3 取代：候选 3 之前的 `7d15cb18` 修复了 `/health` 安装路径脱敏与桌面存在性推导后重建） | 私密证据 `dsh-bot-candidates/beta2/6a6cdfd8/` |
| 2026-10-31 00:55 +08 | beta2 候选 3 | `7d15cb18…`；DMG SHA-256 `dda3e8ec…` | PASS（自动 15/15 + B2 18/18 + 稳定 3/3）；后被本轮候选取代 | 私密证据 `dsh-bot-candidates/beta2/7d15cb18/` |
| 2026-10-31 | 第一轮收尾提交（源码级 PASS） | `089d598d…`；其后的 `37dc00f30c` 只改本索引 | 源码级 PASS；无打包验收 | 本文件历史（§4.2 旧记录） |
| 2026-10-31 | 交付 HEAD（仅验收工具改动） | `c772c2df…` | 不改变打包字节，不是新候选 | 私密证据 `FINAL-REPORT.md` |
| 2026-10-31 | 本轮 E 层候选（最近验收） | `40be8ef8…`；DMG `10db0f13…`、702,290,843 B | PASS（base 15/15 + native 9/9 + 稳定 3/3 + 18/18；首次 launchservices 失败为环境时序，重跑通过） | 见 §2 |
| 2026-10-31 | 旧产物清理执行（用户授权） | 4 条 DELETE-CANDIDATE 删除，`df` 净增 4.16 GiB；四包哈希复检完好 | 完成 | 私密 `round2/CLEANUP-EXECUTION.md` |

历史记录保持原样：上表只新增日期、提交与位置，不重写任何历史结论；历史失败（例如候选 3 的 G18 首轮夹具下只有 1/3 回放、之后修复夹具侧激活时序才 3/3；本轮首次 `first-launchservices` FAIL 后重跑通过；v0.1 的 BLOCKED 项）继续记录在各自文档与 §2 中。

### 6.3 回滚基线状态

| 项 | 状态 | 证据 |
|---|---|---|
| 上一已验收候选（`f801a59b`） | **回滚候选（数据兼容双向 + 三轮稳定 + 凭据文件完整）**；是否定为正式回滚基线需用户拍板（见 §5 第 5 项） | `0.0.1-beta` 构建 `f801a59ba957e01418d70ea8d44f55b965d10117`；DMG 实测 SHA-256 `7acadd6b…`、702,230,791 B；绑 `acceptance-1793287717/RESULTS.json` 15/15 PASS（[验收记录](../review/0.0.1-mac-bubble-level-2026-10-29/STATUS.zh.md) 写 702,229,423 B，与实测不一致，以实测为准）；演练结论见 §8.2 |
| 仅构建可验证的回滚点 | 构建可验证，验收记录未绑定 | beta2 候选 2 `6a6cdfd8…`，DMG 实测 SHA-256 `377345c6…`、702,479,827 B |
| 记录中的回滚包（`76d13562…`） | ROLLBACK-RECORD-DRIFT + VERIFIED-AT-ALTERNATE-PATH | 记录路径失效（`nisse/dist/v0.0.1-beta/` 现只剩 `SHA256SUMS.txt`，记录路径 `$HOME/projects/dsh-bot-workspace/dist/…` 本机不存在），但 DMG 在本机替代路径存在且可验证：`nisse-dsh/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg`，实测 **SHA-256 `76d13562…`、779,421,007 B**（与记录值及 `nisse/versions.json.sizeBytes` 一致）。**不是"文件缺失/不可验证"** |
| `nisse/dist/rc3-closure/` 同名 DMG | 未验收，不作为回滚包 | 实测 SHA-256 `6dc0db38…`（不是 `76d13562…`）；来源是 2026-10-25/26 本地构建（`mvp/rc3-closure` @ `8c34e669…`），材料目录中的本地验收报告（`nisse/review/rc3-closure-2026-10-25/LEAD-LOCAL-ACCEPTANCE.zh.md`，非本仓库文件）结论为"不建议按已交付 MVP Candidate 接受"（4 个 High 未解决），仅核心运行链路实测通过 |
| 回滚链完整性（计划书 §8.3） | **有条件 SATISFIED** | 有可验证的上一已验收候选（`f801a59b`，已推进到"回滚候选（数据兼容双向已验证）"）+ 仅构建可验证的候选（`6a6cdfd8`）；**beta1↔beta2 数据格式兼容已实测（升级召回 + 降级启动/召回）**、**回滚包三轮稳定性已实测（3/3 首次就绪、跨轮记忆连续、退出清理干净）**、**凭据文件三轮保持 0600 且未知 ref 未被丢弃**；仍缺真实用户库（≈470 MiB）迁移与真实凭据往返（新写旧用），正式回滚基线尚未由用户拍板 |

## 7. 本轮 `unknown` 用户可见性修复（2026-10-31 登记）

| 字段 | 内容 |
|---|---|
| 问题 | 上轮 F1 `DEFERRED`：registry 已恢复 `unknown`，但 `snapshot@1.interactions` 不投影 `unknown`，UI 既无法告知用户，也没有恢复入口 |
| 修复范围 | `interactions.unknown` 可选新增（`{id,kind,sessionId,reason,at,action:{id:'open-main',label}}`，≤8 条；schema 仍为 `snapshot@1`）；`displayMode='unknown'`；气泡一条中文"结果尚未确认"、唯一动作"打开主窗口确认"；**不重放、不回答、不取消** |
| 提交 | `40be8ef895e1344588b46a6d5a0198f688764f6e`，tree `156a09834908f127066705d893a79a34eff34965`（与 §1 一致） |
| 证据 | `node --test nisse/packages/host-integration/tests/*.test.mjs` → **233/233**（含 `round2-unknown-ux.test.mjs` 9 例）；`apps/desktop/tests/round2-unknown-ux.spec.ts` 6 例（含真实双 Host 进程崩溃重启）；`f1-host-restart-unknown.spec.ts` 把上轮"无 unknown 字段"断言翻转为新契约（2/2 PASS） |
| 用户可见性验收 | 用户可见"结果尚未确认"提示与唯一动作"打开主窗口确认"；行为为不重放/不回答/不取消，与"官方结果先到""Host 崩溃 unknown""优雅 cancelled"的既有语义一致 |
| 结论 | **PASS**；F1 的 `snapshot` 不投影 `unknown` `DEFERRED` **CLOSED**。剩余限制：主窗口内不显示 unknown、精灵动画仍为 idle、提示为通知而非永久角标 |
| 关联 | §4 F1 行已更新；§3 E 层据此复核（源码级 PASS 保持） |

## 8. 回滚演练结论（2026-10-31 登记）

> 三个分类互斥：同一产物只能出现在一处；未演练的项明确写"未证明"，不得预设"可用"。

### 8.1 正式可用回滚基线

| 字段 | 内容 |
|---|---|
| 产物 | **无**（本轮没有产物同时满足全部条件；分级见 §8.2） |
| 绑定源码 | — |
| 数据格式兼容性 | 未验证（beta1↔beta2 `dataFormat`） |
| 演练证据 | — |
| 结论 | **不可用**（缺数据兼容、真实用户库迁移、回滚后凭据与回滚包稳定性证据） |

### 8.2 回滚候选

| 字段 | 内容 |
|---|---|
| 产物 | `0.0.1-beta-f801a59b` DMG：`7acadd6b…`、702,230,791 B（`acceptance-1793287717/RESULTS.json` 15/15 PASS） |
| 已证明 | 安装到隔离目录 → 用其自己那次验收的旧 user-data 启动 → 召回 `updatedAt=2026-10-29T15:30:52Z` 的原始记忆 → 写入新数据 → 项目自带 web 验收 PASS → 3 次重启连续 → SIGTERM 2s 退出、8 子进程 / 2 descriptor / 端口全清；另：beta1↔beta2 **双向**数据兼容、回滚包**三轮**首次就绪 3/3 与跨轮记忆连续 2/2、凭据文件 0600 且未知 ref 未丢 |
| 未证明（因此不能升级为正式基线） | 真实用户库（≈470 MiB）迁移、真实凭据往返（新包写 → 旧包用）、更老版本组合（且最老包本身不可隔离，见下方负向发现②） |
| 关键负向发现 | ①`BOT_CONFIG_PORT=59100` 硬编码 → **回滚必须先在跑实例退出**（否则 `EADDRINUSE`）；②**`0.0.1-beta`（`2c74680111`，DMG `76d13562…`）忽略 `--user-data-dir`**，启动即写入真实数据根并会把受管权限块重生成回 `danger-full-access` → **回滚目标限定为 `f801a59b` 或更新**，更老包不能隔离运行 |
| 证据 | 私密 `round2/ROLLBACK-DRILL.md`、`round2/DATA-COMPAT-DRILL.md`、`round2/ROLLBACK-STABILITY.md`、`round2/ROLLBACK-OLDEST-FINDING.md` |
| 结论 | **回滚候选（数据兼容双向 + 三轮稳定 + 凭据文件完整；回滚窗口 = f801a59b 及以后）** |

### 8.3 不可回滚

| 字段 | 内容 |
|---|---|
| 产物或记录 | 本轮未判定任何对象为"不可回滚" |
| 理由 | — |
| 处置 | 保留 `76d13562…` 替代路径与 `6a6cdfd8…` 等"仅构建可验证"候选的既有记录（§6.3），不升格也不作不可回滚结论；如需处置由用户决策 |

## 9. 取数与复核

第一轮取数与门禁实测在 2026-10-31 09:43–10:06 +08；第二轮与 E 层打包验收的权威事实与实测结果由 Lead 整合提供（2026-10-31），命令与结果如下。`<EVID>`、`<CANDIDATES>`、`<NISSE>`、`<NISSE_DSH>` 为私密证据区占位符（本文件不公开本机绝对路径）。

```bash
# 仓库身份与候选版本
git rev-parse HEAD; git rev-parse HEAD^{tree}; git rev-parse --abbrev-ref HEAD; git status --porcelain
git diff --stat 7d15cb18 c772c2df; git diff --shortstat 37dc00f30c 40be8ef8
node -p "require('./product/versions.json').product.version"     # 0.0.1-beta2
node -p "require('./apps/desktop/package.json').version"         # 0.0.1-beta2
node -p "JSON.stringify(require('./product/versions.json').runtime)"

# 本轮 E 层候选（只读私密证据区）
shasum -a 256 <CANDIDATES>/closure-40be8ef8/*.dmg; stat -f %z <CANDIDATES>/closure-40be8ef8/*.dmg
node -p "const b=require('<CANDIDATES>/closure-40be8ef8/macos-build.json'); [b.sourceCommit,b.createdAt].join(' | ')"
node -p "JSON.stringify(require('<CANDIDATES>/closure-40be8ef8/gate-map.json').summary)"
node -p "JSON.stringify(require('<CANDIDATES>/closure-40be8ef8/stability-summary.json').overall)"
ls -la <EVID>/closure-2026-10-31/attempt1-launchservices-fail/

# 源码级测试 / 构建 / 冒烟（构建前在 40be8ef8 干净树）
node --test product/pet/tests/*.test.mjs nisse/packages/host-integration/tests/*.test.mjs product/tools/tests/*.test.mjs
pnpm run build
NODE_USE_ENV_PROXY=0 pnpm exec vitest run --maxWorkers=1 <verify-local 的 spec 列表>
node product/tools/smoke-host.mjs; node product/tools/smoke-host.mjs --default-provider
node product/tools/smoke-wake-word.mjs; node product/tools/smoke-pet-ui.mjs; node product/tools/check-built-resources.mjs
node product/tools/dev-doctor.mjs --json
bash product/tools/build-macos.sh        # 磁盘守卫；本轮 BUILD_MACOS_EXIT:0
bash product/tools/accept-beta2-macos.sh <candidate.dmg>   # base 15/15 + native 9/9，exit 0
node product/tools/stability-beta2.mjs --rounds 3 --dmg <candidate.dmg>   # 3/3，exit 0
node product/tools/gate-map.mjs --source-commit 40be8ef8… --exit-code     # 18/18，exit 0

# 回滚演练与清理记录
cat <私密>/round2/ROLLBACK-DRILL.md
cat <私密>/round2/CLEANUP-EXECUTION.md
shasum -a 256 <CANDIDATES>/0.0.1-beta-f801a59b/*.dmg
shasum -a 256 <CANDIDATES>/beta2/6a6cdfd8/*.dmg
ls -la <NISSE>/dist/v0.0.1-beta/; cat <NISSE>/dist/v0.0.1-beta/SHA256SUMS.txt
shasum -a 256 <NISSE>/dist/rc3-closure/*.dmg
shasum -a 256 <NISSE_DSH>/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg; stat -f "%z" <NISSE_DSH>/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg   # 76d13562…（779,421,007 B）
node -p "const r=require('<EVID>/acceptance-1793287717/RESULTS.json'); [r.status,Object.keys(r.phases).length].join(' | ')"
cat <NISSE>/dist/v0.1/SHA256SUMS.txt; shasum -a 256 <NISSE>/dist/v0.1/*.dmg

# 文档门禁
node product/tools/verify-product-docs.mjs    # exit 0
node product/tools/verify-upstream.mjs        # exit 0（main.ts 变更已重新登记 override）

# 门禁偏差取数（既有，未修复）
pnpm exec tsx scripts/verify-repository-references.ts   # exit 1；180 处既有 + 42 处本索引 = 222
pnpm exec tsx scripts/verify-translation-pairing.ts     # exit 1；9 处既有（英文对缺失）
pnpm exec tsx scripts/verify-md-wrap.ts                 # exit 1；2 处既有（README 两个 HTML 锚点行）
# 逐条归因脚本与索引身份行计数脚本见私密提案 GATE-DEVIATION-PROPOSAL.md 附录 A/B
```

## 10. 维护规则

- 只在打包验收、门禁结论或开发身份变化时改本文件；一行一处事实，不要把证据解释扩写成叙述。
- 任何重新构建都产生新身份：更新 §1/§2，并把上一候选移入 §6.2；不得只替换文字而保留旧 SHA。
- 不把历史 PASS 当当前 PASS；不把 fixture/mock 证据当真人或真实 Provider 证据；无法验证时写 `BLOCKED-*` / `DEFERRED`，不写"条件通过"。
- 改被 `product/upstream-allowlist.json` 覆盖的上游文件（含根 `README.md`、`README.zh.md`、`README.i18n.yaml`、`apps/web/src/main.ts` 等）后必须同步登记新 blob SHA（`git hash-object <file>`）；改根 README 还要用 `pnpm exec tsx scripts/verify-translation-pairing.ts --write README.md` 重录双语配对，否则 `verify-upstream` 或 `verify-translation-pairing` 会失败。
- 本文件自身的更新提交不改变源码身份（§1 的 `40be8ef8…`）；不需要因此重建或重新打包验收。
- 不得为让 `verify-repository-references` 变绿而删除或隐藏本文件中的提交身份；该门禁偏差（180 处改动前既有 + 42 处本索引 = 222）按私密提案 `round2/GATE-DEVIATION-PROPOSAL.md` 的评审结论处置，修改上游 `scripts/**` 必须经用户批准。
- `ptc-runtime/workflow` 为 **② 已挂载且受边界约束**，**端到端文件副作用已验证**（探针 `round2/workflow/probe-workflow.mjs` 20/20 PASS：workflow→`agent()` 子代理→工作区外写被拒、无文件、`guard_fault=0`）。证据见 `round2/WORKFLOW-ENTRY-CLOSURE.md`。
- 提交前分别运行 `node product/tools/verify-product-docs.mjs` 与 `node product/tools/verify-upstream.mjs`，两个都要 exit 0。
