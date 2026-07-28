from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import pytest

from tenvyr_worker._runtime.scheduler import RunScheduler


@dataclass
class _Run:
    run_callback: Callable[[], Awaitable[None] | None]
    cancel_callback: Callable[[], Awaitable[None] | None] = lambda: None

    def run(self) -> Awaitable[None] | None:
        return self.run_callback()

    def cancel(self) -> Awaitable[None] | None:
        return self.cancel_callback()


async def _wait_until(predicate: Callable[[], bool]) -> None:
    for _ in range(10):
        if predicate():
            return
        await asyncio.sleep(0)
    assert predicate()


@pytest.mark.asyncio
async def test_scheduler_enforces_concurrency_and_fifo() -> None:
    scheduler = RunScheduler(concurrency=2, max_queued_runs=2)
    gates = [asyncio.Event() for _ in range(4)]
    started: list[int] = []

    async def execute(index: int) -> None:
        started.append(index)
        await gates[index].wait()

    for index in range(4):
        assert scheduler.enqueue(_Run(lambda index=index: execute(index)))
    assert not scheduler.has_capacity()
    await _wait_until(lambda: len(started) == 2)
    assert started == [0, 1]

    gates[0].set()
    await _wait_until(lambda: len(started) == 3)
    assert started == [0, 1, 2]

    gates[1].set()
    await _wait_until(lambda: len(started) == 4)
    assert started == [0, 1, 2, 3]
    gates[2].set()
    gates[3].set()
    await scheduler.wait_idle()


@pytest.mark.asyncio
async def test_scheduler_capacity_counts_active_plus_queued_exactly() -> None:
    scheduler = RunScheduler(concurrency=1, max_queued_runs=1)
    gate = asyncio.Event()
    assert scheduler.enqueue(_Run(gate.wait))
    assert scheduler.enqueue(_Run(lambda: None))
    assert not scheduler.enqueue(_Run(lambda: None))
    await asyncio.sleep(0)
    assert scheduler.active_count == 1
    assert scheduler.queued_count == 1
    gate.set()
    await scheduler.wait_idle()


@pytest.mark.asyncio
async def test_enqueue_rolls_back_when_drain_scheduling_fails() -> None:
    scheduler = RunScheduler(concurrency=1, max_queued_runs=0)

    def fail() -> None:
        raise RuntimeError("loop rejected callback")

    scheduler._schedule_drain = fail  # type: ignore[method-assign]
    with pytest.raises(RuntimeError, match="loop rejected callback"):
        scheduler.enqueue(_Run(lambda: None))
    assert scheduler.queued_count == 0
    assert scheduler.has_capacity()


@pytest.mark.asyncio
async def test_scheduler_isolates_failure_and_tracks_named_tasks() -> None:
    scheduler = RunScheduler(concurrency=1, max_queued_runs=1)
    ran_second = asyncio.Event()

    async def fail() -> None:
        raise RuntimeError("private handler failure")

    assert scheduler.enqueue(_Run(fail))
    assert scheduler.enqueue(_Run(lambda: ran_second.set()))
    await asyncio.sleep(0)

    assert scheduler.active_tasks
    assert all(
        task.get_name().startswith("tenvyr-worker-run-")
        for task in scheduler.active_tasks
    )

    await scheduler.wait_idle()
    assert ran_second.is_set()
    assert not scheduler.active_tasks


@pytest.mark.asyncio
async def test_stop_accepting_cancels_queued_but_not_active() -> None:
    scheduler = RunScheduler(concurrency=1, max_queued_runs=2)
    gate = asyncio.Event()
    cancelled: list[str] = []
    assert scheduler.enqueue(_Run(gate.wait, lambda: cancelled.append("active")))
    assert scheduler.enqueue(_Run(lambda: None, lambda: cancelled.append("queued-1")))
    assert scheduler.enqueue(_Run(lambda: None, lambda: cancelled.append("queued-2")))
    await asyncio.sleep(0)

    await scheduler.stop_accepting()

    assert cancelled == ["queued-1", "queued-2"]
    assert not scheduler.enqueue(_Run(lambda: None))
    gate.set()
    await scheduler.wait_idle()
