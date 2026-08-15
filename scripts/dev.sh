#!/bin/sh
# One-command dev lifecycle (`pnpm dev`): Compose infrastructure plus the
# orchestrator, gateway, and frontend in parallel watch mode. Ctrl-C (or any
# exit) tears down the Compose stack too; named volumes are kept, so dev data
# survives. ponytail: SIGKILL bypasses the trap and leaves infra running —
# recover with `pnpm dev:infra:down`.
set -e

cd "$(dirname "$0")/.."

set -a
if [ -f .env ]; then . ./.env; fi
set +a
export POSTGRES_PORT="${TENVYR_POSTGRES_PORT:-${POSTGRES_PORT:-5432}}"

docker compose up -d postgres redis zookeeper kafka kafka-ui

down() {
  trap - EXIT INT TERM
  docker compose down >/dev/null 2>&1 || true
}
trap down EXIT INT TERM

pnpm --parallel --filter orchestrator --filter gateway --filter frontend run start:dev
