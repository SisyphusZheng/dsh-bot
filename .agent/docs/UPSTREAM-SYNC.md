# DSH 上游同步与发布机制（dsh-bot v0.1）

状态：v1（2026-10-24）。适用对象：dsh-bot 产品（`nisse/`）与 DSH fork（`nisse-dsh/`，只读上游）。
本文只描述**机制**；rc.3 的实测结论见 [UPSTREAM-RC3-COMPAT.md](reports/UPSTREAM-RC3-COMPAT.md)。

## 1. 双版本 manifest

`versions.json`（项目根）是**唯一版本事实来源**，产品版本与 DSH 运行时版本相互独立：

| 字段 | 当前值 | 说明 |
|---|---|---|
| `product.version` | `0.1.0` | dsh-bot 产品版本（Electron `app.getVersion()`） |
| `product.dataFormatVersion` | `1` | 用户数据格式；升级数据结构必须同步迁移脚本 |
| `source.baselineTag` / `baselineTagObject` / `baselineCommit` | `wg-v0.1-baseline.1` = 231f17d2d6 → d521e6579d | 产品基线（annotated tag 对象与解引用 commit 分开记录） |
| `source.postBaselineCommits` | `142552179d`、`d7ae1b7b3e` | 基线后的已验收修复（host single-flight、打包版本分离） |
| `source.forkBaseTag` / `forkCommitsAheadOfBase` | `dsh-v0.2.1-rc.2` / 45 | fork 相对上游 pin 的距离（只读核对，不用于自动升级） |
| `runtime.dsh.version` / `upstreamTag` | `0.2.1-rc.2` / `dsh-v0.2.1-rc.2` | 打包进产物、不可热切换的运行时 |
| `runtime.hostIntegration.*` | `nisse-host-integration 0.1.0`、contract `v0`、bridge `dsh-nisse-subset-v0` | 双向桥接契约 |
| `runtime.g2Bridge.*` | `whalegirl-g2-bridge 0.0.1` | 语音/UI → DSH 网关插件 |
| `runtime.voice.*` | Pipecat 1.13.0 / aiortc 1.15.0 / av 17.1.0 | 语音 worker 栈（PyInstaller onedir） |
| `runtime.memory.*` | Hindsight 1.0.0 + adapter 0.1.0 | 随包内置、异步启动 |
| `artifacts.<name>` | dmg 文件名、绝对路径、sha256、构建 commit、app/runtime 版本 | 发布产物指纹；**必须与最后一次构建一致** |
| `update.*` | `github-releases`、本地 feed 演练 | 签名/公证前标记 `DEFERRED-EXTERNAL` |

规则：

1. **构建/打包先读 manifest，不一致即失败**（版本、runtime、产物指纹三层都要对上）。
2. 修改 `versions.json` 属于发布决策，必须由 Lead 批准；任何自动化都不写它。
3. `artifacts.<name>.sha256` 只有在**产物冻结后**才写入；重建产物必须重新计算并原子更新（现有 v0.1 记录已发生过两次漂移，见 §6）。

## 2. 变更检测（不自动升级）

```bash
node tools/upstream-sync/check-versions.mjs          # 清单/基线/tag/产物/运行时一致性，失败 exit 1
node tools/upstream-sync/check-upstream.mjs          # 上游最新 release vs pin，输出变更报告
```

- `check-versions.mjs`：校验 product / runtime / bridge / voice / memory 字段完整性；用只读 git 交叉核对 `wg-v0.1-baseline.1` 的 tag 对象、解引用 commit、HEAD 祖先关系、fork 距离、post-baseline commit；核对产物 sha256（文件存在时逐字节校验）；`--strict` 把 warning 升级为失败（发布门）。退出码：0 PASS / 1 校验失败 / 2 用法或清单不可读。
- `check-upstream.mjs`：读 manifest 的 pin，调 GitHub Releases API 对比最新 `dsh-v*` release，输出 tag、发布日期、commit 列表、文件统计、触及包排行和「服务端源码候选」清单；证据 JSON 写 `docs/reports/upstream-check-latest.json`。退出码：0 pin 已最新 / 10 有新版本（信息性） / 1 有新版本且 `--fail-on-newer` / 2 用法 / 3 API 失败。**它只报告，不升级、不推送、不改 manifest。**
- 注意：GitHub compare API 的文件列表上限 300 个（`files.length >= 300` 时必须用独立 worktree 的真实 diff 复核，rc.3 真实为 **640** 个文件）。

## 3. 兼容测试（候选运行时/插件/语音变更的必跑门）

```bash
node tools/upstream-sync/compat.mjs --runs=1
```

| 门 | 内容 | 失败含义 |
|---|---|---|
| `manifest` | `versions.json` 契约校验（含 tag/commit/产物指纹/运行时一致性） | 产品版本事实被污染，禁止发布 |
| `preflight` | `m4/preflight.mjs --runs=1`：并发 `/sessions/create` 单飞、agent ready 语义、单次插件加载、teardown 顺序；隔离 HOME/DSH_HOME/端口 | `PRODUCT_FAIL=2` 产品缺陷；`COMPAT_FAIL=3` 预检自身异常；`ENV_FAIL=4` 环境 |
| `voice-worker` | 启动 PyInstaller `VoiceWorker`（隔离端口/隔离 HOME），`GET /health` 必须 `ok:true`、`pipecat` 版本符合 manifest；停止后端口释放 | 语音链路不可用 |
| `memory-sidecar` | 仅在传 `--memory-url` 时检查（记忆服务启动归记忆流） | 记忆链路不可用 |

结构化证据：`docs/reports/compat-<ts>.json` + 稳定指针 `docs/reports/compat-latest.json`；日志在 `docs/reports/raw/`。
只读主机/候选 worktree 场景可用 `--preflight-evidence <m4/evidence/PREFLIGHT-*.json>` 复用已记录的预检结果（`mode: recorded`），或用 `--skip-preflight` 显式跳过——跳过会以 `SKIP` 记录，不视为通过。
退出码与 m4 预检一致：0 PASS / 2 PRODUCT_FAIL / 3 COMPAT_FAIL / 4 ENV_FAIL。

## 4. 人工批准门（升级流程）

```
检测（check-upstream）
  → /tmp 独立 worktree 检出候选 tag（禁止动 nisse-dsh 基线）
  → 候选构建（pnpm install --frozen-lockfile + pnpm run build）
  → 兼容探针（tools/upstream-sync/rc3-probe.mjs：host boot + bridge + turn，A/B 对照 pin）
  → 合并评估（真实 diff、fork 冲突文件、host-integration API 变化）
  → 升级决策（Lead 人工批准）→ 更新 versions.json 的 pin 与基线
  → 候选包（内部 unsigned）→ compat.mjs 全绿 → 人工批准发布
```

硬性规则：

- **不自动合并、不自动改 pin、不推送远端**（`nisse-dsh` 只读；worktree 只建在 `/tmp`）。
- 升级候选必须先通过 `compat.mjs` 与 rc3-probe 的 A/B 对照，再进入打包。
- 打包候选包后必须复核：`git status --porcelain` 打包前后一致、产物 sha256 回填 manifest、`compat.mjs` 对该候选包再跑一次。
- 上游处于 prerelease（`-rc.N`）时，只允许作为候选分支预检，不允许直接进入对外发布。

## 5. 回滚限制

- 回滚 = 上一版 app（manifest `artifacts`/`rollback` 记录的产物）+ 匹配数据快照；**`dataFormatVersion` 升级后不能只靠降级 app 回滚**，必须用快照恢复，否则用户数据不可读。
- 当前 v0.1：内部 unsigned/ad-hoc 构建，DMG 无 Developer ID；自动更新标记 `DEFERRED-EXTERNAL`，仅在本地 feed 演练，不承诺线上原子回滚。
- 建议在 manifest 增加 `rollback` 块（v0.1 尚未写入，`check-versions --strict` 会因此失败）：

```json
"rollback": {
  "previousTestedVersion": "0.1.0",
  "artifact": "whalegirlbot-0.1.0-mac-arm64-unsigned.dmg",
  "dataSnapshot": "userData/dsh-home snapshot taken before upgrade"
}
```

## 6. 当前已知偏差（2026-10-24）

1. `artifacts.unsignedInternal.sha256` 记录的是 19:49 构建；DMG 在 20:09 及之后被反复重建（`3d87aaf…` → `611ae8de…` → `173ea23b…`），`check-versions.mjs` 因此 FAIL → **产物冻结后必须重算并更新 manifest**。
2. `source.forkCommitsAheadOfBase` 记录 45，但 `nisse-dsh` HEAD 已前进到 `4cd8dc129a`（46），校验器 FAIL；冻结时需重算 `forkCommitsAheadOfBase` 与 `postBaselineCommits`。
3. `rollback` 块缺失（`--strict` 报错，默认只 WARN）。
4. `PRODUCT-RUNTIME-VERSION-CONTRACT.md` 写「+44 commits」，实际 `git rev-list --count dsh-v0.2.1-rc.2..HEAD` = **45**（以 manifest 与校验器为准）。
5. `m4/evidence/` 中按文件名最新的一份 PREFLIGHT 是失败注入记录（`PREFLIGHT-2026-10-24T11-24-56Z`，`PRODUCT_FAIL`），通过记录是更早的两份（`ok:true`）；引用预检证据时要按内容而非 mtime 选。

## 7. 命令速查

| 目的 | 命令 |
|---|---|
| 校验清单 | `node tools/upstream-sync/check-versions.mjs`（发布门加 `--strict`） |
| 发现上游更新 | `node tools/upstream-sync/check-upstream.mjs` |
| 兼容套件 | `node tools/upstream-sync/compat.mjs --runs=1` |
| 候选运行时探针 | `node tools/upstream-sync/rc3-probe.mjs --runtime-dir /tmp/dsh-rc3 --label rc.3` |
| 证据 | `docs/reports/compat-latest.json`、`docs/reports/upstream-check-latest.json`、`docs/reports/raw/` |
