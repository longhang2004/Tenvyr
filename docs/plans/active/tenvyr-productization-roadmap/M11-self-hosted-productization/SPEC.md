---
title: "M11 Specification: Single-Owner Self-Hosted Productization"
status: planned
audience:
  - developer
  - operator
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M11-self-hosted-productization/PLAN.md
  - docs/operations/configuration.md
  - docs/architecture/executors/local-executor-host.md
  - docs/reference/implementation-status.json
---

# M11 Single-owner self-hosted productization specification

## Supported deployment contract

One owner controls one host/private environment, operating one Tenvyr control plane
and PostgreSQL authority with configured runtime connections. The supported Docker
profile pins/test-documents versions, ports/bindings, persistent volumes, startup
order, health/readiness, resource expectations and upgrade path. Kafka/Redis/Java
services are included only where the chosen profile actually needs them.

This profile assumes trusted host administration and trusted configured local
runtimes. It is not tenant isolation, a security sandbox, HA, or internet-safe by
default. Services bind privately/loopback unless the operator explicitly configures
a reviewed private reverse proxy.

## Configuration and secrets

Bootstrap validates required configuration and creates references/templates, never
live checked-in secrets. Separate control-plane DB/callback/runtime credentials;
apply minimum environment allowlists; redact values from commands, logs, receipts,
health and Capsules. Document ownership, creation, storage outside source, rotation,
revocation and post-restore replacement for every secret class.

Local CLI authentication remains runtime-owned machine state and must be reconnected
explicitly after host migration where required. Backups never promise to capture
external provider sessions.

## Data and lifecycle

PostgreSQL contains execution authority and must be in every supported backup.
Inventory configuration, connection revisions, plans, attempts, inbox/outbox,
events, policy/budget/approval, coordination state, artifacts-as-references, and
Capsule export pins. External artifact bytes and runtime auth are excluded unless a
future capability owns them.

Upgrade sequence: preflight supported source/target version and free resources;
quiesce or document live-upgrade behavior; create verified backup; apply ordered
migrations once; run readiness and data invariants; resume. A failed migration must
stop unhealthy and preserve backup/diagnostics. Rollback is supported only where
schema/application compatibility is explicitly proven; otherwise restore is the
documented recovery.

## Backup and restore

Backup is consistent, encrypted/permissioned by operator procedure, checksummed,
timestamped and version-labeled. Restore is tested into a clean isolated target,
runs schema/version checks, preserves immutable identities and audit facts, rotates
deployment secrets, reconnects runtimes, and proves a pre-backup Capsule/execution
plus a post-restore new run. A backup command without a restore drill is not support.

## Health and diagnostics

Health distinguishes liveness, readiness, migration required/failed, PostgreSQL,
required transport, disk/resource pressure, and Runtime Connection state. It returns
safe reason codes, not secrets or raw errors. Optional runtime unavailability may
degrade specific teams without falsely making the control plane healthy for them.
Diagnostics are bounded and operator-triggered.

## Resource and failure behavior

Document CPU/memory/disk estimates and enforce existing request/output/graph/team
bounds. Warn/fail closed on insufficient disk for migration/backup. Shutdown stops
new work, follows current graceful semantics, and preserves accepted responsibility.
Restart uses outbox/inbox, watchdog, coordination and local-host recovery. No claim
of exactly-once runtime execution or zero-downtime upgrade.

## Compatibility and examples

Preserve legacy protocol identifiers, existing development Compose behavior and
source release limitations. Provide a clean single-host install, upgrade from the
last supported version, backup/restore, connection setup and incident examples.

## Non-goals

No public/multi-user authorization, SaaS tenancy, Kubernetes, HA, sandbox, provider
credential backup, artifact-byte backup, telemetry backend, or package publication.
