# Mac 验收：MVP READY FOR LOCAL ACCEPTANCE（2026-10-29）

状态：**Mac 自动验收 PASS；产品仍 `0.0.1-beta`，等待本机真人/声学/Provider 人工验收。**

- 分支 `work/0.0.1-closure`；本轮最终交付 `63bb2c4313`；应用源码冻结 `f9d65fdd`（之后仅验收文档）
- 构建身份：`63bb2c431321e80f8236ca953561b2f61978f7fb`
- DMG：`dsh-bot-0.0.1-beta-63bb2c43-mac-arm64-unsigned.dmg`
- 大小 / SHA-256：`702,228,179 B` / `01cef9f615f76f2b9dff185464c4328ae40991d870041fbc961978539dd53d42`
- `main` 未改；Actions 仍 649，新增 0；无 PR/tag/Release。

## 本机执行结果

1. `bash product/tools/build-macos.sh` → **EXIT=0**，9 项生产构建门禁；`packaged source identity = 63bb2c43…`；原生签名 660 文件 PASS（Gatekeeper 仍 rejected，属未公证 BLOCKED-EXTERNAL）。
2. `bash product/tools/verify-local.sh` → **EXIT=0**：22 文件 / 477 项 Vitest、78 项 Node、Python、5 项类型检查、9 项构建检查；真实页面/媒体/文档检查 PASS。
   - 本机环境前置：Playwright 1.61.1 对应 `chromium_headless_shell-1228` 需要先安装；首次执行因缺浏览器失败，执行 `node .../playwright/cli.js install chromium` 后默认入口通过。这是本机测试环境依赖，不是产品缺陷。
3. `bash product/tools/accept-macos.sh <DMG>` → **EXIT=0，status=PASS，15/15**：原生签名、LaunchServices 首启/退出/重启、Bridge、真实 Web boot、Bot Session、Memory health、Hindsight 写入/跨 Session/重启、两次 shutdown + descriptor cleanup。

## 本轮云端修复（已包含在候选）

- 发言碎片聚合、短句确认、可修改/删除的等待队列
- 语音选择题（共享答案给气泡/语音）
- 停止与取消回执、错误诊断
- Dock/菜单栏入口、系统通知、气泡避让
- 简短播报（长度限制，尚未做语义摘要）

## 仍未验收（需人工/真机）

- 本轮新 DMG 的真人声学：外放回声、蓝牙耳机、十轮连续对话、真实抢话
- TCC、鼠标穿透、Spaces、多屏/缩放、物理拖动
- 真实 Provider（ASR/TTS/LLM）长对话
- 真实个人 Hindsight 库跨重启召回
- 简短播报语义质量、Dock/通知观感、体积/冷启动
- Developer ID 签名与公证（已批准延期）

## 复现命令

```bash
git fetch origin && git switch work/0.0.1-closure && git pull --ff-only origin work/0.0.1-closure
bash product/tools/build-macos.sh
bash product/tools/verify-local.sh
bash product/tools/accept-macos.sh "$(node -p "require('./.mvv-build/evidence/macos-build.json').artifact.path")"
```
