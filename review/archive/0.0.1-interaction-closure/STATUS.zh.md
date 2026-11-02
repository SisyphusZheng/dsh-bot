# 0.0.1 交互收口执行记录（2026-10-28）

状态：**IMPLEMENTED；自动与打包验收 PASS，产品仍 `0.0.1-beta`，真机声学/TCC/物理交互 BLOCKED-ENVIRONMENT。**

- 分支：`work/0.0.1-closure`
- 源码冻结提交：`787ae06a0804bdf1097c49ac29409052e4b5acfe`（本文件随后单独提交为证据提交）
- 基线：`ed6db64390`（云端 `f8bd1374` + 本机验收记录）
- 最终候选 DMG：`apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-787ae06a-mac-arm64-unsigned.dmg`
- 大小 / SHA-256：`702,234,783 B` / `49d91135180c7879d0b6f2443052a291bba101f30bc0c6292db682d261067d53`
- 未 push、未创建 PR/tag/Release、未使用 Actions、未修改 main、未升级产品版本。

## ID01–ID08

| ID | 状态 | 实际修改 | 验证 | 剩余限制 |
|---|---|---|---|---|
| ID01 删除「在 DSH 中查看」 | PASS | `companion-presentation.mjs` 移除审批/问答 secondary `open`；气泡不再渲染该入口；保留双击桌宠/气泡打开主窗口 | presentation 单测断言无该文案；smoke-pet-ui 断言审批与问答气泡无该按钮；真实 App 审批/问答实测无该按钮 | 无 |
| ID02 问答布局与提交语义 | PASS | 单题隐藏 `1/1`；单选点选项即提交；多选保留「提交」；「其他回答」展开输入；「跳过」降为次要文字；提交中禁用并防重复；失败保留草稿可重试；过期请求不生效 | presentation 单测：单题 progress 空、多题进度、单选无提交、多选/自定义批次；smoke：单选/多选/自定义/重复选择断言真实提交值；真实 App 单题：progress 隐藏、secondary 仅「其他回答/跳过」、点咖啡得到 completed | 多题进度/回退仅单测覆盖，未在真实模型多题流程复测 |
| ID03 审批文案与按钮 | PASS | 按钮改「允许一次 / 拒绝」；中文摘要按工具分类（write=写入/修改、read=读取、shell=运行命令、未知=执行操作）；新增「查看详情」展开工具、目标、原始原因、范围；不把 shell 解释成读/写/删 | 单测覆盖 write/read/bash/unknown 映射与 humanize；smoke 真实 Chromium 展开详情并断言「工具/目标/原始原因/范围」；真实 App 审批：中文摘要、按钮、详情、允许后文件创建、turn-end completed | 删除类工具目前归为“执行操作”而非断言删除；未知命令风险不推断（按需求） |
| ID04 死按钮治理 | PASS（本轮范围） | 删除气泡内两个死入口；新增「查看详情」「打开主窗口」均有真实处理；入口清单见下 | smoke 断言审批/问答无 DSH 入口；真实 App 点「允许一次」「查看详情」均有可见结果；错误气泡「打开主窗口」有 `send('open')` 单测 | 全产品入口未做穷举审计，仅覆盖本轮涉及的气泡/审批/问答/语音/恢复入口 |
| ID05 中断提示与恢复 | PARTIAL | 识别 DSH 上游中断文案并改为中文人话；提供可用的「打开主窗口」；诊断细节仍走日志/诊断 ID | 单测 humanize + 打开主窗口 action；真实 App 仅验证 `open` 链路可达（未构造真实中断） | 未实现「继续/重试」自动恢复、副作用确认、重启后任务状态面板；标注 BLOCKED/PARTIAL，不冒充完成 |
| ID06 气泡自适应 | PASS（实现+实测） | 气泡窗口改为内容自适应：渲染层测量 `scrollHeight` 上报；主进程按底部锚点缩放窗口；最小 118、最大 420，长内容滚动；修复旧固定 420 浪费与第一次实现只缩不长的 bug | 控制器单测：底部锚点、min/max、reposition；smoke：短内容、审批展开、长选项/长文本、按下/选中不裁切；真实 App：短回复 118px、审批展开 275px、问答 159px，card bottom 全部 ≤ innerHeight，按钮完整可见 | 多屏/缩放/物理点击穿透未自动验，属 BLOCKED-ENVIRONMENT |
| ID07 简洁/详细偏好 | IMPLEMENTED | `app.responseStyle` 持久化（默认 concise）；设置页新增「回答风格」；Host 每次组装人格时读取；detailed 使用展开规则、concise 使用简洁规则；语音仍只播摘要 | smoke-host 写入 detailed 配置后 `/persona/preview` 断言 detailed 规则生效且 concise 规则不泄漏；config normalize 默认/未知值走 concise；settings 既有保存/迁移测试通过 | 未在真实模型逐场景评估“简洁/详细”效果；属真实 Provider 复验项 |
| ID08 交互测试补齐 | PASS（本轮） | 新增/更新：presentation 单测、bubble-window-controller 单测、smoke-pet-ui（真实 shipped 资源、Markdown/长文本/布局/按下/审批详情/静默录音取消）、smoke-host（detailed 风格） | `verify-local` 17 文件/281 项；Node 61；Python 32；packaged acceptance 12/12 | 真实 Electron 原生窗口几何仅单测+渲染层尺寸实测；物理交互仍人工 |

## 入口清单（ID04）

| 入口 | 触发 | 成功 | 失败 | 测试 |
|---|---|---|---|---|
| 允许一次 | 审批气泡 | 对应请求 allow，操作落地 | 失败提示可重试 | smoke-pet-ui、真实 App |
| 拒绝 | 审批气泡 | 对应请求 reject，不落地 | 同上 | smoke-pet-ui、smoke-host |
| 查看详情 | 审批气泡 | 展开工具/目标/原因/范围 | 无内容不显示 | smoke-pet-ui、真实 App |
| 其他回答 | 问答气泡 | 展开输入 | 输入为空不允许提交 | smoke-pet-ui |
| 提交 | 多选问答 | 提交当前批次 | 失败保留草稿 | smoke-pet-ui、presentation 单测 |
| 跳过 | 单选问答 | 跳过当前问题 | 过期请求不生效 | presentation 单测 |
| 取消录音 | 录音气泡 | 只丢弃录音，不取消任务 | 无 | smoke-pet-ui、媒体测试 |
| 打开主窗口 | 中断提示 | 打开主窗口 | 无法打开时无死按钮 | presentation 单测 |
| 关闭 / 取消 | 气泡 | 关闭当前提示 | 无 | smoke-pet-ui |

## V01–V09

| ID | 状态 | 结果 / 阻塞 |
|---|---|---|
| V01 Markdown、长文本、布局 | PASS（自动） | 标题/粗体/列表/引用/代码渲染；长文本完整尾部保留；滚动/复制；脚本、HTML、图片、危险链接均不执行；真实资源路由与 packaged 资源通过；真实 App 渲染 h2/strong/li + 结尾标记 |
| V02 设置保存与生效范围 | PARTIAL | 代码路径沿用只更新受影响组件；responseStyle 由 Host 每轮读取；未在真实 App 上交互式改设置并验证“不刷新/不丢任务”，仅既有测试与审计 |
| V03 真机声学与连续语音 | BLOCKED-ENVIRONMENT | 需真实麦克风/外放/十轮/抢话/唤醒；不伪造录音 |
| V04 TCC 与物理交互 | BLOCKED-ENVIRONMENT | 需本机授权与物理输入 |
| V05 Provider 与代理矩阵 | PARTIAL | 保留 `proxy=None` 策略与既有真实 TTS 建连证据；本轮未重新执行真实 ASR/TTS 全矩阵（无凭据/不打印 Key） |
| V06 最终候选核心闭环 | PASS（自动） | 同一 DMG 12/12 阶段 PASS：bridge、web boot+双击、Bot Session、Memory health、真实 Hindsight 写入/跨 Session/重启；审批/问答/停止在 smoke 与真实 App 覆盖；语音 provider 真实音频 BLOCKED-EXTERNAL |
| V07 安全边界与脱敏 | PARTIAL | `/health` 最小投影、本地鉴权、审批 fail-closed 保持；新详情只在本地气泡展示路径/原因，不写日志敏感字段；未重跑全量安全审计 |
| V08 体积、启动、旧产物 | PASS（记录） | 终候选 DMG 702,234,783 B vs beta 779,421,007 B；App 2.1G vs 旧 2.3G；启动中位数 1270ms vs 上一候选 1327ms（beta 同条件约 1283ms）；旧 DMG/App 清单见 perf.json |
| V09 源码、产物与正式版收尾 | PARTIAL | 源码冻结 `787ae06a`、DMG 身份与验收 SHA 一致；产品仍 beta，未做正式版 tag/Release；证据提交与源码提交分开 |

## 证据

- `ACCEPTANCE-RESULTS.json`、`DMG-SHA256.txt`、`verify-local.log`、`build-macos.log.gz`、`accept-macos.log`
- `perf.json`、`startup-final.jsonl`
- `live/final-approval.png`、`live/final-question.png`、`live/final-live.json`（真实 App 尺寸/按钮/详情/提交）
- 历史证据保持原样：`review/0.0.1-local-acceptance/`、`review/0.0.1-cloud-closure/`

## 仍需人工

1. 真实外放回声/AEC、TTS 音色、真人十轮与抢话、唤醒词。
2. TCC 首次授权/拒绝恢复、鼠标穿透、拖动/抚摸/单击/双击、Spaces/多屏/缩放。
3. 真实 Provider（ASR+TTS+Agent）长对话与系统代理/NO_PROXY 矩阵。
4. 多题真实模型问答、ID05 的“继续/重试/副作用确认”完整恢复流程。
5. 本机对 DMG `49d91135…` 做一次半小时真实使用验收。
