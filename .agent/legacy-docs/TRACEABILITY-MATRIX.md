# 需求 → 设计 → 实现 → 测试 → 门禁 追溯矩阵（M0）

> 状态：2026-10-21｜维护：Lead｜评审：测试/安全
> 用法：每个需求必须能追到设计决策、实现位置、测试、门禁阶段；没有测试的需求不得标记完成。实现位置为「现状」或「目标」。
> 关联：`M0-FACT-BASE.md`、`ROADMAP-M0-TO-1.0.md`、`SPIKE-DSH-VOICE-INTEGRATION.md`、`RISK-REGISTER.md`、`review/evidence-*.md`。

---

## 1. 产品需求

| REQ | 需求 | 设计/ADR | 现状实现位置 | 目标实现位置 | 测试/证据 | 门禁 |
|---|---|---|---|---|---|---|
| REQ-01 | 一次安装、自包含 runtime，不需用户装 DSH/插件 | ADR-0001/0004/0005 | 无（现有插件依赖用户 DSH） | Release：安装器 + 独立 DSH_HOME | M6 干净机安装/卸载；M3 `~/.dsh` 零写入 | M3/M6 |
| REQ-02 | 桌宠身体：透明置顶、拖拽、点击/穿透、动作/皮肤 | ADR-0004 | `research/qwen-audio-agent/desktop/src/orb-*`（原型） | Nisse Shell | runtime §4 真机证据；M5 验收 | M3/M5 |
| REQ-03 | 独立气泡/任务卡/托盘/热键 | ADR-0004 | `bubble-window.mjs`、`main.mjs`（原型） | Nisse Shell | 单测 26/26；M5 真机几何采样 | M3/M5 |
| REQ-04 | 实时语音：开麦、唤醒、全双工、音色、打断、停止 | ADR-0003 | Qwen server/voice（可用） | Voice Runtime（去 Agent 化） | M1 T1/T5；SPIKE §5 | M1 |
| REQ-05 | 唤醒词本地可用、可配置 | ADR-0003 | `desktop/src/wake-word/*`（原型） | Voice Runtime | 合成音频 4/4；真人样本待测 | M1/M5 |
| REQ-06 | 单一 Agent 权威：DSH 决策/执行；语音无执行权 | ADR-0002/0003 | 未成立（Qwen 前台是完整 Agent，prompt 压制） | DSH + Voice + Host Integration | M1 T11–T14；工具审计 | M1（核心） |
| REQ-07 | 语音输入提交 DSH，一次输入一个 turn | ADR-0002 | ACP/插件桥（原型） | Host Integration | M1 T1/T2/T8 | M1 |
| REQ-08 | DSH 工具执行 + 结果汇报 | ADR-0002 | 插件桥 + DSH（原型） | Host Integration | M1 T3/T4 | M1 |
| REQ-09 | 审批绑定正确任务、可允许/拒绝/总是允许 | ADR-0007 | 插件 approval + always-allow（弱） | DSH 执行门 + 产品策略 | M1 T7；M4 SEC-01/04–08 | M1/M4 |
| REQ-10 | 停止播报 ≠ 取消任务 ≠ 急停 | ADR-0007 | 部分（stop phrase/cancel 已有；点dsh-bot只停音频） | 产品层 + Voice + DSH | M1 T5/T6/S1；M4 | M1/M4 |
| REQ-11 | 取消后不再发起新工具动作；不谎称回滚 | ADR-0007 | 部分（插件 /cancel；竞态未测） | 产品层 + DSH | M1 T6/S5；M4 | M1/M4 |
| REQ-12 | 统一 turn/task/approval/event 契约 | ADR-0008 | 无（客户端字符串 turnId） | `packages/nisse-contracts` | M3 契约测试；M1 事件日志 | M1/M3 |
| REQ-13 | 任务状态/进度/历史；失败说明 | ADR-0008 | 仅「完成→语音」（原型） | 产品层状态机 + UI | M4 任务状态测试；M5 用户测试 | M4/M5 |
| REQ-14 | 人格单一来源；修改下一轮生效 | ADR-0002/0006 | prompt section 原型（两处） | DSH preset/persona + UI | M4 人格一致性测试 | M4 |
| REQ-15 | 长期记忆单一权威；可查改删导出 | ADR-0006 | 文件工作区（原型，隔离失败） | Host Integration memory | M4 记忆 CRUD/迁移/删除；M1 不阻塞 | M4 |
| REQ-16 | 记忆删除后不再召回；用户修改不被覆盖 | ADR-0006 | 未验证 | Host Integration + 索引 | M4 删除/召回测试 | M4 |
| REQ-17 | 凭据安全：Keychain/受限文件，不入日志/记忆/Git | ADR-0006/0007 | 部分（桥 token 0600；日志待查） | 全组件 | M4 SEC-16；M6 凭据检查 | M4/M6 |
| REQ-18 | 数据隔离：不写 `~/.dsh`，卸载按用户选择保留/删除 | ADR-0001/0004/0006 | 不成立（反向证据） | Shell/Release | M3 零写入；M6 卸载 | M3/M6 |
| REQ-19 | 首启向导/设置/权限引导；状态可辨识 | ADR-0009（平台） | 无/原型 | 产品层 UI | M5 用户测试 | M5 |
| REQ-20 | 失败可诊断：DSH/Voice/网络/Key/权限/版本 | ADR-0004/0008 | 部分（日志/错误） | 全组件 | M3 故障注入；M5 用户测试 | M3/M5 |
| REQ-21 | 签名/公证/更新/回滚/卸载 | ADR-0005（发行） | 无（adhoc；updater off） | Release | M6 干净机/升级失败回滚/卸载 | M6 |
| REQ-22 | 可复现构建、依赖锁定、SBOM/许可 | ADR-0005 | 无（无 git/lockfile/CI） | Release | M2 构建/许可；M6 合规 | M2/M6 |
| REQ-23 | macOS 首发；Windows 次之；Linux 条件 | ADR-0009 | 仅 macOS | Shell 适配层 | M8 平台矩阵 | M8 |
| REQ-24 | OpenElement 不阻塞核心 | ADR-0010 | 未集成 | 独立 M9 轨道 | M9 一页 spike Go/No-Go | M9 |
| REQ-25 | 上游同步/受控 fork/patch 治理 | ADR-0005 | 无 | Release/平台 | M2 merge 演练；M7 同步演练 | M2/M7 |
| REQ-26 | 语音可替换/降级（不锁定单一供应商） | ADR-0003 | 部分（Qwen 固定） | Voice Runtime 抽象 | M1 路线比较；M8 平台 | M1/M8 |

---

## 2. 安全需求（来自 `review/evidence-security.md`）

| SEC | 控制/测试 | 关系 | 设计 | 现状 | 目标测试 | 门禁 |
|---|---|---|---|---|---|---|
| SEC-01 | 普通语句/回声不得批准审批；待审批时普通语句不被吞 | R07 | ADR-0007 | ❌（宽松匹配） | M1/M4 语音审批测试 | M1/M4 |
| SEC-02 | 审批有视觉动作摘要（工具/路径/参数/范围） | R07 | ADR-0007 | ❌ | M4 UI 审批测试 | M4 |
| SEC-03 | 审批超时/过期/已结算拒绝 | R07 | ADR-0007 | ❌（部分） | M4 过期/重复测试 | M4 |
| SEC-04 | always-allow 绑定 tool+scope+TTL，可查看/撤销 | R08 | ADR-0007 | ❌ | M4 策略测试 | M4 |
| SEC-05 | always-allow 单一存储、撤销闭环、重启生效 | R08 | ADR-0007 | ❌（双存储不一致） | M4 撤销/重启测试 | M4 |
| SEC-06 | always-allow 作用域不可用 `..`/symlink/空前缀绕过 | R08/R09 | ADR-0007 | ❌（reason 子串） | M4 路径/作用域负例 | M4 |
| SEC-07 | 审批→执行无 TOCTOU；执行前重校验 | R09 | ADR-0007 | ❌ | M4 竞态测试 | M4 |
| SEC-08 | L3 高危默认拒绝/非语音二次确认 | R07 | ADR-0007 | ❌ | M4 风险分级测试 | M4 |
| SEC-09 | 文件路径 realpath/工作区/敏感路径/覆盖校验 | R09 | ADR-0007 | ❌（零校验） | M4 路径负例矩阵 | M4 |
| SEC-10 | 取消后无新工具动作；不谎称回滚 | R10 | ADR-0007 | 部分（竞态未测） | M1 T6/M4 S5 | M1/M4 |
| SEC-11 | `/cancel` 只能取消授权目标（session/turn） | R10 | ADR-0008 | ❌（任意 sessionId） | M3/M4 目标校验 | M3/M4 |
| SEC-12 | loopback 只 127.0.0.1；token 不入 URL/日志；Origin/Host 校验 | R11 | ADR-0008 | 部分（query token/无 Origin） | M3 安全测试 | M3 |
| SEC-13 | `/health` 最小化；同用户进程信任边界明确 | R11 | ADR-0008 | ❌（泄露 pid/路径/session） | M3 信息泄露测试 | M3 |
| SEC-14 | renderer 安全：contextIsolation/sandbox/IPC 校验/外链 | R11 | ADR-0008 | ✅（良好实践，需固化） | M3/M4 CI 断言 | M3 |
| SEC-15 | 依赖锁定/SBOM/签名/更新完整性 | R16/R18 | ADR-0005 | ❌ | M6 供应链检查 | M6 |
| SEC-16 | 日志/记忆无 Key/token/审批原文；脱敏可验证 | R17/R23 | ADR-0006/0007 | 部分（待验证） | M4 日志/记忆检查 | M4 |
| SEC-17 | 记忆导出/删除/备份恢复可验证 | R12 | ADR-0006 | ❌ | M4 测试 | M4 |
| SEC-18 | Voice/DSH 崩溃不假聆听/假执行 | R06/R10 | ADR-0004 | 部分（spike 级） | M1 T9/M3 故障注入 | M1/M3 |
| SEC-19 | 急停后无新输入/操作，保留现场 | R10 | ADR-0007 | ❌ | M4 急停测试 | M4 |
| SEC-20 | 遥测/隐私：默认关闭/明示；数据外发说明 | R17/R18 | PRODUCT §6.3 | ❌ | M6 隐私检查 | M6 |

图例：✅ 已具备（需固化/回归）；部分；❌ 缺失/不成立。

**证据编号映射**（`review/evidence-security.md` 用 C/H/M/L/G 编号；本矩阵 SEC-xx 为产品控制/测试编号）：SEC-01 ↔ C-01；SEC-02/03/07/08 ↔ C-01 + M-02；SEC-04/05/06 ↔ H-02/H-03；SEC-09 ↔ H-01；SEC-10/11 ↔ H-04/M-07；SEC-12/13 ↔ M-01/M-05/M-06；SEC-14 ↔ G-02；SEC-16 ↔ M-04/L-04；SEC-18 ↔ H-04；SEC-19 ↔ L-01；SEC-20 新增见下。

| SEC-21 | `qwaudio://connect` 深链不得无确认改网关 | R26 | ADR-0008 | ❌ | M4/M6 深链测试 | M4/M6 |
| SEC-22 | 更新通道不得残留上游 feed；只用自有签名 feed | R27 | ADR-0005 | ❌（app-update.yml 残留） | M6 供应链检查 | M6 |
| SEC-23 | 语音原文/审批内容不默认落盘；replay 仅限自身 turnId；可清理 | R28 | ADR-0007/0008 | 部分（WORKLOG/日志/SSe replay） | M4 隐私测试 | M4 |


---

## 3. 关键契约测试（M1/M3）

| CT | 契约 | 测试 | 门禁 |
|---|---|---|---|
| CT-01 | 一次用户输入 → 一个 DSH turn | T1/T2 | M1 |
| CT-02 | turnId ↔ sessionId:turn ↔ voiceTurnId 映射唯一 | T2/T8 | M1 |
| CT-03 | 终态映射：succeeded/failed/cancelled/interrupted/unknown | T4/T6 | M1 |
| CT-04 | 审批：approvalId 绑定 turn/tool/摘要/过期；重复/迟到拒绝 | T7/S5 | M1/M4 |
| CT-05 | 取消：stopSpeaking/cancelTurn/emergencyStop 三命令 | T5/T6/S1 | M1/M4 |
| CT-06 | 事件去重/顺序/重放（eventSeq） | T8 | M1/M3 |
| CT-07 | 进程崩溃/断线状态一致性 | T9/M3 故障注入 | M1/M3 |
| CT-08 | 版本握手/不兼容 fail-loud | M3 | M3 |
| CT-09 | 记忆读/写/删/导出/迁移 | M4 | M4 |
| CT-10 | `~/.dsh` 零写入 | M3 | M3 |

---

## 4. 发布门禁对应（M6/M7）

| 门禁 | 要求 | 证据 |
|---|---|---|
| REL-01 | 干净 Mac 安装→首任务 | 安装记录/截图/日志 |
| REL-02 | 升级失败可回滚 | 故障注入/回滚演练 |
| REL-03 | 卸载按用户选择保留/删除记忆 | 卸载测试/数据检查 |
| REL-04 | 签名/公证/SBOM/许可 | 产物校验/清单 |
| REL-05 | 发布/回滚/支持流程演练 | 演练记录 |
| REL-06 | 安全矩阵 P0 全过、无严重未缓解 | 安全报告/测试 |
| REL-07 | 关键旅程指标达标（基线后冻结） | 指标报告/试点 |

---

## 5. 未覆盖/待补

- 真实麦克风 TCC/真人语音（M1）；
- 审批串轮/并发（M1/M4）；
- app 级崩溃恢复（M3）；
- 记忆迁移冲突/删除召回（M4）；
- Windows/Linux 平台测试（M8）；
- 上游许可/EULA（M2/M6）。

本矩阵随阶段更新；每次新增需求/测试必须同时更新此处，否则视为文档不一致。
