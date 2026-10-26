#!/bin/bash
set -euo pipefail
umask 077
export HF_HUB_DISABLE_XET=1
export HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx HINDSIGHT_API_RERANKER_PROVIDER=rrf
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STAGE="$ROOT/.mvv-build"
PYTHON="$STAGE/memory-venv/bin/python"
export MACOSX_DEPLOYMENT_TARGET=14.0
if ! "$PYTHON" -c 'import sys; assert sys.version_info[:3] == (3,12,13)' >/dev/null 2>&1; then
  uv venv --clear --python 3.12.13 "$STAGE/memory-venv"
fi
uv pip sync --python "$PYTHON" --require-hashes "$ROOT/product/memory/requirements-macos.lock"
mkdir -p "$STAGE/memory/runtime/models" "$STAGE/memory/runtime/pg0/installation" "$STAGE/pg0-build-home"
"$PYTHON" - "$STAGE/memory/runtime/models" <<'PY'
import sys
from huggingface_hub import snapshot_download
snapshot_download('Xenova/multilingual-e5-small', revision='761b726d', local_dir=sys.argv[1]+'/Xenova/multilingual-e5-small',
                  allow_patterns=['*.json','onnx/model_int8.onnx','sentencepiece.bpe.model'])
PY
[[ $(shasum -a 256 "$STAGE/memory/runtime/models/Xenova/multilingual-e5-small/onnx/model_int8.onnx" | cut -d' ' -f1) == 4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c ]] || { echo 'ONNX input digest mismatch'; exit 1; }
HOME="$STAGE/pg0-build-home" CFFIXED_USER_HOME="$STAGE/pg0-build-home" "$PYTHON" - <<'PY'
from pg0 import Pg0
pg = Pg0(name='dsh-bot-build')
try:
    pg.start()
finally:
    pg.stop()
PY
[[ -x "$STAGE/pg0-build-home/.pg0/installation/18.1.0/bin/postgres" ]]
rm -rf "$STAGE/memory/runtime/pg0/installation/18.1.0"
cp -R "$STAGE/pg0-build-home/.pg0/installation/18.1.0" "$STAGE/memory/runtime/pg0/installation/"
(cd "$ROOT/product/memory" && "$STAGE/memory-venv/bin/pyinstaller" HindsightAPI.spec --distpath "$STAGE/memory-dist" --workpath "$STAGE/memory-build" --noconfirm)
rm -rf "$STAGE/memory/runtime/hindsight"
cp -R "$STAGE/memory-dist/HindsightAPI" "$STAGE/memory/runtime/hindsight"
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 "$STAGE/memory/runtime/hindsight/HindsightAPI" --check-embeddings "$STAGE/memory/runtime/models/Xenova/multilingual-e5-small"
for name in sidecar.mjs scripts adapter; do rm -rf "$STAGE/memory/$name"; cp -R "$ROOT/product/memory/$name" "$STAGE/memory/"; done
node "$ROOT/product/memory/scripts/gen-version.mjs" "$STAGE/memory"
