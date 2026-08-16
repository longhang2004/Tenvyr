---
title: "Tenvyr Productization Current-Research Register"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/architecture/executors/native-integrations.md
  - docs/product/principles.md
  - docs/plans/active/tenvyr-productization-roadmap/ROADMAP.md
---

# Current-research register

External integrations are versioned assumptions. Recheck official primary sources
at implementation time and record the access date and selected version in the
milestone report. Research may block one adapter without weakening the
framework-neutral milestone core.

## Allowed documented surfaces as of 2026-08-15 (P2 model-selection recheck)

| Area                    | Planning boundary and primary sources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex            | `codex exec --model <id>` (alias `-m`) is the documented invocation model override; `codex login status` is the documented auth-status command; `codex debug models` prints the raw model catalog as JSON but is EXPERIMENTAL — best-effort discovery only, execution never depends on it; `codex login` is the official sign-in. Rechecked 2026-08-15. [CLI reference](https://learn.chatgpt.com/docs/codex/developer-commands?surface=cli), [commands](https://learn.chatgpt.com/docs/codex/reference/commands).                                                                                                                                    |
| Claude Code / Agent SDK | `claude --model <alias-or-full-id>` (e.g. `claude --model claude-sonnet-5`) is the documented model selector; `claude auth login` / `claude auth status` are the documented auth commands; there is NO documented model-list CLI — manual model ID entry / Runtime default only. `--fallback-model` exists inside the runtime (documented as outside Tenvyr's model-selection authority; Tenvyr itself never falls back). Rechecked 2026-08-15. [CLI reference](https://code.claude.com/docs/en/cli-reference), [third-party login guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account#developers). |
| OpenCode                | `opencode run --model provider/model` is the documented model selector; `opencode models [provider]` lists the catalog in `provider/model` format; `opencode models --refresh` refreshes from models.dev; `opencode auth login` is the official sign-in. Provider state uses the STRUCTURED Server API (`opencode serve`: GET /provider, /provider/auth, oauth authorize/callback; basic auth via OPENCODE_SERVER_PASSWORD; 127.0.0.1) — TUI auth-list output is NEVER parsed; model enumeration uses the documented `opencode models [provider]` CLI through the exact connection profile. Tenvyr NEVER reads `~/.local/share/opencode/auth.json`. Rechecked 2026-08-16. [Server API](https://opencode.ai/docs/server/), [CLI](https://opencode.ai/docs/cli/), [providers](https://opencode.ai/docs/providers/). |
| 9Router                 | Product UX INSPIRATION ONLY — explicitly NOT a Tenvyr product concept (Technical Lead audit, 2026-08-16). No routing/fallback/quota/combo/alias/account machinery is or will be copied; Tenvyr never sends inference through it. An existing 9Router instance is connectable only as the generic OpenAI-compatible endpoint (advanced surface). |

## Allowed documented surfaces as of 2026-08-12

| Area                    | Planning boundary and primary sources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex            | Use documented non-interactive `codex exec`, JSONL/result/schema outputs, and official authentication. Local authenticated CLI or documented API-key/access-token automation only; never inspect or copy cached session state. [Authentication](https://learn.chatgpt.com/docs/auth), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).                                                                                                                                 |
| Claude Code / Agent SDK | Local Claude Code is a trusted local runtime. Product/team automation prefers `ANTHROPIC_API_KEY`, supported WIF/cloud credentials, and Agent SDK hooks/cancellation/bounds inside a Worker. Anthropic's current third-party-login rule forbids offering Claude consumer login or subscription limits without approval. [Claude Code IAM](https://code.claude.com/docs/en/iam), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [third-party login guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account#developers). |
| OpenCode                | Invoke OpenCode as a runtime and let it own providers/auth. Tenvyr records connection/executor identity, not provider accounts. [CLI](https://opencode.ai/docs/cli/), [providers](https://opencode.ai/docs/providers/), [commands](https://opencode.ai/docs/commands/).                                                                                                                                                                                                                                                                                                           |
| MCP                     | Prefer current official protocol for runtime tool/context interoperability. Policy can only claim interception at observable configured boundaries. Record server/tool/version metadata in Capsule provenance without model reasoning. Version negotiation is required because ecosystem adoption may lag the current breaking release. [Specification](https://modelcontextprotocol.io/specification/2026-07-28), [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).                                                                 |
| A2A                     | Treat a remote agent as an executor/delegation target through current open protocol semantics; do not expose Tenvyr's storage protocol. Version negotiation, task identity, auth, streaming, cancellation, and artifact mapping require a dedicated compatibility plan. [Specification](https://a2a-protocol.org/latest/specification/), [project releases](https://github.com/a2aproject/A2A/releases).                                                                                                                                                                          |
| OpenTelemetry           | Use OTLP/SDK/exporter standards only as projection. Pin semantic-convention versions and isolate exporter failure. [OTLP](https://opentelemetry.io/docs/specs/otlp/), [GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).                                                                                                                                                                                                                                                                                                                                   |
| UX references           | Study runtime/account discovery, status, quota, switching, and test-connection ergonomics only. Do not copy provider-router architecture. [9router](https://github.com/decolua/9router), [cockpit-tools](https://github.com/jlcodes99/cockpit-tools).                                                                                                                                                                                                                                                                                                                             |

## Implementation-time checklist

1. Record official URL, access date, product/CLI/SDK/spec version, supported auth,
   lifecycle, cancellation, events, structured output, and documented limits.
2. Create an allowed-API list and an explicit unsupported/deprecated list before
   adapter code. Copy documented invocation patterns; do not invent flags.
3. Keep provider SDKs/auth inside runtime applications or trusted connection
   resolution. Core receives secret references and capabilities, never provider
   prompt/inference logic.
4. Gate live credential tests explicitly; deterministic conformance must remain
   runnable without vendor accounts.
5. Treat 9router/cockpit quota/account behavior as UX research, not a requirement
   for multi-account consumer subscription routing.

## M8 slice 4 recheck (2026-08-12, live fetches)

Official pages re-fetched and quoted for the runtime profile templates in
`services/orchestrator/src/executors/runtime-profiles.ts`:

| Runtime | Pinned version (source) | Confirmed documented surface | Explicitly unsupported / not documented |
| ------- | ----------------------- | ---------------------------- | --------------------------------------- |
| Codex CLI | 0.147.0 (`github.com/openai/codex` release `rust-v0.147.0`, 2026-08-07) | `codex exec --json` (newline-delimited JSON events), `--ephemeral`, `-o/--output-last-message`, `--output-schema`, `--sandbox read-only\|workspace-write\|danger-full-access`; `codex login status` ("print the active authentication mode and exit with 0 when logged in"); `codex login --with-api-key` / `--with-access-token` (stdin) / `--device-auth`; `--ask-for-approval untrusted\|on-request\|never` | `codex --version` is NOT documented (version output absent from setup/auth/developer-commands/non-interactive pages); `--full-auto` is a deprecated compatibility flag ("prefer `--sandbox workspace-write`"); `--dangerously-bypass-approvals-and-sandbox/--yolo`; no documented exec cancel RPC |
| Claude Code | 2.1.228 (npm `@anthropic-ai/claude-code@latest`; docs reference ≥v2.1.227) | `claude --version`/`-v` ("output the version number"); `claude auth status` ("Show authentication status as JSON ... exits with code 0 if logged in, 1 if not"); `claude auth login [--console]`, `claude auth logout`; headless `claude -p "<prompt>"`, `--output-format json` | Consumer subscription login through third-party products (official rule); Agent SDK OAuth not documented; `claude auth status --text` (human output, not the probe) |
| OpenCode | 1.18.16 (`github.com/sst/opencode` release) | `opencode --version`/`-v` ("print version number"); `opencode run [message..]` with `--format json` ("raw JSON events"); `opencode auth login/logout/list` | Provider auth is runtime-owned; `opencode auth list` is discovery, not a Tenvyr auth probe |

Live non-billable gates (2026-08-12): installed `codex`, `claude` (2.1.97),
and `opencode` (1.18.16) ran their documented version/auth-status probes with
bounded secret-free outcomes. Detected versions are evidence; the pins are
the versions each template was written and tested against.
