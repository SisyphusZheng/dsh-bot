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
npx --yes pnpm@11.28.5 run build
if ! "$STAGE/voice-venv/bin/python" -c 'import sys; assert sys.version_info[:3] == (3,12,13)' >/dev/null 2>&1; then
  uv venv --clear --python 3.12.13 "$STAGE/voice-venv"
fi
uv pip sync --python "$STAGE/voice-venv/bin/python" --require-hashes product/voice-worker-src/requirements-macos.lock
"$STAGE/voice-venv/bin/python" -m unittest discover -s product/voice-worker-src -p 'test_*.py'
node product/tools/smoke-voice.mjs "$STAGE/voice-venv/bin/python"
(cd product/voice-worker-src && "$STAGE/voice-venv/bin/pyinstaller" VoiceWorker.spec --distpath "$STAGE/voice-dist" --workpath "$STAGE/voice-build" --noconfirm)
export NISSE_VOICE_WORKER_DIR="$STAGE/voice-dist/VoiceWorker"
node product/tools/smoke-voice.mjs --binary "$NISSE_VOICE_WORKER_DIR/VoiceWorker"
node product/tools/check-built-resources.mjs > "$STAGE/evidence/built-resources.json"
node product/tools/smoke-host.mjs
node product/tools/smoke-host.mjs --default-provider
npx --yes pnpm@11.28.5 run package:desktop:mac:arm64:unsigned --check
npx --yes pnpm@11.28.5 run package:desktop:mac:arm64:unsigned
PACKAGED_APP=$(find apps/desktop/.desktop-build -type d -name 'dsh-bot.app' -print -quit)
[[ -n "$PACKAGED_APP" ]] || { echo 'Packaged app missing'; exit 1; }
# Record signed bytes externally so the application signature remains valid.
node product/memory/scripts/gen-version.mjs "$PACKAGED_APP/Contents/Resources/memory" "$STAGE/evidence/packaged-memory.json"
find apps/desktop/.desktop-build -name '*.dmg' -exec shasum -a 256 {} \; | tee "$STAGE/evidence/DMG-SHA256.txt"
echo 'Native build complete. Run bash product/tools/accept-macos.sh /absolute/path/to/new.dmg'
