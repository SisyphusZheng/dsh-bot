#!/bin/bash
set -euo pipefail
umask 077
PAYLOAD=$(cd "$(dirname "$0")/.." && pwd)
: "${NISSE_M1C_ROOT:?private runtime root required}"
: "${NISSE_M1C_PORT:?private loopback port required}"
export HOME="$NISSE_M1C_ROOT/home" CFFIXED_USER_HOME="$NISSE_M1C_ROOT/home"
export TMPDIR="$NISSE_M1C_ROOT/tmp" XDG_CACHE_HOME="$NISSE_M1C_ROOT/cache" XDG_DATA_HOME="$NISSE_M1C_ROOT/data"
mkdir -p "$HOME" "$TMPDIR" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
# pg0's cache contract. Copy only installation binaries; never reset its data directory.
PG_INSTALL="$HOME/.pg0/installation/18.1.0"
if [[ ! -x "$PG_INSTALL/bin/postgres" ]]; then
  mkdir -p "$(dirname "$PG_INSTALL")"
  PG_STAGE="$(dirname "$PG_INSTALL")/.18.1.0-$$"
  trap 'rm -rf "$PG_STAGE"' EXIT
  cp -R "$PAYLOAD/runtime/pg0/installation/18.1.0" "$PG_STAGE"
  test -x "$PG_STAGE/bin/postgres"
  rm -rf "$PG_INSTALL"
  mv "$PG_STAGE" "$PG_INSTALL"
fi
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export HINDSIGHT_API_HOST=127.0.0.1 HINDSIGHT_API_PORT="$NISSE_M1C_PORT"
export HINDSIGHT_API_DATABASE_URL=pg0
export HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx
export HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH="$PAYLOAD/runtime/models/Xenova/multilingual-e5-small/onnx/model_int8.onnx"
export HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH="$PAYLOAD/runtime/models/Xenova/multilingual-e5-small"
export HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS=384 HINDSIGHT_API_RERANKER_PROVIDER=rrf
export HINDSIGHT_API_RETAIN_EXTRACTION_MODE=chunks HINDSIGHT_API_ENABLE_OBSERVATIONS=false
export HINDSIGHT_API_LLM_PROVIDER=mock HINDSIGHT_API_LLM_MODEL=mock-model
exec "$PAYLOAD/runtime/hindsight/HindsightAPI" --host 127.0.0.1 --port "$NISSE_M1C_PORT"
