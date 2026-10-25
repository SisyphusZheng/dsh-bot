# dsh-bot macOS MVP Candidate

目标：Apple Silicon、macOS 14+。DSH 是唯一 Agent Runtime，固定为官方 0.2.1-rc.3；产品版本独立为 0.0.1-beta。组件来源和 SHA-256 见 `product/versions.json`。

## 在你的 Mac 上构建

需要 Node 22.19+ 或 24、uv、Xcode Command Line Tools；下载私有仓库及现有 release 时需要已登录的 GitHub CLI。运行：

```bash
bash product/tools/build-macos.sh
```

也可先下载仓库现有 `v0.0.1-beta` 的 ARM64 unsigned DMG，并设置 `DSH_BOT_LEGACY_DMG=/absolute/path/to/file.dmg`。脚本必须校验完整 DMG 的 SHA-256；原 DMG 仅提供 Pet 的 Electron/依赖、既有语音客户端、Hindsight 1.0.0 / PostgreSQL / ONNX 模型。Pet 覆盖本仓库当前源码并重建 ASAR；VoiceWorker 按固定 Python 版本及带哈希的锁文件重新编译。新版 Desktop/DSH 从本仓库源码构建，不依赖 Actions Artifact、个人电脑绝对路径或发布权限。输出和日志在 `.mvv-build/evidence` 及 Desktop 构建目录。

脚本不会安装软件到系统目录、Push、创建 PR 或发布 Release。内部包使用 ad-hoc 签名；首次打开通过 Finder 的“打开”操作完成系统确认。

## 自动验收与语音

```bash
bash product/tools/accept-macos.sh /absolute/path/to/new-candidate.dmg
```

验收脚本复制应用到独立目录、隔离 HOME 和 user-data；等待真实 Host/Memory 就绪，写入中文咖啡偏好，以不同措辞检索，切换 Agent Session、退出、重启后再次检索，并检查描述符清理。检索失败直接失败，不以 health=ready 代替记忆质量。

正常启动应用后，在 Bot 设置中填写 LLM 和 DashScope Key。当前语音链路是 Qwen Realtime ASR → 同一个 DSH Agent → Qwen Realtime TTS；语音模型不承担第二套 Agent。默认 ASR `qwen3-asr-flash-realtime`、TTS `qwen3-tts-flash-realtime`、音色 Cherry。提供其他供应商选项需要真实实现后再添加。

允许麦克风权限；按实际工具需要，在系统设置中允许辅助功能/屏幕录制。连续对话 10 轮，播放中说“等一下”或自然提出新问题，确认旧播报停止、旧文本不再送入 TTS。让它创建工作区外临时文件，分别验证批准、拒绝和取消；重启后确认长期记忆仍可检索。

## 已修复的运行契约

- 官方 rc.3 全文件 Git Blob 校验；有意产品差异列入最小 allowlist。测试数据不进行猜测式字符串恢复。
- Host 从实际 runtime package.json 的依赖解析官方 LLM export，启动前验证编译入口，login shell 不得覆盖产品数据目录和官方入口。
- Pet 和 Voice 共用 `DSH_HOME/bot/bridge.json`；Voice 使用鉴权 NDJSON `/voice/turn`，复用同一 Session、Tool 和 Approval。
- Memory 资源全部位于 `Resources/memory`；前台 Hindsight 包装脚本、Bearer Token、bank bootstrap 与真实 adapter health 全部通过才发布 ready。退出清理进程组，保留数据库。
- `dsh-app://app` 精确 CORS，审批使用每次启动的新 token；损坏凭据文件保持原状并报错；清除/切换 Key 不遗留旧环境值。

## 验证范围

本次计算环境为 Linux。`product/evidence/RESULTS.json` 和日志记录可执行检查；G1/G7 的原生 macOS 构建、DMG、TCC 无法在此验收。真实模型与麦克风需要你的凭据和设备。

Memory 的 Linux 单元/进程测试使用真实 adapter + 明确的 HTTP backend fixture，不能证明真实 Hindsight 语义检索。当前 Work 进程以 root 运行且不能降权，嵌入式 PostgreSQL 不接受 root，G4 的数据库/跨重启检索需运行上述 Mac 验收脚本。没有将它标记为 PASS。

所有验证在 Work 本地运行；未调用 GitHub Actions。仅新建无 PR 的 MVP 分支，避免仓库的 PR 工作流。不要为验收本候选版本随意创建 PR，否则已有工作流会运行。
