from __future__ import annotations

import asyncio
import inspect
import json
import random
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from contextlib import suppress
from typing import TypeVar, cast
from urllib.parse import urlsplit

from aiohttp import (
    ClientError,
    ClientResponse,
    ClientSession,
    ClientTimeout,
    DummyCookieJar,
)

from .._http.callback_policy import validate_callback_url
from .._protocol.validation import ContractValidationError, parse_agent_result
from .retry import (
    backoff_delay_seconds,
    classify_callback_response,
    retry_after_delay_seconds,
)
from .signer import create_callback_signature
from .types import (
    CallbackDeliveryOutcome,
    CallbackDeliveryRequest,
    CallbackDeliverySettings,
    CallbackLogger,
    StopSignal,
)

HEADER_KEY_ID = "X-AgentWeave-Key-Id"
HEADER_TIMESTAMP = "X-AgentWeave-Timestamp"
HEADER_DELIVERY_ID = "X-AgentWeave-Delivery-Id"
HEADER_SIGNATURE = "X-AgentWeave-Signature"
USER_AGENT = "Tenvyr-Worker/1.0.0"

_Sleep = Callable[[float], Awaitable[None]]


class _ResponseTooLarge(Exception):
    def __init__(self, status: int) -> None:
        self.status = status


class _WorkerShutdown(Exception):
    pass


def create_callback_session() -> ClientSession:
    return ClientSession(
        trust_env=False,
        auto_decompress=False,
        cookie_jar=DummyCookieJar(),
        timeout=ClientTimeout(total=None),
        skip_auto_headers={"Accept-Encoding"},
    )


def serialize_result(result: object) -> bytes:
    return json.dumps(
        result,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


async def deliver_callback(
    session: ClientSession,
    request: CallbackDeliveryRequest,
    settings: CallbackDeliverySettings,
    *,
    logger: CallbackLogger | None = None,
    stop_signal: StopSignal | None = None,
    delivery_id_factory: Callable[[], str] = lambda: str(uuid.uuid4()),
    now: Callable[[], float] = time.time,
    random_value: Callable[[], float] = random.random,
    sleep: _Sleep = asyncio.sleep,
) -> CallbackDeliveryOutcome:
    delivery_id = delivery_id_factory()
    try:
        validate_callback_url(
            request.callback_url,
            settings._normalized_callback_origins,
            allow_insecure_http=settings.allow_insecure_http,
        )
    except (TypeError, ValueError):
        outcome = CallbackDeliveryOutcome(
            delivered=False,
            delivery_id=delivery_id,
            attempts=0,
            reason="callback-policy-rejected",
        )
        _log_outcome(logger, request, outcome)
        return outcome
    try:
        result = parse_agent_result(request.result)
        raw_body = serialize_result(result)
    except (ContractValidationError, TypeError, ValueError):
        outcome = CallbackDeliveryOutcome(
            delivered=False,
            delivery_id=delivery_id,
            attempts=0,
            reason="invalid-result",
        )
        _log_outcome(logger, request, outcome)
        return outcome

    last_status: int | None = None
    last_reason = "delivery-failed"
    for attempt in range(1, settings.callback_max_attempts + 1):
        if stop_signal is not None and stop_signal.is_set():
            return _shutdown_outcome(delivery_id, attempt - 1)

        timestamp = str(int(now()))
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            HEADER_KEY_ID: request.key_id,
            HEADER_TIMESTAMP: timestamp,
            HEADER_DELIVERY_ID: delivery_id,
            HEADER_SIGNATURE: create_callback_signature(
                request.secret, timestamp, delivery_id, raw_body
            ),
            "User-Agent": USER_AGENT,
        }

        try:
            status, retry_after = await _run_until_stopped(
                _send_once(
                    session,
                    callback_url=request.callback_url,
                    headers=headers,
                    raw_body=raw_body,
                    timeout_seconds=settings.callback_request_timeout_seconds,
                    max_response_bytes=settings.callback_max_response_bytes,
                ),
                stop_signal,
                task_name="tenvyr-worker-callback-request",
            )
            last_status = status
        except _WorkerShutdown:
            return _shutdown_outcome(delivery_id, attempt)
        except _ResponseTooLarge as error:
            last_status = error.status
            outcome = CallbackDeliveryOutcome(
                delivered=False,
                delivery_id=delivery_id,
                attempts=attempt,
                reason="response-too-large",
                http_status=last_status,
            )
            _log_outcome(logger, request, outcome)
            return outcome
        except TimeoutError:
            last_reason = "request-timeout"
            retry_after = None
        except (ClientError, OSError):
            last_reason = "network-error"
            retry_after = None
        else:
            classification = classify_callback_response(status)
            if classification == "delivered":
                outcome = CallbackDeliveryOutcome(
                    delivered=True,
                    delivery_id=delivery_id,
                    attempts=attempt,
                    http_status=status,
                )
                _log_outcome(logger, request, outcome)
                return outcome
            last_reason = (
                "retryable-http-status"
                if classification == "retry"
                else "non-retryable-http-status"
            )
            if classification == "do-not-retry":
                outcome = CallbackDeliveryOutcome(
                    delivered=False,
                    delivery_id=delivery_id,
                    attempts=attempt,
                    reason=last_reason,
                    http_status=status,
                )
                _log_outcome(logger, request, outcome)
                return outcome

        if attempt == settings.callback_max_attempts:
            outcome = CallbackDeliveryOutcome(
                delivered=False,
                delivery_id=delivery_id,
                attempts=attempt,
                reason=last_reason,
                http_status=last_status,
            )
            _log_outcome(logger, request, outcome)
            return outcome

        delay = retry_after_delay_seconds(
            retry_after,
            status=last_status if last_status is not None else 0,
            maximum=settings.callback_max_delay_seconds,
        )
        if delay is None:
            delay = backoff_delay_seconds(
                settings,
                attempt=attempt,
                random_value=random_value(),
            )
        try:
            await _run_until_stopped(
                sleep(delay),
                stop_signal,
                task_name="tenvyr-worker-callback-retry-sleep",
            )
        except _WorkerShutdown:
            return _shutdown_outcome(delivery_id, attempt)
        except Exception:
            outcome = CallbackDeliveryOutcome(
                delivered=False,
                delivery_id=delivery_id,
                attempts=attempt,
                reason="backoff-failed",
                http_status=last_status,
            )
            _log_outcome(logger, request, outcome)
            return outcome

    raise AssertionError("callback attempt loop did not return")


async def _send_once(
    session: ClientSession,
    *,
    callback_url: str,
    headers: Mapping[str, str],
    raw_body: bytes,
    timeout_seconds: float,
    max_response_bytes: int,
) -> tuple[int, str | None]:
    async with asyncio.timeout(timeout_seconds):
        response = await session.post(
            callback_url,
            data=raw_body,
            headers=headers,
            allow_redirects=False,
        )
        try:
            await _read_limited_response(response, max_response_bytes)
            return response.status, response.headers.get("Retry-After")
        finally:
            response.release()


async def _read_limited_response(response: ClientResponse, limit: int) -> None:
    if response.content_length is not None and response.content_length > limit:
        response.close()
        raise _ResponseTooLarge(response.status)

    size = 0
    async for chunk in response.content.iter_chunked(min(64 * 1024, limit + 1)):
        size += len(chunk)
        if size > limit:
            response.close()
            raise _ResponseTooLarge(response.status)


_T = TypeVar("_T")


async def _await_operation(operation: Awaitable[_T]) -> _T:
    return await operation


async def _run_until_stopped(
    operation: Awaitable[_T],
    stop_signal: StopSignal | None,
    *,
    task_name: str,
) -> _T:
    operation_task = asyncio.create_task(_await_operation(operation), name=task_name)
    if stop_signal is None:
        return await operation_task

    stop_task = asyncio.create_task(
        stop_signal.wait(), name="tenvyr-worker-callback-stop-wait"
    )
    try:
        done, _ = await asyncio.wait(
            (operation_task, stop_task), return_when=asyncio.FIRST_COMPLETED
        )
        if stop_task in done and stop_signal.is_set():
            operation_task.cancel()
            with suppress(asyncio.CancelledError):
                await operation_task
            raise _WorkerShutdown
        return await operation_task
    finally:
        stop_task.cancel()
        with suppress(asyncio.CancelledError):
            await stop_task


def _shutdown_outcome(delivery_id: str, attempts: int) -> CallbackDeliveryOutcome:
    return CallbackDeliveryOutcome(
        delivered=False,
        delivery_id=delivery_id,
        attempts=attempts,
        reason="worker-shutdown",
    )


def _log_outcome(
    logger: CallbackLogger | None,
    request: CallbackDeliveryRequest,
    outcome: CallbackDeliveryOutcome,
) -> None:
    if logger is None:
        return
    context: dict[str, object] = {
        "agent": request.agent,
        "invocation_id": request.invocation_id,
        "run_id": request.run_id,
        "delivery_id": outcome.delivery_id,
        "callback_host": _safe_callback_host(request.callback_url),
        "attempts": outcome.attempts,
        "outcome": "delivered" if outcome.delivered else cast(str, outcome.reason),
    }
    if outcome.http_status is not None:
        context["http_status"] = outcome.http_status
    method_name = "info" if outcome.delivered else "error"
    try:
        returned = getattr(logger, method_name)(
            "Agent callback delivered"
            if outcome.delivered
            else "Agent callback delivery failed",
            context,
        )
        if inspect.iscoroutine(returned):
            returned.close()
    except Exception:
        pass


def _safe_callback_host(value: str) -> str:
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return "invalid"
    if hostname is None:
        return "invalid"
    rendered = f"[{hostname}]" if ":" in hostname else hostname
    return f"{rendered}:{port}" if port is not None else rendered
