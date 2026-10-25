# dsh-bot 产品壳结果（W1–W8，2026-10-22 PM）

> 承接 `WHALEGIRL-BOT-TASKBOOK.md`。只记录**已实测**的事实；未做的明确标 UNVERIFIED/待用户。

## 1. 结论

- **原唯一技术阻塞（真实 DSH 审批）已修复并端到端验证**：DSH 发起审批 → 桌宠气泡显示「是/否」→ 真实点击 → 回传 → DSH 执行/拒绝 → turn 结算；allow 真的创建文件、reject 真的不创建。
- W7 默认 Bot 工作区、W8 语音/LLM provider 选择+连接测试、W1 Body Runtime 清理、W6 双击切换 已完成并留证。
- W13 的 `m3/shell` 已删除；M4 六套件复跑 6/6 PASS（`tools/verify-m4.sh`）。
- **未做**（等用户/后续阶段）：真实麦克风与 TCC 验收、7 天 dogfood、签名/公证/打包（按用户要求暂缓）。

## 2. 关键实现

| 工作包 | 实现 | 证据 |
|---|---|---|
| W4 审批 | `nisse-host-integration` 的 approval answerer 用 `{ prepend: true }` 抢在 DSH UI 转发器之前，只回答 Bot session；与 DSH 窗口自带 answerer **竞速**（谁先答谁赢）；120s 无人答 fail-closed 为 `cancelled`；cancel 会结算所有 pending。 | `m4/bot-evidence/HOST-APPROVAL-RESULT.json`（隔离 host allow/reject）、`REAL-APPROVAL-PET-RESULT.json`（真桌宠气泡点击 是/否）、`PET-APPROVAL-BUBBLE-allow.png` |
| W5 写预检 | 预检闸门覆盖 `write/edit/apply_patch` 与 shell 工具的变更命令，工作区外路径 ask、工作区内不打扰；Bot session 使用 `bot-outside-write` 预设（sandbox danger-full-access + approval ask），**审批闸门是工作区外边界的唯一门**，所以 allow 后真的落盘、reject 后不执行。 | 同上两个 JSON（allow→文件存在；reject→不存在） |
| W7 默认 Bot 工作区 | host integration 每次会话读取 `DSH_HOME/bot/config.json` 的 `agent.workspace`，通过 DSH 官方 `workspaceRegistry` 注册；bridge cwd/预检边界/DSH 侧边栏与顶部工作区选择器同源；Bot 设置保存后壳重新生成 managed profile layer（保留用户自定义 patch 行）。 | `m4/bot-evidence/BOT-WORKSPACE-RESULT.json`、`DSH-DEFAULT-BOT-WORKSPACE.png`、`DSH-BOT-WORKSPACE-CHANGED.png`、`DSH-BOT-WORKSPACE-INTEGRATED.png` |
| W8 provider 选择 | `apps/desktop/src/bot-providers.ts`：语音（DashScope 默认/StepFun/豆包 Seeduplex/本地 ASR）与 LLM（opencode-go 默认/DeepSeek/DashScope/OpenAI/自定义 OpenAI 兼容）目录；8s 连接测试，401/403/404/429/5xx/超时/DNS/TLS 中文提示；密钥永不回显（GET/PUT 只回 `apiKeySet`；空 key 保留旧 key；`onConfigSaved` 拿真实 key 用于 env/profile）。LLM/工作区变更保存后自动重启一次（`WHALEGIRL_NO_RELAUNCH=1` 可关）。 | `m4/bot-evidence/BOT-PROVIDERS-TEST.json`（14/14 PASS，mock fetch）、`BOT-SETTINGS-INTEGRATION-RESULT.json`（真实壳内配置往返、真实 opencode-go 连接测试 PASS、无密钥回显、profile layer 正确） |
| W1 Body Runtime | `m3/pet/desktop`：删除独立设置窗/chat 面板/onboarding/独立会话/内嵌 gateway；只保留 orb/气泡/拖动/语音桥；双击→`/bot/toggle-main`；审批气泡是/否→`/bot/approval`；气泡可交互修复。 | `m3/pet/evidence/BODY-RUNTIME-CLEANUP.json`（smoke 6/6，含真实 Electron 窗口截图） |
| W6 双击 | 双击桌宠 → `POST /bot/toggle-main`：聚焦→最小化，否则 show+focus；每次双击恰好一次调用。 | `m4/bot-evidence/DOUBLE-CLICK-TOGGLE-RESULT.json`（3 次双击 3 次调用，shown/minimized 交替） |
| W13 清理 | `m3/shell` 已删除（删除前 grep/lsof 证据）；旧 qwen 入口清单与建议见 `m4/CLEANUP-REPORT.md`。 | `m4/CLEANUP-REPORT.md`、`m4/cleanup-evidence/` |
| M4 回归 | 六套件 6/6 PASS；`tools/verify-m4.sh` default PASS（含真实审批 E2E）。 | `m4/evidence/M4-E2E-SUITE.json`、`m4/evidence/VERIFY-M4.json`、`m4/evidence/HOST-APPROVAL-RERUN.json` |

## 3. 代码提交（fork `nisse/main`）

- `9b22d2371a` fix(approval): host integration owns Bot-session approval waterfall; full-access sandbox + preflight gate
- `2cf64b0bb2` feat(bot): default Bot workspace, selectable voice/LLM providers, pet approval round-trip
- 工作树 clean；`~/.dsh` 未被测试写入（所有联调用 `/tmp` 隔离 DSH_HOME；仅只读复制凭据用于隔离 host）。

## 4. 可复跑

```bash
# Bot 设置 provider/连接测试（无网络、mock fetch，14 项）
cd $HOME/projects/dsh-bot-workspace && node m3/bot/test-bot-providers.mjs

# M4 六套件 + 真实审批 allow/reject（隔离 /tmp DSH_HOME；default 模式含真实模型）
cd $HOME/projects/dsh-bot-workspace && ./tools/verify-m4.sh

# Body Runtime 证据（真实 Electron smoke 由 teammate 运行的脚本生成）
cat m3/pet/evidence/BODY-RUNTIME-CLEANUP.json
```

## 5. 未完成 / 需要用户

1. **真实麦克风 + TCC 语音验收 UNVERIFIED**：本轮所有语音链路用文本注入与 bridge 验证；真实说话/打断/TTS 需你在真机上配合（麦克风权限弹窗只能由你点）。
2. **7 天 dogfood 未开始**：产品 App 入口已可在本机以（开发壳 + 清理后 Body Runtime）方式跑通真实审批/双击/工作区；正式 dogfood 建议等打包后。
3. **签名/公证/打包/安装器（M6）暂缓**（你的决定）；当前没有打包产物交付。
4. **Hindsight 记忆服务产品化打包**未做（M4 工程层已验证 6/6）。
5. 已知遗留（不影响主路径）：`m3/pet/web/dist` 里仍有旧 chat/settings 前端资产（宿主层不可达，物理存在）；`dsh-nisse` 旧插件保留作参考；`m3/pet` 仍从 `research/qwen-audio-agent` 借 Electron/node_modules（打包时需正式内置）。
6. 壳侧 LLM/工作区变更目前"保存 → 自动重启一次"生效；若你希望不重启就切换，需要改 DSH host 热重启（后续可做）。
