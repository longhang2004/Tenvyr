#!/bin/sh
set -eu
TENVYR_SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TENVYR_CHECK_MODE=${1:-pure}
case "$TENVYR_CHECK_MODE" in pure|--integration) ;; *) echo 'usage: backend-checks.sh [pure|--integration]' >&2; exit 2 ;; esac
cd "$TENVYR_SCRIPT_ROOT"
TENVYR_CHECK_COUNT=0
run_check() {
  TENVYR_CHECK_MODULE=$1
  TENVYR_CHECK_CLASS=$2
  shift 2
  TENVYR_CHECK_PATH=$(echo "$TENVYR_CHECK_CLASS" | tr . /)
  test -f "backend/$TENVYR_CHECK_MODULE/target/test-classes/$TENVYR_CHECK_PATH.class" || { echo "Required check missing: $TENVYR_CHECK_CLASS. Run scripts/backend-build.sh." >&2; exit 1; }
  test -d "backend/$TENVYR_CHECK_MODULE/target/dependency" || { echo "Runtime dependencies missing: $TENVYR_CHECK_MODULE" >&2; exit 1; }
  "${TENVYR_JAVA_EXECUTABLE:-java}" -ea -cp "backend/$TENVYR_CHECK_MODULE/target/test-classes:backend/$TENVYR_CHECK_MODULE/target/classes:backend/$TENVYR_CHECK_MODULE/target/dependency/*:backend/worker/target/classes:backend/agents/target/classes:backend/executor-host/target/classes" "$TENVYR_CHECK_CLASS" "$TENVYR_SCRIPT_ROOT" "$@"
  TENVYR_CHECK_COUNT=$((TENVYR_CHECK_COUNT + 1))
}
run_check platform io.tenvyr.platform.FoundationCheck
run_check control-plane io.tenvyr.control.ControlCheck
run_check control-plane io.tenvyr.control.engine.EngineCheck
run_check control-plane io.tenvyr.control.runtime.RuntimeCheck
run_check gateway io.tenvyr.gateway.GatewayPureCheck
run_check agents io.tenvyr.agents.AgentCheck
run_check worker io.tenvyr.worker.WorkerCheck
run_check executor-host io.tenvyr.executorhost.ExecutorHostCheck
run_check operations io.tenvyr.operations.OperationsCheck
if [ "$TENVYR_CHECK_MODE" = --integration ]; then
  run_check platform io.tenvyr.platform.FoundationIntegrationCheck
  node scripts/backend-canonical-check.mjs
  node scripts/backend-database-check.mjs
  run_check control-plane io.tenvyr.control.engine.EngineIntegrationCheck --integration
  run_check control-plane io.tenvyr.control.ControlIntegrationCheck
  run_check control-plane io.tenvyr.control.ControlKafkaIntegrationCheck
  run_check control-plane io.tenvyr.control.RuntimeIntegrationCheck
  UNCONFIGURED_PARENT_SECRET=must-not-inherit run_check control-plane io.tenvyr.control.NativeRuntimeIntegrationCheck
  run_check control-plane io.tenvyr.control.WorkerSdkIntegrationCheck
  run_check gateway io.tenvyr.gateway.GatewayCheck
  node scripts/backend-socketio-check.mjs
  run_check agents io.tenvyr.agents.AgentIntegrationCheck
  run_check worker io.tenvyr.worker.WorkerIntegrationCheck
  run_check executor-host io.tenvyr.executorhost.ExecutorHostIntegrationCheck
  run_check operations io.tenvyr.operations.OperationsIntegrationCheck
fi
test "$TENVYR_CHECK_COUNT" -gt 0
echo "Java backend checks PASS: executed $TENVYR_CHECK_COUNT check programs ($TENVYR_CHECK_MODE)"
