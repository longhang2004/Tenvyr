const SENSITIVE_KEY =
  /token|key|secret|password|authorization|cookie|credentials?|session(?:id)?/i;

export const SAFE_PREVIEW_MAX_CHARS = 2000;

function redact(value) {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(nestedValue),
      ]),
    );
  }

  return value;
}

export function safeJsonPreview(value) {
  const serialized = JSON.stringify(redact(value), null, 2) ?? String(value);

  return serialized.length > SAFE_PREVIEW_MAX_CHARS
    ? `${serialized.slice(0, SAFE_PREVIEW_MAX_CHARS - 1)}…`
    : serialized;
}
