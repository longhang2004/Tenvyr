---
title: "M2C Verification Plan: Bounded State ContextSnapshot"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
  - packages/worker/test/callback.spec.ts
  - sdks/python-worker/tests/test_schema_protocol.py
---

# M2C verification plan

## Focused contract cases

Test at minimum:

- absent selector preserves null snapshot and absence of Tenvyr context;
- one/many exact keys, null values, dotted literal keys, and canonical ordering;
- empty, duplicate, unsafe, too-long, too-many, malformed, and missing keys;
- 65,536-byte complete envelope succeeds and 65,537-byte envelope fails, using
  UTF-8 multibyte and astral Unicode cases;
- nested unsafe JSON and non-finite/non-JSON values fail before persistence;
- later mutation of input objects cannot mutate returned/persisted snapshots;
- plan revision round-trip and frozen spec hash distinguish selector changes;
- selected values never include unselected state or prior result output.

## Real PostgreSQL cases

1. Claim stores one attempt and one outbox with deep-equal snapshot/envelope.
2. DataSource restart preserves both and dispatcher uses the same invocation.
3. Outbox insertion failure rolls back attempt and snapshot.
4. Forced attempt/snapshot persistence failure creates no outbox.
5. Two replicas racing one step create exactly one authoritative attempt/outbox.
6. State mutation racing claim observes a coherent old or new semantic version.
7. Retry creates a new attempt snapshot; outbox redelivery does not.
8. Later state mutation leaves historical snapshot bytes unchanged.
9. Projection failure follows deterministic step/onFailure behavior and leaves no
   READY poison loop or outbox.
10. Historical null rows remain readable after any migration.

Run the full PostgreSQL suite twice sequentially with `tenvyr_m2_test`.

## Transport/SDK cases

- Outbox parse/stringify preserves the envelope.
- HTTP adapter loopback delivers it unchanged.
- Kafka adapter/Worker contract delivers it unchanged where the repository's
  broker-free fixtures apply.
- TypeScript handler reads it from `AgentExecutionContext.invocation.context`.
- Python handler reads the semantically identical mapping.
- Neither Worker mutates result/callback semantics because context is present.

## Architecture prohibitions

Add executable guards that fail if:

- adapters, dispatch retry, supervision, AgentEvent handling, or ResultInbox
  synthesize/recompute ContextSnapshot;
- prior result output or artifact descriptor arrays enter it automatically;
- provider SDK/prompt code appears in the Orchestrator;
- a second snapshot persistence authority appears;
- state write integration enters M2C.

## Required gates

Run focused domain, pipeline validation, execution service, engine, adapter, Worker,
and architecture suites; then:

```bash
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test \
  pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test \
  pnpm --filter orchestrator test -- --runInBand
pnpm --filter @tenvyr/contracts test
pnpm --filter @tenvyr/worker test
sdks/python-worker/.venv/bin/python -m pytest sdks/python-worker/tests
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
pnpm build:all
pnpm exec prettier --check <m2c-changed-non-python-files>
git diff --check
```

Apply the HTTP/Kafka open-handle gates from current operations docs if their
runtime code changed. Record every result in `docs/_scratch/m2-program/m2c-receipt.md`.

## Stop conditions

M2C is blocked rather than silently redesigned if it requires a new protocol root
field, a provider-specific envelope, artifact bytes, state mutation, or snapshot
materialization outside the authoritative claim transaction.
