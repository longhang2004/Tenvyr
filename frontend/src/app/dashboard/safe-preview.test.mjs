import assert from "node:assert/strict";
import test from "node:test";

import { SAFE_PREVIEW_MAX_CHARS, safeJsonPreview } from "./safe-preview.mjs";

test("redacts nested sensitive keys", () => {
  const preview = safeJsonPreview({
    token: "top-secret",
    nested: [{ apiKey: "also-secret", safe: "visible" }],
    Authorization: "Bearer hidden",
    password: "hidden-password",
    clientSecret: "hidden-client-secret",
    cookie: "hidden-cookie",
    credential: "hidden-credential",
    credentials: "hidden-credentials",
    session: "hidden-session",
    sessionId: "hidden-session-id",
  });

  assert.doesNotMatch(
    preview,
    /top-secret|also-secret|Bearer hidden|hidden-password|hidden-client-secret|hidden-cookie|hidden-credential|hidden-credentials|hidden-session|hidden-session-id/,
  );
  assert.match(preview, /\[REDACTED\]/);
  assert.match(preview, /visible/);
});

test("truncates previews to the configured limit", () => {
  const preview = safeJsonPreview({ value: "x".repeat(3000) });

  assert.equal(preview.length, SAFE_PREVIEW_MAX_CHARS);
  assert.ok(preview.endsWith("…"));
});
