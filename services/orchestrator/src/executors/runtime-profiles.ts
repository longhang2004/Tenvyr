import type {
  CliProbeConfigV1,
  CliProfileV1,
  ConnectionCapabilities,
  ConnectionProfileV1,
  CredentialReference,
  RuntimeKind,
} from "./runtime-connection";

/**
 * M8-S4: version-pinned Codex, Claude, and OpenCode runtime profiles.
 *
 * Every template is built ONLY from the official primary sources listed in
 * `docs/plans/active/tenvyr-productization-roadmap/RESEARCH_REGISTER.md`,
 * re-fetched 2026-08-12. The fixed run argv and probe argv use documented
 * flags only; anything undocumented or deprecated is recorded in
 * `unsupported` and never used. Credentials stay references (or runtime-
 * owned auth); probes never parse auth output.
 *
 * Templates are the CONFIGURED capability ceiling: an operator's connection
 * built from a template declares at most these capabilities, and detection
 * can only downgrade.
 */

export type RuntimeProfileTemplate = {
  runtimeKind: "codex" | "claude" | "opencode";
  /** Version the profile was written and tested against. */
  pinnedVersion: string;
  /** Official primary source(s) and access date. */
  sourceUrl: string;
  accessedAt: string;
  /** P2: the OFFICIAL runtime-owned login command for the guided Sign-in
   *  UX. Tenvyr never collects provider credentials; it only shows this
   *  fixed command for the operator to run in their own terminal. */
  loginCommand: string;
  /** Fixed run argv (documented flags only). */
  runArgs: string[];
  /** P2: FIXED argv elements inserted before a requested model id when the
   *  operator freezes a model for an attempt (e.g. ["--model"]). The host
   *  agent config mirrors this; the model id is appended as ONE bounded
   *  data element — never concatenated, never shell-interpreted. Empty =
   *  runtime default (no model argument). */
  modelArgvPrefix: string[];
  /** Primary probe: version probe when the CLI documents one, otherwise the
   *  documented auth-status command. */
  probe: CliProbeConfigV1;
  /** Optional documented auth-status probe run after the primary probe. */
  authProbe?: CliProbeConfigV1;
  /** Documented credential environment variable names (references). */
  credentialEnvRefs: string[];
  /** Explicitly unsupported/deprecated surface — never used. */
  unsupported: string[];
  /** Conservative capability ceiling from the documentation. */
  declaredCapabilities: ConnectionCapabilities;
};

export const CODECX_CLI_DOCS =
  "https://learn.chatgpt.com/docs/developer-commands?surface=cli";
export const CLAUDE_CLI_DOCS = "https://code.claude.com/docs/en/cli-reference";
export const OPENCODE_CLI_DOCS = "https://opencode.ai/docs/cli/";
export const RUNTIME_PROFILE_ACCESSED_AT = "2026-08-12";

export const RUNTIME_PROFILE_TEMPLATES: Record<
  "codex" | "claude" | "opencode",
  RuntimeProfileTemplate
> = {
  codex: {
    runtimeKind: "codex",
    pinnedVersion: "0.147.0",
    sourceUrl: CODECX_CLI_DOCS,
    accessedAt: RUNTIME_PROFILE_ACCESSED_AT,
    runArgs: ["exec", "--json", "--ephemeral", "-"],
    // P2: `codex login` is the documented runtime-owned sign-in command.
    loginCommand: "codex login",
    // P2 recheck 2026-08-15: `--model <id>` (alias `-m`) is the documented
    // invocation override ("Override the model set in configuration").
    modelArgvPrefix: ["--model"],
    // Version output is NOT documented for the Codex CLI; the documented
    // auth-status command is `codex login status` ("print the active
    // authentication mode and exit with 0 when logged in").
    probe: {
      args: ["login", "status"],
      authAnyNonZero: true,
    },
    credentialEnvRefs: ["CODEX_API_KEY"],
    unsupported: [
      "codex --version (version output is not documented; the pinned version is operator-declared)",
      "--full-auto (deprecated compatibility flag; prefer --sandbox workspace-write)",
      "--dangerously-bypass-approvals-and-sandbox / --yolo",
      "exec cancel RPC (none documented; the host wall clock and process-group kill are the executor boundary)",
      "~/.codex/auth.json inspection or copying (plaintext secret)",
    ],
    declaredCapabilities: {
      invocation: { supported: true, source: "configured", version: "0.147.0" },
      structuredResult: {
        supported: true,
        source: "configured",
        version: "0.147.0",
      },
      progressEvents: {
        supported: true,
        source: "configured",
        version: "0.147.0",
      },
      localProcessTermination: { supported: true, source: "configured" },
    },
  },
  claude: {
    runtimeKind: "claude",
    pinnedVersion: "2.1.228",
    sourceUrl: CLAUDE_CLI_DOCS,
    accessedAt: RUNTIME_PROFILE_ACCESSED_AT,
    runArgs: ["-p", "--output-format", "json"],
    // P2: `claude auth login` is the documented runtime-owned sign-in command.
    loginCommand: "claude auth login",
    // P2 recheck 2026-08-15: `--model` accepts an alias or a full model id
    // ("Sets the model for the current session with an alias for the latest
    // model or a model's full name"; example `claude --model claude-sonnet-5`).
    modelArgvPrefix: ["--model"],
    probe: { args: ["--version"], expectsVersion: true },
    // `claude auth status` prints JSON and "exits with code 0 if logged in,
    // 1 if not".
    authProbe: {
      args: ["auth", "status"],
      authExitCodes: [1],
    },
    credentialEnvRefs: ["ANTHROPIC_API_KEY"],
    unsupported: [
      "Consumer subscription login through third-party products (official Anthropic rule)",
      "Agent SDK OAuth (not documented for the SDK)",
      "claude auth status --text (human output; the JSON default is the bounded probe)",
    ],
    declaredCapabilities: {
      invocation: { supported: true, source: "configured", version: "2.1.228" },
      structuredResult: {
        supported: true,
        source: "configured",
        version: "2.1.228",
      },
      localProcessTermination: { supported: true, source: "configured" },
    },
  },
  opencode: {
    runtimeKind: "opencode",
    pinnedVersion: "1.18.16",
    sourceUrl: OPENCODE_CLI_DOCS,
    accessedAt: RUNTIME_PROFILE_ACCESSED_AT,
    runArgs: ["run", "--format", "json"],
    // P2: `opencode auth login` is the documented runtime-owned sign-in
    // command (provider auth is runtime-owned; Tenvyr never reads the
    // OpenCode auth file).
    loginCommand: "opencode auth login",
    // P2 recheck 2026-08-15: `run --model provider/model` is the documented
    // model selector ("Model to use in the form of provider/model").
    modelArgvPrefix: ["--model"],
    probe: { args: ["--version"], expectsVersion: true },
    credentialEnvRefs: [],
    unsupported: [
      "Provider auth is runtime-owned; Tenvyr never reads provider credentials",
      "opencode auth list is the documented discovery command, not a Tenvyr auth probe",
    ],
    declaredCapabilities: {
      invocation: { supported: true, source: "configured", version: "1.18.16" },
      structuredResult: {
        supported: true,
        source: "configured",
        version: "1.18.16",
      },
      progressEvents: {
        supported: true,
        source: "configured",
        version: "1.18.16",
      },
      localProcessTermination: { supported: true, source: "configured" },
    },
  },
};

/** Builds a validated connection profile for a runtime from its template.
 *  Only the executable path and optional overrides are operator-supplied:
 *  run argv and probe argv come from the documented template. */
export function buildRuntimeConnectionProfile(input: {
  runtimeKind: "codex" | "claude" | "opencode";
  name: string;
  executorId: string;
  /** Absolute path to the operator's installed CLI executable. */
  executable: string;
  /** Overrides the template's pinned version (operator-declared). */
  version?: string;
  credentialRefs?: CredentialReference[];
  declaredCapabilities?: ConnectionCapabilities;
}): ConnectionProfileV1 {
  const template = RUNTIME_PROFILE_TEMPLATES[input.runtimeKind];
  const cli: CliProfileV1 = {
    command: input.executable,
    args: template.runArgs,
    probe: template.probe,
  };
  if (template.authProbe) cli.authProbe = template.authProbe;
  const profile: ConnectionProfileV1 = {
    name: input.name,
    runtimeKind: input.runtimeKind as RuntimeKind,
    executorId: input.executorId,
    version: input.version ?? template.pinnedVersion,
    credentialRefs: input.credentialRefs ?? [],
    declaredCapabilities:
      input.declaredCapabilities ?? template.declaredCapabilities,
    cli,
  };
  return profile;
}
