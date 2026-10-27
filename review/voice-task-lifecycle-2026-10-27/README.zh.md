# 语音与任务生命周期修复

本轮从 `pet-restored` 的验收基线 `efeb1f9` 继续修复，保留桌宠、欢迎语、麦克风/音量条、hold/toggle/always、快捷键、离线唤醒、皮肤、引导和 DSH 审批/问答。没有新增第二套 Agent，没有使用 GitHub Actions，没有把二进制或构建缓存加入 Git。

## Issue 闭环

| Issue | 修复与验证 |
|---|---|
| A1 dev 版本契约 | dev profile 使用 CLI 的 Runtime 版本 rc.3，产品版本仍为 0.0.1-beta；真实清单与开发项目回归通过。 |
| B1 自动取消语音任务 | Host 事件携带 voice/desktop 来源；自动键鼠接管排除语音、说话手势及冷却期、待审批请求；每个 turn 最多触发一次。 |
| B2 气泡取消/Esc | 绑定录音 ID，只丢弃对应收音；不取消 Agent、不关闭 RTC。已提交文本没有录音取消按钮，过期按钮被拒绝。运行中的 Bridge 任务在取消录音后继续完成，cancel/disconnect 都为 0。 |
| B3 欢迎语回采 | 初始麦克风关闭；Worker 确认录音许可并在实际输入音轨应用 AEC/降噪/自动增益后才收音。欢迎语和回复参与回声过滤，保留全双工与自然打断。真实声学效果仍需 Mac 复测。 |
| B4 识别气泡常驻 | 只展示经过 Worker 过滤的文本；区分 partial/final、去重、限制绝对显示时长，final 转为无取消按钮的短暂文本。 |
| B5 环境声提交 | hold 松键立即关闭真实音轨及 Worker 输入许可，迟到的已丢弃录音不能提交。过滤填充音，同时保留“是/否”等有效短回答。显式持续收听仍可能识别其他人声，不承诺声纹能力。 |
| B6 短按暗中常开 | 删除 650ms 隐式 latch；hold 的每次松键都静音，toggle 仍作为显式模式保留。 |
| C1 松键提示 | 正常结束收音不再弹“已暂停任务”提示，回答继续播放。 |
| C2 调试探针 | `DSH_VOICE_DEBUG_PROBES=1` 才启用；媒体集成断言默认没有 g3-probe 输出。 |
| C3 重复翻译 key | 移除重复“称呼”，用真实 JS 编译器检查字典重复项。 |
| C4 取消来源 | 保留官方 DSH cancel 类型；应用审计记录 task-stop/idle-pause/voice-command/voice-disconnect 和会话、turn、请求 ID。 |
| C5 错认运行环境 | 默认人格及自定义人格均带桌面应用事实，说明 localhost 是内部服务，不能据此猜测浏览器/窗口，也不能虚构屏幕可见性。真实 Host 模型请求已验证。 |
| D1–D3 测试缺口 | 新增监测策略、收音许可/丢弃/迟到回包、快速松键重按、气泡超时、真实 IPC 录音取消与任务停止分离测试；旧测试不再把隐式常开当成正确行为。 |
| E1 首启缺凭据 | 主模型 Key 未保存时，在开启语音前给中文配置提示；保存后可恢复语音。正常更换已存在的模型 Key 不重启媒体连接。 |
| 新发现的 TTS 延迟 | 每个 assistant step 结束即刷新 TTS，不必等整个 Agent 任务结束；单元及未结束任务的真实媒体集成通过。 |

“键鼠接管”仍调用官方任务取消，并非可恢复的暂停；设置说明和气泡已改用“停止”。这里只保护语音任务及手势，保留用户配置的桌面任务接管功能。

## 验证结果

Linux 本地：冻结依赖安装通过；Typecheck 5/5、生产构建 9/9；Vitest 12 files / 74 tests、Node 44 tests、Python 15 tests 全部通过。真实编译 Host 覆盖 Session、工具、审批、N 选一、热配置、Web boot、同 Bot 导航与优雅退出。真实 Chromium/WebRTC/Pipecat 使用明确的本地 ASR/TTS/LLM fixture；覆盖欢迎语、回声/填充音过滤、输入音轨 AEC 设置、音量条、回答播放、任务运行中丢弃录音和静音/恢复。Hindsight 只验证了鉴权 HTTP 适配器及跨 Session 注入，不冒充数据库验收。

Linux PyInstaller 冻结 VoiceWorker 构建成功，包含 capture_policy，并通过启动、接口鉴权、监督与退出测试。它不是 macOS 产物。原生 KWS Worker、锁定模型、PCM 接收和退出通过；未把这解释成真实口述唤醒或 TCC 验收。

官方 rc.3 全树 16347 文件机械验证通过，29 项明确产品覆盖；本轮新增覆盖只涉及 dev 版本读取及其回归，现有 main 覆盖更新了凭据预检恢复逻辑。DSH 核心保持官方版本。

证据绑定到源码树 `74f877f33ac7292559b4045ee4b4a710342a1206`；`baseCommit` 表示修复起点，不表示测试 HEAD。最终提交只额外加入本目录。提交后运行 `node review/voice-task-lifecycle-2026-10-27/verify.mjs`，会机械核对当前 HEAD 去掉本目录后的源码树和全部证据哈希，避免把旧候选的结果冒充当前结果。

## Mac 本地验收

在新分支干净 checkout 中运行 `bash product/tools/build-macos.sh`。继续使用原有锁定依赖和资源校验，脚本已加入 dev 版本与桌宠 IPC 回归测试。按脚本输出的新 DMG 绝对路径运行 `bash product/tools/accept-macos.sh /absolute/path/to/new.dmg`，不要复用旧同名 DMG。构建要求 Apple Silicon、macOS 14+、Xcode CLI、Node 22.19+ 或 24+ 和 uv；不依赖 Actions。

随后检查：hold 快速松键/正常松键均停止收音；欢迎语不会形成自己的用户消息；连续语音和自然抢话；气泡取消/Esc 不终止正在执行的任务；任务卡停止才终止任务；真实审批/问答点击；保存人格或模型设置不刷新桌宠；Hindsight 写入后退出、重启并跨 Session 检索。

当前环境没有 macOS、真实麦克风/TCC，也没有云端 Provider 凭据：上述原生项目为 BLOCKED-ENVIRONMENT，真实 Provider 长对话为 BLOCKED-EXTERNAL。此前 efeb1f9 的 Mac 实机测试确实运行过真实 Provider，本轮新候选仍需回归，不能沿用为 PASS。

最终 Workflow 审计覆盖 main 的 25 个文件（Blob 与候选一致）和候选全部 27 个触发条件；新修复分支不匹配 push 分支过滤，没有 create 触发器。本轮只发布一次最终新分支，不创建 PR、tag、release，不 dispatch 或重跑 Workflow。
