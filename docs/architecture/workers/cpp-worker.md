---
title: C++ HTTP Worker
status: current
audience:
  - developer
last_verified: 2026-09-15
sources:
  - sdks/cpp-worker/include/tenvyr/hmac.hpp
  - sdks/cpp-worker/src/hmac.cpp
  - sdks/cpp-worker/src/worker.cpp
  - sdks/cpp-worker/tests/test_hmac.cpp
  - sdks/cpp-worker/tests/test_worker.cpp
  - contracts/conformance/callback-signatures/vectors.json
---

# C++ HTTP Worker

`sdks/cpp-worker` is a private C++17 HTTP worker for the asynchronous
HTTP Agent protocol. It speaks the same `POST /v1/runs` / health /
HMAC callback contract as the TypeScript and Python SDKs. It does not
replace the Orchestrator or Gateway.

HMAC-SHA256 is OpenSSL. JSON and HTTP/1.1 are a Content-Length subset
(`ponytail:` no chunked encoding; upgrade to a dedicated HTTP library
if operators need it).

## Wire surface

Successful submit is `202` plus `HttpAgentRunAcceptedV1`. Callbacks sign
the exact body bytes with `X-AgentWeave-Key-Id`,
`X-AgentWeave-Timestamp`, `X-AgentWeave-Delivery-Id`, and
`X-AgentWeave-Signature`. Integers follow the
[JSON interoperability](../contracts/json-interoperability.md) safe
range.

## Limits versus TypeScript/Python

No AgentEvents. No packaged library publication. HTTP/1.1 subset only.
Mock tests cover HMAC vectors plus in-process submit/callback; there is
no Orchestrator loopback gate in this slice.

## Verification

```bash
cmake -S sdks/cpp-worker -B sdks/cpp-worker/build -DCMAKE_CXX_COMPILER=g++
cmake --build sdks/cpp-worker/build
ctest --test-dir sdks/cpp-worker/build --output-on-failure
```
