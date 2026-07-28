from __future__ import annotations

from typing import TypeVar

from .config import TenvyrWorkerConfig
from .types import TenvyrWorker

InputT = TypeVar("InputT")
OutputT = TypeVar("OutputT")


def create_tenvyr_worker(
    config: TenvyrWorkerConfig[InputT, OutputT],
) -> TenvyrWorker:
    from .._runtime.worker import WorkerRuntime

    return WorkerRuntime(config)
