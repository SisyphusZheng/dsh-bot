# 0.0.1 本地执行状态

分支：`work/0.0.1-closure`（基于 `main@710c942`，2026-10-28 Dependabot 冻结提交之后）
执行依据：[docs/roadmap/LOCAL-0.0.1.zh.md](../../docs/roadmap/LOCAL-0.0.1.zh.md) 与 [0.0.1 任务书](../../docs/roadmap/0.0.1.zh.md)。

本文件是执行记录。**候选已构建并通过打包自动验收，但产品仍保留 `0.0.1-beta`**：真实麦克风/TCC/声学与真实 Provider 长对话无法在本机自动结论，版本升级未执行。未验证项保留真实阻塞状态。

## 候选与验收（本轮）

- 候选源码：`f3b593b2dd3005588caea9f4ab60bcd06d70ee96`（`work/0.0.1-closure`，本文件证据提交前）
- DMG：`apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-f3b593b2-mac-arm64-unsigned.dmg`
- DMG 大小 / SHA-256：`702,145,159 B` / `d430e1db52d30cc01c764c5538ef2ce43b4adf15ba501673ba11068349e7bd87`
- 构建：`bash product/tools/build-macos.sh` **EXIT=0**；upstream 完整性 `PASS 16347 official files, 33 explicit product overrides`；Node **53**、Python **32**、构建内 Vitest **3 files / 7 tests**；生产构建门禁 **9/9**；VoiceWorker 源码与冻结二进制 smoke、native KWS、office/desktop runtime 检查、`smoke-host`（custom/opencode-go）全 PASS；`packaged source identity = f3b593b2…`。
- 打包验收：`bash product/tools/accept-macos.sh <DMG>` **EXIT=0**，`RESULTS.json` **status=PASS**，12/12 阶段通过：Bridge、web boot + 真实精灵双击 + 官方 Bot Session 匹配、Memory health、真实 Hindsight 写入/跨 Session/重启召回、两次优雅退出与 descriptor 清理。
- 验收内明确边界：`voice = BLOCKED-EXTERNAL`（未跑真实 provider/麦克风）；`nativePointerAndTcc = DEFERRED`（物理穿透/Spaces/TCC 需人工）。
- 证据文件：`RESULTS.json`、`DMG-SHA256.txt`、`build-macos.log`、`accept-macos.log`、`startup-*.jsonl`、`performance.json`（本目录）。

## 自动化实机验收（2026-10-28，用户授权）

在真实用户数据上运行候选 App（已先备份数据），通过 CDP/Playwright 驱动真实 UI：

- 会话：主窗口发「只回答两个字：收到」→ 4 秒完成，回复「收到」。
- 审批：写入 `/tmp/dsh-accept-allow.txt` → 文件创建成功；写入 `/tmp/dsh-accept-reject.txt` → 气泡拒绝后文件未创建，Agent 明确报告"审批弹窗收到的是拒绝"。
- 问答：`ask_user_question` 三选项 → 点「咖啡」→ 回复「你选了咖啡」。
- 停止任务：运行 `sleep 25` 期间点任务卡「停止」→ 2.2 秒内 `已停止`，审计 `session.cancel.requested/cancelled source=task-stop`。
- 录音不取消任务：任务运行中 `gesture down`（麦克风 on）再 `up` → 任务继续到 `已完成/完成`（16 秒），审计 `session.cancelled` 计数 8→8 未增加；静默录音时气泡未出现「取消录音」按钮（该点击路径已有媒体/集成测试覆盖）。
- hold 语义：麦克风 off → on → off。
- 语音故障注入（隔离 profile + 无效 DashScope Key）：气泡显示「语音服务鉴权失败…」+「诊断 ve-c75fb89851b0」+「重试」；Worker 日志 `[voice-error] kind=auth source=asr/tts`。
- 代理修复实机证据：系统 HTTP/HTTPS/SOCKS 代理开启（127.0.0.1）时，Worker 仍成功 `[dashscope-tts] connected: session.created` 并完成 `session updated`，无 `python-socks` 错误——`proxy=None` 修复在真实 App 内成立。
- 证据：`live/01-conversation.png`、`02-approval-question.png`、`03-capture-cancel.png`、`04-voice-auth-error.png`、`stage-*.json`、`live/summary.json`。
- 清理：隔离实例已退出、临时 profile 已删除；真实候选 App 已重新正常启动（无残留进程）。

仍需人工的部分：TCC 授权弹窗体验、真实外放回声/TTS 音色、真人 10 轮与抢话手感、口述唤醒词、物理穿透/Spaces/拖动观感；可选补测语音输入时气泡「取消录音」点击路径。

## 发布冻结（已完成并延迟复核）

- 仓库 Actions 已禁用（`enabled=false`）；本机与仓库均未 dispatch/重跑 Workflow。
- Dependabot 版本更新已通过 `open-pull-requests-limit: 0` 暂停：`main@710c94223cc0f4e75f066507107fb1c1d43d29a1`。
- 冻结前 6 个 Dependabot PR（#17–#22）已关闭、对应 6 条分支已删除；远端仅剩 `main`。
- 延迟审计（`created >= 2026-10-28T04:20:05Z`）：+10 / +15 分钟均 `actionsTotal=649`、新增运行 `0`、heads `1`、开放 PR `0`。
- 旧 tag `v0.0.1-beta → 5418caec` 与 Release `423189662` 原件保留，未新建 tag/Release/PR。
- 全 refs 备份：`<HOME>/Documents/projects/dsh-bot-backups/20261028/dsh-bot-all-refs-20261028.bundle`（恢复验证 16/16 heads + tag）。

## 用户实机反馈（2026-10-28，候选 f3b593b2）

用户使用候选版本后提出 3 个 UI/体验问题，均未在本候选修复，记为 0.0.1 稳定版新增阻塞：

1. **气泡不渲染 Markdown**：气泡把 `**三、基本停着的**` 原样显示（截图 1）。需要气泡文本支持轻量 Markdown（粗体/列表/代码）或至少剥离标记；涉及 `companion-presentation` 气泡渲染路径。
2. **回复/汇报过于冗长**：长汇报类回答仍偏长，需要更严格的简洁输出约束（系统提示/人格规则或"汇报"场景长度上限）。
3. **问答气泡布局与按键反馈差**：截图 2 中选项区排版拥挤、文字被裁切；点击选项/「提交」缺少按下/选中视觉反馈；底部辅助入口呈灰色且交互反馈缺失。需要调整气泡尺寸/选项网格与 `:active/:selected` 状态样式。

状态：OPEN（未修复，候选产物不变）。

## 工作项状态

| ID | 状态 | 本轮结果 / 剩余 |
|---|---|---|
| V001-01 可行动诊断 | IMPLEMENTED + 实机自动 PASS（剩余人工） | `voice_errors.py` 分类/脱敏/`diagId`/最小 health；Worker ASR/TTS/会话失败接入；supervisor 去 300 字截断并跨 chunk 脱敏；桌宠分类气泡 + 诊断 ID + 就地重试。真实 Provider 故障注入与 UI 端到端仍需人工/真机（BLOCKED-EXTERNAL）。 |
| V001-02 代理/NO_PROXY | IMPLEMENTED + 实机自动 PASS（剩余人工） | DashScope ASR/TTS WebSocket 显式 `proxy=None`，不采用 macOS 系统 SOCKS；行为测试断言两条 provider 连接均传 `proxy=None`；系统 SOCKS 开启下外部探测 `session.created`，默认配置复现 `python-socks` 错误并归为 `proxy`。真实 App 内真实 Key 复测仍待人工。 |
| V001-03/04 设置范围与旧 Provider | IMPLEMENTED（审计） | 保存只热更新受影响组件（记忆→Memory；LLM→bridge `/config`；语音→Worker 重启；人格/显示→pet），不刷新主窗口/不重启 Host；失败显示“保存失败”。LLM 只列已适配路由，语音只有 dashscope；旧值以“保留的旧配置”保留。任务中保存/下一轮生效的人工验收待做。 |
| V001-05 声学/过滤 | IMPLEMENTED + 实机自动 PASS（剩余人工） | 欢迎语子串误过滤已修：`你好/我在/想聊什么/是/否` 可提交，完整/长片段回声仍丢弃；新增两条回归。真实外放/耳机/10 轮/抢话验收 BLOCKED-EXTERNAL。 |
| V001-06 候选验收 | PASS（自动） | 单一候选 DMG 完成构建 + `accept-macos.sh` 12/12 PASS；真实语音/TCC 边界已在 RESULTS 标注 BLOCKED/DEFERRED。 |
| V001-07 安全默认 | IMPLEMENTED（审计） | 默认 hold；启动仅 always 模式开麦；dev 实测初始麦克风关闭；敏感工具走 DSH 审批、不叠第二层确认。新用户/旧配置人工验收待做。 |
| V001-08 health/审批 unavailable | IMPLEMENTED | 未鉴权 Host `/health` 移除 `paths` 并加回归；Worker `/health` 仅暴露最小 `last_error`；无 DSH answerer 且桌宠 SSE 未连接时短 grace 后 fail-closed，不空等 120s；桌宠在 grace 内连上仍可回答；2 条新单测 + smoke-host/host-integration 回归通过。 |
| V001-09 旧产物/性能 | IMPLEMENTED（记录） | 盘点完成；候选 DMG `702,145,159 B` vs beta `779,421,007 B`（−9.9%），App `2.1G` vs `/Applications` beta `2.3G`；启动中位数候选 1327 ms vs beta 1283 ms（beta 首跑 6101 ms 为冷缓存离群），差异 <4% 属噪声。清理执行与回滚清单仍待用户确认。 |
| V001-10 版本收尾 | NOT-STARTED | 保留 `0.0.1-beta`：真实声学/TCC/Provider 与 V001-11 未闭环，未去 beta；未创建 tag/Release。 |
| V001-11 测试入口 | IN-PROGRESS（分类完成，待产品化重写） | `verify-local.sh` 已并入相关回归与新增测试；启动 spec 修了 Electron/process/host-process/产品运行时 mock，并修复真实产品缺陷（packaged 环境清理误删 `DSH_CLIENT_VERSION`）。本轮把产品菜单/应用名/许可证项与 About 面板对齐到产品实际行为（新增 9 个通过用例并刷新 2 个快照），`main-startup` 提升到 **112/125**。剩余 13 个失败已分类为：产品 pet-only 首次启动/激活语义（4 个 raise 用例超时 + 窗口隐藏/恢复类）、退出确认与托盘流程、更新证据写入路径、轮询计时差异；`welcome-startup` 0/2 为产品欢迎触发条件与上游 harness 不一致。均未计入默认入口，需要按产品行为重写断言后才能并入。 |
| V001-12 冻结门禁 | COMPLETED | Actions/Dependabot 冻结、PR/分支清理、延迟审计、备份恢复验证完成；仓库级冻结保持。 |

## 额外发现（本轮修复）

- **`main` 当前不可直接 `build-macos.sh`**：`ba15fc9`/`710c942` 改了 `.github/workflows/e2e.yml` 与 `.github/dependabot.yml`，但未登记 upstream allowlist，`verify-upstream.mjs` 会失败。本分支已把这 5 个产品覆盖登记为 allowlist（16347 official files / 33 overrides 通过）。合并回 `main` 前需带上该 allowlist 更新。

## 0.0.1 稳定版阻塞（需要用户/真机）

1. 真实麦克风权限/TCC、外放回声、连续 10 轮、抢话、取消录音与任务停止（V001-01/02/05 的人工部分）。
2. 真实 Provider（DashScope + LLM）长对话与语音端到端，在系统代理/NO_PROXY 组合下的 App 内复测。
3. `main-startup`/`welcome-startup` 上游预期与产品行为对齐（V001-11）；在其通过前不并入默认入口。
4. 版本收尾 V001-10 与发布动作需另行授权（本轮未 push、未建 PR/tag/Release）。
