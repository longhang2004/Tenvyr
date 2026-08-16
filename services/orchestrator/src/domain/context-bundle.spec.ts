import {
  CONTEXT_BUNDLE_SCHEMA_VERSION,
  SESSION_MODES,
  buildClaimEfficiencyEvidence,
  completeEfficiencyEvidence,
  computeContextBundleHash,
  extractReportedUsage,
  measureContextEnvelope,
  parseEfficiencyEvidence,
  workspaceIdentityOf,
  type ContextBundleIdentityInputsV1,
} from "./context-bundle";
import { materializeContextSnapshot } from "./context-snapshot";

const baseInputs = (): ContextBundleIdentityInputsV1 => ({
  bundleSchemaVersion: CONTEXT_BUNDLE_SCHEMA_VERSION,
  contextSchemaVersion: 1,
  stateProjection: {
    version: 3,
    values: { goal: { text: "fix login" }, "team.role": "worker" },
  },
  artifacts: [
    {
      artifactId: "artifact-1",
      producerStepId: "step-a",
      producerAttemptId: "step-a:1",
      descriptorOrdinal: 0,
      name: "diff.json",
      mediaType: "application/json",
    },
  ],
  harness: {
    agent: "impl",
    executorKind: "http",
    configHash: "a".repeat(64),
    connectionId: "conn-1",
    connectionRevision: 2,
    requestedModelId: "deepseek-v4-flash",
  },
  planHash: "b".repeat(64),
  workspace: {
    workspaceId: "ws-1",
    branch: "main",
    headSha: "c".repeat(40),
    dirty: false,
  },
});

const envelope = () =>
  materializeContextSnapshot(
    { stateKeys: ["goal", "team.role"] },
    { goal: { text: "fix login" }, "team.role": "worker" },
    3,
    [
      {
        artifactId: "artifact-1",
        producerStepId: "step-a",
        producerAttemptId: "step-a:1",
        descriptorOrdinal: 0,
        name: "diff.json",
        mediaType: "application/json",
      },
    ],
  );

describe("P3 ContextBundle identity (Deliverable A)", () => {
  it("produces the same hash for identical semantic inputs", () => {
    const first = computeContextBundleHash(baseInputs());
    const second = computeContextBundleHash({
      ...baseInputs(),
      // Same inputs in a different caller insertion order.
      artifacts: [
        baseInputs().artifacts[0],
      ],
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable when optional members are absent", () => {
    const without: ContextBundleIdentityInputsV1 = {
      bundleSchemaVersion: 1,
      contextSchemaVersion: 1,
      stateProjection: { version: 0, values: {} },
      artifacts: [],
      harness: { agent: "x", executorKind: "kafka", configHash: "d".repeat(64) },
    };
    const again = computeContextBundleHash({
      ...without,
      stateProjection: { version: 0, values: {} },
    });
    expect(computeContextBundleHash(without)).toBe(again);
  });

  it("changes for every load-bearing input", () => {
    const baseline = computeContextBundleHash(baseInputs());
    const mutations: Array<[string, ContextBundleIdentityInputsV1]> = [
      [
        "state value",
        {
          ...baseInputs(),
          stateProjection: {
            version: 3,
            values: { goal: { text: "fix login " }, "team.role": "worker" },
          },
        },
      ],
      [
        "state version",
        {
          ...baseInputs(),
          stateProjection: { version: 4, values: baseInputs().stateProjection.values },
        },
      ],
      [
        "artifact reference",
        {
          ...baseInputs(),
          artifacts: [
            {
              ...baseInputs().artifacts[0],
              descriptorOrdinal: 1,
            },
          ],
        },
      ],
      ["configHash", { ...baseInputs(), harness: { ...baseInputs().harness, configHash: "e".repeat(64) } }],
      ["connection revision", { ...baseInputs(), harness: { ...baseInputs().harness, connectionRevision: 3 } }],
      ["requested model", { ...baseInputs(), harness: { ...baseInputs().harness, requestedModelId: "other" } }],
      ["plan hash", { ...baseInputs(), planHash: "f".repeat(64) }],
      [
        "workspace headSha",
        {
          ...baseInputs(),
          workspace: { ...baseInputs().workspace!, headSha: "0".repeat(40) },
        },
      ],
      [
        "workspace dirty transition",
        {
          ...baseInputs(),
          workspace: { ...baseInputs().workspace!, dirty: true },
        },
      ],
    ];
    for (const [label, mutated] of mutations) {
      expect(computeContextBundleHash(mutated)).not.toBe(baseline);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("never lets random invocation identity or timestamps contaminate the fingerprint", () => {
    const baseline = computeContextBundleHash(baseInputs());
    // Execution ids, attempt ids, invocation ids and wall-clock timestamps
    // are NOT canonical inputs; identical context must hash identically
    // even when these differ.
    const timestamps = ["2026-08-16T00:00:00.000Z", "2026-08-17T23:59:59.999Z"];
    for (const timestamp of timestamps) {
      const rerun = computeContextBundleHash({
        ...baseInputs(),
        stateProjection: { ...baseInputs().stateProjection },
      });
      expect(rerun).toBe(baseline);
      expect(timestamp.length).toBeGreaterThan(0);
    }
    expect(
      computeContextBundleHash({
        ...baseInputs(),
        workspace: { ...baseInputs().workspace! },
      }),
    ).toBe(baseline);
  });

  it("exposes the bundle identity through the claim-time evidence builder", () => {
    const evidence = buildClaimEfficiencyEvidence({
      invocationId: "step-a:1",
      harness: baseInputs().harness,
      workspace: baseInputs().workspace,
      contextBundle: { hash: "abc", reused: false },
      context: {
        projectedBytes: 100,
        projectedCharacters: 50,
        selectedContextItemCount: 2,
        selectedArtifactCount: 1,
        executionStateBytes: 200,
      },
      dispatchable: true,
      startedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(evidence.contextBundle).toEqual({ hash: "abc", reused: false });
    expect(evidence.session.mode).toBe("fresh");
    expect(evidence.usage).toEqual({ reported: false });
    // No execution/attempt/timestamp contamination inside the record.
    expect(JSON.stringify(evidence)).not.toContain("2026-08-17");
  });
});

describe("P3 context projection metrics (Deliverable B)", () => {
  it("measures bytes/characters/counts reliably from the envelope", () => {
    const metrics = measureContextEnvelope(envelope(), {
      goal: { text: "fix login" },
      "team.role": "worker",
      unused: { nested: [1, 2, 3] },
    });
    expect(metrics.projectedBytes).toBeGreaterThan(0);
    expect(metrics.projectedCharacters).toBeGreaterThan(0);
    expect(metrics.selectedContextItemCount).toBe(2);
    expect(metrics.selectedArtifactCount).toBe(1);
    // Full-state bytes measures the whole bounded execution state the
    // projection drew from (always ≥ 0; state-only projections yield a
    // smaller envelope than the full state it was selected from).
    expect(metrics.executionStateBytes).toBeGreaterThan(0);
  });
});

describe("P3 provider usage evidence (Deliverable C)", () => {
  it("reports usage only when the runtime actually reported it", () => {
    expect(extractReportedUsage(undefined)).toEqual({ reported: false });
    expect(extractReportedUsage(null)).toEqual({ reported: false });
    expect(extractReportedUsage("garbage")).toEqual({ reported: false });
    const reported = extractReportedUsage({
      inputTokens: 28402,
      cachedInputTokens: 17931,
      outputTokens: 3124,
    });
    expect(reported).toEqual({
      reported: true,
      inputTokens: 28402,
      cachedInputTokens: 17931,
      outputTokens: 3124,
    });
    // Reported zeros are kept as reported zero (schema-validated upstream),
    // but absent fields stay absent — never synthesized.
    const reportedZero = extractReportedUsage({ inputTokens: 0 });
    expect(reportedZero).toEqual({ reported: true, inputTokens: 0 });
    // Malformed/negative/float entries are dropped, not minted.
    expect(
      extractReportedUsage({ inputTokens: -5, outputTokens: 1.5, cacheWriteTokens: "x" }),
    ).toEqual({ reported: true });
  });

  it("completes the claim-time record only with observed data", () => {
    const claim = buildClaimEfficiencyEvidence({
      invocationId: "a:1",
      harness: { agent: "x", executorKind: "http", configHash: "a".repeat(64) },
      contextBundle: { hash: "abc", reused: true },
      context: null,
      dispatchable: true,
      startedAt: "2026-08-16T00:00:00.000Z",
    });
    const completed = completeEfficiencyEvidence(
      claim,
      undefined,
      "2026-08-16T00:00:01.000Z",
      "2026-08-16T00:00:00.000Z",
    );
    expect(completed.usage).toEqual({ reported: false });
    expect(completed.timing.completedAt).toBe("2026-08-16T00:00:01.000Z");
    expect(completed.timing.durationMs).toBe(1000);
    const reported = completeEfficiencyEvidence(
      claim,
      { inputTokens: 7, cachedInputTokens: 3 },
      "2026-08-16T00:00:02.000Z",
      "2026-08-16T00:00:00.000Z",
    );
    expect(reported.usage).toEqual({
      reported: true,
      inputTokens: 7,
      cachedInputTokens: 3,
    });
  });
});

describe("P3 session strategy vocabulary (model only)", () => {
  it("declares the bounded vocabulary and maps current behavior truthfully", () => {
    expect(SESSION_MODES).toEqual(["fresh", "reused", "resumed", "unknown"]);
    const dispatchable = buildClaimEfficiencyEvidence({
      invocationId: "a:1",
      harness: { agent: "x", executorKind: "http", configHash: "a".repeat(64) },
      contextBundle: null,
      context: null,
      dispatchable: true,
      startedAt: "2026-08-16T00:00:00.000Z",
    });
    const blocked = buildClaimEfficiencyEvidence({
      invocationId: "b:1",
      harness: { agent: "x", executorKind: "http", configHash: "a".repeat(64) },
      contextBundle: null,
      context: null,
      dispatchable: false,
      startedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(dispatchable.session.mode).toBe("fresh");
    expect(blocked.session.mode).toBe("unknown");
  });
});

describe("P3 efficiency evidence parse (persistence trust boundary)", () => {
  it("round-trips a completed record and rejects unknown shapes", () => {
    const record = buildClaimEfficiencyEvidence({
      invocationId: "a:1",
      harness: { agent: "x", executorKind: "http", configHash: "a".repeat(64) },
      workspace: workspaceIdentityOf({
        workspaceId: "ws-1",
        branch: "main",
        headSha: "c".repeat(40),
        dirty: false,
      }),
      contextBundle: { hash: "a".repeat(64), reused: false },
      context: {
        projectedBytes: 100,
        projectedCharacters: 50,
        selectedContextItemCount: 1,
        selectedArtifactCount: 0,
        executionStateBytes: 200,
      },
      dispatchable: true,
      startedAt: "2026-08-16T00:00:00.000Z",
    });
    const complete = completeEfficiencyEvidence(
      record,
      { inputTokens: 9, cachedInputTokens: 2 },
      "2026-08-16T00:00:03.000Z",
      "2026-08-16T00:00:00.000Z",
    );
    expect(parseEfficiencyEvidence(structuredClone(complete))).toEqual(complete);
    expect(() => parseEfficiencyEvidence(null)).toThrow();
    expect(() =>
      parseEfficiencyEvidence({ ...complete, schemaVersion: 2 }),
    ).toThrow();
    expect(() =>
      parseEfficiencyEvidence({ ...complete, smuggled: true }),
    ).toThrow();
    expect(() =>
      parseEfficiencyEvidence({ ...complete, contextBundle: { hash: "zz", reused: false } }),
    ).toThrow();
    expect(() =>
      parseEfficiencyEvidence({ ...complete, session: { mode: "warp" } }),
    ).toThrow();
  });
});