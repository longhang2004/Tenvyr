# `tenvyr-worker`

Private Python 3.11+ runtime harness for Tenvyr HTTP agents. The distribution
is version `0.1.0`, typed with `py.typed`, and licensed under MIT. It remains
private and unpublished; do not upload it to PyPI.

## Install locally

```bash
python -m pip install -e './sdks/python-worker[dev]'
```

## Define and run an agent

```python
import asyncio

from tenvyr_worker import TenvyrWorkerConfig, create_tenvyr_worker, define_agent


async def execute(context, value):
    context.raise_if_cancelled()
    return context.success(output={"echo": value})


async def main() -> None:
    agent = define_agent(name="echo", execute=execute)
    worker = create_tenvyr_worker(
        TenvyrWorkerConfig(
            agent=agent,
            bearer_token="replace-me",
            callback_keys={"local-v1": "replace-me"},
            allowed_callback_origins=("https://orchestrator.example",),
        )
    )
    address = await worker.start(port=8080)
    print(address)
    await worker.stop()


asyncio.run(main())
```

Applications own signal handling. Cancellation is cooperative: arbitrary
threads and cancellation-suppressing coroutines cannot be force-terminated.
Queue, idempotency, and callback state are process-local and disappear on
restart.

Only imports from `tenvyr_worker` are public. `_public`, `_protocol`, `_http`,
`_runtime`, `_callback`, and schema helpers are internal.

## Agent events

Events are strictly opt-in and mirror the TypeScript Worker. Set
`events_enabled=True` and, optionally, `event_heartbeat_interval_seconds`
(default `60.0`, bounded `1`–`3600`). When disabled, every emission is a no-op
with zero behavioral change.

The Worker runtime emits lifecycle events automatically:

- `accepted` at sequence `0` when the run is accepted — this means the Worker
  owns the invocation, NOT that the handler has started. A run accepted while
  the execution slot is busy sits in the Worker queue and emits nothing
  further until it actually executes;
- `heartbeat` on the configured interval while the handler is executing —
  queued runs never emit heartbeats;
- `completed` or `failed` after the terminal `AgentResult` callback completes,
  so event delivery can never prevent or delay the terminal result.

Agent code emits operational events through the context:
`context.progress(payload)`, `context.log(message_or_payload)`,
`context.artifact(metadata)`, and `context.event(type, payload)` — the last
restricted to `progress`, `log`, or `artifact`; system-owned types
(`accepted`, `heartbeat`, `completed`, `failed`) are rejected.

Per run, `eventId` is deterministic (`{invocationId}:{sequence}`) with a
monotonic sequence counter, and each event body is built exactly once and
reused across delivery retries. The generated identity is validated against
the canonical AgentEventV1 bounds (`eventId <= 255` characters,
`sequence <= 2147483647`) before any delivery is scheduled — a long
invocation ID or exhausted sequence rejects the event locally, never sending
an identity the Orchestrator would permanently reject. Payloads must be JSON
objects, and the COMPLETE canonical event body (envelope fields included)
must fit within the 64 KiB limit: an oversized event is rejected locally,
before any delivery callback is scheduled, so the Worker never emits an event
the Orchestrator would permanently reject.

Events are delivered through the same signed-body callback machinery as
results: identical X-AgentWeave-Key-Id/X-AgentWeave-Timestamp/
X-AgentWeave-Delivery-Id/X-AgentWeave-Signature HMAC headers, a
per-delivery `deliveryId`, a stable prebuilt body on every retry, and the
same bounded retry policy.
Delivery failures are logged without secrets, routed to
`on_callback_delivery_failed`, and never raise into the run. Callback state is
worker-local and process-local — a restart forgets undelivered events; the
Orchestrator's acceptance is the durable record.

## Verify

```bash
python scripts/sync-python-worker-schemas.py check
python -m pytest sdks/python-worker/tests
python -m ruff check sdks/python-worker/src sdks/python-worker/tests
python -m ruff format --check sdks/python-worker/src sdks/python-worker/tests
(cd sdks/python-worker && python -m mypy)
python scripts/verify-python-worker-package.py
```

See [CONFORMANCE.md](CONFORMANCE.md) and the
[architecture document](../../docs/architecture/workers/python-worker-sdk.md).
