---
title: CodeGraph
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
  - codegraph.config.json
  - scripts/codegraph-init.sh
  - .gitignore
  - AGENTS.md
---

# CodeGraph

CodeGraph is optional local developer tooling for structural code search. It is not a Tenvyr runtime dependency, production service, or package build input.

## Initialize the local index

```bash
pnpm codegraph:init
```

The helper invokes `npx -y @colbymchenry/codegraph`, so first use or updates may require network access. It creates or refreshes `.codegraph/codegraph.db` and prints tool status. `.codegraph/`, `*.db`, and `*.sqlite` are ignored local artifacts and must not be packaged or committed.

## Checked-in scope

`codegraph.config.json` is authoritative for the repository helper. Its configured languages are exactly:

```json
["typescript", "javascript", "java"]
```

Python is not configured by the checked-in helper. A separately managed MCP server may report a different live index; do not infer Python coverage from that external state or describe it as repository configuration.

The config excludes dependency, build, and Git directories and enables watch mode. When an agent environment exposes CodeGraph MCP tools, prefer structural queries such as context, trace, callers, callees, and impact. Literal strings and generated text still belong in normal text search.

## Boundary

CodeGraph availability is optional. Builds, tests, services, Workers, and deployed applications do not read its database. If the external package, network, local database, or MCP integration is unavailable, use repository-native read-only search without changing production behavior.
