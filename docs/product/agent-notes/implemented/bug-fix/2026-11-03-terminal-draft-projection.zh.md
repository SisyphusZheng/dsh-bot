# Agent Note：Terminal drafts leave the confirmation projection

Status: implemented

[English](2026-11-03-terminal-draft-projection.md) | 中文

## 问题

语音草稿被拒绝、确认或过期后，会话服务仍把它作为待确认内容投影。桌宠气泡不关闭，每次快照又把它打开；再次点“丢弃”返回 409，用户被卡在丢弃动作里。

## 决策

投影只携带仍然有效的确认窗口（`pending`、`editing`、`submitting` 且未过期）；终态草稿只保留在有界历史里，不再投影。用户丢弃过的 capture，后续迟到的修订不再重新提供；回归测试同时覆盖投影与重复提供抑制。

## 考虑过的替代方案

- 每个终态命令后清空草稿：常见路径等价，但从持久化状态恢复的终态草稿仍可能漏进快照。
- 继续投影终态草稿、在桌宠侧过滤：同一规则出现两个所有者，每个新客户端都要重复过滤。

## 后果

丢弃后气泡立即关闭，迟到的 ASR 修订无法复活已丢弃的 capture。真正迟到的 final 仍会给一次性提示，因为那部分内容不能被静默丢弃。
