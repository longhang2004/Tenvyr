---
title: "M3–M7 Independent Technical Closure"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
  - product
last_verified: 2026-08-12
sources:
  - services/orchestrator/src
  - services/local-executor-host/src
  - docs/archive/plans/tenvyr-roadmap
  - docs/reference/implementation-status.json
---

# M3–M7 independent technical closure

## Decision

M3, M4, M5, M6, and M7 are **CLOSED / PASS** as bounded internal product
milestones. The review used the live post-M2 repository, executable contracts,
migrations, authority transactions, and real PostgreSQL tests as truth. It did
not accept provisional implementation reports as closure evidence.

The External Production Exposure Gate remains **OPEN**. This closure does not
authorize public capsule, replay, artifact, delegation, policy, approval,
budget, executor, or credential-management APIs.

## Independent findings and repairs

1. **M3 executor containment.** Lexical cwd checks allowed symlink escape, and
   output accounting mixed JavaScript character length with byte limits.
   Configured roots and cwd are now canonicalized through `realpath`, missing
   paths fail closed, and output accounting uses actual UTF-8 bytes. Symlink
   and multibyte regressions were added.
2. **M5 terminal plan authority.** Proposal activation blocked only cancelled
   executions. Completed and failed executions could still receive a revision.
   Every terminal execution now produces a deterministic `STALE` decision.
3. **M6 supervised delegation.** Request replay did not compare payloads;
   concurrent request creation could exceed fanout; delegation skipped its own
   policy decision; budgeted children were not linked to the ancestor ledger;
   and deadlines were not inherited. Payload hashes/conflict evidence,
   parent-attempt serialization, delegate policy evaluation, parent-linked
   budget accounts, frozen child authority deadlines, exact graph totals, and
   durable relation constraints now close those gaps.
4. **M7 capsule and replay truth.** Export/replay races depended on recovering
   from a unique violation inside an aborted transaction; large input replay
   used a display truncation; provenance could fabricate decision identities;
   graph truncation could leave dangling edges; telemetry names/cardinality
   were insufficiently bounded. Source-execution locking, authoritative input
   replay, durable identities, edge-safe graph bounds, static names, and a
   global 101-span ceiling now apply.
5. **Migration rollback.** The closure migration upgrades provisional schemas
   repeat-safely and restores the prior attempt-cascade semantics on rollback,
   while forward authority relations use `NO ACTION`.
6. **Cross-runtime contract packaging.** The M6 `AgentResultV1` delegation
   addition had not been copied into the Python Worker's embedded schemas.
   The tracked resource is synchronized byte-for-byte and the package smoke
   test now protects the complete contract in built wheels and sdists.
7. **Race-test truth.** The cancel-versus-watchdog regression incorrectly
   required cancellation to win every race. It now checks the actual authority
   contract: the first committed terminal transition wins, and the attempt and
   execution terminal outcomes must agree.

## Closure by milestone

| Milestone | Result | Durable product guarantee                                                                                                                            |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3        | PASS   | Frozen framework-neutral executor descriptors, capability-aware dispatch/cancel, and a bounded trusted local-process host                            |
| M4        | PASS   | Transactional hierarchical budgets, immutable policy decisions, and exactly-once approval state transitions                                          |
| M5        | PASS   | Restricted versioned plan patches with validated, policy-controlled, terminal-safe activation                                                        |
| M6        | PASS   | Explicit opaque/observed/supervised modes, inert observed evidence, and bounded authoritative child executions                                       |
| M7        | PASS   | Bounded coherent capsules, immutable export pins, new-execution replay, structural comparison/provenance, and non-authoritative telemetry projection |

## Verification gates

Closure required all of the following on the final tree:

- Orchestrator full real-PostgreSQL suite: **785 passed, 1 intentional skip,
  twice sequentially**; the focused cancel/watchdog race also passed.
- Repository `test:all` and `build:all`: PASS; Orchestrator unit **543 passed**;
  local executor unit **33 passed**, integration **3 passed**, and Orchestrator
  loopback **1 passed**.
- TypeScript Worker open-handle suite: **199 passed**. Python Worker:
  **261 passed**, Ruff PASS, schema sync **5/5**, package build/install/smoke
  PASS, and real Orchestrator loopback **3 passed**.
- Contract/schema identity, documentation (**91 files, 191 links,
  39 capabilities**), product identity (**0 violations**), isolated package
  consumers, formatting, and `git diff --check`: PASS.
- Upgrade/restart/repeat-safe migrations, duplicate and conflicting requests,
  100-way contention, terminal races, and bounded large-graph projections.

No skipped command is counted as a pass. Environment-dependent loopbacks were
run with their required executable paths for this closure.

## Explicit non-claims

- The local executor host runs trusted code; it is not a security sandbox.
- Opaque runtimes create no invented subagent lineage. Observed delegation is
  a runtime assertion, not Tenvyr scheduling or authority.
- Supervised delegation is explicit workflow work. Tenvyr does not claim a
  generic durable pause/resume channel for arbitrary native subagents.
- Artifact rows protect reference identity and lineage, not bytes stored behind
  an external URI. Exposure proves projection, not semantic consumption.
- Replay creates a new execution and re-evaluates current authority. It does
  not promise deterministic model output or copy historical credentials,
  approvals, permissions, or mutable state as current authority.
- The OpenTelemetry capability is a bounded mapper/projection, not a wired
  exporter. It has no real timing capture, `tracestate`, or trusted inbound
  trace parentage.
- Public package release and external production exposure remain separately
  gated and are not implied by M3–M7 closure.

## Product handoff

The complete numbered M0–M7 roadmap is closed. Current behavior and limitations
live in `docs/reference/implementation-status.json`; the completed execution
pack is historical evidence under `docs/archive/plans/tenvyr-roadmap/`.
Future work must start from a new approved product direction or from the open
External Production Exposure Gate, not by silently extending these milestones.
