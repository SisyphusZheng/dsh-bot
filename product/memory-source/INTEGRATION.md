# WhaleGirl Bot 内置长期记忆（Hindsight）集成契约 v1

状态：R1 已裁决「随包内置 + 异步启动」；本文件是 **B 流（记忆产品化）交给 A 流（Mac 交付）的唯一打包/启动契约**。
暂存根：`/tmp/wg-memory-staging/`（由 B 流生成并离线验证通过，见 `EVIDENCE.json`）。
目标仓库位置：`nisse/product/memory/**`（A 流按 `COPY-MANIFEST.txt` 复制，不修改内容）。

## 0. 不变量

1. 记忆主链路（语音/对话/工具）**不得被记忆运行时阻塞**；记忆未就绪时如实显示「记忆准备中」，不得假报健康、不得宣称「已记住」。
2. 模型、PostgreSQL、Python 运行时、Node 适配器全部随包；**首启不得隐式下载任何关键资源**。
3. 记忆进程只绑定 `127.0.0.1`；用户真实 HOME 与 DSH home 不得被记忆进程读写（wrapper 用 `HOME` + `CFFIXED_USER_HOME` + `TMPDIR` + `XDG_*` 隔离到数据目录）。
4. 失败必须 fail-soft：记忆不可用时 Bot 继续工作，设置页可见具体原因和日志路径。
5. 打包输入 = 本暂存目录；构建不得再引用 `/tmp`、开发目录等路径（完成后对产物做 `strings` 审计）。

## 1. 目标布局（electron-builder extraResources / extraFiles）

| 暂存源（product/memory/…） | 包内目标 | 说明 |
|---|---|---|
| `runtime/hindsight/` | `Contents/Resources/memory/hindsight/` | PyInstaller onedir：`HindsightAPI` + `_internal/` + `scripts/run-server.sh`（419MB） |
| `runtime/models/` | `Contents/Resources/memory/models/` | `Xenova/multilingual-e5-small`：int8 ONNX 112.6MB + tokenizer 4 文件（共 133.7MiB） |
| `runtime/pg0/` | `Contents/Resources/memory/pg0/` | 预置 PostgreSQL installation 18.1.0（32.4MiB，含 pgvector） |
| `sidecar.mjs` | `Contents/Resources/memory/sidecar.mjs` | 与 `nisse/m4/memory/sidecar.mjs` 字节一致 |
| `adapter/m1-c-hindsight/` | `Contents/spike/m1-c-hindsight/` | **extraFiles（Contents 级，不是 Resources/）**；sidecar 相对 import 依赖它，见 §2 |
| `VERSION.json` | `Contents/Resources/memory/VERSION.json` | 资源版本/来源/哈希，运行时可读 |
| `INTEGRATION.md`、`R1B-VALIDATION-PLAN.md` | `Contents/Resources/memory/`（可选） | 随包文档，便于现场排障 |

内存运行时净增：**约 570MiB 逻辑字节（597,796,821 bytes / 7,795 文件 + 32 相对符号链接；磁盘分配约 617MB）**；安装体积预算按 R1 记录追加。

### electron-builder 参考配置（加入 `apps/desktop/scripts/electron-builder-config.mjs`）

```js
extraResources: [
  { from: join(buildPaths.product, 'memory', 'runtime', 'hindsight'), to: 'memory/hindsight' },
  { from: join(buildPaths.product, 'memory', 'runtime', 'models'), to: 'memory/models' },
  { from: join(buildPaths.product, 'memory', 'runtime', 'pg0'), to: 'memory/pg0' },
  { from: join(buildPaths.product, 'memory', 'sidecar.mjs'), to: 'memory/sidecar.mjs' },
  { from: join(buildPaths.product, 'memory', 'VERSION.json'), to: 'memory/VERSION.json' },
],
extraFiles: [
  // sidecar.mjs 内部 import '../../spike/m1-c-hindsight/src/index.mjs'，从
  // Contents/Resources/memory/ 出发正好落在 Contents/spike/m1-c-hindsight；不要改 sidecar 源码。
  { from: join(buildPaths.product, 'memory', 'adapter', 'm1-c-hindsight'), to: 'spike/m1-c-hindsight' },
],
```

`buildPaths.product` 由 `nisse/tools/build-product.sh` 从 `NISSE_PRODUCT_DIR` 注入并 fail-fast 校验（与现有 NISSE_* 输入同风格）；禁止回退开发路径。

## 2. 包内最终布局与 sidecar import 解析（必须按此实现）

```
WhaleGirlBot.app/Contents/
├── Resources/
│   └── memory/
│       ├── hindsight/            # PyInstaller onedir（HindsightAPI + _internal/）
│       │   └── scripts/run-server.sh
│       ├── models/Xenova/multilingual-e5-small/{config.json,tokenizer.json,tokenizer_config.json,
│       │        special_tokens_map.json,sentencepiece.bpe.model,onnx/model_int8.onnx}
│       ├── pg0/installation/18.1.0/
│       ├── sidecar.mjs
│       └── VERSION.json
└── spike/m1-c-hindsight/         # extraFiles 落到 Contents/
    ├── src/{index,memory-adapter,errors,sensitive,writer-lock}.mjs
    └── node_modules/@vectorize-io/hindsight-client/
        ├── package.json
        ├── dist/index.mjs
        └── README.md
```

解析规则：`sidecar.mjs` 的 `import '../../spike/m1-c-hindsight/src/index.mjs'` 以文件自身目录为基准：
`Contents/Resources/memory/` → `../..` = `Contents/` → `Contents/spike/m1-c-hindsight/src/index.mjs` ✔
该 `index.mjs` 再解析裸包名 `@vectorize-io/hindsight-client`，Node 向上查找到
`Contents/spike/m1-c-hindsight/node_modules/@vectorize-io/hindsight-client` ✔
注意：
- **adapter 必须整体复制**（含 `node_modules`，约 153KB / 8 文件）；只放 `src/` 会导致 sidecar 以 `ERR_MODULE_NOT_FOUND` 退出。
- 不得把 adapter 塞进 `Resources/`（相对路径会变成 `Resources/../../spike`，解析失败）。
- 本契约已用「模拟 .app 布局」离线验证（EVIDENCE.simulatedPackagedLayout）。

## 3. 启动契约

数据根 `dataRoot = <app.getPath('userData')>/dsh-home/memory`（打包版 `DSH_HOME` 已强制为 `userData/dsh-home`，与 `MemoryRuntime.dataRoot` 一致）。
Hindsight 数据根 `NISSE_M1C_ROOT = <dataRoot>/runtime`。

### 3.1 Hindsight API（由 `memory-runtime.ts` 的 `ensureServer()` 启动）

```
argv:  /bin/bash  <Resources>/memory/hindsight/scripts/run-server.sh
cwd:   <Resources>/memory/hindsight
env:   NISSE_M1C_ROOT=<dataRoot>/runtime
       NISSE_M1C_PORT=<127.0.0.1 上自动分配的端口；与 NISSE_HINDSIGHT_URL 一致>
       （可选覆盖）HINDSIGHT_API_LLM_PROVIDER / HINDSIGHT_API_LLM_* / HINDSIGHT_API_KEY
```
`run-server.sh` 负责（A 流不要重复实现，也不要改脚本内容）：
- 强制 `HOME=$NISSE_M1C_ROOT/home`、`CFFIXED_USER_HOME=$HOME`、`TMPDIR=$NISSE_M1C_ROOT/tmp`、`XDG_CACHE_HOME/CONFIG/DATA_HOME` → 所有用户态文件落在数据根；
- 首启把 `Resources/memory/pg0/installation/18.1.0` 复制到 `$HOME/.pg0/installation/`（**pg0 若不预置会从 GitHub 下载，属于禁止行为**）；
- 固定离线 env：`HF_HUB_OFFLINE=1`、`HF_HUB_DISABLE_TELEMETRY=1`、`TRANSFORMERS_OFFLINE=1`；
- 固定指向包内模型：`HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx`、`..._ONNX_MODEL_PATH=<Resources>/memory/models/.../onnx/model_int8.onnx`、`..._ONNX_TOKENIZER_NAME_OR_PATH=<Resources>/memory/models/...`、`DIMENSIONS=384`、`HINDSIGHT_API_RERANKER_PROVIDER=rrf`、`HINDSIGHT_API_DATABASE_URL=pg0`、`HINDSIGHT_API_HOST=127.0.0.1`；
- 幂等：已有健康实例直接返回；健康检查 `/health`，超时 240s；启动失败把日志 tail 打到 stderr 并以非 0 退出。

### 3.2 MemoryAdapter sidecar（由 `ensureSidecar()` 启动）

```
argv:  <Electron 可执行文件> <Resources>/memory/sidecar.mjs     # 见下方 ELECTRON_RUN_AS_NODE
cwd:   <dataRoot>
env:   ELECTRON_RUN_AS_NODE=1                 # 关键：让 Electron 以 Node 模式运行脚本，禁止拉起第二个 Electron 实例
       NISSE_M4_MEMORY_ROOT=<dataRoot>
       NISSE_M4_MEMORY_TOKEN=<randomUUID，运行时生成，仅内存/0600 文件>
       NISSE_M4_BANK=whalegirl:bot
       HINDSIGHT_URL=http://127.0.0.1:<server 端口>
```
- 就绪判据：`<dataRoot>/sidecar.json` 出现且含 `{pid,port,token,bank}`（进程写，0600）。
- 所有 sidecar 端点（含 `/health`）都要求 `Authorization: Bearer <token>`；调用方要带 token。
- 业务端点：`POST /write /search /forget /digest /export /list /correct /delete /history`，`GET /health`。
- 停止：SIGTERM sidecar → 再按 `<dataRoot>/runtime/run/server.pid` SIGTERM HindsightAPI（wrapper 只负责写 pid 文件）。

### 3.3 必需/可选环境变量汇总

| 变量 | 必需 | 由谁设置 | 值/说明 |
|---|---|---|---|
| `NISSE_M1C_ROOT` | 是 | A（memory-runtime） | `<dataRoot>/runtime` |
| `NISSE_M1C_PORT` | 是 | A | 127.0.0.1 空闲端口（与 `NISSE_HINDSIGHT_URL` 一致） |
| `ELECTRON_RUN_AS_NODE` | 是 | A（sidecar spawn env） | `1` |
| `NISSE_M4_MEMORY_ROOT` / `_TOKEN` / `_BANK` | 是 | A | 见 §3.2 |
| `HINDSIGHT_URL` | 是 | A | `http://127.0.0.1:<port>` |
| `WHALEGIRL_HINDSIGHT_ROOT` | 否 | A | 现有代码的旧覆盖变量；建议删除该逻辑，统一用 `NISSE_M1C_ROOT=<dataRoot>/runtime` |
| `NISSE_HINDSIGHT_URL` | 否 | A | 覆盖固定 server URL（默认 `127.0.0.1:18888`），产品应显式分配端口 |
| `WHALEGIRL_MEMORY_DISABLE=1` | 否（kill switch） | 用户/支持 | 完全关闭记忆栈，UI 显示「已关闭」 |
| `HF_HUB_OFFLINE` 等 | 由 wrapper 强制 | — | A 不需要设置，也不要覆盖 |

## 4. 数据目录、性能基线与清理

```
<userData>/dsh-home/memory/                  # dataRoot，卸载时整目录删除
├── runtime/home/.pg0/{installation,instances}   # PostgreSQL 18.1 + 数据（首启复制 installation ≈32MiB）
├── runtime/home/.cache/huggingface/             # 空（离线，仅预防性隔离）
├── runtime/{logs,run,tmp}/
├── sidecar.json                             # 0600，运行时描述符
└── runtime.json                             # 0600，memory runtime 描述符（publishDescriptor）
```
性能基线（M 系列 Mac，arm64，本机实测，详见 `EVIDENCE.json.summary`）：
- 稳态全新 HOME 冷启动 → `/health` 200：**8.1–9.9s**（首次在系统上首次运行 onedir 时 36.5s，属 OS 首次验证/页缓存冷启动，产品首启 UI 需容忍）
- 暖重启（数据保留）：**5.3s**；服务稳态 RSS ≈ **0.86–1.11GB**，峰值 ≈ 1.12GB；sidecar ≈ 78–102MB
- 召回 p50 ≈ 20–34ms，p95 ≈ 65–68ms（3 条中文事实，mock LLM + int8 ONNX）
- 停止（SIGTERM）→ 端口关闭 + pg0 停止：≤ 3s（验证脚本实测）

## 5. 异步启动 / 健康 / 失败态（A 流必须实现）

**状态机**：`disabled → starting → ready | degraded | failed`（外加 `starting` 超时降级）。
- `main.ts` 不得 `await memoryRuntime.start()` 后才继续；改为后台启动（voice/Bot 先可用），`memoryRuntime.status()` 对外暴露 `state/detail/lastError/logDir`。
- `starting`：UI 显式「记忆准备中…」；Host Integration 的 memory 工具返回 `503 {code:"MEMORY_STARTING"}`，**绝不返回空结果冒充已记住**。
- `ready`：descriptor 已发布（`url`/`token` 非空）且 `/health` 200；此时才允许 UI 显示「记忆已就绪」。
- `degraded`：server 健康但 sidecar 或装库失败，或启动超过 60s；继续后台重试（指数退避，上限 3 次），UI 显示原因 + 「重试」。
- `failed`：资源缺失/二进制无法执行/端口耗尽；fail-soft，保留语音主链路，设置页显示 `lastError` 与 `<dataRoot>/runtime/logs/server.log` 路径。
- 建议埋点：`state` 变更、`startup_ms`（cold/warm）、`lastErrorKind`（resource_missing/spawn_failed/health_timeout/sidecar_failed/pg0_failed）。

### 5.1 失败矩阵（用户可见文案 + 处理）

| 场景 | 检测 | state | 用户可见（设置页） | 处理 |
|---|---|---|---|---|
| 资源缺失（hindsight/models/pg0） | 启动前 `existsSync` 校验 | failed | 「记忆组件缺失，请重新安装」 | 不 spawn；日志给缺失路径 |
| `HindsightAPI` 无法执行（签名/quarantine） | spawn error/exit≠0 | failed | 「记忆服务无法启动」 | 记录 exit code + stderr tail |
| `/health` 超时（>240s） | 轮询 | failed | 「记忆准备超时」 | 杀进程树；保留日志 |
| pg0 启动失败（端口/权限） | server.log `pg0` ERROR | failed | 「本地数据库启动失败」 | 提示重试/上传日志 |
| sidecar 退出/无 descriptor | exit/超时 30s | degraded | 「记忆检索组件异常」 | 关闭 sidecar，重试一次 |
| 端口被占用 | 启动前 bind 探测 | degraded | 自动换端口 | 重新分配 |
| 用户关闭记忆 | `memory.enabled=false` / kill switch | disabled | 「记忆已关闭」 | 停止进程、不显示任何记忆入口 |

## 6. A 流最小改动清单（可直接给 patch 文本）

### 6.1 `apps/desktop/src/memory-runtime.ts`

```diff
@@ ensureServer()
-        NISSE_M1C_ROOT: String(process.env.WHALEGIRL_HINDSIGHT_ROOT || '/tmp/...'),
+        NISSE_M1C_ROOT: String(process.env.WHALEGIRL_HINDSIGHT_ROOT || join(this.dataRoot, 'runtime')),
         NISSE_M1C_PORT: String(new URL(this.serverUrl).port || '18888'),
@@ ensureSidecar()
       env: {
         ...process.env,
+        // Electron 主进程二进制必须以 Node 模式运行 sidecar，否则会拉起第二个应用实例。
+        ELECTRON_RUN_AS_NODE: '1',
         NISSE_M4_MEMORY_ROOT: this.dataRoot,
@@ stop()
-        const pidFile = join(String(process.env.WHALEGIRL_HINDSIGHT_ROOT || '/tmp/nisse-m1-hindsight'), 'run', 'server.pid')
+        const pidFile = join(String(process.env.WHALEGIRL_HINDSIGHT_ROOT || this.dataRoot), 'run', 'server.pid')
```
同时：
- 保持 `dataRoot = <dshHome>/memory`；`NISSE_M1C_ROOT = <dataRoot>/runtime`（wrapper 在其中再建 `home/`、`data/`、`logs/`、`run/`、`tmp/`）。不要改 `dataRoot` 本身，否则 sidecar 的 `sidecar.json`/`runtime.json` 位置与现有 `publishDescriptor()` 不一致。
- `start()` 增加 `state` 字段与后台启动 API（例如 `startInBackground(): MemoryRuntimeStatus`），`start()` 内部不再串行阻塞 180s；超时从 180s 调整为 240s 仅作为兜底。
- 端口分配：先 `net.createServer().listen(0,'127.0.0.1')` 取空闲端口再传给 wrapper；`NISSE_HINDSIGHT_URL` 必须与之一致。现有代码默认 `18888` 可在固定端口空闲时保留，但必须支持自动分配。
- `status()` 返回 `{ state, enabled, detail, lastError, logDir: <dataRoot>/runtime/logs }`，供设置页/telemetry 使用。

### 6.2 `apps/desktop/src/main.ts`

```diff
-  await memoryRuntime.start(startupConfig)
-  memoryRuntime.publishDescriptor()
-  botRuntime.setMemory(memoryRuntime.url !== null && memoryRuntime.token !== null
-    ? { url: memoryRuntime.url, token: memoryRuntime.token }
-    : null)
+  // 记忆异步就绪：不阻塞语音主链路；就绪后再把 descriptor 注入 Bot profile。
+  void memoryRuntime.start(startupConfig).then(() => {
+    memoryRuntime.publishDescriptor()
+    botRuntime.setMemory(memoryRuntime.url !== null && memoryRuntime.token !== null
+      ? { url: memoryRuntime.url, token: memoryRuntime.token }
+      : null)
+  })
```

### 6.3 打包 / 签名 / 卸载
- `extraResources` / `extraFiles`：见 §1。
- 签名：PyInstaller onedir 目前是 adhoc 签名（arm64）。A 流发布前必须对嵌套二进制（`HindsightAPI`、`_internal/pg0/bin/pg0`、`_internal/**/*.so`、postgres 可执行文件）重新签名（Developer ID + hardened runtime），再签 app；不要依赖 `--deep`，最后 notarize + staple，并用 `codesign --verify --deep --strict`、`spctl -a -vv` 复核。
- 卸载/关闭：停止进程 → 删除 `<userData>/dsh-home/memory`（整目录）；不得删除用户真实 HOME 下的产品外 PostgreSQL 数据，不得触碰用户 DSH home。
- 打包后审计：`strings` 产物不得出现 `/tmp/wg-`、开发目录路径；启动后 `lsof -p` 确认文件/端口全部落在 `Resources/memory` 与 `127.0.0.1`。

## 7. 验证与证据

- 离线验证证据：`EVIDENCE.json`（本暂存根；Lead 复制为 `m4/evidence/MEMORY-PACKAGING-STAGING.json`）。
- 复跑命令（B 流环境）：
  ```
  cd /tmp/wg-memory-staging
  node scripts/validate-offline.mjs --staging-root /tmp/wg-memory-staging \
       --work-root /tmp/wg-memory-offline-verify --out EVIDENCE.json
  ```
- 结论：**PASS_WITH_CONDITIONS**。功能项全部 PASS（隔离 HOME、零下载、ONNX 初始化、pg0 预置、retain→recall、软失效不可召回、文档删除后不可检索、暖重启、无残留进程、真实 DSH home 未被触碰）。唯一 CONDITION 见 §8。

## 8. 已知条件（打包前必须知晓）

**MEM-COND-1：HindsightAPI 启动时发起 1 条后台 TLS 出站连接（本机呈现为 `172.19.0.1:<port> -> 198.18.0.134:443`，真实域名未能恢复）。**
- 不影响功能：`/health`、pg0、ONNX、retain/recall/invalidate 全部正常；无模型/数据库/记忆数据走网络。
- 已尝试且无法消除：`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`、`HF_HUB_DISABLE_TELEMETRY=1`、`HINDSIGHT_API_MCP_ENABLED=false`、LiteLLM/OTel/FastMCP 遥测开关。
- lldb 断点证据：libc `connect` 捕获到的全部是 `127.0.0.1:5433`（pg0）；该 socket 未经过被拦截的 `connect`，指向 vendored native/后台组件。
- 建议：发布前用 mitmproxy 抓一次 SNI 定性；若为库版本检查/遥测，产品可选择在隐私说明披露，或由 Electron 侧做 egress 白名单。未定性前按 CONDITION 交付，不阻塞打包。
- 最小复现：见 `EVIDENCE.json.conditions[0].minimalRepro`。
