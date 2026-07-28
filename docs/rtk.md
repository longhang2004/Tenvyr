# Rust Token Killer (docs/rtk.md)

[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is a high-performance proxy command-line tool written in Rust. It intercepts shell command outputs (like `git status`, `git diff`, `docker logs`) and filters out boilerplate or redundant details to reduce the token counts before they are consumed by LLMs.

---

## 🚀 Why Use RTK in Tenvyr?

In distributed systems, outputs of tools like `docker compose logs` or Maven build failures (`mvn compile`) can easily exceed 100,000 characters. Passing these raw logs to AI coding assistants quickly exhausts context windows and runs up high API bills.

`RTK` compresses these outputs by 60–90% by:

1.  Stripping stack trace paths that are outside the project.
2.  Collapsing repetitive logs (e.g. repeated Kafka connection warnings).
3.  Truncating middle lines of large arrays or listings.

---

## 🛠️ Usage Instructions

### 1. Installation

If RTK is installed on your local machine:
Make sure the `rtk` executable is in your PATH.

### 2. Compression Script Wrapper

To run commands through compression, you can use the monorepo helper script [rtk-compress.sh](../scripts/rtk-compress.sh). It accepts any shell command and pipes its output through RTK (or a lightweight fallback filter if RTK is not installed locally).

_Example Command:_

```bash
# Compresses git diff before reading
./scripts/rtk-compress.sh git diff
```

### 3. Log Analytics Filtering

In `services/agent-observability`, when logs are collected from containers to be analyzed by the agent:

```typescript
import { execSync } from "child_process";

function fetchAndCompressLogs(containerName: string): string {
  // Execute via RTK wrapper to save token usage during LLM diagnosis
  return execSync(
    `./scripts/rtk-compress.sh docker logs ${containerName} --tail 200`,
  ).toString();
}
```

This ensures the observability agent is extremely cost-efficient and only focuses on anomalous log lines.
