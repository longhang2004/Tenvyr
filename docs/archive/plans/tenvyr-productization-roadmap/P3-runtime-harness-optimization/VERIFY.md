---
title: "P3 VERIFY: Runtime Harness Optimization & Context Efficiency — bounded baseline"
status: historical
audience:
  - developer
last_verified: 2026-08-16
superseded_by:
  - docs/architecture/executors/invocation-efficiency.md
sources:
  - docs/archive/plans/tenvyr-productization-roadmap/P3-runtime-harness-optimization/SPEC.md
---

# P3 VERIFY — verification gates

## Focused gates (must all pass)

1. **Canonical fingerprint** — identical semantic inputs with stable
   ordering → identical hash; any relevant change → different hash.
2. **No random identity contamination** — differing executionId /
   timestamp / attemptId / invocationId must not change the hash (they are
   never in the canonical inputs unless semantically part of the projected
   agent context).
3. **Projection reuse** — MISS → materialize + store; identical inputs →
   HIT → byte-identical envelope; mutated load-bearing input → MISS + new
   hash.
4. **Authority independence** — a cache HIT never skips deadline / policy /
   budget / connection revocation. Proof: at least one authority mutation
   after cache population still blocks execution (policy DENY → durable
   FAILED attempt, no outbox).
5. **Metrics** — missing provider usage renders as not-reported (absent),
   never zero.
6. **Capsule** — historical execution reconstructs the exact recorded
   context bundle identity and efficiency evidence from frozen attempt rows.
7. **Deterministic dogfood** — real Postgres, real engine + real
   deterministic in-process HTTP workers, no provider credentials: run 1
   MISS, run 2 HIT (identical envelope + hash), one mutated load-bearing
   context input → MISS + new fingerprint.

## Full gates

```bash
pnpm test:all
pnpm build:all
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
python scripts/sync-python-worker-schemas.py check
python -m pytest sdks/python-worker/tests
git diff --check
```

Schema change (one jsonb column + agent-result usage fields) implies:

```text
real PostgreSQL integration suite twice
M11 authoritative backup inventory refreshed
self-hosted recovery E2E
```

Hosted CI must require no paid provider credentials.