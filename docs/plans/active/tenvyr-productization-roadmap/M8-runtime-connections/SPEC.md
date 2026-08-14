---
title: "M8 Specification: Runtime Connections"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/PLAN.md
  - docs/architecture/transports/adapter-model.md
  - docs/architecture/executors/local-executor-host.md
  - docs/operations/configuration.md
---

# M8 Runtime Connections specification

## Concepts and boundary

- **Runtime** owns intelligence, prompts, tools, model/provider calls, and native
  subagents.
- **Executor** invokes/supervises the runtime.
- **Runtime Connection** is operator-owned configuration selecting an executor and
  runtime profile plus credential references and declared/detected capabilities.
- **Connection Revision** is immutable, secret-free configuration identity. A new
  edit creates a revision; attempts never point at mutable latest state.
- **Provider/account** belongs to the runtime. It is not a Tenvyr connection type.

## Lifecycle and status

```text
DRAFT -> AVAILABLE | AUTH_REQUIRED | UNAVAILABLE | DEGRADED
      -> revised as a new immutable revision
      -> REVOKED
```

Status is a bounded projection from explicit probes, timestamp, tested version,
and safe reason code. It is not dispatch authority by itself and never contains
secret values, command output, tokens, prompts, or provider responses. An operator
must explicitly request tests; no unbounded polling or billable model call is a
default health probe.

## Capability contract

At minimum declare conservative support for invocation, structured result,
progress/events, heartbeat, cancellation, artifacts, observed/supervised delegation,
planner output, verifier decision, tool/action proposal interception, and local
process termination. Each capability records source (`configured`, `detected`, or
`verified`) and version context. Missing/unknown means unsupported; detection never
widens authority beyond policy/configuration.

## Authentication and secret ownership

Supported modes are:

1. local authenticated CLI—runtime owns its local login; Tenvyr invokes the fixed
   executable and records no session contents;
2. explicit API/automation credential reference—Tenvyr stores only the reference
   and resolves it at the trusted executor boundary;
3. external runtime-managed auth—OpenCode or remote Worker owns provider auth.

Never store raw secrets in connection revisions, descriptors, tests, events,
Capsules, logs, URLs, pipeline input, or PlanPatch. No inspection of Codex/Claude/
OpenCode auth files. Claude consumer subscription login is not offered through a
third-party Tenvyr product without explicit official authorization.

## Frozen execution identity

At attempt claim, resolve exact connection ID/revision, executor kind/profile,
runtime kind/version, config hash, and conservative capabilities into the existing
secret-free executor snapshot. Dispatch/redelivery uses that frozen revision.
Updating or disabling latest never reroutes an existing outbox.

- Revision disabled/reconfigured after claim: dispatched accepted work may finish;
  pending delivery fails with a deterministic safe code unless the exact frozen
  profile remains resolvable. No fallback.
- Revocation denies future claims immediately and best-effort cancels supported
  already-dispatched work; inability to stop opaque work is reported truthfully.
- Workflow retry is a new attempt and resolves current authorized revision.
- Replay is a new execution, re-resolves current connection, credentials, policy,
  approvals, budget, and permissions. Historical connection identity is provenance,
  never current authority.

## Runtime profiles

- Codex: fixed `codex exec` profile with documented structured output/ephemeral
  options; local login or documented automation credential reference.
- Claude: fixed headless CLI for local use or Agent SDK inside a Worker for team/API
  use; supported API/WIF/cloud credential reference only.
- OpenCode: fixed `opencode run --format json` or explicitly versioned loopback
  server profile; OpenCode owns provider login and model inventory.
- Generic CLI: fixed executable/argv/schema mapping; no shell and no pipeline command.
- HTTP/Kafka Worker: reuse current adapters and canonical protocol; connection
  revisions wrap rather than replace transport configuration.

## Health/discovery failure behavior

Missing executable, unsupported version, auth required, timeout, malformed output,
capability mismatch, and revoked state produce bounded reason codes and safe receipt
metadata. A failed test does not mutate attempt outcomes. Probes have deadline,
output, concurrency, and frequency limits and run with the minimum environment.

## Security and compatibility

The Local Executor Host remains trusted-code-only. Paths are canonical fixed config;
argv has no shell; environment and secrets are allowlisted. Existing legacy attempt
snapshots and `AGENT_TRANSPORT_CONFIG` behavior continue unchanged until explicitly
migrated; no historical connection identity is invented. Protocol-v1 legacy
headers/topics remain compatibility identifiers.

## Product example

An operator detects `/opt/codex`, sees `Auth required`, completes login outside
Tenvyr, tests again, and gets `Connected` with structured-output support. Attempt 1
freezes revision 3. The operator revokes it during execution; future attempts are
denied, supported work receives best-effort cancellation, and replay requests a
currently authorized connection rather than reusing revision 3 credentials.

## Non-goals

No provider proxy, account rotation, quota scraping, hidden auth import, automatic
fallback, arbitrary commands, public multi-user admin, or sandbox guarantee.
