# `tenvyr-worker`

Private Python 3.11+ runtime harness for Tenvyr HTTP agents. The distribution
is version `1.0.0`, typed with `py.typed`, and intentionally not licensed or
published. Do not upload it to PyPI.

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
[architecture document](../../docs/architecture/python-worker-sdk.md).
