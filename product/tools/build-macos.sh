#!/bin/bash
# Build locally. This script never invokes GitHub Actions, creates a PR or publishes a release.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo 'Requires Apple Silicon macOS'; exit 2; }
[[ $(sw_vers -productVersion | cut -d. -f1) -ge 14 ]] || { echo 'Requires macOS 14+'; exit 2; }
command -v uv >/dev/null || { echo 'Install uv first: https://docs.astral.sh/uv/'; exit 2; }
xcode-select -p >/dev/null
node -e "const [m,n]=process.versions.node.split('.').map(Number);if(!(m===22&&n>=19||m>=24))process.exit(2)"
SOURCE_SHA=$(git rev-parse HEAD)
[[ -z $(git status --porcelain) ]] || { echo 'Build a clean committed checkout so artifact identity is reliable'; exit 2; }
SHORT_SHA=${SOURCE_SHA:0:8}
STAGE="$ROOT/.mvv-build"
mkdir -p "$STAGE/evidence" "$STAGE/inputs"
exec > >(tee "$STAGE/evidence/build-macos.log") 2>&1
# Current source and hash-locked wheels; no old app or DMG is a build input.
rm -rf "$STAGE/pet" "$STAGE/pet-unpacked"
rm -f "$STAGE/inputs/dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg" "$STAGE/inputs/inject-bundle.js"
bash product/tools/build-memory.sh
export NISSE_MEMORY_DIR="$STAGE/memory"
export DSH_HOME="$STAGE/dsh-home" DSH_TELEMETRY_DISABLED=1
export MACOSX_DEPLOYMENT_TARGET=14.0
export DSH_GATE_CONCURRENCY=${DSH_GATE_CONCURRENCY:-1}
npx --yes pnpm@11.28.5 install --frozen-lockfile
node product/tools/verify-upstream.mjs
node --test product/pet/tests/*.test.mjs nisse/packages/host-integration/tests/*.test.mjs product/tools/tests/*.test.mjs
node product/tools/prepare-wake-model.mjs
npx --yes pnpm@11.28.5 run build
npx --yes pnpm@11.28.5 exec vitest run apps/desktop/tests/host-client-bundle.spec.ts apps/desktop/tests/development-project.spec.ts apps/desktop/tests/pet-runtime.spec.ts
if ! "$STAGE/voice-venv/bin/python" -c 'import sys; assert sys.version_info[:3] == (3,12,13)' >/dev/null 2>&1; then
  uv venv --clear --python 3.12.13 "$STAGE/voice-venv"
fi
uv pip sync --python "$STAGE/voice-venv/bin/python" --require-hashes product/voice-worker-src/requirements-macos.lock
"$STAGE/voice-venv/bin/python" -m unittest discover -s product/voice-worker-src -p 'test_*.py'
node product/tools/smoke-voice.mjs "$STAGE/voice-venv/bin/python"
(cd product/voice-worker-src && "$STAGE/voice-venv/bin/pyinstaller" VoiceWorker.spec --distpath "$STAGE/voice-dist" --workpath "$STAGE/voice-build" --noconfirm)
export NISSE_VOICE_WORKER_DIR="$STAGE/voice-dist/VoiceWorker"
node product/tools/smoke-voice.mjs --binary "$NISSE_VOICE_WORKER_DIR/VoiceWorker"
node product/tools/smoke-wake-word.mjs
node product/tools/check-built-resources.mjs > "$STAGE/evidence/built-resources.json"
node product/tools/smoke-host.mjs
node product/tools/smoke-host.mjs --default-provider
npx --yes pnpm@11.28.5 run package:desktop:mac:arm64:unsigned --check
npx --yes pnpm@11.28.5 run package:desktop:mac:arm64:unsigned
ARTIFACT_DIR=apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts
PACKAGED_APP=$(find "$ARTIFACT_DIR" -type d -name 'dsh-bot.app' -print -quit)
[[ -n "$PACKAGED_APP" ]] || { echo 'Packaged app missing'; exit 1; }
# Record signed bytes externally so the application signature remains valid.
node product/memory/scripts/gen-version.mjs "$PACKAGED_APP/Contents/Resources/memory" "$STAGE/evidence/packaged-memory.json"
node product/tools/macos-artifacts.mjs app "$PACKAGED_APP"
DMG=$(find "$ARTIFACT_DIR" -maxdepth 1 -name "dsh-bot-*-$SHORT_SHA-mac-arm64-unsigned.dmg" -print -quit)
[[ -n "$DMG" ]] || { echo 'DMG for this commit is missing'; exit 1; }
node product/tools/macos-artifacts.mjs record "$DMG" "$STAGE/evidence/macos-build.json" | tee "$STAGE/evidence/DMG-SHA256.txt"
echo 'Native build complete. Run bash product/tools/accept-macos.sh /absolute/path/to/new.dmg'
