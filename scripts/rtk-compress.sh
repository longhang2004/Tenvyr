#!/bin/sh

# Delegate command mode to RTK when installed. Filter mode (no arguments) stays
# local so piped input has the same deterministic behavior on every machine.
if [ "$#" -gt 0 ] && command -v rtk >/dev/null 2>&1; then
  exec rtk "$@"
fi

umask 077
raw_file=$(mktemp "${TMPDIR:-/tmp}/tenvyr-rtk-raw.XXXXXX") || exit 1
filtered_file=$(mktemp "${TMPDIR:-/tmp}/tenvyr-rtk-filtered.XXXXXX") || {
  rm -f "$raw_file"
  exit 1
}
trap 'rm -f "$raw_file" "$filtered_file"' 0 HUP INT TERM

command_status=0
if [ "$#" -gt 0 ]; then
  "$@" >"$raw_file" 2>&1 || command_status=$?
else
  cat >"$raw_file" || command_status=$?
fi

# Keep this filter intentionally small: adjacent duplicate lines and common
# download progress noise are the only content removed before bounding output.
if ! awk '
  /Downloading from|Downloaded from|Progress \(/ { next }
  seen && $0 == previous { next }
  { print; previous = $0; seen = 1 }
' "$raw_file" >"$filtered_file"; then
  cp "$raw_file" "$filtered_file" 2>/dev/null || true
fi

if [ ! -s "$filtered_file" ]; then
  printf '(Empty output)\n'
else
  line_count=$(awk 'END { print NR }' "$filtered_file")
  if [ "$line_count" -gt 200 ]; then
    head -n 100 "$filtered_file"
    printf '\n... [RTK fallback: omitted %s lines] ...\n\n' "$((line_count - 200))"
    tail -n 100 "$filtered_file"
  else
    cat "$filtered_file"
  fi
fi

exit "$command_status"
