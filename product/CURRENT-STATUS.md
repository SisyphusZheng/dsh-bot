# dsh-bot CURRENT-STATUS：唯一当前事实入口

**本文件是唯一当前事实入口；SHA/日期只在本文件维护。** 其它文档（[根 README](../README.md)、[README-MVP.zh.md](../README-MVP.zh.md)、[product/versions.json](versions.json)、[已批准版本计划](../docs/roadmap/README.zh.md)）只链接本文件，不再复制易过时的提交号、产物 SHA 与验收计数。

本文件是状态索引，不是发布声明，也不替代原始证据；结论升级必须来自新的命令输出或新证据文件，不能只改本文件的文字。状态词表：`PASS` / `FAIL` / `BLOCKED-ENVIRONMENT` / `BLOCKED-EXTERNAL` / `DEFERRED`；实现进度另用 `IMPLEMENTED` / `VERIFIED`；`TODO` 表示结论必须由收尾整合负责人（Lead）确认，本文件不代填。历史文档、`review/` 目录与既有证据保持原样，本文件只在"历史索引"给日期、提交与位置。

## 1. 当前开发提交与候选版本

| 项 | 值 |
|---|---|
| 唯一代码工作树 | `dsh-bot-closure`，分支 `work/0.0.1-closure-final` |
| 当前检出提交（整合前） | `c772c2df6384c1eeef865a63a8afc0ee7c5b4a55`，tree `ac612185b53ed553acae9cc9727e4bf4bc798299`；本文件取数前工作树干净（`git status --porcelain` 为空，2026-10-31 09:47 +08），收尾修改期间工作树不再干净，以 Lead 整合提交为准 |
| 当前收尾最终提交 | `TODO`：本工作树正在做收尾修改（安全 S1–S3、协议/记忆、文档、清理清单），最终整合提交与 tree 由 Lead 写入并替换此行 |
| 候选产品版本 | `0.0.1-beta2`（产品版本与 Runtime 版本独立） |
| Runtime | DeepSeek Harness `0.2.1-rc.3`，tag `dsh-v0.2.1-rc.3`，commit `1f81c047fc48fa190a683e469daa699857e9afe8` |
| 候选包 | 本仓库不存放 DMG；最近候选与证据包位于工作树外的私密证据区（见 §2），文件名 `dsh-bot-0.0.1-beta2-7d15cb18-mac-arm64-unsigned.dmg` |
| 发布状态 | 未打 tag、未建 Release、未公证；内部分支推送与合并由 Lead 与用户决定，本文件不预判 |

候选身份必须同时满足：`product/versions.json` 与 `apps/desktop/package.json` 版本一致、`node product/tools/verify-upstream.mjs` PASS、DMG 文件名带源码短 SHA。当前三项均已满足（上游校验：16347 official files / 47 explicit product overrides / manifest commit `1f81c047…`）。

## 2. 最近验收提交及产物 SHA

| 项 | 值 |
|---|---|
| 最近一次完成的原生打包验收 | 运行 `acceptance-1793379224`，`status=PASS`，15/15 阶段 PASS，`updatedAt=2026-10-30T16:55:22.138Z`（= 2026-10-31 00:55 +08） |
| 验收绑定源码 | `7d15cb1878a9bb9896199ee285ebeb71708315fb`，tree `201562bdb61b75a88fa3f7a63342f8cac81c1cc6`（= 当前检出提交的父提交） |
| 产物 DMG | `dsh-bot-0.0.1-beta2-7d15cb18-mac-arm64-unsigned.dmg`，702,399,055 B |
| 产物 SHA-256 | `dda3e8ec6a2cc461ab66e64f330a904f501c4fed59ba93fa6ea56e16a9075b82`（`shasum -a 256` 于 2026-10-31 09:49 +08 复核，与 RESULTS.json、构建 manifest、gate-map 三处记录一致） |
| 自动化门禁 | B2-G01…B2-G18 = 18/18 PASS（automated evidence level，0 FAIL）；边界 16×`BLOCKED-ENVIRONMENT`、8×`BLOCKED-EXTERNAL`、1×`DEFERRED` |
| 三轮回放 | 3/3 轮 PASS，均首次启动成功，每轮同一 DMG SHA；包内 app.asar sha `da923fe8497f3f62d17ba31393ea76f3d4a2797374299411275c26240463e7db` |
| 声学与原生边界 | 同候选 RESULTS.json：`voice = BLOCKED-EXTERNAL`（真实 provider/麦克风未测）；`nativePointerAndTcc = DEFERRED`（物理点击穿透、Spaces、TCC 需人工） |
| 证据位置 | 私密证据区 `dsh-bot-candidates/beta2/7d15cb18/`（`FINAL-REPORT.md`、`gate-map.json`、`stability-summary.json`、`SHA256SUMS`）；原始日志在 beta2 构建工作树 `.agent/evidence/beta2/run-20261030T142317Z/` 与 `.mvv-build/acceptance-1793379224/`。以上均未提交入库 |

### 2.1 最近验收绑定 ≠ 当前开发身份

- 相对验收绑定源码，当前检出提交只改 4 个验收工具脚本：`product/tools/accept-beta2-macos.sh`、`product/tools/accept-native-beta2.mjs`、`product/tools/gate-map.mjs`、`product/tools/stability-beta2.mjs`（`git diff --stat 7d15cb18 c772c2df` → 4 files changed, 479 insertions(+), 109 deletions(-)），不改变打包字节。
- 本次收尾还会产生新的源码提交（安全/协议/记忆/文档修复），这些提交**尚无可绑定的打包验收**。因此当前状态是：**工程门禁证据绑定 `7d15cb18…` 候选；收尾后的源码身份未重新打包验收**。
- 不得把 `c772c2df…` 或收尾最终提交称为"当前候选已验收"。重新构建后，新 DMG 必须重跑 `accept-macos.sh` / `accept-beta2-macos.sh`、`gate-map.mjs` 与三轮回放，才能替换 §2 的"最近验收"行；旧候选移入 §6.2。

## 3. E / U / R 三层状态

| 层 | 定义 | 状态 | 依据与缺口 |
|---|---|---|---|
| E：工程完成 | 实现与确定性测试、构建、原生启动/退出、基础记忆存储与检索闭环 | **源码级门禁 PASS（绑定 `7d15cb18…` 候选）；安全/协议门禁 `TODO` 待 Lead 整合；收尾新源码未重新打包验收** | 打包验收 15/15、B2 门禁 18/18、三轮回放 3/3，`verify-local` 在交付 HEAD 上 exit 0（私密证据 FINAL-REPORT.md）。安全 S1–S3 与协议 F1 正在收尾，整合前不宣布 E 最终 PASS |
| U：内测可用 | E 加真实 Provider、真人语音、TCC、任务审批/取消、自然对话记忆与持续试用证据 | **未 PASS**（`BLOCKED-EXTERNAL` + `DEFERRED` + `NOT-STARTED`） | 真实 Provider/麦克风未测（`BLOCKED-EXTERNAL`）；TCC、点击穿透、Spaces、多屏 `DEFERRED`/`BLOCKED-ENVIRONMENT`；真实个人 Hindsight 库未验（验收只用隔离 run-local bank）；日常试用 G12 未开始（需 3–5 名用户一周） |
| R：公开发行 | 签名、公证、更新源与正式发布身份 | **NOT-STARTED** | 当前仅 ad-hoc 内部签名；无 Developer ID/公证、无更新 feed；bundle id `ai.nisse.app` 仍为内部暂定；B2-G17 = `DEFERRED` |

E PASS 不等于 U PASS，U PASS 不等于 R PASS。历史 PASS 不是当前 PASS；fixture/mock 证据不是真人或真实 Provider 证据。上表"E 层"的 PASS 只覆盖已列出的自动化门禁，不覆盖安全/协议结论。

## 4. 核心门禁及明确缺口

门禁编号沿用收尾计划书 §6（G0–G12）与 §3–§5（S1–S3、F1）；状态只来自列出的证据。

| 门禁 | 状态 | 证据 | 明确缺口 |
|---|---|---|---|
| G0 身份与构建 | PASS | 验收候选 `7d15cb18…`，DMG `dda3e8ec…` 与 manifest/gate-map 一致；`verify-upstream` PASS | 收尾新源码未重建，故新身份暂无包 |
| G1 安装与首启 | PASS | 15/15 阶段含 `native-signatures`、`first-launchservices`、`first-bridge`、`first-web-boot-and-navigation`、`first-memory` | 隔离 user-data（非隔离 HOME 沙箱）；真实账户安装属 U |
| G2 首次配置 | BLOCKED-EXTERNAL | 自动验收无真实 Key 引导 | 无预置 Key 的引导、错误 Key 恢复、凭据无泄露需用户 Key |
| G3 文本任务 | 夹具级 PASS；真实 Provider `BLOCKED-EXTERNAL` | gate-map B2-G04（Mock Provider）；`verify-local` 全套 | 真实 DSH 工具任务与真实终态需真实 Key |
| G4 真人语音 | BLOCKED-EXTERNAL | RESULTS.json `voice` 字段 | 真麦克风→ASR→DSH→TTS、连续十轮、回声/打断 |
| G5 审批安全 | TODO 待 Lead 整合 | B2-G01 自动化证据 PASS（host kernel 级） | S1 默认权限/越界审批结论未定稿；不得先写 PASS |
| G6 取消与恢复 | 自动化 PASS；真实 Provider `BLOCKED-EXTERNAL` | gate-map B2-G07、B2-G08 | 真实 Provider 下的取消确认仍需活体 turn |
| G7 记忆体验 | 包内写入/跨会话/重启召回 PASS（隔离 bank）；真实个人库 `BLOCKED-ENVIRONMENT` | 15 阶段中 `memory-write-and-cross-session`、`memory-restart-recall` | 真实个人 Hindsight 库、查看/纠正/删除/导出、备份恢复待整合 |
| G8 故障恢复 | 夹具级 PASS | gate-map B2-G08、B2-G14（dev-doctor） | 网络/丢包真实故障注入 `BLOCKED-ENVIRONMENT` |
| G9 原生交互 | DEFERRED | RESULTS.json `nativePointerAndTcc`；gate-map 多显示器/全屏边界 | TCC、物理点击穿透、Spaces、多屏（本机单显示器） |
| G10 退出重启 | PASS | `first-shutdown`、`first-descriptor-cleanup`、`restart-shutdown`、`restart-descriptor-cleanup` | — |
| G11 复测稳定 | PASS | 三轮回放 3/3 首次成功、同一 DMG SHA | 长期稳定不属于三轮机械冒烟 |
| G12 日常试用 | NOT-STARTED | — | 作者连续使用 + 3–5 名技术友好用户一周（需用户招募同意） |
| S1 默认权限与越界审批 | TODO 待 Lead 整合 | 收尾修复进行中 | 整合前不写 PASS；历史风险见计划书 §3 S1 |
| S2 取消入口统一 | TODO 待 Lead 整合 | 收尾修复进行中 | 同上 |
| S3 凭据并发与原子性 | TODO 待 Lead 整合 | 收尾修复进行中 | 同上 |
| F1 正式状态与桌面投影 | TODO 待 Lead 整合 | 协议/投影矩阵验证进行中 | 同上 |
| B2-G01…G18（自动化） | 18/18 PASS（automated evidence level） | `gate-map.json`（sourceCommit `7d15cb18…`，artifactSha256 一致） | 其中 B2-G01/G03/G07（审批与协议语义）、B2-G15（凭据/auth/Origin/日志）只代表自动化证据层级，安全结论以 Lead 整合为准（`TODO`） |

门禁现状（本次改动后实测，命令见 §7）：`node product/tools/verify-product-docs.mjs` → exit 0；`node product/tools/verify-upstream.mjs` → exit 0（16347 official files / 47 explicit product overrides，修改根 README 后已按 `product/upstream-allowlist.json` 登记新 blob SHA）。以下两项为**改动前既有失败，独立于本次收尾**，不改写、不冒充已修复：全库 `verify-translation-pairing` exit 1（9 处产品新增 zh-only 文档，缺英文对与 `.i18n.yaml`）；`verify-repository-references` exit 1（改动前实测 180 处，主要集中在 `review/`、`.agent/` 既有证据中的 commit 标识；加入本文件后实测 206 处，其中 26 处来自本文件按 §10 要求记录的提交号）。本文件记录提交号是该门禁的已知冲突——"唯一事实入口必须写提交号"与上游"维护文件禁止记录 commit"两条规则不能同时满足，需要 Lead/上游策略决定，不能靠删除索引里的提交号绕过。另：`verify-md-wrap` 在改动前即报告 `README.md:126` / `README.zh.md:126` 的两个 HTML 锚点行（`git show HEAD:README.md` 为同一结构），本次未触碰该区域，保持既有状态。

## 5. 用户需配合事项

1. **真实 Provider / API key 授权**：在 DSH 设置 → Bot 填入 LLM 与 DashScope Key（或提供测试 Key），解锁 G2/G3/G4 与真实语音链路；凭据与费用归用户，产品不代持。
2. **真实麦克风与真人语音**：安静环境、外放回声、耳机、连续十轮、抢话、停止播报分别验证（G4/G5）。
3. **TCC / 点击穿透 / Spaces / 多屏 / 物理拖动**：在 Finder 与系统设置中人工授权并操作，提供截图或录屏（G9）；本机为单显示器，多屏项记录为 `BLOCKED-ENVIRONMENT`。
4. **旧产物删除的逐项授权**：清理清单与提案在私密交接目录，删除前需用户对具体条目确认；未确认时状态 `WAITING-USER`。
5. **发布授权（签名/公证/更新源）**：R 层需要 Apple Developer 账号与证书、公证流程与正式更新 feed 决策。
6. **试用招募（G12）**：作者连续使用并记录，随后 3–5 名技术友好用户一周试用；需要用户同意招募渠道与试用数据范围。
7. **远期路线变更批准**：变更提案在私密交接目录 `ROADMAP-CHANGE-PROPOSAL.md`，状态 `PENDING-USER-APPROVAL`；未批准前不修改权威路线图文件。

## 6. 当前下一步与历史索引

### 6.1 当前下一步

| 步骤 | 工作 | 依赖 | 完成判据 |
|---|---|---|---|
| 1 | 整合 S1–S3 与 F1 的结论：逐项给 PASS/FAIL/BLOCKED 与缺口，更新 §4 | 安全/协议收尾修复完成 | 每个门禁有命令与证据；不出现"条件通过" |
| 2 | 生成唯一收尾提交并填写 §1（当前检出提交与最终提交一致） | 步骤 1 | `git rev-parse HEAD` 与 tree 写入本文件 |
| 3 | 用新源码身份重建 DMG，重跑 `accept-macos.sh`、`gate-map.mjs`、三轮回放 | 步骤 2 | 新 DMG SHA 与 sourceCommit 一并替换 §2；旧候选入 §6.2 |
| 4 | 真实 Key / 真人语音 / TCC 人工验收 | 用户配合项 1–3 | G2–G5、G9 有绑定同一产物的证据 |
| 5 | 试用与体验指标 | 用户配合项 6 | G12 与计划书 §6.1 指标有分母与失败定义 |
| 6 | 旧产物清理执行、路线变更批准 | 用户配合项 4、7 | 清理记录与批准状态可复核 |

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
| 上一已验收候选（可验证） | 可用 | `0.0.1-beta` 构建 `f801a59ba957e01418d70ea8d44f55b965d10117`；DMG 实测 SHA-256 `7acadd6b…`、702,230,791 B（[验收记录](../review/0.0.1-mac-bubble-level-2026-10-29/STATUS.zh.md) 写 702,229,423 B，与实测不一致，以实测为准）；`accept-macos.sh` 15/15 PASS |
| 仅构建可验证的回滚点 | 构建可验证，验收记录未绑定 | beta2 候选 2 `6a6cdfd8…`，DMG 实测 SHA-256 `377345c6…`、702,479,827 B |
| `.agent/versions.json` 记录的回滚包 | ROLLBACK-RECORD-DRIFT + ROLLBACK-UNVERIFIED | 记录 `76d13562…` 的 `dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg`；`nisse/dist/v0.0.1-beta/` 实测只剩 `SHA256SUMS.txt`（无 DMG），记录路径 `$HOME/projects/dsh-bot-workspace/dist/…` 本机不存在。该记录不代表没有其他可用回滚点（见上两行），是否作为发布回滚基线需用户与 Lead 决定 |
| `nisse/dist/rc3-closure/` 同名 DMG | 未验收，不作为回滚包 | 实测 SHA-256 `6dc0db38…`（不是 `76d13562…`）；来源是 2026-10-25/26 本地构建（`mvp/rc3-closure` @ `8c34e669…`），材料目录中的本地验收报告（`nisse/review/rc3-closure-2026-10-25/LEAD-LOCAL-ACCEPTANCE.zh.md`，非本仓库文件）结论为"不建议按已交付 MVP Candidate 接受"（4 个 High 未解决），仅核心运行链路实测通过 |

## 7. 取数与复核

以下命令在 2026-10-31 09:43–10:06 +08 实际执行并据此填写本文件（两套文档门禁在 10:03:28 +08 复跑）；`<EVID>`、`<CANDIDATES>`、`<NISSE>` 为私密证据区占位符（本文件不公开本机绝对路径）。

```bash
# 仓库身份与候选版本
git rev-parse HEAD; git rev-parse HEAD^{tree}; git rev-parse --abbrev-ref HEAD; git status --porcelain
git diff --stat 7d15cb18 c772c2df
node -p "require('./product/versions.json').product.version"     # 0.0.1-beta2
node -p "require('./apps/desktop/package.json').version"         # 0.0.1-beta2
node -p "JSON.stringify(require('./product/versions.json').runtime)"

# 最近验收（只读私密证据区）
node -p "const r=require('<EVID>/acceptance-1793379224/RESULTS.json'); [r.status,Object.keys(r.phases).length,r.sourceCommit,r.dmg.sha256,r.voice,r.nativePointerAndTcc].join(' | ')"
node -p "JSON.stringify(require('<EVID>/gate-map.json').summary)"
node -p "JSON.stringify(require('<CANDIDATES>/beta2/7d15cb18/stability-summary.json').overall)"
shasum -a 256 <CANDIDATES>/beta2/7d15cb18/*.dmg; stat -f "%z" <CANDIDATES>/beta2/7d15cb18/*.dmg

# 回滚点与漂移
shasum -a 256 <CANDIDATES>/0.0.1-beta-f801a59b/*.dmg
shasum -a 256 <CANDIDATES>/beta2/6a6cdfd8/*.dmg
ls -la <NISSE>/dist/v0.0.1-beta/; cat <NISSE>/dist/v0.0.1-beta/SHA256SUMS.txt
shasum -a 256 <NISSE>/dist/rc3-closure/*.dmg
cat <NISSE>/dist/v0.1/SHA256SUMS.txt; shasum -a 256 <NISSE>/dist/v0.1/*.dmg

# 文档门禁
node product/tools/verify-product-docs.mjs    # exit 0
node product/tools/verify-upstream.mjs        # exit 0
```

## 8. 维护规则

- 只在打包验收、门禁结论或开发身份变化时改本文件；一行一处事实，不要把证据解释扩写成叙述。
- 任何重新构建都产生新身份：更新 §1/§2，并把上一候选移入 §6.2；不得只替换文字而保留旧 SHA。
- 不把历史 PASS 当当前 PASS；不把 fixture/mock 证据当真人或真实 Provider 证据；无法验证时写 `BLOCKED-*` / `DEFERRED` / `TODO`，不写"条件通过"。
- 改根 `README.md`、`README.zh.md`、`README.i18n.yaml` 后必须同步登记：在 `product/upstream-allowlist.json` 更新对应 blob SHA（`git hash-object <file>`），并用 `pnpm exec tsx scripts/verify-translation-pairing.ts --write README.md` 重录双语配对；否则 `verify-upstream` 或 `verify-translation-pairing` 会失败。
- 提交前分别运行 `node product/tools/verify-product-docs.mjs` 与 `node product/tools/verify-upstream.mjs`，两个都要 exit 0。
