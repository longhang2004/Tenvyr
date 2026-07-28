from __future__ import annotations

import asyncio
import copy
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest
from aiohttp import ClientSession, web

from tenvyr_worker import TenvyrWorkerConfig, create_tenvyr_worker, define_agent


def _request(invocation_id: str = "invocation-1") -> dict[str, object]:
    return {
        "schemaVersion": "1",
        "invocation": {
            "schemaVersion": "1",
            "invocationId": invocation_id,
            "executionId": "execution-1",
            "stepExecutionId": "step-execution-1",
            "stepId": "echo",
            "target": {"agent": "echo-agent"},
            "input": {"message": "hello"},
            "attempt": 1,
            "createdAt": "2026-07-26T00:00:00.000Z",
            "trace": {"traceId": "trace-1", "correlationId": invocation_id},
        },
        "resultDelivery": {
            "mode": "callback",
            "callbackUrl": "http://127.0.0.1:1/results",
            "authentication": {"scheme": "hmac-sha256", "keyId": "key-1"},
        },
    }


@asynccontextmanager
async def _callback_server() -> AsyncIterator[tuple[str, list[dict[str, object]]]]:
    received: list[dict[str, object]] = []
    delivered = asyncio.Event()

    async def callback(request: web.Request) -> web.Response:
        received.append(json.loads(await request.read()))
        delivered.set()
        return web.Response(status=204)

    app = web.Application()
    app.router.add_post("/results", callback)
    runner = web.AppRunner(app, handle_signals=False, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    host, port = runner.addresses[0][:2]
    try:
        yield f"http://{host}:{port}", received
    finally:
        await runner.cleanup()


def _config(callback_origin: str, **overrides: Any) -> TenvyrWorkerConfig[Any, Any]:
    async def execute(_context: object, value: object) -> object:
        return value

    values: dict[str, object] = {
        "agent": define_agent(name="echo-agent", execute=execute),
        "bearer_token": "worker-token",
        "callback_keys": {"key-1": "callback-secret"},
        "allowed_callback_origins": [callback_origin],
        "allow_insecure_http": True,
        "callback_initial_delay_seconds": 0.01,
        "callback_max_delay_seconds": 0.01,
        "callback_max_attempts": 1,
    }
    values.update(overrides)
    return TenvyrWorkerConfig(**values)  # type: ignore[arg-type]


def _headers(invocation_id: str = "invocation-1") -> dict[str, str]:
    return {
        "Authorization": "Bearer worker-token",
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": invocation_id,
    }


async def _assert_error(response: Any, status: int, code: str) -> None:
    assert response.status == status
    assert (await response.json()) == {
        "error": {"code": code, "message": (await _messages())[code]}
    }


async def _messages() -> dict[str, str]:
    return {
        "NOT_FOUND": "Route not found",
        "UNAUTHORIZED": "Bearer authentication failed",
        "UNSUPPORTED_MEDIA_TYPE": "Content-Type must be application/json",
        "INVALID_JSON": "Request body must be valid JSON",
        "INVALID_REQUEST": "Request does not match HttpAgentRunRequestV1",
        "AGENT_NOT_FOUND": "Target agent is not hosted by this Worker",
        "INVALID_IDEMPOTENCY_KEY": "Idempotency-Key must equal invocationId",
        "UNKNOWN_CALLBACK_KEY": "Callback key ID is not configured",
        "CALLBACK_TARGET_REJECTED": "Callback URL is not allowed",
        "IDEMPOTENCY_CONFLICT": "Invocation ID was already used by another request",
    }


@pytest.mark.asyncio
async def test_health_acceptance_duplicate_and_callback_are_real_http() -> None:
    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(_config(origin))
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        url = f"http://{address.host}:{address.port}"
        async with ClientSession() as client:
            live = await client.get(f"{url}/health/live")
            ready = await client.get(f"{url}/health/ready")
            first = await client.post(
                f"{url}/v1/runs", json=request, headers=_headers()
            )
            second = await client.post(
                f"{url}/v1/runs", json=request, headers=_headers()
            )
            first_body = await first.json()
            assert live.status == ready.status == 200
            assert await live.json() == await ready.json() == {"status": "ok"}
            assert first.status == second.status == 202
            assert await second.json() == first_body
            assert first_body["invocationId"] == "invocation-1"
            assert first_body["status"] == "accepted"
        for _ in range(100):
            if received:
                break
            await asyncio.sleep(0.01)
        assert len(received) == 1
        assert received[0]["status"] == "succeeded"
        await worker.stop()


@pytest.mark.asyncio
async def test_route_validation_and_conflict_mapping() -> None:
    async with _callback_server() as (origin, _received):
        worker = create_tenvyr_worker(_config(origin))
        address = await worker.start(port=0)
        url = f"http://{address.host}:{address.port}"
        base = _request()
        base["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        async with ClientSession() as client:
            await _assert_error(await client.get(f"{url}/unknown"), 404, "NOT_FOUND")
            await _assert_error(
                await client.post(f"{url}/v1/runs", data=b"{}"),
                415,
                "UNSUPPORTED_MEDIA_TYPE",
            )
            await _assert_error(
                await client.post(
                    f"{url}/v1/runs",
                    data=b"{}",
                    headers={"Content-Type": "application/json"},
                ),
                401,
                "UNAUTHORIZED",
            )
            await _assert_error(
                await client.post(f"{url}/v1/runs", data=b"{", headers=_headers()),
                400,
                "INVALID_JSON",
            )
            await _assert_error(
                await client.post(f"{url}/v1/runs", json={}, headers=_headers()),
                400,
                "INVALID_REQUEST",
            )

            wrong_agent = copy.deepcopy(base)
            wrong_agent["invocation"]["target"]["agent"] = "other"  # type: ignore[index]
            await _assert_error(
                await client.post(
                    f"{url}/v1/runs", json=wrong_agent, headers=_headers()
                ),
                404,
                "AGENT_NOT_FOUND",
            )
            await _assert_error(
                await client.post(
                    f"{url}/v1/runs", json=base, headers=_headers("other")
                ),
                400,
                "INVALID_IDEMPOTENCY_KEY",
            )
            unknown_key = copy.deepcopy(base)
            unknown_key["resultDelivery"]["authentication"]["keyId"] = "other"  # type: ignore[index]
            await _assert_error(
                await client.post(
                    f"{url}/v1/runs", json=unknown_key, headers=_headers()
                ),
                400,
                "UNKNOWN_CALLBACK_KEY",
            )
            rejected = copy.deepcopy(base)
            rejected["resultDelivery"]["callbackUrl"] = "http://example.com/results"  # type: ignore[index]
            await _assert_error(
                await client.post(f"{url}/v1/runs", json=rejected, headers=_headers()),
                400,
                "CALLBACK_TARGET_REJECTED",
            )
            accepted = await client.post(
                f"{url}/v1/runs", json=base, headers=_headers()
            )
            assert accepted.status == 202
            conflict = copy.deepcopy(base)
            conflict["invocation"]["input"] = {"message": "different"}  # type: ignore[index]
            await _assert_error(
                await client.post(f"{url}/v1/runs", json=conflict, headers=_headers()),
                409,
                "IDEMPOTENCY_CONFLICT",
            )
        await worker.stop()


@pytest.mark.asyncio
async def test_content_length_and_chunked_body_limits() -> None:
    async with _callback_server() as (origin, _received):
        worker = create_tenvyr_worker(_config(origin, max_request_bytes=16))
        address = await worker.start(port=0)
        url = f"http://{address.host}:{address.port}/v1/runs"

        async def chunks() -> AsyncIterator[bytes]:
            yield b"{" + b" " * 32

        async with ClientSession() as client:
            response = await client.post(url, data=b"{" + b" " * 32, headers=_headers())
            assert response.status == 413
            assert (await response.json())["error"]["code"] == "REQUEST_TOO_LARGE"
            assert response.headers.get("Connection") == "close"
        async with ClientSession() as client:
            response = await client.post(url, data=chunks(), headers=_headers())
            assert response.status == 413
            assert (await response.json())["error"]["code"] == "REQUEST_TOO_LARGE"
            assert response.headers.get("Connection") == "close"
        await worker.stop()


@pytest.mark.asyncio
async def test_unauthorized_request_is_rejected_without_waiting_for_its_body() -> None:
    async with _callback_server() as (origin, _received):
        worker = create_tenvyr_worker(_config(origin))
        address = await worker.start(port=0)
        reader, writer = await asyncio.open_connection(address.host, address.port)
        try:
            writer.write(
                (
                    "POST /v1/runs HTTP/1.1\r\n"
                    f"Host: {address.host}:{address.port}\r\n"
                    "Content-Type: application/json\r\n"
                    "Authorization: Bearer wrong\r\n"
                    "Content-Length: 1000000\r\n\r\n"
                ).encode()
            )
            await writer.drain()
            response = await asyncio.wait_for(reader.read(), 1)
            assert b"HTTP/1.1 401 Unauthorized" in response
            assert b'"code":"UNAUTHORIZED"' in response
            assert b"Connection: close" in response
        finally:
            writer.close()
            await writer.wait_closed()
            await worker.stop()


@pytest.mark.asyncio
async def test_duplicate_precedes_capacity_and_store_capacity_has_distinct_error() -> (
    None
):
    gate = asyncio.Event()
    started = asyncio.Event()

    async def execute(_context: object, value: object) -> object:
        started.set()
        await gate.wait()
        return value

    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                execution_concurrency=1,
                max_queued_runs=0,
                idempotency_max_entries=1,
            )
        )
        address = await worker.start(port=0)
        url = f"http://{address.host}:{address.port}/v1/runs"
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        async with ClientSession() as client:
            first = await client.post(url, json=request, headers=_headers())
            await asyncio.wait_for(started.wait(), 1)
            duplicate = await client.post(url, json=request, headers=_headers())
            assert first.status == duplicate.status == 202
            assert await first.json() == await duplicate.json()
            gate.set()
            for _ in range(100):
                if received:
                    break
                await asyncio.sleep(0.01)
            second = _request("invocation-2")
            second["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
            response = await client.post(
                url, json=second, headers=_headers("invocation-2")
            )
            assert response.status == 429
            assert (await response.json())["error"]["code"] == (
                "IDEMPOTENCY_CAPACITY_FULL"
            )
        await worker.stop()


@pytest.mark.asyncio
async def test_unexpected_submission_failure_is_static_internal_error() -> None:
    async with _callback_server() as (origin, _received):
        worker = create_tenvyr_worker(_config(origin))
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]

        def broken_lookup(*_args: object, **_kwargs: object) -> object:
            raise RuntimeError("sensitive internal detail")

        worker._store.lookup = broken_lookup  # type: ignore[attr-defined,method-assign]
        async with ClientSession() as client:
            response = await client.post(
                f"http://{address.host}:{address.port}/v1/runs",
                json=request,
                headers=_headers(),
            )
            assert response.status == 500
            assert await response.json() == {
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Worker could not process the request",
                }
            }
            assert "sensitive" not in await response.text()
        await worker.stop()


@pytest.mark.asyncio
async def test_unexpected_enqueue_failure_rolls_back_idempotency_record() -> None:
    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(_config(origin))
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]

        def broken_enqueue(_run: object) -> bool:
            raise RuntimeError("sensitive enqueue detail")

        worker._scheduler.enqueue = broken_enqueue  # type: ignore[attr-defined,method-assign]
        async with ClientSession() as client:
            response = await client.post(
                f"http://{address.host}:{address.port}/v1/runs",
                json=request,
                headers=_headers(),
            )
            assert response.status == 500
            assert (await response.json())["error"]["code"] == "INTERNAL_ERROR"
        assert worker._store.get("invocation-1") is None  # type: ignore[attr-defined]
        assert received == []
        await worker.stop()
