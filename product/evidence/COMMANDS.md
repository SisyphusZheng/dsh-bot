# Work-local verification

See RESULTS.json and per-command logs. No Actions workflow was invoked.

- `pnpm install --frozen-lockfile`
- `DSH_GATE_CONCURRENCY=1 pnpm run typecheck`
- `DSH_GATE_CONCURRENCY=1 pnpm run build`
- `pnpm exec vitest run --maxWorkers=1` with the nine files in `product/tools/verify-local.sh`
- Python 3.12.13 + `product/voice-worker-src/requirements.in`, three real processor contract tests
- `node product/tools/smoke-host.mjs` and `--default-provider`
- `node product/tools/smoke-voice.mjs ../dependencies/voice-venv/bin/python`
- `node product/tools/verify-upstream.mjs`, plus a temporary unallowlisted source mutation rejected and restored
- `DSH_ARCHIVE_BASE_REF=1f81c047fc48fa190a683e469daa699857e9afe8 pnpm exec lefthook run pre-commit`
- `bash -n` for Mac build, Mac acceptance and Hindsight wrapper; Node syntax checks for bridge/tools
- Actual `hindsight_api.pg0.EmbeddedPostgres.start(max_retries=1)` with hindsight-api-slim 1.0.0, pg0-embedded 0.15.2: PostgreSQL root rejection, recorded without faking retrieval success.

Work environment adaptations (not tracked runtime changes): `NODE_USE_ENV_PROXY=0` for loopback tests; Node v24.22.1 copied alongside official verified headers to compile native addons; tsx CLI's UNIX IPC unavailable, so local node_modules bin wrappers use its supported `node --import tsx` loader. Header archive SHA-256: 322e0a27db9088093ab8347bdc8c7e0aaa21dc9ed548390bf06b394494c09267.

Log whitespace and ANSI escape sequences normalized for Git. RESULTS.json retains both raw and saved SHA-256. The final commit adds only evidence to the tested source tree.
