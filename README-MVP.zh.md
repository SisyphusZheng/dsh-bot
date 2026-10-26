# dsh-bot macOS MVP Candidate

目标：Apple Silicon、macOS 14+。DSH 是唯一 Agent Runtime，固定为官方 0.2.1-rc.3；产品版本独立为 0.0.1-beta。组件来源和 SHA-256 见 `product/versions.json`。

## 在你的 Mac 上构建

需要 Node 24+、uv、Xcode Command Line Tools。取得本分支后运行：

```bash
bash product/tools/build-macos.sh
```

Desktop、桌宠前端、VoiceWorker 和 Hindsight 都从本分支源码及锁定依赖构建。**不下载、不挂载旧 DMG，也不包含第二份 Electron**。沿用 WhaleGirl 动画资源，Pipecat 浏览器 SDK 从 pnpm 锁文件打包。Memory 的 macOS wheels 使用带哈希锁文件，ONNX 模型按固定 revision 下载并检查 SHA-256。构建脚本在 VERSION.json 记录暂存输入；签名后的实际 Memory 文件哈希另存 `.mvv-build/evidence/packaged-memory.json`，DMG 的 SHA-256 另存证据目录。

脚本不会安装软件到系统目录、Push、创建 PR 或发布 Release。内部包使用 ad-hoc 签名；首次打开通过 Finder 的“打开”操作完成系统确认。

## 自动验收与语音

```bash
bash product/tools/accept-macos.sh /absolute/path/to/new-candidate.dmg
```

验收脚本复制应用到独立目录、隔离 HOME 和 user-data；等待真实 Host/Memory 就绪，写入中文咖啡偏好，以不同措辞检索，切换 Agent Session、退出、重启后再次检索，并检查描述符清理。检索失败直接失败，不以 health=ready 代替记忆质量。

正常启动应用后，在 Bot 设置中填写 LLM 和 DashScope Key。当前语音由 **Pipecat 1.13.0** 编排，链路是 Qwen Realtime ASR → 同一个 DSH Agent → Qwen Realtime TTS；语音模型不承担第二套 Agent。默认 ASR `qwen3-asr-flash-realtime`、TTS `qwen3-tts-flash-realtime`、音色 Cherry。提供其他供应商选项需要真实实现后再添加。

桌宠点击“开启语音”，双击打开主窗口，“停止任务”取消 Agent。当前候选使用显式麦克风按钮；全局键鼠自动暂停和唤醒词尚未接入当前桌宠，旧设置已隐藏，持久化值保留。允许麦克风权限；按实际工具需要，在系统设置中允许辅助功能/屏幕录制。连续对话 10 轮，播放中说“等一下”或自然提出新问题，确认旧播报停止、旧文本不再送入 TTS。让它创建工作区外临时文件，分别验证批准、拒绝和取消；重启后确认长期记忆仍可检索。

## 在线设置与清理

保存人格、权限和模型配置不会刷新主窗口、重启 Host 或更换 Agent Session，变更从下一次 Agent 步骤生效。只改语音配置时，单独重启 Pipecat Worker 并重连音频；Memory 开关只管理 Memory 服务。保存失败会显示错误，避免把落盘误报为应用成功。

已删除独立旧 Pet 应用、Gateway、未入库共享前端依赖、旧 DMG 提取脚本、重复 memory-source 和过期复制清单。首次运行新构建前需退出旧版应用，避免旧 Worker 占用 8765；不会自动结束未知进程或删除个人数据库。新安装体积仍需 Mac 实测。

## 已修复的运行契约

- 官方 rc.3 全文件 Git Blob 校验；有意产品差异列入最小 allowlist。测试数据不进行猜测式字符串恢复。
- Host 从实际 runtime package.json 的依赖解析官方 LLM export，启动前验证编译入口，login shell 不得覆盖产品数据目录和官方入口。
- Pet 和 Voice 共用 `DSH_HOME/bot/bridge.json`；Voice 使用鉴权 NDJSON `/voice/turn`，复用同一 Session、Tool 和 Approval。
- Memory 资源全部位于 `Resources/memory`；前台 Hindsight 包装脚本、Bearer Token、bank bootstrap 与真实 adapter health 全部通过才发布 ready。退出清理进程组，保留数据库。
- `dsh-app://app` 精确 CORS，审批使用每次启动的新 token；损坏凭据文件保持原状并报错；清除/切换 Key 不遗留旧环境值。

## 验证范围

本次计算环境为 Linux。`product/evidence/RESULTS.json` 和日志记录可执行检查；G1/G7 的原生 macOS 构建、DMG、TCC 无法在此验收。真实模型与麦克风需要你的凭据和设备。

Memory 的 Linux 单元/进程测试使用真实 adapter + 明确的 HTTP backend fixture，不能证明真实 Hindsight 数据库检索。当前源码冻结的 Hindsight 已通过固定 ONNX 模型的离线中文相关性检查。每轮语音请求都会检索相关记忆；生产 Host 的跨 Session 注入使用明确的 HTTP fixture 验证。当前 Work 的 PostgreSQL Linux 二进制缺少 libicuuc.so.70，进程又以 root 运行且 setuid 返回 EINVAL，G4 的数据库/跨重启检索需运行上述 Mac 验收脚本。没有将它标记为 PASS。

所有验证在 Work 本地运行；未调用 GitHub Actions。仅新建无 PR 的 MVP 分支，避免仓库的 PR 工作流。不要为验收本候选版本随意创建 PR，否则已有工作流会运行。
