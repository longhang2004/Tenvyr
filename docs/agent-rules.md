# Agent Rules and Mechanics (docs/agent-rules.md)

This file contains the definitive guide for AI agents (Codex, Cursor, Claude, Kiro, Antigravity) working in the **AgentWeave** monorepo. It establishes the "rules of engagement" to maximize execution performance, minimize API token costs, and maintain architectural consistency.

---

## 🧭 Core Directives (Karpathy-Inspired)

AI agents are prone to failure modes such as "hallucination loops", "context overflow amnesia", and "mass file rewrites". To mitigate this:

### 1. The "Think-Before-Code" Ceremony
*   **Rule:** Before modifying any file, the agent must declare its design assumptions, trace the affected dependencies, and check if the change requires updating databases or configurations.
*   **Action:** Write a brief structured paragraph in your thoughts detailing:
    *   What function/class is being edited.
    *   Where its dependencies are defined (linked using markdown file links).
    *   What side effects are expected.

### 2. Surgical, Contiguous Edits
*   **Rule:** Never rewrite entire source code files if you are only changing a few lines or a single block.
*   **Action:** Always prefer `replace_file_content` for single contiguous edits and `multi_replace_file_content` for multiple non-contiguous edits. DO NOT overwrite files unless creating a file from scratch.

### 3. Verification Protocol
*   **Rule:** Every code modification must be verified for syntax and run-time validity.
*   **Action:** Run local linters or build commands (`pnpm build`, `mvn clean compile`) to confirm changes do not break the project.

### 4. Rule-Documentation Loop (Mechanic Registration)
*   **Rule:** Whenever a new "mechanic" (a new agent, a new Kafka consumer, a new data store adapter, or a helper tool integration) is added to AgentWeave, the agent **MUST** update this file to document the new mechanic's rules.

---

## 🛠️ Registering a New Mechanic Checklist

Every time you add a new service, agent, or major architectural feature, you must perform these steps:

1.  **Update `CLAUDE.md`:** Add ports, glossary terms, or Kafka topic patterns introduced by the new feature.
2.  **Add System Rules to `docs/agent-rules.md`:** Add a section under "Registered Mechanics" explaining how the feature works, what interfaces it exposes, and guidelines for editing it.
3.  **Create Helper Scripts (if applicable):** Create automated tools in the `scripts/` directory to simplify setup, data fetching, or testing.
4.  **Register with CodeGraph:** Run `scripts/codegraph-init.sh` to update symbol references.

---

## 🔌 Integrated Agent Support Mechanics

The following external agent-support tools are integrated into this monorepo to optimize workflows:

### A. CodeGraph (Local Intelligence Graph)
*   **Purpose:** Indexes the monorepo into a SQLite database using tree-sitter. Agents query CodeGraph instead of running slow and expensive `grep` or file listings.
*   **Rule:** Check `docs/codegraph.md` for index commands and schema queries. Always query the CodeGraph when looking for symbol definitions.

### B. antigravity-awesome-skills (Structured Agentic Skills)
*   **Purpose:** Reusable agent guidelines (e.g. security audits, API design, maven packaging) stored as markdown files in the `skills/` folder.
*   **Rule:** Refer to `docs/awesome-skills.md`. Pull relevant skills using `pnpm skills:install` when working on specific domains.

### C. Claude-Mem (Cross-Session Memory)
*   **Purpose:** Local long-term memories stored via hybrid search. Solves the context loss when initiating new terminal or chat sessions.
*   **Rule:** See `docs/agent-memory.md` to learn how to store and fetch memories of architectural decisions.

### D. RTK (Rust Token Killer)
*   **Purpose:** Command proxy that intercepts large outputs and filters them. Reduces token waste from repetitive logs and status dumps by 60–90%.
*   **Rule:** Refer to `docs/rtk.md`. Run terminal outputs through `scripts/rtk-compress.sh` when returning output summaries.
