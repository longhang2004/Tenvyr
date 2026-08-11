---
title: "M2F Implementation Plan: Program Hardening and Closure Readiness"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/50-m2f-hardening-closure-spec.md
  - docs/archive/plans/m2-program/03-global-verification-and-anti-regression.md
  - docs/reference/implementation-status.json
---

# M2F hardening plan

M2F starts only after M2B-E receipts say ready for independent review.

## Checkpoint F1 — evidence inventory and gap audit

1. Read every stage receipt and list every requirement/anti-regression ID with its
   executable evidence path.
2. Inspect the complete diff file by file and map every production change to tests
   and current documentation.
3. Run focused searches/architecture checks for forbidden coupling, URI sinks,
   sensitive logs, duplicate transaction authorities, and full-output copying.
4. List missing, flaky, mock-only, or overclaimed evidence. Repair root causes in
   the owning stage's smallest source/test surface.
5. Do not redesign green functionality for aesthetic consistency.

## Checkpoint F2 — cross-stage system tests

1. Add one bounded end-to-end workflow fixture exercising state projection,
   successful artifact production, downstream artifact projection/exposure, and
   controlled state write.
2. Add retry, duplicate, conflict, cancellation, failure-policy, and restart
   variants using existing harnesses.
3. Assert database truth across Execution, LogicalStep, StepAttempt, DispatchOutbox,
   ResultInbox, Artifact, exposure, ExecutionState, and write provenance.
4. Prove old no-M2-config workflow behavior in a paired compatibility fixture.
5. Avoid a second orchestration test framework or external provider dependency.

## Checkpoint F3 — migration, failure, and scale matrix

1. Implement the clean-install and representative-upgrade matrices.
2. Complete failure injections at every new late-write boundary and verify cleanup.
3. Complete exact-bound and 100-way contention profiles.
4. Close/reopen DataSource and exercise real recovery/redelivery after commits.
5. Keep test duration suitable for the existing serial PostgreSQL gate; record
   concrete durations in the receipt.

## Checkpoint F4 — contract, SDK, package, and security closure

1. Run cross-language conformance and package pack/install checks.
2. Exercise HTTP/Kafka paths touched by context propagation and open-handle gates.
3. Run URI non-dereference and sensitive-log adversaries.
4. Review dependency manifests and imports for forbidden/provider/storage additions.
5. Confirm protocol v1 compatibility and deliberate hashes/schema mirrors.

## Checkpoint F5 — documentation and final gate

1. Reconcile executable behavior with current architecture, protocol, operations,
   implementation status narrative, and machine ledger.
2. Ensure every planned file is reachable from `docs/README.md`, links are valid,
   archives are not cited as current truth, and historical limitations are honest.
3. Run the global gate ladder, including two sequential real PostgreSQL runs.
4. Run Prettier on every changed non-Python file, Python Ruff checks, package checks,
   docs/identity verifiers, and `git diff --check`.
5. Write the final receipt and leave plans active for Tech Lead verification.

## Final self-review questions

- Can the database answer what exact context one attempt received and which
  authoritative artifacts were exposed?
- Can every state write be traced to frozen mapping plus canonical result?
- Does any recovery path derive new context or repeat a committed side effect?
- Can any cross-execution/unbounded/unsafe value cross a new trust boundary?
- Do current docs distinguish reference immutability from external byte immutability?
- Is every claim backed by a runnable check, not a receipt assertion alone?

Any negative answer means M2F is not ready.
