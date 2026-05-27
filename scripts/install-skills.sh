#!/bin/bash

# install-skills.sh: Downloads or installs agentic skill markdown files 
# from the antigravity-awesome-skills repository.

mkdir -p skills

echo "Installing skills via npx @sickn33/antigravity-awesome-skills..."
# Try executing npm command to download packages, allow failure if offline
npx -y @sickn33/antigravity-awesome-skills init --dir ./skills || {
  echo "npm package download failed or timed out. Fetching key skills directly from GitHub..."
  
  # Download key skills from GitHub using curl
  curl -s -o skills/security-review-basic.md https://raw.githubusercontent.com/sickn33/antigravity-awesome-skills/main/skills/security/security-review-basic.md
  curl -s -o skills/observability-guidelines.md https://raw.githubusercontent.com/sickn33/antigravity-awesome-skills/main/skills/observability/observability-guidelines.md
  curl -s -o skills/code-quality-rules.md https://raw.githubusercontent.com/sickn33/antigravity-awesome-skills/main/skills/development/code-quality-rules.md
  
  echo "Fallback direct download completed."
}

# Ensure we have local mock skill files if curl downloads failed (are small or contain 404)
for file in security-review-basic.md observability-guidelines.md code-quality-rules.md; do
  if [ ! -f "skills/$file" ] || [ $(wc -c < "skills/$file") -le 100 ]; then
    rm -f "skills/$file"
  fi
done

if [ ! -f skills/security-review-basic.md ]; then
  cat << 'EOF' > skills/security-review-basic.md
# Skill: Basic Security Review
- Regex match for secrets: AWS, Stripe, GitHub, generic Private Keys.
- Scan for hardcoded URLs or database credentials.
- Check for SQL injection vulnerabilities by checking for direct string interpolation in SQL calls.
- Inspect routes to verify if JWT authentication guards are applied.
EOF
fi

if [ ! -f skills/observability-guidelines.md ]; then
  cat << 'EOF' > skills/observability-guidelines.md
# Skill: Observability Diagnostics
- Check log line structure: timestamp, level (ERROR/WARN/INFO), service name, trace ID.
- Scan for stack trace blocks and extract primary failure line.
- Check Redis key expirations and verify timeout watchdogs.
- Identify performance bottle-necks by logging elapsed durations.
EOF
fi

if [ ! -f skills/code-quality-rules.md ]; then
  cat << 'EOF' > skills/code-quality-rules.md
# Skill: Code Quality Rules
- Validate camelCase naming conventions for TypeScript files.
- Ensure all public functions have descriptive docstrings.
- Check for async functions without corresponding try/catch blocks.
- Highlight unused imports or variables.
EOF
fi

echo "Skills installation done! Saved to ./skills directory."
