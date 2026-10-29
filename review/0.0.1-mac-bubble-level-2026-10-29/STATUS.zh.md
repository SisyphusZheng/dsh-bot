# Mac 修复：气泡被全屏 DSH 窗口遮挡（2026-10-29）

- 构建身份：`f801a59ba957e01418d70ea8d44f55b965d10117`
- DMG：`dsh-bot-0.0.1-beta-f801a59b-mac-arm64-unsigned.dmg`
- 大小 / SHA-256：`702,229,423 B` / `7acadd6bb6198b696618ad2b4fea62fc0dac94d69fa75d7c798d873a6a26e478`
- `verify-local.sh`：EXIT=0（477 Vitest、82 Python、Node、类型、9 构建门禁）
- `accept-macos.sh`：EXIT=0，PASS 15/15（LaunchServices attempt 1）
- 产品仍 0.0.1-beta；main/Actions/PR 未动。

## 根因

用户截图显示：气泡在普通窗口上方可见，但在 dsh-bot 自己的 DSH 主窗口（全屏/大窗口）上方消失。`floating` 窗口层级在 macOS 上可能被活动全屏窗口压住；且未设置 `skipTransformProcessType` 时，`visibleOnFullScreen` 不可靠。

## 修复

`product/pet/src/bubble-window.mjs`：

- `setAlwaysOnTop(true, 'screen-saver')`
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`

## 未验证

- 本轮只验证构建/LaunchServices/Headless 页面；全屏 DSH 上方的气泡可见性仍需用户实机确认。
- 真人声学/TCC/Provider/个人 Hindsight 仍未验收。
