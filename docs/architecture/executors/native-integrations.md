---
title: Native and Remote Integration Research (M3-S4)
status: current
audience:
  - developer
  - product
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/RESEARCH_REGISTER.md
  - docs/architecture/executors/local-executor-host.md
---

# Native and remote integration compatibility matrix

Official-source research performed 2026-08-11. Every claim below comes from
the official primary sources fetched that day (URLs listed in the research
register and the M3-S4 receipt under `docs/_scratch/tenvyr-roadmap/`):

- Codex: `https://developers.openai.com/codex/non-interactive-mode`,
  `https://developers.openai.com/codex/codex-sdk`,
  `https://developers.openai.com/codex/developer-commands`,
  `https://developers.openai.com/codex/auth`,
  `https://github.com/openai/codex/releases` (CLI 0.147.0, 2026-08-07).
- Claude Agent SDK: `https://code.claude.com/docs/en/agent-sdk/quickstart.md`,
  `.../typescript.md`, `.../python.md`,
  `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest`.
- A2A: `https://a2a-protocol.org/latest/specification/`,
  `https://github.com/a2aproject/A2A/releases` (v1.0.0 2026-03-12,
  v1.0.1 2026-05-26).
- DeepSeek: `https://api-docs.deepseek.com/`,
  `https://api-docs.deepseek.com/api/create-chat-completion`.

Rules applied: official primary sources only, no undocumented flags, no
session scraping, no provider SDK in Orchestrator or Worker core, credentials
are trusted references never embedded in pipeline definitions or evidence.

## Decisions

| Integration      | Verdict                                   | Integration mode                                                                                                                                                                 | Auth (documented)                                                                                                          | Lifecycle via documented API                                                                                                                                                                                                                                                              | Status                                                                                                                                                         |
| ---------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex CLI | SUPPORTED as an executor command          | `codex exec` (headless) run as a FIXED command under the approved [local executor host](./local-executor-host.md)                                                                | `CODEX_API_KEY` per run; `codex login --with-api-key` / `--device-auth` (beta); `~/.codex/auth.json` is a plaintext secret | invoke ✅ (`codex exec`), events ✅ (`--json` JSONL), result ✅ (`-o` / `--output-schema`), resume ✅ (`exec resume --last`); cancel ⚠️ process-level only (no documented exec cancel), timeout ❌ none documented — the host wall clock and process-group kill are the executor boundary | documented, not exercised (no credentials here)                                                                                                                |
| Claude Agent SDK | SUPPORTED as a runtime worker application | `@anthropic-ai/claude-agent-sdk` v0.3.227 (TS) / `claude-agent-sdk` v0.2.135 (PyPI); headless by default; the SDK stays INSIDE a runtime worker — never Orchestrator/Worker core | `ANTHROPIC_API_KEY` (env of the agent process); OAuth not documented for the SDK                                           | invoke ✅ `query()`, events ✅ stream + `includePartialMessages`, pre-side-effect gate ✅ `PreToolUse` hooks / `canUseTool` / `permissionMode`, cancel ✅ `Query.interrupt()` / abortController, timeouts ✅ `API_TIMEOUT_MS`, `max_turns`, `max_budget_usd`                              | documented, not implemented (no credentials; provider SDK belongs in a runtime app)                                                                            |
| A2A protocol     | DEFERRED                                  | A Tenvyr A2A executor transport is a canonical protocol extension                                                                                                                | spec v1.0.0 (2026-03-12; patch v1.0.1 2026-05-26): OAuth2/OIDC/mTLS declared in the Agent Card; no per-message signing     | complete: Task lifecycle, `SendMessage`, `SendStreamingMessage` (SSE), `SubscribeToTask`, push notifications, `CancelTask`, `GetTask`/`ListTasks`                                                                                                                                         | deferred — needs version/compatibility approval across contracts and both SDKs (SPEC: any canonical protocol extension requires it); does not block M3 closure |
| DeepSeek API     | SUPPORTED as runtime provider config      | OpenAI-compatible chat completions: `base_url=https://api.deepseek.com`, `POST /chat/completions`, SSE `data:` chunks + `data: [DONE]`                                           | `Authorization: Bearer <key>`                                                                                              | n/a (provider concern inside runtimes)                                                                                                                                                                                                                                                    | documented; current models `deepseek-v4-flash` / `deepseek-v4-pro` (legacy `deepseek-chat`/`deepseek-reasoner` retired 2026-07-24)                             |

## Codex CLI — documented invocation (executor command shape)

```bash
# prompt from stdin (context on stdin is the executor's bounded input channel)
cat prompt.md | codex exec - --json --ephemeral
codex exec --json --sandbox workspace-write "<task>"        # workspace edits
codex exec --ephemeral --json -o ./last-message.json "<task>"
CODEX_API_KEY=<key> codex exec --json "<task>"               # per-run API key
```

Executable under the local executor host as:

```json
{
  "command": "/absolute/path/to/codex",
  "args": ["exec", "--json", "--ephemeral", "-"],
  "secrets": { "CODEX_API_KEY": "CODEX_API_KEY" }
}
```

The host supplies the wall clock (no documented Codex run timeout) and
process-group kill (no documented `codex exec` cancel). Unsupported /
undocumented surface to never rely on: any `--timeout` flag, exec cancel RPC,
`--full-auto` (removed in CLI 0.147.0), `chatgptAuthTokens` and the app-server
WebSocket transport (labeled experimental by OpenAI).

## Claude Agent SDK — documented executor-relevant surface

- invoke: `query({ prompt, options })` (TS) / `async for message in query(...)` (PyPI);
  `startup()` pre-warms the bundled Claude Code subprocess.
- pre-side-effect gate: `PreToolUse` hooks with `permissionDecision: deny|ask`,
  `canUseTool`, `permissionMode` — blocking a tool prevents its execution
  (documented: "Block dangerous operations before they execute").
- cancel: `Query.interrupt()` / `Options.abortController` / `Query.close()`.
- events: per-message stream, `includePartialMessages`, `api_retry`.
- bounds: `max_turns`, `max_budget_usd`, `API_TIMEOUT_MS`, hook timeouts.
- auth: `ANTHROPIC_API_KEY` (env of the agent process).

## A2A v1.0 — why deferred

The spec (normative `a2a.proto`) is complete: Task lifecycle with
`SUBMITTED/WORKING/COMPLETED/FAILED/CANCELED/REJECTED/INPUT_REQUIRED/AUTH_REQUIRED`,
client-supplied idempotent `messageId`s, SSE streaming, push notifications,
`CancelTask`, version negotiation via `A2A-Version: 1.0`. Adding an A2A
transport to Tenvyr means a new canonical transport kind with contract and
both-SDK version compatibility — a protocol change needing explicit
approval; recorded and deferred. Auditability is not a protocol feature: it
must be built client-side (task/message ids, ISO-8601 timestamps).

## DeepSeek — runtime configuration only

Official docs: "By modifying the configuration, you can use the OpenAI/Anthropic
SDK ... to access the DeepSeek API." Base URL + API key + model identifier are
the only configuration; the wire format is OpenAI-identical. Model names are
`deepseek-v4-flash` and `deepseek-v4-pro` (legacy names retired 2026-07-24);
`thinking` / `reasoning_effort` are documented extensions beyond OpenAI. This
stays a Worker/runtime configuration concern — no Orchestrator change.

## M8 runtime connection profiles (rechecked 2026-08-12)

The M8 connection templates in
`services/orchestrator/src/executors/runtime-profiles.ts` re-fetched the
official pages on 2026-08-12 and pin: Codex CLI `0.147.0` (release
`rust-v0.147.0`), Claude Code `2.1.228` (npm latest), OpenCode `1.18.16`
(release). New findings vs the 2026-08-11 research above:

- `codex --version` is NOT documented (absent from setup/auth/
  developer-commands/non-interactive pages) — the Codex profile probes
  `codex login status` ("exit with 0 when logged in") instead, and the
  pinned version is operator-declared.
- `--full-auto` is a deprecated compatibility flag ("prefer
  `--sandbox workspace-write`"); the profile never uses it.
- `claude auth status` is documented to exit 0 when logged in and 1 when
  not (JSON output, never parsed by Tenvyr); `claude --version`/`-v` is
  documented.
- `opencode --version`/`-v` and `opencode run --format json` are
  documented; provider auth stays runtime-owned.
- Live non-billable gates ran 2026-08-12 against the installed CLIs
  (installed Claude Code was 2.1.97, older than the pin): version and
  auth-status probes completed with bounded, secret-free outcomes. The
  runtime connection status is projection, not dispatch authority.
