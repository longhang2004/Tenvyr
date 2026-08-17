/**
 * PP1 Slice B — Attention Queue V1.
 *
 * An exception-driven READ PROJECTION over existing durable authority rows.
 * NOT a second authority system: items exist exactly while the underlying
 * durable condition exists, ids are deterministic (`attention:<kind>:<id>`)
 * so polling can never duplicate items, and "resolving" an item means using
 * the EXISTING authoritative commands (approve/deny/cancel/workspace
 * release). No attention table exists — derivation is cheap and exact.
 */

export const ATTENTION_BOUNDS = {
  reasonMax: 512,
  maxItems: 200,
} as const;

export const ATTENTION_KINDS = [
  "HUMAN_APPROVAL_REQUIRED",
  "RUN_FAILED",
  "LIMIT_REACHED",
  "WORKSPACE_REQUIRES_ATTENTION",
] as const;
export type AttentionKindV1 = (typeof ATTENTION_KINDS)[number];

export type AttentionSeverityV1 = "critical" | "warning" | "info";

export type AttentionItemV1 = {
  /** Deterministic: `attention:<kind>:<id>` — the same condition always
   *  yields the same id, so polling cannot duplicate items. */
  attentionId: string;
  kind: AttentionKindV1;
  severity: AttentionSeverityV1;
  executionId: string | null;
  runId: string | null;
  /** Short bounded operator-facing reason (never raw errors/secrets). */
  reason: string;
  createdAt: string;
  updatedAt: string;
  /** Canonical route the operator acts on (existing authority surface). */
  actionRoute: string;
  workspaceExecutionId?: string;
};

export type AttentionDerivationInput = {
  /** coordination_runs rows (phase is the authority signal). */
  runs: Array<{
    id: string;
    executionId: string;
    phase: string;
    waitReason: string | null;
    updatedAt: Date;
    createdAt: Date;
  }>;
  /** executions (status is the authority signal). */
  executions: Array<{
    id: string;
    status: string;
    terminationReason: string | null;
    updatedAt: Date;
    createdAt: Date;
  }>;
  /** approval_requests with status PENDING (durable authority rows). */
  approvalRequests: Array<{
    proposalId: string;
    actionType: string;
    targetAgent: string | null;
    targetExecutor: string | null;
    status: string;
    createdAt: Date;
  }>;
  /** workspace_executions PRESERVED with uncommitted work. */
  workspaceExecutions: Array<{
    id: string;
    ownerRunId: string | null;
    state: string;
    hasUncommittedWork: boolean | null;
    updatedAt: Date;
    createdAt: Date;
  }>;
  /** executionId -> runId for RUN_FAILED items. */
  runByExecution: Map<string, { id: string }>;
  /** runId -> executionId for workspace lease routes. */
  executionByRun: Map<string, { executionId: string }>;
};

export function attentionId(kind: AttentionKindV1, id: string): string {
  return `attention:${kind.toLowerCase()}:${id}`;
}

/** Derive the bounded attention projection from durable rows. Deterministic
 *  ids + derived-while-condition-exists semantics → no duplicates, no stale
 *  items, no invented "blocked" states. */
export function deriveAttentionItems(
  input: AttentionDerivationInput,
): AttentionItemV1[] {
  const items: AttentionItemV1[] = [];
  const push = (item: Omit<AttentionItemV1, "attentionId">) => {
    items.push({
      attentionId: attentionId(item.kind, item.runId ?? item.executionId ?? item.workspaceExecutionId ?? "?"),
      ...item,
    });
  };

  // 1. HUMAN_APPROVAL_REQUIRED — run-level WAIT (verifier/operator
  //    decision) and durable pending policy-approval requests.
  for (const run of input.runs) {
    if (run.phase !== "WAITING_FOR_HUMAN") continue;
    push({
      kind: "HUMAN_APPROVAL_REQUIRED",
      severity: "critical",
      executionId: run.executionId,
      runId: run.id,
      reason: (run.waitReason ?? "Verifier requires operator decision").slice(
        0,
        ATTENTION_BOUNDS.reasonMax,
      ),
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      actionRoute: `/runs/${run.executionId}`,
    });
  }
  for (const request of input.approvalRequests) {
    if (request.status !== "PENDING") continue;
    items.push({
      attentionId: attentionId("HUMAN_APPROVAL_REQUIRED", request.proposalId),
      kind: "HUMAN_APPROVAL_REQUIRED",
      severity: "warning",
      executionId: null,
      runId: null,
      reason: `Policy approval required: ${request.actionType}${
        request.targetAgent ? ` for ${request.targetAgent}` : ""
      }`.slice(0, ATTENTION_BOUNDS.reasonMax),
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.createdAt.toISOString(),
      actionRoute: "/approvals",
    });
  }

  // 2. RUN_FAILED — durable FAILED executions (operator CANCELLED runs are
  //    operator-driven and need no attention).
  for (const execution of input.executions) {
    if (execution.status !== "FAILED") continue;
    const run = input.runByExecution.get(execution.id);
    push({
      kind: "RUN_FAILED",
      severity: "warning",
      executionId: execution.id,
      runId: run?.id ?? null,
      reason: (
        execution.terminationReason ??
        "Worker execution failed"
      ).slice(0, ATTENTION_BOUNDS.reasonMax),
      createdAt: execution.createdAt.toISOString(),
      updatedAt: execution.updatedAt.toISOString(),
      actionRoute: `/runs/${execution.id}`,
    });
  }

  // 3. LIMIT_REACHED — the run phase is the authoritative signal.
  for (const run of input.runs) {
    if (run.phase !== "LIMIT_REACHED") continue;
    push({
      kind: "LIMIT_REACHED",
      severity: "warning",
      executionId: run.executionId,
      runId: run.id,
      reason: "Iteration or worker limits reached",
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      actionRoute: `/runs/${run.executionId}`,
    });
  }

  // 4. WORKSPACE_REQUIRES_ATTENTION — preserved execution workspace with
  //    uncommitted work (operator should inspect / release it).
  for (const lease of input.workspaceExecutions) {
    if (lease.state !== "PRESERVED" || lease.hasUncommittedWork !== true) {
      continue;
    }
    const ownerRun = lease.ownerRunId
      ? input.executionByRun.get(lease.ownerRunId)
      : undefined;
    push({
      kind: "WORKSPACE_REQUIRES_ATTENTION",
      severity: "info",
      executionId: ownerRun?.executionId ?? null,
      runId: lease.ownerRunId ?? null,
      reason:
        "Run finished with uncommitted work in its preserved execution workspace",
      createdAt: lease.createdAt.toISOString(),
      updatedAt: lease.updatedAt.toISOString(),
      actionRoute: ownerRun
        ? `/runs/${ownerRun.executionId}`
        : "/workspaces",
      workspaceExecutionId: lease.id,
    });
  }

  // Severity order: critical first, then updatedAt desc (newest first).
  const severityRank: Record<AttentionSeverityV1, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  items.sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      (left.updatedAt < right.updatedAt
        ? 1
        : left.updatedAt > right.updatedAt
          ? -1
          : left.attentionId < right.attentionId
            ? -1
            : 1),
  );
  return items.slice(0, ATTENTION_BOUNDS.maxItems);
}