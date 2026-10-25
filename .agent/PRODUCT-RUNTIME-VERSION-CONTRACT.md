# Product runtime version contract (v0.1, 2026-10-24)

本文件记录 dsh-bot v0.1 的版本契约。**产品版本与 DSH 运行时版本相互独立**。

## 当前固定栈

| 层 | 当前值 | 说明 |
|---|---|---|
| 产品 | `dsh-bot 0.1.0` | `apps/desktop/package.json`；Electron `app.getVersion()` |
| 产品基线 tag | `wg-v0.1-baseline.1` | commit `d521e6579d4baf348ba5a3b2ea33cb14bfa3e84e`；最终内测构建 `a5dd919a3e` |
| 内部验收产物 | `dist/v0.1/whalegirlbot-0.1.0-mac-arm64-unsigned.dmg` | sha256 `120e7b83c30c43658d63555a9343c6577e2ff15a65896d2e3af68559471640bf`；743MB |
| 基线后修复 | `142552179d` | host-integration single-flight / ready / ownership |
| DSH runtime | `0.2.1-rc.2` | fork 基于 `dsh-v0.2.1-rc.2`，+44 commits；runtime descriptor 记录此版本 |
| DSH 上游最新已见 | `dsh-v0.2.1-rc.3` | 仅预检候选，不自动升级 |
| Host Integration 插件 | `nisse-host-integration 0.1.0` | contract `v0`；HTTP bridge `dsh-nisse-subset-v0` |
| G2 Bridge 插件 | `whalegirl-g2-bridge 0.0.1` | DSH profile bundle，HTTP `/turn` NDJSON |
| 语音 | Pipecat `1.13.0` / aiortc `1.15.0` / av `17.1.0` | PyInstaller onedir `VoiceWorker`；client-js `1.14.0` + small-webrtc `1.11.0` |
| 长期记忆 | Hindsight `1.0.0` | 随包内置：PyInstaller 419MB + pg0 installation 36MB + int8 ONNX 113MB；异步启动 |
| 记忆打包布局 | `Contents/Resources/memory/{hindsight,models,pg0,sidecar.mjs,VERSION.json}` + `Contents/spike/m1-c-hindsight` | 载荷 589MB / 7,795 文件 / 32 符号链接；来源 `product/memory/**`，构建输入 `NISSE_MEMORY_DIR` |
| 用户数据格式 | `v1` | `<userData>/dsh-home`；记忆数据 `<userData>/dsh-home/memory`（含 pg0 安装/实例、模型、adapter 运行目录） |
| 应用身份 | `ai.nisse.app`（内部暂定） | 首次公证前需产品负责人定稿 |

## 发布必须记录

1. 产品版本、构建 commit、基线 tag；
2. DSH runtime 版本与上游 tag；
3. Bridge 插件版本与协议 rev；
4. Voice Worker 版本、Pipecat/aiortc/av 版本、provider 模型；
5. Hindsight 版本与模型/量化方式；
6. 用户数据格式版本与迁移脚本；
7. 回滚产物与已验证的上一版本。

## 更新策略

- 上游 DSH 在独立 worktree 预检，产品发布**固定**经过验证的版本；
- 产品更新不得覆盖用户数据；迁移需备份 + 回滚；
- 更新后健康检查覆盖 app shell、Bridge、Worker、一次真实 DSH turn、memory sidecar；
- 启动/健康失败恢复上一版应用与匹配数据快照；
- 签名/公证条件不满足时，正式自动更新标记 `DEFERRED-EXTERNAL`，内部仅做本地 feed 演练。

## 构建可复现性

- 构建前后 `git status --porcelain` 必须一致（构建不得改写源码）；
- 产物 SHA-256、构建命令与 commit 写入验收证据；
- 禁止依赖开发者绝对路径/开发目录（A 流清理项）。
