import { createHash } from "crypto";
import type { HttpAgentRunRequestV1 } from "@tenvyr/contracts";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON requires JSON-compatible values");
}

export function requestFingerprint(
  request: HttpAgentRunRequestV1,
  idempotencyKey: string,
): string {
  return createHash("sha256")
    .update(idempotencyKey)
    .update("\n")
    .update(canonicalJson(request))
    .digest("hex");
}
