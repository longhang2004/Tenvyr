---
title: "Tenvyr Product Discovery and Design-Partner Gates"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/ROADMAP.md
  - docs/product/principles.md
  - docs/reference/implementation-status.json
---

# Product discovery and design-partner gates

## ICP decision

Start with ICP B: 2–10 developers/operators already using two or more coding or
autonomous runtimes, running long tasks with real side effects, and caring about
cost, approvals, recovery, and audit. Preserve ICP A—internal AI platform teams—as
the expansion path through generic HTTP/Kafka/Worker connections and explicit
authority contracts.

The forcing question is: **If Tenvyr did not exist, what painful incident or
operational burden would force this team to find another solution?**

## Discovery interview

Ask for one recent run from goal to outcome: runtimes, duration, concurrency,
native subagents, failure/retry, cost surprise, side effects and permissions,
human approvals, debugging time, replay needs, artifacts, secrets, self-hosting,
number of operators, runtime switching, and the current operational workaround.
Avoid feature voting; ask what happened and what it cost.

## Evidence threshold

Before promoting a program, interview at least five qualified teams; require three
to describe the same high-severity problem with a recent concrete incident and two
to commit to a bounded design-partner trial or integration review. Record contrary
evidence and maintenance willingness, not only enthusiasm.

## Discovery-gated programs

| Program                                 | Hypothesis / target ICP                                                         | Evidence required to become READY                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| External multi-user production exposure | ICP A needs a shared organization workspace rather than single-owner deployment | Threshold above plus agreement on deployment/ownership model and named security owner; no automatic SaaS assumption                              |
| Artifact byte management                | Team loops cannot reliably replay/verify with external ArtifactRefs alone       | Three workflows require Tenvyr-owned bytes; define size, retention, object-store, integrity, malware/content policy, and download authorization  |
| MCP interoperability                    | Operators need reusable configured tools/context across heterogeneous runtimes  | Two runtimes and three partners need the same bounded MCP surface; prove policy interception point and Capsule metadata                          |
| A2A interoperability                    | Internal platforms need remote-agent tasks without custom Worker adapters       | Two design partners run A2A-compatible agents and require streaming/cancel/auth; pin official version and compatibility cost                     |
| Sandbox integrations                    | Trusted local execution blocks real adoption for untrusted code                 | Three partners require isolation and accept a third-party sandbox dependency; select adapter capability contract, never build a microVM platform |
| Wired OpenTelemetry                     | Existing observability systems are a buying requirement                         | Three partners identify an OTLP backend and concrete correlation query; exporter backpressure/privacy requirements agreed                        |
| Kubernetes/Helm                         | Compose/private host cannot meet chosen deployment                              | Two committed deployments require Kubernetes operations and own cluster support; otherwise keep Docker profiles                                  |
| Multi-tenant SaaS / enterprise RBAC     | Shared service economics justify tenancy complexity                             | Explicit business model, security owner, isolation threat model, and committed tenants; not inferred from local account switching                |

9router/cockpit-style multi-account switching remains a UX observation. It becomes
a product requirement only if chosen ICP workflows require runtime connection
selection—not consumer subscription credential brokerage.

## M10 evidence output

M10 must publish a compact design-partner findings record: interview count and
profile, top incidents, current substitutes, wedge task completion evidence,
security/deployment constraints, willingness to trial, and recommendation for
each discovery-gated program. No program is promoted from technical enthusiasm.

## M10 evidence record (2026-08-12)

- **Design-partner interviews: 0.** No qualified design partner completed
  the wedge this cycle. The offline deterministic demo
  (`services/orchestrator/src/m10-demo.spec.ts`) proves the product wedge
  mechanically (launch → Worker failure → WAIT → approval → ACCEPT →
  Capsule) but is NOT partner evidence.
- **Wedge task completion evidence:** internal only (demo + M10-S1–S4
  gates). External completion evidence remains open.
- **Top incidents / substitutes / trial willingness:** not recorded —
  no interviews.
- **Discovery-gated programs:** none promoted. No feature vote or internal
  enthusiasm promotes later programs; the M10 closure record stays empty
  until real interviews are recorded and Sol reviews them.
