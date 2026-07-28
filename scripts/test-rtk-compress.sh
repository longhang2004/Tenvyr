#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WRAPPER="$SCRIPT_DIR/rtk-compress.sh"
TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/tenvyr-rtk-test.XXXXXX")
trap 'rm -rf "$TEST_TMP"' 0 HUP INT TERM

mkdir "$TEST_TMP/bin"
mkdir "$TEST_TMP/wrapper-tmp"
for utility in awk cat cp head mktemp rm tail; do
  ln -s "$(command -v "$utility")" "$TEST_TMP/bin/$utility"
done
NO_RTK_PATH="$TEST_TMP/bin"
WRAPPER_TMP="$TEST_TMP/wrapper-tmp"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_equal() {
  if [ "$1" != "$2" ]; then
    printf 'expected:\n%s\nactual:\n%s\n' "$2" "$1" >&2
    fail "$3"
  fi
  printf 'ok - %s\n' "$3"
}

output=$(PATH="$NO_RTK_PATH" TMPDIR="$WRAPPER_TMP" "$WRAPPER" /usr/bin/printf 'alpha\nbeta\n')
assert_equal "$output" "alpha
beta" "fallback preserves multiline output"

if output=$(PATH="$NO_RTK_PATH" TMPDIR="$WRAPPER_TMP" "$WRAPPER" /bin/sh -c 'printf "failed safely\n"; exit 37'); then
  status=0
else
  status=$?
fi
assert_equal "$status" "37" "fallback preserves the wrapped command exit status"
assert_equal "$output" "failed safely" "failed command output remains visible"

literal='$(touch should-not-exist); still literal'
output=$(cd "$TEST_TMP" && PATH="$NO_RTK_PATH" TMPDIR="$WRAPPER_TMP" "$WRAPPER" /usr/bin/printf '%s\n' "$literal")
assert_equal "$output" "$literal" "arguments are passed without evaluation"
[ ! -e "$TEST_TMP/should-not-exist" ] || fail "argument text executed as shell code"

output=$(/usr/bin/printf 'same\nsame\nDownloading from mirror\nkept\n' | PATH="$NO_RTK_PATH" TMPDIR="$WRAPPER_TMP" "$WRAPPER")
assert_equal "$output" "same
kept" "stdin filter mode compresses adjacent and download noise"

output=$(PATH="$NO_RTK_PATH" TMPDIR="$WRAPPER_TMP" "$WRAPPER" /usr/bin/awk 'BEGIN { for (i = 1; i <= 10000; i++) print "line-" i }')
printf '%s\n' "$output" | /usr/bin/grep -qx 'line-1' || fail "large output lost its first line"
printf '%s\n' "$output" | /usr/bin/grep -qx 'line-10000' || fail "large output lost its last line"
printf '%s\n' "$output" | /usr/bin/grep -q 'omitted 9800 lines' || fail "large output did not report compression"
printf 'ok - large output is file-backed and bounded\n'

output=$(PATH="$NO_RTK_PATH" TMPDIR="$WRAPPER_TMP" "$WRAPPER" /usr/bin/awk 'BEGIN { for (i = 1; i <= 200; i++) print "logical-" i; printf "logical-201" }')
printf '%s\n' "$output" | /usr/bin/grep -qx 'logical-1' || fail "unterminated output lost its first line"
printf '%s\n' "$output" | /usr/bin/grep -qx 'logical-201' || fail "unterminated output lost its final line"
printf '%s\n' "$output" | /usr/bin/grep -q 'omitted 1 lines' || fail "unterminated final line bypassed the 200-line bound"
printf 'ok - unterminated final lines count toward the output bound\n'

[ -z "$(/usr/bin/find "$WRAPPER_TMP" -type f -print -quit)" ] || fail "fallback left temporary files behind"
printf 'ok - temporary files are removed\n'
