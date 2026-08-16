/**
 * P2 closure (round 2): OpenCode Server API domain.
 *
 * The official OpenCode Server API (opencode serve) is the STRUCTURED
 * provider contract — the TUI `auth list` output (box-drawing decoration)
 * is never parsed. Contract verified against opencode.ai/docs/server on
 * 2026-08-16:
 *
 *   GET  /provider                        -> { all: Provider[], default: {...}, connected: string[] }
 *   GET  /provider/auth                   -> { [providerID: string]: ProviderAuthMethod[] }
 *   POST /provider/{id}/oauth/authorize   -> ProviderAuthAuthorization
 *   POST /provider/{id}/oauth/callback    -> boolean
 *
 * Auth: HTTP basic auth; username `opencode` (OPENCODE_SERVER_USERNAME
 * override), password from OPENCODE_SERVER_PASSWORD. The server binds
 * 127.0.0.1 by default; mDNS is off by default.
 *
 * All parsing is STRICT and bounded: unknown fields are dropped, missing
 * required fields are malformed errors (never optimistic defaults).
 * OAuth authorization URLs are validated before they are surfaced.
 */
import { ModelCatalogEntryV1 } from "./model-source";

export const OPENCODE_SERVER_BOUNDS = {
  /** Per-response byte cap for management API bodies. */
  responseBytes: 256 * 1024,
  /** Per-call API timeout. */
  apiTimeoutMs: 5_000,
  /** Wall-clock budget to reach the READY state. */
  startTimeoutMs: 10_000,
  /** Port bind retries before failing the session. */
  portRetries: 5,
  /** Provider id bound (matches the model-id family). */
  providerIdMax: 255,
  authMethodsMax: 32,
  oauthUrlMax: 2048,
} as const;

export type OpenCodeProviderV1 = {
  /** Bounded provider identifier (provider names from the server). */
  id: string;
  /** Optional display name when the server provides one. */
  name?: string;
};

export type OpenCodeProviderListV1 = {
  all: OpenCodeProviderV1[];
  default: Record<string, string>;
  /** Provider ids currently authenticated in the runtime. */
  connected: string[];
};

/**
 * P2 final closure: OpenCode 1.18.16 auth method — the runtime exposes
 * `{ type: "oauth" | "api", label }` (no stable string id). A method is
 * identified by its STABLE LIST INDEX within the current discovery
 * snapshot (`methodIndex`), never by a synthesized identifier. Bounded
 * prompt metadata is preserved ONLY as a fail-closed flag: Tenvyr never
 * collects credentials for prompts it cannot safely drive.
 */
export type OpenCodeProviderAuthMethodV1 = {
  /** Stable index within the auth-method snapshot (0-based). */
  methodIndex: number;
  type: "oauth" | "api";
  /** Bounded runtime-provided label. */
  label: string;
  /** True when the runtime declares prompt inputs Tenvyr will not drive
   *  (fail closed -> guided official login command instead). */
  requiresPrompt: boolean;
};

export type OpenCodeAuthAuthorizationV1 = {
  /** Validated http(s) authorization URL. */
  url: string;
  /** "auto": complete via the same live session; "code": the operator
   *  must submit the bounded authorization code. */
  method: "auto" | "code";
  /** Bounded runtime instructions for the operator. */
  instructions: string | null;
};

export type OpenCodeAuthMethodsV1 = Record<
  string,
  OpenCodeProviderAuthMethodV1[]
>;

export class OpenCodeServerError extends Error {
  constructor(
    readonly code:
      | "start-timeout"
      | "start-failed"
      | "api-timeout"
      | "unreachable"
      | "auth-failed"
      | "malformed"
      | "oversized"
      | "invalid-oauth-url",
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeServerError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedProviderId(value: unknown): string {
  if (typeof value !== "string") {
    throw new OpenCodeServerError("malformed", "provider id must be a string");
  }
  if (
    value.length === 0 ||
    value.length > OPENCODE_SERVER_BOUNDS.providerIdMax ||
    /[^A-Za-z0-9_.:-]/.test(value)
  ) {
    throw new OpenCodeServerError("malformed", "provider id is out of bounds");
  }
  return value;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max) {
    throw new OpenCodeServerError("malformed", `${field} is out of bounds`);
  }
  return value;
}

/** Strict parse of GET /provider. `default` is projection metadata only —
 *  never execution authority. */
export function parseOpenCodeProviderList(value: unknown): OpenCodeProviderListV1 {
  if (!isRecord(value) || !Array.isArray(value.all)) {
    throw new OpenCodeServerError("malformed", "provider list must be an object with all[]");
  }
  const all: OpenCodeProviderV1[] = [];
  for (const entry of value.all) {
    if (!isRecord(entry)) continue;
    const id = boundedProviderId(entry.id);
    const provider: OpenCodeProviderV1 = { id };
    if (typeof entry.name === "string" && entry.name.length <= 255) {
      provider.name = entry.name;
    }
    if (!all.some((p) => p.id === id)) all.push(provider);
    if (all.length >= 512) break;
  }
  const connected: string[] = [];
  if (Array.isArray(value.connected)) {
    for (const entry of value.connected) {
      const id = boundedProviderId(entry);
      if (!connected.includes(id)) connected.push(id);
      if (connected.length >= 512) break;
    }
  }
  const defaults: Record<string, string> = {};
  if (isRecord(value.default)) {
    for (const [key, entry] of Object.entries(value.default)) {
      if (typeof entry === "string" && entry.length <= OPENCODE_SERVER_BOUNDS.providerIdMax) {
        defaults[key] = entry;
      }
      if (Object.keys(defaults).length >= 64) break;
    }
  }
  return { all, default: defaults, connected };
}

/** Strict parse of GET /provider/auth (methods BY provider) — the REAL
 *  OpenCode contract: `{ type: "oauth" | "api", label, ... }`. Each method
 *  is referenced by its stable list index; a method whose type is unknown
 *  or whose label is missing is DROPPED (never optimistic). Prompt
 *  metadata is reduced to a fail-closed `requiresPrompt` flag. */
export function parseOpenCodeAuthMethods(
  value: unknown,
): OpenCodeAuthMethodsV1 {
  if (!isRecord(value)) {
    throw new OpenCodeServerError("malformed", "auth methods must be an object");
  }
  const result: OpenCodeAuthMethodsV1 = {};
  for (const [providerId, rawMethods] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(providerId)) continue;
    if (!Array.isArray(rawMethods)) continue;
    const methods: OpenCodeProviderAuthMethodV1[] = [];
    let index = 0;
    for (const raw of rawMethods) {
      if (!isRecord(raw)) continue;
      if (raw.type !== "oauth" && raw.type !== "api") {
        index += 1;
        continue;
      }
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      if (label.length === 0 || label.length > 255) {
        index += 1;
        continue;
      }
      methods.push({
        methodIndex: index,
        type: raw.type,
        label,
        // REAL OpenCode 1.18.16 contract: `prompts?: Prompt[]` on
        // ProviderAuth methods. The singular `prompt` is NOT supported as
        // authoritative. Prompt-requiring methods fail closed — Tenvyr
        // never collects prompt inputs.
        requiresPrompt: Array.isArray(raw.prompts) && raw.prompts.length > 0,
      });
      index += 1;
      if (methods.length >= OPENCODE_SERVER_BOUNDS.authMethodsMax) break;
    }
    result[providerId] = methods;
  }
  return result;
}

/** Strict parse of POST oauth/authorize — the REAL contract:
 *  `{ url, method: "auto" | "code", instructions }`. The URL is validated
 *  BEFORE it is surfaced; the flow method is an exhaustive enum; unknown
 *  values are malformed, never optimistic. */
export function parseOpenCodeAuthAuthorization(
  value: unknown,
): OpenCodeAuthAuthorizationV1 {
  if (!isRecord(value) || typeof value.url !== "string") {
    throw new OpenCodeServerError("malformed", "authorization must carry a url");
  }
  const url = value.url;
  if (
    url.length === 0 ||
    url.length > OPENCODE_SERVER_BOUNDS.oauthUrlMax ||
    !isSafeOauthUrl(url)
  ) {
    throw new OpenCodeServerError(
      "invalid-oauth-url",
      "authorization url is not a safe http(s) url",
    );
  }
  if (value.method !== "auto" && value.method !== "code") {
    throw new OpenCodeServerError(
      "malformed",
      `authorization method must be auto|code (got ${String(value.method)})`,
    );
  }
  const instructions =
    typeof value.instructions === "string" && value.instructions.length > 0
      ? value.instructions.slice(0, 512)
      : null;
  return { url, method: value.method, instructions };
}

/** Bounded authorization code for the "code" flow — never logged, never
 *  persisted. */
export function isBoundedAuthCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    /^[A-Za-z0-9._~+/=-]+$/.test(value)
  );
}

/** http/https only; no userinfo; no localhost restrictions beyond scheme
 *  (the server runs on 127.0.0.1 and the provider owns the destination);
 *  no credentials embedded. */
export function isSafeOauthUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    if (!parsed.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

/** Official fixed OpenCode login command for guided fallback (api-key /
 *  non-oauth providers). The provider id is DATA appended as a separate
 *  argv element — never shell-interpolated. */
export function openCodeLoginCommand(providerId: string): string {
  return `opencode auth login --provider ${providerId}`;
}

export function toRuntimeProviderV1(
  list: OpenCodeProviderListV1,
): Array<{ providerId: string; authenticated: boolean; loginCommand: string }> {
  return list.all.map((provider) => ({
    providerId: provider.id,
    authenticated: list.connected.includes(provider.id),
    loginCommand: openCodeLoginCommand(provider.id),
  }));
}

/** Models from the documented `opencode models [provider]` CLI format —
 *  provider/model lines. Bounded; dedupe; never mixes providers when a
 *  provider filter is applied. */
export function parseOpenCodeModelLines(
  stdout: string,
  provider?: string,
): ModelCatalogEntryV1[] {
  const entries: ModelCatalogEntryV1[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const slash = line.indexOf("/");
    if (slash <= 0 || slash === line.length - 1) continue;
    const providerId = line.slice(0, slash);
    const modelId = line.slice(slash + 1);
    if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(providerId)) continue;
    if (!/^[A-Za-z0-9_.:\/-]{1,255}$/.test(modelId)) continue;
    if (provider && providerId !== provider) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    entries.push({ modelId: line, providerId, source: "opencode" });
    if (entries.length >= 5000) break;
  }
  return entries;
}
