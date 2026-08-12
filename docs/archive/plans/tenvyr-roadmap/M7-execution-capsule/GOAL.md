---
title: "M7 DeepSeek Goal: Execution Capsule, Replay, Comparison, and Projection"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/M7-execution-capsule/PLAN.md
  - docs/archive/plans/tenvyr-roadmap/M7-execution-capsule/SPEC.md
  - docs/archive/plans/tenvyr-roadmap/M7-execution-capsule/VERIFY.md
---

# M7 Goal Mode

## Objective

Build a reconstructable bounded capsule, controlled replay-as-new-execution,
structural comparison/provenance, and failure-isolated standards-based telemetry.

## Slice order

### Slice 1 — internal Capsule V1

Define explicit versioned DTO/completeness/hash/bounds. Assemble terminal facts in a
repeatable-read transaction, paginate large sections, report legacy gaps, and prove
same facts/same semantic hash. No public API or giant source table.

### Slice 2 — manifest and replay

Add only a small manifest if required. Implement idempotent source→new target replay,
allowlisted overrides, current M4 authority, artifact/executor prerequisites, atomic
target creation, and source immutability. Never reuse historical approval/credentials.

### Slice 3 — comparison and provenance

Implement stable structural categories independent of UUID/time noise, explicit
missing/unavailable/unverified, bounded graph projection, and correct authority labels.
Optional standard export follows current official research.

### Slice 4 — OTel/W3C/OTLP

Research official current standards first. Pin mapper versions, propagate headers,
default metadata-only, bound cardinality/queues, isolate exporter failure, and use a
dedicated projection outbox only if exact durable delivery is required.

### Slice 5 — privacy/query/closure

Complete privacy modes, sensitive-export security, scale/crash/race, internal query/
dashboard, all prior compatibility, PostgreSQL twice, docs/ledger, and provisional
report. Public exposure remains blocked until its separate gate passes.

## Rules and stops

Do not mutate/replay source in place, claim deterministic model output, invent missing
history, expose raw ORM entities, overclaim artifact use/runtime facts, put payloads in
spans, or let telemetry affect authority. Stop for unresolved replay override/fidelity/
privacy/retention/ownership choices or required exposure closure; ordinary repair
continues.
