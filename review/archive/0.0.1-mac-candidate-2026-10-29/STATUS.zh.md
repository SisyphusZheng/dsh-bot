# Mac 本机验收：0.0.1-beta 候选（2026-10-29）

状态：**PASS（自动 + 打包 + LaunchServices 安装启动链路）；真人声学/TCC/物理交互仍 BLOCKED-ENVIRONMENT。**

- 分支：`work/0.0.1-closure`
- 源码冻结/构建身份：`4aa3b8d39be665743aa87935b0868a265e00777f`（云端冻结 `345a1d60` + 本机 packaging 修复）
- 后续提交只记录 Mac 构建修复与验收证据（HEAD 见仓库）
- 候选 DMG：`apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-4aa3b8d3-mac-arm64-unsigned.dmg`
- 大小 / SHA-256：`702,164,591 B` / `52b01bf8f9dd7af5eced75b5dd19e2a5e3e555c952190f19984a4d1a307db6c1`
- 产品仍 `0.0.1-beta`，未改 main、未建 PR/tag/Release、未使用 Actions。

## 验收结果

`bash product/tools/accept-macos.sh <DMG>` → **EXIT=0，RESULTS status=PASS，15/15 阶段**：

- `native-signatures` PASS（660 个原生 Mach-O；`codesign --deep --strict` 通过；Gatekeeper 仍 rejected，属未公证的 BLOCKED-EXTERNAL）
- `first-launchservices` / `restart-launchservices` **PASS**：真实 `open`（LaunchServices）启动、退出、再次启动
- Bridge、真实 Web boot + 精灵双击 + Bot Session 匹配、Memory health
- 真实 Hindsight 写入 / 跨 Session / 重启召回
- 两次 shutdown、descriptor cleanup

完整日志：`accept-macos.log`、`build-macos.log.gz`、`native-signatures.json`、`RESULTS.json`、`DMG-SHA256.txt`。

## 本轮为让 Mac 构建/启动成立所做的修复

1. 未签名构建先对 runtime 做 ad-hoc 签名，再写 ASAR 完整性清单（原顺序会让签名改变字节导致 `ASAR integrity verification failed`）。
2. 忽略 Finder 生成的 `.DS_Store`（运行时清单、目录清理、PyInstaller 输出均受影响）。
3. PyInstaller（memory/voice）改为先构建到临时 dist 再交换，避免 `--noconfirm` 的 `ENOTEMPTY`。
4. 未签名 App 在 DMG 创建前对 Frameworks 与 App 本体做 ad-hoc 签名；否则 LaunchServices/AMFI 拒绝 Electron Framework。
5. 验收脚本 LaunchServices 启动加 `--env ELECTRON_RUN_AS_NODE=`（避免继承 harness 的 Node 模式），并增加重试与独立 stdout/stderr 日志。

## 仍未验收

- 真人麦克风/外放/蓝牙耳机/十轮对话/连续抢话/回声
- TCC 授权、鼠标穿透、Spaces、多屏/缩放、物理拖动
- 真实 Provider（DashScope ASR/TTS + LLM）完整长对话
- 本候选的真实 Hindsight 跨重启语义检索（打包验收使用隔离机器上的真实 Hindsight，但不是你的个人数据库）
- 安装体积/冷启动优化、Developer ID 签名与公证（已批准延期）
- 全仓双语文档配对 9 项历史债务（非阻塞）

## 建议人工验收入口

```bash
bash product/tools/build-macos.sh
bash product/tools/accept-macos.sh /absolute/path/to/candidate.dmg
# 稳定安装（默认不覆盖旧 App）：
bash product/tools/install-macos.sh /path/to/dsh-bot.app
# 然后从 Finder 双击 $HOME/Applications/dsh-bot.app
```

旧 App、旧 DMG、用户数据没有被本流程删除。
