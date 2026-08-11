---
title: "M3 Specification: Executor Architecture and Runtime Integration"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/M3-executors-providers/PLAN.md
  - docs/architecture/transports/adapter-model.md
  - services/orchestrator/src/services/dispatch-outbox.service.ts
  - services/orchestrator/src/entities/step-attempt.entity.ts
---

# M3 executor architecture specification

## Concepts

- `Agent target`: logical pipeline identity for the work role.
- `Executor`: how Tenvyr invokes and supervises a runtime instance/class.
- `Transport`: how canonical messages cross a boundary; current Kafka/HTTP
  `AgentAdapter` remains this concern.
- `Provider`: model/API used inside the runtime; not Orchestrator intelligence.
- `ExecutorDescriptor`: bounded, versioned, secret-free resolved configuration and
  capability snapshot frozen for one attempt.
- `CredentialRef`: opaque trusted reference resolved only at the executor boundary;
  never the credential value.

No first-class registry table is required until lifecycle/admin behavior requires
one. Trusted deployment configuration plus frozen descriptors is the preferred
starting point.

## State behavior

```text
attempt CREATED + durable outbox
  → executor dispatch requested
  → DISPATCHED after accepted dispatch receipt
  → RUNNING from authoritative activity evidence
  → SUCCESS | FAILED | TIMED_OUT | CANCELLED through canonical ResultInbox
```

An executor process/session may have richer internal states, but they cannot bypass
the existing attempt authority. Dispatch retry of one outbox row reuses the same
invocation and executor snapshot. Workflow retry creates a new attempt/invocation.

Cancellation:

```text
Tenvyr cancellation commits
  → attempt/execution become CANCELLED and outbox retires
  → supported executor receives idempotent best-effort cancel
  → unsupported/unreachable executor is recorded as such
  → any late result remains rejected evidence
```

Remote/process acknowledgement never reverses Tenvyr cancellation authority.

## Descriptor invariants

A descriptor must include stable versioned data sufficient to explain routing,
such as executor kind/id, runtime/integration version where known, transport kind,
capability flags, trusted configuration version/hash, and sandbox profile reference.
It may contain credential reference identifiers but never secret values.

Descriptors are JSON-clean, explicitly bounded, immutable after claim, included in
the attempt's frozen evidence, and safe to render only through redacted views.
Runtime/provider self-reports are labeled claims unless Tenvyr verifies them.

## Authority boundaries

- Pipeline selects an approved logical executor reference, not executable commands
  or credentials.
- Trusted resolver maps it to a descriptor and dispatch implementation.
- Scheduling/attempt/outbox remains Orchestrator authority.
- Executor owns runtime lifecycle and canonical result/event production.
- ResultInbox and AgentEvent services retain result/event authority rules.
- Provider SDK, prompt/tool construction, model selection, and native reasoning stay
  inside the runtime.
- M4 policy may later authorize dispatch/actions but cannot be embedded in adapters.

## Local process safety contract

If approved, a generic process executor should run in a separate bounded executor
host/sidecar or Worker application unless current evidence proves core ownership is
safer. It must:

- resolve only preconfigured executable IDs; never accept pipeline-supplied paths;
- use argv arrays with no shell, command interpolation, or evaluation;
- use an allowlisted working root, environment allowlist, secret references, and a
  named sandbox/resource profile;
- deliver bounded canonical input through a documented channel;
- bound stdout, stderr, result/event counts, process count, wall time, and cleanup;
- kill the process group on deadline/cancel and record escalation outcome;
- use Tenvyr invocation identity for idempotency/correlation;
- define restart orphan adoption/termination/rejection behavior before launch;
- never interpret artifact URIs as local paths automatically.

Without a real sandbox, documentation must label this executor trusted-code only.

Every dispatch/redelivery must consume the descriptor frozen on the attempt. Live
configuration may resolve secret values for that exact pinned profile but cannot
choose a different executor. Missing/rotated profile is a deterministic safe failure,
not automatic fallback.

## Contracts and compatibility

Prefer internal executor contracts first. Any canonical protocol extension requires
version compatibility across contracts and both SDKs. Existing `agent` pipelines,
Kafka topic identities, HTTP callback contract, result/event schemas, and Worker
APIs remain valid.

Capabilities are explicit and conservative: `cancel`, `actionProposal`,
`delegationEvidence`, `usage`, or similar flags mean the reviewed integration can
provide that boundary. Missing capability never silently means supported.

## Failure semantics

- unknown/disabled executor: permanent pre-dispatch configuration failure through
  existing workflow failure policy;
- transient launch/network failure: outbox retry of same invocation;
- accepted launch then runtime crash: canonical executor failure result/evidence;
- output/protocol violation: bounded permanent attempt failure, safe error only;
- Tenvyr crash around launch: reconcile via persisted invocation/executor ownership;
  never blindly start duplicates;
- credentials missing/revoked: safe classified failure, secret omitted;
- unsupported cancel: Tenvyr state still cancels; limitation is durable evidence;
- adapter callback/result duplicate/conflict: existing inbox/event rules unchanged.

## Security/trust boundary

Configuration, runtime output, self-reported identity, event/result payloads, process
output, remote endpoints, and provider metadata are untrusted at their boundary.
Validate sizes/types; use TLS/auth where supported; redact secrets; forbid shell/path
injection; bind callback/result identity to invocation and executor; instrument logs
to prove no prompt/context/artifact/credential leakage.

## Cross-runtime behavior

Every supported executor receives semantically identical invocation input/context
and produces the same canonical result/event meanings. Runtime-specific capability
or metadata remains namespaced/bounded and cannot change lifecycle authority.

## Product example

A pipeline's `research` step selects a trusted local Codex executor reference while
`review` uses the existing Python HTTP Worker. Tenvyr freezes each executor
descriptor, sends the same bounded context/artifact model, cancels the local process
at its deadline, accepts the Python Worker's signed callback, and displays which
runtime handled each attempt. Codex auth/provider prompting remains inside the
supported Codex runtime mechanism; the pipeline contains no token.

## Non-goals

No model gateway, provider prompt logic, arbitrary command input, universal tool
interception, user-session impersonation, or public executor administration.
