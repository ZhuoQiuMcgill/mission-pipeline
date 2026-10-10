#!/usr/bin/env bash
# Exploratory probe (not a gate), design 6.5 / §14 item 2: under the subscription
# login, does Claude Code send its model requests through a local metering proxy
# set with ANTHROPIC_BASE_URL, and can the proxy read the usage of each request?
# It makes ONE small real model request. Checks:
#  1. the model request went through the proxy, authenticated (Bearer), status 200;
#  2. the proxy read usage from the streamed response (input incl. cache, output);
#  3. the request body in bytes is >= the total input tokens (the design's input bound);
#  4. claude printed the expected reply.
# Not covered here: agreement with account-side usage (tokenhud), concurrency,
# proxy or host death mid-request. Exits non-zero on any failed check.
set -u
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'kill $PID 2>/dev/null; rm -rf "$T"' EXIT
node "$HERE/probe-metering-proxy-server.mjs" "$T/log.jsonl" > "$T/port" & PID=$!
for i in $(seq 1 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT=$(cat "$T/port")
out=$(cd "$T" && timeout 180 env ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" claude -p "Reply with exactly: proxied-ok" --safe-mode < /dev/null 2>/dev/null)
sleep 1
post=$(grep '"method":"POST"' "$T/log.jsonl" | grep '/v1/messages' | head -1)
check "model request went through the proxy, Bearer auth, status 200" '[[ "$post" == *"\"status\":200"* && "$post" == *"\"auth\":\"bearer\""* ]]'
check "proxy read usage from the streamed response" '[[ "$post" == *"input_tokens"* && "$post" == *"output_tokens"* ]]'
bytes=$(printf '%s' "$post" | python3 -c 'import json,sys; print(json.load(sys.stdin)["bodyBytes"])')
intok=$(printf '%s' "$post" | python3 -c '
import json,re,sys
u=json.load(sys.stdin)["usages"][0]
d={k:int(v) for k,v in re.findall(r"\"(input_tokens|cache_read_input_tokens|cache_creation_input_tokens)\":(\d+)",u)}
print(sum(d.values()))')
check "body bytes ($bytes) >= total input tokens ($intok)" '[ "$bytes" -ge "$intok" ]'
check "claude printed the expected reply" '[[ "$out" == *"proxied-ok"* ]]'
exit $fail
