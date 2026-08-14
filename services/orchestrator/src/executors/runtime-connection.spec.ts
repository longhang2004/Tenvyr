import {
  applyStatusTransition,
  buildConnectionReference,
  connectionConfigHash,
  CONNECTION_BOUNDS,
  freezeConnectionRevision,
  parseConnectionProfile,
  parseConnectionReference,
  parseConnectionRevision,
  parseConnectionStatus,
  resolveCapabilities,
  RUNTIME_CAPABILITY_KEYS,
  type ConnectionCapabilities,
  type ConnectionProfileV1,
} from "./runtime-connection";

const SEEDED_SECRET = "sk-secret-value-never-leaks";

const baseProfile = (): ConnectionProfileV1 => ({
  name: "Codex local",
  runtimeKind: "codex",
  executorId: "local-host",
  version: "0.147.0",
  credentialRefs: [{ kind: "env", name: "CODEX_API_KEY" }],
  declaredCapabilities: {
    invocation: { supported: true, source: "configured" },
    structuredResult: { supported: true, source: "configured" },
    cancellation: { supported: false, source: "configured" },
  },
});

const expectRejected = (fail: () => unknown, code: string): void => {
  try {
    fail();
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
};

describe("freezeConnectionRevision", () => {
  it("freezes an immutable, secret-free revision with a stable canonical hash", () => {
    const revision = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 3,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });

    expect(revision).toEqual({
      schemaVersion: "1",
      connectionId: "conn:codex-local",
      revisionNumber: 3,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
      configHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      capabilities: {
        invocation: { supported: true, source: "configured" },
        structuredResult: { supported: true, source: "configured" },
      },
    });
    // Explicit unsupported declarations and missing keys resolve to absent:
    // missing/unknown means unsupported.
    expect(revision.capabilities.cancellation).toBeUndefined();
    expect(Object.keys(revision.capabilities).sort()).toEqual([
      "invocation",
      "structuredResult",
    ]);
  });

  it("produces the same configHash for the same profile (idempotency)", () => {
    const first = freezeConnectionRevision({
      connectionId: "conn:a",
      revisionNumber: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    const second = freezeConnectionRevision({
      connectionId: "conn:b",
      revisionNumber: 7,
      createdAt: "2026-08-13T00:00:00.000Z",
      profile: baseProfile(),
    });
    expect(first.configHash).toBe(second.configHash);
    expect(first.configHash).toBe(connectionConfigHash(baseProfile()));
  });

  it("is deeply immutable after freeze", () => {
    const revision = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    const mutation = (): void => {
      (revision as { profile: { name: string } }).profile.name = "mutated";
    };
    expect(mutation).toThrow();
  });

  it("never renders credential values — only env reference names", () => {
    const revision = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    const rendered = JSON.stringify(revision);
    expect(rendered).not.toContain(SEEDED_SECRET);
    expect(rendered).toContain("CODEX_API_KEY");
    expect(rendered).not.toContain("sk-");
  });

  it("rejects invalid connection ids, revision numbers, and timestamps", () => {
    expectRejected(
      () =>
        freezeConnectionRevision({
          connectionId: "conn with spaces",
          revisionNumber: 1,
          createdAt: "2026-08-12T00:00:00.000Z",
          profile: baseProfile(),
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        freezeConnectionRevision({
          connectionId: "conn:ok",
          revisionNumber: 0,
          createdAt: "2026-08-12T00:00:00.000Z",
          profile: baseProfile(),
        }),
      "RUNTIME_CONNECTION_REVISION_INVALID",
    );
    expectRejected(
      () =>
        freezeConnectionRevision({
          connectionId: "conn:ok",
          revisionNumber: 1,
          createdAt: "not-a-timestamp",
          profile: baseProfile(),
        }),
      "RUNTIME_CONNECTION_REVISION_INVALID",
    );
  });
});

describe("resolveCapabilities", () => {
  it("defaults: missing and explicit-unsupported keys stay unsupported", () => {
    const resolved = resolveCapabilities({
      invocation: { supported: true, source: "configured" },
      cancellation: { supported: false, source: "configured" },
    });
    expect(resolved.invocation).toEqual({ supported: true, source: "configured" });
    expect(resolved.cancellation).toBeUndefined();
    expect(resolved.heartbeat).toBeUndefined();
  });

  it("downgrades a declared capability when detection reports it unsupported", () => {
    const resolved = resolveCapabilities(
      {
        structuredResult: { supported: true, source: "configured" },
      },
      {
        structuredResult: { supported: false, source: "detected", version: "0.146.0" },
      },
    );
    expect(resolved.structuredResult).toEqual({
      supported: false,
      source: "detected",
      version: "0.146.0",
    });
  });

  it("never widens: detection cannot enable a capability the operator did not declare", () => {
    const resolved = resolveCapabilities(
      { invocation: { supported: true, source: "configured" } },
      { heartbeat: { supported: true, source: "detected" } },
    );
    expect(resolved.heartbeat).toBeUndefined();
  });

  it("promotes source to verified and carries detected version when both support", () => {
    const resolved = resolveCapabilities(
      { invocation: { supported: true, source: "configured" } },
      { invocation: { supported: true, source: "verified", version: "0.147.0" } },
    );
    expect(resolved.invocation).toEqual({
      supported: true,
      source: "verified",
      version: "0.147.0",
    });
  });
});

describe("parseConnectionProfile", () => {
  it("rejects unknown runtime kinds, unknown fields, and out-of-bounds values", () => {
    expectRejected(
      () => parseConnectionProfile({ ...baseProfile(), runtimeKind: "provider-router" }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () => parseConnectionProfile({ ...baseProfile(), pipeline: "anything" }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () => parseConnectionProfile({ ...baseProfile(), name: "" }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          name: "x".repeat(CONNECTION_BOUNDS.nameMaxLength + 1),
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
  });

  it("rejects any credential shape that is not an env reference (structural secret rejection)", () => {
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          credentialRefs: [{ kind: "literal", value: SEEDED_SECRET }],
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          credentialRefs: [{ kind: "env", name: "CODEX API KEY" }],
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          credentialRefs: [{ kind: "env", name: "CODEX_API_KEY", value: SEEDED_SECRET }],
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
  });

  it("rejects unknown capability keys and invalid capability shapes", () => {
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          declaredCapabilities: { "provider-routing": { supported: true, source: "configured" } },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          declaredCapabilities: { invocation: { supported: "yes", source: "configured" } },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          declaredCapabilities: { invocation: { supported: true, source: "guessed" } },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
  });

  it("round-trips an empty credential/capability profile (runtime-owned auth)", () => {
    const profile = parseConnectionProfile({
      name: "OpenCode",
      runtimeKind: "opencode",
      executorId: "local-host",
      declaredCapabilities: {},
    });
    expect(profile.credentialRefs).toEqual([]);
    expect(profile.declaredCapabilities).toEqual({});
    expect(profile.version).toBeUndefined();
  });

  it("requires a fixed cli profile for generic-cli and rejects cli on worker transports", () => {
    expectRejected(
      () =>
        parseConnectionProfile({
          name: "Generic CLI",
          runtimeKind: "generic-cli",
          executorId: "local-host",
          credentialRefs: [],
          declaredCapabilities: {},
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          name: "HTTP worker",
          runtimeKind: "http-worker",
          executorId: "http",
          credentialRefs: [],
          declaredCapabilities: {},
          cli: {
            command: "/bin/echo",
            args: [],
            probe: { args: ["--version"] },
          },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
  });

  it("accepts and strictly validates a fixed cli profile", () => {
    const profile = parseConnectionProfile({
      name: "Generic CLI",
      runtimeKind: "generic-cli",
      executorId: "local-host",
      credentialRefs: [],
      declaredCapabilities: {},
      cli: {
        command: "/usr/local/bin/tenvyr-cli",
        args: ["run", "--fixed"],
        cwd: "/opt/tenvyr",
        envAllowlist: { TENVYR_ONLY: "TENVYR_ONLY" },
        secrets: { API_TOKEN: "API_TOKEN" },
        probe: { args: ["--version"], wallTimeMs: 5000, maxOutputBytes: 1024, authExitCodes: [2, 3] },
      },
    });
    expect(profile.cli).toEqual({
      command: "/usr/local/bin/tenvyr-cli",
      args: ["run", "--fixed"],
      cwd: "/opt/tenvyr",
      envAllowlist: { TENVYR_ONLY: "TENVYR_ONLY" },
      secrets: { API_TOKEN: "API_TOKEN" },
      probe: {
        args: ["--version"],
        wallTimeMs: 5000,
        maxOutputBytes: 1024,
        authExitCodes: [2, 3],
      },
    });
    // Hostile shapes are rejected: relative command, bad env names,
    // unbounded probe settings, duplicate auth codes.
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          runtimeKind: "generic-cli",
          cli: { command: "relative/codex", args: [], probe: { args: [] } },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          runtimeKind: "generic-cli",
          cli: {
            command: "/bin/echo",
            args: [],
            probe: { args: [], wallTimeMs: 3_600_000 },
          },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          runtimeKind: "generic-cli",
          cli: {
            command: "/bin/echo",
            args: [],
            probe: { args: [], authExitCodes: [2, 2] },
          },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
  });
});

describe("parseConnectionRevision", () => {
  it("rejects unknown schema versions, unknown fields, and bad hashes", () => {
    const valid = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    expectRejected(
      () => parseConnectionRevision({ ...valid, schemaVersion: "2" }),
      "RUNTIME_CONNECTION_REVISION_INVALID",
    );
    expectRejected(
      () => parseConnectionRevision({ ...valid, secret: SEEDED_SECRET }),
      "RUNTIME_CONNECTION_REVISION_INVALID",
    );
    expectRejected(
      () => parseConnectionRevision({ ...valid, configHash: "deadbeef" }),
      "RUNTIME_CONNECTION_REVISION_INVALID",
    );
  });

  it("rejects a revision whose configHash does not match its frozen profile", () => {
    const valid = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    const tampered = {
      ...valid,
      profile: { ...valid.profile, name: "Different name" },
    };
    expectRejected(
      () => parseConnectionRevision(tampered),
      "RUNTIME_CONNECTION_REVISION_INVALID",
    );
  });

  it("rejects capability spoofing: a revision claiming a capability the profile never declared", () => {
    const valid = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    const spoofed = {
      ...valid,
      capabilities: {
        ...valid.capabilities,
        artifacts: { supported: true, source: "detected", version: "0.147.0" },
      },
    };
    expectRejected(
      () => parseConnectionRevision(spoofed),
      "RUNTIME_CONNECTION_REVISION_INVALID",
    );
  });

  it("round-trips a frozen revision exactly", () => {
    const revision = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 2,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    expect(parseConnectionRevision(revision)).toEqual(revision);
  });
});

describe("buildConnectionReference / parseConnectionReference", () => {
  it("freezes the exact secret-free revision identity as a reference", () => {
    const revision = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 3,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    const reference = buildConnectionReference(revision);
    expect(reference).toEqual({
      schemaVersion: "1",
      connectionId: "conn:codex-local",
      revisionNumber: 3,
      runtimeKind: "codex",
      version: "0.147.0",
      configHash: revision.configHash,
      capabilities: revision.capabilities,
    });
    expect(JSON.stringify(reference)).not.toContain(SEEDED_SECRET);
    expect(JSON.stringify(reference)).not.toContain("CODEX_API_KEY");
    expect(parseConnectionReference(reference)).toEqual(reference);
  });

  it("rejects hostile or incoherent references at the trust boundary", () => {
    const revision = freezeConnectionRevision({
      connectionId: "conn:codex-local",
      revisionNumber: 1,
      createdAt: "2026-08-12T00:00:00.000Z",
      profile: baseProfile(),
    });
    const reference = buildConnectionReference(revision);
    expectRejected(
      () => parseConnectionReference({ ...reference, revisionNumber: 0 }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () => parseConnectionReference({ ...reference, configHash: "deadbeef" }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () => parseConnectionReference({ ...reference, runtimeKind: "router" }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () => parseConnectionReference({ ...reference, secret: SEEDED_SECRET }),
      "RUNTIME_CONNECTION_INVALID",
    );
  });
});

describe("applyStatusTransition", () => {
  const draft = { state: "DRAFT" as const, reasonCode: "none" as const };

  it("projects DRAFT to AVAILABLE/AUTH_REQUIRED/UNAVAILABLE/DEGRADED from test outcomes", () => {
    expect(
      applyStatusTransition(draft, {
        type: "test",
        outcome: "ok",
        reasonCode: "none",
        testedAt: "2026-08-12T00:00:00.000Z",
        testedVersion: "0.147.0",
      }),
    ).toEqual({
      state: "AVAILABLE",
      reasonCode: "none",
      testedAt: "2026-08-12T00:00:00.000Z",
      testedVersion: "0.147.0",
    });
    expect(
      applyStatusTransition(draft, {
        type: "test",
        outcome: "authRequired",
        reasonCode: "auth-required",
        testedAt: "2026-08-12T00:00:00.000Z",
      }),
    ).toMatchObject({ state: "AUTH_REQUIRED", reasonCode: "auth-required" });
    expect(
      applyStatusTransition(draft, {
        type: "test",
        outcome: "failed",
        reasonCode: "missing-executable",
        testedAt: "2026-08-12T00:00:00.000Z",
      }),
    ).toMatchObject({ state: "UNAVAILABLE", reasonCode: "missing-executable" });
    expect(
      applyStatusTransition(draft, {
        type: "test",
        outcome: "degraded",
        reasonCode: "unsupported-version",
        testedAt: "2026-08-12T00:00:00.000Z",
      }),
    ).toMatchObject({ state: "DEGRADED", reasonCode: "unsupported-version" });
  });

  it("re-tests transition between non-revoked states", () => {
    const available = applyStatusTransition(draft, {
      type: "test",
      outcome: "ok",
      reasonCode: "none",
      testedAt: "2026-08-12T00:00:00.000Z",
    });
    const degraded = applyStatusTransition(available, {
      type: "test",
      outcome: "degraded",
      reasonCode: "capability-mismatch",
      testedAt: "2026-08-13T00:00:00.000Z",
    });
    expect(degraded.state).toBe("DEGRADED");
    const availableAgain = applyStatusTransition(degraded, {
      type: "test",
      outcome: "ok",
      reasonCode: "none",
      testedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(availableAgain.state).toBe("AVAILABLE");
  });

  it("revocation is terminal and idempotent", () => {
    const revoked = applyStatusTransition(draft, { type: "revoke" });
    expect(revoked).toEqual({ state: "REVOKED", reasonCode: "revoked" });
    const afterRevoke = applyStatusTransition(revoked, {
      type: "test",
      outcome: "ok",
      reasonCode: "none",
      testedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(afterRevoke).toEqual({ state: "REVOKED", reasonCode: "revoked" });
    expect(applyStatusTransition(revoked, { type: "revoke" })).toEqual(revoked);
  });
});

describe("parseConnectionStatus", () => {
  it("accepts a bounded projection and never secret/command-output fields", () => {
    const status = parseConnectionStatus({
      state: "AUTH_REQUIRED",
      reasonCode: "auth-required",
      testedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(status).toEqual({
      state: "AUTH_REQUIRED",
      reasonCode: "auth-required",
      testedAt: "2026-08-12T00:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toContain(SEEDED_SECRET);
    expect(JSON.stringify(status)).not.toContain("stdout");
  });

  it("rejects unknown states, reason codes, and extra fields", () => {
    expectRejected(
      () => parseConnectionStatus({ state: "RUNNING", reasonCode: "none" }),
      "RUNTIME_CONNECTION_STATUS_INVALID",
    );
    expectRejected(
      () => parseConnectionStatus({ state: "DRAFT", reasonCode: "exploded" }),
      "RUNTIME_CONNECTION_STATUS_INVALID",
    );
    expectRejected(
      () => parseConnectionStatus({ state: "DRAFT", reasonCode: "none", output: "x" }),
      "RUNTIME_CONNECTION_STATUS_INVALID",
    );
  });
});

describe("capability vocabulary coverage", () => {
  it("covers every SPEC-mandated capability key exactly once", () => {
    expect(RUNTIME_CAPABILITY_KEYS).toEqual([
      "invocation",
      "structuredResult",
      "progressEvents",
      "heartbeat",
      "cancellation",
      "artifacts",
      "observedDelegation",
      "supervisedDelegation",
      "plannerOutput",
      "verifierDecision",
      "toolActionInterception",
      "localProcessTermination",
    ]);
    expect(new Set(RUNTIME_CAPABILITY_KEYS).size).toBe(12);
  });
});

describe("hostile input at the trust boundary", () => {
  it("rejects shell metacharacters and traversal in identifier fields", () => {
    const hostile: ConnectionCapabilities = {
      invocation: { supported: true, source: "configured" },
    };
    expectRejected(
      () =>
        freezeConnectionRevision({
          connectionId: "../../etc/passwd",
          revisionNumber: 1,
          createdAt: "2026-08-12T00:00:00.000Z",
          profile: { ...baseProfile(), declaredCapabilities: hostile },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          credentialRefs: [{ kind: "env", name: "$(rm -rf /)" }],
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
    expectRejected(
      () =>
        parseConnectionProfile({
          ...baseProfile(),
          declaredCapabilities: {
            invocation: { supported: true, source: "configured", version: "0.147.0; rm -rf /" },
          },
        }),
      "RUNTIME_CONNECTION_INVALID",
    );
  });
});
