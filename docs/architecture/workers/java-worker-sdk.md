---
title: Java Worker SDK
status: current
audience:
  - developer
last_verified: 2026-09-15
sources:
  - sdks/java-worker/src/main/java/com/tenvyr/worker/Hmac.java
  - sdks/java-worker/src/main/java/com/tenvyr/worker/TenvyrWorker.java
  - sdks/java-worker/src/test/java/com/tenvyr/worker/HmacTest.java
  - sdks/java-worker/src/test/java/com/tenvyr/worker/WorkerProtocolTest.java
  - scripts/sync-java-worker-schemas.py
  - contracts/conformance/callback-signatures/vectors.json
---

# Java Worker SDK

`com.tenvyr:tenvyr-worker` version `0.1.0` is a private JDK 17 HTTP worker
for the asynchronous HTTP Agent protocol. It is independent from the
TypeScript and Python SDKs and does not import them. It does not replace
the Orchestrator, Gateway, or the Java Agent Runner.

The distribution is unpublished (`Private :: Do Not Upload` intent): no
Maven Central publication. Jackson Databind is the only runtime
dependency; the HTTP surface is `com.sun.net.httpserver.HttpServer`.

## Wire surface

The Worker exposes only `POST /v1/runs`, `GET /health/live`, and
`GET /health/ready`. Successful submit is `202` plus
`HttpAgentRunAcceptedV1`. Terminal results travel on the signed callback.
HMAC uses the protocol-v1 headers `X-AgentWeave-Key-Id`,
`X-AgentWeave-Timestamp`, `X-AgentWeave-Delivery-Id`, and
`X-AgentWeave-Signature` over `timestamp.deliveryId.rawBody`.

Integers follow the
[JSON interoperability](../contracts/json-interoperability.md) safe range.
Five schema resources are byte-copies of `contracts/schemas`; keep them
in sync with `python3 scripts/sync-java-worker-schemas.py check`.

## Limits versus TypeScript/Python

Process-local idempotency and queue. AgentEvents are not implemented;
the canonical result remains terminal authority. No Orchestrator
loopback gate in this slice (mock callback server only).

## Verification

```bash
python3 scripts/sync-java-worker-schemas.py check
mvn -B -f sdks/java-worker/pom.xml test
```
