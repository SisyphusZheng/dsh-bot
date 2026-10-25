# 参考 Coopanion：dsh-bot 差距分析（2026-10-22）

> 只借鉴 Coopanion（Pal-AI-Lab，AGPL-3.0）的交互与功能设计，**不复制其代码/素材**。
> 依据：其官方 README（2026-10 版本 v0.2.6）与本地安装包只读检查；dsh-bot 现状按本仓库实测。
> 标记：✅ 已有 ｜ 🟡 部分 ｜ ❌ 缺

## 1. 模型与连接

| 能力 | Coopanion | dsh-bot 现状 |
|---|---|---|
| 多模型服务 | 13+ 家（OpenAI/Anthropic/Gemini/xAI/OpenRouter/DeepSeek/Kimi/Qwen/MiniMax/Zhipu/豆包/千帆/StepFun），每服务各自保存 key | 🟡 Bot 设置可选 opencode-go/DeepSeek/DashScope/OpenAI/自定义；DSH 自身也支持多 provider |
| ChatGPT 订阅登录 | 支持 | ❌ |
| 连接测试/错误提示 | 气泡内错误 + Open settings | ✅ Bot 设置「测试连接」+ 中文错误映射 |
| 用量与成本页 | 有（含价格表） | ❌（仅 DSH token 统计） |
| 推理强度/自定义模型 | 有 | 🟡 DSH 设置里可选 reasoning effort |

## 2. 语音输入

| 能力 | Coopanion | dsh-bot 现状 |
|---|---|---|
| 本机 ASR（FunASR SenseVoiceSmall / Whisper small） | 有，模型本地下载，音频不上传 | ❌（当前仅云端 Qwen Realtime；本地 ASR 在任务书 W15 可选） |
| Talk key（双击按住 / 按住；单键/组合/鼠标侧键） | 有 | ❌（只有唤醒词） |
| 聆听模式（按住说 / 按一下切换 / 一直听） | 有 | ❌ |
| 麦克风悬停按钮 / 输入气泡 / 取消 | 有 | 🟡 桌宠 toolbars 已裁到只留麦克风；无输入气泡 UI |
| 语音播报（打字音效/音节朗读） | 有 | 🟡 TTS 由语音网关负责 |

## 3. 记忆（用户特别关心）

| 能力 | Coopanion | dsh-bot 现状 |
|---|---|---|
| 长期记忆后端 | 自研 PARTNER.md + 版本化工作区 | ✅ **Hindsight 本地内置**（本轮接入：启动即起、本地 pg0、零外发 embeddings/rerank） |
| 记忆进 prompt | PARTNER.md 全文 | ✅ digest 注入 Bot prompt |
| 自动记忆 | 对话沉淀到 PARTNER.md | ✅ 每轮结束后写 episode 到 Hindsight |
| 记忆页（查看/搜索/删除/导出） | 有（含历史版本） | 🟡 本轮已有 搜索/导出/清空/状态；缺「查看全部/逐条纠正/版本历史」 |
| 人可读记忆文件 | PARTNER.md 可直接看/改 | ❌（Hindsight 库，不可直接读；可导出 JSONL） |

## 4. 人格与提示词

| 能力 | Coopanion | dsh-bot 现状 |
|---|---|---|
| 人格字段 | 称呼/性格/说话方式/关系等，内置 5 种人格 + 11 语言 | ✅ 8 字段（称呼/性格/语气/身份背景/口癖/对用户称呼/边界禁忌/人格说明） |
| System prompt 编辑器（CONSTITUTION、变量、预览、revert、apply） | 有 | ❌（当前只有人格字段，不能直接编辑完整 prompt） |
| 人格引导 | 首次引导内选择并随时可改 | 🟡 设置页可改，无引导 |
| 多语言人格 | 11 语言 | ❌（中文为主） |

## 5. 首次引导（pet-led onboarding）

| 能力 | Coopanion | dsh-bot 现状 |
|---|---|---|
| 气泡式引导（称呼/人格/走法/模型/语音模型/权限/设置位置） | 有，全部在气泡里完成 | ❌（已移除 qwen onboarding；任务书 W12 未做） |

## 6. 电脑操作与安全

| 能力 | Coopanion | dsh-bot 现状 |
|---|---|---|
| 屏幕查看 + 鼠标键盘 | 有 | 🟡 DSH 工具可操作电脑（terminal/文件等）；无屏幕查看专用流 |
| 审批粒度（每次/操作前/一次 N 分钟/从不） | 有 | 🟡 审批闸门 + bot-outside-write 预设；粒度不可配 |
| 用户碰键鼠立即暂停 | 有 | ❌ |
| 登录/密码/支付交还用户 | 有 | ✅ 明示（prompt 约束 + 审批） |
| 每唤醒请求预算 | 有（40 次） | ❌ |

## 7. 桌宠身体与表现

| 能力 | Coopanion | dsh-bot 现状 |
|---|---|---|
| 形象 | Coo + DeepSeek Whale（8 配色、2 套衣服）+ 第三方形象包 | 🟡 dsh-bot单一皮肤（idle/跑/挥手等 spritesheet 动画） |
| 互动 | 点击/摸头/拖动/抛掷/表情/动作/悬停按钮/右键菜单 | 🟡 拖动 + 双击 + 气泡 + 审批是/否；缺摸头/抛掷/表情动作/菜单 |
| 位置记忆 / 多显示器 / 全屏隐藏 | 有 | 🟡 位置记忆有（orb placement）；多显示器/全屏隐藏缺 |
| OBS overlay | 有 | ❌ |
| 活动气泡（思考/阅读/搜索/写文件/用电脑，带文件名、点击穿透） | 有，每个动作不同动画图标 | 🟡 只有文字气泡（turn.started/delta/settled/审批） |

## 8. 设置、诊断、发布

| 能力 | Coopanion | dsh-bot 现状 |
|---|---|---|
| 设置体系 | Start/Habits/Dress/Voice/System prompt/Usage&cost/Chat/记忆/诊断（高级模式） | 🟡 DSH 设置 → Bot（语音/LLM/后台Agent/人格/应用/记忆） |
| 诊断导出 | 有（Export diagnostics） | 🟡 audit.jsonl 存在；无 UI 导出 |
| 托盘/开机启动/后台常驻 | 有 | 🟡 壳有托盘/autoStart 字段未接 |
| 签名/公证/安装器/自动更新 | 有（未签名但自动更新） | ❌（用户要求暂缓） |
| 多语言 | 11 语言 | ❌（中英 UI 为主） |
| 遥测可关 | 有 | ✅ 无遥测（全部本地/自带 key） |

## 9. 建议补齐顺序（按产品收益/成本）

**P0（下一阶段，体验最像 Coopanion 的部分）**
1. **pet-led onboarding**（气泡里完成：称呼 → 人格 → 模型/Key 测试 → 语音 → 权限 → 提示）——W12。
2. **记忆页补全**：查看全部/逐条删除/纠正/版本历史（Coopanion 的 Memory 页等价物），并决定是否同时导出人可读 `PARTNER.md`。
3. **提示词/人格编辑器**：完整 system prompt 可看/可改/可预览/可恢复，人格字段只是它的常用部分。
4. **语音输入补全**：talk key（双击按住）、聆听模式、输入气泡与取消、错误在气泡里说。
5. **审批粒度 + 碰键鼠立即暂停 + 屏幕查看开关**。

**P1**
6. 活动气泡（动作图标+文件名+点击穿透可关）、Usage & cost 页、诊断导出、Chat 页（可视化 Bot 对话区）。
7. 桌宠互动（摸头/表情动作/右键菜单）、位置/多显示器/全屏隐藏、OBS overlay。

**P2**
8. 形象换装/换色/形象包、多语言（11）、签名/更新/安装器、扩展体系（Worlds 不做，用 DSH 插件体系替代）。

## 10. 明确不做的部分

- 不复用 Coopanion AGPL 代码/素材；DeepSeek Whale 美术不使用。
- 不做 OBS overlay 之前，现有桌宠透明窗由自有 Body Runtime 负责。
