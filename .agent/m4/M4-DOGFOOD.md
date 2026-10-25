# M4 7 天 Dogfood 记录表（需要用户执行）

> 目标：连续 7 天真实使用，≥20 次成功语音任务，无 P0 事故；用于 M4 正式退出。
> 启动（2026-10-22 W13 更新）：旧 M3 原型入口 `m3/shell/run-real.sh` **已随 `m3/shell` 删除**；
> 真机语音 dogfood 的入口改为产品桌面 App（DSH fork `nisse-dsh/apps/desktop` + Body Runtime）；
> 本地启动器可能为 `m3/pet/open-dsh.sh`（由 body-runtime/Lead 维护，本报告**未验证**其语音可用性）。
> 在 Lead 给出经确认的可复跑命令前，本表不可开始计时。
> 历史日志位置（已不再产生新日志）：`/tmp/nisse-m3-shell-real-run.log`；
> 历史 Host Integration audit：`/tmp/nisse-m3-shell-real/dsh-home/nisse/audit.jsonl`。
> 当前真机语音验收状态见 `AUDIT-2026-10-22-PM.md` §5（UNVERIFIED，等待用户麦克风/TCC）。

## 每日记录（用户填写或让 Lead 读日志汇总）

| 日期 | 成功语音任务数 | 失败/异常 | 是否打断/审批 | 备注 |
|---|---|---|---|---|
| Day 1 |  |  |  |  |
| Day 2 |  |  |  |  |
| Day 3 |  |  |  |  |
| Day 4 |  |  |  |  |
| Day 5 |  |  |  |  |
| Day 6 |  |  |  |  |
| Day 7 |  |  |  |  |

## 判定
- 7 天累计 ≥20 次成功语音任务；无 P0（错误审批、取消后仍执行、数据丢失、假执行）；
- 每天失败任务可复盘；P1/P2 记录不阻塞；
- 达成后由 Lead 归档 `m4-report.md` 并在 ROADMAP 标记 M4 退出。
