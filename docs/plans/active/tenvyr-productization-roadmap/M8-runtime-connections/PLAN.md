---
title: "M8 Plan: Runtime Connections"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/architecture/executors/native-integrations.md
  - docs/architecture/executors/local-executor-host.md
  - docs/reference/implementation-status.json
  - docs/plans/active/tenvyr-productization-roadmap/RESEARCH_REGISTER.md
---

# M8 Runtime Connections plan

## Product outcome

An operator can define, detect, health-check, select, revise, and revoke a
Runtime Connection for Codex, Claude, OpenCode, a Generic CLI, HTTP Worker, or
Kafka Worker. Every claimed attempt freezes a secret-free connection revision
and conservative capability set; provider selection and authentication stay in
the runtime.

## Problem being solved

Current executor routing is static environment configuration. It has frozen
attempt descriptors but no stable connection identity/revision, discovery,
health contract, revocation semantics, or product status. Real agent runtimes
therefore cannot be selected truthfully in the team wedge.

## Existing capabilities reused

- `ExecutorDescriptorV1` freeze-at-claim and profile-mismatch behavior;
- Kafka/HTTP adapters and canonical invocation/result contracts;
- trusted-code-only Local Executor Host with fixed commands, bounded output,
  deadline kill, environment allowlist, and secret references;
- policy, approvals, budgets, events, capsules, and controlled replay;
- current Codex/Claude/A2A research in native integration documentation.

## Missing capabilities

Durable connection identity/revisions, richer capability vocabulary, safe CLI
discovery/version capture, test-connection receipts, lifecycle/status projection,
runtime-specific local adapters/profiles, revocation and replay rules, credential
ownership, operator service/UI API behind the exposure gate, and current public
documentation.

## Dependencies and allowed APIs

M3–M7 are closed. Before each adapter slice, use only the official commands/APIs
listed in `RESEARCH_REGISTER.md`: Codex login status/`codex exec`; Claude auth
status/headless CLI or Agent SDK with supported credentials; OpenCode auth/model
discovery and `opencode run`; fixed Generic CLI argv; existing HTTP/Kafka Workers.
Undocumented flags, cached-auth scraping, consumer token import/export, and
provider proxying are prohibited.

## Engineering slices

1. Foundation: durable immutable Runtime Connection revisions, secret-reference
   boundary, conservative capability contract, status projection, service-level
   create/revise/revoke/test APIs, and frozen attempt resolution.
2. Generic/local integration: fixed Generic CLI profile over the existing host,
   version/availability probes, bounded structured result mapping, and truthful
   trusted-code-only labeling.
3. Runtime profiles: Codex local/API automation, Claude local CLI plus supported
   SDK/API credential-ref example, and OpenCode runtime-owned auth. Pin tested
   versions; live credential tests remain optional explicit gates.
4. Product surface: connection cards/status/test/revoke APIs for local workbench,
   safe receipts, configuration bootstrap, and public README/feature/terminology/
   getting-started truth refresh.
5. Hardening/closure: rotation/revocation/dispatch races, restart, secret redaction,
   capability downgrade, old attempt compatibility, Capsule provenance, docs and
   full verification.

## Product-impacting alternatives

- Chosen: first-class durable connection revision wrapping existing executor
  profiles. Rejected: rename `AgentAdapter`, embed mutable configuration in a
  pipeline, or create a provider/model account registry.
- Chosen: CLI profile composes the Local Executor Host. A new workflow engine or
  shell-based adapter adds risk without capability.
- Local connection administration remains internal/local. External administration
  waits for identity/ownership decisions.

## Risks

Mutable config changing in-flight work; revoked connections dispatching; capability
overstatement; command/path injection; secret leakage; local credential trust;
Codex/Claude/OpenCode CLI churn; unsupported OAuth/session brokerage; health checks
causing cost or side effects; provider/account concepts leaking into core; replay
resurrecting old credentials; status probing creating resource exhaustion.

## Research-required items

Recheck official CLI/SDK commands, version output, auth status, automation auth,
structured output, cancellation, and licensing/third-party login rules immediately
before each profile. Record tested version ranges and unsupported surfaces.

## Explicit non-goals

No LLM gateway, model routing/fallback, consumer subscription router, quota scraping,
secret vault product, arbitrary command from pipeline input, sandbox claim, automatic
session import, A2A/MCP adapter, public admin API, or broad framework integrations.

## Closure definition

Sol may close M8 only when connection revisions are immutable/frozen, secrets never
enter descriptors/evidence, rotation and revocation have deterministic attempt and
replay behavior, health is bounded and truthful, all three named local runtimes have
documented tested profiles or an explicit narrow blocker, generic Workers remain
compatible, current product docs are truthful, and VERIFY passes.

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
