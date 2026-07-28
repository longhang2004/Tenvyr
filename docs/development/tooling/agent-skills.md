---
title: Local Agent Skills
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
  - package.json
  - scripts/install-skills.sh
  - .gitignore
---

# Local agent skills

Agent skills are optional instruction files for developer-operated coding agents. They are not Tenvyr runtime plugins and are not automatically injected into Agent Runner prompts.

## Install or refresh

```bash
pnpm skills:install
```

The command runs `scripts/install-skills.sh` and writes into `skills/`. Its primary path invokes `npx -y @sickn33/antigravity-awesome-skills`, so it may download packages from the network. If that fails, the script attempts direct `curl` downloads for three files and finally creates small local fallback instructions when downloaded files are absent or invalid.

The guaranteed fallback filenames are:

- `skills/security-review-basic.md`
- `skills/observability-guidelines.md`
- `skills/code-quality-rules.md`

Review third-party or generated instructions before using them. Running the installer can replace those fallback files and is not required to build or test Tenvyr.

## Runtime boundary

No inspected Gateway, Orchestrator, Worker, specialized-agent, or Java Agent Runner source loads `skills/` dynamically. A developer may manually adapt an instruction into a reviewed prompt, but the file is not active merely because it exists. Dynamic runtime skill discovery and community-skill execution are not implemented.
