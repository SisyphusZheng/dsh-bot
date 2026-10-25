#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .mvv-build/evidence
exec > >(tee .mvv-build/evidence/verify-local.log) 2>&1
export DSH_GATE_CONCURRENCY=${DSH_GATE_CONCURRENCY:-1}
node product/tools/verify-upstream.mjs
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm exec vitest run --maxWorkers=1 apps/desktop/tests/host-integration-mvp.spec.ts apps/desktop/tests/mvp-closure.spec.ts apps/desktop/tests/product-resources.spec.ts apps/desktop/tests/dsh-bot-regressions.spec.ts apps/desktop/tests/bot-settings-secrets.spec.ts apps/desktop/tests/host-process.spec.ts packages/credentials/credentials-local/tests/local.spec.ts packages/llm/llm/tests/api-key.spec.ts packages/session/session-telemetry/tests/redact.spec.ts
node product/tools/smoke-host.mjs
node product/tools/smoke-host.mjs --default-provider
VOICE_PYTHON=${DSH_BOT_VOICE_PYTHON:-.mvv-build/voice-venv/bin/python}
[[ -x "$VOICE_PYTHON" ]] || { echo 'BLOCKED-ENVIRONMENT: set DSH_BOT_VOICE_PYTHON to Python with requirements.in installed'; exit 2; }
"$VOICE_PYTHON" -m unittest discover -s product/voice-worker-src -p 'test_*.py'
node product/tools/smoke-voice.mjs "$VOICE_PYTHON"
bash -n product/tools/build-macos.sh product/tools/accept-macos.sh product/memory/scripts/run-server.sh
git diff --check
