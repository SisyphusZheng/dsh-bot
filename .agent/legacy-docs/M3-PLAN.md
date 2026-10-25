# M3 计划：一体化 Runtime、Shell 与 Product Contract

> 状态：**计划内工作包完成（prototype 级，2026-10-21）**｜前置：M2 PASS（baseline）；M1 集成层结论/证据；M3-M4-DESIGN-INPUTS。
> 总结：见 [m3/M3-FINAL-REPORT.md](m3/M3-FINAL-REPORT.md)。
> 目标：一个 App（Nisse.app）启动/监督 DSH Host + Voice Runtime，完成语音任务，不依赖用户 DSH；产品状态机/契约可测；
> **不改 DSH 核心**（Route A 冻结）；Host Integration 是随包第一方 bundle。

## 1. 责任边界（不变）

- DSH Host：唯一 Agent（session/turn/tool/approval/cancel/最终回复/compaction）；
- Host Integration：DSH 内第一方 bundle；turn/事件/审批/取消映射、Bot 编排、Hindsight Adapter、产品状态投影；
- Voice Runtime：独立子进程，只做音频 I/O（设备/TCC/VAD/唤醒/ASR/TTS/打断/回声），无执行权；
- Electron Shell/Product layer：Supervisor、窗口/托盘/TCC、状态机、审批/记忆/人格 UX；
- Hindsight：Nisse 管理的本地 memory runtime（M1-C 结论/条件）；旧文件工作区仅迁移/导出。

## 2. 工作包（顺序）

| # | 工作包 | 产物 | 验收 |
|---|---|---|---|
| M3-1 | Supervisor 原型 | `m3/supervisor/`：启动 DSH Host（隔离 DSH_HOME + Nisse profile）；health；单实例；退出清理；崩溃重启；孤儿回收 | 启动/健康/kill-restart/停止后无孤儿；不写用户 `~/.dsh` |
| M3-2 | Product Contract v0 | `m3/contract/`：IDs/状态/命令/事件/错误 schema + validator + 契约测试（对齐 ADR-0008） | schema 校验通过；非法状态/事件被拒 |
| M3-3 | Host Integration v0（替换 placeholder） | fork `nisse/packages/host-integration/`：版本握手、session 创建/恢复、turn/事件转产品契约、approval/cancel 映射；health；fail-closed | profile 内加载；文本 turn 走通；DSH 不可用 fail-closed；无 core 改动 |
| M3-4 | Voice Runtime 子进程边界 | voice stub/IPC 协议 + 设备所有权/TCC 说明；Supervisor 生命周期管理 | 启动/崩溃重启/不抢占已装 App；音频 I/O 接口契约 |
| M3-5 | 产品层最小状态机 | idle/listening/thinking/working/waiting-approval/speaking/error + UI 接入点 | 状态转换与事件一致；无假状态 |
| M3-6 | 故障注入/恢复 | kill DSH/voice、断网、重启；日志/审计；孤儿检查 | 全部场景可恢复/fail-closed；无孤儿；TCC 记录 |

## 3. 里程碑与前置

- M3 Gate：M2 PASS + M1 Go/Conditional 已记录；
- 不在 M3 做：完整 MVP UI、记忆迁移、安装器/签名/更新（M4/M5/M6）、Windows/Linux（M8）；
- 关键决策输入：`M3-M4-DESIGN-INPUTS.md`、`BOT-SESSION-ORCHESTRATION.md`、`MEMORY-SERVICE-SPEC.md`、`M3-REQUIREMENTS-BOT-MEMORY.md`。

## 4. 当前进展

- [x] M3 计划（本文件）
- [x] M3-1 Supervisor 原型（`m3/supervisor/`；start/singleton/crash-restart/stop 全 PASS）
- [x] M3-2 Product Contract v0（7 状态/20 命令/16 事件/12 错误；契约测试 8/8）
- [ ] M3-3 Host Integration v0
- [ ] M3-4 Voice Runtime 边界
- [x] M3-5 产品状态机（7 状态、合法转换；6/6 PASS；UI 接入留 M4）
- [x] M3-6 故障注入/恢复（DSH/Voice 双进程 crash/restart/fail-closed/无孤儿；5/5 PASS）
