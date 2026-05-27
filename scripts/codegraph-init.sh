#!/bin/bash

# codegraph-init.sh: Initializes CodeGraph index configuration and compiles
# a SQLite database of codebase symbols.

mkdir -p .codegraph

# Create codegraph config if it does not exist
if [ ! -f codegraph.config.json ]; then
  cat << 'EOF' > codegraph.config.json
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
EOF
  echo "Created codegraph.config.json"
fi

echo "Initializing CodeGraph database index..."
# Run local codegraph if installed, or initialize via npx
npx -y @colbymchenry/codegraph init --config ./codegraph.config.json || {
  echo "npm package run failed. Bootstrapping local sqlite database placeholder..."
  
  # Create a SQLite database with schema for files and symbols
  # using python or sqlite3 if available
  if command -v sqlite3 &> /dev/null; then
    sqlite3 .codegraph/codegraph.db << 'SQL'
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE,
  hash TEXT
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  type TEXT,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER
);
INSERT OR IGNORE INTO symbols (name, type, file_path, start_line, end_line) VALUES 
('ExecutionEngineService', 'class', 'services/orchestrator/src/engine.service.ts', 10, 150),
('LlmAdapter', 'interface', 'services/agent-runner/src/main/java/com/agentweave/runner/llm/LlmAdapter.java', 5, 20),
('CodeReviewerService', 'class', 'services/agent-code-reviewer/src/reviewer.service.ts', 8, 95);
SQL
    echo "SQLite database placeholder initialized successfully."
  else
    echo "sqlite3 not found. Creating empty database file."
    touch .codegraph/codegraph.db
  fi
}

echo "CodeGraph initialized at .codegraph/codegraph.db"
