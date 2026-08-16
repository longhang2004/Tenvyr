import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MalformedResponseError,
  parseConnectionTestReceipt,
  parseConnectionTestResult,
  parseOpenCodeAuthBegin,
  parseProviderAuthMethods,
  parseProviderDiscovery,
  parseTestTargetEvidence,
  parseWorkbenchCommandResult,
  providerStateKey,
  selectableProviders,
} from "./guards.ts";

/**
 * P2 contract regression: the connection test receipt is nested under the
 * Workbench command result (`data.result.receipt`). Server state is
 * authoritative — "READY" is NEVER fabricated when state is absent,
 * unknown, or malformed.
 */

const receiptFixture = (overrides = {}) => ({
  connectionId: "conn:codex",
  revisionNumber: 3,
  testedAt: "2026-08-15T00:00:00.000Z",
  state: "AUTH_REQUIRED",
  reasonCode: "auth-required",
  durationMs: 42,
  ...overrides,
});

const envelopeFixture = (overrides = {}) => ({
  action: "test-connection",
  idempotencyKey: "key-1",
  outcome: "executed",
  result: {
    connectionId: "conn:codex",
    receipt: receiptFixture(),
  },
  ...overrides,
});

describe("parseConnectionTestReceipt", () => {
  test("backend AUTH_REQUIRED receipt parses to AUTH_REQUIRED — never READY", () => {
    const receipt = parseConnectionTestReceipt(receiptFixture());
    assert.equal(receipt.state, "AUTH_REQUIRED");
    assert.equal(receipt.reasonCode, "auth-required");
    assert.notEqual(receipt.state, "READY");
  });

  test("AVAILABLE receipt with testedVersion parses", () => {
    const receipt = parseConnectionTestReceipt(
      receiptFixture({
        state: "AVAILABLE",
        reasonCode: "none",
        testedVersion: "0.147.0",
      }),
    );
    assert.equal(receipt.state, "AVAILABLE");
    assert.equal(receipt.testedVersion, "0.147.0");
  });

  test("unknown state string is rejected as malformed (never coerced to READY)", () => {
    assert.throws(
      () => parseConnectionTestReceipt(receiptFixture({ state: "READY" })),
      MalformedResponseError,
    );
    assert.throws(
      () =>
        parseConnectionTestReceipt(receiptFixture({ state: "SOMETHING_NEW" })),
      (err) =>
        err instanceof MalformedResponseError &&
        /receipt\.state/.test(err.message),
    );
  });

  test("missing or malformed fields are rejected", () => {
    for (const overrides of [
      { state: undefined },
      { reasonCode: undefined },
      { revisionNumber: "3" },
      { durationMs: -1 },
      { testedAt: "" },
      { testedVersion: 42 },
    ]) {
      assert.throws(
        () => parseConnectionTestReceipt(receiptFixture(overrides)),
        MalformedResponseError,
        JSON.stringify(overrides),
      );
    }
    assert.throws(
      () => parseConnectionTestReceipt(null),
      MalformedResponseError,
    );
    assert.throws(
      () => parseConnectionTestReceipt("READY"),
      MalformedResponseError,
    );
  });
});

describe("parseConnectionTestResult (Workbench command envelope)", () => {
  test("nested receipt under result.receipt is the authoritative state", () => {
    const result = parseConnectionTestResult(envelopeFixture());
    assert.equal(result.result.receipt.state, "AUTH_REQUIRED");
    assert.equal(result.result.connectionId, "conn:codex");
    // Regression: the page previously read res.data.status || res.data.state
    // (both undefined at the top level) and fell through to "READY".
    const envelope = envelopeFixture();
    assert.equal(envelope.status, undefined);
    assert.equal(envelope.state, undefined);
  });

  test("receipt missing entirely → malformed (never READY)", () => {
    const envelope = envelopeFixture();
    delete envelope.result.receipt;
    assert.throws(
      () => parseConnectionTestResult(envelope),
      (err) =>
        err instanceof MalformedResponseError && /receipt/.test(err.message),
    );
  });

  test("result missing → malformed", () => {
    assert.throws(
      () => parseConnectionTestResult(envelopeFixture({ result: undefined })),
      MalformedResponseError,
    );
  });

  test("non test-connection action or unknown outcome → malformed", () => {
    assert.throws(
      () =>
        parseConnectionTestResult(
          envelopeFixture({ action: "revoke-connection" }),
        ),
      MalformedResponseError,
    );
    assert.throws(
      () => parseConnectionTestResult(envelopeFixture({ outcome: "pending" })),
      MalformedResponseError,
    );
  });

  test("duplicate outcome still carries the stored receipt", () => {
    const result = parseConnectionTestResult(
      envelopeFixture({ outcome: "duplicate" }),
    );
    assert.equal(result.outcome, "duplicate");
    assert.equal(result.result.receipt.state, "AUTH_REQUIRED");
  });
});

describe("parseWorkbenchCommandResult (P2 closure envelope)", () => {
  const envelope = (overrides = {}) => ({
    action: "model-source-create",
    idempotencyKey: "key-1",
    outcome: "executed",
    result: { source: { sourceId: "src:generic" } },
    ...overrides,
  });

  test("executed envelope parses with its result payload", () => {
    const command = parseWorkbenchCommandResult(envelope());
    assert.equal(command.outcome, "executed");
    assert.equal(command.action, "model-source-create");
    assert.equal(command.result.source.sourceId, "src:generic");
  });

  test("duplicate envelope parses", () => {
    const command = parseWorkbenchCommandResult(envelope({ outcome: "duplicate" }));
    assert.equal(command.outcome, "duplicate");
    assert.equal(command.result.source.sourceId, "src:generic");
  });

  test("rejected envelope carries the bounded error", () => {
    const command = parseWorkbenchCommandResult(
      envelope({
        outcome: "rejected",
        result: undefined,
        error: { code: "PAYLOAD_TOO_LARGE", message: "too big" },
      }),
    );
    assert.equal(command.outcome, "rejected");
    assert.equal(command.error?.code, "PAYLOAD_TOO_LARGE");
    assert.equal(command.result, undefined);
  });

  test("malformed envelopes are rejected — never optimistic defaults", () => {
    for (const bad of [
      null,
      "READY",
      {},
      envelope({ outcome: "pending" }),
      envelope({ outcome: undefined }),
      envelope({ action: "" }),
      envelope({ result: "not-an-object" }),
      envelope({ error: { code: "X" } }),
    ]) {
      assert.throws(
        () => parseWorkbenchCommandResult(bad),
        MalformedResponseError,
        JSON.stringify(bad),
      );
    }
  });

  test("top-level outcome reads are undefined by construction (the bug class)", () => {
    // The gateway passes { success, data: <envelope> } through verbatim —
    // a consumer reading res.outcome at the top level always gets
    // undefined and must fall into the error branch, never a fake success.
    const gatewayBody = { success: true, data: envelope() };
    assert.equal(gatewayBody.outcome, undefined);
    const command = parseWorkbenchCommandResult(gatewayBody.data);
    assert.equal(command.outcome, "executed");
  });
});

describe("parseProviderDiscovery (P2 closure round 2)", () => {
  const discovery = {
    connectionId: "conn:opencode-A",
    revisionNumber: 3,
    runtimeKind: "opencode",
    providers: [
      { providerId: "openai", authenticated: true, loginCommand: "opencode auth login --provider openai" },
      { providerId: "deepseek", authenticated: false, loginCommand: "opencode auth login --provider deepseek" },
    ],
  };

  test("parses strictly; malformed responses are errors, never defaults", () => {
    const parsed = parseProviderDiscovery(discovery);
    assert.equal(parsed.connectionId, "conn:opencode-A");
    assert.equal(parsed.revisionNumber, 3);
    assert.equal(parsed.providers.length, 2);
    for (const bad of [
      null,
      {},
      { ...discovery, providers: "nope" },
      { ...discovery, revisionNumber: "3" },
      { ...discovery, providers: [{ providerId: "x" }] },
      { ...discovery, providers: [{ providerId: "x", authenticated: "yes" }] },
    ]) {
      assert.throws(() => parseProviderDiscovery(bad), MalformedResponseError);
    }
  });

  test("selectableProviders = authenticated ONLY (catalog visibility != execution compatibility)", () => {
    const parsed = parseProviderDiscovery(discovery);
    const selectable = selectableProviders(parsed);
    assert.deepEqual(
      selectable.map((p) => p.providerId),
      ["openai"],
    );
    assert.equal(selectableProviders(null).length, 0);
  });

  test("provider state identity includes the connection (no cross-connection bleed)", () => {
    const a = providerStateKey("conn:A", "openai");
    const b = providerStateKey("conn:B", "openai");
    assert.notEqual(a, b);
    assert.equal(a, "conn:A::openai");
    // Same provider on two connections NEVER shares a key.
    assert.equal(providerStateKey("conn:A", "openai") === providerStateKey("conn:B", "openai"), false);
  });

  test("test target evidence: ok/failed only — unknown status is malformed, never READY", () => {
    const ok = parseTestTargetEvidence({
      connectionId: "conn:run",
      revisionNumber: 1,
      runtimeKind: "opencode",
      requestedModelId: "openai/gpt-5.5",
      status: "ok",
      exitCode: 0,
      durationMs: 1200,
      outputTruncated: false,
    });
    assert.equal(ok.status, "ok");
    const failed = parseTestTargetEvidence({
      connectionId: "conn:run",
      revisionNumber: 1,
      runtimeKind: "opencode",
      requestedModelId: "openai/gpt-5.5",
      status: "failed",
      exitCode: 3,
      durationMs: 900,
      outputTruncated: false,
    });
    assert.equal(failed.status, "failed");
    assert.throws(
      () => parseTestTargetEvidence({ ...ok, status: "READY" }),
      MalformedResponseError,
    );
    assert.throws(() => parseTestTargetEvidence({ ...ok, status: undefined }), MalformedResponseError);
  });
});

describe("P2 final closure: OpenCode auth contract (type/label + method index)", () => {
  test("auth methods parse the REAL contract {type,label} with stable list indexes — no fake string id", () => {
    const parsed = parseProviderAuthMethods({
      connectionId: "conn:opencode-A",
      revisionNumber: 1,
      runtimeKind: "opencode",
      providerId: "openai",
      methods: [
        { methodIndex: 0, type: "oauth", label: "OAuth" },
        { methodIndex: 1, type: "api", label: "API Key" },
      ],
    });
    assert.equal(parsed.methods.length, 2);
    assert.deepEqual(parsed.methods.map((m) => m.type), ["oauth", "api"]);
    assert.deepEqual(parsed.methods.map((m) => m.methodIndex), [0, 1]);
    assert.equal(parsed.methods[0].label, "OAuth");
    assert.equal("id" in parsed.methods[0], false);
    // Malformed entries are errors, never optimistic defaults.
    for (const bad of [
      { ...parsed, methods: [{ type: "oauth", label: "OAuth" }] }, // no methodIndex
      { ...parsed, methods: [{ methodIndex: 0, type: "magic", label: "X" }] },
      { ...parsed, methods: [{ methodIndex: 0, type: "oauth" }] }, // no label
      { ...parsed, methods: "nope" },
    ]) {
      assert.throws(() => parseProviderAuthMethods(bad), MalformedResponseError);
    }
  });

  test("oauth begin parses auto/code strictly; unknown flow method is malformed", () => {
    const auto = parseOpenCodeAuthBegin({
      authFlowId: "a".repeat(32),
      url: "https://provider.example/authorize?state=x",
      method: "auto",
      instructions: "Complete in the provider window.",
      connectionId: "conn:opencode-A",
      connectionRevision: 1,
      providerId: "openai",
    });
    assert.equal(auto.method, "auto");
    assert.equal(auto.authFlowId, "a".repeat(32));

    const code = parseOpenCodeAuthBegin({ ...auto, method: "code", instructions: null });
    assert.equal(code.method, "code");
    assert.equal(code.instructions, null);

    for (const bad of [
      { ...auto, method: "magic" },
      { ...auto, url: "javascript:alert(1)" },
      { ...auto, authFlowId: "short" },
      null,
    ]) {
      assert.throws(() => parseOpenCodeAuthBegin(bad), MalformedResponseError);
    }
  });
});
