# dsh-bot 任务书 v2（2026-10-22 调整）

## 1. 产品定位（唯一原则）

**DSH 接管全部**：DSH 是唯一 Agent/大脑；dsh-bot桌宠只是 OS 级身体与入口；Qwen 只做音频 I/O；chat 归 DSH session；设置归 DSH Settings → Bot。

目标形态：双击 dsh-bot 启动 OS 级透明置顶dsh-bot桌宠 + 内置 DSH；说话→bridge→DSH→工具/审批→语音/气泡；双击桌宠打开/最小化 DSH。

## 2. 开源与许可（已确认：MIT）

本项目采用 **MIT** 许可（自有代码）；DSH MIT、whale-girl MIT；不复制 Coopanion AGPL 代码/素材。所有上游版权与许可声明保留在 NOTICE。

**决定（2026-10-22）**：选 **A（自有代码 MIT/Apache-2.0）**。只借鉴 Coopanion 交互，不复制其 AGPL 代码/DeepSeek Whale 美术。

## 3. 技术架构

- **Body Runtime**：qwen-audio-agent 桌宠渲染器（dsh-bot canvas 动画、透明置顶、可拖动、气泡、语音采集/TTS/打断）；
- **DSH**：fork DSH desktop（dsh-bot），唯一 Agent；
- **Bridge**：Host Integration v0（第一方 bundle，不改 packages/core）；
- **Voice**：默认云端 Qwen Realtime（更自然的语音交互）；**语音 provider 用户可选**（Qwen Realtime / 其他云 TTS/ASR / 本地 ASR）；
- **LLM**：provider/模型由用户选择（DSH 支持的 provider）；Bot 设置里提供 provider + key + model 配置；
- **Settings**：DSH 设置内 Bot 页（语音前台/后台 Agent/人格/应用）；
- **Default Bot workspace**：DSH 顶部自然存在，可在 Bot 设置指定。

## 4. 工作包

| # | 工作包 | 验收 |
|---|---|---|
| W1 | Body Runtime 裁剪：删除 qwen chat/settings/onboarding/toolbar/独立会话 | 工具条仅语音；无独立设置窗/chat |
| W2 | 气泡重做：限宽、无阴影、闭合尖角、可交互 | 视觉验收；不再过宽/开口 |
| W3 | DSH 状态驱动：turn.started/delta/settled → 气泡/状态 | 真实 DSH 事件驱动，无假状态 |
| W4 | 审批：approval.request → 气泡「是/否」→ /approval；绑定/超时/取消 | allow/reject 生效、拒绝不执行 |
| W5 | 写审批预检：工作区外写 → 审批后重试（不依赖模型自觉升级） | 文件在 allow 后创建、reject 不创建 |
| W6 | 双击切换：未开→打开默认 Bot 工作区；已聚焦→最小化 | 实测 shown/minimized |
| W7 | 默认 Bot 工作区：DSH 顶部显示、可在 Bot 设置指定 | 新会话进入该 workspace/session |
| W8 | Bot 设置完整：语音/LLM provider 选择 + Agent/人格/应用 + 连接测试/错误提示 | 用户可选语音与 LLM provider；改配置生效、失败原因可见 |
| W9 | 语音 bridge 文本 E2E | `user.message→assistant.message→completed` ✅ 已 PASS |
| W10 | 真实麦克风/TCC 验收 | 需用户配合 |
| W11 | 记忆可见性（借鉴 Coopanion）：查看/纠正/删除/导出/版本 | Hindsight 接入后验收 |
| W12 | 首次引导（pet-led onboarding）：称呼/人格/Key/语音/权限 → 写入 DSH 设置 | 不打开独立设置窗 |
| W13 | 清理 m3/shell、旧 qwen 入口、临时实验 | 工作树 clean、无旧入口 |
| W14 | 最终打包（用户要求时）+ 一致性/清洁审计 | 冒烟+审计报告 |

## 5. 本地 ASR（可选增强）

- 本地 ASR = 语音识别在设备上完成（FunASR SenseVoiceSmall ~230MB / Whisper small ~360MB），音频不上传，只把文本发给模型；
- 优点：隐私、离线、无 ASR 云费用；缺点：首次下载模型、占用 CPU/内存、长音频较慢；
- 当前我们用 Qwen Realtime（云端、低延迟、音频发给 DashScope）；任务书把“本地 ASR 可选”列为 W15，默认不阻塞 MVP。

## 6. 借鉴 Coopanion（只借鉴，不抄代码/素材）

- talk key（双击后按住/组合键/鼠标侧键）、三种聆听模式、麦克风悬停按钮；
- 审批粒度：每次/操作前/一次 N 分钟/从不；用户碰键鼠立即暂停；登录密码支付交还用户；
- pet-led onboarding 气泡式引导；
- 记忆可见/版本/导出；
- 位置记忆、多显示器、全屏隐藏、点击/摸头/拖拽、悬停按钮；
- 错误在气泡明确说出（key 错/余额/模型错）；正常/高级设置分层；诊断导出。

## 7. 当前状态与阻塞

- 已完成：品牌/登录/Licenses、Bot 设置页+配置、气泡样式、Body Runtime 工具条裁剪、bridge 文本 E2E、审批 UI 假 bridge 验证；
- 阻塞：真实 DSH approval 未触发（bridge agent 无 write 工具；sandbox 拒绝不升级）；需要按 1+2 方案修工具/审批；
- 未打包；签名/公证暂缓；真实麦克风/TCC 需用户。

## 8. 当前阶段与剩余（2026-10-22）

**当前**：M0–M2 已完成；M3 计划内原型完成；现在处于 **M3 余项/产品壳一体化**（OS 桌宠 + DSH 接管 + Bot 设置 + Voice bridge），尚未进入正式 M4 MVP 验收。

**剩余**：
1. 产品壳（本任务书 W1–W13）：Body Runtime、气泡、DSH 状态、审批、写预检、默认 Bot 工作区、provider 选择、清理；
2. M4 MVP：真实语音主路径、人格、Hindsight 记忆、安全/审批/审计、E2E、7 天 dogfood；
3. M5 Alpha：onboarding、设置/状态/错误体验、性能、用户测试；
4. M6 安装与发布：签名/公证/安装器/更新/卸载/SBOM（你已要求暂缓）；
5. M7 Beta/RC/1.0：可靠性/长任务/故障注入/试点/发布门禁。

## 9. 决策点

1. 开源许可选 **A（MIT/Apache，只借鉴）** 还是 **B（AGPL，可复用 Coopanion 代码）**？
2. 是否把本地 ASR（W15）列为必做？
