# tenvyr-worker (Java)

Private JDK 17 HTTP worker for Tenvyr protocol v1. See
`docs/architecture/workers/java-worker-sdk.md`.

```bash
python3 scripts/sync-java-worker-schemas.py check
mvn -B -f sdks/java-worker/pom.xml test
TENVYR_JAVA_EXECUTABLE=java pnpm --filter orchestrator test:java-worker-loopback
```
