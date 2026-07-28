---
title: Optional Persistent Memory Tooling
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
  - .agents/skills/how-it-works/SKILL.md
  - .agents/skills/mem-search/SKILL.md
  - services/gateway/src
  - services/orchestrator/src
---

# Optional persistent memory tooling

`claude-mem` is third-party local developer tooling that may be supplied by an agent environment. It is not part of the Tenvyr runtime, package graph, or deployment architecture.

When installed, its own checked-in skill documentation says observations, summaries, SQLite data, vector index, logs, and settings live under `~/.claude-mem` on the developer machine. Provider calls used by that tool remain governed by the developer's external configuration. Installation, operation, retention, and deletion are therefore outside Tenvyr service ownership.

## Current runtime boundary

The inspected Gateway and Orchestrator sources do not expose an `AgentMemory` API, memory adapter, vector-memory database, or semantic retrieval endpoint. Pipeline agents do not automatically receive `claude-mem` observations. Do not design application behavior that depends on the local tool being installed.

Repository-provided memory-related skills describe how a compatible developer environment can search prior coding sessions. They are agent instructions, not production APIs.

Runtime memory, durable provenance, artifact lineage, and associated privacy/retention policy remain future work. See the [observability and provenance roadmap](../../roadmap/observability-provenance.md) for planned direction; a roadmap entry does not establish current behavior.
