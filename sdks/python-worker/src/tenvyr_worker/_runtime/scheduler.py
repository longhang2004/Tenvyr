"""Small bounded FIFO scheduler for accepted agent runs."""

from __future__ import annotations

import asyncio
import inspect
from collections import deque
from collections.abc import Awaitable
from typing import Protocol


class ScheduledRun(Protocol):
    def run(self) -> Awaitable[None] | None: ...

    def cancel(self) -> Awaitable[None] | None: ...


class RunScheduler:
    def __init__(self, *, concurrency: int, max_queued_runs: int) -> None:
        self._concurrency = concurrency
        self._max_queued_runs = max_queued_runs
        self._accepting = True
        self._queue: deque[ScheduledRun] = deque()
        self._active_tasks: set[asyncio.Task[None]] = set()
        self._idle_waiters: set[asyncio.Future[None]] = set()
        self._drain_scheduled = False
        self._sequence = 0

    @property
    def accepting(self) -> bool:
        return self._accepting

    @property
    def active_count(self) -> int:
        return len(self._active_tasks)

    @property
    def queued_count(self) -> int:
        return len(self._queue)

    @property
    def active_tasks(self) -> frozenset[asyncio.Task[None]]:
        return frozenset(self._active_tasks)

    def has_capacity(self) -> bool:
        return (
            self.active_count + self.queued_count
            < self._concurrency + self._max_queued_runs
        )

    def enqueue(self, run: ScheduledRun) -> bool:
        if not self._accepting or not self.has_capacity():
            return False
        self._queue.append(run)
        try:
            self._schedule_drain()
        except Exception:
            self._queue.pop()
            raise
        return True

    async def stop_accepting(self) -> None:
        self._accepting = False
        queued = list(self._queue)
        self._queue.clear()
        outcomes: list[Awaitable[None]] = []
        for run in queued:
            try:
                outcome = run.cancel()
            except Exception:
                outcome = None
            if inspect.isawaitable(outcome):
                outcomes.append(outcome)
        if outcomes:
            await asyncio.gather(*outcomes, return_exceptions=True)
        self._resolve_idle()

    def cancel_active(self) -> None:
        for task in tuple(self._active_tasks):
            task.cancel()

    async def wait_idle(self) -> None:
        if not self._active_tasks and not self._queue:
            return
        waiter = asyncio.get_running_loop().create_future()
        self._idle_waiters.add(waiter)
        try:
            await waiter
        finally:
            self._idle_waiters.discard(waiter)

    def _schedule_drain(self) -> None:
        if self._drain_scheduled:
            return
        self._drain_scheduled = True
        asyncio.get_running_loop().call_soon(self._drain)

    def _drain(self) -> None:
        self._drain_scheduled = False
        while (
            self._accepting
            and len(self._active_tasks) < self._concurrency
            and self._queue
        ):
            run = self._queue.popleft()
            self._sequence += 1
            task = asyncio.create_task(
                self._run_isolated(run),
                name=f"tenvyr-worker-run-{self._sequence}",
            )
            self._active_tasks.add(task)
            task.add_done_callback(self._run_done)
        self._resolve_idle()

    async def _run_isolated(self, run: ScheduledRun) -> None:
        try:
            outcome = run.run()
            if inspect.isawaitable(outcome):
                await outcome
        except Exception:
            # Individual run failures are reported by execution/callback code.
            return

    def _run_done(self, task: asyncio.Task[None]) -> None:
        self._active_tasks.discard(task)
        if not task.cancelled():
            task.exception()  # retrieve any BaseException subclass not isolated above
        if self._accepting and self._queue:
            self._schedule_drain()
        self._resolve_idle()

    def _resolve_idle(self) -> None:
        if self._active_tasks or self._queue:
            return
        for waiter in tuple(self._idle_waiters):
            if not waiter.done():
                waiter.set_result(None)
        self._idle_waiters.clear()
