# 云端修复交付（2026-10-28）

状态：可在 Mac 重建并进行本地验收的 beta 源码候选，尚未升级为 0.0.1 正式版。分支沿用 `work/0.0.1-closure`，入口为用户提交的 `faaf1703d1` 完整 Bundle。最终代码身份、环境和测试范围见 [RESULTS.json](RESULTS.json)。

## 改动

- 气泡支持 CommonMark 粗体、标题、列表、引用与代码，保留完整回复；滚动查看长文本，双击可打开 DSH。渲染不执行模型 HTML、不加载远程图片、不授予模型导航能力。复用已锁定的 mdast 解析器，构建时生成依赖许可证文件。
- 问答正文、选项分别滚动，提交及辅助按钮保持可见；长标签与说明换行，选中、按下和键盘焦点均有反馈。独立气泡透明窗口固定为 380 × 420，短气泡仍保持紧凑，桌宠本体不随之调整尺寸。
- 默认人格增加简洁回答规则：普通对话通常 1–3 句，汇报结果优先；用户要求详细内容时仍展开，不截断回答，不删除自定义人格、失败、风险或审批内容。模型实际表现仍需真实 Provider 复验。
- 麦克风实际启用后即可显示「取消录音」，无需先有 ASR 文本；取消只丢弃当前录音，不取消 Agent 任务。
- 启动测试区分默认桌宠启动、显式打开主窗口及可选的上游账号登录。启动两套测试共 128 项通过，已纳入 `verify-local.sh`。保持打包环境过滤；更新诊断目录与轮询间隔的环境覆盖测试在开发模式运行。
- 新 Markdown 脚本同时接入真实桌宠 HTTP 资源路由。集成测试从实际气泡 HTML 枚举脚本并请求它们，要求全部 200，且无 nonce 的访问仍为 404，避免独立渲染 fixture 掩盖资源缺失。
- 修正交接 HEAD 已存在的完整性登记遗漏，明确新增 3 个菜单/About 产品快照差异；36 项 allowlist、16,347 个官方文件机械验证通过。未修改官方 Agent 核心。
- 历史 `12 files / 74 tests` 数字保持原样，新增不可复现性说明，不改写旧证据或预期哈希。

## 验证

生产构建 9/9、TypeScript 专项 5/5、Vitest 17 文件 / 281 项、Node 57 项、Python 32 项通过。构建产物结构检查、KWS 模型/原生 worker、生产 Host 的 custom 与 opencode-go Mock Provider、实际工具副作用及审批允许/拒绝/取消、问答、跨会话记忆 HTTP 接入通过。

Chromium 验证真实生产 Web boot、官方 Bot Session 导航及旧裸 ESM 的失败负例。真实气泡资源进行 Markdown、完整长文本、长选项、布局边界、按下/选中状态、多选/自定义回答、审批及录音取消测试，截图见 [ui/](ui/)。这是布局/交互断言与截图证据，不是跨平台像素金图测试；Electron IPC 使用显式 fixture，中文字体为云端测试用 Noto Sans SC。

Pipecat/WebRTC/SDK 媒体测试通过真实握手、音量指示、ASR 转写、欢迎语/回复音轨、静音/恢复、任务期间丢弃录音且零 cancel/disconnect。麦克风、ASR/TTS Provider 与 Bridge 为明确的测试设备/本地服务。修正媒体 fixture 的旧假设：回采注入实际完整欢迎语，不能把用户可能合法重复的短句当作必定回声；短回复仍由 Python 回归覆盖。AEC 参数通过不等于真实房间回声验收通过。

## 环境适配与证据边界

云端为 Linux。`tsx` CLI 的 Unix IPC 不可用；只在忽略的云端已安装工具中，用相同 tsx ESM hook 启动脚本，未禁用编译或测试。原生插件使用同一 Node 24.22.1 二进制副本和官方 Node 24.0.0 的稳定 Node-API 头文件编译。常规 Git pre-commit 的 lint、空白与 vendor 检查均执行并通过，未跳过。

机器继承了 `NODE_USE_ENV_PROXY=1`；Vitest setup 删除代理环境后，已初始化的 fetch dispatcher 仍可能走代理。仅对无密钥的 fixture 测试进程设置 `NODE_USE_ENV_PROXY=0`，未修改系统代理或产品 Provider 连接策略。

Playwright 浏览器直下载失败后，使用测试目录内的 Chromium 153 npm 分发。浏览器与字体均不随产品打包。完整 `verify-local.sh` 未在云端作为单条命令运行；上列检查以分项命令执行，Vitest 文件清单直接取自该入口。Mac 上应完整运行该入口。

原 [本机验收记录](../../0.0.1-local-acceptance/STATUS.md)、`f3b593b2` 的 DMG、SHA 与证据保持不变，不能用来证明本次新源码已完成 macOS 打包验收。本轮未生成 DMG，未触碰真实用户数据、旧 App 或旧产物，未修改 GitHub、Actions、PR、tag 或 Release。

原始终端日志以 `logs/*.log.gz` 保存，解压可逐字查看；压缩保留原始空白和控制字符，避免为通过 Git 空白检查改写日志。先运行本目录 `verify.mjs` 核验冻结源码及证据哈希。

## 剩余项目

| 原 Issue | 当前结论 |
|---|---|
| #1、#3、#7、#8、#9 | 云端实现和自动验证 PASS；Mac 观感仍需复验 |
| #2 | 提示词及实际请求装配 PASS；真实模型简洁程度 BLOCKED-EXTERNAL |
| #10 | 静默录音按钮、取消语义及实际 IPC 路由 PASS；打包 App 物理点击 BLOCKED-ENVIRONMENT |
| #11 | 强制审批的生产 Host 有请求、文件在允许前不存在、允许后创建、拒绝/取消后不创建；真实打包 App 手动允许路径仍需复验，不以 Agent 自述通过 |
| #4–#6 | 真人声学、TCC、鼠标穿透/Spaces/拖动 BLOCKED-ENVIRONMENT |
| #12 | 本地媒体与显式直连行为通过；真实 ASR+TTS、系统代理/NO_PROXY 完整矩阵 BLOCKED-EXTERNAL |
| #13 | 真实用户数据未提供，新会话即时召回 BLOCKED-ENVIRONMENT；本轮 memory 使用 HTTP fixture，不冒充新 Hindsight 数据库验收 |
| #14 | Mac 性能基线未增加采样，原结论仍低置信 |
| #15 | 历史数字已增加可复现性说明 |
| #16–#20 | 不升正式版本、不推送、不清理个人数据或旧产物；远端冻结保持原状态，计数未重新查询 |

## Mac 接回

在原仓库确认没有未提交改动，再将下载的完整 Bundle 按实际路径导入：

```bash
git switch work/0.0.1-closure
git fetch /完整路径/dsh-bot-0.0.1-cloud-closure.bundle refs/heads/work/0.0.1-closure
git merge --ff-only FETCH_HEAD
node review/0.0.1-cloud-closure/verify.mjs
bash product/tools/verify-local.sh
bash product/tools/build-macos.sh
```

如果分支已被你继续修改，`--ff-only` 会中止，不强行覆盖。若 Playwright 未安装浏览器，可通过 `DSH_CHROMIUM_EXECUTABLE` 指定本机已有 Chromium/Google Chrome 的可执行文件；语音 Python 可用 `DSH_BOT_VOICE_PYTHON` 指定。生成新 DMG 后按 `accept-macos.sh <新 DMG 的完整路径>` 验收，核对新源码 SHA，勿使用旧 DMG。

人工重点：默认只留桌宠、双击打开会话；长 Markdown 与问答选项可读且有反馈；静默录音可取消且后台任务继续；审批实际出现后点允许/拒绝并对照审计与文件副作用；欢迎语后立即说「你好」；真人外放/耳机 10 轮与抢话；新会话召回真实记忆。全部完成前保留 beta。
