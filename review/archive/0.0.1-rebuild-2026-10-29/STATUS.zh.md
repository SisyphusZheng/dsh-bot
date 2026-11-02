# 当前交付状态

本轮是可继续本机验收的 MVP Candidate，产品仍为 0.0.1-beta，未宣布稳定版。源码冻结提交、完整检查与边界见 [RESULTS.json](RESULTS.json)，版本和输入校验见 [VERSIONS.json](VERSIONS.json)。历史 Mac DMG 的结果没有被当作本轮候选的原生验收。

工作分支为 work/0.0.1-closure；main 未改，不建 PR/tag/Release，不使用 Actions。每个修复阶段均已单独提交并核对远端 SHA，检查点及后续任务保存在 [CHECKPOINT.json](CHECKPOINT.json)。

## 用户可见变化

- 语音允许/拒绝不再排在正在执行的任务后；停止播报、停止任务和普通工作排队分开，迟到或重复口令不操作下一任务。
- 审批采用短摘要，可展开真实参数；持续允许需二次确认，只匹配完全相同的操作，并可在右键菜单撤销。损坏授权文件不被静默覆盖。
- 右键可退出和检查任务状态，双击会话导航请求携带鉴权。媒体连接断开后，已提交的 DSH 任务与待审批继续存在。
- Mac 构建在外层 App 封存前检查并修复内部 ad-hoc 原生资源签名；验收要求正常 LaunchServices 首启和重启，单纯执行二进制不算通过。稳定安装助手默认保留旧 App，明确替换时先备份。
- 欢迎语、麦克风反馈、输入模式、唤醒、人格、皮肤、拖动、问答、Markdown 和记忆入口均保留。实际真人听感仍需本机验收。

## 本轮自动检查

冻结源码上的 verify-local.sh 通过：70 项 Node、5 项 TypeScript 门禁、9 项生产构建门禁、18 个 Vitest 文件/284 项、48 项 Python、离线唤醒原生模块、资源检查、真实页面点击、真实编译 Host 和 Pipecat/WebRTC 媒体夹具。Linux 冻结 VoiceWorker 已构建并通过实际启动/鉴权/退出；不是 Mac 产物。

新 [Chief 任务书](../../docs/roadmap/CHIEF-0.0.1.zh.md)明确桌宠所代表的 Nisse 本身是未来 Main Bot，0.0.2 才接入 DS-Bot；Pipecat 和 Hindsight 保持各自职责。中英文一致性检查通过。

额外的全仓 doc-sync 未通过：CLI help 被云端 SOCKS 诊断打断，上游 client catalog 陈旧，运行在 120 秒边界停止。额外旧版上游打包用例也未通过，涉及产品/Runtime 版本和品牌断言，运行未完成。原始日志均保留为 FAIL；不得把所选产品门禁的通过说成全仓所有测试通过。当前新增的原生资源打包 Hook 另有 3 项通过的专用回归。

## 剩余边界

Mac ARM64 DMG、Finder/open 实际启动、内层签名实际验证、TCC、物理鼠标交互、真实房间回声/连续抢话、真实 Provider 长对话和本候选 Hindsight 数据库语义持久化，尚未在本云端验证。Memory HTTP 夹具通过不代表数据库或记忆质量通过。

两项产品缺口保留：中断后提供只读状态检查，尚无安全的自动继续/重试；DSH 主窗口仍保留上游技术错误文案。重试前须确认原任务副作用，不自动重放工具。这两项不计已完成，详细对应见 Chief 任务书。

## 在 Mac 上继续

拉取工作分支后，从干净的已提交目录执行：

```bash
bash product/tools/build-macos.sh
bash product/tools/accept-macos.sh /absolute/path/to/candidate.dmg
bash product/tools/install-macos.sh /absolute/path/to/dsh-bot.app
```

验收同一个 DMG，保留脚本输出的 SHA 和源码身份。安装默认目标为 ~/Applications/dsh-bot.app；存在旧 App 时先保留，明确使用 --replace 才备份后替换。不开启 Actions，不绕过 Gatekeeper，不删除用户数据。

## 云端复现说明

原始日志按字节 gzip 保存，RESULTS 记录解压后的 SHA-256。测试环境使用匹配 Node 头文件及 tsx 官方 ESM 导入钩子，绕过本环境禁止 Unix IPC 的启动限制；应用源码未为此改动。Chromium 和 Noto 字体只装在忽略的构建目录内。

云端 Python 的 SSL 策略补丁依赖相邻证书文件；冻结测试复制了该文件的原始字节，未禁用 TLS 校验。适配记录见 [frozen-cloud-adapter.json](evidence/frozen-cloud-adapter.json)。它属于 Linux 云端测试环境，不是 Mac 构建输入。目录内没有 DMG、用户数据或真实 Provider Key。
