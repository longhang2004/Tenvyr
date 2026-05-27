# CodeGraph Integration (docs/codegraph.md)

[CodeGraph](https://github.com/colbymchenry/codegraph) is a local-first codebase intelligence tool. It indexes files, classes, methods, and variables into a SQLite database using tree-sitter, making it easily queryable by AI agents.

---

## 🚀 Why Use CodeGraph in AgentWeave?

AI agents (like Cursor, Claude, and Codex) consume valuable tokens when performing search operations like `grep`, `find`, or raw file reading to locate functions or structures. 

By building a local graph of `AgentWeave`'s files and symbols, agents can query CodeGraph via SQL or JSON parameters to immediately resolve:
*   Where a specific class is implemented (e.g. `LlmAdapter` in Spring Boot).
*   Which services consume/produce a specific Kafka topic.
*   The call tree of a method.

---

## 🛠️ Usage Instructions

### 1. Initialization
To initialize CodeGraph index for the AgentWeave monorepo, run:
```bash
pnpm codegraph:init
```
This executes the helper script [codegraph-init.sh](file:///Users/longhang/personal_repos/AgentWeave/scripts/codegraph-init.sh), which creates/updates the index database in `.codegraph/codegraph.db`.

### 2. Configuration
CodeGraph configurations are defined in `codegraph.config.json` at the root of the project:
```json
{
  "exclude": [
    "**/node_modules/**",
    "**/target/**",
    "**/.next/**",
    "**/.git/**"
  ],
  "languages": ["typescript", "javascript", "java"],
  "watch": true
}
```

### 3. Querying the Graph (For Agents)
Agents equipped with SQLite tools or MCP servers can run direct SQL queries on `.codegraph/codegraph.db` to inspect definitions without reading whole directories.

*Example Query:* Find where `ExecutionEngineService` is defined:
```sql
SELECT file_path, start_line, end_line 
FROM symbols 
WHERE name = 'ExecutionEngineService';
```
This saves token cost and execution time significantly.
