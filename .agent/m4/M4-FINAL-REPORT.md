# M4 最终报告：MVP 工程与验收（2026-10-22）

> 状态：**工程/自动化验收完成；真实语音/TCC 与 7 天 dogfood 需用户参与（未完成）**
> 环境：macOS arm64；fork 构建产物 DSH 0.2.1-rc.2；隔离 DSH_HOME；Hindsight v1.0.0（mock LLM，零外发）。
> 约束：无 DSH core 改动（check-patches coreChanges=[]）；未写用户 `~/.dsh`。

## 1. 工作包结果

| # | 工作包 | 结果 | 证据 |
|---|---|---|---|
| M4-1 | 问答 → DSH 回答 | ✅ 文本 E2E PASS | `M4-PATHS-RESULT.json` |
| M4-2 | 低风险文件任务/审批 | ✅ 工作区内写 + 工作区外审批 allow 均 PASS | 同上 |
| M4-3 | 任务历史/「刚才做了什么」 | ✅ `/history` PASS | 同上 |
| M4-4 | 停止播报/取消 | ✅ 取消 E2E + 停播报≠取消任务（运行期/状态机）PASS | `M4-STOP-RESULT.json`；UI 三态/急停待 M5 |
| M4-5 | 人格单一来源、下一轮生效 | ✅ 5/5 PASS | `M4-PERSONA-RESULT.json` |
| M4-6 | Hindsight 记忆 v1 | ✅ Adapter 5/5；Host Integration 代理/digest 3/3（真实答案使用记忆） | `M4-MEMORY-RESULT.json`、`M4-MEMORY-HOST-RESULT.json` |
| M4-7 | 安全 v0 | ✅ 工具级 always-allow/TTL/撤销、审批绑定、错误 id、秘密扫描 6/6 | `M4-SECURITY-AUDIT-RESULT.json` |
| M4-8 | 审计 | ✅ audit.jsonl + `/audit`；审批/取消/人格事件可追溯 | 同上 |
| M4-9 | E2E/安全套件 | ✅ **6/6 测试文件 PASS**（含 stop 语义）（paths/persona/security/memory/memory-host/stop-semantics） | `M4-E2E-SUITE.json` |

套件总耗时约 84s（本次热缓存）；所有测试进程已停止。

## 1.5 真实语音 Shell（2026-10-22）

> **W13 更新（2026-10-22 21:1x）**：本节引用的 `m3/shell/`（含 `run-real.sh`）已在 W13 清理中**删除**；
> 历史证据保留在 `m4/cleanup-evidence/`（`M3-shell-ui.png`、`M3-shell-RESULT.json`、`PRE-DELETE-MANIFEST.txt`）。
> 真机语音入口改为产品桌面 App，由 Lead 接线中；删除与影响见 `m4/CLEANUP-REPORT.md` 与 `AUDIT-2026-10-22-PM.md`。

- `m3/shell/run-real.sh`：真实 route-C Qwen 语音网关 + WebUI 载入 Shell 窗口；Host Integration bridge 已接通（realtime connected）；
- TCC 麦克风状态：**granted**（dev Electron），userData 已隔离到 `/tmp`（不再写用户 Application Support）；
- 当前等待用户点击「开启麦克风」并做真机语音验收（T5 打断/T7 审批/普通问答）。

## 2. 仍缺少（必须用户参与）

1. **真实语音/TCC**：当前所有 E2E 用文本注入；需要真机麦克风授权、设备所有权、回声/打断实测；
2. **7 天 dogfood**：M4 退出标准要求作者连续 7 天真实任务、≥20 次成功语音任务、无 P0；
3. **产品 UI 接入**：当前 Shell 只有状态卡；设置/审批/记忆页属 M5；
4. **Hindsight 产品化打包/生命周期**：mock 服务与 sidecar 已跑通，正式安装包依赖（M2/M6 决策）；
5. **路径级 always-allow scope**：DSH approval reason 为自然语言且截断，v0 实际为工具级；路径级需 DSH 结构化元数据/Host Integration 预判（M5 安全增强）；
6. **停播报≠取消任务 UI 三态**：Voice stub 支持事件，产品层联动待接。

## 3. 验收判定

- M4 工程目标（主路径/人格/记忆/安全/审计/套件）：**完成**；
- M4 正式退出（真实语音 + 7 天 dogfood）：**未完成，等待用户**；
- 无安全 P0 阻塞；已知限制已列。

## 4. 证据索引

`m4/evidence/`：`M4-PATHS-RESULT.json`、`M4-PERSONA-RESULT.json`、`M4-SECURITY-AUDIT-RESULT.json`、`M4-MEMORY-RESULT.json`、`M4-MEMORY-HOST-RESULT.json`、`M4-E2E-SUITE.json`；各分报告 `m4/M4-*-REPORT.md`。


## 6. 当前等待用户（唯一剩余）

> **W13 更新（2026-10-22）**：`m3/shell` 原型（含本节引用的 `run-real.sh`）已删除，历史证据见
> `m4/cleanup-evidence/`。真机语音入口改为产品桌面 App（Lead/body-runtime 接线中），当前无可复跑命令。

- 旧真实语音 Shell（`m3/shell/run-real.sh`）已删除；TCC 曾为 granted（dev Electron，历史记录）；
- 真机语音验收（T5 打断 / T7 审批 / 问答）尚无用户交互（历史日志 speech_started=0），状态 **UNVERIFIED**；
- 7 天 dogfood 需用户按 `m4/M4-DOGFOOD.md` 执行（当前入口未就绪，不可开始计时）；
- 在完成以上两项前，M4 不标记完成。
