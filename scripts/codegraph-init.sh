#!/bin/bash

set -euo pipefail

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
if [ -f .codegraph/codegraph.db ]; then
  npx -y @colbymchenry/codegraph index --force .
else
  npx -y @colbymchenry/codegraph init -i .
fi

echo "CodeGraph initialized at .codegraph/codegraph.db"
npx -y @colbymchenry/codegraph status .
