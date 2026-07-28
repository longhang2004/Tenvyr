from __future__ import annotations

import pytest

from tenvyr_worker._runtime.idempotency import (
    IdempotencyCapacityError,
    IdempotencyRecordExistsError,
    InMemoryIdempotencyStore,
    RunState,
)


def _create(
    store: InMemoryIdempotencyStore,
    invocation_id: str,
    *,
    fingerprint: bytes | None = None,
    now: float = 0.0,
):
    return store.create(
        invocation_id=invocation_id,
        request_fingerprint=fingerprint or invocation_id.encode(),
        run_id=f"run-{invocation_id}",
        accepted_at="2026-07-26T00:00:00.000Z",
        now=now,
    )


def test_duplicate_and_conflict_keep_original_acceptance() -> None:
    store = InMemoryIdempotencyStore(ttl_seconds=10.0, max_entries=2)
    record = _create(store, "one", fingerprint=b"same")

    duplicate = store.lookup("one", b"same", now=1.0)
    conflict = store.lookup("one", b"other", now=1.0)

    assert duplicate.kind == "duplicate" and duplicate.record is record
    assert conflict.kind == "conflict" and conflict.record is record
    assert duplicate.record.run_id == "run-one"
    assert duplicate.record.accepted_at == "2026-07-26T00:00:00.000Z"


def test_existing_record_is_checked_before_capacity() -> None:
    store = InMemoryIdempotencyStore(ttl_seconds=10.0, max_entries=1)
    _create(store, "one")

    assert store.lookup("one", b"one", now=1.0).kind == "duplicate"
    with pytest.raises(IdempotencyRecordExistsError):
        _create(store, "one")
    with pytest.raises(IdempotencyCapacityError):
        _create(store, "two")


def test_cleanup_scans_past_active_head_and_only_expires_terminal() -> None:
    store = InMemoryIdempotencyStore(ttl_seconds=10.0, max_entries=4)
    active = _create(store, "active")
    delivered = _create(store, "delivered")
    callback_failed = _create(store, "callback-failed")
    pending = _create(store, "pending")
    store.update_state(active, RunState.RUNNING, now=0.0)
    store.update_state(delivered, RunState.DELIVERED, now=0.0)
    store.update_state(callback_failed, RunState.CALLBACK_FAILED, now=0.0)
    store.update_state(pending, RunState.CALLBACK_PENDING, now=0.0)

    assert store.cleanup(now=10.0) == 2
    assert store.get("active") is active
    assert store.get("pending") is pending
    assert store.get("delivered") is None
    assert store.get("callback-failed") is None


def test_expired_terminal_key_can_be_reused_and_active_key_cannot() -> None:
    store = InMemoryIdempotencyStore(ttl_seconds=2.0, max_entries=1)
    original = _create(store, "one", now=0.0)
    store.update_state(original, RunState.DELIVERED, now=1.0)

    replacement = _create(store, "one", now=3.0)

    assert replacement is not original
    assert replacement.state is RunState.ACCEPTED


def test_rollback_deletes_only_the_expected_record() -> None:
    store = InMemoryIdempotencyStore(ttl_seconds=10.0, max_entries=1)
    record = _create(store, "one")

    assert not store.delete("one", expected=object())
    assert store.get("one") is record
    assert store.delete("one", expected=record)
    assert store.get("one") is None


def test_record_contains_no_callback_secret_fields() -> None:
    store = InMemoryIdempotencyStore(ttl_seconds=10.0, max_entries=1)
    record = _create(store, "one")

    assert set(record.__dataclass_fields__) == {
        "invocation_id",
        "request_fingerprint",
        "run_id",
        "accepted_at",
        "state",
        "created_at",
        "updated_at",
    }
