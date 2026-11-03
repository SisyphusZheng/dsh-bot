#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .mvv-build/evidence
exec > >(tee .mvv-build/evidence/verify-local.log) 2>&1
export DSH_GATE_CONCURRENCY=${DSH_GATE_CONCURRENCY:-1}
# beta2 additions (Lead-approved frozen list; missing/failing must FAIL, never skip):
#  - apps/desktop/tests/beta2-host-kernel.spec.ts in the explicit vitest list below
#    (real Host + Mock Provider v2 kernel evidence for B2-G04/G10);
#  - node product/tools/dev-doctor.mjs --json after build (read-only; exit != 0 FAILS);
#  - bash -n covers accept-beta2-macos.sh below.
# Auto-picked by the globs below: product/pet/tests/*.test.mjs,
# nisse/packages/host-integration/tests/*.test.mjs, product/tools/tests/*.test.mjs;
# product/voice-worker-src/test_*.py is auto-picked by unittest discover.
# A separate v2 host smoke runner is intentionally NOT added: beta2-host-kernel.spec.ts
# is the real-Host+Mock evidence.
node product/tools/verify-upstream.mjs
npx --yes pnpm@11.28.5 install --frozen-lockfile
node product/tools/prepare-wake-model.mjs
node --test product/pet/tests/*.test.mjs nisse/packages/host-integration/tests/*.test.mjs product/tools/tests/*.test.mjs
npx --yes pnpm@11.28.5 run typecheck
npx --yes pnpm@11.28.5 run build
# Vitest's proxy setup cannot undo Node's startup-time global fetch dispatcher.
# Isolate only these keyless fixture tests; provider connection policy stays unchanged.
# 2026-10-31 closure additions (S1/S2/S3/F1 evidence, reviewed by the integration Lead):
#  sandbox-write-effects/sandbox-bot-permissions (S1 default permission + fail-closed),
#  s2-pet-cancel-target (S2 Desktop capture-time target), s3-credentials-concurrency (S3 two-process writer),
#  f1-projection-ordering/f1-host-restart-unknown/f1-m2-memory-e2e (F1 + M2 Host-level evidence).
# Missing or failing must FAIL, never skip.
# 2026-11-02 0.0.1 final additions: product-identity/launch-settings are new product tests; tray,
# locale, directory-picker and the preload*/welcome-renderer client specs cover upstream sources
# this product modifies (app name, locale strings, tray labels, IPC surface), so they are gated here
# rather than left to the upstream-only gate. Their expected values follow the dsh-bot name.
NODE_USE_ENV_PROXY=0 npx --yes pnpm@11.28.5 exec vitest run --maxWorkers=1 apps/desktop/tests/sandbox-write-effects.spec.ts apps/desktop/tests/sandbox-bot-permissions.spec.ts apps/desktop/tests/s2-pet-cancel-target.spec.ts apps/desktop/tests/s3-credentials-concurrency.spec.ts apps/desktop/tests/f1-projection-ordering.spec.ts apps/desktop/tests/f1-host-restart-unknown.spec.ts apps/desktop/tests/f1-m2-memory-e2e.spec.ts apps/desktop/tests/round2-memory-switch.spec.ts apps/desktop/tests/round2-remember-path.spec.ts apps/desktop/tests/round2-unknown-ux.spec.ts apps/desktop/tests/round3-s1-closure.spec.ts apps/desktop/tests/round3-atomic-profile.spec.ts apps/desktop/tests/beta2-host-kernel.spec.ts apps/desktop/tests/main-startup.spec.ts apps/desktop/tests/welcome-startup.spec.ts apps/desktop/tests/live-config.spec.ts apps/desktop/tests/pet-runtime.spec.ts apps/desktop/tests/host-integration-mvp.spec.ts apps/desktop/tests/mvp-closure.spec.ts apps/desktop/tests/product-resources.spec.ts apps/desktop/tests/product-macos-resources.spec.ts apps/desktop/tests/installer-packaging.spec.ts apps/desktop/tests/packaged-runtime-verification.spec.ts apps/desktop/tests/macos-signature.spec.ts packages/client/ui-chat/tests/chat-view.client.spec.tsx apps/desktop/tests/dsh-bot-regressions.spec.ts apps/desktop/tests/bot-settings-secrets.spec.ts apps/desktop/tests/host-process.spec.ts apps/desktop/tests/preload-app.spec.ts apps/desktop/tests/host-client-bundle.spec.ts apps/desktop/tests/development-project.spec.ts apps/desktop/tests/pet-voice-route.spec.ts apps/desktop/tests/product-identity.spec.ts apps/desktop/tests/launch-settings.spec.ts apps/desktop/tests/bubble-visibility.spec.ts apps/desktop/tests/tray.spec.ts apps/desktop/tests/locale.spec.ts apps/desktop/tests/directory-picker.spec.ts apps/desktop/tests/preload-menu.client.spec.ts apps/desktop/tests/preload-theme.client.spec.ts apps/desktop/tests/preload-windows.client.spec.ts apps/desktop/tests/preload-platform.client.spec.ts apps/desktop/tests/welcome-renderer.client.spec.tsx packages/credentials/credentials-local/tests/local.spec.ts packages/llm/llm/tests/api-key.spec.ts packages/session/session-telemetry/tests/redact.spec.ts
node product/tools/dev-doctor.mjs --json
node product/tools/verify-product-docs.mjs
node product/tools/smoke-wake-word.mjs
node product/tools/check-built-resources.mjs | tee .mvv-build/evidence/built-resources.json
node product/tools/smoke-pet-ui.mjs
node product/tools/smoke-host.mjs
node product/tools/smoke-host.mjs --default-provider
VOICE_PYTHON=${DSH_BOT_VOICE_PYTHON:-.mvv-build/voice-venv/bin/python}
[[ -x "$VOICE_PYTHON" ]] || { echo 'BLOCKED-ENVIRONMENT: set DSH_BOT_VOICE_PYTHON to Python with requirements.in installed'; exit 2; }
"$VOICE_PYTHON" -m unittest discover -s product/voice-worker-src -p 'test_*.py'
node product/tools/smoke-voice.mjs "$VOICE_PYTHON"
node product/tools/smoke-voice-media.mjs "$VOICE_PYTHON"
DSH_MEDIA_PASSIVE=1 DSH_MEDIA_INTERACTION=approval node product/tools/smoke-voice-media.mjs "$VOICE_PYTHON"
DSH_MEDIA_PASSIVE=1 DSH_MEDIA_INTERACTION=question node product/tools/smoke-voice-media.mjs "$VOICE_PYTHON"
bash -n product/tools/build-macos.sh product/tools/build-memory.sh product/tools/accept-macos.sh product/tools/accept-beta2-macos.sh product/tools/install-macos.sh product/memory/scripts/run-server.sh
git diff --check
echo 'PASS verify-local'
