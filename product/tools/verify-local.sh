#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .mvv-build/evidence
exec > >(tee .mvv-build/evidence/verify-local.log) 2>&1
export DSH_GATE_CONCURRENCY=${DSH_GATE_CONCURRENCY:-1}
node product/tools/verify-upstream.mjs
pnpm install --frozen-lockfile
node product/tools/prepare-wake-model.mjs
node --test product/pet/tests/*.test.mjs nisse/packages/host-integration/tests/*.test.mjs product/tools/tests/*.test.mjs
pnpm run typecheck
pnpm run build
# Vitest's proxy setup cannot undo Node's startup-time global fetch dispatcher.
# Isolate only these keyless fixture tests; provider connection policy stays unchanged.
NODE_USE_ENV_PROXY=0 pnpm exec vitest run --maxWorkers=1 apps/desktop/tests/main-startup.spec.ts apps/desktop/tests/welcome-startup.spec.ts apps/desktop/tests/live-config.spec.ts apps/desktop/tests/pet-runtime.spec.ts apps/desktop/tests/host-integration-mvp.spec.ts apps/desktop/tests/mvp-closure.spec.ts apps/desktop/tests/product-resources.spec.ts apps/desktop/tests/product-macos-resources.spec.ts apps/desktop/tests/installer-packaging.spec.ts apps/desktop/tests/packaged-runtime-verification.spec.ts apps/desktop/tests/macos-signature.spec.ts packages/client/ui-chat/tests/chat-view.client.spec.tsx apps/desktop/tests/dsh-bot-regressions.spec.ts apps/desktop/tests/bot-settings-secrets.spec.ts apps/desktop/tests/host-process.spec.ts apps/desktop/tests/preload-app.spec.ts apps/desktop/tests/host-client-bundle.spec.ts apps/desktop/tests/development-project.spec.ts apps/desktop/tests/pet-voice-route.spec.ts packages/credentials/credentials-local/tests/local.spec.ts packages/llm/llm/tests/api-key.spec.ts packages/session/session-telemetry/tests/redact.spec.ts
node product/tools/verify-product-docs.mjs
node product/tools/smoke-wake-word.mjs
node product/tools/check-built-resources.mjs
node product/tools/smoke-pet-ui.mjs
node product/tools/smoke-host.mjs
node product/tools/smoke-host.mjs --default-provider
VOICE_PYTHON=${DSH_BOT_VOICE_PYTHON:-.mvv-build/voice-venv/bin/python}
[[ -x "$VOICE_PYTHON" ]] || { echo 'BLOCKED-ENVIRONMENT: set DSH_BOT_VOICE_PYTHON to Python with requirements.in installed'; exit 2; }
"$VOICE_PYTHON" -m unittest discover -s product/voice-worker-src -p 'test_*.py'
node product/tools/smoke-voice.mjs "$VOICE_PYTHON"
node product/tools/smoke-voice-media.mjs "$VOICE_PYTHON"
bash -n product/tools/build-macos.sh product/tools/build-memory.sh product/tools/accept-macos.sh product/tools/install-macos.sh product/memory/scripts/run-server.sh
git diff --check
