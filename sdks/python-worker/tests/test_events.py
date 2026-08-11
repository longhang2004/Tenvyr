"""Agent event parity tests mirroring packages/worker/test/events.spec.ts."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import threading
import time
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from aiohttp import ClientSession, web

from tenvyr_worker import (
    AgentExecutionContext,
    TenvyrWorkerConfig,
    WorkerLifecycleState,
    create_tenvyr_worker,
    define_agent,
)
from tenvyr_worker._callback.delivery import (
    HEADER_DELIVERY_ID,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    USER_AGENT,
)
from tenvyr_worker._protocol.json_value import JsonValue
from tenvyr_worker._protocol.validation import parse_agent_event
from tenvyr_worker._runtime.canonical_json import canonical_json
from tenvyr_worker._runtime.worker import (
    MAX_AGENT_EVENT_CANONICAL_BYTES,
    MAX_AGENT_EVENT_SEQUENCE,
    RunEventEmitter,
)


def _execute(context: object, value: object) -> object:
    return value


AGENT = define_agent(name="echo-agent", execute=_execute)


def _valid_config(**overrides: object) -> TenvyrWorkerConfig[object, object]:
    values: dict[str, object] = {
        "agent": AGENT,
        "bearer_token": "worker-token",
        "callback_keys": {"callback-v1": "callback-secret"},
        "allowed_callback_origins": ("https://orchestrator.example",),
    }
    values.update(overrides)
    return TenvyrWorkerConfig(**values)  # type: ignore[arg-type]


def test_events_config_defaults_to_disabled_with_bounded_heartbeat() -> None:
    config = _valid_config()
    assert config.events_enabled is False
    assert config.event_heartbeat_interval_seconds == 60.0


def test_events_config_accepts_explicitly_enabled_configuration() -> None:
    config = _valid_config(events_enabled=True, event_heartbeat_interval_seconds=5.0)
    assert config.events_enabled is True
    assert config.event_heartbeat_interval_seconds == 5.0


@pytest.mark.parametrize(
    "interval",
    (
        0.5,
        3601.0,
        "60",
        True,
        math.nan,
        math.inf,
    ),
)
def test_events_config_rejects_invalid_heartbeat_intervals(interval: object) -> None:
    with pytest.raises((TypeError, ValueError), match="event heartbeat interval"):
        _valid_config(event_heartbeat_interval_seconds=interval)  # type: ignore[arg-type]


def test_events_config_rejects_non_boolean_enabled() -> None:
    with pytest.raises(ValueError, match="events_enabled"):
        _valid_config(events_enabled=1)  # type: ignore[arg-type]


def test_events_config_accepts_seconds_spelling_of_valid_ms_interval() -> None:
    config = _valid_config(events_enabled=True, event_heartbeat_interval_seconds=1.5)
    assert config.event_heartbeat_interval_seconds == 1.5


FIXED_NOW = datetime(2026, 7, 26, 0, 0, 1, tzinfo=UTC).timestamp()
EXPECTED_OCCURRED_AT = "2026-07-26T00:00:01.000Z"


def _invocation(
    invocation_id: str = "invocation-1",
    *,
    execution_id: str = "execution-1",
    step_execution_id: str = "step-execution-1",
    trace_id: str = "trace-1",
) -> dict[str, object]:
    return {
        "schemaVersion": "1",
        "invocationId": invocation_id,
        "executionId": execution_id,
        "stepExecutionId": step_execution_id,
        "stepId": "echo",
        "target": {"agent": "echo-agent"},
        "input": {"message": "hello"},
        "attempt": 1,
        "createdAt": "2026-07-26T00:00:00.000Z",
        "trace": {"traceId": trace_id, "correlationId": invocation_id},
    }


class _Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Mapping[str, object]]] = []
        self.debug_messages: list[str] = []

    def debug(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self.calls.append(("debug", message, dict(context or {})))
        self.debug_messages.append(message)

    def info(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self.calls.append(("info", message, dict(context or {})))

    def warning(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None:
        self.calls.append(("warning", message, dict(context or {})))

    def error(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self.calls.append(("error", message, dict(context or {})))


def _make_emitter(
    *,
    enabled: bool = True,
    logger: _Recorder | None = None,
    now: Callable[[], float] = lambda: FIXED_NOW,
) -> tuple[RunEventEmitter, list[tuple[dict[str, JsonValue], bytes]]]:
    delivered: list[tuple[dict[str, JsonValue], bytes]] = []
    emitter = RunEventEmitter(
        invocation=_invocation(),
        run_id="run-1",
        enabled=enabled,
        logger=logger or _Recorder(),
        now=now,
        deliver=lambda event, raw_body: delivered.append((event, raw_body)),
    )
    return emitter, delivered


def test_emitter_assigns_sequences_with_deterministic_event_ids_and_fields() -> None:
    emitter, delivered = _make_emitter()
    emitter.emit("accepted", {"acceptedAt": "2026-07-26T00:00:00.000Z"})
    emitter.emit("progress", {"step": 1})
    emitter.emit("completed", {"status": "succeeded"})

    assert [event["sequence"] for event, _ in delivered] == [0, 1, 2]
    assert [event["eventId"] for event, _ in delivered] == [
        "invocation-1:0",
        "invocation-1:1",
        "invocation-1:2",
    ]
    for event, _ in delivered:
        assert event["schemaVersion"] == "1"
        assert event["occurredAt"] == EXPECTED_OCCURRED_AT
        assert event["trace"] == {
            "traceId": "trace-1",
            "correlationId": "invocation-1",
        }
        assert event["metadata"] == {"runId": "run-1"}
        assert event["invocationId"] == "invocation-1"
        assert event["executionId"] == "execution-1"
        assert event["stepExecutionId"] == "step-execution-1"
    assert delivered[0][0]["type"] == "accepted"
    assert delivered[0][0]["payload"] == {"acceptedAt": "2026-07-26T00:00:00.000Z"}
    assert delivered[2][0]["payload"] == {"status": "succeeded"}


def test_emitter_sequences_are_unique_and_monotonic_under_thread_concurrency() -> None:
    """Stress the sequence/eventId allocation across thread kinds.

    A synchronous handler runs under ``asyncio.to_thread``, so its
    ``context.progress(...)`` calls land on handler worker threads while the
    heartbeat coroutine emits from the event-loop thread. Sequence and
    eventId must stay unique and strictly monotonic ([0..N-1]) regardless.
    The emitter's ``threading.Lock`` is the synchronization contract, not the
    GIL, so this runs several rounds to exercise the race.
    """
    rounds = 10
    handler_threads = 8
    emissions_per_handler = 50
    loop_emissions = 100

    for _ in range(rounds):
        collector: list[tuple[dict[str, JsonValue], bytes]] = []
        collector_lock = threading.Lock()

        def deliver(
            event: dict[str, JsonValue],
            raw_body: bytes,
            collector: list[tuple[dict[str, JsonValue], bytes]] = collector,
            lock: threading.Lock = collector_lock,
        ) -> None:
            with lock:
                collector.append((event, raw_body))

        emitter = RunEventEmitter(
            invocation=_invocation(),
            run_id="run-1",
            enabled=True,
            logger=_Recorder(),
            now=lambda: FIXED_NOW,
            deliver=deliver,
        )
        # The sync-handler pattern: context.progress from worker threads.
        context = AgentExecutionContext(
            invocation=_invocation(),
            run_id="run-1",
            logger=_Recorder(),
            _emitter=emitter,
        )
        start = threading.Barrier(handler_threads + 1)

        def handler_worker(
            start: threading.Barrier = start,
            context: AgentExecutionContext = context,
        ) -> None:
            start.wait()
            for i in range(emissions_per_handler):
                context.progress({"thread": True, "i": i})

        threads = [
            threading.Thread(target=handler_worker) for _ in range(handler_threads)
        ]
        for thread in threads:
            thread.start()
        start.wait()  # release all handler threads at once
        # Concurrent heartbeat emissions from the event-loop thread.
        for _ in range(loop_emissions):
            emitter.emit("heartbeat", {})
        for thread in threads:
            thread.join()

        sequences = [event["sequence"] for event, _ in collector]
        event_ids = [cast(str, event["eventId"]) for event, _ in collector]
        assert len(sequences) == len(set(sequences))
        assert len(event_ids) == len(set(event_ids))
        assert sorted(sequences) == list(range(len(sequences)))
        # No cross-thread corruption of identity-bearing fields.
        for event, _ in collector:
            assert event["invocationId"] == "invocation-1"
            assert event["metadata"] == {"runId": "run-1"}


def test_emitter_builds_body_once_and_reuses_the_same_bytes() -> None:
    emitter, delivered = _make_emitter()
    emitter.emit("progress", {"step": 1})

    event, raw_body = delivered[0]
    assert raw_body.decode("utf-8") == json.dumps(
        event, ensure_ascii=False, separators=(",", ":")
    )
    assert parse_agent_event(json.loads(raw_body)) == event


def test_emitter_is_a_noop_when_disabled_and_notes_it_exactly_once() -> None:
    recorder = _Recorder()
    emitter, delivered = _make_emitter(enabled=False, logger=recorder)

    emitter.emit("progress", {"step": 1})
    emitter.emit("progress", {"step": 2})

    assert delivered == []
    assert len(recorder.debug_messages) == 1
    assert recorder.debug_messages[0] == (
        "Agent events are disabled; ignoring event emission"
    )


@pytest.mark.parametrize(
    ("label", "payload"),
    (
        ("NaN", {"n": math.nan}),
        ("Infinity", {"n": math.inf}),
        ("unsafe integer", {"n": 9_007_199_254_740_992}),
        ("set value", {"s": {"x"}}),
        ("object value", {"o": object()}),
        ("non-object payload", "text"),
        ("array payload", [1, 2]),
    ),
)
def test_emitter_rejects_non_json_and_non_finite_payloads(
    label: str, payload: object
) -> None:
    emitter, _ = _make_emitter()
    with pytest.raises((TypeError, ValueError), match="Agent event payload"):
        emitter.emit("progress", payload)  # type: ignore[arg-type]


def test_emitter_rejects_circular_payloads() -> None:
    circular: dict[str, object] = {}
    circular["self"] = circular
    emitter, _ = _make_emitter()
    with pytest.raises(TypeError, match="circular"):
        emitter.emit("progress", circular)  # type: ignore[arg-type]


def test_emitter_rejects_a_complete_event_over_64_kib_without_delivery() -> None:
    emitter, delivered = _make_emitter()
    oversized = {"data": "x" * MAX_AGENT_EVENT_CANONICAL_BYTES}
    with pytest.raises(ValueError, match="exceeds the 65536-byte limit"):
        emitter.emit("progress", oversized)
    assert delivered == []


@pytest.mark.parametrize("rounds", range(3))
def test_emitter_rejects_full_envelope_overflow_and_accepts_the_boundary(
    rounds: int,
) -> None:
    """Payload under 64 KiB but complete canonical event over the limit.

    The envelope overhead is measured deterministically from a probe event
    whose payload data string is empty; each extra \"x\" adds exactly one
    canonical byte, so the boundary is exact rather than a magic constant.
    """
    emitter, delivered = _make_emitter()
    emitter.emit("progress", {"data": ""})
    assert len(delivered) == 1
    overhead = len(canonical_json(delivered[0][0]).encode("utf-8"))
    at_limit = MAX_AGENT_EVENT_CANONICAL_BYTES - overhead
    assert at_limit > 0

    emitter.emit("progress", {"data": "x" * at_limit})
    with pytest.raises(ValueError, match="exceeds the 65536-byte limit"):
        emitter.emit("progress", {"data": "x" * (at_limit + 1)})
    # Probe + boundary event delivered; the overflow was never scheduled.
    assert len(delivered) == 2
    assert delivered[1][0]["payload"] == {"data": "x" * at_limit}


@pytest.mark.parametrize(
    ("invocation_id", "expect_error"),
    [
        # invocationId length 254 + ":0" => eventId length 256: the canonical
        # AgentEventV1 contract would reject the constructed event, so the
        # emitter rejects it locally before any delivery is scheduled.
        ("i" * 254, r"exceeds the 255-character limit"),
        # The maximum valid generated eventId: 253 + ":0" => 255 characters.
        ("i" * 253, None),
    ],
)
def test_emitter_enforces_generated_event_id_bound(
    invocation_id: str, expect_error: str | None
) -> None:
    emitter, delivered = _make_emitter()
    emitter._invocation_id = invocation_id  # type: ignore[attr-defined]
    if expect_error is not None:
        with pytest.raises(ValueError, match=expect_error):
            emitter.emit("progress", {"step": 1})
        assert delivered == []
        return
    emitter.emit("progress", {"step": 1})
    assert len(delivered) == 1
    event = delivered[0][0]
    assert event["eventId"] == f"{'i' * 253}:0"
    assert len(cast(str, event["eventId"])) == 255
    # The emitted event is valid under the canonical AgentEventV1 contract.
    parse_agent_event(json.loads(delivered[0][1].decode("utf-8")))


def test_emitter_enforces_sequence_upper_bound_without_billions_of_events() -> None:
    """Internal seam: the sequence counter is private; the emit path is
    exercised at the boundary without constructing two billion events."""
    emitter, delivered = _make_emitter()
    emitter._sequence = MAX_AGENT_EVENT_SEQUENCE  # type: ignore[attr-defined]
    emitter.emit("progress", {"step": 1})
    assert len(delivered) == 1
    assert delivered[0][0]["sequence"] == MAX_AGENT_EVENT_SEQUENCE
    assert delivered[0][0]["eventId"] == f"invocation-1:{MAX_AGENT_EVENT_SEQUENCE}"

    emitter._sequence = MAX_AGENT_EVENT_SEQUENCE + 1  # type: ignore[attr-defined]
    with pytest.raises(ValueError, match=r"outside the 0\.\.2147483647 range"):
        emitter.emit("progress", {"step": 2})
    assert len(delivered) == 1  # nothing new was scheduled


def test_context_rejects_system_owned_event_types() -> None:
    emitter, delivered = _make_emitter()
    context = AgentExecutionContext(
        invocation=_invocation(),
        run_id="run-1",
        logger=_Recorder(),
        _emitter=emitter,
    )

    for type in ("accepted", "heartbeat", "completed", "failed"):
        with pytest.raises(
            ValueError,
            match=f'Agent events of type "{type}" are reserved for the Worker runtime',
        ):
            context.event(type, {})  # type: ignore[arg-type]

    context.event("progress", {"step": 1})
    assert [event["type"] for event, _ in delivered] == ["progress"]


def _request(invocation_id: str = "invocation-1") -> dict[str, object]:
    return {
        "schemaVersion": "1",
        "invocation": _invocation(invocation_id),
        "resultDelivery": {
            "mode": "callback",
            "callbackUrl": "http://127.0.0.1:1/results",
            "authentication": {"scheme": "hmac-sha256", "keyId": "callback-v1"},
        },
    }


class _CallbackSink:
    def __init__(self) -> None:
        self.requests: list[dict[str, object]] = []
        self.status_for: Callable[[bytes], int] = lambda body: 204


@asynccontextmanager
async def _callback_server() -> AsyncIterator[tuple[str, _CallbackSink]]:
    sink = _CallbackSink()

    async def callback(request: web.Request) -> web.Response:
        body = await request.read()
        headers = {key.lower(): value for key, value in request.headers.items()}
        sink.requests.append({"headers": headers, "body": body})
        return web.Response(status=sink.status_for(body))

    app = web.Application()
    app.router.add_post("/callback", callback)
    runner = web.AppRunner(app, handle_signals=False, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    host, port = runner.addresses[0][:2]
    try:
        yield f"http://{host}:{port}", sink
    finally:
        await runner.cleanup()


def _config(callback_origin: str, **overrides: Any) -> TenvyrWorkerConfig[Any, Any]:
    values: dict[str, object] = {
        "agent": AGENT,
        "bearer_token": "worker-token",
        "callback_keys": {"callback-v1": "callback-secret"},
        "allowed_callback_origins": [callback_origin],
        "allow_insecure_http": True,
        "callback_max_attempts": 2,
        "callback_initial_delay_seconds": 0.01,
        "callback_max_delay_seconds": 0.02,
        "callback_jitter_ratio": 0.0,
        "callback_request_timeout_seconds": 1.0,
        "callback_max_response_bytes": 4096,
        "execution_timeout_seconds": 5.0,
        "execution_concurrency": 1,
        "max_queued_runs": 1,
        "idempotency_ttl_seconds": 10.0,
        "idempotency_max_entries": 100,
        "shutdown_grace_seconds": 1.0,
    }
    values.update(overrides)
    return TenvyrWorkerConfig(**values)  # type: ignore[arg-type]


def _is_event_body(body: bytes) -> bool:
    return b'"eventId"' in body


def _event_bodies(sink: _CallbackSink) -> list[dict[str, JsonValue]]:
    events: list[dict[str, JsonValue]] = []
    for request in sink.requests:
        body = cast(bytes, request["body"])
        if _is_event_body(body):
            events.append(parse_agent_event(json.loads(body)))
    return events


def _result_bodies(sink: _CallbackSink) -> list[dict[str, object]]:
    return [
        cast(dict[str, object], json.loads(cast(bytes, request["body"])))
        for request in sink.requests
        if not _is_event_body(cast(bytes, request["body"]))
    ]


async def _wait_for(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("Timed out waiting for condition")
        await asyncio.sleep(0.01)


def _headers(invocation_id: str = "invocation-1") -> dict[str, str]:
    return {
        "Authorization": "Bearer worker-token",
        "Content-Type": "application/json",
        "Idempotency-Key": invocation_id,
    }


async def _submit(
    client: ClientSession,
    url: str,
    request: dict[str, object],
    invocation_id: str = "invocation-1",
) -> Any:
    return await client.post(
        f"{url}/v1/runs", json=request, headers=_headers(invocation_id)
    )


def _expected_signature(
    secret: str, timestamp: str, delivery_id: str, body: bytes
) -> str:
    signed = b".".join((timestamp.encode(), delivery_id.encode(), body))
    return "v1=" + hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()


@pytest.mark.asyncio
async def test_disabled_events_preserve_old_behavior() -> None:
    async def execute(context: Any, value: object) -> object:
        context.progress({"step": 1})
        context.log("ignored when disabled")
        context.artifact({"id": "a1", "name": "f.txt"})
        return {"echoed": True}

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)

        assert _event_bodies(sink) == []
        assert len(sink.requests) == 1
        result = _result_bodies(sink)[0]
        assert result["status"] == "succeeded"
        assert result["output"] == {"echoed": True}
        await worker.stop()


@pytest.mark.asyncio
async def test_accepted_at_sequence_zero_and_monotonic_progress() -> None:
    async def execute(context: Any, value: object) -> object:
        context.progress({"step": 1})
        context.progress({"step": 2})
        return "done"

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            accepted = await response.json()
            assert response.status == 202
        await _wait_for(
            lambda: (
                len([e for e in _event_bodies(sink) if e["type"] == "progress"]) == 2
            )
        )
        await _wait_for(
            lambda: any(e["type"] == "accepted" for e in _event_bodies(sink))
        )
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)

        events = sorted(_event_bodies(sink), key=lambda e: e["sequence"])
        assert [e["sequence"] for e in events[:3]] == [0, 1, 2]
        assert [e["eventId"] for e in events[:3]] == [
            "invocation-1:0",
            "invocation-1:1",
            "invocation-1:2",
        ]
        assert [e["type"] for e in events[:3]] == ["accepted", "progress", "progress"]
        assert events[0]["payload"] == {"acceptedAt": accepted["acceptedAt"]}
        assert events[1]["payload"] == {"step": 1}
        assert events[2]["payload"] == {"step": 2}
        for event in events:
            assert event["trace"] == {
                "traceId": "trace-1",
                "correlationId": "invocation-1",
            }
            assert event["metadata"] == {"runId": accepted["runId"]}
            parsed_at = datetime.fromisoformat(
                cast(str, event["occurredAt"]).replace("Z", "+00:00")
            )
            assert parsed_at.tzinfo is not None
        assert _result_bodies(sink)[0]["status"] == "succeeded"
        await worker.stop()


@pytest.mark.asyncio
async def test_queued_run_emits_only_accepted_until_it_executes() -> None:
    """concurrency=1: run B is accepted and queued behind run A.

    While B sits queued it must emit only `accepted` — no heartbeat, no
    progress — so the Orchestrator can neither acceptance-timeout nor
    heartbeat-timeout an accepted-but-queued run, and must not transition it
    to RUNNING from the accepted event alone.
    """
    entered = asyncio.Event()
    release = asyncio.Event()

    async def execute(context: Any, value: object) -> object:
        if cast(dict[str, object], value).get("block") is True:
            entered.set()
            await release.wait()
            return "blocked-done"
        context.progress({"ran": True})
        # Outlive one heartbeat interval so a heartbeat is actually emitted.
        await asyncio.sleep(1.2)
        return "quick-done"

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
                event_heartbeat_interval_seconds=1.0,
            )
        )
        address = await worker.start(port=0)
        url = f"http://{address.host}:{address.port}"
        request_a = _request("invocation-1")
        request_a["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        request_b = _request("invocation-2")
        request_b["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        cast(dict[str, object], request_a["invocation"])["input"] = {"block": True}
        cast(dict[str, object], request_b["invocation"])["input"] = {"block": False}
        async with ClientSession() as client:
            first = await _submit(client, url, request_a, "invocation-1")
            assert first.status == 202
            await asyncio.wait_for(entered.wait(), timeout=5.0)
            # The execution slot is occupied; B is accepted and queued.
            second = await _submit(client, url, request_b, "invocation-2")
            assert second.status == 202

            # ~2 heartbeat intervals later B is still queued: only `accepted`.
            await asyncio.sleep(2.2)
            b_events = [
                event
                for event in _event_bodies(sink)
                if event["invocationId"] == "invocation-2"
            ]
            assert [event["type"] for event in b_events] == ["accepted"]
            assert b_events[0]["sequence"] == 0

            release.set()
            await _wait_for(lambda: len(_result_bodies(sink)) == 2)

        # Once B executes it emits progress/heartbeat; sequences stay unique
        # and monotonic from the accepted event at 0.
        await _wait_for(
            lambda: any(
                event["invocationId"] == "invocation-2" and event["type"] == "progress"
                for event in _event_bodies(sink)
            )
        )
        b_events = sorted(
            [
                event
                for event in _event_bodies(sink)
                if event["invocationId"] == "invocation-2"
            ],
            key=lambda event: cast(int, event["sequence"]),
        )
        assert [event["sequence"] for event in b_events] == list(range(len(b_events)))
        assert [event["type"] for event in b_events[:2]] == ["accepted", "progress"]
        assert any(event["type"] == "heartbeat" for event in b_events)
        assert [event["eventId"] for event in b_events] == [
            f"invocation-2:{sequence}" for sequence in range(len(b_events))
        ]
        await worker.stop()


@pytest.mark.asyncio
async def test_heartbeats_emitted_on_interval_while_running() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def execute(_context: Any, value: object) -> object:
        entered.set()
        await release.wait()
        return "slow"

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
                event_heartbeat_interval_seconds=1.0,
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
            await asyncio.wait_for(entered.wait(), 2)
        await _wait_for(
            lambda: any(e["type"] == "heartbeat" for e in _event_bodies(sink)),
            timeout=4.0,
        )
        release.set()
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)
        await _wait_for(
            lambda: any(e["type"] == "completed" for e in _event_bodies(sink))
        )

        events = sorted(_event_bodies(sink), key=lambda e: e["sequence"])
        heartbeats = [e for e in events if e["type"] == "heartbeat"]
        accepted = next(e for e in events if e["type"] == "accepted")
        completed = next(e for e in events if e["type"] == "completed")
        assert len(heartbeats) >= 1
        for heartbeat in heartbeats:
            assert heartbeat["payload"] == {}
            assert heartbeat["sequence"] > accepted["sequence"]
            assert heartbeat["sequence"] < completed["sequence"]
        assert completed["sequence"] > 0
        await worker.stop()


@pytest.mark.asyncio
async def test_event_id_and_body_stable_across_retries_with_own_delivery_ids() -> None:
    seen_event_ids: set[str] = set()

    def status_for(body: bytes) -> int:
        value = json.loads(body)
        if "eventId" not in value:
            return 204
        event_id = cast(str, value["eventId"])
        if event_id in seen_event_ids:
            return 204
        seen_event_ids.add(event_id)
        return 500

    async def execute(context: Any, value: object) -> object:
        context.progress({"step": 1})
        return "done"

    async with _callback_server() as (origin, sink):
        sink.status_for = status_for
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)
        await _wait_for(
            lambda: any(e["eventId"] == "invocation-1:1" for e in _event_bodies(sink))
        )
        await _wait_for(
            lambda: (
                len(
                    [
                        r
                        for r in sink.requests
                        if _is_event_body(cast(bytes, r["body"]))
                        and cast(
                            dict[str, object],
                            json.loads(cast(bytes, r["body"])),
                        )["eventId"]
                        == "invocation-1:0"
                    ]
                )
                == 2
            )
        )

        requests = [r for r in sink.requests if _is_event_body(cast(bytes, r["body"]))]
        retried = [
            r
            for r in requests
            if cast(dict[str, object], json.loads(cast(bytes, r["body"])))["eventId"]
            == "invocation-1:0"
        ]
        assert len(retried) == 2
        assert retried[0]["body"] == retried[1]["body"]
        retried_delivery_ids = [
            cast(dict[str, str], r["headers"])[HEADER_DELIVERY_ID.lower()]
            for r in retried
        ]
        assert retried_delivery_ids[0] == retried_delivery_ids[1]
        for request in retried:
            headers = cast(dict[str, str], request["headers"])
            timestamp = headers[HEADER_TIMESTAMP.lower()]
            delivery_id = headers[HEADER_DELIVERY_ID.lower()]
            assert headers[HEADER_SIGNATURE.lower()] == _expected_signature(
                "callback-secret",
                timestamp,
                delivery_id,
                cast(bytes, request["body"]),
            )
        progress = next(
            r
            for r in requests
            if cast(dict[str, object], json.loads(cast(bytes, r["body"])))["eventId"]
            == "invocation-1:1"
        )
        assert (
            cast(dict[str, str], progress["headers"])[HEADER_DELIVERY_ID.lower()]
            != retried_delivery_ids[0]
        )
        await worker.stop()


@pytest.mark.asyncio
async def test_independent_runs_have_independent_sequence_counters() -> None:
    async def execute(context: Any, value: object) -> object:
        context.progress({"step": 1})
        return "done"

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
            )
        )
        address = await worker.start(port=0)
        url = f"http://{address.host}:{address.port}"
        first = _request("invocation-1")
        first["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        second = _request("invocation-2")
        second["invocation"]["trace"] = {  # type: ignore[index]
            "traceId": "trace-2",
            "correlationId": "invocation-2",
        }
        second["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        async with ClientSession() as client:
            assert (await _submit(client, url, first)).status == 202
            assert (
                await _submit(client, url, second, invocation_id="invocation-2")
            ).status == 202
        await _wait_for(
            lambda: (
                len([e for e in _event_bodies(sink) if e["type"] == "progress"]) == 2
            )
        )

        def by_invocation(invocation_id: str) -> list[dict[str, JsonValue]]:
            return sorted(
                (
                    e
                    for e in _event_bodies(sink)
                    if e["invocationId"] == invocation_id
                    and e["type"] in ("accepted", "progress")
                ),
                key=lambda e: e["sequence"],
            )

        assert [e["eventId"] for e in by_invocation("invocation-1")] == [
            "invocation-1:0",
            "invocation-1:1",
        ]
        assert [e["eventId"] for e in by_invocation("invocation-2")] == [
            "invocation-2:0",
            "invocation-2:1",
        ]
        assert [e["type"] for e in by_invocation("invocation-2")] == [
            "accepted",
            "progress",
        ]
        await worker.stop()


@pytest.mark.asyncio
async def test_result_callback_precedes_completed_event_and_never_replaces_it() -> None:
    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(_config(origin, events_enabled=True))
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)
        await _wait_for(
            lambda: any(e["type"] == "completed" for e in _event_bodies(sink))
        )

        results = _result_bodies(sink)
        assert len(results) == 1
        assert results[0]["status"] == "succeeded"
        result_index = next(
            index
            for index, request in enumerate(sink.requests)
            if not _is_event_body(cast(bytes, request["body"]))
        )
        completed_index = next(
            index
            for index, request in enumerate(sink.requests)
            if _is_event_body(cast(bytes, request["body"]))
            and cast(dict[str, object], json.loads(cast(bytes, request["body"])))[
                "type"
            ]
            == "completed"
        )
        assert result_index >= 0
        assert completed_index > result_index
        completed = next(e for e in _event_bodies(sink) if e["type"] == "completed")
        assert completed["eventId"] == "invocation-1:1"
        assert completed["payload"] == {"status": "succeeded"}
        await worker.stop()


@pytest.mark.asyncio
async def test_event_delivery_failure_does_not_block_result_callback() -> None:
    def status_for(body: bytes) -> int:
        return 500 if _is_event_body(body) else 204

    hook_calls: list[Mapping[str, object]] = []
    recorder = _Recorder()

    async def execute(context: Any, value: object) -> object:
        context.progress({"step": 1})
        return "done"

    async with _callback_server() as (origin, sink):
        sink.status_for = status_for
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
                logger=recorder,
                on_callback_delivery_failed=lambda event: hook_calls.append(event),
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)
        await _wait_for(lambda: len(hook_calls) >= 1)

        assert _result_bodies(sink)[0]["status"] == "succeeded"
        assert _result_bodies(sink)[0]["output"] == "done"
        failed = next(call for call in hook_calls)
        assert failed["agent"] == "echo-agent"
        assert failed["invocation_id"] == "invocation-1"
        assert isinstance(failed["run_id"], str)
        assert isinstance(failed["delivery_id"], str)
        assert failed["attempts"] == 2
        assert cast(str, failed["callback_host"]).startswith("127.0.0.1:")
        assert failed["http_status"] == 500
        assert failed["reason"] == "retryable-http-status"
        assert "callback-secret" not in json.dumps([dict(call) for call in hook_calls])
        assert any(
            level == "warning" and message == "Agent event delivery failed"
            for level, message, _context in recorder.calls
        )
        assert worker.get_state() is WorkerLifecycleState.RUNNING
        await worker.stop()


@pytest.mark.asyncio
async def test_invalid_or_reserved_event_fails_the_run_loudly() -> None:
    async def execute(context: Any, value: object) -> object:
        context.progress({"n": math.nan})
        return "done"

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)
        await _wait_for(lambda: any(e["type"] == "failed" for e in _event_bodies(sink)))

        result = _result_bodies(sink)[0]
        assert result["status"] == "failed"
        assert cast(dict[str, object], result["error"])["code"] == (
            "AGENT_EXECUTION_FAILED"
        )
        events = sorted(_event_bodies(sink), key=lambda e: e["sequence"])
        assert [e["type"] for e in events] == ["accepted", "failed"]
        await worker.stop()


@pytest.mark.asyncio
async def test_log_and_artifact_shaping_and_failed_terminal_details() -> None:
    async def execute(context: Any, value: object) -> object:
        context.log("plain message")
        context.log({"level": "info", "detail": "structured"})
        context.artifact({"id": "a1", "name": "report.pdf", "uri": "s3://bucket"})
        raise RuntimeError("boom")

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)
        await _wait_for(lambda: any(e["type"] == "failed" for e in _event_bodies(sink)))

        events = sorted(_event_bodies(sink), key=lambda e: e["sequence"])
        assert [e["type"] for e in events] == [
            "accepted",
            "log",
            "log",
            "artifact",
            "failed",
        ]
        assert events[1]["payload"] == {"message": "plain message"}
        assert events[2]["payload"] == {"level": "info", "detail": "structured"}
        assert events[3]["payload"] == {
            "id": "a1",
            "name": "report.pdf",
            "uri": "s3://bucket",
        }
        assert events[4]["payload"] == {
            "status": "failed",
            "code": "AGENT_EXECUTION_FAILED",
            "message": "Agent execution failed",
            "retryable": False,
        }
        result = _result_bodies(sink)[0]
        assert result["status"] == "failed"
        assert cast(dict[str, object], result["error"])["code"] == (
            "AGENT_EXECUTION_FAILED"
        )
        await worker.stop()


@pytest.mark.asyncio
async def test_event_callbacks_use_the_same_hmac_headers_as_results() -> None:
    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(_config(origin, events_enabled=True))
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(lambda: len(_event_bodies(sink)) >= 1)
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)

        event_requests = [
            r for r in sink.requests if _is_event_body(cast(bytes, r["body"]))
        ]
        callback_headers = [
            "x-agentweave-delivery-id",
            "x-agentweave-key-id",
            "x-agentweave-signature",
            "x-agentweave-timestamp",
        ]
        assert len(event_requests) >= 1
        for request in event_requests:
            headers = cast(dict[str, str], request["headers"])
            assert (
                sorted(key for key in headers if key in callback_headers)
                == callback_headers
            )
            assert headers["x-agentweave-key-id"] == "callback-v1"
            assert headers["user-agent"] == USER_AGENT
            timestamp = headers["x-agentweave-timestamp"]
            delivery_id = headers["x-agentweave-delivery-id"]
            assert headers["x-agentweave-signature"] == _expected_signature(
                "callback-secret",
                timestamp,
                delivery_id,
                cast(bytes, request["body"]),
            )
            assert not any(key.startswith("x-tenvyr-") for key in headers)
        await worker.stop()


@pytest.mark.asyncio
async def test_event_delivery_never_logs_callback_secrets() -> None:
    recorder = _Recorder()

    async def execute(context: Any, value: object) -> object:
        context.progress({"step": 1})
        return "done"

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                events_enabled=True,
                logger=recorder,
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)
        await _wait_for(
            lambda: any(
                level == "info" and message == "Agent event delivered"
                for level, message, _context in recorder.calls
            )
        )

        logged = json.dumps(recorder.calls)
        assert "callback-secret" not in logged
        assert "worker-token" not in logged
        await worker.stop()


@pytest.mark.asyncio
async def test_sync_handler_emits_events_from_the_worker_thread() -> None:
    def execute_sync(context: Any, value: object) -> object:
        context.progress({"step": 1})
        return value

    async with _callback_server() as (origin, sink):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute_sync),
                events_enabled=True,
            )
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/callback"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            response = await _submit(client, url, request)
            assert response.status == 202
        await _wait_for(
            lambda: (
                len([e for e in _event_bodies(sink) if e["type"] == "progress"]) == 1
            )
        )
        await _wait_for(lambda: len(_result_bodies(sink)) == 1)

        events = sorted(_event_bodies(sink), key=lambda e: e["sequence"])
        assert [e["type"] for e in events[:2]] == ["accepted", "progress"]
        assert events[1]["payload"] == {"step": 1}
        assert _result_bodies(sink)[0]["status"] == "succeeded"
        await worker.stop()
