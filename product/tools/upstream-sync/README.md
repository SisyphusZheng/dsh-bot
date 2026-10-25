# tools/upstream-sync — DSH 上游同步工具链

WhaleGirlBot 把「产品版本」与「DSH 运行时版本」分开管理，`versions.json` 是唯一事实来源。本目录是它的校验、发现与兼容测试工具；机制说明见 [../../docs/UPSTREAM-SYNC.md](../../docs/UPSTREAM-SYNC.md)，rc.3 实测结论见 [../../docs/reports/UPSTREAM-RC3-COMPAT.md](../../docs/reports/UPSTREAM-RC3-COMPAT.md)。

| 文件 | 作用 |
|---|---|
| `lib/manifest.mjs` | 清单加载/校验、git 只读核对、sha256、semver 比较（不写任何东西） |
| `check-versions.mjs` | 清单契约 fail-fast：字段完整性、基线 tag 对象与 commit 一致、产物 sha256、pin 与 checkout 版本一致 |
| `check-upstream.mjs` | GitHub Releases/compare API 对比 pin 与最新 release，输出变更报告；只报告不升级 |
| `compat.mjs` | 最小兼容套件：清单 + `m4/preflight.mjs` + 语音 `/health`（+ 可选 memory sidecar），输出结构化 JSON |
| `rc3-probe.mjs` | 候选运行时宿主探针：隔离 HOME/DSH_HOME 启动候选 runtime + pin 的 host-integration 插件，跑 descriptor→health→sessions/create→turn→退出，A/B 对照用 |

## 常用命令

```bash
# 发布门（严格：warning 也算失败）
node tools/upstream-sync/check-versions.mjs --strict

# 日常巡检
node tools/upstream-sync/check-versions.mjs
node tools/upstream-sync/check-upstream.mjs          # exit 10 = 上游有新版本

# 兼容套件（发布前必跑；本机只读场景可复用已记录的预检证据）
node tools/upstream-sync/compat.mjs --runs=1
node tools/upstream-sync/compat.mjs --preflight-evidence m4/evidence/PREFLIGHT-<ts>.json

# 候选运行时 A/B（不改产品基线，不动 nisse-dsh）
node tools/upstream-sync/rc3-probe.mjs --runtime-dir /tmp/dsh-rc3 \
  --plugin-root /path/to/fork/nisse/packages/host-integration --out /tmp/rc3-probe.json
```

## 退出码

| 脚本 | 0 | 1 | 2 | 3 | 4 | 10 |
|---|---|---|---|---|---|---|
| `check-versions.mjs` | PASS | 校验失败 | 用法/清单不可读 | — | — | — |
| `check-upstream.mjs` | pin 已最新 | `--fail-on-newer` 且有更新 | 用法 | API/网络失败 | — | 有更新（信息性） |
| `compat.mjs` | PASS | — | PRODUCT_FAIL | COMPAT_FAIL | ENV_FAIL | — |
| `rc3-probe.mjs` | 全部断言 PASS | — | 产品/桥接失败 | 探针/环境失败 | — | — |

## 安全边界

- 从不写 `versions.json`、不合并上游、不 push、不改 `nisse-dsh`；
- 所有宿主/语音测试使用 `/tmp` 下的隔离 `HOME`/`DSH_HOME`/随机端口，结束后校验用户私有主 DSH 目录 mtime 未变；
- 证据写入 `docs/reports/`（`compat-latest.json`、`upstream-check-latest.json`、`raw/`）。
