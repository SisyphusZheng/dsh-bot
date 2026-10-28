# 0.0.1 本地执行状态（进行中）

分支：`work/0.0.1-closure`（基于 `main@710c942`，2026-10-28 Dependabot 冻结提交之后）
执行依据：[docs/roadmap/LOCAL-0.0.1.zh.md](../../docs/roadmap/LOCAL-0.0.1.zh.md) 与 [0.0.1 任务书](../../docs/roadmap/0.0.1.zh.md)。

本文件是执行记录，不是验收通过声明。完成项必须由命令输出和候选产物证据支撑；未验证项保留真实阻塞状态。

## 发布冻结（已完成并延迟复核）

- 仓库 Actions 已禁用（`enabled=false`）；本机与仓库均未 dispatch/重跑 Workflow。
- Dependabot 版本更新已通过 `open-pull-requests-limit: 0` 暂停：`main@710c94223cc0f4e75f066507107fb1c1d43d29a1`，提交 `chore(deps): pause Dependabot version updates during 0.0.1 freeze [skip ci]`。
- 冻结前 6 个 Dependabot PR（#17–#22）已关闭，对应 6 条分支已删除；远端仅剩 `main`。
- 延迟审计（`created >= 2026-10-28T04:20:05Z`）：
  - +10 分钟：`actionsTotal=649`，新增运行 `0`，远端 heads `1`，开放 PR `0`。
  - +15 分钟：`actionsTotal=649`，新增运行 `0`，远端 heads `1`，开放 PR `0`。
- 旧 tag `v0.0.1-beta → 5418caec` 与 Release `423189662` 原件保留，未新建 tag/Release/PR。
- 全 refs 备份：`<HOME>/Documents/projects/dsh-bot-backups/20261028/dsh-bot-all-refs-20261028.bundle`（SHA-256 `ffc2cb…`，恢复验证 16/16 heads + tag）。

## 工作项状态

| ID | 状态 | 本轮做了什么 / 剩余什么 |
|---|---|---|
| V001-01 可行动诊断 | IN-PROGRESS | 新增 `voice_errors.py`（分类、脱敏、`diagId`、`/health` 最小投影）；Worker ASR/TTS/会话失败接入分类与日志；supervisor 去掉 300 字截断并做跨 chunk 密钥脱敏；桌宠侧分类气泡、诊断 ID、就地“重试”动作已接线。剩余：真实 DashScope 故障注入/恢复回归，以及 UI 端到端验收。 |
| V001-02 代理/NO_PROXY | IN-PROGRESS | DashScope ASR/TTS WebSocket 显式 `proxy=None`（不采用 macOS 系统 SOCKS）；新增行为测试断言两种 provider 连接均传 `proxy=None`。剩余：系统代理开启下的真机 DashScope 复测与故障注入矩阵。 |
| V001-05 声学/过滤 | IN-PROGRESS | 修复欢迎语子串误过滤：`_input_noise` 与最终转写回声过滤改为“播放窗口 + 长连续相似”，`你好/我在/想聊什么/是/否` 可提交，完整/长片段回声仍丢弃；新增两条回归测试。剩余：真实外放/耳机/连续 10 轮/抢话验收。 |
| V001-11 测试入口 | IN-PROGRESS | `verify-local.sh` 并入 `host-client-bundle`、`development-project`、`pet-voice-route` 与新增 Node/Python 测试；启动 spec 的 Electron mock（`app.setName/commandLine/setPath`）、`process` 事件桩、`host-process` 原样导出、临时真实 userData、产品运行时模块（BotRuntime/MemoryRuntime/ProductPet/bot-config-server/bot-host-environment/secret-store）桩均已补齐。**修复的产品缺陷**：packaged 模式的环境清理原先删除了 `DSH_CLIENT_VERSION`（账号请求的构建身份），现保留该变量且仍清理 home/profile 覆盖；`main-startup` 的 packaged 用例由超时转为通过。当前 `main-startup.spec.ts` **101/125 通过、24 失败 + 2 快照失败**，失败集中在上游菜单/退出确认/窗口恢复预期与产品 main.ts 差异；`welcome-startup.spec.ts` 仍 0/2（产品欢迎流程触发条件与上游 harness 不一致）。两个 spec 暂不计入默认入口，分类结果保留，待逐条对齐后回填。 |
| V001-03/04 设置范围与旧 Provider | IMPLEMENTED（待验收） | 审计结果：`onConfigSaved` 只做受影响组件热更新——记忆开关才重启 Memory、LLM 变更走 bridge `/config`、语音变更/凭据存在性变化才重启语音 Worker、人格/显示走 `pet.updateBehavior`，不刷新主窗口也不重启 Host；保存失败在设置页显示“保存失败：”。LLM 目录只列已适配路由（opencode-go/deepseek/dashscope/openai/custom），语音目录只有 dashscope；旧值以“（保留的旧配置；请检查兼容性）”选项保留，不删除数据。剩余：按 0.0.1 验收矩阵实测任务中保存/下一轮生效/不丢审批。 |
| V001-07 安全默认 | IMPLEMENTED（待验收） | 默认 hold；启动仅当保存偏好为 always 才开麦，实测 dev 启动麦克风关闭；敏感工具仍由 DSH 审批策略（bot-outside-write）裁决，没有对语音再叠一层确认。剩余：新用户/旧配置两套验收。 |
| V001-08 health/审批 unavailable | IMPLEMENTED | `/health` 已移除未鉴权的 `paths`（dshHome/home/profile/cwd/bridgeDir/workspaceDir），并有回归断言；Worker `/health` 只暴露 `last_error` 的 kind/summary/diagId/retryable/source/at（无 detail/stack）。审批无 DSH answerer 且桌宠 SSE 未连接时，`interactions.ask` 在短 grace 后 fail-closed 返回 cancelled，不再空等 `approvalTimeoutMs`；期间桌宠若连上仍可正常回答；新增 2 条单测，`smoke-host` 与 `host-integration-mvp` 回归通过。 |
| V001-09 旧产物/性能 | IN-PROGRESS | 已盘点：`/Applications/dsh-bot.app` 2.3G（2026-10-26 安装，保留回滚）；DMG 有 `nisse/dist/v0.0.1-beta`（779,421,007 B，与旧 Release asset 一致）、`dist/rc3-closure`（780,327,376 B）、`dist/v0.1/whalegirlbot-0.1.0`（779,631,049 B）、`dist/nisse-2.3.1`（139,859,076 B）；`/Volumes` 有 Quark 与豆包工作盘（不触碰）；tag `v0.0.1-beta → 5418caec`、Release `423189662` 保留。剩余：同机 beta/候选体积与冷热启动三次中位数对比、清理清单与回滚说明。 |
| V001-10 版本收尾 | NOT-STARTED | 产品仍 `0.0.1-beta`；待全部检查通过后升级并单候选冻结。 |
| V001-06 候选绑定验收 | NOT-STARTED | 待单一冻结 DMG 上运行 `accept-macos.sh` 与真实声学回归。 |

## 本轮验证结果（本机、当前分支）

- Python：`Ran 32 tests ... OK`（含新增诊断/代理/回声回归）。
- Node：`tests 51 / pass 51 / fail 0`（含新增 `voice-diagnostics.test.mjs`）。
- `pnpm run typecheck`：`5 passed, 0 failed`。
- `pnpm run build`：`9 passed, 0 failed`，`EXIT=0`。
- Vitest 定向：`pet-runtime`、`host-client-bundle`、`development-project`、`pet-voice-route` 通过；启动 spec 进展见 V001-11（`main-startup` 101/125，`welcome-startup` 0/2，未计为通过）。
- 真实 DashScope 复测（系统 SOCKS 开启、无 NO_PROXY）：`proxy=None` 下 ASR/TTS 均返回 `session.created`；默认（不传 `proxy=None`）复现 `connecting through a SOCKS proxy requires python-socks`。分类器将该原始错误归为 `proxy` 并生成 `diagId`。
- `host-integration-mvp` 3/3 通过（含新增 `/health` 无 paths 断言）；`smoke-host` 全部 PASS（真实生产 Host + 审批/问答/记忆 fixture）。
- typecheck 5/5 通过（本轮 main.ts 与 host health 改动后复跑）。

## 已知限制 / 接下来

1. `main-startup` 剩余失败按类别处理：上游菜单/退出确认/窗口恢复预期 vs 产品 main.ts 差异（需更新预期或补产品分支 mock），`welcome-startup` 需按产品欢迎触发条件对齐 harness；全部通过后再回填 `verify-local.sh`。
2. 完成 V001-02 的真实 DashScope 系统代理矩阵与 V001-01 的 UI 端到端重试验收。
3. 继续 V001-03/04/07/08/09 审计与修复，然后进入 V001-10 版本收尾、单一候选 DMG 构建与 `accept-macos.sh` + 声学验收。
