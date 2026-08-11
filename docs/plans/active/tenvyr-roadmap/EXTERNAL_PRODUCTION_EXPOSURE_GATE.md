---
title: "Cross-Cutting Requirement: External Production Exposure Gate"
status: planned
audience:
  - product
  - developer
  - operator
last_verified: 2026-08-11
sources:
  - docs/reference/implementation-status.json
  - docs/architecture/overview.md
  - docs/architecture/transports/http-agent-adapter-v1.md
  - services/gateway/src/app.controller.ts
  - services/orchestrator/src/app.controller.ts
---

# External Production Exposure Gate

## Purpose

Current general Gateway and Orchestrator APIs are unauthenticated. Existing
Worker submission/callback authentication does not authenticate users or protect
general pipeline, execution, event, artifact, policy, approval, capsule, or replay
operations.

This gate does not silently add authentication to every milestone. It blocks only
claims and surfaces that require secure external exposure.

## Claims blocked while open

- secure internet-facing or multi-user production deployment;
- externally administered executor/credential configuration;
- public state, artifact, lineage, policy, approval, capsule, or replay APIs;
- tenant-isolated ownership, sharing, deletion, or export claims;
- approval links/tokens usable across an untrusted network;
- abuse-resistant public resource consumption.

Local, isolated, operator-controlled implementation may proceed if every affected
milestone documents the limitation and exposes no new sensitive public route.

## Closure decisions required

1. Authentication: supported caller identities, service identities, session/token
   mechanism, rotation, revocation, and bootstrap.
2. Authorization: ownership/resource model, roles or capabilities, action-level
   checks, default deny, and audit.
3. Credential boundary: secret references, resolution authority, encryption at
   rest/in transit, redaction, lifecycle, and executor delivery.
4. Tenant/deployment model: single-owner, project/workspace, or multi-tenant;
   isolation assumptions must be explicit before schema/API design.
5. Abuse controls: request/body/query bounds, rate/resource limits, audit retention,
   webhook trust, CSRF/origin rules where applicable, and incident response.

## Verification gate

Before closing, require threat modeling and executable tests for unauthenticated,
wrong-owner, privilege escalation, token replay, revoked/expired credentials,
cross-tenant IDs, enumeration, oversized requests, approval replay, callback
confusion, secret leakage, audit integrity, and rate/resource exhaustion.

Real deployment verification must include proxy/TLS/header behavior and secret
rotation. Unit guards alone are insufficient.

## Scheduling decision

This requirement remains cross-cutting and unnumbered until the PO/BA chooses the
deployment/tenant model. It must be scheduled before any milestone claims an
externally exposed sensitive surface. Sol may issue a dedicated implementation
milestone once that product choice exists.
