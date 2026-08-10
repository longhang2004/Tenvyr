# Python Worker Conformance

The Python SDK consumes the canonical repository fixtures directly during
tests; fixtures are not copied into the wheel or sdist.

| Fixture area               | Valid | Invalid/other |  Total |
| -------------------------- | ----: | ------------: | -----: |
| Run requests               |     2 |             4 |      6 |
| Run acceptances            |     1 |             3 |      4 |
| Agent results              |     4 |             3 |      7 |
| HMAC signature vectors     |     8 |             0 |      8 |
| Callback HTTP status cases |    15 |             0 |     15 |
| Retry classification cases |    12 |             0 |     12 |
| Retry-After cases          |     5 |             8 |     13 |
| JSON number documents      |     3 |             5 |      8 |
| **Total**                  |       |               | **73** |

The conformance tests also prove five packaged schemas are byte-identical to
the canonical files, all schema URNs resolve from an offline registry, format
checking is enabled, non-finite JSON is rejected, issue paths remain readable
for special keys, validators do not mutate inputs, and integral values outside
the JavaScript safe-integer range are rejected before fingerprinting or callback
serialization.

Additional Python-only tests cover the exact root API, frozen and secret-safe
configuration, bearer and origin policy, FIFO scheduling, process-local
idempotency, execution/cancellation, callback retry/signing, lifecycle and
resource ownership, package archives, and an explicit real cross-language
loopback.

## Agent events (Milestone 1 parity)

Agent events are strictly opt-in and mirror the TypeScript Worker's
`events` feature: when `events_enabled` is `False` there is zero behavioral
change and zero event emission. Configuration adds `events_enabled` (default
`False`) and `event_heartbeat_interval_seconds` (bounded to 1–3600 seconds,
default 60; the seconds spelling of the TypeScript
`heartbeatIntervalMs` 1000–3_600_000 bound). The packaged
`agent-event.v1.schema.json` remains byte-identical to the canonical file and
`parse_agent_event` validates every emitted body.

Per-run machinery (`RunEventEmitter` in `_runtime/worker.py`) owns one
monotonic sequence counter (0, 1, 2, …), builds deterministic `eventId`
values (`{invocationId}:{sequence}`), captures `occurredAt` and trace once per
event, and reuses the exact serialized body across delivery retries. Payloads
are validated with the shared `to_json_value` policy (finite JSON, safe
integers, acyclic) and rejected above the canonical 64 KiB limit. System-owned
lifecycle events (`accepted` at sequence 0, `heartbeat` on the interval while
executing, `completed`/`failed` after the terminal AgentResult callback) are
not exposed to agent code; the public context adds only `progress(payload)`,
`log(message_or_payload)`, `artifact(metadata)`, and `event(type, payload)`
restricted to `progress`/`log`/`artifact` with a clear rejection of reserved
types.

Event delivery reuses the signed-body callback machinery
(`deliver_signed_body`): the same HMAC-SHA256 headers
(`X-AgentWeave-Key-Id`/`-Timestamp`/`-Delivery-Id`/`-Signature`), the same
bounded retry policy, a per-delivery `deliveryId`, and the stable prebuilt
body on every attempt. Delivery failures are logged (no secrets), routed to
`on_callback_delivery_failed`, and never raise into the run or delay the
terminal AgentResult callback.

The parity suite lives in `tests/test_events.py` and mirrors
`packages/worker/test/events.spec.ts` (disabled no-op behavior, accepted at
sequence 0 with monotonic progress, heartbeats, retry-stable `eventId` and
body, independent per-run counters, result-before-completed ordering, event
failure isolation, payload/finite-JSON validation, reserved-type rejection,
identical HMAC headers, and no secret leakage in logs).


The dedicated loopback is intentionally excluded from normal Orchestrator
Jest discovery. Run it with an installed wheel interpreter:

```bash
TENVYR_PYTHON_EXECUTABLE=/path/to/venv/bin/python \
  pnpm --filter orchestrator test:python-worker-loopback
```

The command fails if `TENVYR_PYTHON_EXECUTABLE` is absent. A passing local
Python 3.13 run does not claim the 3.11–3.14 matrix; those versions are reported
only by CI jobs that actually execute them.
