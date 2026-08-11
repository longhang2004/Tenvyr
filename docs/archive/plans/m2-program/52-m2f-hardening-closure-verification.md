---
title: "M2F Verification Plan: Program Hardening and Closure Readiness"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md
  - docs/operations/testing-and-verification.md
  - scripts/verify-docs.mjs
  - scripts/verify-product-identity.mjs
  - scripts/verify-package-packs.mjs
---

# M2F verification plan

## Required cross-stage scenarios

1. Legacy pipeline: no projection/writes, unchanged invocation/state/result behavior.
2. State-only projection: exact snapshot/outbox equality across dispatch restart.
3. Artifact chain: producer result creates Artifact; downstream attempt exposes
   exact reference and durable lineage without URI dereference.
4. State-write chain: canonical succeeded output maps selected values, exact version
   and provenance; full output stays outside state.
5. Combined chain: state plus artifacts projected, downstream result writes state,
   all lineages queryable after DataSource restart.
6. Retry chain: attempt-specific snapshots/exposures; one outbox redelivery adds none.
7. Failure chain: projection/mapping bound error follows failure policy without
   poison loop, partial state, or partial authority.
8. Cancellation chain: late result/event cannot resurrect or write.
9. Duplicate/conflict chain: canonical first result and exactly-once artifacts/state.
10. Race chain: claim/state/result concurrency has coherent versions and exact rows.

## Required data-truth assertions

Query real PostgreSQL directly for:

- migration identities/order;
- state JSON/version/timestamp versus rowVersion;
- attempt snapshot versus outbox invocation context;
- Artifact to producer ResultInbox/StepAttempt;
- exposure to target StepAttempt and same execution;
- controlled-write provenance to canonical ResultInbox and versions;
- absence of historical fabricated rows;
- exact row counts after retry, duplicate, conflict, restart, and failure injection.

## Full command gate

Run every command from the global verification file. The minimum final sequence is:

```bash
pnpm --filter orchestrator test -- --runInBand

TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test \
  pnpm --filter orchestrator test -- --runInBand

TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_m2_test \
  pnpm --filter orchestrator test -- --runInBand

pnpm test:all
pnpm build:all
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs

sdks/python-worker/.venv/bin/python -m pytest sdks/python-worker/tests
sdks/python-worker/.venv/bin/python -m ruff check \
  sdks/python-worker/src sdks/python-worker/tests
sdks/python-worker/.venv/bin/python -m ruff format --check \
  sdks/python-worker/src sdks/python-worker/tests

python scripts/sync-python-worker-schemas.py check
python scripts/verify-python-worker-package.py

pnpm exec prettier --check <all-final-changed-non-python-files>
git diff --check
```

Add the exact current HTTP loopback/open-handle and Kafka gates from
`docs/operations/testing-and-verification.md` when those runtime paths changed.
No command may be collapsed into an ambiguous combined receipt row.

## Final adversarial review

- one byte/item/key/mapping beyond every bound;
- astral Unicode, invalid pointer escapes, unsafe nested JSON keys;
- malicious URI/path/metadata strings with network/file APIs instrumented;
- cross-execution Artifact UUID and descriptor-ID collision;
- forced late DB failures for outbox, exposure, artifact, state, and provenance;
- kill/restart-equivalent DataSource loss after commit before acknowledgement;
- old schema/old Worker/old pipeline compatibility fixtures;
- log/error capture with secret-like values;
- package tarball/schema mirror and documentation-link adversaries.

## Receipt and handoff

Write `docs/_scratch/m2-program/m2f-receipt.md` plus a final section linking the
M2B-E receipts. Include exact HEAD/status, file inventory by stage, migrations,
all command outcomes/counts/durations, failures and repairs, limitations, and the
phrase `READY FOR INDEPENDENT TECH LEAD REVIEW` only if everything is green.

Do not archive, commit, push, or write `SAFE TO CLOSE`. The next action after this
receipt is independent Tech Lead review of the complete accumulated program.
