#!/bin/sh
set -eu
TENVYR_SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$TENVYR_SCRIPT_ROOT"

TENVYR_CHECK_MODE=${1:-}
case "$TENVYR_CHECK_MODE" in
  unit|integration) ;;
  *)
    echo "usage: review-checks.sh [unit|integration]" >&2
    exit 2
    ;;
esac

case "$TENVYR_CHECK_MODE" in
  unit)
    echo "==> Running review-api unit checks (Maven reactor test)..."
    mvn -B -f backend/pom.xml -pl review-api -am test
    ;;
  integration)
    DB_URL="${TENVYR_REVIEW_TEST_DATABASE_URL:-}"
    if [ -z "$DB_URL" ]; then
      echo "ERROR: Missing test database URL." >&2
      exit 1
    fi

    # Validate test database URL with standard Node parser without credential/URL exposure
    DB_URL="$DB_URL" node -e '
      const raw = process.env.DB_URL || "";
      if (!raw) process.exit(1);
      if (!raw.startsWith("jdbc:postgresql://")) {
        process.exit(3);
      }
      let parsed;
      try {
        parsed = new URL(raw.slice(5));
      } catch {
        process.exit(2);
      }
      if (raw.includes("#") || parsed.hash) {
        process.exit(2);
      }
      if (parsed.protocol !== "postgresql:" || !parsed.hostname) {
        process.exit(3);
      }
      let dbName;
      try {
        dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
      } catch {
        process.exit(2);
      }
      if (!dbName || !/(?:test|scratch|disposable)/i.test(dbName)) {
        process.exit(4);
      }
      const forbidden = new Set([
        "pgdbname",
        "pghost",
        "pgport",
        "service",
        "dbname",
        "databasename",
        "database",
        "host",
        "port"
      ]);
      const qIndex = raw.indexOf("?");
      if (qIndex !== -1) {
        const queryPart = raw.slice(qIndex + 1);
        const pairs = queryPart.split("&");
        for (const pair of pairs) {
          if (!pair) continue;
          const eq = pair.indexOf("=");
          const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
          let decodedKey;
          try {
            decodedKey = decodeURIComponent(rawKey).trim().toLowerCase();
          } catch {
            process.exit(2);
          }
          if (forbidden.has(decodedKey)) {
            process.exit(5);
          }
        }
      }
    ' || {
      _ec=$?
      case "$_ec" in
        1) echo "ERROR: Missing test database URL." >&2 ;;
        2) echo "ERROR: Malformed test database URL." >&2 ;;
        3) echo "ERROR: Test database URL must be a valid PostgreSQL JDBC URL." >&2 ;;
        4) echo "ERROR: Refusing non-disposable test database. Database name must contain test, scratch, or disposable." >&2 ;;
        5) echo "ERROR: Test database URL must not override database routing in query parameters." >&2 ;;
        *) echo "ERROR: Invalid test database URL." >&2 ;;
      esac
      exit 1
    }

    echo "==> Running review-api integration checks against verified disposable test database..."
    export TENVYR_REVIEW_TEST_DATABASE_URL="$DB_URL"
    mvn -B -f backend/pom.xml -pl review-api -am verify -Preview-integration
    ;;
esac
