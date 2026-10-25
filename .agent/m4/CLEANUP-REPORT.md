# W13 清理报告 + 旧 qwen 入口清单（2026-10-22）

> Owner: teammate m4-audit（task-3）。范围：`$HOME/projects/dsh-bot-workspace`（项目根，**非 git 仓库**）。
> 未改动产品 fork `$HOME/projects/dsh-bot/**`（只读检查）、未改 `m3/pet/**`、未改 `apps/**`、
> 未打包、未 git commit。本报告在 `m4/CLEANUP-REPORT.md`，配套审计见 `AUDIT-2026-10-22-PM.md`。

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| `m3/shell`（M3 Electron Shell 原型） | ✅ **已删除**（grep 无代码引用 / 无进程占用 / 历史证据已保留） |
| 旧入口引用更新 | ✅ `m4/M4-DOGFOOD.md`、`m4/M4-FINAL-REPORT.md` 已加 W13 删除说明；`m3/M3-*.md` 为历史报告，保留原文 |
| 旧 qwen 入口清单 | ✅ 见 §3（含保留/建议，**未删除** `m3/pet`、`research/qwen-audio-agent`、`dsh-nisse`） |
| 可复跑验证脚本 | ✅ `tools/verify-m4.sh`（+ `tools/verify-m4.mjs`、`tools/m4-approval-e2e.mjs`），见 §5 |
| 许可证/NOTICE | ⚠️ 发现 1 处缺口（根 `NOTICE.md` 未写明 qwen-audio-agent 的 Apache-2.0/版本/pin），**只报告未改** |
| 清洁检查 | ✅ 未发现仓库内明文密钥/凭据文件；毛病类文件仅 1 个根 `.DS_Store`（未来 git init 时已被忽略） |
| 产品 fork | ⚠️ 审计时工作树有 1 个 **Lead 正在修改**的未提交文件（非本次清理造成），无未跟踪垃圾 |

## 2. `m3/shell` 删除记录（W13 核心动作）

### 2.1 删除前检查（证据：`m4/cleanup-evidence/PRE-DELETE-MANIFEST.txt`）

- **路径确认**：`cd $HOME/projects/dsh-bot-workspace/m3/shell && pwd -P` → `$HOME/projects/dsh-bot-workspace/m3/shell`（绝对路径复核后才删除）；
- **文件清单 + SHA256**：10 个文件，96K（`main.mjs`、`preload.cjs`、`renderer.html`、`package.json`、`run-real.sh`、`test-shell.mjs`、2 张托盘图、evidence 2 个）；
- **进程检查**：`lsof +D m3/shell` 为空；`ps aux` 无任何进程引用 `m3/shell`；
- **代码引用检查**（grep `m3/shell|shell/run-real|shell/main.mjs|run-real.sh|M3-shell-ui`，排除 node_modules/.git 与 m3/shell 自身）：
  - 项目根内**没有任何 import / spawn / 构建脚本**引用它；
  - 命中仅 3 类：① 任务书记载 W13 本身；② `m3/M3-FINAL-REPORT.md`、`m3/M3-SHELL-REPORT.md`（历史报告）；③ `m4/M4-DOGFOOD.md`、`m4/M4-FINAL-REPORT.md`（旧入口说明，已更新）；
  - 产品 fork `nisse-dsh` 全树 grep：**0 命中**（壳不依赖此原型）。

### 2.2 删除与证据保留

- 删除：`rm -rf $HOME/projects/dsh-bot-workspace/m3/shell`，删除后 `[ ! -e ... ]` 复核通过；
- 历史证据**不随删除丢失**，已复制到 `m4/cleanup-evidence/`：
  - `M3-shell-ui.png`（UI 截图，46659 B，sha256 `7914388d…acf4c`）；
  - `M3-shell-RESULT.json`（历史结果：smoke-app / single-instance / no-orphans **3/3 PASS**，2026-10-21T17:43Z）；
  - `PRE-DELETE-MANIFEST.txt`（完整清单、SHA256、grep 证据、无进程证据、删除确认）；
- `m3/M3-*.md` 历史报告保留原文（记录 M3 阶段事实）；由于它们引用了已删除路径，**以本报告为当前事实源**
  （如需彻底消除历史引用，建议 Lead 在归档时统一加"已删除，见 CLEANUP-REPORT"注记）。

## 3. 旧 qwen 入口清单（全项目盘点）

| 路径 | 性质 | 当前状态 | 建议 | 本次动作 |
|---|---|---|---|---|
| `m3/pet/`（`@qwen-audio-agent/desktop` 2.0.1 Electron + shared/web） | qwen 桌宠/Body Runtime 代码；入口 `m3/pet/open-dsh.sh`（打开 dsh-bot 桌面 App） | **正在由 body-runtime/Lead 改造为纯 Body Runtime**（另一 task 进行中） | **保留**，按 Body Runtime 合同收敛；“旧 qwen 入口”在此目录内属改造对象，不由 W13 删除 | 未动（只读盘点） |
| `research/qwen-audio-agent/` | qwen-audio-agent v2.0.1 上游完整 checkout（1.4G，gitignored），含 Nisse 74 文件本地修改 | 上游参考 + 语音链路来源；`NISSE-NOTICE.md` Apache-2.0 声明完整 | **保留**（上游参考）；体积大，已由 `.gitignore` 的 `research/` 排除，不随仓库分发 | 未动 |
| `research/skins/`、`research/whale-girl/`、`research/brand/` | dsh-bot皮肤构建工具/素材（MIT）与品牌资料 | 参考资产 | **保留** | 未动 |
| `dsh-nisse/`（v0.6.0 Host 插件 bundle） | M1 时代 qwen→DSH 桥插件（loopback HTTP+SSE、`~/.dsh-nisse/bridge.json`）；`install/install-desktop-profile.sh` 会改**用户 `~/.dsh` desktop profile** | 已被产品 fork 的 `nisse/packages/host-integration`（v0.1.0，M3/M4 使用）取代；**不是当前产品路径** | **保留作参考，不要安装**；若 M6 前不再使用，建议整体 archive 并删除 install 脚本的默认 `~/.dsh` 目标 | 未动（只读盘点） |
| `desktop-fork/`（qwen-audio-agent v2.0.1 patch overlay + `build.sh`） | 旧 Nisse 2.3.1 桌面 App（qwen 前台壳）的构建材料；UPSTREAM pin `a73bcbc` | 已被 DSH 桌面产品 fork 取代；**不是当前产品路径** | **保留作历史构建参考**；不再作为发布路径；可 M6 后归档 | 未动 |
| `dist/`（`nisse-2.3.1-mac-arm64.dmg` 133M + 2 个 review zip） | 旧 Nisse 2.3.1 unsigned/unnotarized DMG、review 包 | 本地历史产物；`.gitignore` 的 `dist/` 已忽略 | **保留在本机**，不提交；M6 发布前建议清空/归档 | 未动 |
| `spike/dsh-voice/`、`spike/m1-bot/`、`spike/tools/` | M0/M1 语音/桌宠/WEBUI 实验 spike（含 run.sh/stop.sh） | 历史实验，**非产品路径**；`spike/logs/` 已 ignored | 保留（研究价值）；旧 run.sh 仅供复现，不要当产品入口 | 未动 |
| `spike/m1-c-hindsight/` | Hindsight 本地记忆服务（M4 memory 测试依赖，mock LLM 零外发） | **仍被 `m4/test-m4-memory.mjs` 使用** | **保留**（M4-6 运行时依赖） | 未动 |
| `assistant/` | 产品定义 v0.1–v3.0 与早期工作文档（历史） | 历史产品文档 | 保留（决策溯源） | 未动 |
| `m1a/`、`m2/`、`m3/{bot,brand,contract,fault-injection,host-integration,product-state,supervisor,voice-runtime}` | 里程碑证据、fork 构建模板、M3 测试与契约、M4 依赖 | 历史 + 现役（M3 套件、M4 测试复用） | **保留** | 未动 |
| `m3/shell/` | M3 Electron Shell 原型（状态卡 UI，监督 DSH Host + Voice stub） | **已删除**（W13） | 删除完成 | ✅ 删除 + 证据保留 |
| `/Applications/Nisse.app`（v2.3.1） | 机器上安装的**旧 qwen 前台 App**（仓库外） | 旧产品残留，不是 dsh-bot；本报告未启动/未删除 | **建议用户决定是否卸载**（避免误启旧入口；不影响本仓库验证） | 未动（仓库外） |
| `~/.dsh-nisse/`、`~/Documents/Nisse/`、`~/Library/Application Support/Nisse/` | 旧 dsh-nisse / 旧 App 的用户级状态（仓库外） | 残留运行时状态（bridge.json、记忆工作区、备份） | 由用户/Lead 决定清理；**审计未触碰** | 未动（仓库外） |

> 说明：`/tmp` 下实验脚本/隔离 DSH_HOME 不属于仓库，W13 不纳入；本次验证新产生的 `/tmp/nisse-m4-*` 均为测试隔离目录，可用 `rm -rf` 清理。

## 4. W13 工作包（WO）清单

| WO | 状态 | 内容 | 验收证据 |
|---|---|---|---|
| W13-01 删除 `m3/shell` | ✅ DONE | 引用 grep + 进程检查 + SHA256 清单 → 删除 → 复核不存在 | `m4/cleanup-evidence/PRE-DELETE-MANIFEST.txt` |
| W13-02 更新旧入口文档引用 | ✅ DONE | `m4/M4-DOGFOOD.md`、`m4/M4-FINAL-REPORT.md` 标注删除与替代入口状态；`m3/M3-*.md` 保留历史原文 | 本报告 §2.2；两文档 W13 注记 |
| W13-03 旧 qwen 入口盘点 | ✅ DONE | 见 §3 全表（保留/删除建议，未删其他目录） | 本报告 §3 |
| W13-04 保留 M3 shell 历史证据 | ✅ DONE | 截图 + 结果 JSON + 清单移入 `m4/cleanup-evidence/` | 本报告 §2.2 |
| W13-05 许可证/NOTICE 缺口 | ⏳ OPEN（只报告） | 根 `NOTICE.md` 未写明 qwen-audio-agent 为 **Apache-2.0**、未写版本/pin `v2.0.1 a73bcbc`、未指向 `research/qwen-audio-agent/NISSE-NOTICE.md`；若分发含 `m3/pet`（qwen fork）代码，需随包附 Apache-2.0 LICENSE/NOTICE | 本报告 §6 |
| W13-06 旧 App/用户态残留清理决策 | ⏳ OPEN（需用户/Lead） | `/Applications/Nisse.app`（2.3.1）、`~/.dsh-nisse/`、`~/Documents/Nisse/`、`~/Library/Application Support/Nisse/` 是否清理 | 本报告 §3 末行 |
| W13-07 m3 历史报告路径标注 | ⏳ OPEN（低优先） | `m3/M3-FINAL-REPORT.md`、`m3/M3-SHELL-REPORT.md` 仍引用已删除路径；归档时统一加注记 | 本报告 §2.2 |
| W13-08 真机语音 dogfood 入口 | ⏳ BLOCKED（等待 Lead/body-runtime） | `m3/shell/run-real.sh` 删除后，dogfood 入口需改为产品桌面 App 并经真实麦克风验证；当前 **UNVERIFIED** | `m4/M4-DOGFOOD.md`、`AUDIT-2026-10-22-PM.md` §5 |
| W13-09 `dsh-nisse` install 脚本默认写 `~/.dsh` | ⏳ OPEN（低优先/安全） | 该旧插件 install 脚本默认改用户 desktop profile；建议 archive 时加废弃警示或改默认目标 | 本报告 §3 |
| W13-10 新增可复跑验证脚本 | ✅ DONE | `tools/verify-m4.sh`（隔离 DSH_HOME + 真实 approval allow/reject + 断言文件存在/不存在，exit code 0/1/2） | `m4/evidence/VERIFY-M4.json`、`m4/evidence/HOST-APPROVAL-RERUN.json` |

## 5. 可复跑验证脚本（W13-10）

```bash
cd $HOME/projects/dsh-bot-workspace
./tools/verify-m4.sh              # 确定性本地套件 + 真实审批 allow/reject（需 ~/.dsh 凭据 + 真实模型）
./tools/verify-m4.sh --no-model   # 只跑确定性本地套件（审批 E2E 记 SKIP/UNVERIFIED）
./tools/verify-m4.sh --full       # 额外重跑 6 文件 M4 E2E/安全套件
```

| 脚本 | 作用 |
|---|---|
| `tools/verify-m4.sh` | 入口（薄 bash wrapper，透传参数；exit 0=PASS / 1=FAIL / 2=前置失败） |
| `tools/verify-m4.mjs` | 编排器：preflight（node≥22、DSH CLI、install-profile、supervisor、zstd、凭据）→ 跑 `m4/test-m4-stop-semantics.mjs`（纯确定性）→ `m4/test-m4-memory.mjs`（本地 Hindsight + mock LLM，零外发；本脚本启动的 Hindsight 会再次停止）→ `tools/m4-approval-e2e.mjs` → 可选 `m4/run-all.mjs`；汇总写 `m4/evidence/VERIFY-M4.json` |
| `tools/m4-approval-e2e.mjs` | 真实审批 E2E：隔离 `DSH_HOME=/tmp/nisse-m4-approval-verify/dsh-home` 启动真实 DSH host（`DshHostSupervisor` + `bot-outside-write` 预设），真实模型 turn 调用 `write` 写**工作区外**路径，经 bridge `POST /approval` 分别 allow/reject；断言 **allow → 文件存在且内容非空**、**reject → 文件不存在**、outcome 为 `allowed-once` / `rejected`；只读复制 `~/.dsh/.credentials.yaml` 到隔离 home（0600），**不写 `~/.dsh`**；结果写 `m4/evidence/HOST-APPROVAL-RERUN.json` |

最近一次运行（本报告交付前）：
- `default` 模式 **PASS**（exit 0）：热缓存一次 17.2s（stop 0.3s、memory 1.9s、approval 13.5s）；冷启动一次 **35.8s**
  （stop 0.3s、memory 17.4s 含本地 Hindsight 启动、approval 15.9s；allow 6.8s / reject 7.6s），allow/reject 两 case 均 PASS；
- `--no-model` 模式亦 **PASS**（17.8s；approval SKIP，Hindsight 启动后已被脚本停止，端口 18888 释放，无残留 DSH host）。
证据：`m4/evidence/VERIFY-M4-RERUN.log`、`m4/evidence/VERIFY-M4-NOMODEL.log`、`m4/evidence/VERIFY-M4.json`、
`m4/evidence/VERIFY-M4-NOMODEL.json`、`m4/evidence/HOST-APPROVAL-RERUN.json`。运行结束后已确认无残留 DSH host、Hindsight 已停止。

## 6. 许可证 / 清洁检查（只报告，不改代码）

### 6.1 许可证

| 检查项 | 结果 |
|---|---|
| 项目根 `LICENSE` | ✅ MIT（"dsh-bot contributors"），覆盖本项目自有代码 |
| 项目根 `NOTICE.md` | ⚠️ **不完整**：列了 DSH（MIT）、whale-girl（MIT）、qwen-audio-agent（仅写 "reused modules per upstream license"，**未写 Apache-2.0 / 未写版本 v2.0.1 a73bcbc / 未指向** `research/qwen-audio-agent/NISSE-NOTICE.md`）、Coopanion（仅 UX 想法，无 AGPL 代码） |
| qwen-audio-agent（`research/qwen-audio-agent/`） | ✅ 上游 `LICENSE`=Apache-2.0、`NOTICE`、`THIRD_PARTY_NOTICES.md` 齐全；`NISSE-NOTICE.md` 声明了来源/版本/修改（品牌、皮肤、语音交互等）+ whale-girl MIT + pypinyin MIT |
| whale-girl 素材（`research/whale-girl/`） | ✅ MIT，Copyright (c) 2026 Sam Gao (vlln)；产品 fork 已内置 `apps/desktop/resources/whale-girl/NOTICE.txt` |
| 产品 fork | ✅ 根 `LICENSE` = 上游 DSH MIT（Copyright (c) 2026 DeepSeek，保留）；`THIRD_PARTY_NOTICES.md` 25KB；`nisse/scripts/license-inventory.sh` 可生成依赖许可清单；桌面 Licenses 页已有（历史审计 PASS） |
| 品牌声明 | ✅ `m3/brand/BRAND.md`：非官方/非商业二创、用户已确认角色授权、保留 vlln MIT 署名、不用 DeepSeek 官方 Logo；签名/公证暂缓（M6） |

**建议（M6 打包前）**：① 根 NOTICE 明确 qwen-audio-agent = Apache-2.0 + 版本/pin + 修改说明指针；② 若最终安装包内含 `m3/pet`（qwen fork）代码，随包附 Apache-2.0 LICENSE + NISSE-NOTICE + THIRD_PARTY_NOTICES；③ 发布物保留 DSH MIT LICENSE/NOTICE。

### 6.2 清洁检查

| 检查项 | 结果 |
|---|---|
| 项目根 git 状态 | 不是 git 仓库（无提交）；`.gitignore` 已就位，为将来 init 做准备 |
| nisse 根 `.gitignore` 覆盖 | ✅ `node_modules/`、`dist/`、`out/`、`research/`、`.plan/`、`dsh-nisse/dist/`、`m1a/backup/`、`spike/node_modules/`、`spike/logs/`、`.env*`、`*.pem/*.key`、`secrets/`、`.DS_Store` 等 |
| 明文密钥/凭据文件扫描 | ✅ 项目根（排除 `node_modules`、`research/qwen-audio-agent` 上游树）**0 命中**（`.env*`/`config.env`/`*.pem`/`*.key`/`*credentials*`） |
| 垃圾文件 | ⚠️ 仅 1 个根 `.DS_Store`（已被 .gitignore 覆盖；可随时删）；无其他明显临时垃圾 |
| 大体积/被忽略内容 | `research/qwen-audio-agent` 1.4G、`dist/` 134M、`m1a/` 68M 等均在本机，`.gitignore` 已排除（research/dist/m1a/backup）；项目根合计 1.6G |
| 产品 fork `nisse-dsh` 工作树 | 审计时（2026-10-22 21:1x）：`git status --porcelain` 有 **1 个未提交修改** `nisse/packages/host-integration/lib/index.js`（+73/−16，**Lead 审批接线正在进行，非本次清理造成**）；**0 个未跟踪非忽略文件**；726 个被忽略路径（构建缓存/`node_modules`/`lib`/`.desktop-build` 等，正常）；分支 `nisse/main`，HEAD `9b22d2371a`，领先 `origin/nisse/main` **9 个本地提交** |
| `research/qwen-audio-agent` git 状态 | HEAD `a73bcbc`（v2.0.1），工作树 74 个 Nisse 本地修改（历史已知，属参考树，不提交产品仓库） |
| 测试进程/服务 | ✅ 本次验证结束后无残留 DSH host；Hindsight（18888）已停止；验证脚本可重复清理（--no-model 路径已验证） |

## 7. 证据索引

- `m4/cleanup-evidence/PRE-DELETE-MANIFEST.txt` — m3/shell 删除前完整清单/SHA256/引用/进程证据
- `m4/cleanup-evidence/M3-shell-ui.png`、`M3-shell-RESULT.json` — 保留的 M3 Shell 历史证据
- `m4/evidence/VERIFY-M4.json` — 可复跑验证汇总（default 模式）
- `m4/evidence/VERIFY-M4-RERUN.log`、`VERIFY-M4-NOMODEL.log` — 两种模式运行日志
- `m4/evidence/HOST-APPROVAL-RERUN.json` — 本次真实审批 allow/reject 证据（fork HEAD `9b22d2371a`）
- `m4/bot-evidence/HOST-APPROVAL-RESULT.json` — Lead 之前的真实审批 PASS 证据（本次未覆盖）
- `AUDIT-2026-10-22-PM.md` — 本次完整审计报告
