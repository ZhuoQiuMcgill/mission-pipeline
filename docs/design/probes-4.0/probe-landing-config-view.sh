#!/usr/bin/env bash
# Exploratory probe (not a gate): run the landing push and the post-landing check
# inside a bubblewrap mount namespace that shows git only a program-built
# configuration view, with the environment cleared.
#
# A default-location .git/hooks/post-index-change hook also appends to the marker,
# and the sequence builds a temporary index with read-tree (as landing admission
# does), so hooks are exercised too.
#
# A filter whose commands append to an ABSOLUTE marker path (baked into the command
# text, so it does not depend on any environment variable) is defined in the repo
# config, the global config, and injected through GIT_CONFIG_COUNT/KEY/VALUE. The
# view keeps the attribute mapping (*.dat filter=evil), so the filter IS requested;
# only its definition is absent.
#
# Two groups run the IDENTICAL sequence (reset to A, push B, force a content
# re-read so clean is invoked, refresh, diff-files, status) and differ only in
# --clearenv. The negative group must leave a clean mark from the check commands
# (proving the marker works and the injected definition is live outside the view);
# the positive group must leave none and still update the checkout. Exits non-zero on any
# failed check.
set -u
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
MARK="$T/filter-ran"
git init -q -b main "$T/r" && cd "$T/r"
git config user.email p@example.invalid && git config user.name probe
echo one > f.txt && git add f.txt && git commit -qm A
A=$(git rev-parse HEAD)
B=$(git commit-tree -p "$A" -m B "$(printf '100644 blob %s\tf.txt\n100644 blob %s\tg.dat\n' \
  "$(echo two | git hash-object -w --stdin)" "$(echo payload | git hash-object -w --stdin)" | git mktree)")
git update-ref refs/mission-pipeline/delivered/m1/op1 "$B"

# Hostile definitions in every source; each command writes its own tag to $MARK.
SMUDGE="sh -c 'echo smudge >> $MARK; cat'"; CLEAN="sh -c 'echo clean >> $MARK; cat'"
git config filter.evil.smudge "$SMUDGE"; git config filter.evil.clean "$CLEAN"
mkdir -p .git/info && echo '*.dat filter=evil' > .git/info/attributes
# A default-location hook that runs whenever the index is written.
mkdir -p .git/hooks && printf '#!/bin/sh\necho hook >> %s\n' "$MARK" > .git/hooks/post-index-change && chmod +x .git/hooks/post-index-change
mkdir -p "$T/home"; git config -f "$T/home/.gitconfig" filter.evil.smudge "$SMUDGE"
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=filter.evil.smudge GIT_CONFIG_VALUE_0="$SMUDGE" \
       GIT_CONFIG_KEY_1=filter.evil.clean GIT_CONFIG_VALUE_1="$CLEAN"

# The view: only non-executing core keys, plus hooksPath forced to an empty
# read-only directory (dropping the key would fall back to .git/hooks), and an
# info/attributes copy that KEEPS the mapping. The same empty directory is also
# mounted over .git/hooks.
mkdir "$T/no-hooks"; chmod 555 "$T/no-hooks"
printf '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\thooksPath = %s\n\tfsmonitor = false\n' "$T/no-hooks" > "$T/view-config"
printf '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tfsmonitor = false\n' > "$T/view-config-noguard"
echo '*.dat filter=evil' > "$T/view-attributes"; mkdir "$T/view-home"
RP='git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c receive.denyCurrentBranch=updateInstead receive-pack'
view() {  # $1 = clear|inherit|noguard (cleared env, but no hook guard), rest = command
  local mode=$1; shift
  local env=(); [ "$mode" != inherit ] && env=(--clearenv --setenv PATH /usr/bin:/bin --setenv LANG C.UTF-8)
  local guard=(--ro-bind "$T/view-config" "$T/r/.git/config" --ro-bind "$T/no-hooks" "$T/r/.git/hooks")
  [ "$mode" = noguard ] && guard=(--ro-bind "$T/view-config-noguard" "$T/r/.git/config")
  bwrap --dev-bind / / "${env[@]}" "${guard[@]}" \
    --ro-bind "$T/view-attributes" "$T/r/.git/info/attributes" \
    --bind "$T/view-home" "$T/home" \
    --setenv HOME "$T/home" --setenv GIT_CONFIG_NOSYSTEM 1 --setenv GIT_CONFIG_GLOBAL /dev/null \
    --setenv GIT_ATTR_NOSYSTEM 1 -- "$@"; }
# Every step's exit status is checked; a failing check command fails the group.
# diff-files exits 1 when it sees a difference, which is a valid outcome here
# (the back-dated file may compare unequal under a clean filter), so it must exit 0 or 1.
SEQ='cd "$1" && git -c core.hooksPath=/dev/null push -q --receive-pack="$2" . \
       refs/mission-pipeline/delivered/m1/op1:refs/heads/main --force-with-lease="refs/heads/main:$3" || exit 10
     GIT_INDEX_FILE="$(mktemp -u /tmp/probe-idx.XXXXXX)" git read-tree "$4" || exit 16
     touch -d "2000-01-01" g.dat || exit 12
     git update-index -q --refresh; r=$?; [ $r -le 1 ] || exit 13
     git diff-files --quiet; r=$?; [ $r -le 1 ] || exit 14
     git status --porcelain >/dev/null || exit 15
     [ "$(git rev-parse HEAD)" = "$4" ] || exit 11'
run_group() {  # $1 = clear|inherit; leaves rc in $rc
  # Setup runs outside any view, so hooks are disabled for it explicitly, and the
  # marker is cleared only after setup.
  git update-ref refs/heads/main "$A"; git -c core.hooksPath=/dev/null reset -q --hard "$A"; rm -f g.dat; rm -f "$MARK"
  view "$1" sh -c "$SEQ" sh "$T/r" "$RP" "$A" "$B" >/dev/null 2>&1; rc=$?; }

# Hazard group: no view at all, same sequence. The repository's own config is
# visible to the receiving side, so smudge runs during the push and clean during the check.
git update-ref refs/heads/main "$A"; git -c core.hooksPath=/dev/null reset -q --hard "$A"; rm -f g.dat; rm -f "$MARK"
sh -c "$SEQ" sh "$T/r" "$RP" "$A" "$B" >/dev/null 2>&1; rc=$?
check "hazard group: without the view, smudge ran in the push, clean and the index hook in the check (rc=$rc)" \
  '[ $rc -eq 0 ] && grep -q smudge "$MARK" && grep -q clean "$MARK" && grep -q hook "$MARK"'

# Negative group: environment inherited -> injected definitions visible.
run_group inherit
check "negative group: sequence completed (rc=$rc)" '[ $rc -eq 0 ]'
# Observed on git 2.53: a local push resets the receiving side's environment, so the
# injected definition never reaches receive-pack's checkout (no smudge mark); the
# post-landing check commands run with the caller's environment and DO run clean.
check "negative group: injected clean ran during the post-landing check" 'grep -q clean "$MARK"'
check "negative group (observation): receive side did not see the injected smudge" '! grep -q smudge "$MARK"'

# Hook control: environment cleared, but the view leaves core.hooksPath unset and
# .git/hooks visible. git falls back to the default hooks directory and the index
# hook runs: dropping the key is not the same as disabling hooks.
run_group noguard
check "hook control: without the hook guard the default index hook ran inside the view" 'grep -q hook "$MARK" && ! grep -q smudge "$MARK" && ! grep -q clean "$MARK"'

# Positive group: environment cleared -> no definition anywhere in view.
run_group clear
check "positive group: sequence completed and checkout updated (rc=$rc)" \
  '[ $rc -eq 0 ] && [ "$(cat f.txt)" = two ] && [ "$(cat g.dat)" = payload ]'
check "positive group: the mapping is in effect inside the view" \
  '[ "$(view clear git -C "$T/r" check-attr filter g.dat)" = "g.dat: filter: evil" ]'
check "positive group: no filter and no hook ran in push, temp-index build or check" '[ ! -e "$MARK" ]'
check "real config untouched by the view" '[ "$(git config --file .git/config filter.evil.clean)" = "$CLEAN" ]'

exit $fail
