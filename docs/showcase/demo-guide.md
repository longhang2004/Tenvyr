---
title: Tenvyr Showcase Demo Guide
status: current
audience:
  - product
  - developer
last_verified: 2026-07-28
sources:
  - package.json
  - scripts/smoke-e2e.mjs
  - docker-compose.showcase.yml
---

# Tenvyr showcase demo guide

This is a 5–10 minute interview flow. The default path is offline and makes no
provider API call.

1. **Frame the problem — 45 seconds.** Agent frameworks own reasoning; Tenvyr
   owns execution supervision: persisted state, runtime/transport, timeout,
   retry, standardized result, and auditability.
2. **Show the architecture — 45 seconds.** Point to the
   [overview](../architecture/overview.md): Dashboard → Gateway → Orchestrator,
   then Kafka specialized agents or signed-callback HTTP Workers.
3. **Start the showcase — 1–3 minutes.** Run `pnpm setup:check`, then
   `pnpm showcase:up`. Open <http://localhost:4000/dashboard>.
4. **Run success — 1 minute.** Run `pnpm showcase:seed`, then
   `pnpm showcase:smoke`. Highlight the Python `analyze-input` step followed by
   the Java-backed `quality-gate`.
5. **Show supervision — 1 minute.** Select the `retry-once` execution. Confirm
   attempt `2/2`, terminal success, runtime/transport, duration, and safe preview.
6. **Inspect provider evidence — 45 seconds.** Show mock provider/model/fallback
   metadata. Explain that Java Runner can select OpenAI, Anthropic, or Ollama,
   while Workers may call any application-owned provider SDK.
7. **Explain failure policy — 30 seconds.** A real provider must be explicitly
   exported; `.env` alone cannot opt the showcase into a live call. Its failure
   mode derives `fail` unless mock fallback is explicitly exported, so an
   invalid key cannot silently become a successful real-provider result.
8. **Close on boundaries — 45 seconds.** Native subagents reason; Tenvyr
   supervises. Mention process-local Worker state, cooperative cancellation,
   estimated Java token usage, and intentionally unbuilt roadmap systems.

The smoke command prints dashboard, API, and execution URLs and exits nonzero
on a mismatch. Stop only the named showcase project afterward:

```bash
pnpm showcase:down
```

For a real-provider explanation or optional manual run, use the copyable
commands in [using model providers](using-model-providers.md). Do not enter or
show a real API key during a recorded demo.
