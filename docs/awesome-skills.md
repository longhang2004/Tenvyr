# Awesome Skills Integration (docs/awesome-skills.md)

[antigravity-awesome-skills](https://github.com/sickn33/antigravity-awesome-skills) is a structured catalog containing over 1,400 reusable AI agent skills, prompts, and behavioral instructions.

---

## 🚀 Why Use Awesome Skills in AgentWeave?

In `AgentWeave`, developers write multi-agent pipelines composed of specialized agents (e.g. `code-reviewer`, `observability`, `security`). Designing optimized prompt templates for each agent is difficult.

By integrating `antigravity-awesome-skills`, we can:
1.  Pull expert-level instructions into our agent definitions (for example, importing security review guidelines into `services/agent-code-reviewer`).
2.  Provide localized `.clauderules` / `.cursorrules` to instruct the developer's local agent on how to write code for AgentWeave itself.

---

## 🛠️ Usage Instructions

### 1. Installation & Downloader
To download/update awesome skills into the local repository, run:
```bash
pnpm skills:install
```
This runs the helper script [install-skills.sh](file:///Users/longhang/personal_repos/AgentWeave/scripts/install-skills.sh). The script creates a local `skills/` folder containing downloaded instruction templates.

### 2. Custom Agent Prompt Templates
The `agent-runner` service loads prompts dynamically. We map skills directly to our prompt templates under `services/agent-runner/src/main/resources/prompts/`.

*Example Prompt Import:*
```yaml
# services/agent-runner/src/main/resources/prompts/code-reviewer.yaml
name: code-reviewer
systemPrompt: |
  # Static Code review rules
  (Copied from skills/security-review-basic.md)
  Analyze code for hardcoded secrets, SQL injection, and uncaught exceptions...
```
This ensures prompt definitions are robust and sourced from community best practices.
