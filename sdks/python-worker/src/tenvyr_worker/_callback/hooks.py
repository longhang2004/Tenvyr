from __future__ import annotations

import asyncio
import inspect
from contextlib import suppress

from .types import (
    CallbackDeliveryFailedEvent,
    CallbackFailureHook,
    CallbackLogger,
    StopSignal,
)


async def notify_callback_delivery_failed(
    hook: CallbackFailureHook | None,
    event: CallbackDeliveryFailedEvent,
    *,
    logger: CallbackLogger | None = None,
    stop_signal: StopSignal | None = None,
) -> None:
    if hook is None or (stop_signal is not None and stop_signal.is_set()):
        return

    hook_task = asyncio.create_task(
        _invoke_hook(hook, event), name="tenvyr-worker-callback-failure-hook"
    )
    stop_task: asyncio.Task[bool] | None = None
    if stop_signal is not None:
        stop_task = asyncio.create_task(
            stop_signal.wait(), name="tenvyr-worker-callback-hook-stop-wait"
        )
    try:
        if stop_task is not None:
            done, _ = await asyncio.wait(
                (hook_task, stop_task), return_when=asyncio.FIRST_COMPLETED
            )
            if stop_task in done and stop_signal is not None and stop_signal.is_set():
                hook_task.cancel()
                with suppress(asyncio.CancelledError):
                    await hook_task
                return
        await hook_task
    except Exception:
        _safe_hook_log(logger, event)
    finally:
        if stop_task is not None:
            stop_task.cancel()
            with suppress(asyncio.CancelledError):
                await stop_task


async def _invoke_hook(
    hook: CallbackFailureHook, event: CallbackDeliveryFailedEvent
) -> None:
    if inspect.iscoroutinefunction(hook) or inspect.iscoroutinefunction(
        type(hook).__call__
    ):
        returned = hook(event)
    else:
        returned = await asyncio.to_thread(hook, event)
    if inspect.isawaitable(returned):
        await returned


def _safe_hook_log(
    logger: CallbackLogger | None, event: CallbackDeliveryFailedEvent
) -> None:
    if logger is None:
        return
    try:
        returned = logger.error(
            "Callback delivery failure hook failed",
            {
                "agent": event["agent"],
                "invocation_id": event["invocation_id"],
                "run_id": event["run_id"],
                "delivery_id": event["delivery_id"],
            },
        )
        if inspect.iscoroutine(returned):
            returned.close()
    except Exception:
        pass
