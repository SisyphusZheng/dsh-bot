# Mac 验收：常听输入与问答气泡修复候选（2026-10-29）

状态：**Mac 自动验收 PASS（含 LaunchServices 首启/重启）；真人声学、TCC、真实 Provider 与个人记忆库仍 BLOCKED-ENVIRONMENT/EXTERNAL。**

- 源码冻结：`973a5488b2d4f15c662645924da5dc536fcd56ca`（云端 `261654e6` 证据提交）
- 构建身份：`261654e65ff6abe65e282aa6fbcce6551482b650`
- DMG：`apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-261654e6-mac-arm64-unsigned.dmg`
- 大小 / SHA-256：`702,184,079 B` / `8ec5d4a4b02ff8a563bd32eb4a9eb1ca5c89ddc7df73dd5d26d4a2010e9f84f8`
- 产品仍 `0.0.1-beta`；main、Actions、PR/tag/Release 均未动。

## 验收

`bash product/tools/accept-macos.sh <DMG>` → **EXIT=0，status=PASS，15/15**：

- native-signatures PASS（660 原生文件；`codesign --deep --strict`）
- **first-launchservices / restart-launchservices PASS**（`open` 首启、退出、重启）
- Bridge、真实 Web boot + 精灵双击 + Bot Session、Memory health
- 真实 Hindsight 写入 / 跨 Session / 重启召回
- 两次 shutdown + descriptor cleanup

## 本轮行为修复（云端提供，Mac 构建包含）

- 长问答正文与选项说明共用滚动区，提交控件固定底栏
- 常听普通输入先确认（发送/修改/丢弃，30 秒过期、只执行一次）
- 审批/问答在语音连接时播报一次
- 常听普通误词不再直接打断/压低播报
- 输入气泡区分“我听到”、识别中、待确认、已提交
- TTS 使用 Markdown 过滤器（视觉 Markdown 保留）

## 未验收

- 真人外放回声、蓝牙耳机、十轮连续对话、真实抢话
- TCC、鼠标穿透/Spaces/多屏/物理拖动
- 真实 Provider 长对话、真实个人 Hindsight 库
- Dock 图标、主窗口/气泡统一避让、语音关闭时的系统通知、分层播报、体积/冷启动
- Developer ID 签名与公证（已批准延期）

## Mac 二进制可复现入口

```bash
bash product/tools/build-macos.sh
bash product/tools/accept-macos.sh /absolute/path/to/dsh-bot-0.0.1-beta-261654e6-mac-arm64-unsigned.dmg
bash product/tools/install-macos.sh /path/to/dsh-bot.app   # 默认保留旧 App
```
