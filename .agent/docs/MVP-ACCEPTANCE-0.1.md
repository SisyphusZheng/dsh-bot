# dsh-bot v0.1 内部 MVP 验收报告（2026-10-24）

- 状态：**INTERNAL MVP — CONDITIONAL**（不是公开发布 PASS）
- 产物：`dist/v0.1/whalegirlbot-0.1.0-mac-arm64-unsigned.dmg`
- SHA-256：`120e7b83c30c43658d63555a9343c6577e2ff15a65896d2e3af68559471640bf`
- 构建 commit：`a5dd919a3e`（基线 tag `wg-v0.1-baseline.1` / `d521e6579d`）
- 产品版本：0.1.0；内嵌 DSH runtime：0.2.1-rc.2；数据格式：v1

## A. 已完成并验证

| 项 | 结果 | 证据 |
|---|---|---|
| 版本分离 | 产品 0.1.0 与 DSH runtime 0.2.1-rc.2 独立；构建前后源码树一致 | `m3/pet/evidence/BASELINE-BUILD-0.1.0.json`、`m4/evidence/PREFLIGHT-*.json` |
| 基线 | `wg-v0.1-baseline.1`，本地未 push | `versions.json` |
| host-integration 竞态 | single-flight ensureAgent + ready 语义 + 409 结构化错误；预检 3/3 PASS；回退旧代码可稳定复现 4×500 | `m4/preflight.mjs`、`m4/evidence/PREFLIGHT-2026-10-24T11-24-10.583Z.json` |
| 记忆随包内置 | Resources/memory（Hindsight 419MB + int8 模型 + pg0）+ Contents/spike adapter；异步启动 | `product/memory/**`、`m4/evidence/MEMORY-PAYLOAD-COPY.json` |
| 记忆打包运行 | 安装包内 phase=ready，server+sidecar URL 就绪，search 返回 ok；数据在 `<userData>/dsh-home/memory` | `m3/pet/evidence/BUILD-0.1.0-FINAL.json` |
| 应用身份 | 独立 userData `~/Library/Application Support/dsh-bot` 与单实例锁（不再与 DSH 抢锁） | `ca296dc1f1` |
| 进程隔离 | 继承污染的 DSH_* 环境下 Host 仍使用产品 dsh-home；退出后无 dsh-bot/pet/worker/memory 进程 | 同上 + `MAIN-DSH-INCIDENT-2026-10-24-2135.md` |
| DMG 安装/启动 | DMG 挂载 → `/Applications` → 深度签名校验 PASS → 直接启动成功 | 同上 |
| 凭据安全 | provider key 经 safeStorage/Keychain 加密进 `bot/secrets.json`；config.json 无明文；迁移失败不丢 key；4/4 vitest | `apps/desktop/tests/bot-settings-secrets.spec.ts` |
| 去开发路径 | 打包输入全部改显式 NISSE_*（wrapper）；运行期 `$HOME` 回退已移除；产物仅剩第三方 sourcemap 路径 | `b9e145ea16`、`4cd8dc129a`、`ca296dc1f1` |
| 上游机制 | versions.json + check-versions PASS（9 检查）+ check-upstream + compat PASS（manifest/preflight/voice worker/私有 home 未变） | `tools/upstream-sync/**`、`docs/reports/UPSTREAM-RC3-COMPAT.md` |
| rc.3 预检 | 独立 worktree 构建 9/9 gate PASS；真实 turn 4×delta；建议条件可升级、v0.1.0 继续固定 rc.2 | 同上 |

## B. 门禁状态（不得把 CONDITION 读成 PASS）

| 门 | 状态 | 说明 |
|---|---|---|
| Gate 2（包内语音运行时） | **MVP PASS WITH CONDITION** | 包内 worker/pet/bridge/语音 E2E 与 SIGTERM 回收为既有 PASS；本轮补 DMG 安装/启动/隔离/记忆；**真实 TCC 仍需用户 Finder 交互** |
| P-M1 记忆 | **MVP PASS WITH CONDITION** | 打包运行就绪 + search 可用；跨会话 retain/recall、真实 provider 质量、备份恢复、删除不可检索的**产品包内**证据待用户 key |
| P-M2 人格 | IN PROGRESS | 需真实 key 的产品包对照 |
| P-M3 审批 | IN PROGRESS | 包内真实 DSH 审批 allow/reject/审计待跑 |
| P-M4 电脑任务 | IN PROGRESS | 一条低风险任务 + 语音汇报待跑 |
| P-M5 会话生命周期 | IN PROGRESS | 竞态已修复、预检 PASS；取消/迟到事件包内证据待跑 |
| P-M6 产品体验 | IN PROGRESS | SecretStore 已落地；onboarding 真实状态/统一设置待验收 |
| P-M7 Mac 交付 | IN PROGRESS | 内部 DMG 已产出；更新演练与正式签名/公证未完成（签名 `DEFERRED-EXTERNAL`） |

## C. 黄金路径 S0–S11

| 步骤 | 状态 | 说明 |
|---|---|---|
| S0 安装 + 启动 | **CONDITION** | DMG 安装与启动通过；Finder 双击 + TCC 归因需用户 |
| S1 onboarding/Key/人格/语音/权限 | BLOCKED | 需用户提供 provider key 并走设置页 |
| S2 真实文本对话 | BLOCKED | 需 key |
| S3 真实麦克风语音 | BLOCKED | 需 key + 麦克风 TCC |
| S4 写入记忆 | BLOCKED | 需 S2/S3 + key |
| S5 退出回收/无主 DSH 污染 | **PASS（本轮）** | 退出后 0 残留；本轮隔离运行未新增主 DSH 写入（历史污染见 §E） |
| S6 跨会话召回 | BLOCKED | 需 S4 |
| S7 记忆管理/备份恢复 | BLOCKED | 需 S4 + key |
| S8 真实电脑任务 | BLOCKED | 需 S2 + 受控测试目录 |
| S9 审批 allow/reject/审计 | BLOCKED | 需 S8 |
| S10 取消/迟到事件 | BLOCKED | 需 S8 |
| S11 更新/回滚演练 | BLOCKED | 需首版更新产物；签名条件下部分 DEFERRED-EXTERNAL |

## D. 资源与可靠性

- 安装包：DMG 743MB（778,827,854 bytes）；安装后 app ≈2.3GB（其中 memory 载荷 589MB）。
- 记忆冷启动（包内实测）：Hindsight healthy 后 phase=ready ~60–90s 内（首启 pg0 init 占主因）；后续启动见 B 流 5.3–10.1s 记录。
- 稳态内存：B 流实测 844MB（sidecar 73MB）；Hindsight 峰值 ~1.0–1.7GB。
- 退出回收：本轮 quit 后 0 个相关进程。
- 无凭据状态：未配置 key 时不会启动 voice worker；设置页显示真实状态。
- 主 DSH：修复后隔离运行 mtime 未变；历史上曾被污染（见 §E）。

## E. 遗留问题（按优先级）

| ID | 优先级 | 问题 | 解除条件 |
|---|---|---|---|
| MAIN-DSH-POLLUTION | **P0** | 21:35/22:17 两次测试把 dsh-bot host 写进主 `~/.dsh/profiles/desktop`（含 managed block 与会话 f0f64228）；未清理 | 需用户授权后按 incident 文档精确清理 + 备份 |
| TCC-FINDER | P1 | 真实 TCC 拒绝/重新授权未验证 | 用户 Finder 双击 `/Applications/dsh-bot.app`，在系统弹窗选 Don't Allow/Allow |
| ONBOARD-KEY | P1 | S1–S4 需要用户 provider key（LLM/DashScope） | 用户在设置页配置，或提供测试 key |
| MEM-COND-1 | P2 | Hindsight 偶发一条后台 TLS 外连（未复现） | 发布前 mitmproxy 抓 SNI 并封堵 |
| UPDATE-SMOKE | P2 | macOS 本地 feed 更新/回滚演练未执行 | 内部 v0.1.1 候选包 + 本地 feed |
| SIGN-IDENTITY | P2 | bundle id `ai.nisse.app` 待定稿；Developer ID/公证未具备 | 产品负责人决定 + Apple 账号 |
| SRC-MAP-PATHS | P3 | 产物 asar 仍有第三方 sourcemap 绝对路径（303 处，非运行回退） | 生产构建剥离 .map（后置） |

## F. 复现命令

```bash
# 构建（工作区）
$HOME/projects/dsh-bot-workspace/tools/build-product.sh unsigned
# 版本清单
cd $HOME/projects/dsh-bot-workspace && node tools/upstream-sync/check-versions.mjs
# 兼容套件
node tools/upstream-sync/compat.mjs
# 确定性预检
node m4/preflight.mjs --runs=3
# 安装
hdiutil attach dist/v0.1/whalegirlbot-0.1.0-mac-arm64-unsigned.dmg -nobrowse -readonly -mountpoint /tmp/mnt
cp -R /tmp/mnt/dsh-bot.app /Applications/ && hdiutil detach /tmp/mnt
```
