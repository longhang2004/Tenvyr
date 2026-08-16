import {
  deriveAttentionItems,
  attentionId,
  type AttentionDerivationInput,
} from "./attention";

const base = (): AttentionDerivationInput => ({
  runs: [],
  executions: [],
  approvalRequests: [],
  workspaceExecutions: [],
  runByExecution: new Map(),
  executionByRun: new Map(),
});

const run = (id: string, phase: string, waitReason: string | null = null) => ({
  id,
  executionId: `exec-${id}`,
  phase,
  waitReason,
  updatedAt: new Date("2026-08-17T10:00:00.000Z"),
  createdAt: new Date("2026-08-17T09:00:00.000Z"),
});

const execution = (id: string, status: string, reason: string | null = null) => ({
  id,
  status,
  terminationReason: reason,
  updatedAt: new Date("2026-08-17T10:00:00.000Z"),
  createdAt: new Date("2026-08-17T09:00:00.000Z"),
});

describe("PP1 Attention derivation (read projection, no authority)", () => {
  it("derives ONE deterministic item for a WAITING_FOR_HUMAN run", () => {
    const waiting = run("r1", "WAITING_FOR_HUMAN", "Verifier requires operator decision");
    const items = deriveAttentionItems({
      ...base(),
      runs: [waiting],
      runByExecution: new Map([[waiting.executionId, waiting]]),
      executionByRun: new Map([[waiting.id, { executionId: waiting.executionId }]]),
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(items[0].attentionId).toBe(attentionId("HUMAN_APPROVAL_REQUIRED", "r1"));
    expect(items[0].actionRoute).toBe(`/runs/${waiting.executionId}`);
    // Polling repeatedly yields the same single item (no duplicates).
    const again = deriveAttentionItems({
      ...base(),
      runs: [waiting],
      runByExecution: new Map([[waiting.executionId, waiting]]),
      executionByRun: new Map([[waiting.id, { executionId: waiting.executionId }]]),
    });
    expect(again.map((item) => item.attentionId)).toEqual(
      items.map((item) => item.attentionId),
    );
  });

  it("derives items for pending approval requests and removes them once decided", () => {
    const pending = {
      proposalId: "p-1",
      actionType: "dispatch",
      targetAgent: "worker-a",
      targetExecutor: null,
      status: "PENDING",
      createdAt: new Date("2026-08-17T09:00:00.000Z"),
    };
    const items = deriveAttentionItems({ ...base(), approvalRequests: [pending] });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(items[0].reason).toContain("worker-a");
    expect(items[0].actionRoute).toBe("/approvals");
    // Resolution = the AUTHORITATIVE approval service changes the row; the
    // projection then has nothing to show (never marks authority complete).
    const decided = deriveAttentionItems({
      ...base(),
      approvalRequests: [{ ...pending, status: "APPROVED" }],
    });
    expect(decided).toHaveLength(0);
  });

  it("derives RUN_FAILED for durable FAILED executions but never for healthy or operator-cancelled runs", () => {
    const failed = execution("e-1", "FAILED", "Worker execution failed");
    const failedRun = run("r-1", "FAILED");
    const items = deriveAttentionItems({
      ...base(),
      runs: [failedRun],
      executions: [failed, execution("e-2", "COMPLETED"), execution("e-3", "CANCELLED")],
      runByExecution: new Map([[failedRun.executionId, failedRun]]),
      executionByRun: new Map([[failedRun.id, { executionId: failedRun.executionId }]]),
    });
    expect(items.map((item) => item.kind)).toEqual(["RUN_FAILED"]);
    expect(items[0].executionId).toBe("e-1");
    expect(items[0].actionRoute).toBe("/runs/e-1");
  });

  it("derives LIMIT_REACHED from the run phase", () => {
    const limited = run("r-9", "LIMIT_REACHED");
    const items = deriveAttentionItems({
      ...base(),
      runs: [limited],
      runByExecution: new Map([[limited.executionId, limited]]),
      executionByRun: new Map([[limited.id, { executionId: limited.executionId }]]),
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("LIMIT_REACHED");
    expect(items[0].reason).toContain("limits reached");
  });

  it("derives WORKSPACE_REQUIRES_ATTENTION only for PRESERVED leases with uncommitted work", () => {
    const preserved = {
      id: "lease-1",
      ownerRunId: "r-1",
      state: "PRESERVED",
      hasUncommittedWork: true,
      updatedAt: new Date("2026-08-17T10:00:00.000Z"),
      createdAt: new Date("2026-08-17T09:00:00.000Z"),
    };
    const items = deriveAttentionItems({
      ...base(),
      workspaceExecutions: [
        preserved,
        { ...preserved, id: "lease-clean", hasUncommittedWork: false },
        { ...preserved, id: "lease-inuse", state: "IN_USE" },
      ],
      executionByRun: new Map([["r-1", { executionId: "exec-r-1" }]]),
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("WORKSPACE_REQUIRES_ATTENTION");
    expect(items[0].workspaceExecutionId).toBe("lease-1");
    expect(items[0].actionRoute).toBe("/runs/exec-r-1");
  });

  it("never creates false attention for healthy RUNNING runs", () => {
    const healthy = run("r-ok", "WORKING");
    const items = deriveAttentionItems({
      ...base(),
      runs: [healthy, run("r-plan", "PLANNING"), run("r-verify", "VERIFYING")],
      executions: [
        execution("exec-r-ok", "RUNNING"),
        execution("exec-r-plan", "RUNNING"),
        execution("exec-r-verify", "RUNNING"),
      ],
      runByExecution: new Map(),
      executionByRun: new Map(),
    });
    expect(items).toHaveLength(0);
  });

  it("orders critical attention first and bounds the list", () => {
    const waiting = run("r-w", "WAITING_FOR_HUMAN");
    const failedRun = run("r-f", "FAILED");
    const inputs: AttentionDerivationInput = {
      ...base(),
      runs: [waiting, failedRun],
      executions: [execution(failedRun.executionId, "FAILED")],
      runByExecution: new Map([[failedRun.executionId, failedRun]]),
      executionByRun: new Map([
        [waiting.id, { executionId: waiting.executionId }],
        [failedRun.id, { executionId: failedRun.executionId }],
      ]),
    };
    const items = deriveAttentionItems(inputs);
    expect(items[0].kind).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(items[1].kind).toBe("RUN_FAILED");
  });
});