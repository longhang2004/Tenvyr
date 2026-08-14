---
title: "M11 Plan: Single-Owner Self-Hosted Productization"
status: planned
audience:
  - product
  - developer
  - operator
last_verified: 2026-08-12
sources:
  - docs/operations/local-development.md
  - docs/operations/configuration.md
  - docker-compose.yml
  - docs/plans/active/tenvyr-productization-roadmap/EXTERNAL_PRODUCTION_EXPOSURE_GATE.md
---

# M11 Single-owner self-hosted productization plan

## Product outcome

A design partner can install, configure, upgrade, back up, restore, health-check,
and operate the M10 wedge on one owner-controlled host using supported Docker-based
profiles and explicit trusted-runtime/secret boundaries.

## Problem being solved

The showcase proves development behavior but is not a supported lifecycle. Adoption
requires repeatable bootstrap and recovery, not Kubernetes theater or an implied
secure public service.

## Existing capabilities reused

Docker Compose/showcase, ordered PostgreSQL migrations, health endpoints, setup
check, configuration docs, package verification, local Runtime Connections,
Execution Capsules and current backupable PostgreSQL authority.

## Missing capabilities

Supported deployment profile and version matrix, configuration/secret bootstrap,
preflight, migration/upgrade/rollback rules, database backup/restore drill, runtime
connection setup, health/readiness/diagnostics, resource bounds, TLS/reverse-proxy
guidance for private deployment, incident/recovery runbook and release evidence.

## Dependencies

Closed M10 plus recorded design-partner deployment evidence. This milestone selects
deployment model A only: single-owner local/self-hosted. It does not close shared
organization, private-cloud team, or multi-tenant exposure semantics.

## Engineering slices

1. Contract: freeze supported single-host topology, platform/version prerequisites,
   trust boundaries, data/secret inventory, resource ceilings and support matrix.
2. Bootstrap: one documented Docker profile, generated local configuration/secret
   references without checked-in values, health/preflight and Runtime Connection
   setup. Reuse Compose; no orchestrator installer framework.
3. Upgrade/recovery: migration preflight, backup, upgrade, failure behavior,
   rollback compatibility boundary, restore to a clean host and Capsule integrity.
4. Operations: readiness/degraded status, log redaction, disk/DB growth guidance,
   orphan/runtime recovery, credential rotation/revocation, shutdown and incident
   runbook; optional reverse proxy guidance without internet-safe claim.
5. Closure: fresh-host and upgrade-from-prior tests, repeated restore drill, docs/
   identity/release evidence and design-partner installation feedback.

## Product-impacting alternatives

Chosen: Docker Compose on one controlled host. Helm/Kubernetes, HA control plane,
multi-region, and managed SaaS remain discovery-gated. Object-store artifacts and
wired observability are independent capabilities, not hidden deployment work.

## Risks

Destructive migration/restore, secret defaults, accidental public binding,
unsupported upgrade paths, backup missing authoritative data, runtime auth tied to
one machine, disk/artifact/log exhaustion, Docker/platform drift, unclear ownership,
false high-availability claim and operational burden beyond design-partner needs.

## Research-required items

Validate current supported Docker/Compose/PostgreSQL versions and platform behavior
at implementation time. Select reverse-proxy/TLS guidance only from supported vendor
docs. Kubernetes research requires separate discovery evidence.

## Explicit non-goals

No multi-tenant SaaS, team RBAC, public internet security claim, Kubernetes/Helm,
multi-region/HA, managed database mandate, proprietary secret manager, object store,
microVM sandbox, OTLP backend, auto-update daemon or package publication.

## Closure definition

Sol may close M11 only after fresh install, real upgrade, backup/restore to a clean
environment, runtime reconnection, migration failure recovery, secret/redaction and
private-binding review pass from current supported artifacts; docs clearly state
single-owner scope and the external exposure gate remains explicit.

# Milestone handoff

## What was delivered

## User/operator value

## How it works

## Guarantees

## Known limitations

## Architecture decisions

## What this unlocks

## Verification summary

## Recommended next milestone
