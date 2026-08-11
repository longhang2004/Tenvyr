---
title: "Tenvyr Roadmap Current-Technical-Research Register"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/ROADMAP.md
  - docs/product/principles.md
---

# Current-technical-research register

External APIs and standards may change after this plan is written. DeepSeek must
perform research immediately before the relevant slice, using current official
primary sources, record URLs/version/date in the milestone report, and re-check
assumptions against installed versions.

| Milestone | Research required                                                                                                                                                | Decision output                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| M3        | Supported Codex runtime/integration and authentication; Claude Agent SDK/runtime; A2A protocol; OpenAI-compatible and DeepSeek provider behavior inside runtimes | approved integration mode, auth mechanism, lifecycle/cancellation/events, compatibility test matrix |
| M4        | No external policy product required initially; research standards only if adopting a policy expression/interchange format                                        | evidence that the chosen minimal internal decision contract is necessary and safe                   |
| M5        | No planner provider API belongs in core; research chosen runtime structured-output guarantees only for the optional proposal-producing Worker                    | versioned proposal producer assumptions, never execution authority                                  |
| M6        | Current native Codex/Claude/runtime subagent and A2A delegation capabilities                                                                                     | opaque/observed/supervised mapping and what can actually be intercepted                             |
| M7        | Current OpenTelemetry SDK, OTLP, W3C Trace Context/Baggage, semantic conventions, and optional provenance export standards                                       | projection contract, version compatibility, privacy/bounds                                          |

Anti-patterns:

- no blogs or generated summaries as sole authority;
- no scraping or impersonating private/internal user sessions;
- no frozen undocumented CLI flags or SDK methods;
- no provider SDK dependency in Orchestrator or Worker core merely for examples;
- no implementation based on a future-looking API name that official docs do not
  support.

Research can block one optional integration without blocking the framework-neutral
milestone core. Record the narrow blocker and continue only with independent slices.
