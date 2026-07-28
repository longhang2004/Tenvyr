from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

import pytest
from aiohttp import ClientError, ClientSession
from test_http_submission import _callback_server, _config, _headers, _request

from tenvyr_worker import WorkerLifecycleState, create_tenvyr_worker, define_agent


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_start_stop_are_shared_and_port_zero_is_reported() -> None:
    async with _callback_server() as (origin, _received):
        worker = create_tenvyr_worker(_config(origin))
        first, second = await asyncio.gather(worker.start(port=0), worker.start(port=0))
        assert first == second == await worker.start(port=0)
        assert first.host == "127.0.0.1" and first.port > 0
        assert worker.get_state() is WorkerLifecycleState.RUNNING
        await asyncio.gather(worker.stop(), worker.stop())
        await worker.stop()
        assert worker.get_state() is WorkerLifecycleState.STOPPED
        with pytest.raises(RuntimeError, match="cannot start from stopped"):
            await worker.start(port=0)


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_cancelling_one_stop_waiter_preserves_shared_shutdown() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def execute(_context: object, value: object) -> object:
        entered.set()
        await release.wait()
        return value

    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(
            _config(origin, agent=define_agent(name="echo-agent", execute=execute))
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        async with ClientSession() as client:
            response = await client.post(
                f"http://{address.host}:{address.port}/v1/runs",
                json=request,
                headers=_headers(),
            )
            assert response.status == 202
            await entered.wait()
            first = asyncio.create_task(worker.stop(grace_seconds=0.5))
            while worker.get_state() is not WorkerLifecycleState.STOPPING:
                await asyncio.sleep(0)
            second = asyncio.create_task(worker.stop(grace_seconds=0.5))
            await asyncio.sleep(0)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            release.set()
            await asyncio.wait_for(second, 1)

        assert worker.get_state() is WorkerLifecycleState.STOPPED
        assert len(received) == 1 and received[0]["status"] == "succeeded"
        assert not [
            task
            for task in asyncio.all_tasks()
            if task.get_name().startswith("tenvyr-worker-")
        ]


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_stop_before_start_is_terminal() -> None:
    worker = create_tenvyr_worker(_config("http://127.0.0.1:1"))
    await worker.stop()
    assert worker.get_state() is WorkerLifecycleState.STOPPED
    with pytest.raises(RuntimeError, match="cannot start from stopped"):
        await worker.start(port=0)


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_partial_bind_failure_cleans_runner_and_cannot_restart() -> None:
    occupied = await asyncio.start_server(lambda _reader, _writer: None, "127.0.0.1", 0)
    port = occupied.sockets[0].getsockname()[1]
    try:
        worker = create_tenvyr_worker(_config("http://127.0.0.1:1"))
        with pytest.raises(OSError):
            await worker.start(port=port)
        assert worker.get_state() is WorkerLifecycleState.FAILED
        await worker.stop()
        assert worker.get_state() is WorkerLifecycleState.STOPPED
    finally:
        occupied.close()
        await occupied.wait_closed()


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_shutdown_delivers_queued_cancel_and_leaves_no_tasks() -> None:
    active = asyncio.Event()

    async def execute(context: Any, value: object) -> object:
        active.set()
        await context.wait_cancelled()
        context.raise_if_cancelled()
        return value

    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                execution_concurrency=1,
                max_queued_runs=1,
            )
        )
        address = await worker.start(port=0)
        url = f"http://{address.host}:{address.port}"

        def run(invocation_id: str) -> dict[str, object]:
            value = _request(invocation_id)
            value["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
            return value

        async with ClientSession() as client:
            first = await client.post(
                f"{url}/v1/runs", json=run("active"), headers=_headers("active")
            )
            assert first.status == 202
            await asyncio.wait_for(active.wait(), 1)
            second = await client.post(
                f"{url}/v1/runs", json=run("queued"), headers=_headers("queued")
            )
            assert second.status == 202
            await worker.stop(grace_seconds=0.05)
            assert worker.get_state() is WorkerLifecycleState.STOPPED
            with pytest.raises(ClientError):
                await client.get(f"{url}/health/live")

        shutdown_callbacks = [
            result
            for result in received
            if result["status"] == "cancelled"
            and result["error"]["code"] == "WORKER_SHUTDOWN"
        ]
        assert [result["invocationId"] for result in shutdown_callbacks] == ["queued"]
        await asyncio.sleep(0)
        assert not [
            task.get_name()
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
            and task.get_name().startswith("tenvyr-worker-")
        ]


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_active_handler_can_finish_successfully_inside_grace() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def execute(_context: object, value: object) -> object:
        entered.set()
        await release.wait()
        return value

    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(
            _config(origin, agent=define_agent(name="echo-agent", execute=execute))
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        async with ClientSession() as client:
            response = await client.post(
                f"http://{address.host}:{address.port}/v1/runs",
                json=request,
                headers=_headers(),
            )
            assert response.status == 202
            await entered.wait()
            asyncio.get_running_loop().call_later(0.02, release.set)
            await worker.stop(grace_seconds=0.5)
        assert len(received) == 1
        assert received[0]["status"] == "succeeded"


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_body_read_started_before_stop_cannot_reserve_after_stop() -> None:
    first_chunk_sent = asyncio.Event()
    finish_body = asyncio.Event()

    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(_config(origin))
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        raw = json.dumps(request).encode()

        async def delayed_body() -> Any:
            yield raw[: len(raw) // 2]
            first_chunk_sent.set()
            await finish_body.wait()
            yield raw[len(raw) // 2 :]

        async with ClientSession() as client:
            submission = asyncio.create_task(
                client.post(
                    f"http://{address.host}:{address.port}/v1/runs",
                    data=delayed_body(),
                    headers=_headers(),
                )
            )
            await asyncio.wait_for(first_chunk_sent.wait(), 1)
            stopping = asyncio.create_task(worker.stop())
            while worker.get_state() is not WorkerLifecycleState.STOPPING:
                await asyncio.sleep(0)
            finish_body.set()
            response = await asyncio.wait_for(submission, 2)
            assert response.status == 503
            assert (await response.json())["error"]["code"] == "WORKER_NOT_READY"
            await stopping
        assert received == []


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_cancellation_suppressing_async_work_is_detached_and_observed() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()

    async def execute(_context: object, value: object) -> object:
        entered.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            await release.wait()
        return value

    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(
            _config(origin, agent=define_agent(name="echo-agent", execute=execute))
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        async with ClientSession() as client:
            response = await client.post(
                f"http://{address.host}:{address.port}/v1/runs",
                json=request,
                headers=_headers(),
            )
            assert response.status == 202
            await entered.wait()
            await asyncio.wait_for(worker.stop(grace_seconds=0.2), 1)
        assert received == []
        assert not [
            task
            for task in asyncio.all_tasks()
            if task.get_name().startswith("tenvyr-worker-")
        ]
        release.set()
        await asyncio.sleep(0)


@pytest.mark.lifecycle
@pytest.mark.asyncio
async def test_late_sync_thread_is_outside_worker_ownership() -> None:
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    def execute(_context: object, value: object) -> object:
        entered.set()
        release.wait(2)
        finished.set()
        return value

    async with _callback_server() as (origin, received):
        worker = create_tenvyr_worker(
            _config(origin, agent=define_agent(name="echo-agent", execute=execute))
        )
        address = await worker.start(port=0)
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        async with ClientSession() as client:
            response = await client.post(
                f"http://{address.host}:{address.port}/v1/runs",
                json=request,
                headers=_headers(),
            )
            assert response.status == 202
            assert await asyncio.to_thread(entered.wait, 1)
            await asyncio.wait_for(worker.stop(grace_seconds=0.2), 1)
        assert received == []
        assert not [
            task
            for task in asyncio.all_tasks()
            if task.get_name().startswith("tenvyr-worker-")
        ]
        release.set()
        assert await asyncio.to_thread(finished.wait, 1)
