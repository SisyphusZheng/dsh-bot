# P0 事件记录：内测包继承 DSH 环境导致主 DSH 被写入（2026-10-24 21:35）

## 事件

从 Agent shell 直接启动 `/Applications/dsh-bot.app` 时，进程继承了当前会话的环境变量（`DSH_HOME`、`DSH_PROFILE_DIR`、`DSH_SHELL` 等）。打包壳虽然把 `DSH_HOME` 强制到 `userData/dsh-home`，但 **Host 子进程仍读取了继承的 `DSH_PROFILE_DIR`**，因此附着了用户主 DSH profile：

- `$HOME/.dsh/profiles/desktop`（Host 使用的 profile）
- 写入时间：2026-10-24 21:35

## 受影响文件（已确认，未修改）

| 路径 | 说明 |
|---|---|
| `~/.dsh/profiles/desktop/cordis.patch.yml` | 21:35 被重写（managed block 重新生成） |
| `~/.dsh/profiles/desktop/cordis.patch.yml.commandcode-goat-d71dac091893c614.json` | 21:35 生成 |
| `~/.dsh/profiles/desktop/cordis.yml` | 21:35 生成/更新 |
| `~/.dsh/storages/session_projcache/sessions/session-f0f64228-0054-4eda-af4c-ff5a97360ea4.json` | 测试会话缓存 |
| `~/.dsh/sessions/--Users-user-Documents-projects-nisse--/session-f0f64228-.../session.v4.jsonl.zstd` | 测试会话 |

`~/.dsh` 顶层 mtime 仍为 17:38；上述是 21:35 新增/修改。

## 根因

`main.ts` 只在 packaged 模式设置 `DSH_HOME`，但没有清理继承的 `DSH_*` / `WHALEGIRL_*` / `NISSE_*` 环境；`apps/desktop-host` 优先使用 `DSH_PROFILE_DIR`。

## 修复（已提交）

- commit `f04ea76f62`：packaged 模式在任何路径解析前删除所有 `DSH_/WHALEGIRL_/NISSE_` 变量（`NISSE_DSH_HOME` 测试覆盖除外），并删除继承的 `ELECTRON_RUN_AS_NODE`。
- 真实 Finder 启动不会继承这些变量；本次是"从 Agent/终端启动"的特例，但产品必须对此免疫。

## 待产品负责人决定（未执行任何清理）

主 DSH 属于只读隔离范围，本事件**未做任何回滚/清理**。可选的精确清理（需授权）：

1. 删除 21:35 生成的测试会话：`~/.dsh/sessions/--Users-user-Documents-projects-nisse--/session-f0f64228-.../` 与对应 `storages/session_projcache/sessions/session-f0f64228-...json`；
2. 检查 `~/.dsh/profiles/desktop/cordis.patch.yml` 中是否新增了 WhaleGirl/Host Integration 的 managed block（若只是重写已有 block，需要与用户重启前状态对比才能安全回退）；
3. 任何恢复前先备份当前文件。

## 验证（修复后需重做）

用包含 `DSH_HOME/DSH_PROFILE_DIR` 的污染环境启动新包，断言：

- Host 进程参数指向 `~/Library/Application Support/dsh-bot/dsh-home/...`；
- `~/.dsh` 顶层与 profiles/sessions 的 mtime 不变化；
- 产品自己的 `dsh-home/profiles/desktop` 正常生成。

## 2026-10-24 22:17 — 第二次复现（修复不完整）

第一次修复（f04ea76f62）只清理了继承的 `DSH_*` 环境，但 `main.ts` 把 `DSH_HOME` 覆盖放在 `resolveDesktopPaths()` **之后**，路径在覆盖前已从继承的 `DSH_HOME` 解析；Host 再次使用 `~/.dsh/profiles/desktop`（22:17:58 mtime 更新，同一 session-f0f64228 继续写入）。

修复：commit `adbc1c18ad` 把 `DSH_HOME` 覆盖移入启动时的 scrub 块（任何路径解析之前）。

验证要求：重新用污染环境启动，Host 进程参数必须是
`~/Library/Application Support/dsh-bot/dsh-home/profiles/desktop`，且 `~/.dsh` 无新 mtime。

## 2026-10-24 22:38–22:50 — 修复后隔离验证（通过）

用同样继承 `DSH_HOME/DSH_PROFILE_DIR/DSH_SHELL` 等变量的 shell 启动新包（未清理环境），结果：

- Host 进程参数：`~/Library/Application Support/dsh-bot/dsh-home/profiles/desktop` ✅
- 产品数据目录生成 `dsh-home/{bot,memory,nisse,profiles,sessions,storages,workspace}` ✅
- `~/.dsh`、`~/.dsh/profiles/desktop`、`~/.dsh/sessions` mtime 在本次运行前后**未变化** ✅
- 伴生进程：HindsightAPI 从 `Contents/Resources/memory/hindsight` 启动；NissePet 从 `Contents/Resources/pet` 启动 ✅

剩余待验证：sidecar 打包路径（adapter node_modules 缺失已修复，等待下一构建复测）。

## 2026-10-24 23:38 — 主 DSH 运行中自行重写 profile（待归因）

隔离修复后的最终验证运行（23:29–23:38）中，产品 Host 全程使用
`~/Library/Application Support/dsh-bot/dsh-home/profiles/desktop`；
但 `~/.dsh/profiles/desktop/cordis.patch.yml` 在 23:38:31 被重写，且文件内包含
`# >>> whalegirl-bot: managed profile layer >>>` 块（22:17 污染遗留）。
该重写更可能来自**正在运行的主 DSH 应用**对该遗留 managed block 的定期规范化，
而不是本轮产品进程（本轮 Host 参数无主 DSH 路径）。待用户清理主 DSH 污染块后复核。
