# 候选交付：可以进入 Mac 本机验收

本轮已收口此前明确遗留的运行代码缺口。我认为这份候选已经值得交给项目所有者做 Mac 实机验收；产品保留 0.0.1-beta，不冒称稳定版。源码、检查数字和原始日志身份见 [RESULTS.json](RESULTS.json)，版本及输入哈希见 [VERSIONS.json](VERSIONS.json)。

## 修复结果

- 中断后不再只有“打开主窗口”：从官方持久化 Session 读取预览，选择“检查后继续”或“重新提交原指令”，单独确认副作用后才向同一 DSH Agent 发送新的用户指令。运行中、历史变化、过期、重复和非法请求会被拒绝。它不是工具回滚或幂等承诺。
- 真实 Host 退出并重启后，恢复的是同一个持久化会话；旧令牌失效，重新预览并确认后可继续。不会自动重放工具或恢复未提交的 Worker 内存队列。恢复结果通过现有会话和气泡展示，不承诺续播中断前的音频。
- 主窗口和桌宠的中断提示均改成人话，保留“部分操作可能已执行，先检查结果”的警告。带操作按钮的错误气泡会接收鼠标，不再保持穿透。
- 原有 26 项打包回归通过：测试显式提供资源映射夹具，正确区分产品版本与 Runtime，检查产品品牌、资源及带提交身份的 unsigned 产物名。没有降低生产 Runtime、签名或资源校验。
- 欢迎语、收音反馈、输入模式、打断、皮肤、人格、拖动、审批、结构化问答和 Hindsight 入口保留；DSH 仍是唯一 Agent Runtime，Pipecat 仍是语音适配层。

## 冻结检查

源码冻结后，干净工作区执行 product/tools/verify-local.sh 全部通过：22 个 Vitest 文件/477 项、79 项 Node、48 项 Python、5 项 TypeScript 与 9 项生产构建检查。另通过真实完整 Web 启动、官方加载器和同 Bot Session 导航；旧裸 ESM 格式在同一真实加载器中被拒绝。真实 Pipecat/WebRTC 与 SDK 的收音、播报、取消录音不取消任务、静音/恢复/断开由媒体夹具验证。

新维护的产品双语文档、7 页 CLI 帮助引用、生成 Client catalog 和 2026 个 Markdown 文件链接通过。CLI 帮助是无网络的引用夹具，其子进程不继承 ALL_PROXY 的 SOCKS 诊断；应用和 Provider 的代理设置没有因此改动。

所有旧 review 保持原样。全仓双语配对仍有 9 个历史任务书/review 缺口，原始检查明确保留 FAIL；它属于不阻塞本机候选的文档债务。这里不宣称上游完整 43 项 doc-sync 全部通过，也没有用跳过测试制造通过结果。

## 仍需本机验收

本云端为 Linux，未生成或启动 Mac DMG。正常 Finder/open 启动与重启、真实签名/AMFI、TCC、物理鼠标穿透/Spaces、多屏、真人外放回声、蓝牙耳机、十轮长对话与连续抢话，仍需 Mac 实测。真实 Provider 和本候选 Hindsight 数据库写入、跨 Session、跨重启语义检索也未由本轮云端验证；HTTP 夹具不等于记忆质量验收。

VoiceWorker 源码树与上轮冻结构建完全一致，本轮复跑了源码 Worker 和真实媒体链路；保留上轮二进制构建证据，不把它改写为本轮新生成的 Mac 或 Linux 二进制。

## 拉取与构建

工作分支为 work/0.0.1-closure。源码冻结后只追加本目录验收记录；main 不更新，不创建 PR/tag/Release，不执行 Actions。

```bash
git fetch origin
git switch work/0.0.1-closure
git pull --ff-only origin work/0.0.1-closure
bash product/tools/build-macos.sh
```

构建要求干净的已提交工作区。对脚本生成的同一个 DMG 执行 bash product/tools/accept-macos.sh /absolute/path/to/candidate.dmg，记录它自己的 SHA 和源码身份。需要稳定安装时使用 product/tools/install-macos.sh；默认保留旧 App，明确 --replace 才备份后替换。不要把旧 tag、旧 DMG 或 /Applications 内旧版本当成本候选。

## 证据复核

本目录日志按原始字节 gzip 保存，哈希在 RESULTS 中；运行 node review/0.0.1-candidate-2026-10-29/verify.mjs 可核对源码、输入及日志。它只验证证据完整性，不重新执行测试，也不把 BLOCKED/DEFERRED/FAIL 改成 PASS。云端使用匹配 Node 头文件、tsx 官方 ESM 钩子及测试专用 Chromium/Noto 字体适配环境限制；这些适配没有进入应用源码。
