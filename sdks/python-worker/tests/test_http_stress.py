from __future__ import annotations

import asyncio
import copy
from typing import Any

import pytest
from aiohttp import ClientSession
from test_http_submission import _callback_server, _config, _headers, _request

from tenvyr_worker import create_tenvyr_worker, define_agent


async def _post(
    client: ClientSession,
    url: str,
    request: dict[str, object],
    invocation_id: str,
) -> tuple[int, dict[str, Any]]:
    response = await client.post(url, json=request, headers=_headers(invocation_id))
    return response.status, await response.json()


@pytest.mark.stress
@pytest.mark.asyncio
async def test_one_hundred_identical_and_conflicting_requests_are_atomic() -> None:
    executions = 0

    async def execute(_context: object, value: object) -> object:
        nonlocal executions
        executions += 1
        await asyncio.sleep(0.03)
        return value

    async with _callback_server() as (origin, _received):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                execution_concurrency=1,
            )
        )
        address = await worker.start(port=0)
        url = f"http://{address.host}:{address.port}/v1/runs"
        request = _request()
        request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
        async with ClientSession() as client:
            identical = await asyncio.gather(
                *(_post(client, url, request, "invocation-1") for _ in range(100))
            )
            assert {status for status, _ in identical} == {202}
            assert len({body["runId"] for _, body in identical}) == 1

            conflict_requests = []
            for index in range(100):
                changed = copy.deepcopy(request)
                changed["invocation"]["input"] = {"index": index}  # type: ignore[index]
                conflict_requests.append(_post(client, url, changed, "invocation-1"))
            conflicts = await asyncio.gather(*conflict_requests)
            assert {status for status, _ in conflicts} == {409}
            assert {body["error"]["code"] for _, body in conflicts} == {
                "IDEMPOTENCY_CONFLICT"
            }
            racing = []
            for index in range(100):
                changed = _request("fresh-race")
                changed["invocation"]["input"] = {"index": index}  # type: ignore[index]
                changed["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
                racing.append(_post(client, url, changed, "fresh-race"))
            race = await asyncio.gather(*racing)
            assert sum(status == 202 for status, _ in race) == 1
            assert sum(status == 409 for status, _ in race) == 99
        await worker.stop()
        assert executions == 2


@pytest.mark.stress
@pytest.mark.asyncio
async def test_exact_capacity_and_fifo_with_twenty_way_overflow() -> None:
    gate = asyncio.Event()
    started = asyncio.Event()
    order: list[int] = []

    async def execute(_context: object, value: object) -> object:
        index = value["index"]  # type: ignore[index]
        order.append(index)
        if index == 0:
            started.set()
            await gate.wait()
        return value

    async with _callback_server() as (origin, _received):
        worker = create_tenvyr_worker(
            _config(
                origin,
                agent=define_agent(name="echo-agent", execute=execute),
                execution_concurrency=1,
                max_queued_runs=1,
            )
        )
        address = await worker.start(port=0)
        url = f"http://{address.host}:{address.port}/v1/runs"

        def indexed(index: int) -> dict[str, object]:
            request = _request(f"invocation-{index}")
            request["invocation"]["input"] = {"index": index}  # type: ignore[index]
            request["resultDelivery"]["callbackUrl"] = f"{origin}/results"  # type: ignore[index]
            return request

        async with ClientSession() as client:
            assert (await _post(client, url, indexed(0), "invocation-0"))[0] == 202
            await asyncio.wait_for(started.wait(), 1)
            assert (await _post(client, url, indexed(1), "invocation-1"))[0] == 202
            overflow = await asyncio.gather(
                *(
                    _post(client, url, indexed(index), f"invocation-{index}")
                    for index in range(2, 20)
                )
            )
            assert [status for status, _ in overflow] == [429] * 18
            assert {body["error"]["code"] for _, body in overflow} == {"QUEUE_FULL"}
            gate.set()
            for _ in range(100):
                if order == [0, 1]:
                    break
                await asyncio.sleep(0.01)
            assert (await _post(client, url, indexed(2), "invocation-2"))[0] == 202
            for _ in range(100):
                if order == [0, 1, 2]:
                    break
                await asyncio.sleep(0.01)
        await worker.stop()
        assert order == [0, 1, 2]
