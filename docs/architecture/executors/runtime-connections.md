---
title: Runtime Connections
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-12
sources:
  - services/orchestrator/src/executors/runtime-connection.ts
  - services/orchestrator/src/executors/runtime-connection.spec.ts
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/SPEC.md
---

# Runtime Connections (M8)

## Purpose

A Runtime Connection is operator-owned configuration selecting an executor and
a runtime profile plus credential references and declared/detected
capabilities. Connection Revisions are the immutable, secret-free
configuration identity: a new edit creates a new revision, and attempts never
point at mutable latest state.

Boundary: the runtime owns intelligence, prompts, tools, provider/model calls,
and native subagents. Tenvyr records connection identity and conservative
capability evidence — never provider routing, credential values, or session
contents. Provider/account ownership stays inside the runtime.

## Domain (slice 1 — implemented)

`services/orchestrator/src/executors/runtime-connection.ts` is a pure domain
module with no persistence or dispatch coupling:
- **`ConnectionProfileV1`**: `name`, `runtimeKind`
  (`codex` | `claude` | `opencode` | `generic-cli` | `http-worker` |
  `kafka-worker`), `executorId`, optional pinned `version`, `credentialRefs`,
  and `declaredCapabilities`. Credentials are only `env` references resolved
  at the trusted executor boundary; any other credential shape is rejected
  structurally.
- **`freezeConnectionRevision`**: freezes one immutable, deeply frozen
  revision with a canonical secret-free `configHash` (`sha256Json` of the
  profile), the conservative capability set resolved at freeze time, and the
  exact connection ID/revision number/timestamp. Freeze is idempotent:
  identical profiles hash identically regardless of revision number.
- **Capability vocabulary** (12 keys): invocation, structuredResult,
  progressEvents, heartbeat, cancellation, artifacts, observedDelegation,
  supervisedDelegation, plannerOutput, verifierDecision,
  toolActionInterception, localProcessTermination. Missing/unknown means
  unsupported. `resolveCapabilities` is conservative: detection may downgrade
  or confirm, never widen.
- **Status projection**: `DRAFT -> AVAILABLE | AUTH_REQUIRED | UNAVAILABLE |
  DEGRADED`, `REVOKED` terminal, with bounded reason codes
  (`missing-executable`, `unsupported-version`, `auth-required`, `timeout`,
  `malformed-output`, `capability-mismatch`, `revoked`, `none`). Status is a
  bounded projection from explicit probes — never dispatch authority, never
  secret values, command output, tokens, prompts, or provider responses.
- **Strict parsers** (`parseConnectionProfile`, `parseConnectionRevision`,
  `parseConnectionStatus`): reject unknown fields/versions, out-of-bounds
  values, hostile identifiers, non-reference credential shapes, and
  capability spoofing (a revision may never claim a capability its frozen
  profile did not declare). A revision whose `configHash` does not match its
  embedded profile is rejected as incoherent.

## Persistence and frozen attempt identity (slice 2 — implemented)

- Migration `1722270014000-MilestoneEightConnections` creates
  `runtime_connections` and `connection_revisions`; a
  `TRG_connection_revision_immutable` trigger blocks UPDATE/DELETE on
  revisions durably. `UNIQUE (connectionId, revisionNumber)` guarantees one
  canonical revision per number.
- `RuntimeConnectionService` (PostgreSQL-backed): `createConnection` (revision
  1, DRAFT), `reviseConnection` (pessimistic lock on the connection row, then
  append N+1; unique constraint backstops concurrent writers),
  `revokeConnection` (terminal REVOKED via the slice-1 status projection),
  `claimRevision` / `claimRevisionWithManager` (linearizable claim — the
  authority-row lock is the linearization point: existence, non-revocation,
  and the current revision number are all re-read under the lock, so a revoke
  committed before the claim lock denies the claim and a claim that locks
  first returns its immutable frozen revision; the manager-aware variant
  enforces the identical rules inside caller-owned transactions),
  `connectionStatus`.
- Frozen attempt identity: when an agent's transport configuration selects a
  `connectionId`, attempt claim embeds `ConnectionReferenceV1`
  (connectionId, revisionNumber, runtimeKind, version, configHash,
  capabilities — secret-free by construction) into the attempt's
  `ExecutorDescriptorV1.connection`. Dispatch and Capsule provenance consume
  exactly that frozen reference.
- Dispatch-time revocation: pending delivery of a REVOKED connection fails
  with deterministic non-retryable `EXECUTOR_CONNECTION_REVOKED`; no
  fallback. Already-dispatched accepted work is untouched. Health status
  (DRAFT/AUTH_REQUIRED/UNAVAILABLE/DEGRADED) is projection, never dispatch
  authority.
- Retry (new attempt) and replay (new execution) re-claim the current
  revision; historical revision identity is provenance, never current
  authority.

## Generic CLI probes and test receipts (slice 3 — implemented)

- `CliProfileV1` (in the connection domain): fixed absolute `command`,
  fixed run `args`, optional `cwd`, `envAllowlist`, and `secrets` (env
  references only — values never enter the profile, revision, or receipts),
  plus a `probe` block: fixed probe argv, `wallTimeMs` (default 10s, max
  60s), `maxOutputBytes` (default 64 KiB, max 1 MiB), and operator-declared
  `authExitCodes`. `generic-cli` connections REQUIRE a cli profile; worker
  transports reject one.
- `runCliProbe` (bounded probe runner): spawns the fixed command with
  `shell: false` and `detached: true` process-group kill (SIGTERM →
  SIGKILL escalation), a wall-clock deadline, per-stream byte bounds, and a
  MINIMUM environment (allowlist + resolved secret references only). Exit
  mapping is operator-declared (`authExitCodes`), never inferred from
  output. Outcomes are bounded reason codes — the probe never returns
  command output beyond the first-line version.
- `testConnection` (operator-initiated, rate-limited to one test per
  connection per 5s, deduplicated in flight): resolves the current revision
  (REVOKED denied), runs the probe, and projects the outcome through the
  slice-1 status machine — AVAILABLE / AUTH_REQUIRED / UNAVAILABLE /
  DEGRADED (pinned-version mismatch → `unsupported-version`) — persisting
  only `statusState`, `statusReasonCode`, `statusTestedAt`,
  `statusTestedVersion`. Receipts are bounded and secret-free, and a failed
  test never mutates attempt outcomes.
- Deterministic fake-CLI tests cover success, malformed/empty/hostile
  output, missing executable, auth exit codes, command failure, timeout,
  output bounds, minimum environment, and rate limiting — unit and real
  PostgreSQL.

## Version-pinned runtime profiles (slice 4 — implemented)

`runtime-profiles.ts` ships Codex, Claude, and OpenCode templates built ONLY
from the official sources re-fetched 2026-08-12 (URLs + access date recorded
in `RESEARCH_REGISTER.md` and in the templates themselves):

| Runtime | Pin (2026-08-12) | Run argv (documented) | Probe | Auth |
| ------- | ---------------- | --------------------- | ----- | ---- |
| Codex | 0.147.0 | `exec --json --ephemeral -` | `login status` (exit 0 = logged in; version output NOT documented) | local login or `CODEX_API_KEY` reference |
| Claude | 2.1.228 | `-p --output-format json` | `--version` + `auth status` (exit 1 = not logged in, JSON output never parsed) | local login or `ANTHROPIC_API_KEY` reference |
| OpenCode | 1.18.16 | `run --format json` | `--version` | runtime-owned (provider auth); discovery is the STRUCTURED `opencode serve` API, never TUI parsing |

- `buildRuntimeConnectionProfile` produces a validated, version-pinned
  connection profile: only the executable path and bounded overrides are
  operator-supplied; run/probe argv come from the documented template;
  operators may only DOWNGRADE the capability ceiling.
- Explicit unsupported surface per runtime (`--full-auto` deprecated,
  `--yolo`, exec-cancel RPC absence, auth-file inspection, consumer
  subscription brokerage, provider-credential reading) — recorded, never used.
- Deterministic fake-CLI tests per profile plus opt-in live gates: the
  installed Codex/Claude/OpenCode CLIs ran their documented non-billable
  probes (version/auth-status) with bounded, secret-free outcomes; installed
  Claude Code is 2.1.97 while the pin is 2.1.228 — detected version is
  evidence, the pin is what the operator tested against.

## Runtime Targets and model selection (P2 — implemented)

A Runtime Connection answers "which runtime executes the work?". A **Model
Source** (see [provider connections and runtime targets](../provider-connections.md))
answers "where may Tenvyr safely discover model identifiers?". A **Runtime
Target** `{ connectionId, modelId? }` is the usable unit selected for
Planner / Worker / Verifier roles.

Model selection is execution provenance (P2):

- The frozen coordination configuration carries `plannerTarget` /
  `verifierTarget` / `allowedTargets`; a Planner task may select only an
  exact allowed target (`MODEL_NOT_ALLOWED` otherwise) and a
  connection-only emission resolves deterministically only when that
  connection has exactly one allowed model.
- Steps freeze `metadata.tenvyrModelId`; the attempt claim freezes
  `ExecutorDescriptorV1.requestedModelId`; the invocation carries
  `requestedModelId` (wire contract); the executor host composes the FIXED
  argv `[...args, ...modelArgvPrefix, modelId]` and fails closed when it
  cannot.
- Retries reuse the frozen descriptor; later catalog refreshes or source
  changes never rewrite historical attempts; `observedModelId` is recorded
  only when the runtime itself reports it. Tenvyr performs NO silent model
  fallback.

## Remaining product surface (M8 slice 5 / M10 workbench)

- Implemented: the local connection administration API (`POST/PATCH
  /connections`, `GET /api/connections`, test, revoke) with gateway proxies,
  guarded behind the open External Production Exposure Gate (loopback/private
  trusted-operator only).
- Implemented (P2): the Workbench `/runtimes` UI with Agent Runtimes and
  Model Sources tabs, guided official sign-in commands, and the
  RuntimeTargetPicker for team runs.
- Not yet implemented: a public README/feature/terminology truth refresh
  beyond this document set.

## Guarantees

- Revisions are immutable and secret-free by construction — in code (deep
  freeze) and durably (database trigger); every render of a revision or
  status is a safe redacted view.
- Detection never widens authority; missing capabilities are unsupported.
- Revocation is terminal: it denies future claims immediately and pending
  delivery deterministically; already-dispatched accepted work is untouched.
- Attempts freeze the exact current revision; revision rotation, transport
  rotation, retry, and replay can never reroute or resurrect historical
  authority.
- Only REVOKED blocks dispatch; health status is projection, not authority.
