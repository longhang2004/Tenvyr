---
title: "M7 Specification: Execution Capsule, Replay, Comparison, and Projection"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/M7-execution-capsule/PLAN.md
  - docs/roadmap/observability-provenance.md
  - services/orchestrator/src/services/agent-event.service.ts
  - packages/worker/src/observability/safe-logger.ts
---

# M7 Execution Capsule specification

## Concepts

- `ExecutionCapsuleV1`: versioned reconstructable read/export DTO over authoritative
  facts, not a new authority table.
- `CapsuleManifest`: optional immutable request/hash/completeness/export metadata.
- `EvidenceCompleteness`: explicit missing, legacy, unverified, unavailable, or
  runtime-asserted classifications.
- `ReplayRequest`: immutable source capsule reference plus controlled overrides,
  policy decision, and new target Execution relation.
- `ExecutionComparison`: deterministic structural drift categories.
- `ProvenanceProjection`: derived entities/activities/agents/relationships with
  authority labels.
- `TelemetryProjection`: failure-isolated OTLP/W3C output.

## Capsule assembly behavior

For the first slice, require a terminal source execution unless the output is
explicitly `livePointInTime` with `capturedAt` and completeness warning. Assemble in
one PostgreSQL repeatable-read transaction so sections cannot mix revisions.

An explicit bounded schema may reference/include:

- execution identity/status/input/config/pipeline hash/termination;
- all plan revisions and active/frozen relationships;
- logical steps and all attempts with input/context/executor snapshots;
- dispatch facts, canonical results, conflicts, events/conflicts;
- artifacts, producer and exposure lineage, state version/write provenance;
- policy, approval, budget, Planner proposal/revision, delegation facts;
- runtime/model/tool/version claims where actually captured;
- counts, hashes, completeness/warnings, schema/convention versions.

Default DTO excludes secrets, credential values, artifact bytes, full logs, and
unbounded payload duplication. Large event/artifact/delegation sections use bounded
keyset pages or external references with counts/hashes. Limits are configured,
documented defaults covering export bytes, rows/section, graph nodes/edges, nesting,
and preview bytes.

Canonical semantic hash excludes generation-only fields such as request time and
page cursor, but includes schema version, completeness classifications, and
authoritative evidence. Assembling unchanged terminal facts twice produces the same
hash.

## Authority and persistence

Source database rows remain authority. A capsule cache/materialization can be added
only on measured need and must be rebuildable. A small manifest may preserve request,
semantic hash, signature/version, status, and generated artifact reference; it never
claims to replace sources.

Historical missing context/artifact/policy/delegation facts remain `missing/legacy`,
never backfilled guesses. Runtime/provider self-reports remain claims. M2 exposure
means Tenvyr exposed a reference, not that an agent semantically used bytes.

## Replay state behavior

```text
REQUESTED(sourceExecution, capsuleVersion/hash, overrides, idempotency)
  → assemble/verify source completeness
  → re-evaluate current M4 policy/budget/approval
  → verify current executor/credential refs and required artifact availability
  → BLOCKED | REJECTED | CREATE new Execution
  → link source → target and execute normally
```

Replay never changes source evidence. Historical approvals/credentials/permissions
are evidence, not current authority. Overrides are an allowlisted bounded contract,
not arbitrary entity/plan mutation; every override appears in comparison/provenance.

Duplicate identical replay request creates one target; conflicting request identity
is retained/rejected. Source artifact bytes that are missing, changed, external, or
unverified cause explicit blocked/degraded fidelity per approved policy. Tenvyr never
claims deterministic model output; it records runtime/model/tool/config drift.

## Comparison behavior

Compare using stable logical identities (step IDs, revision lineage, descriptor
hashes, proposal/action identities), not incidental new UUIDs/timestamps. Categories:

- source input/config/plan/context;
- executor/runtime/model/tool/skill/MCP/sandbox claims;
- policy/approval/budget/delegation;
- attempt/retry/status/result/error/termination;
- artifacts/lineage/state/usage/duration;
- evidence completeness and unavailable content.

Distinguish `equal`, `changed`, `missing-left`, `missing-right`, `unavailable`,
`unverified`, and `not-comparable`. Structural comparison makes no automatic semantic
quality judgment. Results are bounded/paginated and deterministic.

## Provenance behavior

Derive Agent/Activity/Entity-like projections from facts Tenvyr owns. Every edge
states whether it is authoritative, Tenvyr-exposed, runtime-asserted, or derived.
Optional standard serialization is a mapper/export, not storage schema. Hidden
runtime reasoning/tools/subagents remain absent.

## Telemetry behavior

- pin a researched semantic-convention version behind a compatibility mapper;
- preserve business execution/invocation IDs as attributes/links; standard trace IDs
  use valid W3C semantics rather than business IDs;
- inject/extract bounded `traceparent`/`tracestate` and allowlisted baggage in HTTP/
  Kafka headers without changing canonical payload authority;
- retries are distinct attempt spans linked to logical work/source;
- default metadata-only; state/context/output/artifact URI/credentials/full prompts
  never become span attributes;
- exporter disabled/down/slow/full/sampled/malformed context leaves authoritative
  behavior identical and memory/latency bounded;
- untrusted inbound trace context cannot widen capture/policy or automatically become
  trusted parentage; invalid context is rejected or linked per trust policy.

If exact transition export requires durable delivery, use a dedicated bounded
telemetry projection outbox committed with authority and drained asynchronously. Do
not overload AgentEvents or DispatchOutbox, and exporter delivery is still projection.

## Failure semantics

- incoherent/missing source: explicit unavailable/completeness, no invention;
- section/byte limit: paginated/truncated-with-proof or rejected export, never OOM;
- replay prerequisite absent: BLOCKED with stable reason, no target;
- replay create failure: request remains safely retryable, no partial target;
- source changes during live capture: repeatable-read point-in-time truth;
- comparison large/malformed: bounded safe error;
- exporter/collector failure: dropped/retried projection per bounded policy, execution
  unchanged;
- manifest signing/storage failure: no false durable export claim.

## Security/trust boundary

Capsules may contain highly sensitive metadata. Apply ownership/authorization after
the exposure gate, explicit capture modes (`off`, `metadata-only`, `hash-only`,
`preview`, `full-reference`), redaction, bounded previews, secret scanning, export
audit, and retention/deletion policy. Never treat frontend safe preview as auth.

## Product example

An operator exports a failed supervised run. Capsule V1 shows revision 3, the exact
context and artifact references exposed to attempt 2, executor/policy/budget facts,
and one missing external artifact marked unverified. Replay is initially blocked.
After supplying an approved current artifact reference and budget, Tenvyr creates a
new execution. Comparison reports changed artifact, runtime version, retry count, and
result—not "better reasoning." Collector outage during both runs changes no status.

## Non-goals

No source rewind, deterministic LLM replay, hidden-state claims, giant authority
table, full payload spans, or unauthenticated export/replay.
