from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from aiohttp import ClientConnectionError, DummyCookieJar, web

from tenvyr_worker._callback import (
    CallbackDeliveryFailedEvent,
    CallbackDeliveryRequest,
    classify_callback_response,
    create_callback_session,
    create_callback_signature,
    deliver_callback,
    make_callback_delivery_failed_event,
    notify_callback_delivery_failed,
    serialize_result,
)
from tenvyr_worker._callback.delivery import (
    HEADER_DELIVERY_ID,
    HEADER_KEY_ID,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    USER_AGENT,
)
from tenvyr_worker._callback.retry import retry_after_delay_seconds


@dataclass(frozen=True)
class _Settings:
    callback_max_attempts: int = 3
    callback_initial_delay_seconds: float = 0.01
    callback_max_delay_seconds: float = 1.0
    callback_jitter_ratio: float = 0.0
    callback_request_timeout_seconds: float = 0.1
    callback_max_response_bytes: int = 32
    allow_insecure_http: bool = False
    _normalized_callback_origins: tuple[tuple[str, str, int], ...] = (
        ("https", "callback.example.test", 443),
    )


class _Content:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def iter_chunked(self, _size: int) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk


class _Response:
    def __init__(
        self,
        status: int,
        *,
        body: bytes = b"",
        headers: Mapping[str, str] | None = None,
        content_length: int | None = None,
    ) -> None:
        self.status = status
        self.headers = dict(headers or {})
        self.content_length = content_length
        self.content = _Content([body] if body else [])
        self.closed = False
        self.released = False

    def close(self) -> None:
        self.closed = True

    def release(self) -> None:
        self.released = True


class _Session:
    def __init__(self, outcomes: list[_Response | BaseException]) -> None:
        self._outcomes = outcomes
        self.requests: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> _Response:
        self.requests.append({"url": url, **kwargs})
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _request(result: object | None = None) -> CallbackDeliveryRequest:
    return CallbackDeliveryRequest(
        agent="echo-agent",
        invocation_id="invocation-1",
        run_id="run-1",
        callback_url="https://callback.example.test/results",
        key_id="callback-v1",
        secret="TOP_SECRET_CALLBACK",
        result=(
            {
                "schemaVersion": "1",
                "invocationId": "invocation-1",
                "executionId": "execution-1",
                "stepExecutionId": "step-1",
                "status": "succeeded",
                "output": {"message": "Xin chào 🌏"},
                "completedAt": "2026-07-26T00:00:02.000Z",
            }
            if result is None
            else result
        ),
    )


def test_signature_matches_all_shared_vectors() -> None:
    path = (
        Path(__file__).parents[3]
        / "contracts"
        / "conformance"
        / "callback-signatures"
        / "vectors.json"
    )
    vectors = json.loads(path.read_text(encoding="utf-8"))
    assert len(vectors) == 8
    for vector in vectors:
        assert (
            create_callback_signature(
                vector["secret"],
                vector["timestamp"],
                vector["deliveryId"],
                vector["rawBodyUtf8"].encode("utf-8"),
            )
            == vector["expectedSignature"]
        )


def test_callback_status_fixture() -> None:
    path = (
        Path(__file__).parents[3]
        / "contracts"
        / "conformance"
        / "protocol"
        / "callback-status-cases.json"
    )
    cases = json.loads(path.read_text(encoding="utf-8"))
    assert len(cases) == 15
    for case in cases:
        assert classify_callback_response(case["status"]) == case["outcome"]


def test_retry_classification_fixture() -> None:
    path = (
        Path(__file__).parents[3]
        / "contracts"
        / "conformance"
        / "protocol"
        / "retry-classification.json"
    )
    cases = json.loads(path.read_text(encoding="utf-8"))
    assert len(cases) == 12
    for case in cases:
        input_value = case["input"]
        actual = (
            "retry"
            if input_value["kind"] == "network-error"
            else classify_callback_response(input_value["status"])
        )
        assert actual == case["outcome"]


def test_serialization_is_compact_utf8_finite_and_non_mutating() -> None:
    result = {"message": "Xin chào 🌏", "nested": {"value": 1}}
    before = json.loads(json.dumps(result))
    assert (
        serialize_result(result)
        == '{"message":"Xin chào 🌏","nested":{"value":1}}'.encode()
    )
    assert result == before
    with pytest.raises(ValueError):
        serialize_result({"number": float("nan")})


def test_retry_uses_stable_body_and_delivery_id_with_fresh_signatures() -> None:
    async def run() -> None:
        session = _Session([_Response(500), _Response(204)])
        times = iter((1785024000.0, 1785024001.0))
        delays: list[float] = []

        async def sleep(delay: float) -> None:
            delays.append(delay)

        outcome = await deliver_callback(
            session,  # type: ignore[arg-type]
            _request(),
            _Settings(),
            delivery_id_factory=lambda: "delivery-1",
            now=lambda: next(times),
            random_value=lambda: 0.5,
            sleep=sleep,
        )

        assert (
            outcome.delivered and outcome.attempts == 2 and outcome.http_status == 204
        )
        assert delays == [0.01]
        assert len(session.requests) == 2
        first, second = session.requests
        assert first["data"] == second["data"] == serialize_result(_request().result)
        assert first["allow_redirects"] is False
        first_headers = first["headers"]
        second_headers = second["headers"]
        assert (
            first_headers[HEADER_DELIVERY_ID]
            == second_headers[HEADER_DELIVERY_ID]
            == "delivery-1"
        )
        assert [first_headers[HEADER_TIMESTAMP], second_headers[HEADER_TIMESTAMP]] == [
            "1785024000",
            "1785024001",
        ]
        assert first_headers[HEADER_SIGNATURE] != second_headers[HEADER_SIGNATURE]
        assert first_headers["User-Agent"] == USER_AGENT
        assert {
            HEADER_KEY_ID,
            HEADER_TIMESTAMP,
            HEADER_DELIVERY_ID,
            HEADER_SIGNATURE,
        }.issubset(first_headers)
        assert "TOP_SECRET_CALLBACK" not in repr(session.requests)

    asyncio.run(run())


def test_same_second_retry_keeps_signature_and_exact_body() -> None:
    async def run() -> None:
        session = _Session([_Response(500), _Response(204)])

        async def no_sleep(_delay: float) -> None:
            return None

        await deliver_callback(
            session,  # type: ignore[arg-type]
            _request(),
            _Settings(),
            delivery_id_factory=lambda: "delivery-1",
            now=lambda: 1785024000.9,
            random_value=lambda: 0.5,
            sleep=no_sleep,
        )
        first, second = session.requests
        assert first["data"] == second["data"]
        assert first["headers"][HEADER_SIGNATURE] == second["headers"][HEADER_SIGNATURE]

    asyncio.run(run())


@pytest.mark.parametrize(
    ("status", "retry_after", "expected_delay"),
    [(408, "5", 1.0), (429, "5", 1.0), (500, "5", 1.0), (503, "5", 1.0)],
)
def test_retry_after_is_numeric_limited_for_every_retryable_response(
    status: int, retry_after: str, expected_delay: float
) -> None:
    async def run() -> None:
        session = _Session(
            [_Response(status, headers={"Retry-After": retry_after}), _Response(204)]
        )
        delays: list[float] = []

        async def sleep(delay: float) -> None:
            delays.append(delay)

        await deliver_callback(
            session,  # type: ignore[arg-type]
            _request(),
            _Settings(),
            delivery_id_factory=lambda: "delivery-1",
            now=lambda: 1785024000.0,
            random_value=lambda: 0.5,
            sleep=sleep,
        )
        assert delays == [expected_delay]

    asyncio.run(run())


def test_shared_retry_after_cases() -> None:
    path = (
        Path(__file__).parents[3]
        / "contracts"
        / "conformance"
        / "protocol"
        / "retry-after-cases.json"
    )
    cases = json.loads(path.read_text(encoding="utf-8"))

    for case in cases:
        actual = retry_after_delay_seconds(
            case["value"], status=503, maximum=case["maximumSeconds"]
        )
        expected = case["expected"]
        assert actual == (
            expected["seconds"] if expected["kind"] == "header-delay" else None
        ), case["name"]


def test_retry_after_is_ignored_for_non_retryable_status() -> None:
    assert retry_after_delay_seconds("5", status=400, maximum=30.0) is None


def test_redirect_and_streamed_oversize_are_not_retried() -> None:
    async def run() -> None:
        redirect_session = _Session([_Response(302), _Response(204)])
        redirect = await deliver_callback(
            redirect_session,  # type: ignore[arg-type]
            _request(),
            _Settings(),
            delivery_id_factory=lambda: "delivery-1",
        )
        assert not redirect.delivered and redirect.attempts == 1
        assert redirect.reason == "non-retryable-http-status"
        assert len(redirect_session.requests) == 1

        oversized = _Response(500, body=b"x" * 33)
        oversized_session = _Session([oversized, _Response(204)])
        outcome = await deliver_callback(
            oversized_session,  # type: ignore[arg-type]
            _request(),
            _Settings(),
            delivery_id_factory=lambda: "delivery-1",
        )
        assert not outcome.delivered and outcome.reason == "response-too-large"
        assert len(oversized_session.requests) == 1
        assert oversized.closed

    asyncio.run(run())


def test_declared_oversize_is_closed_without_read_or_retry() -> None:
    async def run() -> None:
        oversized = _Response(503, body=b"ignored", content_length=33)
        session = _Session([oversized, _Response(204)])
        outcome = await deliver_callback(
            session,  # type: ignore[arg-type]
            _request(),
            _Settings(),
            delivery_id_factory=lambda: "delivery-1",
        )
        assert outcome.reason == "response-too-large"
        assert outcome.http_status == 503
        assert oversized.closed and len(session.requests) == 1

    asyncio.run(run())


def test_network_timeout_and_exhaustion_are_bounded() -> None:
    class TimeoutThenSuccess(_Session):
        def __init__(self) -> None:
            super().__init__([])
            self.attempts = 0

        async def post(self, url: str, **kwargs: Any) -> _Response:
            self.requests.append({"url": url, **kwargs})
            self.attempts += 1
            if self.attempts == 1:
                await asyncio.Event().wait()
                raise AssertionError("unreachable")
            return _Response(204)

    async def run() -> None:
        async def no_sleep(_delay: float) -> None:
            return None

        network = _Session([ClientConnectionError("offline"), _Response(204)])
        network_outcome = await deliver_callback(
            network,  # type: ignore[arg-type]
            _request(),
            _Settings(),
            delivery_id_factory=lambda: "delivery-network",
            sleep=no_sleep,
        )
        assert network_outcome.delivered and network_outcome.attempts == 2

        timeout = TimeoutThenSuccess()
        timeout_outcome = await deliver_callback(
            timeout,  # type: ignore[arg-type]
            _request(),
            _Settings(callback_request_timeout_seconds=0.001),
            delivery_id_factory=lambda: "delivery-timeout",
            sleep=no_sleep,
        )
        assert timeout_outcome.delivered and timeout_outcome.attempts == 2

        exhausted = _Session(
            [ClientConnectionError("offline"), ClientConnectionError("offline")]
        )
        exhausted_outcome = await deliver_callback(
            exhausted,  # type: ignore[arg-type]
            _request(),
            _Settings(callback_max_attempts=2),
            delivery_id_factory=lambda: "delivery-exhausted",
            sleep=no_sleep,
        )
        assert not exhausted_outcome.delivered
        assert exhausted_outcome.attempts == 2
        assert exhausted_outcome.reason == "network-error"

    asyncio.run(run())


def test_shutdown_interrupts_request_and_retry_sleep_without_owned_tasks() -> None:
    class HangingSession(_Session):
        async def post(self, url: str, **kwargs: Any) -> _Response:
            self.requests.append({"url": url, **kwargs})
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    async def run_request() -> None:
        stop = asyncio.Event()
        delivery = asyncio.create_task(
            deliver_callback(
                HangingSession([]),  # type: ignore[arg-type]
                _request(),
                _Settings(callback_request_timeout_seconds=10),
                stop_signal=stop,
                delivery_id_factory=lambda: "delivery-1",
            )
        )
        await asyncio.sleep(0)
        stop.set()
        outcome = await delivery
        assert outcome.reason == "worker-shutdown"
        assert not [
            task
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
            and task.get_name().startswith("tenvyr-worker-callback-")
        ]

    async def run_sleep() -> None:
        stop = asyncio.Event()
        session = _Session([_Response(500)])
        delivery = asyncio.create_task(
            deliver_callback(
                session,  # type: ignore[arg-type]
                _request(),
                _Settings(callback_initial_delay_seconds=10),
                stop_signal=stop,
                delivery_id_factory=lambda: "delivery-1",
            )
        )
        while not session.requests:
            await asyncio.sleep(0)
        await asyncio.sleep(0)
        stop.set()
        outcome = await delivery
        assert outcome.reason == "worker-shutdown"

    asyncio.run(run_request())
    asyncio.run(run_sleep())


def test_failure_hook_supports_sync_async_and_isolates_hook_and_logger_errors() -> None:
    event = make_callback_delivery_failed_event(
        agent="echo-agent",
        invocation_id="invocation-1",
        run_id="run-1",
        delivery_id="delivery-1",
        attempts=3,
        callback_host="callback.example.test",
        reason="network-error",
    )

    class ThrowingLogger:
        def error(self, _message: str, _context: object = None) -> None:
            raise RuntimeError("logger failed")

    async def run() -> None:
        seen: list[str] = []

        def sync_hook(value: CallbackDeliveryFailedEvent) -> None:
            seen.append(str(value["delivery_id"]))

        async def async_hook(value: CallbackDeliveryFailedEvent) -> None:
            seen.append(str(value["run_id"]))

        def broken_hook(_value: CallbackDeliveryFailedEvent) -> None:
            raise RuntimeError("hook failed TOP_SECRET_CALLBACK")

        await notify_callback_delivery_failed(sync_hook, event)
        await notify_callback_delivery_failed(async_hook, event)
        await notify_callback_delivery_failed(
            broken_hook,
            event,
            logger=ThrowingLogger(),  # type: ignore[arg-type]
        )
        assert seen == ["delivery-1", "run-1"]

    asyncio.run(run())


def test_failure_hook_event_is_immutable_and_shutdown_interrupts_async_wait() -> None:
    event = make_callback_delivery_failed_event(
        agent="echo-agent",
        invocation_id="invocation-1",
        run_id="run-1",
        delivery_id="delivery-1",
        attempts=3,
        callback_host="callback.example.test",
        reason="network-error",
    )
    with pytest.raises(TypeError):
        event["reason"] = "changed"  # type: ignore[index]

    async def run() -> None:
        started = asyncio.Event()
        stop = asyncio.Event()

        async def hook(_event: CallbackDeliveryFailedEvent) -> None:
            started.set()
            await asyncio.Event().wait()

        notification = asyncio.create_task(
            notify_callback_delivery_failed(hook, event, stop_signal=stop)
        )
        await started.wait()
        stop.set()
        await notification
        assert not [
            task
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
            and task.get_name().startswith("tenvyr-worker-callback-")
        ]

    asyncio.run(run())


@pytest.mark.parametrize(
    "result",
    (
        {"number": float("inf")},
        {
            "schemaVersion": "1",
            "invocationId": "invocation-1",
            "executionId": "execution-1",
            "stepExecutionId": "step-1",
            "status": "succeeded",
            "error": {
                "code": "NOT_ALLOWED",
                "message": "A success result cannot have an error",
                "retryable": False,
            },
            "completedAt": "2026-07-26T00:00:02.000Z",
        },
    ),
)
def test_invalid_local_result_and_logger_exception_never_send_or_raise(
    result: object,
) -> None:
    class ThrowingLogger:
        def error(self, _message: str, _context: object = None) -> None:
            raise RuntimeError("logger failed")

    async def run() -> None:
        session = _Session([])
        outcome = await deliver_callback(
            session,  # type: ignore[arg-type]
            _request(result),
            _Settings(),
            logger=ThrowingLogger(),  # type: ignore[arg-type]
            delivery_id_factory=lambda: "delivery-1",
        )
        assert outcome.reason == "invalid-result" and outcome.attempts == 0
        assert session.requests == []

    asyncio.run(run())


def test_callback_policy_is_rechecked_before_local_delivery() -> None:
    class RecordingLogger:
        def __init__(self) -> None:
            self.contexts: list[object] = []

        def error(self, _message: str, context: object = None) -> None:
            self.contexts.append(context)

    async def run() -> None:
        session = _Session([])
        logger = RecordingLogger()
        request = _request()
        request = CallbackDeliveryRequest(
            agent=request.agent,
            invocation_id=request.invocation_id,
            run_id=request.run_id,
            callback_url=(
                "https://user:TOP_SECRET_CALLBACK@callback.example.test/results"
            ),
            key_id=request.key_id,
            secret=request.secret,
            result=request.result,
        )

        outcome = await deliver_callback(
            session,  # type: ignore[arg-type]
            request,
            _Settings(),
            logger=logger,  # type: ignore[arg-type]
            delivery_id_factory=lambda: "delivery-1",
        )

        assert outcome.reason == "callback-policy-rejected"
        assert outcome.attempts == 0
        assert session.requests == []
        assert "TOP_SECRET_CALLBACK" not in repr(logger.contexts)

    asyncio.run(run())


def test_callback_session_disables_environment_cookies_and_decompression() -> None:
    async def run() -> None:
        session = create_callback_session()
        try:
            assert session.trust_env is False
            assert session.auto_decompress is False
            assert isinstance(session.cookie_jar, DummyCookieJar)
        finally:
            await session.close()

    asyncio.run(run())


def test_real_loopback_sends_the_signed_bytes_and_retries_once() -> None:
    async def run() -> None:
        received: list[tuple[Mapping[str, str], bytes]] = []
        statuses = iter((500, 204))

        async def receive(request: web.Request) -> web.Response:
            received.append((request.headers, await request.read()))
            return web.Response(status=next(statuses), body=b"ok")

        app = web.Application()
        app.router.add_post("/results", receive)
        runner = web.AppRunner(app, handle_signals=False, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        host, port = runner.addresses[0][:2]
        session = create_callback_session()
        try:
            callback_request = _request()
            callback_request = CallbackDeliveryRequest(
                agent=callback_request.agent,
                invocation_id=callback_request.invocation_id,
                run_id=callback_request.run_id,
                callback_url=f"http://{host}:{port}/results",
                key_id=callback_request.key_id,
                secret=callback_request.secret,
                result=callback_request.result,
            )

            async def no_sleep(_delay: float) -> None:
                return None

            outcome = await deliver_callback(
                session,
                callback_request,
                _Settings(
                    allow_insecure_http=True,
                    _normalized_callback_origins=(("http", str(host), int(port)),),
                ),
                delivery_id_factory=lambda: "delivery-1",
                now=lambda: 1785024000.0,
                sleep=no_sleep,
            )
            assert outcome.delivered and outcome.attempts == 2
            assert len(received) == 2
            assert (
                received[0][1]
                == received[1][1]
                == serialize_result(callback_request.result)
            )
            expected_protocol_headers = {
                HEADER_KEY_ID.lower(),
                HEADER_TIMESTAMP.lower(),
                HEADER_DELIVERY_ID.lower(),
                HEADER_SIGNATURE.lower(),
            }
            actual_protocol_headers = {
                name.lower() for name in received[0][0] if name.lower().startswith("x-")
            }
            assert actual_protocol_headers == expected_protocol_headers
            assert received[0][0]["User-Agent"] == USER_AGENT
            assert "TOP_SECRET_CALLBACK" not in repr(received)
        finally:
            await session.close()
            await runner.cleanup()

    asyncio.run(run())
