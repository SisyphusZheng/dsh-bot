# Mac 候选：语音审批/播报修复（2026-10-29）

- 构建身份：`c2ae35b2aece8d402b404dbbcfbf84657cecb27b`
- DMG：`dsh-bot-0.0.1-beta-c2ae35b2-mac-arm64-unsigned.dmg`
- 大小 / SHA-256：`702,229,423 B` / `d2d28b1445eb2d8c2a677e3cfab6e442ef3b9629261dd233ca0c6042ca546663`
- 产品仍 `0.0.1-beta`；`main` 未动；Actions 649，新增 0；无 PR/tag/Release。

## 本轮修复

1. **语音审批口令**
   - 允许自然前缀：`我允许一次`、`我确认允许一次`、`好的，确认允许一次`、`那拒绝`。
   - 仅当剥离前缀后的剩余文本仍是精确控制词才生效；`我不允许你这么做`、`解释一下允许一次` 不会授权。
   - `确认发送` / `取消输入` 同样支持前缀。
   - 常听模式的“确认允许一次”安全要求保持不变。
2. **退出时审批提醒异常**
   - Worker 关闭阶段 bridge 描述符已被删除时，announcement 循环静默结束，不再打印 `FileNotFoundError` 或向用户播报误导性的“提醒暂不可用”。
3. **TTS 文本**
   - 新增 `SpeechTextFilter`：Markdown 过滤后把换行/列表折叠成句间停顿，去除多余空白；TTS 不再念 `\n`。
4. **验收启动稳定性**
   - `accept-macos.sh` 启动前清理残留 App 实例；等待 App PID + bridge 描述符同时就绪；失败时重试一次并保留日志，不再把 LaunchServices 启动抖动误报为产品 FAIL。
5. **气泡位置测量**
   - 新增 `product/tools/verify-bubble-placement.mjs`：触发一次短回复，读取真实 Electron 原生窗口 frame，断言气泡中心与桌宠中心距离 <500px 且在屏内。

## 验证结果

- Python：82 项通过。
- Node/Pet/Host：91 项通过。
- `verify-local.sh`：EXIT=0；477 项 Vitest、82 项 Python、Node、类型检查、9 项构建门禁。
- `accept-macos.sh`：**连续 2 次 PASS，均为 LaunchServices attempt 1**，15/15 阶段。
- 气泡位置测量：**PASS，distance=171px**（pet 172×204，bubble 380×182）。
  - 注意：测量用的是直接调试启动 + 隔离 user-data，用来验证原生窗口位置；LaunchServices 启动链路已由 acceptance 覆盖。
- 未验证：真人声学/蓝牙/TCC、真实 Provider 长对话、个人 Hindsight 库、语音审批在真人麦克风下的端到端（本轮只到单元/模块测试）、Dock/通知观感、体积/冷启动。

## 复现

```bash
bash product/tools/build-macos.sh
bash product/tools/verify-local.sh
bash product/tools/accept-macos.sh "$(node -p "require('./.mvv-build/evidence/macos-build.json').artifact.path")"
node product/tools/verify-bubble-placement.mjs <user-data-with-debug-port>
```
