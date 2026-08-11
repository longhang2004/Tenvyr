---
title: "M2D Verification Plan: Artifact Projection and Attempt Lineage"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md
  - services/orchestrator/src/database/migrations/milestone-two-artifact-identity.spec.ts
  - services/orchestrator/src/services/result-inbox.service.spec.ts
  - services/orchestrator/src/database/postgres.integration.spec.ts
---

# M2D verification plan

## Selector and resolver cases

- direct and transitive dependency accepted; self/unrelated/future rejected;
- exact name, exact ordinal, no filter, metadata false/default/true;
- name and ordinal together, duplicate selectors, overlapping matches, zero match,
  too many selectors, and too many resolved references fail deterministically;
- successful current producer resolves; failed/cancelled/timed-out/ignored/conflict/
  superseded attempts do not;
- descriptor-provided ID cannot substitute for Tenvyr Artifact UUID;
- source descriptor absent optional fields remain absent;
- deterministic ordering is independent of query/insert order;
- complete context limit includes URI and opted-in metadata;
- result output and bytes are never included.

## Real PostgreSQL cases

1. Migration follows the exact live predecessor and creates expected constraints.
2. Running upgrade logic twice is safe and preserves existing M2A/M2B/C rows.
3. Historical artifacts/attempts receive no fabricated exposure rows.
4. Successful claim atomically creates attempt, snapshot, outbox, and exact edges.
5. Edge insert failure rolls all of them back; a clean retry succeeds.
6. Foreign-execution Artifact UUID is rejected even if descriptor fields match.
7. Producer result commit racing consumer claim never reads uncommitted/dangling data.
8. Replica race creates one attempt and one edge set.
9. Retry has distinct edges; outbox redelivery adds none.
10. Restart preserves lineage traversal in both directions.
11. Duplicate/conflicting/late producer result cannot alter canonical descriptors or
    existing exposure edges.
12. Attempt to delete exposed producer evidence is rejected per reviewed FK policy.

## URI and authority adversaries

Use hostile values such as loopback/cloud-metadata URLs, `file://`, traversal
paths, credentials, redirects, shell-like strings, oversized Unicode, and hostile
metadata keys. Assert they remain inert bounded data or are rejected by bounds.
Instrument or architecture-test network/file APIs so no resolver/claim path can
dereference them. Assert logs and thrown messages omit the values.

Prove AgentEvent artifact payloads, Worker descriptor IDs, names, and URIs cannot
create an Artifact row or exposure without canonical ResultInbox authority.

## Required gates

Run focused pipeline, resolver, claim, artifact, ResultInbox, migration, architecture,
adapter, and SDK cases; then:

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
pnpm exec prettier --check <m2d-changed-non-python-files>
git diff --check
```

Record results in `docs/_scratch/m2-program/m2d-receipt.md`.

## Stop conditions

Stop rather than expand scope if correctness requires fetching artifact content,
cross-execution sharing policy, a public artifact endpoint, tenant authorization,
retention/deletion product policy, or a claim that opaque external bytes are
immutable.
