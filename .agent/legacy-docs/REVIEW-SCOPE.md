# M0 评审包范围说明（2026-10-21）

- **当前事实/架构/路线**：以本包根目录 `README-FOR-REVIEW.md`、`M0-FACT-BASE.md`、`assistant/PRODUCT-DEFINITION.md`、`research/*.md`、`ADR/`、`ROADMAP-M0-TO-1.0.md`、`SPIKE-DSH-VOICE-INTEGRATION.md` 为准。
- **历史资产**：`assistant/archive/`、`research/archive/` 为 superseded 原稿（只作审计追踪）；`02-dsh-nisse/`、`03-client-nisse-fork/`、`04-reports/` 是 2026-10-21 旧包中的原型代码/报告，**不是最终产品形态**；其中 `dsh-nisse` 已明确退役为迁移参考，不代表当前架构。
- **证据**：`review/evidence-*.md` 为本次 M0 取证（DSH 安装包源码、真机/产物、安全、Qwen、文档）；`M0-CHANGES.diff` 记录旧稿→新稿变更。
- **未包含**：完整 DSH 上游仓库、Qwen 上游完整仓库之外的版本历史、node_modules、构建产物、DMG、真实凭据、完整 5.3MB 二进制 patch。
- **评审目标**：确认 M0 事实/裁决/门禁是否足以批准 M1；不要按旧包的五引擎架构评审。
