#!/bin/sh
set -eu
TENVYR_SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$#" -lt 1 ]; then echo 'usage: java-backend.sh control-plane|gateway|agents|executor-host|operations [args]' >&2; exit 2; fi
TENVYR_MODULE=$1
shift
case "$TENVYR_MODULE" in
  control-plane) TENVYR_MAIN=io.tenvyr.control.Main ;;
  gateway) TENVYR_MAIN=io.tenvyr.gateway.Gateway ;;
  agents) TENVYR_MAIN=io.tenvyr.agents.Main ;;
  executor-host) TENVYR_MAIN=io.tenvyr.executorhost.Main ;;
  operations) TENVYR_MAIN=io.tenvyr.operations.Main ;;
  *) echo 'unknown Java backend module' >&2; exit 2 ;;
esac
if [ ! -d "$TENVYR_SCRIPT_ROOT/backend/$TENVYR_MODULE/target/dependency" ]; then echo 'Run scripts/backend-build.sh before launching the Java backend.' >&2; exit 2; fi
cd "$TENVYR_SCRIPT_ROOT"
exec "${TENVYR_JAVA_EXECUTABLE:-java}" -cp "$TENVYR_SCRIPT_ROOT/backend/$TENVYR_MODULE/target/classes:$TENVYR_SCRIPT_ROOT/backend/$TENVYR_MODULE/target/dependency/*" "$TENVYR_MAIN" "$@"
