---
title: "Cross-Cutting Requirement: External Production Exposure Gate"
status: planned
audience:
  - product
  - developer
  - operator
last_verified: 2026-08-12
sources:
  - docs/reference/implementation-status.json
  - docs/archive/plans/tenvyr-roadmap/EXTERNAL_PRODUCTION_EXPOSURE_GATE.md
  - docs/architecture/overview.md
---

# External Production Exposure Gate

## Current decision

The gate is OPEN. M8–M11 target an operator-controlled, single-owner local or
self-hosted deployment. Existing Worker callback authentication does not secure
general Gateway/Orchestrator APIs or establish human/resource ownership.

## Claims blocked while open

- secure internet-facing, multi-user, or multi-tenant production service;
- externally administered runtime credentials, approvals, capsules, or replay;
- workspace/project ownership, sharing, tenant isolation, or enterprise RBAC;
- abuse-resistant public execution consumption or approval links;
- public access to sensitive context, artifacts, delegation, or audit records.

## Product decision required before implementation

Choose one deployment model: single-owner local/self-hosted, single-organization
workspace, private-cloud team, or multi-tenant SaaS. Then freeze human and service
identity, workspace/project/resource ownership, credential ownership, roles or
capabilities, approval actor identity, operator audit identity, cross-resource
authorization, API contract, and rate/resource-abuse semantics.

This must not collapse into a generic "add JWT" task. The selected ownership model
drives schema, APIs, audit, secret lifecycle, revocation, and verification.

## Closure verification

Require threat modeling and executable wrong-owner, enumeration, privilege
escalation, token replay/revocation, approval replay, cross-resource/cross-tenant,
CSRF/origin, webhook confusion, oversized input, rate exhaustion, secret leakage,
and audit-integrity tests. Verify TLS/proxy/header behavior and credential rotation
in the supported deployment. Unit guards alone are insufficient.

M11 can harden the single-owner profile while this broader gate remains OPEN and
explicit. A later exposure milestone requires its own accepted PLAN/SPEC/VERIFY/GOAL.
