---
title: Roadmap
status: planned
audience:
  - developer
  - product
last_verified: 2026-07-28
sources:
  - docs/roadmap/observability-provenance.md
  - docs/plans/active/tenvyr-productization-roadmap/ROADMAP.md
  - docs/reference/implementation-status.md
---

# Roadmap

Roadmap documents describe intended work, not current runtime guarantees. Check the [implementation status ledger](../reference/implementation-status.md) and current architecture or operations documentation before relying on a capability.

## Status legend

- `implemented`: source and executable tests prove current behavior; details belong in architecture or the status ledger.
- `partial`: a useful subset exists, but the named capability is not complete.
- `planned`: direction is recorded without a current implementation guarantee.
- `blocked`: progress depends on an explicit owner, legal, infrastructure, or release decision.
- `historical`: retained context, not current direction or behavior.

## Current roadmap

- [M8–M11 productization roadmap](../plans/active/tenvyr-productization-roadmap/ROADMAP.md)
  — accepted execution sequence for Runtime Connections, Supervised Agent Team
  Execution, the Operator Workbench, and single-owner self-hosting.
- [Observability, provenance, and product differentiation](observability-provenance.md)
  — older thematic research. Implemented portions are superseded by M0–M7 truth;
  remaining themes are discovery inputs, not a competing execution sequence.

Plans and historical records may explain why a direction was chosen, but they do not override contracts, production code, tests, or current documentation.
