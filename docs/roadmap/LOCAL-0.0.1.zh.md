# 0.0.1 本地执行计划

本文是交给 Apple Silicon Mac 执行者的工作计划。按 [稳定化任务书](0.0.1.zh.md)完成修复并交付可用的 0.0.1；本次文档整合不代表这些工作已完成。以下 Mac 命令按仓库脚本核对，云端没有执行原生构建、TCC、物理声学或真实 Provider 验收。

上次“Actions 573 → 573、无新增运行”的最终结论撤回：即时样本不足以排除延迟触发。默认分支整合后至少新增 68 条运行，其中 dynamic 8、pull_request 40、pull_request_target 20；具体时间和查询范围见 baseline.json。不是 push 类工作流直接启动，但同样违反本任务不消耗 Actions 的要求。

## 1. 保留现场并建立独立工作区

先关闭旧版 dsh-bot，备份现有应用数据，记录正在使用的源码、App、DMG 和用户数据路径；同时盘点 /Applications 中旧 App、挂载卷、GitHub tag/Release 及资源 SHA。旧 v0.0.1-beta 指向历史 main，不代表当前候选；不删除现有凭据、Session 或 Hindsight，也不重写旧 tag。确认 origin 指向用户的 dsh-bot 仓库，而不是上游 deepseek-harness。

```bash
git remote -v
git status --short --branch
git fetch origin main
git worktree add -b work/0.0.1-closure ../dsh-bot-0.0.1 origin/main
cd ../dsh-bot-0.0.1
git rev-parse HEAD
uname -m
sw_vers
node --version
xcode-select -p
uv --version
```

要求 arm64、macOS 14+、Xcode CLI、Node 22.19+ 或 24+ 和 uv。不要把旧工作区未提交修改带入本分支；分支或目录已存在时先检查其用途，不强制覆盖。保留 .mvv-build 缓存，先测再决定清理范围。

## 2. 核对基线，复现真实缺口

读取 baseline.json、上一轮语音生命周期 review 及用户验收报告。上次 Linux 回归已经修过自动取消、录音取消、dev 版本读取等问题，先确认是否回归，不把历史问题全部重新标成未修复。

旧 review/voice-task-lifecycle-2026-10-27/verify.mjs 绑定它自己的历史 HEAD；加入任务书和 Workflow 变更后，对新 HEAD 直接运行它会因源码树不同而失败。这不等于旧证据被篡改。应在历史提交的隔离 worktree 核验，或直接检查其记录的文件哈希；不得修改历史预期来让当前 HEAD 显示 PASS。

安装使用构建脚本固定的 pnpm 版本：

```bash
npx --yes pnpm@11.28.5 install --frozen-lockfile
node product/tools/verify-upstream.mjs
```

先用当前源码启动 dev，复现代理失败、保存设置和旧 Provider 显示。生产启动与完整包在后面单独验收：

```bash
npx --yes pnpm@11.28.5 run dev:desktop
```

不要再临时修改 desktop 版本来启动；若版本契约仍失败，修复启动器并保留产品/Runtime 分离。

## 3. 修复顺序

1. V001-01/02：从 Worker 原始异常追踪到 supervisor 的 safeOutput 和 UI；完整脱敏诊断保留在轮转日志，摘要带分类与诊断 ID。当前锁定 websockets 16.1.1 会自动读取系统 SOCKS；本版 provider WebSocket 显式 proxy=None，不新增 python-socks，不无差别清空系统代理。其余 HTTP 的代理/NO_PROXY 与本机直连分别测试。
2. V001-03/04：核对保存设置的实际调用路径，区分 UI 热更新、下一轮生效、语音重连、记忆服务重启；消除无关整体刷新，明确活跃 Provider 与保留配置。
3. V001-07/08：检查新用户默认收音、审批、health 和 unavailable；按 baseline.json 风险登记确认当前 token 鉴权、0600 明文、同 UID 访问和历史 Profile。保留短回答，修复欢迎语子串吞掉“你好/我在/想聊什么”的问题，不能只用加长过滤阈值掩盖回声。
4. V001-11 随上述修复收拢测试；V001-09 的 tag/Release/App 清单、同机 beta 体积和冷/热启动基线可同时记录，不启动大规模减重重构。
5. V001-10：将产品版本与产物命名修改放在最终源码冻结前，Runtime 保持 rc.3。诊断/设置/安全代码通过后冻结，只接受验收发现的局部修复，修复后重新冻结。
6. V001-05/06：生成并冻结一个候选 DMG，在同一份字节上完成自动验收和真实声学/Provider 测试。重建即产生新产物，必须更新哈希并重验受影响项目；不能在验完 beta 包后改版本重打并沿用原结果。

每个问题按复现 → 必要修复 → 针对性回归 → 实机结果完成。失败需要保留日志及操作步骤，不跳过测试、不制作假健康、不移除已有功能。

## 4. 自动化与集成检查

完整本地入口：

```bash
export DSH_GATE_CONCURRENCY=1
bash product/tools/verify-local.sh
```

该入口需要已安装的语音 Python 依赖及可用的浏览器运行环境。首次执行如缺少 .mvv-build/voice-venv，先运行下一节的 Mac 构建脚本创建锁定环境，再重新执行；也可用 DSH_BOT_VOICE_PYTHON 指向按 requirements-macos.lock 安装的 Python。不能指向依赖不明的系统 Python 并宣称结果等价。

目前 verify-local.sh 的 Vitest 列表不是所有新增桌面测试的全集。V001-11 必须把 host-client-bundle、development-project、pet-voice-route、main-startup、welcome-startup 及本轮回归并入该脚本；下列命令仅用于首次诊断，完成后完整入口是唯一执行清单，不再依赖人手补跑：

```bash
npx --yes pnpm@11.28.5 exec vitest run --maxWorkers=1 apps/desktop/tests/host-client-bundle.spec.ts apps/desktop/tests/development-project.spec.ts apps/desktop/tests/pet-voice-route.spec.ts apps/desktop/tests/main-startup.spec.ts apps/desktop/tests/welcome-startup.spec.ts
git diff --check
```

新增测试重点覆盖真实故障、跨组件状态与恢复行为：代理绕过、错误分类、设置生效范围、等待审批、取消来源。不要写只重复实现的测试；不要重跑无关全仓库检查直到耗尽时间。类型检查、生产构建、Node/Python 与关键 Vitest 由本地入口执行，真实媒体 smoke 的本地供应商 fixture 不算真实云端验收。

两个启动测试的 app.setName 缺失属于 mock 与当前 main 不匹配，执行者应修 mock 并断言实际命名/启动行为；不得 skip，也不得把生产调用改为可选以迁就测试。其他失败逐条区分已有失败、环境阻塞与本轮回归，记录复现和处置。

## 5. 冻结后生产构建

所有源码及产品版本修改先提交并冻结，工作树必须干净。使用自己的 Git 作者身份，提交消息保留 [skip ci]；不要自动 push。首次候选只需本地构建，不要求为了冻结而推送远端。

```bash
bash product/tools/build-macos.sh
```

脚本负责 Hindsight、锁定 Python、VoiceWorker、桌宠、DSH 与 Electron 的生产构建及资源检查，并输出本次 DMG 与 .mvv-build/evidence/macos-build.json。当前包名仍可能含 beta；V001-10 更新产品版本时要同步检查生成产物名称和查找逻辑，不能只改一处 package.json。

构建失败时保留 .mvv-build/evidence/build-macos.log，修复后复用缓存。不运行 GitHub Workflow，不使用旧 DMG、旧 app.asar 或 Actions Artifact 作为本次输入。

## 6. 打包 App 自动验收

使用刚生成的 DMG 绝对路径；下面的路径是占位，必须替换为构建输出：

```bash
bash product/tools/accept-macos.sh /absolute/path/to/current-candidate.dmg
```

确认 first/restart 的 bridge、web-boot-and-navigation、memory，记忆写入/跨 Session/重启召回、两次 shutdown 与描述文件清理全部记录。脚本通过不包含真实物理麦克风验收，也不代表已替换 /Applications 中的旧 App。

## 7. 真实用户验收矩阵

| 场景 | 操作 | 预期 |
|---|---|---|
| 首次配置 | 未填 Key、错误 Key、正确 Key；旧配置分别启动 | 指引准确，旧数据保留，配置恢复后能工作 |
| 代理 | 直连、HTTP/不可达代理、系统 SOCKS 开启且无 NO_PROXY、未安装 python-socks、本机回环、恢复网络 | provider WS 按显式直连策略成功或准确报告网络不可达，不再误报缺 python-socks；其他 HTTP 代理语义单独验证 |
| 诊断日志 | 注入超过 300 字符的 SOCKS 错误及跨 stdout/stderr 块的 Key | 脱敏日志保留完整错误原因，UI 给分类与诊断 ID，安全显示不能靠截断遮盖问题；可以就地重试 |
| 欢迎与外放 | 不说话播放欢迎语；结束立刻及 8–11 秒内分别说“你好/我在/想聊什么/是/否”；耳机重复 | 完整回声不提交，真实用户短句能提交，麦克风状态真实 |
| hold | 未按键、快速按下松开、正常说话、松开重按 | 未授权片段不提交；松键停止收音，回答仍播放 |
| toggle/always | 显式切换，关闭再开启；环境中有人声 | 状态和提示一致；明确常听不能区分说话人 |
| 对话与打断 | 连续 10 轮，在回复中插话 | 无意外“已停止”；被打断的播报和新输入对应正确 |
| 录音取消 | 执行任务时开始录音，点击取消或 Esc | 只取消该次录音，原任务继续 |
| 任务与审批 | 文件/命令任务、拒绝/批准、单选/多选/文本；气泡与主窗口交替答复 | 每次决定最多执行一次，过期操作不作用于新请求 |
| 设置 | 任务中改人格、主模型 Key、皮肤、语音配置、记忆开关 | 只更新所属组件，无无关刷新或任务丢失 |
| 恢复 | 断网恢复、Worker 退出、Host 失败、应用退出重启 | 报错明确、可恢复，无孤儿进程，无静默重复执行 |
| 安全残余 | 无 token 的控制/敏感读取、错误 Origin、凭据权限及损坏文件、历史 Profile 只读盘点 | 控制与敏感接口拒绝无凭据；明确同 UID 限制与本地明文事实；只处理确认属于旧产品的残留 |
| 包与性能 | 旧 App/tag/Release 清单，同机同配置 beta 与候选，启动各至少三次取中位数 | 新包身份唯一；体积和冷/热启动不劣化，测量容差先固定，超预算需处理或显式接受 |
| 首次打开 | 在未预先放行新候选的 macOS 上走系统允许的打开流程 | 说明 ad-hoc/未公证并实测可打开；不要求禁用 Gatekeeper，不把缓存过旧包的授权当作新包证据 |
| 记忆 | 保存可检索事实，新 Session 与退出重启后提问 | 语义召回正确；未保存的内容不伪称记得 |
| 现有桌宠体验 | 皮肤、拖动、双击、唤醒、菜单、麦克风/音量反馈 | 全部保留；双击打开对应会话 |

TCC 由本机用户授权；记录测试时使用的麦克风、外放/耳机、代理状态、模型和 App 构建。未执行项目如实标记 BLOCKED 或 DEFERRED，不用静态页面、fixture 或别的候选结果代替。

## 8. 发布收尾与交付

新增 review/0.0.1-local-acceptance/，记录候选提交/树、产品和 Runtime 版本、资源来源及 SHA、命令退出码、DMG 与 app.asar 身份、自动和人工结果、脱敏日志及残余问题。证据加入 Git 后，不冒称测试提交与最终文档提交完全相同；明确源码是否变化并检查允许的文档差异。

发布检查按 0.0.1 任务书逐项判定。全部满足才去掉 beta；否则保留 beta，并给出具体阻塞。确认后清理测试进程、端口和挂载，保留缓存以便重建；不要自动替换唯一回滚 App。

Developer ID 签名/公证明确 DEFERRED 至 0.1.0 扩大分发阶段，0.0.1 的定位为个人内部使用。正式 v0.0.1 使用新的 tag 与资源身份，不移动 v0.0.1-beta，不把旧 Release 的 DMG 当当前下载；发布 tag/Release 仍需用户另行授权。

用户交付至少包含源码分支及 SHA、新 DMG 的绝对路径与 SHA-256、版本清单、验收记录和简短 TCC/语音步骤。没有 macOS 或 Provider 时继续完成可执行工作，保留环境阻塞，不能宣称稳定版已验收。

## 9. 发布冻结窗口与延迟 Actions 复核

本节是 V001-12。更新 main、任何已关联 PR 的分支、Dependabot 配置或依赖清单之前执行；不是推送后发现有运行再取消的补救。修改工作流文件或加入 [skip ci] 不能替代管理员侧冻结。

1. 仓库管理员确认 Actions 已在仓库级禁用，核对 Dependabot version/security 更新、已有 PR rebase、自动依赖提交及默认 CodeQL 等托管入口；在可能触发闭合/配置事件前先禁用相关 Actions。记录设置状态与确认时间，不能仅凭 YAML 推断。
2. 暂停相关 Dependabot 更新并记录/按用户授权关闭仍可能 rebase 的 PR。本次已观察到的对象是 PR #12—#16；名单必须重新查询。仅设置 rebase-strategy: disabled 不足：GitHub 说明已有 PR 仍可能在创建后 30 天内继续 rebase。关闭 PR 也不能单独阻止默认分支动态依赖任务。
3. 获取推送前总数、最新运行 ID、所有相关 PR head、目标分支预期 SHA；确认没有因冻结操作启动的任务，记录准确的 UTC 推送时刻与本地时区。无法读取或确认冻结状态时，禁止更新默认/PR 分支；交付本地 commit、patch 或 bundle。
4. 使用带 [skip ci] 的最终提交，按预期 SHA 做非强制更新，不创建 PR、评论、tag 或 Release。全新无 PR 的文档审阅分支需单独审计 push/create/动态触发，不以其安全性推断 main 安全。
5. 推送后在第 10 分钟和第 15 分钟分别按 created >= 推送时刻分页查询所有事件，保存运行 ID、event、head_sha、head_branch、创建时间、状态，并记录全仓库 total_count。不得只查 push 或只看前 10 条；不得立刻宣称“无新增运行”。
6. 对新增运行按直接 SHA、Dependabot PR rebase 链及事件关联归因；总数有变化不自动都归给本次，查询为空也只表示已观察窗口内未发现。若相关新增运行出现，记录 FAIL，不继续推广候选，不通过 dispatch/重跑补证据。

延迟观察不保证未来永不触发，仓库级冻结在整个本地验收/发布期间保持。GitHub 的已有 PR rebase 例外见 [Dependabot 官方说明](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#rebase-strategy)。后续推送与发布仍须核实用户授权；先前 main 整合授权不是自动发布 Release 或持续推送的许可。
