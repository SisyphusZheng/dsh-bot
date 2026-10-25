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
DMG=${DSH_BOT_LEGACY_DMG:-$STAGE/inputs/dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg}
if [[ ! -f "$DMG" ]]; then
  command -v gh >/dev/null || { echo 'Set DSH_BOT_LEGACY_DMG to the existing v0.0.1-beta release DMG, or install/authenticate gh'; exit 2; }
  gh release download v0.0.1-beta --repo SisyphusZheng/dsh-bot --pattern dsh-bot-0.0.1-beta-mac-arm64-unsigned.dmg --dir "$STAGE/inputs"
fi
[[ $(shasum -a 256 "$DMG" | cut -d' ' -f1) == 76d13562a33d2efcc1aa6846710bcf2c2e25a7eb1b74e55277fc559780998cd2 ]] || { echo 'Pinned native input SHA-256 mismatch'; exit 1; }
MOUNT="$STAGE/legacy-mount"
mkdir -p "$MOUNT"
hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MOUNT"
trap 'hdiutil detach "$MOUNT" >/dev/null 2>&1 || true' EXIT
LEGACY_APP=$(find "$MOUNT" -maxdepth 1 -name '*.app' -print -quit)
[[ -n "$LEGACY_APP" ]] || { echo 'No app in pinned DMG'; exit 1; }
RES="$LEGACY_APP/Contents/Resources"
rm -rf "$STAGE/pet" "$STAGE/memory"
mkdir -p "$STAGE/pet" "$STAGE/memory/runtime"
ditto "$RES/pet/NissePet.app" "$STAGE/pet/NissePet.app"
cp "$RES/voice-client/inject-bundle.js" "$STAGE/inputs/inject-bundle.js"
for name in hindsight models pg0; do ditto "$RES/memory/$name" "$STAGE/memory/runtime/$name"; done
hdiutil detach "$MOUNT"
trap - EXIT
for name in sidecar.mjs scripts adapter VERSION.json; do cp -R "product/memory/$name" "$STAGE/memory/"; done
node product/memory/scripts/gen-version.mjs "$STAGE/memory"
[[ $(shasum -a 256 "$STAGE/memory/runtime/models/Xenova/multilingual-e5-small/onnx/model_int8.onnx" | cut -d' ' -f1) == 4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c ]] || { echo 'ONNX input digest mismatch'; exit 1; }
export NISSE_PET_BUNDLE="$STAGE/pet/NissePet.app" NISSE_MEMORY_DIR="$STAGE/memory"
export NISSE_VOICE_CLIENT_BUNDLE="$STAGE/inputs/inject-bundle.js"
export DSH_HOME="$STAGE/dsh-home" DSH_TELEMETRY_DISABLED=1
export MACOSX_DEPLOYMENT_TARGET=14.0
npx --yes pnpm@11.28.5 install --frozen-lockfile
node product/tools/verify-upstream.mjs
npx --yes pnpm@11.28.5 run build
node product/tools/rebuild-pet.mjs "$NISSE_PET_BUNDLE"
codesign --force --deep --sign - "$NISSE_PET_BUNDLE"
uv venv --python 3.12.13 "$STAGE/voice-venv"
uv pip sync --python "$STAGE/voice-venv/bin/python" --require-hashes product/voice-worker-src/requirements-macos.lock
"$STAGE/voice-venv/bin/python" -m unittest discover -s product/voice-worker-src -p 'test_*.py'
node product/tools/smoke-voice.mjs "$STAGE/voice-venv/bin/python"
(cd product/voice-worker-src && "$STAGE/voice-venv/bin/pyinstaller" VoiceWorker.spec --distpath "$STAGE/voice-dist" --workpath "$STAGE/voice-build" --noconfirm)
export NISSE_VOICE_WORKER_DIR="$STAGE/voice-dist/VoiceWorker"
node product/tools/smoke-voice.mjs --binary "$NISSE_VOICE_WORKER_DIR/VoiceWorker"
node product/tools/smoke-host.mjs
node product/tools/smoke-host.mjs --default-provider
npx --yes pnpm@11.28.5 run package:desktop:mac:arm64:unsigned --check
npx --yes pnpm@11.28.5 run package:desktop:mac:arm64:unsigned
find apps/desktop/.desktop-build -name '*.dmg' -exec shasum -a 256 {} \; | tee "$STAGE/evidence/DMG-SHA256.txt"
echo 'Native build complete. Run bash product/tools/accept-macos.sh /absolute/path/to/new.dmg'
