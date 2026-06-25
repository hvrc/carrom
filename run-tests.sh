#!/usr/bin/env bash
# One-shot local verification: server tests, client tests, client build.
# Usage: ./run-tests.sh
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
fail=0

echo "══ server tests ══════════════════════════════════════════════"
( cd "$ROOT/server" && npm test ) || fail=1

echo ""
echo "══ client tests ══════════════════════════════════════════════"
( cd "$ROOT/client" && npm test ) || fail=1

echo ""
echo "══ client build ══════════════════════════════════════════════"
if ( cd "$ROOT/client" && npm run build >/tmp/carrom_build.log 2>&1 ); then
  grep -E "built in|dist/" /tmp/carrom_build.log | tail -3
  echo "build OK"
else
  echo "build FAILED:"; tail -20 /tmp/carrom_build.log; fail=1
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASS ✅"
else
  echo "CHECKS FAILED ❌"
fi
exit $fail
