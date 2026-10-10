#!/usr/bin/env bash
# Probe: update the target branch and a protected completion-marker ref in one atomic git ref transaction.
# Expect: both refs move together; when the branch's old value does not match, neither ref moves.
set -eu
R=$(mktemp -d); cd "$R"; git init -q
c() { git -c user.name=p -c user.email=p@l commit -q --allow-empty -m "$1"; git rev-parse HEAD; }
A=$(c A); B=$(c B); git update-ref refs/heads/main "$A"
printf 'start\nupdate refs/heads/main %s %s\ncreate refs/mission-pipeline/ops/op-1 %s\nprepare\ncommit\n' "$B" "$A" "$B" | git update-ref --stdin >/dev/null
[ "$(git rev-parse refs/heads/main)" = "$B" ] && [ "$(git rev-parse refs/mission-pipeline/ops/op-1)" = "$B" ] || { echo "FAIL: refs did not move together"; exit 1; }
git update-ref refs/heads/main "$A"
if printf 'start\nupdate refs/heads/main %s %s\ncreate refs/mission-pipeline/ops/op-2 %s\nprepare\ncommit\n' "$B" "$B" "$B" | git update-ref --stdin >/dev/null 2>&1; then echo "FAIL: mismatched old value committed"; exit 1; fi
git rev-parse --verify -q refs/mission-pipeline/ops/op-2 >/dev/null && { echo "FAIL: marker written without branch update"; exit 1; }
echo "PASS: atomic branch + marker update; mismatch aborts both"; rm -rf "$R"
