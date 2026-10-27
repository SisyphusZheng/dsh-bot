# 0.0.1 本地执行计划

本文是交给 Apple Silicon Mac 执行者的工作计划。按 [稳定化任务书](0.0.1.zh.md)完成修复并交付可用的 0.0.1；本次文档整合不代表这些工作已完成。以下 Mac 命令按仓库脚本核对，云端没有执行原生构建、TCC、物理声学或真实 Provider 验收。

## 1. 保留现场并建立独立工作区

先关闭旧版 dsh-bot，备份现有应用数据，记录正在使用的源码、App、DMG 和用户数据路径；不删除现有凭据、Session 或 Hindsight。确认 origin 指向用户的 dsh-bot 仓库，而不是上游 deepseek-harness。

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

1. V001-01/02：从 Worker 连接异常追踪到 UI，补代理/NO_PROXY 与结构化错误分类。先用故障注入测试，再用真实 DashScope Key 验证；不在终端打印 Key，不无差别禁用系统代理。
2. V001-03/04：核对保存设置的实际调用路径，区分 UI 热更新、下一轮生效、语音重连、记忆服务重启；消除无关整体刷新，明确活跃 Provider 与保留配置。
3. V001-07/08：检查新用户默认收音模式、工具审批、health 最小响应和审批无接收者处理。保持合法短回答，不以过滤所有短句掩盖误识别。
4. V001-05/06：运行真实语音、任务、问答、记忆和生命周期验收；只修复实际失败的路径。
5. V001-09：盘点旧包、无引用链路与缓存，提供清理清单；记录安装体积、首次启动和热启动耗时，不在本版另起大规模减重重构。
6. V001-10：检查完成后升级产品版本到 0.0.1，保持 Runtime rc.3，冻结候选再打包与最终验收。

每个问题按复现 → 必要修复 → 针对性回归 → 实机结果完成。失败需要保留日志及操作步骤，不跳过测试、不制作假健康、不移除已有功能。

## 4. 自动化与集成检查

完整本地入口：

```bash
export DSH_GATE_CONCURRENCY=1
bash product/tools/verify-local.sh
```

该入口需要已安装的语音 Python 依赖及可用的浏览器运行环境。首次执行如缺少 .mvv-build/voice-venv，先运行下一节的 Mac 构建脚本创建锁定环境，再重新执行；也可用 DSH_BOT_VOICE_PYTHON 指向按 requirements-macos.lock 安装的 Python。不能指向依赖不明的系统 Python 并宣称结果等价。

目前 verify-local.sh 的 Vitest 列表不是所有新增桌面测试的全集。执行者需要补齐入口覆盖，并显式验证以下现有回归及本次新增测试：

```bash
npx --yes pnpm@11.28.5 exec vitest run --maxWorkers=1 apps/desktop/tests/host-client-bundle.spec.ts apps/desktop/tests/development-project.spec.ts apps/desktop/tests/pet-voice-route.spec.ts
git diff --check
```

新增测试重点覆盖真实故障、跨组件状态与恢复行为：代理绕过、错误分类、设置生效范围、等待审批、取消来源。不要写只重复实现的测试；不要重跑无关全仓库检查直到耗尽时间。类型检查、生产构建、Node/Python 与关键 Vitest 由本地入口执行，真实媒体 smoke 的本地供应商 fixture 不算真实云端验收。

## 5. 冻结后生产构建

所有源码修改先提交，工作树必须干净。使用自己的 Git 作者身份，提交消息保留 [skip ci]；不要自动 push。

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
| 代理 | 直连、系统 HTTP 代理、不可达代理、NO_PROXY、本机回环 | 支持路径成功，失败指向真正原因，回环不被代理破坏 |
| 欢迎与外放 | 不说话播放欢迎语，再说正常短句；耳机重复 | 欢迎语不被提交为用户消息，麦克风状态真实 |
| hold | 未按键、快速按下松开、正常说话、松开重按 | 未授权片段不提交；松键停止收音，回答仍播放 |
| toggle/always | 显式切换，关闭再开启；环境中有人声 | 状态和提示一致；明确常听不能区分说话人 |
| 对话与打断 | 连续 10 轮，在回复中插话 | 无意外“已停止”；被打断的播报和新输入对应正确 |
| 录音取消 | 执行任务时开始录音，点击取消或 Esc | 只取消该次录音，原任务继续 |
| 任务与审批 | 文件/命令任务、拒绝/批准、单选/多选/文本；气泡与主窗口交替答复 | 每次决定最多执行一次，过期操作不作用于新请求 |
| 设置 | 任务中改人格、主模型 Key、皮肤、语音配置、记忆开关 | 只更新所属组件，无无关刷新或任务丢失 |
| 恢复 | 断网恢复、Worker 退出、Host 失败、应用退出重启 | 报错明确、可恢复，无孤儿进程，无静默重复执行 |
| 记忆 | 保存可检索事实，新 Session 与退出重启后提问 | 语义召回正确；未保存的内容不伪称记得 |
| 现有桌宠体验 | 皮肤、拖动、双击、唤醒、菜单、麦克风/音量反馈 | 全部保留；双击打开对应会话 |

TCC 由本机用户授权；记录测试时使用的麦克风、外放/耳机、代理状态、模型和 App 构建。未执行项目如实标记 BLOCKED 或 DEFERRED，不用静态页面、fixture 或别的候选结果代替。

## 8. 发布收尾与交付

新增 review/0.0.1-local-acceptance/，记录候选提交/树、产品和 Runtime 版本、资源来源及 SHA、命令退出码、DMG 与 app.asar 身份、自动和人工结果、脱敏日志及残余问题。证据加入 Git 后，不冒称测试提交与最终文档提交完全相同；明确源码是否变化并检查允许的文档差异。

发布检查按 0.0.1 任务书逐项判定。全部满足才去掉 beta；否则保留 beta，并给出具体阻塞。确认后清理测试进程、端口和挂载，保留缓存以便重建；不要自动替换唯一回滚 App。

用户交付至少包含源码分支及 SHA、新 DMG 的绝对路径与 SHA-256、版本清单、验收记录和简短 TCC/语音步骤。没有 macOS 或 Provider 时继续完成可执行工作，保留环境阻塞，不能宣称稳定版已验收。

后续推送与发布另行核实授权和全部 Workflow 条件；本次任务书的 main 整合授权不是自动发布 Release 或持续推送的许可。
