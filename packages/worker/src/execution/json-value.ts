import type { JsonValue } from "@tenvyr/contracts";

export function asJsonValue(
  value: unknown,
  path = "$",
  seen = new Set<object>(),
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${path} must be a finite JSON number`);
    return value;
  }
  if (typeof value !== "object")
    throw new TypeError(`${path} is not JSON-compatible`);
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !Array.isArray(value)
  ) {
    throw new TypeError(`${path} must be a plain JSON object or array`);
  }
  if (seen.has(value))
    throw new TypeError(`${path} contains a circular reference`);
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item, index) =>
        asJsonValue(item, `${path}[${index}]`, seen),
      );
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) {
      output[key] = asJsonValue(item, `${path}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}
