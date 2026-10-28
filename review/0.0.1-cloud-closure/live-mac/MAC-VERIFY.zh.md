# 云端更新在 Mac 上的验收记录（2026-10-28）

## 导入

- 更新包：`dsh-bot-update.zip`（增量 bundle，SHA-256 校验通过），基线 `faaf1703d1`
- 方式：官方 `apply-update.sh`，`git bundle verify` 通过、`merge --ff-only` 成功
- 导入后 HEAD：`f8bd137442907fba115e95a9322781bba0284786`；本记录另提交为验证提交
- 未 push、未使用 Actions、未升版本、未改 main

## 自动门禁

- `node review/0.0.1-cloud-closure/verify.mjs`：**PASS**（frozen code `976eefa6`，33 证据哈希）
- `bash product/tools/verify-local.sh`：**EXIT=0**
  - run-gates 9/9；Vitest **17 文件 / 281 项**（含 `main-startup`、`welcome-startup`）
  - Node、Python 32、KWS、生产 Host（custom/opencode-go fixture）、真实 pet HTML 资源、Chromium 精灵/Markdown/长文本/长选项边界/按下选中/静默录音取消/审批允许拒绝、Pipecat/WebRTC 媒体链路均通过
- `bash product/tools/build-macos.sh`：**EXIT=0**，`packaged source identity = f8bd1374…`，构建门禁 9/9
- 新 DMG：`apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/dsh-bot-0.0.1-beta-f8bd1374-mac-arm64-unsigned.dmg`
  - 大小 `702,199,259 B`，SHA-256 `8108cb7fc46c8f45113e087e0531dad35a238b55546582f8047a5d9dc0e49008`
- `bash product/tools/accept-macos.sh <DMG>`：**EXIT=0**，`RESULTS.json status=PASS`，12/12 阶段通过

## 真实 App 内实测（本机、真实用户数据、真实 opencode-go Provider）

1. **Markdown 气泡**：助手回答在气泡内渲染出 `h2×1`、`strong×1`、`li×2`、`code×1`；气泡文本尾部保留「结尾标记」，长度 141 字符；`scrollHeight 258 > clientHeight 132` 且 `overflow:auto`，完整回答可滚动查看，不再截断/原样显示 `**`。
2. **问答气泡排版**：viewport 420，卡片 `top 16.5 / bottom 411` 在窗口内，footer（确认选择）`334–362.5` 完整可见；3 个长标签选项 `clipped=false`；点击后 `aria-pressed="true"`、`class="choice selected"`。
3. **按下反馈**：真实气泡内坐标测量未稳定捕获 `:active` 阴影（脚本竞态）；Chromium 冒烟测试对 `pointerdown` 阴影与 `aria-pressed` 的断言已通过。
4. **审批允许**：气泡明确显示 `write outside workspace: /tmp/dsh-live-allow.txt`，按钮「在 DSH 中查看 / 是 / 否」；点「是」后文件创建且内容为 `allow-live`。允许路径不再依赖 Agent 自述。
5. **默认简洁**：`用一句话介绍你自己` → 3–4 秒、**1 句 45 字**；`汇报当前工作区…` 在命令被拒后 → 2 句、明确不编造文件清单，并给两个恢复选项。真实模型风格仍需人工主观判断。
6. **静默录音取消**：本轮未在真实麦克风上重复（见下）；云端冒烟/集成测试已覆盖「无 ASR 文本即显示取消入口、取消不产生 Agent cancel」，旧候选本机实测过任务期间录音不取消任务。

## 重要副作用与隐私说明

- 首次验证启动时执行了 `gesture('down')` 模拟按住说话，脚本在等待气泡时超时，未能及时 `gesture('up')`；随后约 1 分钟内 Worker 将环境人声转写进会话（日志可见「然后就能使用幻帅了」「对」），App 被停止时该轮支持被标记为中断。之后所有测试均未再开启麦克风。
- 期间 Agent 尝试执行 `cd ~/Downloads && ls`，审批被点「拒绝」，未执行；`/tmp/dsh-live-allow.txt` 已删除。
- 如需恢复验收前的数据，备份：`<HOME>/Documents/projects/dsh-bot-backups/20261028/userdata-before-candidate`。

## 仍需人工

TCC 授权体验、真实外放回声/AEC、TTS 音色、真人 10 轮与抢话、口述唤醒词、物理穿透/Spaces/拖动/观感、真实 Provider 长对话与系统代理矩阵。
