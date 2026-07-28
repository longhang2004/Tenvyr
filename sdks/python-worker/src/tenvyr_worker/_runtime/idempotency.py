"""Bounded process-local idempotency records."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal


class RunState(StrEnum):
    ACCEPTED = "accepted"
    QUEUED = "queued"
    RUNNING = "running"
    CALLBACK_PENDING = "callback_pending"
    DELIVERED = "delivered"
    CALLBACK_FAILED = "callback_failed"


_TERMINAL_STATES = frozenset({RunState.DELIVERED, RunState.CALLBACK_FAILED})


@dataclass(slots=True)
class RunRecord:
    invocation_id: str
    request_fingerprint: bytes
    run_id: str
    accepted_at: str
    state: RunState
    created_at: float
    updated_at: float


@dataclass(frozen=True, slots=True)
class LookupResult:
    kind: Literal["miss", "duplicate", "conflict"]
    record: RunRecord | None = None


class IdempotencyRecordExistsError(RuntimeError):
    pass


class IdempotencyCapacityError(RuntimeError):
    pass


class InMemoryIdempotencyStore:
    def __init__(self, *, ttl_seconds: float, max_entries: int) -> None:
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._records: dict[str, RunRecord] = {}

    def lookup(
        self, invocation_id: str, fingerprint: bytes, *, now: float
    ) -> LookupResult:
        record = self._records.get(invocation_id)
        if record is None:
            return LookupResult("miss")
        if self._is_expired_terminal(record, now):
            del self._records[invocation_id]
            return LookupResult("miss")
        kind: Literal["duplicate", "conflict"] = (
            "duplicate" if record.request_fingerprint == fingerprint else "conflict"
        )
        return LookupResult(kind, record)

    def create(
        self,
        *,
        invocation_id: str,
        request_fingerprint: bytes,
        run_id: str,
        accepted_at: str,
        now: float,
    ) -> RunRecord:
        existing = self._records.get(invocation_id)
        if existing is not None and self._is_expired_terminal(existing, now):
            del self._records[invocation_id]
        elif existing is not None:
            raise IdempotencyRecordExistsError("Idempotency record already exists")

        if len(self._records) >= self._max_entries:
            self.cleanup(now=now)
        if len(self._records) >= self._max_entries:
            raise IdempotencyCapacityError("Idempotency store capacity exhausted")

        record = RunRecord(
            invocation_id=invocation_id,
            request_fingerprint=request_fingerprint,
            run_id=run_id,
            accepted_at=accepted_at,
            state=RunState.ACCEPTED,
            created_at=now,
            updated_at=now,
        )
        self._records[invocation_id] = record
        return record

    def get(self, invocation_id: str) -> RunRecord | None:
        return self._records.get(invocation_id)

    def update_state(self, record: RunRecord, state: RunState, *, now: float) -> None:
        if self._records.get(record.invocation_id) is not record:
            return
        record.state = state
        record.updated_at = now

    def delete(self, invocation_id: str, *, expected: object | None = None) -> bool:
        record = self._records.get(invocation_id)
        if record is None or (expected is not None and record is not expected):
            return False
        del self._records[invocation_id]
        return True

    def cleanup(self, *, now: float) -> int:
        expired = [
            invocation_id
            for invocation_id, record in self._records.items()
            if self._is_expired_terminal(record, now)
        ]
        for invocation_id in expired:
            del self._records[invocation_id]
        return len(expired)

    def __len__(self) -> int:
        return len(self._records)

    def _is_expired_terminal(self, record: RunRecord, now: float) -> bool:
        return (
            record.state in _TERMINAL_STATES
            and record.updated_at + self._ttl_seconds <= now
        )
