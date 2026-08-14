---
title: "M11 Verification: Single-Owner Self-Hosted Productization"
status: planned
audience:
  - developer
  - operator
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M11-self-hosted-productization/SPEC.md
  - docs/operations/testing-and-verification.md
  - docker-compose.yml
---

# M11 verification contract

## Architecture audit

Topology matches single-owner claim; PostgreSQL remains authority; no service is
publicly bound by default; local executor is trusted-code-only; secrets/references
and data/backup inventory are exact; no hidden HA/Kubernetes/SaaS/storage claim.

## Unit/static tests

Configuration/preflight validation, unsafe/default secrets, binding and volume
checks, version/migration compatibility, safe health reasons, backup metadata/checksum,
diagnostic bounds and log redaction.

## Real PostgreSQL and migration tests

Fresh schema; upgrade from every supported prior schema; repeat-safe startup;
failure injected before/during/after migration; incompatible rollback denied safely;
backup under documented quiesce/live rule; restore to clean PostgreSQL; all execution,
coordination, budget, approval, artifact-reference and Capsule identities/invariants.

## Integration/deployment tests

Fresh supported host/profile bootstrap; offline wedge; runtime connection setup;
container/service restart; host reboot simulation; graceful shutdown; disk/resource
pressure; credential rotation/revocation; reverse-proxy example if documented;
restore then replay/new run. Existing showcase/development profiles still work.

## Crash/restart and multi-replica

Crash at migration/backup/restore/start/stop and active team phases. M11 does not
claim HA, but duplicate accidental service start must preserve existing PostgreSQL
locks/uniqueness rather than corrupt authority.

## Security review

Default/public port scan, unsafe sample secrets, environment/log/health/diagnostic/
backup secret leakage, file permissions, backup theft assumptions, path/volume
traversal, reverse-proxy trust headers, restored credential revocation, malicious
runtime command and external exposure claim review.

## Backward compatibility and docs

Verify upgrade/restore from the advertised version, legacy identifiers, source
release/private packages, development and showcase commands. Publish operations
runbooks, support matrix, backup/restore evidence, limitations and unchanged open
exposure gate. Update implementation ledger only for delivered behavior.

## Required commands

```bash
pnpm setup:check
docker compose config
pnpm test:all
pnpm build:all
pnpm showcase:up
pnpm showcase:smoke
pnpm showcase:down
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
git diff --check
```

Add exact migration/backup/restore/fresh-host commands created by implementation and
run them against real PostgreSQL. Perform restore at least twice on separate clean
targets; never count an unavailable Docker gate as pass.

## Closure gate

`SAFE TO CLOSE` requires independent Sol evidence for install, supported upgrade,
failure recovery, two clean restores, runtime reconnection, offline wedge, private
defaults, secret review and truthful single-owner docs. DeepSeek cannot close M11 or
the broader exposure gate.
