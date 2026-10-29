# Mac 热修：助手输出气泡在 TTS 播报期间消失（2026-10-29）

- 源码/构建身份：`6e14edd59ea932d09853de915679a211a4507721`
- DMG：`dsh-bot-0.0.1-beta-6e14edd5-mac-arm64-unsigned.dmg`
- 大小 / SHA-256：`702,227,715 B` / `3f5a0b7949e5f5af630f91f5badb830331906378b0617bd7d165a5adf5bf1b64`
- 验收：`accept-macos.sh` **PASS 15/15**（原生签名、LaunchServices 首启/重启、Bridge、Web、Hindsight、shutdown/cleanup）
- 产品仍 `0.0.1-beta`；`main` 未动；Actions 649，新增 0。

## 根因

Presentation 在 `turn.ended` 后固定 1800ms 隐藏气泡；但语音 TTS 在文本 turn 结束后才真正开始播放（日志中 turn-end 20:24:28、Bot started speaking 20:24:31）。气泡在 TTS 开始前就消失了，所以用户看到“输入有气泡、输出没有”。

## 修复

- `turn.ended`：若当前显示的是 speech，改为 12s 兜底隐藏，而不是 1800ms。
- `voice('speaking')`：取消隐藏计时。
- `voice('idle'/'listening')` 且此前确实说过话、当前无任务/请求/草稿/队列时：1.2s 后隐藏。
- 非语音/纯文本回复仍按原 1800ms 行为。
- 新增回归：`assistant text stays visible while TTS is still speaking after turn-end`。

## 限制

- 真人声学、TTS 实际听感、TCC/物理交互仍未验收。
- 这是 Mac 热修候选；不改云端已有功能，只在本地分支追加。
