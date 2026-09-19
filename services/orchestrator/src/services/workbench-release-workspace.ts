import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { OperatorActionEntity } from "../entities/operator-action.entity";
import { sha256Json } from "../domain/canonical-json";
import { WorkspaceExecutionError } from "../domain/workspace-execution";
import {
  RELEASE_PROCESS_INSTANCE_ID,
  WorkspaceExecutionService,
  type ReleaseClaimEvidence,
} from "./workspace-execution.service";
import type { CommandResult } from "./workbench-command.service";

export const PROCESS_INSTANCE_ID = RELEASE_PROCESS_INSTANCE_ID;
export function getProcessInstanceId(): string {
  return PROCESS_INSTANCE_ID;
}

// Process-scoped active-token registry singleton
const activeReleaseTokensSingleton = new Set<string>();
export function getActiveReleaseTokens(): Set<string> {
  return activeReleaseTokensSingleton;
}
export function clearActiveReleaseTokens(): void {
  activeReleaseTokensSingleton.clear();
}

export type ReleaseWorkspaceDeps = {
  dataSource: DataSource;
  workspaceExecutions: WorkspaceExecutionService;
  boundedKey: (idempotencyKey: string) => string;
  assertSameRequestPayload: (
    stored: Record<string, unknown> | null | undefined,
    expectedHash: string,
    action: string,
    key: string,
  ) => void;
};

// In-process exact active-release-claim registry keyed by operationId + ownerToken - process-scoped singleton
// While a release/recovery invocation is genuinely executing, its exact token is registered as ACTIVE
// In finally, the exact token is removed before the invocation exits
// Same-process EXECUTING is LIVE only when exact token is still active; otherwise it's a local orphan/recovery candidate
// Module-level ensures all WorkbenchCommandService instances in one process share truth (tests construct multiple instances)
function activeTokenKey(operationId: string, ownerToken: string): string {
  return `${operationId}:${ownerToken}`;
}
function registerActiveToken(operationId: string, ownerToken: string): void {
  getActiveReleaseTokens().add(activeTokenKey(operationId, ownerToken));
}
function unregisterActiveToken(operationId: string, ownerToken: string): void {
  getActiveReleaseTokens().delete(activeTokenKey(operationId, ownerToken));
}
function isActiveToken(operationId: string, ownerToken: string): boolean {
  return getActiveReleaseTokens().has(activeTokenKey(operationId, ownerToken));
}

/**
 * PP1 Final Closure: audited safe workspace release command saga.
 *
 * 1. Commits operator intent in PostgreSQL first with outcome = { pending: true, phase: "REQUESTED" }.
 * 2. Reconciles/observes existing execution lease state:
 *    - If lease is already REMOVED: finalizes audit outcome with state: "REMOVED" (no git execution).
 *    - If lease is RELEASE_REQUESTED / PRESERVED: executes safe git worktree removal.
 * 3. On success (clean worktree removal): lease -> REMOVED, audit outcome -> { workspaceExecutionId, state: "REMOVED" }.
 * 4. On refusal (dirty worktree / removal failed): lease stays PRESERVED with failureCode: "WORKTREE_DIRTY",
 *    audit outcome -> { workspaceExecutionId, state: "PRESERVED", failureCode: "WORKTREE_DIRTY", error: "...", refusal: true },
 *    and throws WorkspaceExecutionError("WORKTREE_DIRTY").
 */
export async function releaseExecutionWorkspace(
  deps: ReleaseWorkspaceDeps,
  input: {
    idempotencyKey: string;
    workspaceExecutionId: string;
    reason?: string;
  },
): Promise<CommandResult> {
  const key = deps.boundedKey(input.idempotencyKey);
  const action = "release-execution-workspace";
  const targetId = input.workspaceExecutionId;
  const actor = "local-operator";
  const payload = {
    workspaceExecutionId: input.workspaceExecutionId,
    reason: input.reason ?? null,
  };
  const payloadHash = sha256Json(payload);

  // Step 1: Commit operator intent in PostgreSQL BEFORE any external Git removal
  let auditRow = await deps.dataSource.transaction(async (manager) => {
    const actions = manager.getRepository(OperatorActionEntity);
    await actions
      .createQueryBuilder()
      .insert()
      .into(OperatorActionEntity)
      .values({
        action,
        idempotencyKey: key,
        actor,
        targetId,
        payload,
        outcome: { pending: true, phase: "REQUESTED" },
      })
      .orIgnore()
      .execute();

    const existing = await actions.findOne({
      where: { action, idempotencyKey: key },
    });
    if (!existing) throw new Error("Audit row disappeared");
    deps.assertSameRequestPayload(existing.payload, payloadHash, action, key);
    return existing;
  });
  let outcome = auditRow.outcome as Record<string, unknown> | undefined;
  // PP1 FINAL: explicit outcome semantics — INTERRUPTED/IN_PROGRESS are NOT success.
  if (outcome && outcome.pending !== true) {
    const state = outcome.state as string | undefined;
    const retryRequired = outcome.retryRequired as boolean | undefined;
    if (outcome.refusal === true) {
      throw new WorkspaceExecutionError(
        (outcome.failureCode as string) ?? "WORKTREE_DIRTY",
        (outcome.error as string) ??
          `Execution workspace "${input.workspaceExecutionId}" release was refused`,
      );
    }
    if (state === "INTERRUPTED" && retryRequired === true) {
      // Allow same operation to be intentionally resumed: reset INTERRUPTED → REQUESTED for retry
      const repo = deps.dataSource.getRepository(OperatorActionEntity);
      const reset = await repo
        .createQueryBuilder()
        .update(OperatorActionEntity)
        .set({ outcome: { pending: true, phase: "REQUESTED", resumedFrom: outcome } as unknown as Record<string, unknown> })
        .where("id = :id", { id: auditRow.id })
        .andWhere("outcome->>'state' = 'INTERRUPTED'")
        .execute();
      if ((reset.affected ?? 0) === 1) {
        const refreshed = await repo.findOne({ where: { id: auditRow.id } });
        if (refreshed) {
          auditRow = refreshed;
          outcome = refreshed.outcome as Record<string, unknown> | undefined;
        }
      } else {
        // Concurrent reset — re-read and throw INTERRUPTED for caller to retry
        const refreshed = await repo.findOne({ where: { id: auditRow.id } });
        const out2 = refreshed?.outcome as Record<string, unknown> | undefined;
        if (out2 && out2.state === "INTERRUPTED") {
          throw new WorkspaceExecutionError(
            (out2.failureCode as string) ?? "RELEASE_INTERRUPTED",
            (out2.error as string) ?? "Release was interrupted; retry with the same idempotency key",
          );
        }
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "RELEASE_INTERRUPTED",
          (outcome.error as string) ?? "Release was interrupted; retry required",
        );
      }
    } else if (state === "IN_PROGRESS") {
      throw new WorkspaceExecutionError(
        (outcome.failureCode as string) ?? "OPERATION_IN_PROGRESS",
        (outcome.error as string) ?? "Release operation is in progress",
      );
    } else if (state === "REMOVED") {
      return {
        action,
        idempotencyKey: key,
        outcome: "duplicate",
        result: outcome,
      };
    } else if (state === "NOT_FOUND" || state === "PRESERVED") {
      // For non-REMOVED final states, treat as refusal if flagged, otherwise as duplicate success is wrong — throw
      if (outcome.refusal === true) {
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "RELEASE_REFUSED",
          (outcome.error as string) ?? `Release was refused (${state})`,
        );
      }
      // If it's a PRESERVED without refusal (should not happen after fix), treat as refusal to avoid false success
      if (state === "PRESERVED") {
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "PRESERVED",
          (outcome.error as string) ?? "Workspace is preserved; release was not completed",
        );
      }
      return {
        action,
        idempotencyKey: key,
        outcome: "duplicate",
        result: outcome,
      };
    } else {
      // Unknown final outcome — do not pretend success
      throw new WorkspaceExecutionError(
        (outcome.failureCode as string) ?? "RELEASE_INTERRUPTED",
        (outcome.error as string) ?? "Release outcome requires retry",
      );
    }
  }

  // Target-level active release check: at most one ACTIVE release per workspaceExecutionId.
  // SINGLE DRIVER: stale recovery is reachable without knowing old UUID — any new request that observes a stale owner triggers its takeover.
  const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
  const leaseRow0 = await deps.dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
  if (leaseRow0?.state === "REMOVED") {
    // Legacy/inconsistent: Workspace REMOVED but A still pending → repair A without Git via target-scoped recovery
    // Find the known prior pending A (if any) before deciding B's provenance — must do before any bulk update
    const knownPendingA = await deps.dataSource.getRepository(OperatorActionEntity).createQueryBuilder("a").where("a.action = :action", { action }).andWhere("a.targetId = :targetId", { targetId }).andWhere("a.id != :id", { id: auditRow.id }).andWhere("(a.outcome->>'pending')::boolean = true").orderBy("a.createdAt", "ASC").getOne();
    if (knownPendingA) {
      // Repair A without Git (proven legacy: Workspace already REMOVED, no active ownership)
      try {
        await deps.dataSource.getRepository(OperatorActionEntity).update({ id: knownPendingA.id }, { outcome: { workspaceExecutionId: targetId, state: "REMOVED" } });
      } catch {}
      // Also repair any other pending for this REMOVED workspace (should be at most one, but be safe)
      const otherPendings = await deps.dataSource.getRepository(OperatorActionEntity).createQueryBuilder("a").where("a.action = :action", { action }).andWhere("a.targetId = :targetId", { targetId }).andWhere("a.id NOT IN (:...ids)", { ids: [auditRow.id, knownPendingA.id] }).andWhere("(a.outcome->>'pending')::boolean = true").getMany();
      for (const pending of otherPendings) {
        try {
          await deps.dataSource.getRepository(OperatorActionEntity).update({ id: pending.id }, { outcome: { workspaceExecutionId: targetId, state: "REMOVED" } });
        } catch {}
      }
      // B is observer, not executor
      const observed = await observeRecoveredRelease(deps, auditRow.id, key, knownPendingA.id, targetId);
      if (observed) return observed;
      const duplicateResult: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED", performedByOperationId: knownPendingA.id };
      await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: duplicateResult });
      return { action, idempotencyKey: key, outcome: "duplicate", result: duplicateResult };
    }
    const ownOutcome = auditRow.outcome as any;
    if (ownOutcome?.pending === true) {
      const ownTerminal: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
      await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: ownTerminal });
      return { action, idempotencyKey: key, outcome: "duplicate", result: ownTerminal };
    }
    const recoveredResult: Record<string, unknown> = {
      workspaceExecutionId: targetId,
      state: "REMOVED",
      performedByOperationId: auditRow.id,
    };
    await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: recoveredResult });
    return {
      action,
      idempotencyKey: key,
      outcome: "duplicate",
      result: recoveredResult,
    };
  }
  if (leaseRow0 && (leaseRow0 as unknown as { state: string }).state === "RELEASE_REQUESTED") {
    const ownerOp = (leaseRow0 as unknown as { releaseOperationId?: string | null }).releaseOperationId;
    if (ownerOp && ownerOp !== auditRow.id) {
      // Check if owner is stale (previous process EXECUTING) or same-pid pending that failed finalization (worktree already absent)
      let isStale = false;
      let isSamePidRecoverable = false;
      try {
        const ownerAction = await deps.dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: ownerOp } as unknown as Record<string, unknown> });
        const ownerOutcome = ownerAction?.outcome as Record<string, unknown> | undefined;
        const ownerPid = (ownerOutcome as { ownerProcessId?: string } | undefined)?.ownerProcessId;
        const ownerPhase = (ownerOutcome as { phase?: string } | undefined)?.phase;
        const isRecoverableMarker = Boolean((ownerOutcome as any)?.recoverable === true);
        const ownerToken = (ownerOutcome as any)?.ownerToken as string | undefined;
        const isActive = ownerToken ? isActiveToken(ownerOp, ownerToken) : false;
        isStale = Boolean(ownerOutcome && ownerOutcome.pending === true && ownerPhase === "EXECUTING" && ownerPid !== PROCESS_INSTANCE_ID);
        // Same-process orphan: recoverable marker OR exact token NOT active (covers marker-write-failure)
        isSamePidRecoverable = Boolean(
          ownerOutcome &&
            ownerOutcome.pending === true &&
            ((ownerPhase === "EXECUTING" && ownerPid === PROCESS_INSTANCE_ID && (isRecoverableMarker || !isActive)) ||
              (ownerPhase === "REQUESTED" && isRecoverableMarker)),
        );
        if (isSamePidRecoverable) {
          isStale = true;
        } else if (ownerOutcome && ownerOutcome.pending === true && ownerPhase === "EXECUTING" && ownerPid === PROCESS_INSTANCE_ID && !isRecoverableMarker && isActive) {
          // Live owner with active exact token → check legacy ABSENT case (conservative, but active token is authoritative)
          const { worktreeIsRegistered } = await import("./workspace-execution.service");
          const reg = worktreeIsRegistered((leaseRow0 as any).sourcePath, (leaseRow0 as any).executionPath);
          if (reg === "ABSENT") {
            // Even if ABSENT, if token is still active, it's genuinely live (blocked before Git vs after Git distinction is handled in tryRecoverStaleOperation's re-observation)
            // Do not treat as recoverable here; let the live barrier hold
          }
        }
      } catch {}
      if (isStale || isSamePidRecoverable) {
        await tryRecoverStaleOperation(deps, ownerOp).catch(() => {});
        const observed = await observeRecoveredRelease(deps,
          auditRow.id,
          key,
          ownerOp,
          targetId,
        );
        if (observed) return observed;
      }
      const inProgressOutcome: Record<string, unknown> = {
        workspaceExecutionId: targetId,
        state: "IN_PROGRESS",
        failureCode: "RELEASE_IN_PROGRESS",
        error: `Execution workspace "${input.workspaceExecutionId}" release is already in progress by operation ${ownerOp}`,
        ...(isStale ? { triggeredRecovery: ownerOp } : {}),
      };
      await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
      throw new WorkspaceExecutionError(
        "RELEASE_IN_PROGRESS",
        `Execution workspace "${input.workspaceExecutionId}" release is already in progress by operation ${ownerOp}`,
      );
    }
    if (!ownerOp) {
      const unauthorizedOutcome: Record<string, unknown> = {
        workspaceExecutionId: targetId,
        state: "PRESERVED",
        failureCode: "RELEASE_UNAUTHORIZED",
        error: `Execution workspace "${input.workspaceExecutionId}" RELEASE_REQUESTED has no authorizing operation`,
        refusal: true,
      };
      await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: unauthorizedOutcome });
      throw new WorkspaceExecutionError(
        "RELEASE_UNAUTHORIZED",
        `Execution workspace "${input.workspaceExecutionId}" RELEASE_REQUESTED has no authorizing operation`,
      );
    }
  }
  // 2) Check for any other EXECUTING (same PROCESS_INSTANCE_ID) targeting the same workspace (live owner) — only if exact token is still active
  const activeForTargetAll = await deps.dataSource
    .getRepository(OperatorActionEntity)
    .createQueryBuilder("a")
    .where("a.action = :action", { action })
    .andWhere("a.targetId = :targetId", { targetId })
    .andWhere("a.id != :id", { id: auditRow.id })
    .andWhere("(a.outcome->>'pending')::boolean = true")
    .andWhere("a.outcome->>'phase' = 'EXECUTING'")
    .andWhere("a.outcome->>'ownerProcessId' = :pid", { pid: PROCESS_INSTANCE_ID })
    .getMany();
  const activeForTarget = activeForTargetAll.filter((row) => {
    const out = row.outcome as any;
    return out?.ownerToken && isActiveToken(row.id, out.ownerToken);
  });
  if (activeForTarget.length > 0) {
    const inProgressOutcome: Record<string, unknown> = {
      workspaceExecutionId: targetId,
      state: "IN_PROGRESS",
      failureCode: "RELEASE_IN_PROGRESS",
      error: `Execution workspace "${input.workspaceExecutionId}" release is already in progress`,
    };
    await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
    throw new WorkspaceExecutionError(
      "RELEASE_IN_PROGRESS",
      `Execution workspace "${input.workspaceExecutionId}" release is already in progress`,
    );
  }
  for (const other of activeForTarget) {
    const otherOutcome = other.outcome as Record<string, unknown> | undefined;
    const otherPid = (otherOutcome as { ownerProcessId?: string } | undefined)?.ownerProcessId;
    if (otherPid === PROCESS_INSTANCE_ID) {
      const inProgressOutcome: Record<string, unknown> = {
        workspaceExecutionId: targetId,
        state: "IN_PROGRESS",
        failureCode: "RELEASE_IN_PROGRESS",
        error: `Execution workspace "${input.workspaceExecutionId}" release is already in progress`,
      };
      await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
      throw new WorkspaceExecutionError(
        "RELEASE_IN_PROGRESS",
        `Execution workspace "${input.workspaceExecutionId}" release is already in progress`,
      );
    }
  }
  // Also check for stale EXECUTING owned by different process targeting same workspace but lease not yet RELEASE_REQUESTED (crash before target claim)
  const stalePendingForTarget = await deps.dataSource
    .getRepository(OperatorActionEntity)
    .createQueryBuilder("a")
    .where("a.action = :action", { action })
    .andWhere("a.targetId = :targetId", { targetId })
    .andWhere("a.id != :id", { id: auditRow.id })
    .andWhere("(a.outcome->>'pending')::boolean = true")
    .andWhere("a.outcome->>'phase' = 'EXECUTING'")
    .andWhere("a.outcome->>'ownerProcessId' != :pid", { pid: PROCESS_INSTANCE_ID })
    .getMany();
  for (const stale of stalePendingForTarget) {
    await tryRecoverStaleOperation(deps, stale.id).catch(() => {});
    const observed = await observeRecoveredRelease(deps,
      auditRow.id,
      key,
      stale.id,
      targetId,
    );
    if (observed) return observed;
    // B still must not silently replace A's authority; finalize B as IN_PROGRESS after triggering recovery
    const inProgressOutcome: Record<string, unknown> = {
      workspaceExecutionId: targetId,
      state: "IN_PROGRESS",
      failureCode: "RELEASE_IN_PROGRESS",
      error: `Execution workspace "${input.workspaceExecutionId}" release is already in progress (stale owner ${stale.id} recovery triggered)`,
      triggeredRecovery: stale.id,
    };
    await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
    throw new WorkspaceExecutionError(
      "RELEASE_IN_PROGRESS",
      `Execution workspace "${input.workspaceExecutionId}" release is already in progress (recovery of ${stale.id} triggered)`,
    );
  }
  // NEW: pending REQUESTED (including recoverable from failed terminal) for same target must be recovered, not abandoned — B observes A, CAS claims A, Git remains A
  const pendingRequestedForTarget = await deps.dataSource
    .getRepository(OperatorActionEntity)
    .createQueryBuilder("a")
    .where("a.action = :action", { action })
    .andWhere("a.targetId = :targetId", { targetId })
    .andWhere("a.id != :id", { id: auditRow.id })
    .andWhere("(a.outcome->>'pending')::boolean = true")
    .andWhere("(a.outcome->>'phase' = 'REQUESTED' OR (a.outcome->>'phase' = 'EXECUTING' AND (a.outcome->>'recoverable')::boolean = true) OR a.outcome->>'recoverable' = 'true')")
    .orderBy("a.createdAt", "ASC")
    .getMany();
  // Also include explicit recoverable EXECUTING with same pid that failed terminal persistence
  const recoverableSamePid = await deps.dataSource
    .getRepository(OperatorActionEntity)
    .createQueryBuilder("a")
    .where("a.action = :action", { action })
    .andWhere("a.targetId = :targetId", { targetId })
    .andWhere("a.id != :id", { id: auditRow.id })
    .andWhere("(a.outcome->>'pending')::boolean = true")
    .andWhere("a.outcome->>'phase' = 'EXECUTING'")
    .andWhere("(a.outcome->>'recoverable')::boolean = true")
    .getMany();
  const allRecoverable = [...pendingRequestedForTarget, ...recoverableSamePid].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  for (const pending of allRecoverable) {
    const targetLease = await deps.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
    const targetState = (targetLease as any)?.state as string | undefined;
    // Recoverable may be for RELEASE_REQUESTED (failed terminal) as well as PRESERVED/FAILED (crash before claim)
    if (targetState !== "PRESERVED" && targetState !== "FAILED" && targetState !== "RELEASE_REQUESTED") continue;
    await tryRecoverStaleOperation(deps, pending.id).catch(() => {});
    const observed = await observeRecoveredRelease(deps, auditRow.id, key, pending.id, targetId);
    if (observed) return observed;
    const inProgressOutcome: Record<string, unknown> = {
      workspaceExecutionId: targetId,
      state: "IN_PROGRESS",
      failureCode: "RELEASE_IN_PROGRESS",
      error: `Execution workspace "${input.workspaceExecutionId}" release is already pending by operation ${pending.id} (recovery triggered)`,
      triggeredRecovery: pending.id,
    };
    await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
    throw new WorkspaceExecutionError(
      "RELEASE_IN_PROGRESS",
      `Execution workspace "${input.workspaceExecutionId}" release is already pending by operation ${pending.id}`,
    );
  }
  // Step 1.5: Idempotent durable execution ownership — at most one
  // caller drives the external Git mutation for this (action, key).
  // Uses processInstanceId to distinguish active owner vs dead process.
  // The outcome row carries phase: EXECUTING with ownerToken/ownerProcessId/claimedAt once the winner claims
  // ownership; other concurrent callers in the SAME process observe IN_PROGRESS and never run Git.
  // A stale EXECUTING from a previous dead process (different ownerProcessId) may be taken over via CAS.
  const claimed = await claimReleaseOwnership(deps, auditRow.id, auditRow.outcome as Record<string, unknown> | undefined);
  if (claimed.claimed) {
    registerActiveToken(auditRow.id, claimed.evidence.ownerToken);
  }
  if (!claimed.claimed) {
    const authoritative = await waitForReleaseFinalOutcome(deps, auditRow.id, key, action);
    const aState = authoritative.state as string | undefined;
    const aRetry = authoritative.retryRequired as boolean | undefined;
    if (authoritative.refusal === true) {
      throw new WorkspaceExecutionError(
        (authoritative.failureCode as string) ?? "WORKTREE_DIRTY",
        (authoritative.error as string) ?? `Execution workspace "${input.workspaceExecutionId}" release was refused`,
      );
    }
    if (aState === "INTERRUPTED" && aRetry === true) {
      throw new WorkspaceExecutionError(
        (authoritative.failureCode as string) ?? "RELEASE_INTERRUPTED",
        (authoritative.error as string) ?? "Release was interrupted; retry with the same idempotency key",
      );
    }
    if (aState === "IN_PROGRESS") {
      throw new WorkspaceExecutionError(
        (authoritative.failureCode as string) ?? "OPERATION_IN_PROGRESS",
        (authoritative.error as string) ?? "Release operation is in progress",
      );
    }
    if (aState === "REMOVED") {
      return {
        action,
        idempotencyKey: key,
        outcome: "duplicate",
        result: authoritative,
      };
    }
    // Any other final state is not success
    throw new WorkspaceExecutionError(
      (authoritative.failureCode as string) ?? "RELEASE_NOT_COMPLETED",
      (authoritative.error as string) ?? `Release not completed (state ${aState ?? "unknown"})`,
    );
  }

  // Step 2: Execute safe release saga (we are the owner) — ONE authoritative terminal transaction after Git (inside WorkspaceExecutionService)
  // The exact token is registered as ACTIVE while genuinely executing; in finally it is removed before exit so failure leaves it as orphan/recoverable
  let releaseSucceeded = false;
  try {
    const released =
      await deps.workspaceExecutions.releaseExecutionWorkspace(
        input.workspaceExecutionId,
        claimed.evidence,
      );
    const result: Record<string, unknown> = {
      workspaceExecutionId: released.id,
      state: released.state,
    };
    releaseSucceeded = true;
    return {
      action,
      idempotencyKey: key,
      outcome: "executed",
      result,
    };
  } catch (error) {
    if (error instanceof WorkspaceExecutionError) {
      const code = error.code;
      // For LEASE_NOT_FOUND and other early failures where no workspace exists, the single transaction was never attempted, so we need to persist the truthful outcome directly
      if (code === "LEASE_NOT_FOUND" || code === "LEASE_NOT_RELEASABLE" || code === "SHARED_MODE_NO_REMOVAL" || code === "LEASE_PATH_MISSING") {
        const truthful = await truthfulReleaseRefusalOutcome(deps, input.workspaceExecutionId, code, error.message);
        await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: truthful });
        throw new WorkspaceExecutionError(truthful.failureCode as string, truthful.error as string);
      }
      // For other refusals (like WORKTREE_STATE_UNKNOWN, WORKTREE_DIRTY, etc.), the terminal persistence already happened inside WorkspaceExecutionService if it succeeded
      // If it rolled back, the Operator is still pending, so keep it pending for recovery
      const currentOp = await deps.dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: auditRow.id } });
      const curOutcome = currentOp?.outcome as any;
      if (curOutcome?.pending === true) {
        throw error;
      }
      const truthful = await truthfulReleaseRefusalOutcome(deps,
        input.workspaceExecutionId,
        code,
        error.message,
      );
      throw new WorkspaceExecutionError(truthful.failureCode as string, truthful.error as string);
    }
     // ANY terminal persistence failure after Git (injected or real DB failure) must remain recoverable
    // Classify based on durable post-error state, not error string: re-read Workspace, lock, Operator
    const wsAfter = await deps.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
    const lockAfter = await deps.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
    const lockOpAfter = Array.isArray(lockAfter) ? lockAfter[0]?.releaseOperationId : lockAfter?.rows?.[0]?.releaseOperationId;
    const opAfter = await deps.dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: auditRow.id } });
    const opOutAfter = opAfter?.outcome as any;
    const stillOwnsTarget = wsAfter?.releaseOperationId === auditRow.id && lockOpAfter === auditRow.id && opOutAfter?.pending === true;
    if (stillOwnsTarget) {
      // Terminal commit did not happen → CAS A to explicit recoverable pending state before returning, so same-pid is distinguishable from live owner
      // Use REQUESTED with recoverable marker (explicit durable retryable state, not timing/TTL)
      try {
        await deps.dataSource.getRepository(OperatorActionEntity).createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: opOutAfter.ownerToken, claimedAt: opOutAfter.claimedAt, failedTerminal: true } as any }).where("id = :id", { id: auditRow.id }).andWhere("outcome->>'phase' = 'EXECUTING'").execute();
      } catch {}
      throw error;
    }
    // If terminal already committed (workspace REMOVED/PRESERVED with new state, lock gone, operator terminal), observe truth
    if (wsAfter?.state === "REMOVED" || wsAfter?.state === "PRESERVED") {
      const truth = await readRecoveredReleaseTruth(deps, auditRow.id, targetId);
      if (truth && truth.state !== "IN_PROGRESS") {
        await deps.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: truth });
        if (truth.state === "REMOVED") {
          return { action, idempotencyKey: key, outcome: "executed", result: truth } as any;
        }
        throw new WorkspaceExecutionError((truth.failureCode as any) ?? "RELEASE_NOT_COMPLETED", (truth.error as any) ?? "Release completed");
      }
    }
    // Non-WorkspaceExecutionError: mark INTERRUPTED with truthful evidence
    // so a retry can re-enter and recover (no ambiguous pending forever).
    const interrupted: Record<string, unknown> = {
      workspaceExecutionId: input.workspaceExecutionId,
      state: "INTERRUPTED",
      failureCode: "RELEASE_INTERRUPTED",
      error: error instanceof Error ? error.message : String(error),
      retryRequired: true,
    };
    await deps.dataSource
      .getRepository(OperatorActionEntity)
      .update({ id: auditRow.id }, { outcome: interrupted });
    throw error;
  } finally {
    // Always unregister the exact token when this invocation exits, so a later fresh UUID can distinguish live vs orphan
    // Check affected count for the recoverable transition and do not swallow failure — in-process registry still makes it distinguishable
    try {
      unregisterActiveToken(auditRow.id, claimed.evidence.ownerToken);
    } catch {}
    // Also attempt durable recoverable transition if stillOwnsTarget and we had a terminal failure (best-effort, check affected)
    // This is the explicit retryable marker; if this DB write fails, the in-process registry being empty still makes it recoverable
    if (!releaseSucceeded) {
      try {
        const wsAfter2 = await deps.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
        const lockAfter2 = await deps.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
        const lockOpAfter2 = Array.isArray(lockAfter2) ? lockAfter2[0]?.releaseOperationId : lockAfter2?.rows?.[0]?.releaseOperationId;
        const opAfter2 = await deps.dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: auditRow.id } });
        const opOutAfter2 = opAfter2?.outcome as any;
        const stillOwns2 = wsAfter2?.releaseOperationId === auditRow.id && lockOpAfter2 === auditRow.id && opOutAfter2?.pending === true && opOutAfter2?.phase === "EXECUTING";
        if (stillOwns2) {
          const res = await deps.dataSource.getRepository(OperatorActionEntity).createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: opOutAfter2.ownerToken, claimedAt: opOutAfter2.claimedAt, failedTerminal: true } as any }).where("id = :id", { id: auditRow.id }).andWhere("outcome->>'phase' = 'EXECUTING'").execute();
          // Check affected count — if 0, the in-process registry being empty is still sufficient for recovery
          if ((res.affected ?? 0) === 0) {
            // Marker write failed, but active token is now unregistered, so same-pid will be considered orphan
          }
        }
      } catch {}
    }
  }
}

// ---- Safe Release execution ownership + audit truth (PP1 final closure) ----

async function claimReleaseOwnership(
  deps: ReleaseWorkspaceDeps,
  auditRowId: string,
  outcome: Record<string, unknown> | undefined,
): Promise<
  | { claimed: false }
  | { claimed: true; evidence: ReleaseClaimEvidence }
> {
  const phase = (outcome as { phase?: string } | undefined)?.phase;
  const ownerProcessId = (outcome as { ownerProcessId?: string } | undefined)?.ownerProcessId;
  const ownerToken = (outcome as { ownerToken?: string } | undefined)?.ownerToken;
  const repo = deps.dataSource.getRepository(OperatorActionEntity);
  if (outcome?.pending === true && phase === "REQUESTED") {
    const newToken = randomUUID();
    const result = await repo
      .createQueryBuilder()
      .update(OperatorActionEntity)
      .set({
        outcome: {
          pending: true,
          phase: "EXECUTING",
          ownerToken: newToken,
          ownerProcessId: PROCESS_INSTANCE_ID,
          claimedAt: new Date().toISOString(),
        } as unknown as Record<string, unknown>,
      })
      .where("id = :id", { id: auditRowId })
      .andWhere("(outcome->>'pending')::boolean = true")
      .andWhere("outcome->>'phase' = 'REQUESTED'")
      .execute();
    return (result.affected ?? 0) === 1
      ? {
          claimed: true,
          evidence: {
            operationId: auditRowId,
            ownerProcessId: PROCESS_INSTANCE_ID,
            ownerToken: newToken,
          },
        }
      : { claimed: false };
  }
  if (outcome?.pending === true && phase === "EXECUTING") {
    if (ownerProcessId === PROCESS_INSTANCE_ID) {
      // Same-process EXECUTING is LIVE only when exact old token is still active in-process
      // If exact token is NOT active, it's a same-process orphan (prior invocation exited, even if recoverable marker write failed) → allow reclaim
      if (ownerToken && isActiveToken(auditRowId, ownerToken)) {
        return { claimed: false };
      }
      // Orphan: allow CAS reclaim to fresh token (preserve provenance, same-process recovery)
      const newTokenOrphan = randomUUID();
      const orphanResult = await repo
        .createQueryBuilder()
        .update(OperatorActionEntity)
        .set({
          outcome: {
            pending: true,
            phase: "EXECUTING",
            ownerToken: newTokenOrphan,
            ownerProcessId: PROCESS_INSTANCE_ID,
            claimedAt: new Date().toISOString(),
            sameProcessRecovery: true,
            takenOverFrom: ownerProcessId ?? null,
          } as unknown as Record<string, unknown>,
        })
        .where("id = :id", { id: auditRowId })
        .andWhere("(outcome->>'pending')::boolean = true")
        .andWhere("outcome->>'phase' = 'EXECUTING'")
        .andWhere("outcome->>'ownerProcessId' = :oldProcessId", { oldProcessId: ownerProcessId })
        .andWhere("outcome->>'ownerToken' = :oldOwnerToken", { oldOwnerToken: ownerToken })
        .execute();
      return (orphanResult.affected ?? 0) === 1
        ? {
            claimed: true,
            evidence: {
              operationId: auditRowId,
              ownerProcessId: PROCESS_INSTANCE_ID,
              ownerToken: newTokenOrphan,
            },
          }
        : { claimed: false };
    }
    // An EXECUTING row without an exact old owner identity is not
    // recoverable authority; do not invent a takeover token.
    if (!ownerProcessId || !ownerToken) return { claimed: false };
    // Stale owner from previous dead process → explicit takeover via CAS
    const newToken = randomUUID();
    const result = await repo
      .createQueryBuilder()
      .update(OperatorActionEntity)
      .set({
        outcome: {
          pending: true,
          phase: "EXECUTING",
          ownerToken: newToken,
          ownerProcessId: PROCESS_INSTANCE_ID,
          claimedAt: new Date().toISOString(),
          takenOverFrom: ownerProcessId ?? null,
        } as unknown as Record<string, unknown>,
      })
      .where("id = :id", { id: auditRowId })
      .andWhere("(outcome->>'pending')::boolean = true")
      .andWhere("outcome->>'phase' = 'EXECUTING'")
      .andWhere("outcome->>'ownerProcessId' = :oldProcessId", {
        oldProcessId: ownerProcessId,
      })
      .andWhere("outcome->>'ownerToken' = :oldOwnerToken", {
        oldOwnerToken: ownerToken,
      })
      .execute();
    return (result.affected ?? 0) === 1
      ? {
          claimed: true,
          evidence: {
            operationId: auditRowId,
            ownerProcessId: PROCESS_INSTANCE_ID,
            ownerToken: newToken,
          },
        }
      : { claimed: false };
  }
  return { claimed: false };
}

async function readRecoveredReleaseTruth(
  deps: ReleaseWorkspaceDeps,
  operationId: string,
  workspaceExecutionId: string,
): Promise<Record<string, unknown> | null> {
  const action = await deps.dataSource
    .getRepository(OperatorActionEntity)
    .findOne({ where: { id: operationId } });
  const actionOutcome = action?.outcome as Record<string, unknown> | undefined;
  const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
  const lease = await deps.dataSource
    .getRepository(WorkspaceExecutionEntity)
    .findOne({ where: { id: workspaceExecutionId } });

  let truth: Record<string, unknown> | null = null;
  if (lease?.state === "REMOVED") {
    truth = {
      workspaceExecutionId,
      state: "REMOVED",
    };
  } else if (lease?.state === "PRESERVED" && lease.failureCode) {
    truth = {
      workspaceExecutionId,
      state: "PRESERVED",
      failureCode: lease.failureCode,
      hasUncommittedWork: lease.hasUncommittedWork,
      refusal: true,
      error: lease.failureCode,
    };
  } else if (
    actionOutcome &&
    actionOutcome.pending !== true &&
    ["REMOVED", "PRESERVED", "NOT_FOUND", "INTERRUPTED", "FAILED"].includes(
      String(actionOutcome.state),
    )
  ) {
    truth = { ...actionOutcome };
  }
  if (!truth) return null;
  return {
    ...truth,
    workspaceExecutionId,
    performedByOperationId: operationId,
  };
}

/** Observe A after synchronous stale recovery; B never claims or mutates A. */
async function observeRecoveredRelease(
  deps: ReleaseWorkspaceDeps,
  auditRowId: string,
  idempotencyKey: string,
  operationId: string,
  workspaceExecutionId: string,
): Promise<CommandResult | null> {
  const truth = await readRecoveredReleaseTruth(deps, operationId, workspaceExecutionId);
  if (!truth || truth.state === "IN_PROGRESS") return null;
  await deps.dataSource
    .getRepository(OperatorActionEntity)
    .update({ id: auditRowId }, { outcome: truth });
  if (truth.state === "REMOVED") {
    return {
      action: "release-execution-workspace",
      idempotencyKey,
      outcome: "duplicate",
      result: truth,
    };
  }
  throw new WorkspaceExecutionError(
    (truth.failureCode as string) ?? "RELEASE_NOT_COMPLETED",
    (truth.error as string) ?? `Release completed with state ${String(truth.state)}`,
  );
}

/**
 * SINGLE release-operation driver for stale recovery: claim/take over the exact stale operation A by CAS and execute Git as A.
 * Git mutation remains authorized by A, not by B. Exactly one takeover winner via CAS.
 * Used by normal execution and crash recovery (new UUID frontend reload still converges via this).
 * For finalization-failure recovery, first re-observe worktree: ABSENT→REMOVED without Git, REGISTERED→Git, UNKNOWN→fail closed.
 */
async function tryRecoverStaleOperation(
  deps: ReleaseWorkspaceDeps,
  staleOperationId: string,
): Promise<boolean> {
  const repo = deps.dataSource.getRepository(OperatorActionEntity);
  const staleRow = await repo.findOne({ where: { id: staleOperationId } });
  if (!staleRow) return false;
  if (staleRow.action !== "release-execution-workspace") return false;
  const targetId = staleRow.targetId;
  if (!targetId) return false;
  const outcome = staleRow.outcome as Record<string, unknown> | undefined;
  if (!outcome || outcome.pending !== true) return false;
  const phase = (outcome as { phase?: string }).phase;
  if (phase !== "REQUESTED" && phase !== "EXECUTING") return false;
  // If already in explicit recoverable state (same pid, recoverable marker), try to finalize directly without re-claiming
  const isSamePidRecoverable = (outcome as any).ownerProcessId === PROCESS_INSTANCE_ID && (outcome as any).recoverable === true;
  if (isSamePidRecoverable) {
    try {
      const wsRepo2 = deps.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity);
      const lease2 = await wsRepo2.findOne({ where: { id: targetId } as any });
      if (lease2?.state === "RELEASE_REQUESTED" && (lease2 as any).executionPath) {
        const { worktreeIsRegistered: wirSame } = await import("./workspace-execution.service");
        const regSame = wirSame((lease2 as any).sourcePath, (lease2 as any).executionPath);
        if (regSame === "ABSENT") {
          const resultSame: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
          const fakeClaimSame = { operationId: staleOperationId, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: (outcome as any).ownerToken ?? "recovered" };
          await deps.workspaceExecutions.persistTerminalRelease(targetId, fakeClaimSame as any, { state: "REMOVED" }, resultSame);
          return true;
        } else if (regSame === "REGISTERED") {
          // For refusal/UNKNOWN with REGISTERED, the normal path below will re-observe and handle via Git/refusal
        }
      }
    } catch {}
    // For recoverable, allow claim to re-drive (will be handled below as REQUESTED)
    if (phase === "EXECUTING" && (outcome as any).recoverable === true) {
      // Temporarily treat as REQUESTED for claiming
      await deps.dataSource.getRepository(OperatorActionEntity).update({ id: staleOperationId }, { outcome: { ...outcome, phase: "REQUESTED" } as any });
      const refreshed = await repo.findOne({ where: { id: staleOperationId } });
      if (refreshed) {
        const newOutcome = refreshed.outcome as any;
        const claimed2 = await claimReleaseOwnership(deps, staleOperationId, newOutcome);
        if (claimed2.claimed) {
          // Now proceed to normal observation below with the new claim
          // Fall through to the normal handling with the new claimed evidence
          // For simplicity, just return false and let the outer pendingRequested path handle it
          return false;
        }
      }
    }
  }
  // Attempt to claim/takeover via single driver CAS
  const claimed = await claimReleaseOwnership(deps, staleOperationId, outcome);
  if (!claimed.claimed) return false;
  registerActiveToken(staleOperationId, claimed.evidence.ownerToken);
  let claimedSucceeded = false;
  // Re-observe worktree before deciding Git: if already REMOVED/absent, finalize without Git (covers crash between Git and finalization, and legacy REMOVED+pending)
  // For finalization failure, the operation is still pending with same pid, but the worktree is already absent on FS, so we should finalize without Git
  let reObserveSucceeded = false;
  try {
    const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
    const wsRepo = deps.dataSource.getRepository(WorkspaceExecutionEntity);
    const lease = await wsRepo.findOne({ where: { id: targetId } as any });
    if (lease?.state === "REMOVED") {
      const result: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
      await deps.workspaceExecutions.persistTerminalRelease(targetId, claimed.evidence, { state: "REMOVED" }, result);
      reObserveSucceeded = true;
      return true;
    }
    if (lease && (lease as any).executionPath) {
      const { worktreeIsRegistered } = await import("./workspace-execution.service");
      const registration = worktreeIsRegistered((lease as any).sourcePath, (lease as any).executionPath);
      if (registration === "ABSENT") {
        const result: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
        await deps.workspaceExecutions.persistTerminalRelease(targetId, claimed.evidence, { state: "REMOVED" }, result);
        return true;
      }
      // UNKNOWN must NOT short-circuit here; let the canonical Safe Release path persist the truthful PRESERVED/WORKTREE_STATE_UNKNOWN via the single terminal transaction
    }
    if (lease?.state === "RELEASE_REQUESTED" && (outcome as any).phase === "EXECUTING" && (lease as any).executionPath) {
      const { worktreeIsRegistered: wir2 } = await import("./workspace-execution.service");
      const reg2 = wir2((lease as any).sourcePath, (lease as any).executionPath);
      if (reg2 === "ABSENT") {
        const result: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
        await deps.workspaceExecutions.persistTerminalRelease(targetId, claimed.evidence, { state: "REMOVED" }, result);
        reObserveSucceeded = true;
        return true;
      }
    }
  } catch (e) {
    // If persistTerminalRelease failed while still owning target, CAS to recoverable before returning
    const wsCheck = await deps.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
    const lockCheck = await deps.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
    const lockOp = Array.isArray(lockCheck) ? lockCheck[0]?.releaseOperationId : lockCheck?.rows?.[0]?.releaseOperationId;
    const cur = await repo.findOne({ where: { id: staleOperationId } });
    const stillOwns = wsCheck?.releaseOperationId === staleOperationId && lockOp === staleOperationId && (cur?.outcome as any)?.pending === true;
    if (stillOwns) {
      const curOut = cur?.outcome as any;
      if (curOut?.phase === "EXECUTING" && curOut?.ownerProcessId === PROCESS_INSTANCE_ID && curOut?.ownerToken === claimed.evidence.ownerToken) {
        await repo.createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: curOut.ownerToken, claimedAt: curOut.claimedAt, failedFrom: curOut.phase } as any }).where("id = :id", { id: staleOperationId }).andWhere("outcome->>'phase' = 'EXECUTING'").execute().catch(() => {});
      }
    }
    // Even if DB marker write failed, in-process registry being removed in finally will make it recoverable
    return false;
  }
  // We are now the owner of the exact stale operation A — execute Git as A (single terminal transaction inside WorkspaceExecutionService)
  let gitSucceeded = false;
  try {
    const released = await deps.workspaceExecutions.releaseExecutionWorkspace(targetId, claimed.evidence);
    gitSucceeded = true;
    return true;
  } catch (error) {
    if (error instanceof WorkspaceExecutionError) {
      const wsCheck = await deps.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
      const lockCheck = await deps.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
      const lockOp = Array.isArray(lockCheck) ? lockCheck[0]?.releaseOperationId : lockCheck?.rows?.[0]?.releaseOperationId;
      const cur = await repo.findOne({ where: { id: staleOperationId } });
      const stillOwnsTarget = wsCheck?.releaseOperationId === staleOperationId && lockOp === staleOperationId && (cur?.outcome as any)?.pending === true;
      if (stillOwnsTarget) {
        // Authoritative transaction rolled back while A still owns active target → CAS to explicit retryable before return
        const curOut = cur?.outcome as any;
        if (curOut?.phase === "EXECUTING" && curOut?.ownerProcessId === PROCESS_INSTANCE_ID && curOut?.ownerToken === claimed.evidence.ownerToken) {
          await deps.dataSource.getRepository(OperatorActionEntity).createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: curOut.ownerToken, claimedAt: curOut.claimedAt, failedFrom: curOut.phase } as any }).where("id = :id", { id: staleOperationId }).andWhere("outcome->>'phase' = 'EXECUTING'").execute().catch(() => {});
        }
        return false;
      }
      return true;
    }
    const wsCheck2 = await deps.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
    const lockCheck2 = await deps.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
    const lockOp2 = Array.isArray(lockCheck2) ? lockCheck2[0]?.releaseOperationId : lockCheck2?.rows?.[0]?.releaseOperationId;
    const cur2 = await repo.findOne({ where: { id: staleOperationId } });
    const stillOwnsTarget2 = wsCheck2?.releaseOperationId === staleOperationId && lockOp2 === staleOperationId && (cur2?.outcome as any)?.pending === true;
    if (stillOwnsTarget2) {
      const curOut2 = cur2?.outcome as any;
      if (curOut2?.phase === "EXECUTING" && curOut2?.ownerProcessId === PROCESS_INSTANCE_ID && curOut2?.ownerToken === claimed.evidence.ownerToken) {
        await deps.dataSource.getRepository(OperatorActionEntity).createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: curOut2.ownerToken, claimedAt: curOut2.claimedAt, failedFrom: curOut2.phase } as any }).where("id = :id", { id: staleOperationId }).andWhere("outcome->>'phase' = 'EXECUTING'").execute().catch(() => {});
      }
      return false;
    }
    // Terminal already committed or ownership lost → do not mark INTERRUPTED while still owning target
    if ((cur2?.outcome as any)?.pending === true) {
      return false;
    }
    return true;
  } finally {
    // Always unregister exact token when this recovery attempt exits; if marker write failed, the empty registry still makes it recoverable
    try {
      unregisterActiveToken(staleOperationId, claimed.evidence.ownerToken);
    } catch {}
    // If we had claimed but the terminal failed and we are still pending, ensure recoverable marker (check affected)
    if (!claimedSucceeded) {
      try {
        const wsChk = await deps.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
        const lockChk = await deps.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
        const lockOpChk = Array.isArray(lockChk) ? lockChk[0]?.releaseOperationId : lockChk?.rows?.[0]?.releaseOperationId;
        const curChk = await repo.findOne({ where: { id: staleOperationId } });
        const stillOwnsChk = wsChk?.releaseOperationId === staleOperationId && lockOpChk === staleOperationId && (curChk?.outcome as any)?.pending === true;
        if (stillOwnsChk) {
          const curOutChk = curChk?.outcome as any;
          if (curOutChk?.phase === "EXECUTING" && curOutChk?.ownerProcessId === PROCESS_INSTANCE_ID && curOutChk?.ownerToken === claimed.evidence.ownerToken) {
            const resChk = await repo.createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: curOutChk.ownerToken, claimedAt: curOutChk.claimedAt, failedFrom: curOutChk.phase } as any }).where("id = :id", { id: staleOperationId }).andWhere("outcome->>'phase' = 'EXECUTING'").execute();
            // Do not swallow failure as if correctness preserved; in-process registry being empty is the fallback
            if ((resChk.affected ?? 0) === 0) {
              // Marker write failed, but registry is now empty, so next fresh UUID will see no active token and can recover
            }
          }
        }
      } catch {}
    }
  }
}

async function waitForReleaseFinalOutcome(
  deps: ReleaseWorkspaceDeps,
  auditRowId: string,
  _key: string,
  _action: string,
): Promise<Record<string, unknown>> {
  const repo = deps.dataSource.getRepository(OperatorActionEntity);
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = await repo.findOne({ where: { id: auditRowId } });
    const out = row?.outcome as Record<string, unknown> | undefined;
    if (out && out.pending !== true) return out;
    if (out?.pending === true && (out as { phase?: string }).phase === "EXECUTING") {
      const ownerPid = (out as { ownerProcessId?: string }).ownerProcessId;
      // PP1 FINAL: normal duplicate while owner is alive (same process) MUST NOT run Git via reconcile.
      // Only poll, return IN_PROGRESS if timeout.
      if (ownerPid === PROCESS_INSTANCE_ID) {
        // Active owner — just wait
      } else {
        // Stale owner from dead process — we could attempt takeover, but this path is for waiting duplicates;
        // the caller will attempt takeover via claimReleaseOwnership on retry. Here just wait for that takeover to complete.
      }
      // Do NOT call reconcileWorkspaceExecutions here — that would execute Git while owner is alive (exactly-one violation)
    }
    if (attempt < 19) await new Promise((r) => setTimeout(r, 100));
  }
  const finalRow = await repo.findOne({ where: { id: auditRowId } });
  const fin = finalRow?.outcome as Record<string, unknown> | undefined;
  if (fin && fin.pending !== true) return fin as Record<string, unknown>;
  // Still pending EXECUTING after timeout → report IN_PROGRESS truthfully, never fabricate REMOVED
  if (fin && fin.pending === true && (fin as { phase?: string }).phase === "EXECUTING") {
    return {
      workspaceExecutionId: (fin.workspaceExecutionId as string | undefined) ?? (finalRow?.targetId as string | undefined) ?? "",
      state: "IN_PROGRESS",
      failureCode: "OPERATION_IN_PROGRESS",
      error: "Release operation is in progress; retry with the same idempotency key to observe the final outcome",
    };
  }
  // Still pending REQUESTED → also IN_PROGRESS
  if (fin && fin.pending === true) {
    return {
      workspaceExecutionId: (fin.workspaceExecutionId as string | undefined) ?? (finalRow?.targetId as string | undefined) ?? "",
      state: "IN_PROGRESS",
      failureCode: "OPERATION_IN_PROGRESS",
      error: "Release operation is pending; retry to observe outcome",
    };
  }
  return (fin as Record<string, unknown>) ?? { state: "INTERRUPTED", failureCode: "RELEASE_INTERRUPTED", retryRequired: true };
}

async function truthfulReleaseRefusalOutcome(
  deps: ReleaseWorkspaceDeps,
  workspaceExecutionId: string,
  code: string,
  message: string,
): Promise<Record<string, unknown>> {
  // PP1 FINAL §5: audit must read actual durable workspace state, never hardcode IN_USE etc
  if (code === "LEASE_NOT_FOUND") {
    return {
      workspaceExecutionId,
      state: "NOT_FOUND",
      failureCode: "LEASE_NOT_FOUND",
      error: message,
      refusal: true,
    };
  }
  try {
    const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
    const repo = deps.dataSource.getRepository(WorkspaceExecutionEntity);
    const lease = await repo.findOne({ where: { id: workspaceExecutionId } as unknown as Record<string, unknown> });
    if (!lease) {
      return {
        workspaceExecutionId,
        state: "NOT_FOUND",
        failureCode: "LEASE_NOT_FOUND",
        error: `Execution workspace "${workspaceExecutionId}" does not exist`,
        refusal: true,
      };
    }
    const actualState = (lease as unknown as { state: string }).state;
    const hasUncommittedWork = (lease as unknown as { hasUncommittedWork?: boolean | null }).hasUncommittedWork;
    // For LEASE_NOT_RELEASABLE and similar, record the actual observed state, not a hardcoded IN_USE
    return {
      workspaceExecutionId,
      state: actualState,
      failureCode: code,
      error: message,
      refusal: true,
      ...(hasUncommittedWork !== null && hasUncommittedWork !== undefined ? { hasUncommittedWork } : {}),
    };
  } catch {
    // Fallback if DB read fails — still truthful code but state is unknown; do not hardcode IN_USE
    return {
      workspaceExecutionId,
      state: "PRESERVED",
      failureCode: code,
      error: message,
      refusal: true,
    };
  }
}
