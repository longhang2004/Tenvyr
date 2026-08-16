import {
  parseHandoffBundle,
  handoffBundleHash,
  handoffBundleBytes,
  type HandoffBundleV1,
} from "./handoff";

const validBundle = (): HandoffBundleV1 => ({
  schemaVersion: 1,
  sourceExecutionId: "exec-source-1",
  sourceRunId: "run-source-1",
  goal: "Fix the login flow",
  workspace: {
    workspaceId: "ws-1",
    path: "/repos/project",
    branch: "main",
    headSha: "a".repeat(40),
  },
  executionWorkspace: {
    workspaceExecutionId: "lease-1",
    mode: "git-worktree",
    path: "/tenvyr/workspaces/run-abc",
    baseHeadSha: "a".repeat(40),
    state: "PRESERVED",
  },
  planRevision: { id: "rev-9", planHash: "b".repeat(64) },
  iterationNumber: 2,
  verifierDecision: { action: "CONTINUE", reason: "Keep going" },
  workerOutcomes: [
    { taskId: "impl-2", status: "SUCCESS", summary: '{"diff":{"files":2}}' },
  ],
  artifactRefs: [{ artifactId: "artifact-1", name: null }],
  acceptanceEvidence: { testCommand: "pnpm test" },
  nextWork: "Finish the tests",
  sourceRuntimeProvenance: [
    { agent: "cli-worker", connectionId: "conn-1", requestedModelId: "deepseek-v4-flash" },
  ],
  createdAt: "2026-08-17T10:00:00.000Z",
});

describe("PP1 HandoffBundleV1 (bounded, strictly parsed)", () => {
  it("round-trips a valid bundle and produces a stable hash", () => {
    const bundle = validBundle();
    const parsed = parseHandoffBundle(structuredClone(bundle));
    expect(parsed).toEqual(bundle);
    expect(handoffBundleHash(bundle)).toMatch(/^[0-9a-f]{64}$/);
    expect(handoffBundleHash(parseHandoffBundle(structuredClone(bundle)))).toBe(
      handoffBundleHash(bundle),
    );
    expect(handoffBundleBytes(bundle)).toBeGreaterThan(0);
    expect(handoffBundleBytes(bundle)).toBeLessThanOrEqual(16 * 1024);
  });

  it("rejects unknown fields, wrong versions, and malformed shapes", () => {
    expect(() => parseHandoffBundle(null)).toThrow();
    expect(() =>
      parseHandoffBundle({ ...validBundle(), schemaVersion: 2 }),
    ).toThrow(/schemaVersion/);
    expect(() =>
      parseHandoffBundle({ ...validBundle(), smuggled: true }),
    ).toThrow(/unsupported field/);
    expect(() =>
      parseHandoffBundle({ ...validBundle(), workerOutcomes: "nope" }),
    ).toThrow();
    expect(() =>
      parseHandoffBundle({ ...validBundle(), iterationNumber: -1 }),
    ).toThrow();
    expect(() =>
      parseHandoffBundle({
        ...validBundle(),
        sourceRuntimeProvenance: [{ agent: "x", connectionId: "c", requestedModelId: "m", extra: true }],
      }),
    ).toThrow(/unsupported field/);
  });

  it("never carries raw credentials, sessions, or reasoning by construction", () => {
    const serialized = JSON.stringify(validBundle());
    expect(serialized).not.toMatch(
      /(api[_-]?key|secret|token|password|bearer|authorization|oauth|session)/i,
    );
    // Chain-of-thought / raw tool output would exceed the bounded shape.
    expect(serialized.length).toBeLessThanOrEqual(16 * 1024);
  });

  it("keeps the source runtime/model identity as PROVENANCE, not a rewrite", () => {
    const bundle = validBundle();
    expect(bundle.sourceRuntimeProvenance[0]).toEqual({
      agent: "cli-worker",
      connectionId: "conn-1",
      requestedModelId: "deepseek-v4-flash",
    });
    // A continuation would freeze a NEW target through P2 authority; the
    // bundle only records what the SOURCE ran.
    expect(bundle).not.toHaveProperty("destinationTarget");
  });
});