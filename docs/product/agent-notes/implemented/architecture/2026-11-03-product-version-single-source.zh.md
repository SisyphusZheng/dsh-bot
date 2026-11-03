# Agent Note：One product and runtime version identity

Status: implemented

[English](2026-11-03-product-version-single-source.md) | 中文

## 问题

产品版本和内嵌 Runtime 版本被复制在多处，可能悄悄漂移；打包变化后 Host 仍可能报告旧版本。

## 决策

桌面壳是运行期版本的唯一来源：在 Host 的 spawn 环境里注入 `app.getVersion()` 与 Runtime manifest 版本；Host 缺少身份时报 `unknown`，而不是回退到旧的版本字面量。守卫测试禁止声明的产品版本以字面量出现在 Host bundle 里，`dev-doctor` 把版本漂移视为失败。

## 考虑过的替代方案

- 每个包保留版本字面量、人工核对：正是这次发生漂移的原因。
- 只从打包后的 manifest 推导版本：对 App 可行，但源码启动与测试不适用。

## 后果

版本事实来自打包产物或显式环境值。发布时漏改版本会先被门禁拦下，而不是带着混合身份发出去。
