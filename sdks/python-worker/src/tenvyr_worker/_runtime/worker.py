"""Concrete one-shot aiohttp Worker runtime."""

from __future__ import annotations

import asyncio
import math
import time
import uuid
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any, cast
from urllib.parse import urlsplit

from aiohttp import ClientSession, web

from .._callback.delivery import create_callback_session, deliver_callback
from .._callback.hooks import notify_callback_delivery_failed
from .._callback.types import (
    CallbackDeliveryRequest,
    CallbackDeliverySettings,
    make_callback_delivery_failed_event,
)
from .._http.auth import authenticate_bearer
from .._http.callback_policy import validate_callback_url
from .._http.server import (
    RequestBodyTooLarge,
    error_response,
    is_json_content_type,
    json_response,
    read_request_body,
)
from .._protocol.json_value import JsonValue
from .._protocol.validation import (
    ContractValidationError,
    loads_json,
    parse_agent_result,
    parse_http_agent_run_accepted,
    parse_http_agent_run_request,
)
from .._public.config import TenvyrWorkerConfig
from .._public.types import WorkerAddress, WorkerLifecycleState, WorkerLogger
from .canonical_json import request_fingerprint
from .execution import execute_agent
from .idempotency import (
    IdempotencyCapacityError,
    InMemoryIdempotencyStore,
    RunRecord,
    RunState,
)
from .safe_logger import NO_OP_LOGGER, safe_logger
from .scheduler import RunScheduler


class WorkerRuntime:
    def __init__(self, config: TenvyrWorkerConfig[Any, Any]) -> None:
        self._config = config
        self._state = WorkerLifecycleState.CREATED
        self._address: WorkerAddress | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._session: ClientSession | None = None
        self._start_task: asyncio.Task[WorkerAddress] | None = None
        self._stop_task: asyncio.Task[None] | None = None
        self._cleanup_task: asyncio.Task[None] | None = None
        self._submission_lock = asyncio.Lock()
        self._accepting = False
        self._force_stop = asyncio.Event()
        self._callback_tasks: set[asyncio.Task[None]] = set()
        self._callback_sequence = 0
        self._store = InMemoryIdempotencyStore(
            ttl_seconds=config.idempotency_ttl_seconds,
            max_entries=config.idempotency_max_entries,
        )
        self._scheduler = RunScheduler(
            concurrency=config.execution_concurrency,
            max_queued_runs=config.max_queued_runs,
        )
        self._logger: WorkerLogger = safe_logger(config.logger or NO_OP_LOGGER)

    @property
    def agent_name(self) -> str:
        return self._config.agent.name

    def get_state(self) -> WorkerLifecycleState:
        return self._state

    async def start(
        self, *, host: str = "127.0.0.1", port: int = 8080
    ) -> WorkerAddress:
        if self._state is WorkerLifecycleState.RUNNING and self._address is not None:
            return self._address
        if (
            self._state is WorkerLifecycleState.STARTING
            and self._start_task is not None
        ):
            return await asyncio.shield(self._start_task)
        if self._state is not WorkerLifecycleState.CREATED:
            raise RuntimeError(f"Tenvyr Worker cannot start from {self._state} state")
        if not isinstance(host, str) or not host:
            raise ValueError("host must be a non-empty string")
        if type(port) is not int or not 0 <= port <= 65535:
            raise ValueError("port must be an integer between 0 and 65535")
        self._state = WorkerLifecycleState.STARTING
        self._start_task = asyncio.create_task(
            self._bind(host, port), name="tenvyr-worker-start"
        )
        return await asyncio.shield(self._start_task)

    async def stop(self, *, grace_seconds: float | None = None) -> None:
        if self._state is WorkerLifecycleState.STOPPED:
            return
        if self._state is WorkerLifecycleState.STOPPING and self._stop_task is not None:
            await asyncio.shield(self._stop_task)
            return
        if self._state in (WorkerLifecycleState.CREATED, WorkerLifecycleState.FAILED):
            self._state = WorkerLifecycleState.STOPPED
            return
        grace = (
            self._config.shutdown_grace_seconds
            if grace_seconds is None
            else _positive_grace(grace_seconds)
        )
        self._state = WorkerLifecycleState.STOPPING
        self._stop_task = asyncio.create_task(
            self._stop_after_start(grace), name="tenvyr-worker-stop"
        )
        await asyncio.shield(self._stop_task)

    async def _bind(self, host: str, port: int) -> WorkerAddress:
        app = web.Application(
            client_max_size=self._config.max_request_bytes + 1,
            middlewares=[self._internal_error_middleware],
        )
        app.router.add_get("/health/live", self._handle_live)
        app.router.add_get("/health/ready", self._handle_ready)
        app.router.add_post("/v1/runs", self._handle_run)
        app.router.add_route("*", "/{tail:.*}", self._handle_not_found)
        runner = web.AppRunner(app, handle_signals=False, access_log=None)
        self._runner = runner
        try:
            await runner.setup()
            site = web.TCPSite(runner, host, port)
            self._site = site
            await site.start()
            address = _bound_address(runner, host)
            self._address = address
            self._session = create_callback_session()
            if self._state is not WorkerLifecycleState.STOPPING:
                async with self._submission_lock:
                    self._accepting = True
                    self._state = WorkerLifecycleState.RUNNING
                self._cleanup_task = asyncio.create_task(
                    self._cleanup_records(), name="tenvyr-worker-idempotency-cleanup"
                )
            return address
        except BaseException:
            if self._state is not WorkerLifecycleState.STOPPING:
                self._state = WorkerLifecycleState.FAILED
            await runner.cleanup()
            self._runner = None
            self._site = None
            raise

    async def _stop_after_start(self, grace_seconds: float) -> None:
        if self._start_task is not None and self._address is None:
            try:
                await self._start_task
            except Exception:
                self._state = WorkerLifecycleState.STOPPED
                return
        await self._shutdown(grace_seconds)

    async def _handle_live(self, request: web.Request) -> web.Response:
        return json_response(200, {"status": "ok"})

    @web.middleware
    async def _internal_error_middleware(
        self, request: web.Request, handler: Any
    ) -> web.StreamResponse:
        try:
            return cast(web.StreamResponse, await handler(request))
        except web.HTTPException:
            raise
        except Exception:
            self._logger.error("Worker HTTP request failed")
            return error_response(
                500, "INTERNAL_ERROR", "Worker could not process the request"
            )

    async def _handle_ready(self, request: web.Request) -> web.Response:
        ready = (
            self._state is WorkerLifecycleState.RUNNING
            and self._accepting
            and self._scheduler.accepting
        )
        return json_response(
            200 if ready else 503,
            {"status": "ok" if ready else "unavailable"},
        )

    async def _handle_not_found(self, request: web.Request) -> web.Response:
        return error_response(404, "NOT_FOUND", "Route not found")

    async def _handle_run(self, request: web.Request) -> web.Response:
        if not self._is_ready():
            return await _reject_unread_body(
                request,
                error_response(503, "WORKER_NOT_READY", "Worker is not accepting runs"),
            )
        if not is_json_content_type(request.headers.get("Content-Type")):
            return await _reject_unread_body(
                request,
                error_response(
                    415,
                    "UNSUPPORTED_MEDIA_TYPE",
                    "Content-Type must be application/json",
                ),
            )
        if not authenticate_bearer(
            request.headers.get("Authorization"), self._config.bearer_token
        ):
            return await _reject_unread_body(
                request,
                error_response(
                    401,
                    "UNAUTHORIZED",
                    "Bearer authentication failed",
                    headers={"WWW-Authenticate": "Bearer"},
                ),
            )
        try:
            body = await read_request_body(request, self._config.max_request_bytes)
        except RequestBodyTooLarge:
            return await _reject_unread_body(
                request,
                error_response(
                    413,
                    "REQUEST_TOO_LARGE",
                    "Request body exceeded the configured limit",
                ),
            )
        try:
            value = loads_json(body)
        except (TypeError, ValueError):
            return error_response(
                400, "INVALID_JSON", "Request body must be valid JSON"
            )
        try:
            run_request = parse_http_agent_run_request(value)
        except ContractValidationError:
            return error_response(
                400,
                "INVALID_REQUEST",
                "Request does not match HttpAgentRunRequestV1",
            )

        invocation = cast(dict[str, JsonValue], run_request["invocation"])
        target = cast(dict[str, JsonValue], invocation["target"])
        if target["agent"] != self.agent_name:
            return error_response(
                404,
                "AGENT_NOT_FOUND",
                "Target agent is not hosted by this Worker",
            )
        idempotency_key = request.headers.getall("Idempotency-Key", [])
        if (
            len(idempotency_key) != 1
            or idempotency_key[0] != invocation["invocationId"]
        ):
            return error_response(
                400,
                "INVALID_IDEMPOTENCY_KEY",
                "Idempotency-Key must equal invocationId",
            )
        delivery = cast(dict[str, JsonValue], run_request["resultDelivery"])
        authentication = cast(dict[str, JsonValue], delivery["authentication"])
        key_id = cast(str, authentication["keyId"])
        if key_id not in self._config.callback_keys:
            return error_response(
                400, "UNKNOWN_CALLBACK_KEY", "Callback key ID is not configured"
            )
        try:
            validate_callback_url(
                delivery["callbackUrl"],
                self._config._normalized_callback_origins,
                allow_insecure_http=self._config.allow_insecure_http,
            )
        except (TypeError, ValueError):
            return error_response(
                400, "CALLBACK_TARGET_REJECTED", "Callback URL is not allowed"
            )

        fingerprint = request_fingerprint(run_request, idempotency_key[0])
        async with self._submission_lock:
            if not self._is_ready():
                return error_response(
                    503, "WORKER_NOT_READY", "Worker is not accepting runs"
                )
            now = time.time()
            lookup = self._store.lookup(idempotency_key[0], fingerprint, now=now)
            if lookup.kind == "duplicate":
                assert lookup.record is not None
                return json_response(202, _acceptance(lookup.record))
            if lookup.kind == "conflict":
                return error_response(
                    409,
                    "IDEMPOTENCY_CONFLICT",
                    "Invocation ID was already used by another request",
                )
            if not self._scheduler.has_capacity():
                return error_response(429, "QUEUE_FULL", "Worker run queue is full")
            try:
                record = self._store.create(
                    invocation_id=idempotency_key[0],
                    request_fingerprint=fingerprint,
                    run_id=str(uuid.uuid4()),
                    accepted_at=_timestamp(now),
                    now=now,
                )
            except IdempotencyCapacityError:
                return error_response(
                    429,
                    "IDEMPOTENCY_CAPACITY_FULL",
                    "Worker idempotency capacity is full",
                )
            self._store.update_state(record, RunState.QUEUED, now=now)
            scheduled = _ScheduledSubmission(self, record, run_request)
            try:
                enqueued = self._scheduler.enqueue(scheduled)
            except Exception:
                self._store.delete(record.invocation_id, expected=record)
                raise
            if not enqueued:
                self._store.delete(record.invocation_id, expected=record)
                return error_response(
                    500, "INTERNAL_ERROR", "Worker could not process the request"
                )
            accepted = _acceptance(record)
        return json_response(202, accepted)

    async def _execute_submission(
        self, record: RunRecord, request: dict[str, JsonValue]
    ) -> None:
        self._store.update_state(record, RunState.RUNNING, now=time.time())
        invocation = cast(dict[str, JsonValue], request["invocation"])
        result = await execute_agent(
            agent=self._config.agent,
            invocation=invocation,
            run_id=record.run_id,
            timeout_seconds=self._config.execution_timeout_seconds,
            logger=self._logger,
            shutdown_event=self._force_stop,
        )
        self._track_callback(self._deliver_result(record, request, result))

    async def _cancel_queued(
        self, record: RunRecord, request: dict[str, JsonValue]
    ) -> None:
        invocation = cast(dict[str, JsonValue], request["invocation"])
        self._track_callback(
            self._deliver_result(record, request, _shutdown_result(invocation))
        )

    def _track_callback(self, work: Any) -> None:
        self._callback_sequence += 1
        task = asyncio.create_task(
            work, name=f"tenvyr-worker-callback-{self._callback_sequence}"
        )
        self._callback_tasks.add(task)
        task.add_done_callback(self._callback_done)

    def _callback_done(self, task: asyncio.Task[None]) -> None:
        self._callback_tasks.discard(task)
        if not task.cancelled():
            task.exception()

    async def _deliver_result(
        self,
        record: RunRecord,
        request: dict[str, JsonValue],
        result: dict[str, JsonValue],
    ) -> None:
        session = self._session
        if session is None:
            return
        self._store.update_state(record, RunState.CALLBACK_PENDING, now=time.time())
        invocation = cast(dict[str, JsonValue], request["invocation"])
        delivery = cast(dict[str, JsonValue], request["resultDelivery"])
        authentication = cast(dict[str, JsonValue], delivery["authentication"])
        key_id = cast(str, authentication["keyId"])
        callback_url = cast(str, delivery["callbackUrl"])
        try:
            outcome = await deliver_callback(
                session,
                CallbackDeliveryRequest(
                    agent=self.agent_name,
                    invocation_id=record.invocation_id,
                    run_id=record.run_id,
                    callback_url=callback_url,
                    key_id=key_id,
                    secret=self._config.callback_keys[key_id],
                    result=result,
                ),
                cast(CallbackDeliverySettings, self._config),
                logger=self._logger,
                stop_signal=self._force_stop,
            )
        except Exception:
            self._store.update_state(record, RunState.CALLBACK_FAILED, now=time.time())
            self._logger.error(
                "Callback delivery failed unexpectedly",
                {"agent": self.agent_name, "run_id": record.run_id},
            )
            await notify_callback_delivery_failed(
                self._config.on_callback_delivery_failed,
                make_callback_delivery_failed_event(
                    agent=self.agent_name,
                    invocation_id=record.invocation_id,
                    run_id=record.run_id,
                    delivery_id="unavailable",
                    attempts=0,
                    callback_host=urlsplit(callback_url).netloc,
                    reason="unexpected-delivery-error",
                ),
                logger=self._logger,
                stop_signal=self._force_stop,
            )
            return
        self._store.update_state(
            record,
            RunState.DELIVERED if outcome.delivered else RunState.CALLBACK_FAILED,
            now=time.time(),
        )
        if not outcome.delivered:
            await notify_callback_delivery_failed(
                self._config.on_callback_delivery_failed,
                make_callback_delivery_failed_event(
                    agent=self.agent_name,
                    invocation_id=cast(str, invocation["invocationId"]),
                    run_id=record.run_id,
                    delivery_id=outcome.delivery_id,
                    attempts=outcome.attempts,
                    callback_host=urlsplit(callback_url).netloc,
                    reason=outcome.reason or "delivery-failed",
                    http_status=outcome.http_status,
                ),
                logger=self._logger,
                stop_signal=self._force_stop,
            )

    async def _shutdown(self, grace_seconds: float) -> None:
        async with self._submission_lock:
            self._accepting = False
        if self._site is not None:
            await self._site.stop()
        stop_scheduler = asyncio.create_task(
            self._scheduler.stop_accepting(), name="tenvyr-worker-queue-shutdown"
        )
        drain = asyncio.create_task(
            self._drain(stop_scheduler), name="tenvyr-worker-drain"
        )
        try:
            async with asyncio.timeout(grace_seconds):
                await asyncio.shield(drain)
        except TimeoutError:
            self._force_stop.set()
            await drain
        finally:
            if self._cleanup_task is not None:
                self._cleanup_task.cancel()
                with suppress(asyncio.CancelledError):
                    await self._cleanup_task
                self._cleanup_task = None
            if self._session is not None:
                await self._session.close()
                self._session = None
            if self._runner is not None:
                await self._runner.cleanup()
                self._runner = None
            self._site = None
            self._state = WorkerLifecycleState.STOPPED

    def _is_ready(self) -> bool:
        return self._state is WorkerLifecycleState.RUNNING and self._accepting

    async def _drain(self, stop_scheduler: asyncio.Task[None]) -> None:
        await stop_scheduler
        await self._scheduler.wait_idle()
        while self._callback_tasks:
            await asyncio.gather(*tuple(self._callback_tasks), return_exceptions=True)

    async def _cleanup_records(self) -> None:
        interval = min(self._config.idempotency_ttl_seconds, 60.0)
        while True:
            await asyncio.sleep(interval)
            self._store.cleanup(now=time.time())


class _ScheduledSubmission:
    def __init__(
        self,
        worker: WorkerRuntime,
        record: RunRecord,
        request: dict[str, JsonValue],
    ) -> None:
        self._worker = worker
        self._record = record
        self._request = request

    async def run(self) -> None:
        await self._worker._execute_submission(self._record, self._request)

    async def cancel(self) -> None:
        await self._worker._cancel_queued(self._record, self._request)


def _acceptance(record: RunRecord) -> dict[str, JsonValue]:
    return parse_http_agent_run_accepted(
        {
            "schemaVersion": "1",
            "invocationId": record.invocation_id,
            "runId": record.run_id,
            "status": "accepted",
            "acceptedAt": record.accepted_at,
        },
        expected_invocation_id=record.invocation_id,
    )


def _shutdown_result(invocation: dict[str, JsonValue]) -> dict[str, JsonValue]:
    result: dict[str, object] = {
        "schemaVersion": "1",
        "invocationId": invocation["invocationId"],
        "executionId": invocation["executionId"],
        "stepExecutionId": invocation["stepExecutionId"],
        "status": "cancelled",
        "error": {
            "code": "WORKER_SHUTDOWN",
            "message": "Worker shutdown cancelled the execution",
            "retryable": True,
        },
        "completedAt": _timestamp(time.time()),
    }
    return parse_agent_result(result)


def _bound_address(runner: web.AppRunner, host: str) -> WorkerAddress:
    addresses = runner.addresses
    if not addresses:
        raise RuntimeError("Tenvyr Worker listener did not report an address")
    address = addresses[0]
    if not isinstance(address, tuple) or len(address) < 2:
        raise RuntimeError("Tenvyr Worker listener reported an invalid address")
    return WorkerAddress(host=host, port=int(address[1]))


def _timestamp(value: float) -> str:
    formatted = datetime.fromtimestamp(value, UTC).isoformat(timespec="milliseconds")
    return formatted.replace("+00:00", "Z")


def _positive_grace(value: object) -> float:
    if type(value) not in (int, float):
        raise ValueError("grace_seconds must be non-negative finite seconds")
    number = float(cast(int | float, value))
    if not math.isfinite(number) or number < 0:
        raise ValueError("grace_seconds must be non-negative finite seconds")
    return number


async def _reject_unread_body(
    request: web.Request, response: web.Response
) -> web.Response:
    response.force_close()
    await response.prepare(request)
    await response.write_eof()
    if request.transport is not None:
        request.transport.close()
    return response
