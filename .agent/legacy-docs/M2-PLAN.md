# M2 计划：DSH 发行底座与可复现构建（准备阶段）

> 状态：**完成（baseline，2026-10-21）**：M2-0…M2-6 全部通过；结论与证据见 [m2/M2-FINAL-REPORT.md](m2/M2-FINAL-REPORT.md)。
> 前置已满足：用户明确启动 M2，并授权自行 fork 上游；M1 为 Conditional Go（不阻塞 M2 启动，缺口见 M1-FINAL-REPORT）。
> 依据：[ROADMAP-M0-TO-1.0.md](ROADMAP-M0-TO-1.0.md) M2、[research/dsh-fork-decision.md](research/dsh-fork-decision.md)、ADR-0005
> 目标：证明 Nisse 能在干净环境从受控 fork 构建，且上游同步成本可测；不做产品 UI/记忆/安装器。

## 0. 当前就绪度（本机只读检查，2026-10-21）

| 项 | 状态 |
|---|---|
| M1 | **Conditional**（T5/T7 等未补测）→ 尚未满足 M2 的正式前置 |
| DSH 版本 | 已安装 0.2.1-rc.2（只读参考） |
| 上游仓库 | ✅ 已定位 `deepseek-ai/deepseek-harness`（MIT，公开）；**fork**: `dsh-bot/deepseek-harness` |
| Node / pnpm / git | v24.18.0 / 12.3.4 / 2.39.5 ✅ |
| 磁盘 | 2026-10-21 清理后约 **30 GiB** 可用；M2-2 安装/构建期间持续监控 |
| 网络 | ✅ 已批准并验证（GitHub/克隆/pnpm 安装）；构建依赖下载中 |
| 现有文档 | `research/dsh-fork-decision.md`、`research/dsh-fork/{seams,upstream-cost,nisse-gaps}.md`、ADR-0005 |

## 1. 工作包（正式开工后顺序执行）

| # | 工作包 | 产物 | 备注 |
|---|---|---|---|
| M2-0 | 就绪检查与许可 | `m2/preflight-report.txt`、许可清单 | 本阶段可先做（已提供脚本） |
| M2-1 | fork 脚手架 | `UPSTREAM.txt`、分支模型（upstream/main/upstream-sync/nisse-vX）、目录规范（`apps/nisse/**`、`packages/nisse-*`） | 本阶段可先写模板 |
| M2-2 | 干净构建基线 | clone 上游 pinned tag → `pnpm install` → build → 记录依赖/耗时/产物 sha | 需网络批准 |
| M2-3 | Nisse profile/资产最小接入 | 发行 profile、品牌/账号/遥测裁剪决策记录 | 依赖 M2-2 |
| M2-4 | patch queue | `nisse/patches/<id>/PATCH.md` + 每个 patch 的测试 | 只允许 ADR-0005 允许的 patch |
| M2-5 | 上游同步演练 ×2 | merge/rebase 冲突、耗时、失败测试、delta 清单 | 校准 ADR-0005 阈值 |
| M2-6 | 隔离/许可/CI 冒烟 | 独立 DSH_HOME 启动、SBOM/第三方声明、CI smoke | 不写 `~/.dsh` |

**退出标准**：干净环境可复现构建；patch 可应用且有测试；≥2 次上游 merge 成本有数据且未超 ADR-0005 阈值；
独立 DSH_HOME 启动冒烟通过；许可/SBOM 清单完整；失败/替代路径明确。

## 2. M2-1 已完成（2026-10-21）

- Fork 仓库：https://github.com/dsh-bot/deepseek-harness
- 本地 fork workspace：`$HOME/projects/dsh-bot`（独立 git 树，非 Nisse 项目仓库）
- 上游 pin：**dsh-v0.2.1-rc.2**，commit `687f282e8625c6b8d11ff58211a90524be2e4317`（与安装版一致）
- 分支：`nis se/main` 已推送到 fork；远端 `master` 指向同一上游 commit
- 脚手架：`UPSTREAM.txt`、`nisse/README.md`、`nisse/patches/`（当前无 core patch）、`.nisse/`（本地构建产物，gitignored）
- 分支模型：`master`（上游镜像）/ `nisse/main`（distro 分支）/ `upstream-sync/<tag>`（M2-5 演练）

## 2.5 M2-2 已完成（2026-10-21）

- install **24.1s**（`pnpm install --frozen-lockfile`；官方 registry 慢时用镜像，未写入仓库）
- typecheck **97.92s**（5/5 gates）、build **27.03s**（9/9 gates）、build:check **7.95s**（2/2）
- Node v24.18.0 / pnpm 11.28.5 / macOS arm64；无 core 改动，`git status` 干净
- 产物 sha256 记录在 fork `UPSTREAM.txt`；报告 [m2/M2-2-REPORT.md](m2/M2-2-REPORT.md)
- fork 提交：`nisse(m2): record clean build baseline (M2-2)`

## 3. 本阶段（准备）已交付

- `m2/templates/UPSTREAM.txt`：版本/来源/构建环境记录模板；
- `m2/templates/PATCH.md`：patch manifest 模板（目的/影响文件/上游基线/测试/移除条件/rebase 说明）；
- `m2/scripts/preflight.sh`：本机就绪检查（工具链/磁盘/DSH 版本/上游 checkout 检测；默认不联网）；
- `m2/README.md`：M2 启动步骤与纪律；
- `m2/preflight-report.txt`：本次预检输出。

## 3. 需要用户提供/批准（正式开工前）

1. **DSH 上游仓库**：仓库地址 + 访问方式（公开 clone / 私有凭据），目标 tag/commit（建议 pin 一个 release）；
2. **联网与安装许可**：clone 上游 + `pnpm install` + 构建依赖（会下载较多包/原生依赖）；
3. **磁盘空间**：当前 18 GiB 偏紧；建议清理或指定更大磁盘（M2-2 预计需要 30–50 GiB）；
4. **M1 补测**：T5 播报中打断、T7 审批（决定是否正式 Go；未 Go 前 M2 只做准备，不进入构建）。

## 4. 风险

- 上游构建复杂度/耗时未知（依赖若含原生模块，macOS arm64 可能需要额外工具链）；
- 网络受限导致依赖不可得 → 需准备镜像/离线缓存方案；
- 磁盘不足导致构建中断；
- 上游 API 变化导致 Host Integration/patch 失效 → 依赖 M1 契约与 patch 测试；
- fork 维护成本超 ADR-0005 阈值 → 按 ADR 降级（更少 patch / 纯插件路线评估）。

## 5. 下一步（现在可做 vs 等用户）

我可以立即做（无需网络/不改用户环境）：
- 完成 `m2/` 脚手架与预检报告；
- 写 M2-2 构建步骤草稿（命令清单，待网络批准后执行）；
- 把 M2-1/M2-4 模板与验收清单补齐。

需要等用户：
- 上游仓库地址/凭据与联网批准；
- M1 补测完成 → 正式 Go；
- 磁盘空间决策。

## 6. v3 新增要求（2026-10-21 冻结）

1. **Hindsight 固定版本**：M1-C 选定的 Hindsight 版本/本地运行时/依赖/许可/数据目录/升级回滚，必须纳入 M2 构建与安装验证；
   不允许 M2 后仍“待选型”。
2. **Host Integration 契约测试**：Bot 会话管理/路由/接管锁/摘要/预算/审计事件（`BOT-SESSION-ORCHESTRATION.md`）
   需要进入 M2 回归；不修改 DSH 核心的约束需有验证证据。
3. **不改核心约束**：M2 构建/merge 后需跑 Route A 的“无核心修改”检查（diff/上游文件完整性 + 契约测试）；
   任何 core patch 必须重新获得用户批准并走 ADR-0005 patch queue。
4. **M1-C 输出依赖**：Hindsight 若 No-Go，M2 不得按“Hindsight 已集成”假设继续，需用户裁决。
5. **估算**：Bot/Hindsight 的构建/打包/资源开销需在 M2 记录区间与假设，不写成承诺。
