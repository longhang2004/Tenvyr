---
title: "Tenvyr Roadmap Current-Technical-Research Register"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/ROADMAP.md
  - docs/product/principles.md
---

# Current-technical-research register

External APIs and standards may change after this plan is written. DeepSeek must
perform research immediately before the relevant slice, using current official
primary sources, record URLs/version/date in the milestone report, and re-check
assumptions against installed versions.

| Milestone | Research required                                                                                                                                                | Decision output                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| M3        | DONE 2026-08-11 — official sources fetched: developers.openai.com/codex (CLI 0.147.0, 2026-08-07), code.claude.com agent-sdk (TS 0.3.227 / PyPI 0.2.135), a2a-protocol.org (v1.0.0, 2026-03-12; patch v1.0.1), api-docs.deepseek.com (models deepseek-v4-flash/pro; legacy retired 2026-07-24) | [compatibility matrix](../../../architecture/executors/native-integrations.md): Codex = fixed command under local executor host; Claude Agent SDK = runtime worker app (deferred, no credentials); A2A = DEFERRED (protocol extension needs version/compat approval); DeepSeek = runtime config only |
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
