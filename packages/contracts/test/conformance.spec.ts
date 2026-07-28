import { createHmac } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  parseAgentResult,
  parseHttpAgentRunAccepted,
  parseHttpAgentRunRequest,
} from "../src";

const conformanceRoot = resolve(__dirname, "../../../contracts/conformance");

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    readFileSync(resolve(conformanceRoot, relativePath), "utf8"),
  ) as T;
}

function fixtureNames(relativePath: string): string[] {
  return readdirSync(resolve(conformanceRoot, relativePath))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

type SignatureVector = {
  name: string;
  keyId: string;
  secret: string;
  timestamp: string;
  deliveryId: string;
  rawBodyUtf8: string;
  expectedSignedPayload: string;
  expectedSignature: string;
};

type RetryCase = {
  name: string;
  input: { kind: "network-error" | "http-status"; status?: number };
  outcome: "delivered" | "retry" | "do-not-retry";
};

describe("HTTP protocol conformance fixtures", () => {
  it("loads fixtures independently of the process working directory", () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(readJson("run-request/valid/minimal.json")).toBeDefined();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it.each(["minimal.json", "full.json"])(
    "accepts valid run request %s",
    (name) => {
      expect(
        parseHttpAgentRunRequest(readJson(`run-request/valid/${name}`)),
      ).toBeDefined();
    },
  );

  it.each([
    "missing-invocation.json",
    "invalid-callback-url.json",
    "unsupported-delivery-mode.json",
    "callback-secret-leak.json",
  ])("rejects invalid run request %s", (name) => {
    const fixture = readJson(`run-request/invalid/${name}`);

    expect(() => parseHttpAgentRunRequest(fixture)).toThrow();
  });

  it("accepts the valid acceptance fixture", () => {
    expect(
      parseHttpAgentRunAccepted(readJson("run-accepted/valid/accepted.json")),
    ).toBeDefined();
  });

  it.each(["missing-run-id.json", "invalid-timestamp.json"])(
    "rejects invalid acceptance %s",
    (name) => {
      const fixture = readJson(`run-accepted/invalid/${name}`);

      expect(() => parseHttpAgentRunAccepted(fixture)).toThrow();
    },
  );

  it("classifies an invocation mismatch at the protocol correlation boundary", () => {
    const accepted = parseHttpAgentRunAccepted(
      readJson("run-accepted/invalid/invocation-mismatch.json"),
    );

    expect(accepted.invocationId).not.toBe("invocation-conformance-1");
  });

  it.each([
    "succeeded.json",
    "failed.json",
    "cancelled.json",
    "timed-out.json",
  ])("accepts valid result %s", (name) => {
    expect(parseAgentResult(readJson(`results/valid/${name}`))).toBeDefined();
  });

  it.each([
    "failed-without-error.json",
    "succeeded-with-error.json",
    "negative-usage.json",
  ])("rejects invalid result %s", (name) => {
    const fixture = readJson(`results/invalid/${name}`);

    expect(() => parseAgentResult(fixture)).toThrow();
  });

  it("contains every documented fixture and no production-looking secret", () => {
    expect(fixtureNames("run-request/valid")).toEqual([
      "full.json",
      "minimal.json",
    ]);
    expect(fixtureNames("results/valid")).toEqual([
      "cancelled.json",
      "failed.json",
      "succeeded.json",
      "timed-out.json",
    ]);
    expect(
      readFileSync(
        resolve(conformanceRoot, "callback-signatures/vectors.json"),
        "utf8",
      ),
    ).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}/);
  });

  it("matches every exact raw-byte signature vector", () => {
    const vectors = readJson<SignatureVector[]>(
      "callback-signatures/vectors.json",
    );

    expect(vectors.map((vector) => vector.name)).toEqual([
      "minimal-json",
      "pretty-json",
      "reordered-properties",
      "unicode-utf8",
      "escaped-characters",
      "empty-object",
      "trailing-newline",
      "leading-trailing-whitespace",
    ]);
    for (const vector of vectors) {
      const signedPayload = `${vector.timestamp}.${vector.deliveryId}.${vector.rawBodyUtf8}`;
      const signature = `v1=${createHmac("sha256", vector.secret).update(signedPayload, "utf8").digest("hex")}`;

      expect(signedPayload).toBe(vector.expectedSignedPayload);
      expect(signature).toBe(vector.expectedSignature);
    }
  });

  it("proves formatting, property order, and UTF-8 bytes affect signatures", () => {
    const vectors = readJson<SignatureVector[]>(
      "callback-signatures/vectors.json",
    );
    const signature = (name: string) =>
      vectors.find((vector) => vector.name === name)?.expectedSignature;

    expect(signature("minimal-json")).not.toBe(signature("pretty-json"));
    expect(signature("minimal-json")).not.toBe(
      signature("reordered-properties"),
    );
    expect(
      vectors.find((vector) => vector.name === "unicode-utf8")?.rawBodyUtf8,
    ).toContain("Xin chào");
  });

  it("locks callback status and retry classifications", () => {
    const callbackCases = readJson<Array<{ status: number; outcome: string }>>(
      "protocol/callback-status-cases.json",
    );
    const retryCases = readJson<RetryCase[]>(
      "protocol/retry-classification.json",
    );

    expect(callbackCases).toEqual([
      { status: 200, outcome: "delivered" },
      { status: 202, outcome: "delivered" },
      { status: 204, outcome: "delivered" },
      { status: 299, outcome: "delivered" },
      { status: 302, outcome: "do-not-retry" },
      { status: 400, outcome: "do-not-retry" },
      { status: 401, outcome: "do-not-retry" },
      { status: 403, outcome: "do-not-retry" },
      { status: 404, outcome: "do-not-retry" },
      { status: 408, outcome: "retry" },
      { status: 409, outcome: "do-not-retry" },
      { status: 429, outcome: "retry" },
      { status: 500, outcome: "retry" },
      { status: 503, outcome: "retry" },
      { status: 599, outcome: "retry" },
    ]);
    expect(retryCases).toEqual([
      {
        name: "network-error",
        input: { kind: "network-error" },
        outcome: "retry",
      },
      {
        name: "request-timeout",
        input: { kind: "network-error" },
        outcome: "retry",
      },
      {
        name: "request-timeout-status",
        input: { kind: "http-status", status: 408 },
        outcome: "retry",
      },
      {
        name: "too-many-requests",
        input: { kind: "http-status", status: 429 },
        outcome: "retry",
      },
      {
        name: "server-error",
        input: { kind: "http-status", status: 500 },
        outcome: "retry",
      },
      {
        name: "success",
        input: { kind: "http-status", status: 204 },
        outcome: "delivered",
      },
      {
        name: "bad-request",
        input: { kind: "http-status", status: 400 },
        outcome: "do-not-retry",
      },
      {
        name: "unauthorized",
        input: { kind: "http-status", status: 401 },
        outcome: "do-not-retry",
      },
      {
        name: "forbidden",
        input: { kind: "http-status", status: 403 },
        outcome: "do-not-retry",
      },
      {
        name: "not-found",
        input: { kind: "http-status", status: 404 },
        outcome: "do-not-retry",
      },
      {
        name: "conflict",
        input: { kind: "http-status", status: 409 },
        outcome: "do-not-retry",
      },
      {
        name: "redirect",
        input: { kind: "http-status", status: 302 },
        outcome: "do-not-retry",
      },
    ]);
  });
});
