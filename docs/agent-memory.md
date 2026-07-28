# Agent Memory and Context (docs/agent-memory.md)

[claude-mem](https://github.com/thedotmack/claude-mem) is a persistent memory layer for AI agents. It captures observations, decisions, and tool usage across sessions, storing them in a local SQLite + vector database, preventing agent amnesia.

---

## 🚀 Why Use Claude-Mem in Tenvyr?

AI agents executing in terminal environments typically lose their context between command executions or chat resets. In `Tenvyr`, a long-running execution might crash or get cancelled. When restarting, developers/agents need to know the state of previous failures.

By integrating `claude-mem`, we provide:

1.  **Developer Memory:** Tracks changes and edits in the monorepo across terminal invocations.
2.  **Agent Session Memory:** A memory-adapter module in `services/gateway` and `services/orchestrator` that mimics `claude-mem` concepts, letting pipeline agents fetch long-term context about a target system via vector semantic search.

---

## 🛠️ Usage Instructions

### 1. Developer Tooling Installation

To initialize `claude-mem` for your local agent session when coding in this repo:

```bash
npx claude-mem install
```

This sets up the `.claude-mem` daemon to track commands and file operations in the background.

### 2. Conceptual Memory Engine in Tenvyr

In `services/gateway`, we define a Memory Adapter using the schema:

```typescript
interface AgentMemory {
  id: string;
  executionId: string;
  agentName: string;
  timestamp: Date;
  summary: string;
  keyInsights: string[];
  embedding?: number[]; // Vector embedding for semantic retrieval
}
```

When an agent completes a step (e.g. `observability` finds a memory leak), it publishes an event. The orchestrator indexes this summary into a central memory database.
On the next pipeline execution, agents can fetch past memories matching the project code symbols to gain pre-existing context:

```json
{
  "query": "Memory leak findings",
  "limit": 3
}
```

This drastically improves efficiency by avoiding redundant LLM diagnostics.
