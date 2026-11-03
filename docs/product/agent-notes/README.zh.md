# 产品 Agent Notes

[English](README.md) | 中文

本目录把上游 `.agents/notes` 的归纳约定镜像到 **产品自有** 的决策记录上。它是镜像目录，不是上游门禁里的第二棵 notes 树：上游 Agent Notes 仍放在 `.agents/notes/`，产品决策放这里，避免同步上游时混入不同来源。

- 路径：`{生命周期}/{类别}/yyyy-mm-dd-主题.md`；生命周期为 `implemented`、`proposed` 或 `rejected`；类别为 `architecture`、`bug-fix`、`feature`、`process`、`simplification`、`testing`。
- 每篇是中英双语三件套：`.md`、`.zh.md`，以及 `pnpm run verify-translation-pairing --write <note>.md` 生成的 `.i18n.yaml`。
- 一条决策一篇：问题、决策、考虑过的替代方案、后果。事实随已发布实现更新；推翻决策需要新 Note 并互相链接。
- **审计与验收证据不放在这里。** 安全审查、UAT 记录、产物身份、日志与截图留在本地不公开的 `.agent/review/` 归档；本目录面向公开发布。
