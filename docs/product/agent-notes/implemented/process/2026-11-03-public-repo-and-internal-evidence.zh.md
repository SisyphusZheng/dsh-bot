# Agent Note：Public repository keeps decisions, not audit evidence

Status: implemented

[English](2026-11-03-public-repo-and-internal-evidence.md) | 中文

## 问题

收尾周期在代码旁边产出了审计、验收与 UAT 记录。这些内容包含本机路径、真实库操作与个人验收事实，不应公开；而先在公开分支加入、之后再删除，历史里仍然会暴露它们。

## 决策

公开仓库只承载产品决策与不含证据的文档；内部 `review/` 证据归档在本地隐藏目录（git 忽略），永不提交。产品决策按上游 `.agents/notes` 的约定，以 Agent Notes 形式发布到 `product/agent-notes/`。公开分支以公开基线之上的 squash 快照发布，内部记录不会留在它的历史里。

## 考虑过的替代方案

- 先提交证据、之后再删除：内容仍留在公开历史。
- 发布完整本地历史、依赖私有归档：历史同样会泄露这些记录。
- 把产品决策放进上游 `.agents/notes`：产品与上游来源混在一起，增加同步复杂度。

## 后果

公开树不含 review、可复现；内部归档保留原始证据供审计。更新公开分支需要生成新的 squash 快照并 force-with-lease，在它仍是产品快照而非协作分支期间可以接受。
