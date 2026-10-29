# Host 集成

[English](README.md) | 中文

DSH 负责 Agent、Session、工具、审批和结构化问题。本产品适配器提供有鉴权的本地操作，并将官方交互同步给桌宠。

Node 入口为 `lib/index.js`。浏览器源码为 `src/client/index.js`；Desktop 的 bundle 步骤使用官方 `packages/client/tsdown.client.ts` 预设构建 `lib/client.js`。浏览器导出是通过 `window.__ModuleLoader__` 注册闭包工厂的 classic script，不能包含裸 ESM export。现有 Host Loader 行和 `dsh.client` 清单元数据会自动发现它；不存在名为 `dsh.client` 的插件。

导航订阅官方 Session 列表，只有列表包含桌宠所请求的最新 Session 时才打开它。缓存的 preload 请求可能早于初始快照到达，不得导致插件激活失败。两个订阅属于同一个 effect，卸载时一并移除。

构建：`node apps/desktop/scripts/build-pet-client.mjs`。源码测试：`node --test nisse/packages/host-integration/tests/*.test.mjs`。产物激活：`pnpm exec vitest run apps/desktop/tests/host-client-bundle.spec.ts`。生产构建后，安装 Playwright Chromium 或设置 `DSH_CHROMIUM_EXECUTABLE`，再运行 `node product/tools/smoke-host.mjs --web` 验证完整生产 UI 及旧格式负对照。该浏览器测试中只有 Electron preload 回调是夹具；Host、模块加载器、UI 和 Session 选择均真实运行。

原生打包启动和退出仍由 `bash product/tools/accept-macos.sh <new.dmg>` 验收。Provider 凭据、真实音频和真实 Hindsight 数据库需要各自的运行时验收；Mock Provider 和 HTTP 夹具结果不能代替。

任务恢复通过只读句柄读取官方持久化 Session。先给出有有效期的预览，再要求明确确认，才将检查后继续或重新提交作为新的用户指令。任务仍在运行、Session 历史已变化、预览过期和重复提交均被拒绝。适配器不自行重放工具调用。

取消请求与 Agent 已确认空闲分别记录，超时不会合成空闲状态。语音终态事件在已知时携带取消来源。Bridge 失败包含诊断 ID、异常类型和任务身份；执行结果未知时保持隔离，直到权威任务状态确认结果。
