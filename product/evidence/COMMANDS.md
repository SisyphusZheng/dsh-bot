# Work-local qualification

Base: `8c34e66905ffd1ac50a6ba9c0f3196b45e4823c6`. No GitHub Actions used.

Executed in the Linux Work workspace:

- `node node_modules/pnpm/bin/pnpm.mjs install --frozen-lockfile` (11.28.5).
- `DSH_GATE_CONCURRENCY=1 pnpm run build` and `pnpm run typecheck`, using official Node 24.22.1 headers and cloud-only untracked tsx launch shims.
- Vitest: host-integration-mvp, mvp-closure, product-resources, dsh-bot-regressions, bot-settings-secrets, host-process, live-config, pet-runtime; credentials-local/local, llm/api-key, session-telemetry/redact. 11 files / 122 tests.
- `node product/tools/smoke-host.mjs` and `--default-provider`: real compiled Host and real standard tools, explicit local model/memory fixtures.
- Python unittest discovery in `product/voice-worker-src`: 3 tests.
- `node product/tools/smoke-voice.mjs <python>` and `--binary <fresh Linux VoiceWorker>`: real worker startup/auth/shutdown.
- Fresh Linux PyInstaller builds of `VoiceWorker.spec` and `HindsightAPI.spec`; Hindsight CLI and `--check-embeddings <pinned local model>`.
- `node product/tools/check-built-resources.mjs`; upstream blob integrity plus an intentional source mutation negative control.
- Local pre-commit hook, `git diff --check` and shell syntax for build/acceptance/server scripts.

`RESULTS.json` distinguishes fixtures, actual frozen executables, and unexecuted native/provider gates. `built-resources.json` records emitted cross-platform resource hashes.

To reconstruct the tested source tree: create a temporary Git index, `git read-tree HEAD`, remove `product/evidence` from that index, then `git write-tree`; compare with `testedSourceTreeExcludingEvidence`. The final evidence directory is excluded to avoid a self-referential hash.

On Apple Silicon macOS (not executed here): `bash product/tools/build-macos.sh`, then `bash product/tools/accept-macos.sh /absolute/path/to/new.dmg`. Native build writes signed Memory payload hashes externally and records DMG SHA-256.
