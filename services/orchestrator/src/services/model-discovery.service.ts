import {
  MODEL_SOURCE_BOUNDS,
  MODEL_ID_MAX_LENGTH,
  MODEL_ID_PATTERN,
  modelSourceModelsUrl,
  normalizeModelSourceBaseUrl,
  type ModelCatalogEntryV1,
  type ModelCatalogSnapshotV1,
  type ModelSourceReasonCode,
} from "../executors/model-source";
import { OPENAI_COMPATIBLE_KIND } from "../executors/model-source";
import { runBoundedCliCommand } from "./cli-probe";

/**
 * P2: bounded model DISCOVERY — where Tenvyr safely learns model
 * identifiers. Discovery is a projection, never execution authority:
 *
 * - OpenCode: official CLI only (`opencode auth list`, `opencode models`,
 *   `opencode models --refresh`). The auth.json file is NEVER read.
 * - Codex: `codex debug models` is EXPERIMENTAL — best-effort bounded JSON
 *   parse; execution never depends on it (Runtime default / manual entry).
 * - 9Router / generic OpenAI-compatible: `GET {baseUrl}/models` with
 *   optional bearer env REFERENCE resolved only at request time.
 *
 * Every path is bounded: response bytes, model count, model id length and
 * pattern, strict timeout, http/https only, no userinfo, redirects
 * re-validated per hop, no credential values in logs or errors, no shell.
 */

const DISCOVERY_BOUNDS = {
  wallTimeMs: 15_000,
  maxOutputBytes: 512 * 1024,
} as const;

/** Provider-name pattern for the first column of `opencode auth list`
 *  (human-oriented output; bounded parsing, never persisted). */
const PROVIDER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AUTH_LIST_HEADER_TOKENS = new Set([
  "PROVIDER",
  "ID",
  "TYPE",
  "NAME",
  "KIND",
  "STATUS",
]);

export type ModelSourceTestResult = {
  ok: boolean;
  status: "AVAILABLE" | "AUTH_REQUIRED" | "UNAVAILABLE" | "DEGRADED";
  reasonCode: ModelSourceReasonCode;
  testedAt: string;
  durationMs: number;
  modelCount?: number;
};

export class ModelDiscoveryService {
  /** OpenCode: authenticated providers via the official `auth list`
   *  command. Bounded first-column parse; output is never persisted. */
  async discoverOpenCodeProviders(executable: string): Promise<string[]> {
    const outcome = await runBoundedCliCommand({
      command: executable,
      args: ["auth", "list"],
      wallTimeMs: DISCOVERY_BOUNDS.wallTimeMs,
      maxOutputBytes: DISCOVERY_BOUNDS.maxOutputBytes,
    });
    if (!outcome.ok) return [];
    const providers: string[] = [];
    for (const rawLine of outcome.stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const firstToken = line.split(/\s+/)[0];
      if (!firstToken || AUTH_LIST_HEADER_TOKENS.has(firstToken)) continue;
      if (PROVIDER_TOKEN_PATTERN.test(firstToken) && firstToken.length <= 255) {
        if (!providers.includes(firstToken)) providers.push(firstToken);
      }
      if (providers.length >= 512) break;
    }
    return providers;
  }

  /** OpenCode: model catalog via the official `models [provider]`
   *  command. Output lines are `provider/model` tokens (documented
   *  format); bounded parse with dedupe. */
  async discoverOpenCodeModels(
    executable: string,
    provider?: string,
  ): Promise<ModelCatalogEntryV1[]> {
    const args = ["models", ...(provider ? [provider] : [])];
    const outcome = await runBoundedCliCommand({
      command: executable,
      args,
      wallTimeMs: DISCOVERY_BOUNDS.wallTimeMs,
      maxOutputBytes: DISCOVERY_BOUNDS.maxOutputBytes,
    });
    if (!outcome.ok) return [];
    return parseOpenCodeModelLines(outcome.stdout);
  }

  /** OpenCode: refresh the runtime's models cache (`models --refresh`). */
  async refreshOpenCodeModels(executable: string): Promise<boolean> {
    const outcome = await runBoundedCliCommand({
      command: executable,
      args: ["models", "--refresh"],
      wallTimeMs: DISCOVERY_BOUNDS.wallTimeMs,
      maxOutputBytes: DISCOVERY_BOUNDS.maxOutputBytes,
    });
    return outcome.ok;
  }

  /**
   * Codex: BEST-EFFORT experimental catalog (`codex debug models`). The
   * output is not a stable machine contract — accepted shapes are bounded
   * (string array, object array with an id-like string field, or an object
   * wrapping one of those under `models`). ANY parse failure yields an
   * EMPTY catalog (Runtime default / manual entry) and never affects
   * execution.
   */
  async discoverCodexModels(
    executable: string,
  ): Promise<ModelCatalogEntryV1[]> {
    const outcome = await runBoundedCliCommand({
      command: executable,
      args: ["debug", "models"],
      wallTimeMs: DISCOVERY_BOUNDS.wallTimeMs,
      maxOutputBytes: DISCOVERY_BOUNDS.maxOutputBytes,
    });
    if (!outcome.ok) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch {
      return [];
    }
    const candidate =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).models
        : parsed;
    if (!Array.isArray(candidate)) return [];
    const entries: ModelCatalogEntryV1[] = [];
    const seen = new Set<string>();
    for (const item of candidate.slice(0, MODEL_SOURCE_BOUNDS.modelsMaxCount)) {
      const raw =
        typeof item === "string"
          ? item
          : item !== null && typeof item === "object"
            ? ((item as Record<string, unknown>).id ??
              (item as Record<string, unknown>).model ??
              (item as Record<string, unknown>).name)
            : undefined;
      if (typeof raw !== "string") continue;
      const modelId = raw.trim();
      if (!seen.has(modelId) && isBoundedModelId(modelId)) {
        seen.add(modelId);
        entries.push({ modelId, source: "codex" });
      }
    }
    return entries;
  }

  /**
   * 9Router / generic OpenAI-compatible catalog:
   * `GET {baseUrl}/models`. Bearer token resolved from the env REFERENCE
   * only at request time; missing env value = AUTH_REQUIRED. Bounded:
   * strict timeout, byte cap, model count/id caps, dedupe, redirects
   * re-validated (http/https only, no userinfo), no credential values in
   * errors.
   */
  async fetchOpenAiCompatibleCatalog(input: {
    sourceId: string;
    baseUrl: string;
    credentialEnvRef?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ModelCatalogSnapshotV1> {
    const env = input.env ?? process.env;
    const discoveredAt = new Date().toISOString();
    const url = modelSourceModelsUrl(input.baseUrl);
    const headers: Record<string, string> = {};
    if (input.credentialEnvRef) {
      const value = env[input.credentialEnvRef];
      if (value === undefined || value === "") {
        throw new ModelDiscoveryError(
          "auth-required",
          `credential environment reference ${input.credentialEnvRef} is not set`,
        );
      }
      headers.Authorization = `Bearer ${value}`;
    }
    const { body, finalUrl } = await boundedFetch(url, headers);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new ModelDiscoveryError(
        "malformed",
        `models catalog from ${redactUrl(finalUrl)} is not valid JSON`,
      );
    }
    const data =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).data
        : undefined;
    if (!Array.isArray(data)) {
      throw new ModelDiscoveryError(
        "malformed",
        `models catalog from ${redactUrl(finalUrl)} has no data array`,
      );
    }
    const entries: ModelCatalogEntryV1[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const item of data) {
      if (entries.length >= MODEL_SOURCE_BOUNDS.modelsMaxCount) {
        truncated = true;
        break;
      }
      const raw =
        item !== null && typeof item === "object"
          ? (item as Record<string, unknown>).id
          : undefined;
      if (typeof raw !== "string") continue;
      const modelId = raw.trim();
      if (seen.has(modelId) || !isBoundedModelId(modelId)) continue;
      seen.add(modelId);
      entries.push({ modelId, source: OPENAI_COMPATIBLE_KIND });
    }
    return {
      sourceId: input.sourceId,
      discoveredAt,
      models: entries,
      ...(truncated ? { truncated } : {}),
    };
  }

  /** Bounded source test: endpoint reachable, auth accepted, catalog
   *  retrievable — it does NOT prove inference. */
  async testOpenAiCompatibleSource(input: {
    sourceId: string;
    baseUrl: string;
    credentialEnvRef?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ModelSourceTestResult> {
    const started = Date.now();
    const snapshot = await this.fetchOpenAiCompatibleCatalog(input);
    return {
      ok: true,
      status: "AVAILABLE",
      reasonCode: "none",
      testedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      modelCount: snapshot.models.length,
    };
  }
}

export class ModelDiscoveryError extends Error {
  constructor(
    public readonly code: ModelSourceReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

/** Bounded stdout parse of `opencode models` output: one
 *  `provider/model` token per line (documented format). */
export function parseOpenCodeModelLines(stdout: string): ModelCatalogEntryV1[] {
  const entries: ModelCatalogEntryV1[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const token = rawLine.trim();
    if (!token || seen.has(token)) continue;
    const slash = token.indexOf("/");
    if (slash <= 0 || slash === token.length - 1) continue;
    const providerId = token.slice(0, slash);
    if (!PROVIDER_TOKEN_PATTERN.test(providerId) || providerId.length > 255)
      continue;
    if (!isBoundedModelId(token)) continue;
    seen.add(token);
    entries.push({ modelId: token, providerId, source: "opencode" });
    if (entries.length >= MODEL_SOURCE_BOUNDS.modelsMaxCount) break;
  }
  return entries;
}

export function isBoundedModelId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MODEL_ID_MAX_LENGTH &&
    MODEL_ID_PATTERN.test(value)
  );
}

/** Bounded fetch: strict timeout, byte cap, manual redirects re-validated
 *  per hop (http/https only, no userinfo), credential-free errors. */
export async function boundedFetch(
  url: string,
  headers: Record<string, string>,
  redirects = MODEL_SOURCE_BOUNDS.maxRedirects,
): Promise<{ body: string; finalUrl: string }> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    if (hop > redirects) {
      throw new ModelDiscoveryError(
        "unsupported-redirect",
        "models endpoint exceeded the redirect bound",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      MODEL_SOURCE_BOUNDS.requestTimeoutMs,
    );
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      // Aborts surface differently per undici path (AbortError, or
      // `TypeError: fetch failed` with an AbortError cause); the abort
      // controller's own state is the deterministic signal.
      const aborted = controller.signal.aborted;
      throw new ModelDiscoveryError(
        aborted ? "timeout" : "unreachable",
        aborted
          ? "models endpoint timed out"
          : `models endpoint is unreachable: ${redactError(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      const location = response.headers.get("location");
      const next = new URL(location as string, current);
      validateFetchUrl(next);
      current = next.toString();
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new ModelDiscoveryError(
        "auth-required",
        "models endpoint rejected the credential",
      );
    }
    if (!response.ok) {
      throw new ModelDiscoveryError(
        "unreachable",
        `models endpoint returned HTTP ${response.status}`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new ModelDiscoveryError(
        "malformed",
        "models endpoint returned no body",
      );
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      if (controller.signal.aborted) {
        await reader.cancel();
        throw new ModelDiscoveryError("timeout", "models endpoint timed out");
      }
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MODEL_SOURCE_BOUNDS.responseMaxBytes) {
        await reader.cancel();
        throw new ModelDiscoveryError(
          "oversized",
          `models catalog exceeds ${MODEL_SOURCE_BOUNDS.responseMaxBytes} bytes`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    return { body: Buffer.concat(chunks).toString("utf8"), finalUrl: current };
  }
  // Unreachable: the loop returns or throws.
  throw new ModelDiscoveryError("unreachable", "models endpoint fetch failed");
}

function validateFetchUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelDiscoveryError(
      "unsupported-redirect",
      "models endpoint redirected to an unsafe scheme",
    );
  }
  if (url.username || url.password) {
    throw new ModelDiscoveryError(
      "unsupported-redirect",
      "models endpoint redirected to a URL with embedded credentials",
    );
  }
  if (url.toString().length > MODEL_SOURCE_BOUNDS.baseUrlMaxLength) {
    throw new ModelDiscoveryError(
      "unsupported-redirect",
      "models endpoint URL is too long",
    );
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

function redactError(error: unknown): string {
  // Never echo fetch error internals that could carry credentials.
  return error instanceof Error && error.message
    ? "request failed"
    : "request failed";
}

export function normalizeBaseUrlForSource(baseUrl: string): string {
  return normalizeModelSourceBaseUrl(baseUrl);
}
