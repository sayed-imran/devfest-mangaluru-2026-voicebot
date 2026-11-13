#!/usr/bin/env bash
# Check every Spark service the way an attendee laptop will see it.
#   ./smoke.sh                  # against localhost, on the Spark itself
#   ./smoke.sh spark-065b.local       # from a laptop on the workshop network
set -uo pipefail
HOST="${1:-127.0.0.1}"
fail=0
check() {
  if out=$(curl -fsS --max-time 60 "$@" 2>&1); then echo "  ok    $1"; else echo "  FAIL  $1  ${out:0:200}"; fail=1; fi
}
echo "==> Spark at $HOST"
check "http://$HOST:8081/v1/models"
check "http://$HOST:8081/v1/chat/completions" -H 'Content-Type: application/json' \
  -d '{"model":"gemma4-26b","max_tokens":16,"messages":[{"role":"user","content":"Say hello in five words."}]}'
check "http://$HOST:8001/v1/models"
check "http://$HOST:8880/v1/audio/voices"
check "http://$HOST:8002/health"
exit $fail
