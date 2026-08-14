---
title: "M11 DeepSeek Goal: Single-Owner Self-Hosted Productization"
status: planned
audience:
  - developer
  - operator
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M11-self-hosted-productization/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/M11-self-hosted-productization/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/M11-self-hosted-productization/VERIFY.md
---

# M11 Goal Mode

## Objective

Make the closed product wedge repeatably operable on one owner-controlled host.

## Slice order

1. Read current Compose/setup/migrations/operations and design-partner evidence.
   Freeze the smallest supported topology/version/trust/data contract in docs/tests.
2. Reuse Compose to add safe bootstrap, private defaults, secret-reference setup,
   preflight/readiness and Runtime Connection onboarding. No installer framework.
3. Implement/document upgrade, verified backup and clean restore. Inject migration
   failures; prove identities and run the restored wedge before continuing.
4. Add bounded health/diagnostics, resource guidance, rotation/revocation, shutdown,
   restart and incident runbooks with security tests.
5. Run two clean restores, fresh install, prior-version upgrade, full VERIFY, current
   docs/ledger and provisional report; request Sol audit.

## Rules and stops

Stop if the chosen deployment requires multi-user ownership, public authorization,
HA, Kubernetes, object storage or sandbox semantics; those require separate product
approval. Never ship live sample secrets, destructive migration shortcuts, untested
restore claims, public bindings by default, or close the exposure gate implicitly.
