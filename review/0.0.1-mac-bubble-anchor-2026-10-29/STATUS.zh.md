# Mac 验收：气泡避让锚定桌宠（2026-10-29）

- 源码/构建身份：`c26299603869e304e9e5798b8dbe46929127aa5e`
- DMG：`dsh-bot-0.0.1-beta-c2629960-mac-arm64-unsigned.dmg`
- 大小 / SHA-256：`702,228,895 B` / `b0a17cbed9fce5f08f8d2f914423028e7486731a38222e1c1bb8c94defa131e1`
- 验收：`accept-macos.sh` **PASS 15/15**（原生签名、LaunchServices 首启/重启、Bridge、Web、Hindsight、shutdown/cleanup）
- 首次/第二次验收曾出现隔离 profile 下 first-bridge 失败（Host not ready），第三次重跑通过；已记录为环境/启动时序问题，未在本轮改动产品启动逻辑。
- 产品仍 `0.0.1-beta`；`main` 未动；Actions 649，新增 0。

## 修复

- 气泡避让主窗口时，原先会把气泡放到屏幕最左/最右的“空位”，导致离桌宠很远。
- 现在候选位置只允许在桌宠附近（上/左/右/下），并以重叠面积和与桌宠距离共同评分；不允许远离桌宠。
- 回归：气泡中心距桌宠中心 >500px 视为失败；保留窗口缩放/多屏边界断言。

## 未验收

真人声学、TCC、真实 Provider、个人 Hindsight、Dock 观感、体积/冷启动。
