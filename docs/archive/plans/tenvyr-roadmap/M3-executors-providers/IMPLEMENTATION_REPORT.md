---
title: "M3 Implementation Report"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
  - product
last_verified: 2026-08-12
sources:
  - docs/archive/plans/tenvyr-roadmap/M3-executors-providers/PLAN.md
  - docs/archive/plans/tenvyr-roadmap/M3-executors-providers/SPEC.md
  - docs/archive/plans/tenvyr-roadmap/M3-executors-providers/VERIFY.md
  - docs/archive/plans/tenvyr-roadmap/EXECUTION_STATUS.md
---

# M3 implementation report — Executor architecture and runtime integration

**CLOSED — independent Tech Lead PASS (2026-08-12).** See the
[durable closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).

## Implemented

- **M3-S1 Executor descriptor foundation**: bounded versioned
  `ExecutorDescriptorV1` (executorId, agent, kind, configHash, conservative
  capabilities, frozen HTTP routing profile) frozen per attempt in
  `executorSnapshot`; dispatch always consumes the attempt-pinned selection;
  configuration rotation can never silently reroute a pending outbox
  (`EXECUTOR_PROFILE_MISMATCH` deterministic safe failure); explicit legacy
  `{ agent }` compatibility reader that never rewrites old rows.
- **M3-S2 Capability-aware lifecycle**: optional `AgentAdapter.cancel`
  (idempotent, best-effort, bounded runtime); post-commit executor
  notification gated by the frozen descriptor AND the adapter method; every
  outcome (`delivered | unsupported | unreachable`) recorded durably on the
  outbox row as evidence and idempotency marker; succeeded attempts never
  marked; Tenvyr cancellation authority untouched (late results still
  rejected).
- **M3-S3 Trusted local process executor** (PO/BA-approved, ask decision:
  separate executor host, trusted-code-only): new `@tenvyr/local-executor-host`
  service — fixed operator commands only (absolute path, argv array, no
  shell), allowlisted working root, explicit env allowlist + secret
  references, bounded stdin/stdout/stderr, process-group wall-clock
  deadline/cancel with SIGTERM→SIGKILL escalation, restart orphan
  termination with PID-reuse guard, canonical signed results/events via the
  reviewed `@tenvyr/worker` SDK. Orchestrator core never spawns processes.
- **M3-S4 Official integration research**: Codex CLI 0.147.0 (documented
  `codex exec` mode — supported as a fixed host command; cancel/timeout gaps
  flagged and covered by the host boundary), Claude Agent SDK TS 0.3.227 /
  PyPI 0.2.135 (auditable mode exists — runtime worker application, deferred:
  no credentials here), A2A v1.0.0 (deferred: protocol extension requires
  version/compatibility approval), DeepSeek (OpenAI-compatible, runtime
  configuration only; current models `deepseek-v4-flash`/`deepseek-v4-pro`).
- **M3-S5 Parity and closure**: cross-executor canonical invocation parity
  test (Kafka topic payload == HTTP run-request invocation == local host
  stdin, byte-identical canonical JSON), provider-neutrality architecture
  audit (no Orchestrator source imports a provider SDK), full VERIFY battery,
  this report.

## Architectural decisions

- Executor/transport/provider stay distinct; `AgentAdapter` remains the
  transport boundary; a higher executor boundary was NOT introduced (no
  second runtime lifecycle needed it — the local host speaks the existing
  HTTP Worker protocol).
- Descriptor capabilities are honest and conservative: `cancel: false` for
  Kafka/HTTP (no protocol support); the unsupported limitation IS the
  required durable evidence; the supported path is proven by reviewed
  fixtures.
- Dispatch reads the frozen descriptor from the attempt (immutable after
  claim) — no outbox schema change; live configuration only resolves secrets
  for the exact pinned profile.
- The local executor host is a separate trusted deployment component
  (trusted-code-only, no sandbox — documented limitation), reusing the
  worker SDK's protocol/auth/idempotency/callback machinery.
- Cancel notification is best-effort post-commit evidence on the outbox
  `error` column; it never reverses or blocks the committed cancellation.
- No migrations: `executorSnapshot` jsonb existed; legacy rows upgraded by
  the compatibility reader at dispatch (no invented executor facts).

## Migrations and data changes

None. Migration order unchanged:
`1722270000000` → `1722270001000` → `1722270002000` → `1722270003000` →
`1722270004000` → `1722270005000`.

## Tests and verification evidence

| Gate                                              | Result                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| orchestrator unit                                 | 498 passed, 116 skipped (PG), 0 failed                                  |
| real PostgreSQL (tenvyr_roadmap_test, disposable) | 613/613 ×2 sequential                                                   |
| local-executor-host unit                          | 31/31                                                                   |
| local-executor-host integration (real processes)  | 3/3 (HMAC-verified signed callback, secret redaction, failure/deadline) |
| orchestrator↔host loopback (EXECUTOR_HOST_MAIN)   | 1/1                                                                     |
| `@tenvyr/worker`                                  | 199/199 (+ `--detectOpenHandles`)                                       |
| python worker pytest (venv)                       | 261/261                                                                 |
| loopback (TENVYR_PYTHON_EXECUTABLE)               | 3/3                                                                     |
| test:all / build:all                              | PASS                                                                    |
| verify:docs / test:docs                           | PASS (85 files, 28 capabilities) / 20/20                                |
| verify:identity / test:identity                   | PASS (0 violations) / 25/25                                             |
| verify:package-packs / python package             | PASS                                                                    |
| git diff --check                                  | PASS                                                                    |

Failure repairs during the milestone: legacy `{ agent }` compat classification,
delivered-cancel idempotency marker, CANCELLED-attempt filter, host
shell-metachar argv expectation (node `-e` argv shape), callback-origin
ordering in the host integration, readiness/cleanup in the loopback,
`.pnpm-store` ignore + wire-protocol allowlist for the identity gate, minimal
pnpm-lock importer entry, docs-verifier relative links/sources.

## Security review and external research

- Independent `review` runs after M3-S1, M3-S2, and M3-S3; every should-fix
  finding implemented and covered by new tests (anomalous snapshot terminal
  failure, CANCELLED-only cancel filter, PID-reuse guard, descendant-leak
  group kill, agent-name charset, past-deadline kill).
- Hostile-input coverage: shell metacharacters stay literal argv, cwd
  traversal rejected, hostile env names rejected, oversized argv/IO bounded,
  output limits kill the group, secrets never logged/persisted/echoed by
  host code, URI-as-path never interpreted, process identity verified before
  orphan kills.
- Official-source research (2026-08-11, URLs in
  `docs/architecture/executors/native-integrations.md` and the M3-S4
  receipt): Codex, Claude Agent SDK, A2A, DeepSeek — no undocumented flags,
  no session scraping, no provider SDK in Orchestrator/Worker core.

## Remaining limitations

- Kafka/HTTP executors cannot cancel remotely (`cancel: false`); the local
  host cancels via process-group deadline/shutdown.
- Local executor host is trusted-code-only (no sandbox); `ps`-unavailable
  environments skip orphan termination with a warning (orchestrator times
  the attempt out).
- Codex/Claude Agent integrations are documented but not exercised here (no
  credentials); A2A transport deferred pending protocol-extension approval.
- Loopback and host integration gates require built host / env vars
  (`EXECUTOR_HOST_MAIN`, `TENVYR_PYTHON_EXECUTABLE`); skipped when unset.
- General APIs remain unauthenticated — the External Production Exposure
  Gate is OPEN; no public executor/credential administration exists.

## Independent closure

**PASS — CLOSED 2026-08-12.** Independent review added canonical real-path
containment for configured roots/cwd (including symlink escape rejection),
made stdout/stderr bounds count actual UTF-8 bytes, and added regressions for
both cases. The final cross-repository verification is recorded in the
[durable M3–M7 closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).

## What was delivered

Run any agent, bound what it can do: the same durable pipeline now runs
Kafka Workers, HTTP Workers, and (PO/BA-approved) trusted local processes
with one supervisory meaning — pinned executor evidence per attempt,
rotation-safe dispatch, honest cancel capability, bounded local execution,
and canonical results/events everywhere.

## User/operator value

- Existing Kafka/HTTP pipelines unchanged; new agents select an approved
  executor reference.
- Operators can run trusted local commands without teaching the Orchestrator
  process management.
- Attempt evidence explains exactly which executor, with which frozen
  profile, ran each attempt.
