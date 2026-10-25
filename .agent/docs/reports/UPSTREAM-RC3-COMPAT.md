# DSH rc.3 兼容预检报告（dsh-bot v0.1）

日期：2026-10-24 20:00–20:25 (+08:00)　预检人：C 流（upstream-c）
对象：`dsh-v0.2.1-rc.3`（2026-10-23 发布，prerelease） vs 当前 pin `dsh-v0.2.1-rc.2`（2026-10-17）
结论：**条件可升级**

> 含义：rc.3 与当前产品运行时的契约**没有发现破坏性变化**，构建、host 启动、bridge、真实 turn 均通过 A/B 对照；但 rc.3 仍是 prerelease，且合并会触及 2 个 fork 文件、引入 1 个新 client 包与 LLM 供应商列表重构。因此 **v0.1.0 发布继续固定 rc.2**；rc.3 只作为候选升级窗口，满足下文 §8 前提后再按 runbook 升级，不直接改产品基线。

---

## 1. 方法与隔离边界

| 项 | 值 |
|---|---|
| 上游检出 | `git clone --depth 1 --branch dsh-v0.2.1-rc.3 https://github.com/deepseek-ai/deepseek-harness /tmp/dsh-rc3` + `git fetch --depth 1 origin tag dsh-v0.2.1-rc.2` |
| 真实对比 | `git diff dsh-v0.2.1-rc.2 HEAD`（浅克隆两棵完整树，tree diff 与历史深度无关） |
| 构建 | `pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com`（11.3s，pnpm store 预热后）→ `pnpm run build`（128.8s，9/9 gate PASS） |
| 运行环境 | macOS arm64，Node v24.18.0，pnpm 11.28.5；`/tmp` 可用 20GiB |
| 隔离 | 宿主探针使用 `/tmp/wg-rc3-boot-*` 下的独立 `HOME` / `DSH_HOME` / 随机端口；用户私有的主 DSH 目录只做 mtime 只读比对（预检前后不变，PASS），从不打开 |
| nisse-dsh | **全程只读**：未 fetch、未 commit、未改工作树；插件以符号链接方式被候选运行时加载 |
| 产品基线 | **未改动**：`versions.json`、`m4/preflight.mjs`、打包配置均未动 |

已执行验证（可复现）：

1. GitHub Releases/compare API 对比（`tools/upstream-sync/check-upstream.mjs`，exit 10 = 有更新）；
2. 独立 worktree 真实 diff 统计与 fork 冲突交集（`docs/reports/raw/`）；
3. rc.3 全量构建（`pnpm run build`，9/9 PASS）；
4. 候选运行时 A/B 宿主探针（rc.2 对照 + rc.3 候选，10 个断言全 PASS，含一次真实 turn）；
5. 清单契约校验（`check-versions.mjs`，发现 1 个真实产物指纹漂移，见 §7）。

## 2. 真实 diff 统计（对照 GitHub API）

| 指标 | GitHub compare API | 真实 worktree diff |
|---|---|---|
| commits | 6 | 6（核心 release 流程） |
| 文件 | 300（**API 上限，已截断**） | **640** |
| 行数 | +4237 / −496（仅 300 文件子集） | **+5682 / −1021** |
| 状态 | — | 50 新增 / 584 修改 / 6 重命名 |

commits：`feat(ui): add navigation entry customization (#6247)`、`feat(analytics): track navigation entries and preset selections (#6600)`、`fix(ui): separate navigation pins from selection and show menu icons (#6883)`、`feat(llm): follow the official /models listing on the DeepSeek API-key route (#6944)`、`release(dsh): 0.2.1-rc.3`、`Merge pull request #6999`。

640 个文件的构成（`raw/rc2-rc3-diffstat.json`）：

| 类别 | 文件数 | 说明 |
|---|---|---|
| `package.json` 版本号 bump | **349** | 全部为 `0.2.1-rc.2 → 0.2.1-rc.3` 单行；解释了「6 commits / 640 文件」的表象 |
| 测试快照 `snapshots/` | 71 | 文案/结构快照跟随 UI 变更 |
| client UI（`packages/client/`） | 182 | 导航入口定制、More 菜单、pin/selection 拆分、tooltip/icon |
| web 前端（`apps/web/`） | 26 | e2e 与 tsconfig |
| 文档 / `.agents` | 30 | 产品文档与 agent note |
| **服务端运行时代码** | **0** | 无 `packages/host`、`packages/session`、`packages/shell`、`packages/core`、权限/审批/workspace 源码变化 |

实质变化（非文档、非快照、非版本 bump）：

| 文件 | 变化 | 影响面 |
|---|---|---|
| `packages/api/session-controller/src/client/sessions/service.ts` | **1 行 JSDoc 注释**（`+1/−1`） | 无运行时影响；该文件属 api 包的 client 侧 |
| `packages/bundle/web-app/cordis.patch.yml` | **+5 行**：注册新 bundle `entry-customization` | 产物多一个 client 插件（新包 `packages/client/ui-entry-customization`，16 文件、+623 行） |
| `packages/extensions/cordis-client-runner/src/client/{api-catalog,slot-catalog}.ts`、`packages/extensions/tool-cordis/src/api-catalog.ts` | +188/−26 等 | client 扩展点目录（slot/API 目录），与服务端插件无关 |
| `packages/llm/llm-deepseek*/src/*` | **+~350/−~120**：listing 重构，account 侧 `resolve-catalog/catalog/listing` 迁入 `llm-deepseek` 共享传输；新增 `listing-config.ts`；API-key 路由文档改为 `modelOverrides` | **唯一实质风险点**：若产品使用 DSH 的 DeepSeek API-key 路由，配置面语义有变（`models` → `modelOverrides`）；当前产品 LLM 走 `llm-pi-ai` 的 `opencode-go` 路由，不依赖该重构 |
| 构建配置 | `tsconfig.host/client/base.json`、`vitest.config.ts`、`pnpm-lock.yaml`、`scripts/test-official-listing-guard.ts` 等 | 构建/测试面，已由全量构建验证 |

> 修正既有只读结论：rc.2→rc.3 并非「300 文件」，那是 GitHub compare API 上限；真实为 **640** 文件，其中 349 个是版本号 bump。服务端真实源码变化仍只有 session-controller 的 1 行 JSDoc；但 **`packages/llm/llm-deepseek*` 的 listing 重构是此前结论漏掉的真实代码变化**。

## 3. fork 冲突文件（45 commits vs rc.3）

fork 自 rc.2 起改动 62 个文件；与 rc.3 改动交集 **仅 2 个**（`raw/conflict-candidates.json`）：

| 文件 | fork 侧 | rc.3 侧 | 冲突性质 / 处理 |
|---|---|---|---|
| `apps/desktop/package.json` | 产品版本分离：manifest 为产品版本 `0.1.0`，runtime 从根 `package.json` 读取（`d7ae1b7b3e`） | 版本 bump 为 `0.2.1-rc.3` | **良性**：合入时保留 fork 的产品版本写法，运行时版本随根 `package.json` 变 `0.2.1-rc.3` |
| `packages/client/ui-conversation/src/client/locales.ts` | 品牌文案（dsh-bot） | 新增/调整 UI 文案键 | **内容冲突**：逐键合并，品牌文案优先；该文件是 rc.3 新增 UI slot 文案的主要落点 |

语义风险（不冲突但需回归）：rc.3 大量改动 `packages/client/ui-conversation` 的 contract/slots/input 与 skeleton；fork 的 11 个 client 改动（品牌/登录禁用/标题）只碰了其中 `locales.ts`，但 fork 的 `apps/web` 品牌补丁与 rc.3 的 web e2e/tsconfig 改动需在候选包中回归（导航入口、More 菜单、新会话草稿修复）。`packages/bundle/web-app/cordis.patch.yml` fork 未改，可干净应用，但新增的 `ui-entry-customization` 必须进入候选包的 web 构建与体积预算复核。

## 4. host-integration 依赖的 API 变化评估

`nisse-host-integration 0.1.0`（`lib/index.js`，`inject = ['agents','permissionPresets','approval']`）依赖面核对（`raw/api-surface-check.json`）：

| 依赖点 | 提供方 | rc.3 变化 | 风险 |
|---|---|---|---|
| `ctx.agents.create()` / `resume()` | DSH host agents 服务 | 无源码变化 | 低 |
| `agent.followup(message)` / `agent.cancel({kind:'user'})` | agent handle | 无源码变化 | 低 |
| `ctx.permissionPresets`（`bot-outside-write` 预设表） | `dsh-permission-presets` | 无源码变化 | 低 |
| `ctx.approval`（审批瀑布） | approval 服务 | 无源码变化 | 低 |
| `ctx.get('workspaceRegistry')` | workspace registry | 无源码变化 | 低 |
| `createUserMessage()`（`packages/llm/llm/lib/index.js` 绝对路径导入） | llm 包的官方构造器 | `packages/llm/llm` 仅 `package.json` 版本 bump，构造器与导出未变 | 低 |
| `session/event`、`agent/assistant-stream` 事件名 | DSH session/agent 事件 | 无源码变化 | 低 |
| 插件加载路径（profile 符号链接 + `NISSE_DSH_LLM_ENTRY`） | 打包/安装脚本 | 无变化；候选运行时同样可加载 | 低 |

结论：**host-integration 契约在 rc.3 上无需修改**，并由 §6 的 A/B 实测直接验证（同一份插件二进制同时跑在 rc.2 与 rc.3 上）。

## 5. 构建可行性（已实测 PASS）

| 步骤 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| 依赖安装 | `pnpm install --frozen-lockfile`（npmmirror，network-concurrency=16） | PASS（lockfile 未变，新增 workspace 包链接已提交） | 11.3s（pnpm store 预热后；全新约 24s） |
| 全量构建 | `pnpm run build` | **9/9 gate PASS**：native addon 1.0s、host compiler 30.8s、Host bundle 10.6s、Desktop bundle 1.9s、client compiler 42.0s、Client bundle 16.2s、Web build 12.8s、host aggregate 80.4s、client aggregate 42.5s | **128.8s**（`real 2m13.7s`） |
| 产物 | `apps/cli/lib/bin.js`、`packages/llm/llm/lib/index.js` | 存在，可直接启动 | — |

补充：rc.3 的 `apps/desktop` 只有版本 bump，未做 Electron 打包/签名验证（不在本次预检范围；候选包阶段必须重跑 `package:desktop:mac:arm64:unsigned` 与安装/TCC 检查）。构建只写 `lib/`、`node_modules/`，未改动被跟踪源码。

## 6. 兼容实测（A/B，同一探针、同一插件二进制）

探针做的正是产品依赖的契约（`tools/upstream-sync/rc3-probe.mjs`，无外部网络：模型用候选仓库自带的 mock LLM，`anthropic-messages` 协议）：

| 断言 | rc.2（pin，对照） | rc.3（候选） |
|---|---|---|
| 候选构建存在 | PASS | PASS |
| 隔离 profile 安装 + 插件符号链接 | PASS | PASS |
| bridge descriptor 出现 | PASS（1113ms） | PASS（1315ms） |
| `/health` 且 `agent.ready=true` | PASS（1388ms） | PASS（1647ms） |
| `POST /sessions/create` 200 且 sessionId 与 health 一致 | PASS | PASS |
| `POST /turn` 200 | PASS | PASS |
| turn 事件流：`turn.started` → 4× `turn.delta` → `turn.settled(idle)` | PASS，0 error | PASS，0 error |
| 助手文本经 bridge 流式返回 | `rc.3 bridge probe OK.`（3 段 delta） | 同左 |
| SIGTERM 优雅退出 | PASS | PASS |
| descriptor 退出后移除 | PASS | PASS |
| 私有主 DSH 目录未被触碰（mtime） | PASS | PASS |

10/10 断言在 rc.2 与 rc.3 上完全一致 → **未观察到 host-integration 方言回归**。证据：`docs/reports/raw/rc3-host-probe.json`、`raw/rc2-host-probe-control.json`。

## 7. 风险与已知偏差

| # | 事项 | 级别 | 处置 |
|---|---|---|---|
| 1 | rc.3 是 prerelease（`-rc.3`），无稳定版 | 中 | 只作候选；v0.1.0 固定 rc.2 |
| 2 | `packages/llm/llm-deepseek*` listing 重构改变 API-key 路由配置面（`models`→`modelOverrides`、共享传输缓存） | 中 | 升级时核对 Bot 设置页 LLM provider 选项与「未配置真实状态」验收；当前用 pi-ai `opencode-go` 路由，无直接依赖 |
| 3 | 新增 client 包 `ui-entry-customization`（16 文件/+623 行）与导航入口扩展 | 低 | 候选包回归导航/More 菜单/新会话草稿；复核 web 产物体积 |
| 4 | 合并冲突 2 个（桌面 manifest、locales） | 低 | 按 §3 处理，冲突范围可控 |
| 5 | **产物指纹漂移**：`versions.json` 记录 `c082d6fb…`（19:49 构建），20:09 后 DMG 被反复重建（实测 `3d87aaf…` → `611ae8de…` → `173ea23b…`），`check-versions.mjs` 因此 FAIL | **高（发布门）** | A 流冻结最终产物后重算 sha256 并更新 manifest；冻结前不要引用旧指纹 |
| 9 | **fork 距离漂移**：预检期间 `nisse-dsh` HEAD 前进到 `4cd8dc129a`（46 commits），manifest 仍记 45；校验器 FAIL | 中 | 冻结时重算 `forkCommitsAheadOfBase` 与 `postBaselineCommits`，由 Lead 批准更新 manifest |
| 6 | `versions.json` 缺 `rollback` 块 | 中 | 按 `docs/UPSTREAM-SYNC.md` §5 补 `previousTestedVersion`/`artifact`/`dataSnapshot` |
| 7 | 语音 worker SIGTERM 后 PyInstaller bootloader 进程残留（端口已释放），本次 compat 用 SIGKILL 收尾 | 低 | 归 A 流打包项：确认 worker 由 supervisor 托管时能整组退出 |
| 8 | m4 预检证据中「按文件名最新」的是失败注入记录（`PRODUCT_FAIL`） | 低 | 引用预检证据按 `ok:true` 选择；本次使用 `PREFLIGHT-2026-10-24T11-24-10.583Z.json`（runs=3 PASS） |

## 8. 升级前提（满足后才进入升级）

1. 上游发布 `dsh-v0.2.1` 稳定版或明确 rc.3 为发布候选（当前为 prerelease）；
2. 在 `/tmp` worktree 合入 fork，解决 §3 的 2 个冲突，`pnpm run build` 9/9 PASS；
3. `compat.mjs --runs=3` 全绿（含真实 preflight，而非 recorded）；
4. `rc3-probe` 在合并后的 fork 上 A/B 通过（宿主、turn、descriptor、退出语义）；
5. 候选 DMG 打包 + 安装/TCC 检查 + `git status` 前后一致 + 产物 sha256 回填 manifest；
6. Lead 人工批准后，才允许更新 `versions.json` 的 `runtime.dsh`/`source.forkBaseTag`/`forkCommitsAheadOfBase` 并进入发布。

## 9. 升级 runbook（不推送）

```bash
# 1) 候选 worktree（绝不改主基线 nisse-dsh）
git -C /path/to/dsh-fork worktree add /tmp/wg-upgrade-rc3 -b cand/rc3 <baseline-commit>
# 2) 合入上游候选（同一仓库 upstream remote 已配置；不 push）
cd /tmp/wg-upgrade-rc3 && git fetch upstream tag dsh-v0.2.1-rc.3
git merge dsh-v0.2.1-rc.3        # 解决 apps/desktop/package.json + locales.ts
# 3) 构建 + 兼容
pnpm install --frozen-lockfile && pnpm run build
node tools/upstream-sync/compat.mjs --runs=3
node tools/upstream-sync/rc3-probe.mjs --runtime-dir /tmp/wg-upgrade-rc3 \
  --plugin-root /path/to/dsh-fork/nisse/packages/host-integration --out /tmp/rc3-merged-probe.json
# 4) 候选包（内部 unsigned，不发布）
pnpm run package:desktop:mac:arm64:unsigned
# 5) 产物指纹 + 证据，提人工批准；批准后才改 versions.json 并发布
```

## 10. 回滚 runbook 与限制

1. 数据快照：升级前复制 `<userData>/dsh-home`（含 sessions/workspace/config）到带版本号的快照目录；
2. 上一版 app：保留当前 `whalegirlbot-0.1.0-mac-arm64-unsigned.dmg` 与其 sha256；
3. 回滚 = 退出 app → 恢复快照 → 安装上一版 DMG → `compat.mjs --no-write` 冒烟（manifest 指向旧产物时需同时回退 `versions.json`，由 Lead 批准）；
4. 限制：内部 unsigned/ad-hoc，无 Developer ID 与公证；自动更新为 `DEFERRED-EXTERNAL`（仅本地 feed 演练），**不能承诺线上原子回滚**；若 `dataFormatVersion` 已升级，只降级 app 会导致数据不可读，必须快照恢复；
5. 回滚后必须重跑 `check-versions.mjs`（产物+版本一致）与 `compat.mjs`（三项门全绿）才可再次发布。

## 11. 证据文件

| 路径 | 内容 |
|---|---|
| `docs/reports/raw/rc2-rc3-diffstat.json` | 真实 diff 统计、构成、GitHub compare 对照 |
| `docs/reports/raw/check-versions-drift.txt` / `check-versions-nohash.txt` | 清单契约校验实测（含两处漂移） |
| `docs/reports/raw/compat-manifest-drift.json` | compat 在产物指纹漂移时的 FAIL 证据 |
| `docs/reports/raw/rc3-build-summary.json` | rc.3 构建 9/9 gate 明细 |
| `docs/reports/raw/rc2-rc3-changed-files.txt` | 640 个文件的 name-status 全量清单 |
| `docs/reports/raw/fork-changed-files.txt` | fork 相对 rc.2 的 62 个改动文件 |
| `docs/reports/raw/conflict-candidates.json` | 冲突交集（2 个） |
| `docs/reports/raw/api-surface-check.json` | host-integration 依赖面逐项核对 |
| `docs/reports/raw/rc3-host-probe.json` | rc.3 A/B 宿主探针完整结果（10 断言） |
| `docs/reports/raw/rc2-host-probe-control.json` | rc.2 对照结果 |
| `docs/reports/upstream-check-latest.json` | 上游检测证据（pin vs rc.3） |
| `docs/reports/compat-latest.json` | 兼容套件证据（manifest/preflight/voice） |
| `docs/reports/raw/compat-*-voice.log` | 语音门日志（本次 preflight 用 recorded 证据，见 compat-latest.json 的 `preflight.mode`） |
