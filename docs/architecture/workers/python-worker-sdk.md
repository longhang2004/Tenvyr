---
title: Python Worker SDK
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
  - sdks/python-worker/pyproject.toml
  - sdks/python-worker/src/tenvyr_worker/__init__.py
  - sdks/python-worker/src/tenvyr_worker/_public/config.py
  - sdks/python-worker/src/tenvyr_worker/_public/context.py
  - sdks/python-worker/src/tenvyr_worker/_runtime/worker.py
  - sdks/python-worker/src/tenvyr_worker/_protocol/json_value.py
  - sdks/python-worker/src/tenvyr_worker/_runtime/canonical_json.py
  - sdks/python-worker/src/tenvyr_worker/_callback/delivery.py
  - sdks/python-worker/src/tenvyr_worker/_callback/retry.py
  - sdks/python-worker/tests/test_public_api.py
  - sdks/python-worker/tests/test_schema_protocol.py
  - sdks/python-worker/tests/test_lifecycle.py
  - scripts/verify-python-worker-package.py
---

# Python Worker SDK

## Status and scope

`tenvyr-worker` version `0.1.0` is a private, process-local Python runtime
harness for the asynchronous HTTP Agent protocol. It requires Python 3.11 or
newer and is implemented independently from the TypeScript Worker. It does not
import or execute TypeScript.

The distribution is intentionally unreleased: it has the classifier
`Private :: Do Not Upload`, declares the MIT license expression and file, and
has no publication configuration. PyPI, legal, registry, repository, and
public-package release decisions remain blocked.

## Boundaries

The package root is the sole compatibility surface. Definitions live under
`_public`; schema and contract work under `_protocol`; HTTP policy under
`_http`; execution, scheduling, lifecycle, and idempotency under `_runtime`;
and callback signing/delivery under `_callback`. All underscore namespaces are
internal and may change without compatibility guarantees.

Runtime dependencies are limited to two families:

- `aiohttp>=3.12,<4` for the server and callback client;
- `jsonschema[format-nongpl]>=4.23,<5` for Draft 2020-12 validation, with the
  installed `referencing` support used for an offline registry.

The five tracked schemas are package resources loaded with
`importlib.resources`. Runtime code never reads repository-relative contract
paths and the registry has no network retrieval callback.

## Submission and execution

The Worker exposes only `POST /v1/runs`, `GET /health/live`, and
`GET /health/ready`. Submission validates readiness, media type,
authentication, bounded streamed input, JSON, contracts, target agent,
idempotency, callback key, and exact callback origin before accepting work.

One `asyncio.Lock` protects the readiness recheck, duplicate/conflict lookup,
capacity checks, record creation, acceptance creation, and synchronous FIFO
enqueue. No handler or network await occurs inside this critical section.
Duplicate requests retain the original `runId` and `acceptedAt`.

Async handlers run as tasks. Sync handlers run through `asyncio.to_thread`; a
sync callable that returns an awaitable is subsequently awaited. Cancellation
is cooperative. A timed-out thread or cancellation-suppressing coroutine may
outlive Worker ownership, but terminal-result locking prevents late work from
changing records or sending a second callback.

## Callback and lifecycle guarantees

Results are validated, serialized once as compact finite UTF-8 JSON, and the
exact bytes are signed and sent. Delivery preserves the four protocol-v1 HMAC
headers, uses one stable delivery ID and body, creates a fresh timestamp and
signature per attempt, refuses redirects, bounds response reads, and retries
only network/timeout failures, `408`, `429`, and `5xx`. Numeric delta-seconds
`Retry-After` values are accepted only when they contain ASCII digits. Giant
values are capped using bounded string comparison without unbounded integer
conversion; invalid values and HTTP dates use calculated backoff.

All protocol integers, including integral-valued Python floats, must remain
within `-9007199254740991` through `9007199254740991`. Booleans remain
booleans, non-finite values are rejected, and genuine finite non-integers are
accepted. Validation is recursive across input, output, metadata, usage,
artifacts, failure details, callback bodies, and local fingerprints. An unsafe
request is rejected before reservation; unsafe agent output becomes the static
`AGENT_OUTPUT_INVALID` failure. See
[JSON interoperability](../contracts/json-interoperability.md).

The one-shot lifecycle is:

```text
created -> starting -> running -> stopping -> stopped
                    \-> failed
```

The SDK installs no signal handlers. Applications own SIGINT/SIGTERM wiring.
Shutdown disables acceptance under the submission lock, stops the listener,
turns queued work into shutdown callbacks, drains tracked execution and
callback work within grace, then cancels Worker-owned waits and closes the
session and runner.

## Intentional Python differences

- Public names and configuration use `snake_case`, seconds, and `warning`.
- The local idempotency fingerprint is binary rather than a wire value.
- Threads cannot be killed and Python coroutines may suppress cancellation.
- Packaging and resource isolation use Python wheels, sdists, `py.typed`, and
  `importlib.resources` rather than npm artifacts.

These differences do not change the language-neutral request, acceptance,
result, callback, or HMAC contracts.

## Package verification

The package declares Python `>=3.11`, but the verified local run recorded for
this implementation used Python 3.13. The configured CI matrix covers Python
3.11 through 3.14; configuration alone is not a claim that those jobs passed.
`python scripts/verify-python-worker-package.py` builds wheel and sdist
archives, enforces file and metadata allowlists, compares all five schemas,
rebuilds from the sdist, installs into a clean external virtual environment,
checks the typed public API, starts health endpoints, and exercises example
shutdown. The distribution remains private and unpublished.
