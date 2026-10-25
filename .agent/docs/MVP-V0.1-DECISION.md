# 决策记录：Mac-first MVP 收敛（2026-10-24，执行版）

- **状态：** 已冻结并进入执行。标 `[待确认]` 的项需产品负责人签字后才能进入签名/公开分发。
- **适用版本：** dsh-bot v0.1（Mac MVP）
- **基线：** tag `wg-v0.1-baseline.1`（commit `d521e6579d4baf348ba5a3b2ea33cb14bfa3e84e`）
- **相关：** `versions.json`、`PRODUCT-MVP-GATES.md`、`docs/V0.1-GOLDEN-PATH.md`、`PRODUCT-RUNTIME-VERSION-CONTRACT.md`、`.agent/TASKBOOK.md`。

---

## 1. 结论

1. 进入 **Mac-first MVP 冲刺**，最终目标是交付可独立安装、配置、长期使用的 macOS Apple Silicon 产品，而不是"完成某个 P-M 子任务"。
2. 三条并行工作流：
   - **A / Mac 产品交付**：产品包、安装、凭据、权限、版本身份与更新；
   - **B / 记忆 + 产品 MVP**：Hindsight 随包内置 + 异步启动；人格/审批/电脑任务/会话统一到一条真实任务链；
   - **C / DSH 上游兼容与发布机制**：固定基线、兼容预检、受控升级。
3. **压缩的是功能范围与重复工程**，不是长期记忆、Agent 执行、审批安全、用户数据隔离这些产品核心。
4. **不新增架构层，不推倒现有实现。** 复用 DSH / Electron Shell / 桌宠 / Pipecat Worker / Bridge / Hindsight Adapter。
5. 验收采用 `MVP PASS` / `MVP PASS WITH CONDITION` / `FULL PASS` / `DEFERRED` / `BLOCKED`；不把开发环境证据当安装包证据，不把 unsigned 当公开发行。

## 2. 已冻结决策

| # | 决策 | 冻结值 | 状态 |
|---|---|---|---|
| 1 | 产品名称 | dsh-bot / dsh-bot | 冻结 |
| 2 | 首发平台 | macOS Apple Silicon | 冻结 |
| 3 | 后续平台 | Windows / Linux 保留边界，不阻塞 v0.1 | 冻结 |
| 4 | Agent 内核 | DSH，唯一权威 | 冻结 |
| 5 | DSH 基线 | `dsh-v0.2.1-rc.2`（fork +44 commits） | 冻结；rc.3 只预检 |
| 6 | 长期记忆 | Hindsight 1.0.0，**随包内置 + 异步启动**（用户 2026-10-24 批准） | 冻结 |
| 7 | 语音 | Pipecat 1.13.0 + SmallWebRTC + DashScope，沿用命令式打断契约 | 冻结 |
| 8 | 安装交付 | 先 v0.1-internal（ad-hoc DMG），v0.1-public 单列 | 冻结 |
| 9 | 版本方案 | Product `0.1.0` 与 DSH runtime `0.2.1-rc.2` 分离 | 已实现（基线 commit） |
| 10 | DSH 更新 | 自动发现 + 兼容验证 + 人工批准；产品不直接追 upstream 最新版 | 冻结 |
| 11 | Mac 自动更新 | 纳入正式分发门禁；GitHub Releases 为目标源，本地 feed 为开发入口 | 冻结 |
| 12 | 主 DSH | `~/.dsh` 只读隔离，不清理/不重启/不复用 | 冻结，持续验证 |
| 13 | 应用身份 | `[待确认]` 内部包暂用 `ai.nisse.app`；首次公证前定稿 | 待产品负责人 |

## 3. 版本与更新分层

| 层 | 内容 | 版本来源 | 升级方式 |
|---|---|---|---|
| 产品层 | Shell、设置、人格、记忆 UI、权限、用户数据 | `versions.json: product`（0.1.0） | 产品更新通道 |
| 运行时层 | DSH + Bridge + Voice Worker + Hindsight | `versions.json: runtime.*` | 隔离验证 + 人工批准后切换 |
| 数据层 | DSH home、记忆 bank、设置、凭据 | `dataFormatVersion` + 迁移脚本 | 迁移前备份，失败回滚 |

## 4. v0.1 MVP 验收矩阵

| 门 | v0.1 必须完成 | 首版 DEFERRED | 当前状态 |
|---|---|---|---|
| P-M1 记忆 | 内置 Hindsight 生命周期；跨会话写入/检索；查看/纠正/删除/导出；备份恢复；敏感拦截；删除后不可检索 | 知识图谱、自动整理、多 bank 策略 | 组件已验证；随包集成进行中 |
| P-M2 人格 | 权威人格配置真实改变 DSH 回复 | 人格市场、情绪模型 | 组件有 dev 证据，待产品包证据 |
| P-M3 审批 | 允许/拒绝、任务绑定、取消、危险操作保护、审计 | 永久授权策略引擎 | dev 真 DSH 审批 PASS，待产品包 |
| P-M4 电脑任务 | 一条低风险真实任务 + 一条需审批操作 + 语音汇报 | 全应用自动化 | 语音回传 PASS，待 packaged 主线 |
| P-M5 会话 | 语音/文本共享 DSH 会话；取消无新动作；迟到事件隔离 | 跨会话自主编排 | 竞态已修复，待产品包证据 |
| P-M6 体验 | onboarding + 统一设置（模型/语音/人格/记忆/权限/凭据） | 完整角色定制、主题 | 原型齐；SecretStore 待实现 |
| P-M7 交付 | 干净安装、Finder 启动、真实 TCC、退出回收、更新冒烟、备份回滚 | Windows/Linux 正式发布、差分/灰度 | 包内语音 E2E + SIGTERM 清理 PASS；DMG/TCC/签名/更新进行中 |

## 5. 工作流与写入所有权

| 流 | 目标 | 独占写入 |
|---|---|---|
| A | Mac 产品交付 | `nisse-dsh/apps/desktop/**`（独立分支）、`m3/pet/**`、`m3/bot/**`、`dist/v0.1/**` |
| B | 记忆 + 产品 MVP | `product/memory/**`、`m4/evidence/**`；`spike/m1-c-hindsight/**` 只读 |
| C | 上游兼容与发布机制 | `tools/upstream-sync/**`、`docs/UPSTREAM-SYNC.md`、`docs/reports/**` |

集成点：A 打包读 C 的版本清单；A 的 BotRuntime 管理 B 的 memory sidecar；B 复用 A 的设置/凭据架构。共享文件只由指定负责人修改。

## 6. 先测量风险

| 风险 | 现状 | 处置 |
|---|---|---|
| R1 Hindsight 体积/启动/RSS | PyInstaller 419MB + pg0 36MB + int8 113MB ≈ 568MB；暖启动 13.2–14.1s；RSS ~1.1GB；离线链路已验证 | 随包内置 + 异步启动；UI「记忆准备中」 |
| R2 DSH rc.3 兼容 | rc.3 服务端源码仅 1 行注释变化；client UI 扩展点新增 | C 流隔离构建预检，不升级 |
| R3 签名/TCC 身份 | ad-hoc 内部包；真实 TCC 需用户 Finder 启动 | 内部验收 + `DEFERRED-EXTERNAL` |
| R4 更新/回滚 | 有 electron-updater/feed；mac 本地更新测试需新建 | A 流本地 feed 演练 |
| R5 主 DSH 隔离 | 已确认主 DSH 未被写入 | 每轮 marker/metadata 校验 |

## 7. 反作弊规则

1. 开发环境证据 ≠ 安装包证据；Chromium ≠ Electron/真实麦克风。
2. 命令式打断 ≠ 自由插话；停止播报 ≠ 取消任务。
3. 未复现的 300s 超时不得写成已修复。
4. 删除记忆后必须重新检索证明不可见；拒绝审批必须证明操作未执行。
5. 任何 `MVP PASS` 必须附可复现命令 + 结构化证据。
6. 主 DSH 任何写入视为 P0 事故。
7. 内部 unsigned/更新演练不得宣称为正式自动更新通过。

## 8. 待产品负责人确认

1. **应用身份定稿**（首次公证前）：保留 `ai.nisse.app` 还是改 `ai.nisse.whalegirlbot`。
2. **签名条件**：Apple Developer Program / Developer ID / 公证凭据是否具备。
3. **主 DSH 清理授权**：默认不授权（保持只读隔离）。

## 9. 明确不做

- 不新增通用 Agent 平台抽象；不改 DSH 核心（必要补丁记入 fork 差异）。
- MVP 期间不升级 DSH 基线（rc.3 只预检）。
- 不做 Windows/Linux 正式发布、差分更新、灰度通道。
- 不引入 dsh-pet 的独立聊天/记忆体系。
