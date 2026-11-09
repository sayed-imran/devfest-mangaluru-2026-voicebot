#!/usr/bin/env bash
# Start LiteRT-LM's OpenAI-compatible server for the workshop.
#
#   ./litert/serve.sh                # gemma4-e4b (laptop default)
#   ./litert/serve.sh gemma4-e2b     # Raspberry Pi / 8GB machines
#   ./litert/serve.sh gemma4-26b     # DGX Spark
#
# Imports the model into the local registry on first run, then serves it on :8081.
set -euo pipefail

ALIAS="${1:-gemma4-e4b}"
HOST="${LITERT_HOST:-127.0.0.1}"
PORT="${LITERT_PORT:-8081}"

case "$ALIAS" in
  gemma4-e2b) REPO="litert-community/gemma-4-E2B-it-litert-lm";     FILE="gemma-4-E2B-it.litertlm" ;;
  gemma4-e4b) REPO="litert-community/gemma-4-E4B-it-litert-lm";     FILE="gemma-4-E4B-it.litertlm" ;;
  gemma4-12b) REPO="litert-community/gemma-4-12B-it-litert-lm";     FILE="gemma-4-12B-it.litertlm" ;;
  gemma4-26b) REPO="litert-community/gemma-4-26B-A4B-it-litert-lm"; FILE="gemma-4-26B-A4B-it.litertlm" ;;
  *)
    echo "Unknown alias: $ALIAS" >&2
    echo "Use one of: gemma4-e2b, gemma4-e4b, gemma4-12b, gemma4-26b" >&2
    exit 1
    ;;
esac

if ! command -v litert-lm >/dev/null 2>&1; then
  echo "litert-lm is not installed. Run:  uv tool install litert-lm" >&2
  exit 1
fi

if ! litert-lm list 2>/dev/null | grep -q "$ALIAS"; then
  echo "==> Importing $REPO as '$ALIAS' (first run only, this downloads weights)"
  litert-lm import --from-huggingface-repo="$REPO" "$FILE" "$ALIAS"
fi

echo "==> Serving '$ALIAS' on http://$HOST:$PORT/v1"
echo "    Point the app's LLM_BASE_URL at that address and LLM_MODEL at '$ALIAS'."
exec litert-lm serve --host "$HOST" --port "$PORT"
