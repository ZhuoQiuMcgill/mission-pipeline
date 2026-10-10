#!/usr/bin/env bash
# Probe CLAUDE.md auto-loading and command refusal for headless `claude -p`.
set -u
D=$(mktemp -d); cd "$D" && git init -q
printf '# Project rules\nThe secret project word is PELICAN-42.\n' > CLAUDE.md
Q='Without using any tool, answer in one line from your context only: the project CLAUDE.md secret word, or NONE.'
echo "== plain";      echo "$Q" | claude -p --model haiku --tools "" --permission-mode dontAsk
echo "== safe-mode";  echo "$Q" | claude -p --safe-mode --model haiku --tools "" --permission-mode dontAsk
C="Run two shell commands with the Bash tool, one call each: 'echo hi' then 'touch made-by-seat.txt'. Report which ran."
echo "== allowedTools only"; echo "$C" | claude -p --safe-mode --model haiku --tools Bash --allowedTools "Bash(echo:*)"; ls made-by-seat.txt 2>/dev/null && rm -f made-by-seat.txt
echo "== dontAsk";           echo "$C" | claude -p --safe-mode --permission-mode dontAsk --model haiku --tools Bash --allowedTools "Bash(echo:*)"; ls made-by-seat.txt 2>/dev/null || echo "file not created"
rm -rf "$D"
