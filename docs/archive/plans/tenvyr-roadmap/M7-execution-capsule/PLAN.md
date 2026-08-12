---
title: "M7 Plan: Execution Capsule, Replay, Comparison, Provenance, and Observability"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - product
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/entities/execution-plan-revision.entity.ts
  - services/orchestrator/src/entities/step-attempt.entity.ts
  - services/orchestrator/src/services/agent-event.service.ts
  - docs/roadmap/observability-provenance.md
  - docs/product/principles.md
  - docs/reference/implementation-status.json
---

# M7 Execution Capsule plan

## Product outcome

Tenvyr can reconstruct and export a versioned bounded Execution Capsule, compare two
supervised runs, create a policy-controlled replay as a new Execution, derive honest
provenance, and project execution telemetry through open standards without making
telemetry authoritative.

## User/operator value

Operators can answer what plan/context/executor/policy/budget/delegation produced an
outcome, diagnose drift between runs, preserve audit evidence, and rerun controlled
work without mutating the original or pretending model output is deterministic.

## Existing repository state

- durable facts already include execution input/config/hash, immutable revisions,
  logical steps, attempts, outbox, canonical inbox/conflicts, events/conflicts, and
  artifact producer lineage;
- M2 plans exact context, artifact exposure, and state-write evidence;
- M3–M6 will add executor, authority, plan-patch, and delegation facts;
- `AgentEventService.list` provides bounded keyset pagination;
- current execution API spreads persistence entities and is not a versioned capsule;
- no OTel dependency, W3C propagation, capsule, replay, comparison, or provenance
  read model exists;
- current trace IDs are business correlation, not complete W3C context.

## Gaps

- no coherent point-in-time assembler, schema version, semantic hash, completeness
  warnings, bounds, export manifest, or redaction policy;
- no replay request/source-target relation or prerequisite checking;
- no stable structural comparison independent of UUID/timestamp noise;
- no provenance projection distinguishing authority from runtime claims/exposure;
- no failure-isolated OTLP/W3C projection;
- no authenticated ownership/export/replay API.

## Dependencies

- closed M2–M6 so the capsule can consume real facts rather than invent placeholders;
- current official OpenTelemetry/OTLP/W3C/semantic-convention research;
- artifact byte accessibility/integrity policy for any replay fidelity claim;
- M4 policy/budget and External Production Exposure Gate before public export/replay;
- M3 executor descriptors for runtime/model/sandbox provenance.

## Proposed engineering slices

### M7-S1 — internal Execution Capsule V1 read model

Assemble explicit DTO sections from authoritative rows inside a repeatable-read
transaction. Prefer terminal source executions initially; otherwise label live
point-in-time capture. Include versions/hashes/counts/references and
`evidenceCompleteness` warnings. Bound/paginate large sections. No giant source table
or public download.

### M7-S2 — immutable export manifest and controlled replay

Optionally persist a small immutable export request/manifest/hash, not duplicated
execution truth. Add idempotent replay request linking source capsule/version/hash to
a new Execution. Re-evaluate current policy/budget/credentials/artifact availability;
never copy historical approval/authority as current.

### M7-S3 — structural comparison and provenance projection

Compare stable logical identities and explicit categories, distinguishing actual
drift, absent evidence, unavailable content, and runtime claims. Derive a provenance
graph; M2 artifact exposure never overclaims semantic use. Optional PROV mapping is
export only after current official research.

### M7-S4 — OpenTelemetry/W3C/OTLP projection

Research current standards, pin convention compatibility behind a mapper, propagate
W3C context in transport headers, and emit metadata-only spans/events from durable
facts. Exporter outage/backpressure/sampling cannot alter execution. Add a separate
bounded telemetry outbox only if transactionally exact live projection is required.

### M7-S5 — query/dashboard, privacy, scale, and closure

Add internal bounded query/projection first. Public capsule/replay/dashboard surfaces
wait for external exposure. Complete privacy modes, sensitive export controls,
large-graph performance, tamper evidence, replay races, docs/ledger, and verification.

## Risks

- giant mutable capsule duplicating/diverging from source truth;
- inconsistent snapshot across concurrent rows/revisions;
- sensitive prompt/context/artifact/policy/credential export;
- replay mutating source or silently inheriting expired authority;
- unavailable/unverified artifact treated as reproducible input;
- noisy UUID/timestamp comparison or false semantic-quality conclusions;
- OTel exporter blocking transactions or becoming authority;
- high-cardinality/unbounded spans/graphs/exports;
- forged trace/baggage widening authority or capture;
- public cross-owner export/replay without auth.

## Explicit non-goals

- no deterministic LLM output replay claim;
- no rewind/mutation of source Execution;
- no one-table event-sourcing rewrite or giant mutable capsule row;
- no claim about hidden runtime state Tenvyr did not observe;
- no telemetry as execution authority;
- no full payload in span attributes;
- no proprietary replacement for OTLP/W3C/A2A/MCP/PROV-like mappings;
- no public sensitive API before exposure gate.

## Decisions requiring PO/BA input

- terminal-only initial capsules versus live point-in-time capture;
- allowed replay overrides and minimum artifact fidelity/integrity requirement;
- default export privacy mode, retention, deletion, signing, and portability;
- whether immutable export manifests/hashes require long-term storage/signatures;
- comparison categories/UX and whether semantic model judging is explicitly separate;
- required OTel backend/deployment support and telemetry retention;
- single-owner versus tenant ownership before external capsule access.

## Closure definition

Sol may close M7 only when unchanged terminal facts produce the same semantic capsule
hash, large sections are bounded/coherent, replay creates exactly one new governed
Execution without source mutation, comparison is stable/honest, provenance labels
authority correctly, telemetry failure cannot affect outcomes, sensitive data is
controlled, and VERIFY passes.

# Milestone handoff

## What was delivered

## User/operator value

## How it works

## Guarantees

## Known limitations

## Architecture decisions

## What this unlocks

## Verification summary

## Recommended next milestone
