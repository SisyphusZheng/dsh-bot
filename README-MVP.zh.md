# dsh-bot 0.0.1-beta — 版本计划与本地验收

> **历史文档（beta1 时代，2026-10-27 冻结）。** 本文记录当时的版本计划与本地验收口径，保持原样不改写；当前版本为 `0.0.1-beta2`，提交、产物 SHA、E/U/R 状态与门禁缺口只维护在 [product/CURRENT-STATUS.md](product/CURRENT-STATUS.md)。

当前仍为 beta。已批准的 0.0.1—0.0.4 范围见 [版本任务书](docs/roadmap/README.zh.md)，本地修复与发布步骤见 [0.0.1 执行计划](docs/roadmap/LOCAL-0.0.1.zh.md)。本次整合保留当前修复分支的完整代码与历史，新增任务书并关闭真实 API E2E 的自动触发；没有在云端重新构建或验收 Mac 安装包，也没有宣布稳定版。此前用户报告的本机结果与仓库历史证据分别记录在 [基线](docs/roadmap/baseline.json)。

目标：Apple Silicon、macOS 14+。DSH 是唯一 Agent Runtime，固定为官方 0.2.1-rc.3；产品版本独立为 0.0.1-beta。组件来源和 SHA-256 见 `product/versions.json`。

## 在你的 Mac 上构建

需要 Node 24+、uv、Xcode Command Line Tools。取得本分支后运行：

```bash
bash product/tools/build-macos.sh
```

Desktop、桌宠前端、VoiceWorker 和 Hindsight 都从本分支源码及锁定依赖构建。**不下载、不挂载旧 DMG，也不包含第二份 Electron**。复用旧版独立气泡布局与 QwenAudio v2.0.1 精灵渲染组件，保留 WhaleGirl 九组动画资源；Pipecat 浏览器 SDK 从 pnpm 锁文件打包。Memory 的 macOS wheels 使用带哈希锁文件，ONNX 模型按固定 revision 下载并检查 SHA-256。构建脚本在 VERSION.json 记录暂存输入；签名后的实际 Memory 文件哈希另存 `.mvv-build/evidence/packaged-memory.json`，DMG 文件名带源码短 SHA，身份和 SHA-256 记录在 `.mvv-build/evidence/macos-build.json`。验收会同时核对 DMG 哈希和 app 内的源码 SHA，拒绝旧产物。

脚本不会安装软件到系统目录、Push、创建 PR 或发布 Release。内部包使用 ad-hoc 签名；首次打开通过 Finder 的“打开”操作完成系统确认。

## 自动验收与语音

```bash
bash product/tools/accept-macos.sh /absolute/path/to/new-candidate.dmg
```

验收脚本复制应用到独立目录、隔离 HOME 和 user-data；分别记录 Bridge、web boot/桌宠双击导航、Memory 的就绪结果。仅在验收启动参数中开启随机 loopback DevTools 端口，实际向桌宠画面发送双击，检查 DSH 完成启动，并以官方 `dsh.sessions.current` 对照 Bridge 的 Bot Session；正常启动不会开启该端口。随后写入中文咖啡偏好，以不同措辞检索，切换 Agent Session、退出、重启后再次检索，并检查描述符清理。失败也写入绑定源码 SHA 的 `RESULTS.json`，web 阶段尽可能保留页面截图；检索失败直接失败，不以 health=ready 代替记忆质量。物理鼠标穿透、Spaces 与 TCC 仍需手动验收。

正常启动应用后，在 DSH 设置 → Bot 中填写 LLM 和 DashScope Key。当前语音由 **Pipecat 1.13.0** 编排，链路是 Qwen Realtime ASR → 同一个 DSH Agent → Qwen Realtime TTS；语音模型不承担第二套 Agent。默认 ASR `qwen3-asr-flash-realtime`、TTS `qwen3-tts-flash-realtime`、音色 Cherry。提供其他供应商选项需要真实实现后再添加。

正常启动保留独立桌宠；首次显示可暂停、续接和重来的气泡引导，配置称呼、人格、模型、语音和审批。双击打开同一个 Bot Session；关闭主窗口后桌宠继续运行。悬停显示麦克风、实际监听音量和按键提示；空闲不常驻按钮，反馈气泡自动消失。右键可选择按住／切换／常听模式、说话键、语言、皮肤、隐藏和自动休眠，任务卡片可打开会话或停止任务。审批与结构化提问按请求显示“是/否”、N 个选项、多选或文本输入；回答失败可重试，一端回答后另一端同步撤销。普通反馈自动消失，等待回答的气泡保留。

“操作键鼠时暂停任务”继续采用系统 idle 轮询策略，有启动宽限期，等待审批时不触发。全局 Option 在 macOS 通过随包 koffi 读取，其他系统回退到明确显示的组合快捷键；鼠标侧键在悬停桌宠时使用。离线 Sherpa 唤醒已移回，构建时校验并打包模型，待机音频仅在本机检测，唤醒后才连接 Pipecat。右键可修改唤醒词及显示桌宠快捷键；麦克风手动开启后直接对话。旧 Nisse／NissePet 偏好、引导断点、位置和合法皮肤只读迁移到 dsh-bot/pet，原文件保留，凭据不复制进偏好。

## 在线设置与清理

保存人格、权限和模型配置不会刷新主窗口、重启 Host 或更换 Agent Session，变更从下一次 Agent 步骤生效。只改语音配置时，单独重启 Pipecat Worker 并重连音频；Memory 开关只管理 Memory 服务。保存失败会显示错误，避免把落盘误报为应用成功。

保留统一 Electron 与 Pipecat 链路，恢复旧桌宠的手势、引导、皮肤、唤醒和呈现代码；不恢复 Gateway 或旧 DMG 提取依赖。首次运行新构建前需退出旧版应用，避免旧 Worker 占用 8765；不会自动结束未知进程或删除个人数据库。新安装体积仍需 Mac 实测。`node product/tools/clean-builds.mjs` 默认只预览验收目录大小；确认后通过 `acceptance-<编号> --apply` 清理指定 app 副本和缓存，保留日志与个人数据库。

## 已修复的运行契约

- 官方 rc.3 全文件 Git Blob 校验；有意产品差异列入最小 allowlist。测试数据不进行猜测式字符串恢复。
- Host 从实际 runtime package.json 的依赖解析官方 LLM export，启动前验证编译入口，login shell 不得覆盖产品数据目录和官方入口。
- Pet 和 Voice 共用 `DSH_HOME/bot/bridge.json`；Voice 使用鉴权 NDJSON `/voice/turn`，复用同一 Session、Tool 和 Approval。
- Memory 资源全部位于 `Resources/memory`；前台 Hindsight 包装脚本、Bearer Token、bank bootstrap 与真实 adapter health 全部通过才发布 ready。退出清理进程组，保留数据库。
- `dsh-app://app` 精确 CORS，审批使用每次启动的新 token；损坏凭据文件保持原状并报错；清除/切换 Key 不遗留旧环境值。

## 验证范围

本次计算环境为 Linux。`product/evidence/RESULTS.json` 保留上一候选的云端记录；本轮修复与截图见 `product/evidence/companion/RESULTS.json`。Mac 验收会在对应 `acceptance-*` 目录生成绑定候选与 DMG 的独立 `RESULTS.json`；G1/G7 的原生 macOS 构建、DMG、TCC 无法在此验收。真实模型与麦克风需要你的凭据和设备。

Memory 的 Linux 单元/进程测试使用真实 adapter + 明确的 HTTP backend fixture，不能证明真实 Hindsight 数据库检索。当前源码冻结的 Hindsight 已通过固定 ONNX 模型的离线中文相关性检查。同一 Bot Agent 的语音与 DSH 文字请求都会检索相关记忆；生产 Host 的跨 Session 注入使用明确的 HTTP fixture 验证。当前 Work 的 PostgreSQL Linux 二进制缺少 libicuuc.so.70，进程又以 root 运行且 setuid 返回 EINVAL，G4 的数据库/跨重启检索需运行上述 Mac 验收脚本。没有将它标记为 PASS。

所有验证在 Work 本地运行；未调用 GitHub Actions。仅新建无 PR 的 MVP 分支，避免仓库的 PR 工作流。不要为验收本候选版本随意创建 PR，否则已有工作流会运行。

本轮恢复范围、测试证据与原生限制见 [恢复交付记录](review/pet-restoration-2026-10-27/RESULTS.json)。Mac 构建命令保持 `bash product/tools/build-macos.sh`。
