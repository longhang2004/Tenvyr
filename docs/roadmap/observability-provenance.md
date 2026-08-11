---
title: Observability, Provenance, and Product Differentiation Roadmap
status: planned
audience:
  - developer
  - product
last_verified: 2026-07-28
sources:
  - contracts/schemas/agent-invocation.v1.schema.json
  - services/orchestrator/src/agent-adapters/agent-adapter.router.ts
  - packages/worker/package.json
  - sdks/python-worker/pyproject.toml
  - docs/reference/implementation-status.md
---

# Observability, provenance, and product differentiation roadmap

> **Future roadmap and architectural direction. This document does not make
> these capabilities part of the current implementation.**

The private TypeScript and Python Worker SDKs and protocol-v1 numeric
interoperability are current implementation, not roadmap promises. Their
evidence is summarized in the [implementation status ledger](../reference/implementation-status.md).
Everything described as a theme below remains planned unless that ledger and
current architecture documentation say otherwise.

## Product boundary

Tenvyr is independent from similarly named public observability and provenance
projects documented in the product identity decision. Those products may
emphasize OpenTelemetry, cross-agent tracing, provider proxies,
session/delegation graphs, token and cost attribution, framework
instrumentation, and dashboards for routing, replay, and debugging.

This project is an execution control plane. Its current center is versioned
invocation/result contracts, pipeline/DAG execution, transport adapters,
retry/timeout policy, lifecycle supervision, idempotency, callback security,
and future policy, artifact, and evaluation control.

The intended differentiation is:

```text
Other project: explain what agent systems did.

This project: decide, execute, supervise and eventually explain
what agent systems did.
```

The comparison is positioning, not criticism. Observability patterns from the
other project are useful inputs, but this control plane must preserve its own
authoritative execution model and framework-neutral boundary.

## Architectural invariants

| Invariant                                      | Consequence                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Execution state is authoritative               | A trace backend may be unavailable, delayed, sampled, or reprocessed without changing pipeline truth.      |
| Observability is a projection                  | Spans and dashboards are derived from accepted execution, attempt, callback, policy, and artifact records. |
| Open standards are the portability layer       | OTLP and W3C trace context are preferred over a backend-specific telemetry contract.                       |
| Privacy is configured at the control plane     | Workers and instrumentation cannot silently widen payload capture.                                         |
| Provider integrations stay outside Worker core | Model SDK version churn must not destabilize execution lifecycle or contracts.                             |
| Roadmap work requires durable ownership        | Accepted responsibility eventually needs durable state before replay, outbox, and audit claims are made.   |

## Theme A — OpenTelemetry execution model

The proposed hierarchy is:

```text
pipeline.execute
├── step.execute
│   ├── agent.dispatch
│   ├── agent.run
│   │   ├── gen_ai.*
│   │   ├── tool.execute
│   │   └── artifact.create
│   └── agent.result_callback
```

Each retry is a separate attempt span linked to the logical step. Adapter kind,
invocation ID, step attempt, execution ID, and dispatch ID are attributes, not
substitutes for database keys. The implementation must pin one OpenTelemetry
GenAI semantic-convention version and isolate convention changes behind a
compatibility mapper because those conventions continue to evolve.

| Field                      | Direction                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem                    | Operators cannot correlate control-plane decisions, transport work, Worker execution, model/tool activity, and callbacks in one portable view.              |
| Proposed capability        | Project authoritative lifecycle events into the span hierarchy above and export with OTLP to any compatible backend.                                        |
| Why this project is suited | It already owns pipeline, step, attempt, adapter, invocation, timeout, retry, and callback boundaries.                                                      |
| Dependencies               | Stable event identifiers, telemetry compatibility layer, pinned semantic-convention version, OTLP configuration, privacy policy.                            |
| User value                 | One causal execution waterfall without making the tracing backend transactional.                                                                            |
| Differentiation            | Traces include control-plane choice and supervision, not only model calls.                                                                                  |
| Complexity                 | High.                                                                                                                                                       |
| Key risks                  | Cardinality, double instrumentation, semantic-convention churn, sampling that hides failures, telemetry backpressure.                                       |
| Acceptance signal          | A sampled pipeline can be reconstructed across Orchestrator and Worker spans while the same run completes correctly with telemetry disabled or unavailable. |

## Theme B — W3C trace-context propagation

HTTP submissions and callbacks should carry `traceparent`, `tracestate`, and
controlled baggage. Kafka messages should carry the same context in headers.
Workers extract the parent context, create `agent.run`, and callbacks continue
the trace. Payload bodies must not be the only trace carrier.

Current `traceId` and `correlationId` fields remain useful business
correlation. They are not a complete replacement for W3C trace context.

| Field                      | Direction                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem                    | Current business IDs correlate records but do not preserve standard parent/child trace context across HTTP, Kafka, Worker, and callback boundaries.   |
| Proposed capability        | Inject and extract W3C context in transport headers with a baggage allowlist and explicit invalid-context behavior.                                   |
| Why this project is suited | Both transport adapters and the Worker protocol are controlled at defined trust boundaries.                                                           |
| Dependencies               | Theme A context APIs, header size policy, Kafka header support, callback signing review, cross-language fixtures.                                     |
| User value                 | End-to-end traces survive process, language, and transport changes.                                                                                   |
| Differentiation            | The trace follows execution supervision and adapter routing, not only framework-local calls.                                                          |
| Complexity                 | Medium–high.                                                                                                                                          |
| Key risks                  | Untrusted baggage, header amplification, trace spoofing, broken parentage during retry, accidental business-ID replacement.                           |
| Acceptance signal          | One conformance fixture produces the same parentage through HTTP and Kafka in TypeScript and Python without moving trace context into payload fields. |

## Theme C — Provenance and artifact lineage

The conceptual model uses `Entity`, `Activity`, and `Agent`:

| Tenvyr concept       | Provenance concept |
| -------------------- | ------------------ |
| Agent implementation | Agent              |
| Step attempt         | Activity           |
| Pipeline input       | Entity             |
| Artifact             | Entity             |
| Result output        | Entity             |
| Model/tool call      | Activity           |

The system should answer which attempt created an artifact, which inputs and
artifacts an attempt used, which runtime was responsible, what data produced a
final output, which retries created cost/artifacts, and which runtimes handled
sensitive data. PROV-O may be a projection/export format; it is not required
to be the storage schema.

| Field                      | Direction                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem                    | Result records identify outcomes but do not preserve durable lineage between inputs, attempts, tools, models, artifacts, and final output.                                                                                                                                                                                                                                                                                                           |
| Proposed capability        | Add immutable artifact identities and used/generated/associated relationships, then derive a provenance graph and optional PROV-O projection.                                                                                                                                                                                                                                                                                                        |
| Why this project is suited | The control plane already assigns execution, step-execution, attempt, invocation, and result identities.                                                                                                                                                                                                                                                                                                                                             |
| Dependencies               | Artifact content storage, privacy labels, content hashing, retention policy (durable attempt events are satisfied — Milestone 1; durable artifact identity and producer lineage are partial — Milestone 2A; a durable per-execution ExecutionState core is partial — Milestone 2B, internal primitive only). This table is roadmap intent, not current implementation truth: see the [implementation status](../reference/implementation-status.md). |
| User value                 | Auditable answers about origin, responsibility, retry waste, and sensitive-data transit.                                                                                                                                                                                                                                                                                                                                                             |
| Differentiation            | Lineage is joined to enforced execution state and policy decisions.                                                                                                                                                                                                                                                                                                                                                                                  |
| Complexity                 | High.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Key risks                  | Large graphs, ambiguous derived data, sensitive lineage metadata, inconsistent external-agent reporting.                                                                                                                                                                                                                                                                                                                                             |
| Acceptance signal          | A final result can be traced to immutable input/artifact identities and the exact successful or failed attempts that used or generated them.                                                                                                                                                                                                                                                                                                         |

## Theme D — Provider telemetry proxy

Future optional topology:

```text
CLI agent
→ optional telemetry proxy/sidecar
→ model provider
```

Target users include Claude Code, Codex CLI, Gemini CLI, OpenCode, proprietary
external agents, and runtimes that cannot be instrumented directly. The proxy
is an optional observability path and must never become the core execution
path.

| Field                      | Direction                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem                    | Some CLI and proprietary agents cannot expose model/tool telemetry through explicit hooks.                                                                  |
| Proposed capability        | An isolated opt-in proxy/sidecar that passes streams through, extracts bounded usage metadata, emits spans, and fails independently from the control plane. |
| Why this project is suited | Invocation and runtime identities can bind otherwise opaque provider calls to supervised attempts.                                                          |
| Dependencies               | Theme A/B, credential boundary design, provider compatibility suite, privacy policy, independent deployment.                                                |
| User value                 | Visibility for hard-to-instrument agents without modifying their source.                                                                                    |
| Differentiation            | Proxy telemetry joins control-plane attempts and policy decisions but remains bypassable.                                                                   |
| Complexity                 | Very high.                                                                                                                                                  |
| Key risks                  | Stream corruption, request/response privacy, TLS interception, rate limits, provider drift, credential exposure, failure coupling, bypass detection.        |
| Acceptance signal          | Supported streaming and non-streaming calls are byte/semantic equivalent with proxy on or off, and proxy failure cannot stop core execution.                |

## Theme E — Instrumentation levels

Adoption should progress through:

| Level                       | Contract                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Explicit instrumentation    | Stable context hooks such as `await context.traceTool("repository-search", () => searchRepository())`. |
| Opt-in auto-instrumentation | Versioned plugins with a compatibility matrix and safe install/uninstall behavior.                     |
| Zero-code provider proxy    | Optional sidecar for runtimes that cannot use explicit hooks.                                          |

Possible packages after the public scope decision:

```text
<future-scope>/otel
<future-scope>/instrument-openai
<future-scope>/instrument-anthropic
<future-scope>/instrument-google
<future-scope>/provider-proxy
```

| Field                      | Direction                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem                    | One instrumentation method cannot balance correctness, adoption effort, and coverage across controlled and opaque runtimes.                       |
| Proposed capability        | Ship explicit hooks first, then opt-in versioned auto-instrumentation, then the proxy for remaining gaps.                                         |
| Why this project is suited | Worker context provides a stable explicit boundary while plugins can remain outside core.                                                         |
| Dependencies               | Public package identity, Theme A APIs, provider compatibility tests, plugin release policy.                                                       |
| User value                 | Teams choose the least invasive level that meets their visibility needs.                                                                          |
| Differentiation            | All levels attach to the same supervised attempt model.                                                                                           |
| Complexity                 | Medium for hooks; high for auto-instrumentation; very high for proxy.                                                                             |
| Key risks                  | Monkey-patch breakage, double spans, provider dependency leakage, framework runtime incompatibility.                                              |
| Acceptance signal          | Explicit hooks cover core examples; each opt-in plugin publishes a tested version matrix and never adds provider SDK dependencies to Worker core. |

## Theme F — Privacy-aware telemetry

Capture modes:

```text
off
metadata-only
hash-only
preview
full
```

Full inputs/outputs must not be stored directly in span attributes. Redaction
uses JSON paths; previews have byte limits; encrypted artifact storage holds
payloads when policy permits; spans contain references/hashes. Tenant policy
can only restrict capture unless a trusted control-plane policy explicitly
widens it. PII/secret scanning, retention, and data residency are required
design inputs.

| Field                      | Direction                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Problem                    | Agent telemetry can leak prompts, credentials, PII, proprietary data, and regulated artifacts.                                                       |
| Proposed capability        | Policy-evaluated capture modes, path redaction, bounded previews, encrypted payload references, scanning, retention, and residency controls.         |
| Why this project is suited | The control plane knows tenant, execution, adapter, runtime, and artifact policy context.                                                            |
| Dependencies               | Policy events, artifact store, key management, tenant model, deletion/audit workflows.                                                               |
| User value                 | Useful telemetry with predictable disclosure and retention.                                                                                          |
| Differentiation            | Privacy decisions are tied to execution policy rather than individual instrumentation defaults.                                                      |
| Complexity                 | Very high.                                                                                                                                           |
| Key risks                  | Irreversible leakage, redaction gaps, hash re-identification, regional export, policy mismatch across SDKs.                                          |
| Acceptance signal          | Capture fixtures prove each mode, forbidden JSON paths never reach spans, and full payloads appear only as encrypted authorized artifact references. |

## Theme G — Control-plane dashboard

The future dashboard should combine four views:

| View                 | Required questions                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Execution            | Pipeline state, active/blocked steps, critical path, retries, timeouts.                                 |
| Causality            | Dispatch, Worker execution, model/tool calls, callbacks, artifacts.                                     |
| Decision explanation | Why an adapter/agent was selected, which policy applied, why retry/fallback occurred, remaining budget. |
| Failure attribution  | Contract, transport, Worker, agent, model, tool, callback, policy, or artifact.                         |

| Field                      | Direction                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Problem                    | A trace-only dashboard cannot explain authoritative state, control decisions, or responsibility boundaries.                        |
| Proposed capability        | Join execution records, policy events, trace projections, costs, and provenance into one explorer.                                 |
| Why this project is suited | The Orchestrator owns the state machine and decision points missing from telemetry-only views.                                     |
| Dependencies               | Themes A–C/F/H, durable event model, query API, access control.                                                                    |
| User value                 | Faster diagnosis of what happened, why it happened, and which boundary failed.                                                     |
| Differentiation            | Control decisions and budgets appear beside causal telemetry.                                                                      |
| Complexity                 | Very high.                                                                                                                         |
| Key risks                  | Conflicting trace/database state, expensive graph queries, misleading explanation text, tenant data leakage.                       |
| Acceptance signal          | An operator can diagnose a seeded multi-boundary failure and identify the authoritative state transition without reading raw logs. |

## Theme H — Cost and token attribution

Attribution must extend beyond `AgentResultV1.usage`: model call, tool, agent,
attempt, step, pipeline, retry cost, and failure waste. Later policy may enforce
budgets and enable cost-aware routing. Provider-reported cost is not trusted
without model/pricing source and version metadata.

| Field                      | Direction                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Problem                    | Aggregate usage cannot identify expensive attempts, retries, tools, failures, or routing decisions.                                       |
| Proposed capability        | Normalize usage events and compute versioned cost allocations from model call through pipeline.                                           |
| Why this project is suited | Attempts, retries, steps, pipelines, and routing decisions already have control-plane identities.                                         |
| Dependencies               | Provider usage adapters, versioned pricing table, provenance links, budget policy, currency/rounding rules.                               |
| User value                 | Explain spend, quantify failure waste, enforce budgets, and compare routes.                                                               |
| Differentiation            | Costs are attached to supervised decisions and retries, not only requests.                                                                |
| Complexity                 | High.                                                                                                                                     |
| Key risks                  | Missing usage, stale prices, provider billing mismatch, cached-token semantics, misleading estimates.                                     |
| Acceptance signal          | Every attributed amount records usage source, pricing source/version, confidence, and roll-up equality across call/attempt/step/pipeline. |

## Theme I — Framework adoption

After TypeScript and Python Worker SDKs, publish examples for LangGraph, OpenAI
Agents SDK, CrewAI, PydanticAI, a generic custom agent, and a CLI agent. Each
integration uses the Worker SDK as the runtime harness; framework orchestration
does not enter core.

| Field                      | Direction                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Problem                    | Framework users need proven integration patterns without coupling the control plane to each framework.     |
| Proposed capability        | Maintained end-to-end examples and conformance checks around the common Worker harness.                    |
| Why this project is suited | The language-neutral invocation/result contract already separates orchestration from agent implementation. |
| Dependencies               | Python SDK, shared fixtures, stable public package names, framework version policy.                        |
| User value                 | Faster adoption and a clear migration path from framework-local execution.                                 |
| Differentiation            | Frameworks remain replaceable behind a supervised runtime boundary.                                        |
| Complexity                 | Medium, with ongoing compatibility cost.                                                                   |
| Key risks                  | Example drift, implied support promises, framework lifecycle conflicts, hidden nested retries.             |
| Acceptance signal          | Every example passes the same invocation, callback, cancellation, and idempotency conformance scenarios.   |

## Theme J — Public identity reservations and release gates

Tenvyr is approved for local repository implementation. Public release remains
blocked on owner-controlled registry, domain, legal, organization, repository,
and publication decisions. Risks include SEO and documentation confusion,
domain availability, user trust, trademark/legal review, and npm/PyPI scope
collision.

Required owner work:

| Step | Decision                                                                  |
| ---- | ------------------------------------------------------------------------- |
| 1–3  | Reserve the organization, npm, PyPI, and domain identities.               |
| 4–5  | Complete trademark/legal review.                                          |
| 6    | Completed: MIT License selected on 2026-07-28.                            |
| 7–9  | Rename the external repository, configure redirects, and approve publish. |

Do not publish `@tenvyr/worker` or claim public availability before these
gates are complete.

| Field                      | Direction                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Problem                    | A local identity alone does not reserve public packages, domains, or legal rights.                                      |
| Proposed capability        | Complete the coordinated package/domain/repository reservation and release plan.                                        |
| Why this project is suited | Its control-plane positioning gives a clear naming brief distinct from a telemetry-only product.                        |
| Dependencies               | Product owner, legal/trademark review, registry/domain checks, migration inventory.                                     |
| User value                 | Unambiguous docs, packages, support, security advisories, and trust.                                                    |
| Differentiation            | The chosen identity communicates execution control and supervision.                                                     |
| Complexity                 | Medium technically; high organizationally.                                                                              |
| Key risks                  | Package squatting, broken imports/links, migration churn, residual affiliation confusion.                               |
| Acceptance signal          | Approved name, scope, domain, GitHub/PyPI/npm availability record, legal sign-off, and a rehearsed migration checklist. |

## Priority phases

### Phase 0 — Before public release

| Item                           | Exit signal                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Public identity and legal gate | Theme J acceptance signal is met before any package publish.                      |
| Non-interactive lint setup     | Repository lint runs without framework prompts and reports a reproducible result. |
| Docker production validation   | Supported production Compose and CI paths build and run their documented checks.  |

### Phase 1 — 0–3 months

| Item                                 | Exit signal                                                              |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Basic Orchestrator/Worker OTel spans | Theme A hierarchy exports through OTLP with telemetry failure isolation. |
| W3C HTTP/Kafka propagation           | Theme B cross-transport fixture passes.                                  |
| Local Tempo/Jaeger stack             | A developer can inspect one loopback pipeline trace locally.             |
| Framework examples and durable ADRs  | Initial examples pass conformance and decisions are versioned in ADRs.   |

### Phase 2 — 3–6 months

| Item                                          | Exit signal                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Artifact store and lineage                    | Immutable artifact references answer Theme C origin/use questions.                               |
| Provenance graph and privacy capture          | Graph queries respect Theme F capture, retention, and residency policy.                          |
| Execution trace explorer and cost attribution | Attempts, callbacks, artifacts, tokens, and versioned cost roll up per pipeline.                 |
| Approval and policy events                    | Decisions are durable, attributable, and visible in execution history.                           |
| Durable callback/idempotency options          | Accepted responsibility survives process crash through reviewed outbox/inbox and store adapters. |

### Phase 3 — 6–12 months

| Item                                                | Exit signal                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Provider instrumentation plugins and optional proxy | Compatibility matrices pass; Worker core stays provider-neutral.                                      |
| CLI Adapter sandbox                                 | CLI agents run with explicit isolation, credentials, cancellation, and resource policy.               |
| Decision explanation and root-cause graph           | Dashboard explains seeded routing/retry/fallback failures from authoritative events.                  |
| Evaluation and quality-aware routing                | Versioned evaluations influence routing with auditable policy inputs.                                 |
| Budget-aware routing, fallback, and replay          | Budget/policy decisions are enforced; replay declares deterministic and non-deterministic boundaries. |

### Phase 4 — After 12 months

| Item                                          | Exit signal                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| PROV-O projection/export                      | Theme C graph exports validated provenance without changing the internal storage model. |
| Cross-control-plane federation                | Identity, policy, trace, and provenance boundaries work across trusted control planes.  |
| Multi-region execution                        | Region placement, failover, idempotency, and residency semantics are tested.            |
| Advanced audit/compliance exports             | Exports are access-controlled, reproducible, redacted, and retention-aware.             |
| Marketplace/registry, only with proven demand | Measured ecosystem demand and a reviewed trust/signing model justify the surface.       |

## Current non-goals

The current implementation includes private TypeScript and Python Worker SDKs
and protocol-v1 numeric interoperability, plus M2A durable artifact identity
and producer lineage, the M2B internal durable ExecutionState core (an
Orchestrator-internal primitive only), and the M2C state-only ContextSnapshot
(opt-in `contextProjection.stateKeys`; `context.tenvyr.artifacts` stays an
empty list). It does not include OpenTelemetry
instrumentation, W3C propagation, the planned control-plane observability
dashboard, provider proxy, PROV-O exporter, artifact content storage,
artifact context projection, policy engine, CLI Adapter, durable
callback/idempotency storage, provider integration, auto-instrumentation,
public package release, external repository rename, or database migration.
