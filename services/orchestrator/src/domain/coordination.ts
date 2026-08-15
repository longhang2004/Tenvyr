import { sha256Json } from "./canonical-json";
import { CONNECTION_ID_PATTERN } from "../executors/runtime-connection";
import type { WorkspaceSnapshotV1 } from "./workspace";

/**
 * M9-S1: pure Coordinator semantics — team configuration, phases, bounded
 * TaskBatch proposals, Verifier decisions, bounded aggregation, and hard
 * limits. No persistence, no dispatch, no provider logic: Coordinator
 * authority stays deterministic Tenvyr code; Planner/Verifier return
 * untrusted bounded data that only passes these validators.
 *
 * Hard maxima live here and cannot be raised by any decision payload.
 */

export const COORDINATION_BOUNDS = {
  maxIterations: 100,
  maxWorkersPerIteration: 64,
  maxTotalWorkers: 1024,
  maxTaskIdLength: 100,
  maxAgentLength: 255,
  maxReasonLength: 2048,
  maxTaskInputBytes: 64 * 1024,
  maxBatchSerializedBytes: 256 * 1024,
  maxDependenciesPerTask: 16,
  maxAllowedWorkers: 128,
  maxDecisionReasonLength: 2048,
  maxEvidenceRefs: 64,
  maxRecommendationFocus: 16,
  maxRecommendationBytes: 16 * 1024,
  maxWorkerSummaryBytes: 4096,
  maxSelectedFieldBytes: 4096,
  maxArtifactRefs: 64,
  maxExecutionStateKeys: 32,
  maxAggregateWorkers: 64,
  maxAggregateBytes: 128 * 1024,
  maxDelegationDepth: 3,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
  maxRetries: 10,
} as const;

export const COORDINATION_PHASES = [
  "PLANNING",
  "BATCH_VALIDATION",
  "WORKING",
  "VERIFYING",
  "DECIDING",
  "WAITING_FOR_HUMAN",
  "ACCEPTED",
  "FAILED",
  "CANCELLED",
  "LIMIT_REACHED",
] as const;
export type CoordinationPhase = (typeof COORDINATION_PHASES)[number];

export const TERMINAL_COORDINATION_PHASES: readonly CoordinationPhase[] = [
  "ACCEPTED",
  "FAILED",
  "CANCELLED",
  "LIMIT_REACHED",
];

export const VERIFIER_ACTIONS = [
  "ACCEPT",
  "CONTINUE",
  "FAIL",
  "WAIT_FOR_HUMAN",
] as const;
export type VerifierAction = (typeof VERIFIER_ACTIONS)[number];

const TASK_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export class CoordinationError extends Error {
  constructor(
    public readonly code:
      | "CONFIG_INVALID"
      | "BATCH_INVALID"
      | "TASK_INVALID"
      | "DECISION_INVALID"
      | "DECISION_CONFLICT"
      | "LIMIT_EXCEEDED"
      | "AGENT_NOT_ALLOWED"
      | "CONNECTION_NOT_ALLOWED"
      | "EXECUTOR_NOT_ALLOWED"
      | "PHASE_TRANSITION_INVALID"
      | "AGGREGATION_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "CoordinationError";
  }
}

/** Planner/Verifier/Worker selection: a logical agent or an M8 connection. */
export type CoordinatorSelectionV1 = {
  kind: "agent" | "connection";
  name: string;
  /** M8-S6: routing agent for connection-kind selections — the transport
   *  key the executor host exposes this runtime under (e.g. "codex-host").
   *  Defaults to `name` when absent (workers carry their own agent on the
   *  task; only Planner/Verifier selections use this field). */
  agent?: string;
};

/**
 * Frozen team configuration and hard limits. Bounds cannot be raised by a
 * Verifier decision or an ordinary approval — only a separate audited
 * operator action (never implicit).
 */
export type CoordinationConfigV1 = {
  schemaVersion: 1;
  planner: CoordinatorSelectionV1;
  verifier: CoordinatorSelectionV1;
  /** Allowlist of worker agents/connections the Planner may select. */
  allowedWorkers: CoordinatorSelectionV1[];
  maxIterations: number;
  maxWorkersPerIteration: number;
  maxTotalWorkers: number;
  /** Wall-clock budget for the whole loop, from run start. */
  loopDeadlineMs: number;
  /** Optional budget account reference; resolved by existing authority. */
  budgetAccountId?: string;
  delegationDepthMax: number;
  /** Executor id allowlist (e.g. "local-host"). */
  allowedExecutors: string[];
};

export type TaskProposalV1 = {
  /** Stable within and across iterations; safe charset. */
  taskId: string;
  agent: string;
  /** Optional M8 connection selector; runtime selection stays in Tenvyr. */
  connectionId?: string;
  /** Bounded JSON input; never a secret value, command, or nested loop. */
  input: unknown;
  /** Dependencies on taskIds WITHIN this iteration (acyclic). */
  dependsOn: string[];
  required: boolean;
  reason: string;
  /** Optional per-task wall-clock bound; bounded. */
  timeoutMs?: number;
  /** Optional retry count; bounded. */
  retry?: number;
};

export type TaskBatchProposalV1 = {
  schemaVersion: 1;
  /** The iteration this batch is proposed FOR (1-based). */
  iterationNumber: number;
  /** Immutable plan revision the batch must apply on. */
  baseRevision: number;
  tasks: TaskProposalV1[];
  reason: string;
};

export type VerifierDecisionV1 = {
  schemaVersion: 1;
  /** Stable iteration identity the decision refers to. */
  iterationId: string;
  iterationNumber: number;
  action: VerifierAction;
  reason: string;
  /** Bounded references to criteria/evidence (ids, never content). */
  evidenceRefs: string[];
  /** Optional next-iteration recommendation; never executable work. */
  recommendation?: { reason: string; focus: string[] };
};

export type WorkerOutcomeSummaryV1 = {
  taskId: string;
  status: "SUCCESS" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  failureCode?: string;
  /** Bounded result summary (never raw output or chain of thought). */
  summary?: string;
  /** Explicitly selected output fields (bounded). */
  selectedFields?: Record<string, unknown>;
  artifactRefs: string[];
};

/**
 * Immutable bounded aggregation the Verifier receives. Secrets, raw logs,
 * chain of thought, complete Capsule dumps, unselected artifacts, and
 * provider auth can never enter by construction (fields are bounded and
 * selection is explicit).
 */
export type VerifierContextV1 = {
  schemaVersion: 1;
  iterationId: string;
  iterationNumber: number;
  workers: WorkerOutcomeSummaryV1[];
  /** Selected ExecutionState keys (bounded). */
  executionStateKeys: Record<string, unknown>;
  /** Prior decision summary (bounded). */
  priorDecision?: { action: VerifierAction; reason: string };
  /** Product Phase 1: the frozen workspace snapshot the run executes
   *  against (path + best-effort repository identity), when the run has
   *  one. */
  workspace?: WorkspaceSnapshotV1;
  limits: {
    maxIterations: number;
    maxTotalWorkers: number;
    cumulativeWorkers: number;
    remainingDeadlineMs: number;
    /** M8-S6/M9-S7: REAL bounded per-dimension remaining availability
     *  projected from the budget ledger (never fabricated); absent when
     *  the run has no budget account. */
    remainingBudget?: { accountId: string; remaining: Record<string, number> };
  };
  /** Policy/approval evidence ids and Capsule subset identifiers. */
  evidence: string[];
  /** Deterministic truncation/omission metadata. */
  omitted: string[];
};

const PHASE_EVENTS = [
  "plannerProposed",
  "batchRejected",
  "batchValidated",
  "workersFinished",
  "verifierProposed",
  "accept",
  "continue",
  "fail",
  "wait",
  "approvalGranted",
  "approvalDenied",
  "deadline",
  "cancel",
  "limitReached",
] as const;
export type CoordinationPhaseEvent = (typeof PHASE_EVENTS)[number];

const TRANSITIONS: Record<CoordinationPhaseEvent, CoordinationPhase[]> = {
  plannerProposed: ["PLANNING"],
  batchRejected: ["PLANNING"],
  batchValidated: ["BATCH_VALIDATION"],
  workersFinished: ["WORKING"],
  verifierProposed: ["VERIFYING"],
  accept: ["DECIDING"],
  continue: ["DECIDING"],
  fail: [
    "PLANNING",
    "BATCH_VALIDATION",
    "WORKING",
    "VERIFYING",
    "DECIDING",
    "WAITING_FOR_HUMAN",
  ],
  wait: ["DECIDING"],
  approvalGranted: ["WAITING_FOR_HUMAN"],
  approvalDenied: ["WAITING_FOR_HUMAN"],
  deadline: ["PLANNING", "BATCH_VALIDATION", "WORKING", "VERIFYING", "DECIDING", "WAITING_FOR_HUMAN"],
  cancel: ["PLANNING", "BATCH_VALIDATION", "WORKING", "VERIFYING", "DECIDING", "WAITING_FOR_HUMAN"],
  limitReached: ["PLANNING", "BATCH_VALIDATION", "WORKING", "VERIFYING", "DECIDING", "WAITING_FOR_HUMAN"],
};

const EVENT_PHASE: Record<CoordinationPhaseEvent, CoordinationPhase> = {
  plannerProposed: "BATCH_VALIDATION",
  batchRejected: "PLANNING",
  batchValidated: "WORKING",
  workersFinished: "VERIFYING",
  verifierProposed: "DECIDING",
  accept: "ACCEPTED",
  continue: "PLANNING",
  fail: "FAILED",
  wait: "WAITING_FOR_HUMAN",
  approvalGranted: "DECIDING",
  approvalDenied: "FAILED",
  deadline: "LIMIT_REACHED",
  cancel: "CANCELLED",
  limitReached: "LIMIT_REACHED",
};

/**
 * Deterministic phase machine. Terminal phases absorb every event
 * (idempotent); otherwise the event must be legal from the current phase.
 */
export function applyPhaseTransition(
  phase: CoordinationPhase,
  event: CoordinationPhaseEvent,
): CoordinationPhase {
  if (TERMINAL_COORDINATION_PHASES.includes(phase)) return phase;
  if (!TRANSITIONS[event].includes(phase)) {
    throw new CoordinationError(
      "PHASE_TRANSITION_INVALID",
      `Coordination phase ${phase} cannot accept event ${event}`,
    );
  }
  return EVENT_PHASE[event];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  max: number,
  code: CoordinationError["code"] = "CONFIG_INVALID",
): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new CoordinationError(
      code,
      `${field} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: CoordinationError["code"] = "CONFIG_INVALID",
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new CoordinationError(
      code,
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}

function boundedBytes(value: unknown, field: string, max: number): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > max) {
    throw new CoordinationError(
      "TASK_INVALID",
      `${field} exceeds ${max} serialized bytes`,
    );
  }
}

export function parseCoordinationSelection(
  value: unknown,
  field: string,
): CoordinatorSelectionV1 {
  const snapshot = isRecord(value) ? value : {};
  if (snapshot.kind !== "agent" && snapshot.kind !== "connection") {
    throw new CoordinationError(
      "CONFIG_INVALID",
      `${field} kind must be agent or connection`,
    );
  }
  const name = boundedString(snapshot.name, `${field} name`, 255);
  if (snapshot.kind === "connection" && !CONNECTION_ID_PATTERN.test(name)) {
    throw new CoordinationError(
      "CONFIG_INVALID",
      `${field} connection name must match ${CONNECTION_ID_PATTERN}`,
    );
  }
  const selection: CoordinatorSelectionV1 = { kind: snapshot.kind, name };
  if (snapshot.agent !== undefined) {
    selection.agent = boundedString(snapshot.agent, `${field} agent`, 255);
  }
  return selection;
}

/** Strict parse of the frozen team configuration. */
export function parseCoordinationConfig(value: unknown): CoordinationConfigV1 {
  const snapshot = isRecord(value) ? value : {};
  if (snapshot.schemaVersion !== 1) {
    throw new CoordinationError(
      "CONFIG_INVALID",
      `CoordinationConfig schemaVersion must be 1 (got ${String(snapshot.schemaVersion)})`,
    );
  }
  if (
    !Array.isArray(snapshot.allowedWorkers) ||
    snapshot.allowedWorkers.length === 0 ||
    snapshot.allowedWorkers.length > COORDINATION_BOUNDS.maxAllowedWorkers
  ) {
    throw new CoordinationError(
      "CONFIG_INVALID",
      `allowedWorkers must be an array of 1-${COORDINATION_BOUNDS.maxAllowedWorkers} selections`,
    );
  }
  const config: CoordinationConfigV1 = {
    schemaVersion: 1,
    planner: parseCoordinationSelection(snapshot.planner, "planner"),
    verifier: parseCoordinationSelection(snapshot.verifier, "verifier"),
    allowedWorkers: snapshot.allowedWorkers.map((entry, index) =>
      parseCoordinationSelection(entry, `allowedWorkers[${index}]`),
    ),
    maxIterations: boundedInteger(
      snapshot.maxIterations,
      "maxIterations",
      1,
      COORDINATION_BOUNDS.maxIterations,
    ),
    maxWorkersPerIteration: boundedInteger(
      snapshot.maxWorkersPerIteration,
      "maxWorkersPerIteration",
      1,
      COORDINATION_BOUNDS.maxWorkersPerIteration,
    ),
    maxTotalWorkers: boundedInteger(
      snapshot.maxTotalWorkers,
      "maxTotalWorkers",
      1,
      COORDINATION_BOUNDS.maxTotalWorkers,
    ),
    loopDeadlineMs: boundedInteger(
      snapshot.loopDeadlineMs,
      "loopDeadlineMs",
      1,
      365 * 24 * 60 * 60 * 1000,
    ),
    delegationDepthMax: boundedInteger(
      snapshot.delegationDepthMax ?? COORDINATION_BOUNDS.maxDelegationDepth,
      "delegationDepthMax",
      0,
      COORDINATION_BOUNDS.maxDelegationDepth,
    ),
    allowedExecutors: snapshot.allowedExecutors as string[],
  };
  if (
    !Array.isArray(snapshot.allowedExecutors) ||
    snapshot.allowedExecutors.length === 0 ||
    snapshot.allowedExecutors.length > 32 ||
    !snapshot.allowedExecutors.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 255,
    )
  ) {
    throw new CoordinationError(
      "CONFIG_INVALID",
      "allowedExecutors must be an array of 1-32 non-empty strings",
    );
  }
  if (snapshot.budgetAccountId !== undefined) {
    config.budgetAccountId = boundedString(
      snapshot.budgetAccountId,
      "budgetAccountId",
      255,
    );
  }
  return config;
}

/**
 * Strict parse of an untrusted Planner TaskBatch proposal. Structural
 * bounds only (agent allowlist and iteration limits are checked against the
 * frozen config in `validateTaskBatchProposal`).
 */
export function parseTaskBatchProposal(value: unknown): TaskBatchProposalV1 {
  const snapshot = isRecord(value) ? value : {};
  if (snapshot.schemaVersion !== 1) {
    throw new CoordinationError(
      "BATCH_INVALID",
      `TaskBatchProposal schemaVersion must be 1 (got ${String(snapshot.schemaVersion)})`,
    );
  }
  const iterationNumber = boundedInteger(
    snapshot.iterationNumber,
    "iterationNumber",
    1,
    COORDINATION_BOUNDS.maxIterations,
    "BATCH_INVALID",
  );
  const baseRevision = boundedInteger(
    snapshot.baseRevision,
    "baseRevision",
    1,
    2_147_483_647,
    "BATCH_INVALID",
  );
  if (
    !Array.isArray(snapshot.tasks) ||
    snapshot.tasks.length === 0 ||
    snapshot.tasks.length > COORDINATION_BOUNDS.maxWorkersPerIteration
  ) {
    throw new CoordinationError(
      "BATCH_INVALID",
      `tasks must be an array of 1-${COORDINATION_BOUNDS.maxWorkersPerIteration} proposals`,
    );
  }
  const tasks = snapshot.tasks.map((entry, index) =>
    parseTaskProposal(entry, index),
  );
  const ids = tasks.map((task) => task.taskId);
  if (new Set(ids).size !== ids.length) {
    throw new CoordinationError("BATCH_INVALID", "taskIds must be unique");
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.includes(dependency)) {
        throw new CoordinationError(
          "BATCH_INVALID",
          `task "${task.taskId}" depends on unknown task "${dependency}"`,
        );
      }
    }
  }
  assertAcyclic(tasks);
  boundedBytes(snapshot, "TaskBatchProposal", COORDINATION_BOUNDS.maxBatchSerializedBytes);
  return {
    schemaVersion: 1,
    iterationNumber,
    baseRevision,
    tasks,
    reason: boundedString(snapshot.reason, "reason", COORDINATION_BOUNDS.maxReasonLength),
  };
}

function parseTaskProposal(value: unknown, index: number): TaskProposalV1 {
  const snapshot = isRecord(value) ? value : {};
  const taskId = boundedString(snapshot.taskId, `tasks[${index}].taskId`, 100);
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new CoordinationError(
      "TASK_INVALID",
      `tasks[${index}].taskId must match ${TASK_ID_PATTERN}`,
    );
  }
  const agent = boundedString(snapshot.agent, `tasks[${index}].agent`, 255);
  const dependsOn = snapshot.dependsOn ?? [];
  if (
    !Array.isArray(dependsOn) ||
    dependsOn.length > COORDINATION_BOUNDS.maxDependenciesPerTask ||
    new Set(dependsOn).size !== dependsOn.length ||
    !dependsOn.every(
      (entry) =>
        typeof entry === "string" &&
        TASK_ID_PATTERN.test(entry) &&
        entry.length <= COORDINATION_BOUNDS.maxTaskIdLength,
    ) ||
    dependsOn.includes(taskId)
  ) {
    throw new CoordinationError(
      "TASK_INVALID",
      `tasks[${index}].dependsOn must be distinct taskIds (no self) of at most ${COORDINATION_BOUNDS.maxDependenciesPerTask}`,
    );
  }
  if (typeof snapshot.required !== "boolean") {
    throw new CoordinationError(
      "TASK_INVALID",
      `tasks[${index}].required must be a boolean`,
    );
  }
  boundedBytes(snapshot.input ?? null, `tasks[${index}].input`, COORDINATION_BOUNDS.maxTaskInputBytes);
  const task: TaskProposalV1 = {
    taskId,
    agent,
    input: snapshot.input ?? null,
    dependsOn: dependsOn as string[],
    required: snapshot.required,
    reason: boundedString(snapshot.reason, `tasks[${index}].reason`, COORDINATION_BOUNDS.maxReasonLength),
  };
  if (snapshot.connectionId !== undefined) {
    const connectionId = boundedString(
      snapshot.connectionId,
      `tasks[${index}].connectionId`,
      255,
    );
    if (!CONNECTION_ID_PATTERN.test(connectionId)) {
      throw new CoordinationError(
        "TASK_INVALID",
        `tasks[${index}].connectionId must match ${CONNECTION_ID_PATTERN}`,
      );
    }
    task.connectionId = connectionId;
  }
  if (snapshot.timeoutMs !== undefined) {
    task.timeoutMs = boundedInteger(
      snapshot.timeoutMs,
      `tasks[${index}].timeoutMs`,
      1,
      COORDINATION_BOUNDS.maxTimeoutMs,
      "TASK_INVALID",
    );
  }
  if (snapshot.retry !== undefined) {
    task.retry = boundedInteger(
      snapshot.retry,
      `tasks[${index}].retry`,
      0,
      COORDINATION_BOUNDS.maxRetries,
      "TASK_INVALID",
    );
  }
  return task;
}

function assertAcyclic(tasks: TaskProposalV1[]): void {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: TaskProposalV1): void => {
    if (visited.has(task.taskId)) return;
    if (visiting.has(task.taskId)) {
      throw new CoordinationError(
        "BATCH_INVALID",
        `task dependency cycle detected at "${task.taskId}"`,
      );
    }
    visiting.add(task.taskId);
    for (const dependency of task.dependsOn) {
      visit(byId.get(dependency)!);
    }
    visiting.delete(task.taskId);
    visited.add(task.taskId);
  };
  for (const task of tasks) visit(task);
}

/**
 * Hard-bound and allowlist validation of a Planner batch against the frozen
 * config. Never widens authority: unknown agents/connections, iteration
 * overruns, and worker-count overruns are rejected.
 */
export function validateTaskBatchProposal(
  config: CoordinationConfigV1,
  proposal: TaskBatchProposalV1,
  cumulativeWorkers: number,
): void {
  if (proposal.iterationNumber > config.maxIterations) {
    throw new CoordinationError(
      "LIMIT_EXCEEDED",
      `iteration ${proposal.iterationNumber} exceeds maxIterations ${config.maxIterations}`,
    );
  }
  if (proposal.tasks.length > config.maxWorkersPerIteration) {
    throw new CoordinationError(
      "LIMIT_EXCEEDED",
      `batch of ${proposal.tasks.length} exceeds maxWorkersPerIteration ${config.maxWorkersPerIteration}`,
    );
  }
  if (cumulativeWorkers + proposal.tasks.length > config.maxTotalWorkers) {
    throw new CoordinationError(
      "LIMIT_EXCEEDED",
      `cumulative workers ${cumulativeWorkers} + ${proposal.tasks.length} exceeds maxTotalWorkers ${config.maxTotalWorkers}`,
    );
  }
  for (const task of proposal.tasks) {
    const allowed = config.allowedWorkers.some(
      (selection) =>
        selection.kind === "agent"
          ? task.connectionId === undefined && selection.name === task.agent
          : selection.kind === "connection" && selection.name === task.connectionId,
    );
    if (!allowed) {
      throw new CoordinationError(
        task.connectionId !== undefined ? "CONNECTION_NOT_ALLOWED" : "AGENT_NOT_ALLOWED",
        `task "${task.taskId}" selects agent "${task.agent}"${task.connectionId ? ` connection "${task.connectionId}"` : ""} outside the allowlist`,
      );
    }
    // M9-S3: a Planner batch can never select the Planner or the Verifier —
    // Planner recursion and Verifier smuggling are rejected here, before
    // anything reaches PlanPatch. Connection-kind selections are blocked
    // the same way (the Planner/Verifier connection is Coordinator-owned).
    if (
      (config.planner.kind === "agent" &&
        task.connectionId === undefined &&
        task.agent === config.planner.name) ||
      (config.planner.kind === "connection" &&
        task.connectionId === config.planner.name)
    ) {
      throw new CoordinationError(
        "AGENT_NOT_ALLOWED",
        `task "${task.taskId}" selects the Planner; Planner recursion is not allowed`,
      );
    }
    if (
      (config.verifier.kind === "agent" &&
        task.connectionId === undefined &&
        task.agent === config.verifier.name) ||
      (config.verifier.kind === "connection" &&
        task.connectionId === config.verifier.name)
    ) {
      throw new CoordinationError(
        "AGENT_NOT_ALLOWED",
        `task "${task.taskId}" selects the Verifier; the Verifier step is Coordinator-owned`,
      );
    }
  }
}

/**
 * M9-S3: compiles a validated batch plus ONE Coordinator-owned Verifier
 * step into the restricted PlanPatch. Worker steps: id = taskId, agent,
 * bounded input, in-iteration dependencies; OPTIONAL workers use
 * `onFailure: continue` (failure is evidence, never a stranded DAG);
 * REQUIRED workers use `retry` when the task declares retries, else `stop`
 * (deterministic loop failure). The Verifier step depends on every member
 * and `onFailure: stop` (a Verifier failure terminalizes the loop). The
 * Planner/Verifier step shape is Coordinator-owned: the Planner cannot add
 * either.
 *
 * M8-S6: connection-kind Verifier/worker selections record the typed
 * connection on the step (`metadata.tenvyrConnectionId`); the attempt
 * claim then freezes THAT connection's revision — never the static
 * transport configuration.
 */
export function compileIterationPlanPatch(
  config: CoordinationConfigV1,
  proposal: TaskBatchProposalV1,
  iterationNumber: number,
  workspace?: WorkspaceSnapshotV1,
): { patch: PlanPatchLikeV1; verifierStepId: string } {
  if (config.verifier.kind !== "agent" && config.verifier.kind !== "connection") {
    throw new CoordinationError(
      "CONFIG_INVALID",
      "Verifier must be an agent or connection selection for plan compilation",
    );
  }
  const operations: PlanPatchOperationLikeV1[] = [];
  for (const task of proposal.tasks) {
    // Product Phase 1: the frozen workspace snapshot is injected into every
    // worker step's input envelope (bounded block, deterministic for the
    // run) so the worker knows the repository path + frozen revision it
    // executes against. The planner-authored input is preserved verbatim.
    const isPlainObjectInput =
      typeof task.input === "object" &&
      task.input !== null &&
      !Array.isArray(task.input);
    const stepInput: unknown =
      workspace === undefined
        ? task.input
        : {
            ...(isPlainObjectInput ? (task.input as object) : { value: task.input }),
            workspace,
          };
    const step: Record<string, unknown> = {
      id: task.taskId,
      agent: task.agent,
      input: stepInput,
      dependsOn: task.dependsOn,
      onFailure: task.required
        ? task.retry !== undefined && task.retry > 0
          ? "retry"
          : "stop"
        : "continue",
      ...(task.timeoutMs !== undefined ? { timeout: task.timeoutMs } : {}),
      ...(task.retry !== undefined && task.retry > 0
        ? { retries: task.retry }
        : {}),
    };
    if (task.connectionId !== undefined) {
      // M8 connection constraint recorded on the step; the attempt claim
      // freezes exactly this connection's revision (typed selection).
      step.metadata = { tenvyrConnectionId: task.connectionId };
    }
    operations.push({ op: "addStep", step });
  }
  const verifierStepId = `verify-${iterationNumber}`;
  // M9-S8: the patch applies on the proposal's VERIFIED baseRevision (the
  // Planner attempt's frozen revision, re-checked against the active
  // revision at admission). The PlanPatch activation CAS stays the final
  // authority — a concurrent activation makes the proposal STALE, never
  // silently rebased onto a newer base.
  const patch: PlanPatchLikeV1 = {
    schemaVersion: 1,
    baseRevision: proposal.baseRevision,
    operations,
  };
  const verifierStep: Record<string, unknown> = {
    id: verifierStepId,
    // M8-S6: connection-kind Verifier routes through its declared routing
    // agent (the executor host's transport key) while the typed connection
    // stays authoritative for the claim.
    agent: config.verifier.agent ?? config.verifier.name,
    input: {},
    dependsOn: proposal.tasks.map((task) => task.taskId),
    onFailure: "stop",
  };
  if (config.verifier.kind === "connection") {
    verifierStep.metadata = { tenvyrConnectionId: config.verifier.name };
  }
  operations.push({ op: "addStep", step: verifierStep });
  return {
    patch,
    verifierStepId,
  };
}

type PlanPatchOperationLikeV1 = {
  op: "addStep";
  step: Record<string, unknown>;
};

type PlanPatchLikeV1 = {
  schemaVersion: 1;
  baseRevision: number;
  operations: PlanPatchOperationLikeV1[];
};

/** CONTINUE eligibility: pure bound check (budget/deadline/policy rechecked
 *  by existing authority at commit time). */
export function continueAllowed(
  config: CoordinationConfigV1,
  iterationNumber: number,
  cumulativeWorkers: number,
  nextBatchSize: number,
): boolean {
  return (
    iterationNumber < config.maxIterations &&
    cumulativeWorkers + nextBatchSize <= config.maxTotalWorkers
  );
}

/** Strict parse of an untrusted Verifier decision. */
export function parseVerifierDecision(value: unknown): VerifierDecisionV1 {
  const snapshot = isRecord(value) ? value : {};
  if (snapshot.schemaVersion !== 1) {
    throw new CoordinationError(
      "DECISION_INVALID",
      `VerifierDecision schemaVersion must be 1 (got ${String(snapshot.schemaVersion)})`,
    );
  }
  const iterationId = boundedString(
    snapshot.iterationId,
    "iterationId",
    255,
    "DECISION_INVALID",
  );
  const iterationNumber = boundedInteger(
    snapshot.iterationNumber,
    "iterationNumber",
    1,
    COORDINATION_BOUNDS.maxIterations,
    "DECISION_INVALID",
  );
  if (!VERIFIER_ACTIONS.includes(snapshot.action as VerifierAction)) {
    throw new CoordinationError(
      "DECISION_INVALID",
      `action must be one of ${VERIFIER_ACTIONS.join(", ")}`,
    );
  }
  const evidenceRefs = snapshot.evidenceRefs ?? [];
  if (
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length > COORDINATION_BOUNDS.maxEvidenceRefs ||
    !evidenceRefs.every(
      (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 255,
    )
  ) {
    throw new CoordinationError(
      "DECISION_INVALID",
      `evidenceRefs must be an array of 1-${COORDINATION_BOUNDS.maxEvidenceRefs} short ids`,
    );
  }
  const decision: VerifierDecisionV1 = {
    schemaVersion: 1,
    iterationId,
    iterationNumber,
    action: snapshot.action as VerifierAction,
    reason: boundedString(
      snapshot.reason,
      "reason",
      COORDINATION_BOUNDS.maxDecisionReasonLength,
      "DECISION_INVALID",
    ),
    evidenceRefs: evidenceRefs as string[],
  };
  if (snapshot.recommendation !== undefined) {
    const recommendation = isRecord(snapshot.recommendation) ? snapshot.recommendation : {};
    const focus = recommendation.focus ?? [];
    if (
      !Array.isArray(focus) ||
      focus.length > COORDINATION_BOUNDS.maxRecommendationFocus ||
      new Set(focus).size !== focus.length ||
      !focus.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 255)
    ) {
      throw new CoordinationError(
        "DECISION_INVALID",
        `recommendation.focus must be an array of 1-${COORDINATION_BOUNDS.maxRecommendationFocus} distinct short strings`,
      );
    }
    const recommendationValue = {
      reason: boundedString(
        recommendation.reason,
        "recommendation.reason",
        COORDINATION_BOUNDS.maxReasonLength,
        "DECISION_INVALID",
      ),
      focus: focus as string[],
    };
    boundedBytes(recommendationValue, "recommendation", COORDINATION_BOUNDS.maxRecommendationBytes);
    decision.recommendation = recommendationValue;
  }
  return decision;
}

/** Canonical identity of a decision for idempotency/conflict detection. */
export function canonicalDecisionHash(decision: VerifierDecisionV1): string {
  return sha256Json(decision);
}

/**
 * Idempotency/conflict: identical identity (iterationId + number + payload)
 * is idempotent; the same identity with a different payload is a conflict
 * and changes nothing.
 */
export function decisionsConflict(
  left: VerifierDecisionV1,
  right: VerifierDecisionV1,
): boolean {
  return (
    left.iterationId === right.iterationId &&
    left.iterationNumber === right.iterationNumber &&
    canonicalDecisionHash(left) !== canonicalDecisionHash(right)
  );
}

/**
 * Required/optional fan-in: `ready` means every REQUIRED worker has a
 * terminal outcome; optional workers are awaited once admitted but their
 * failure alone never fails the loop.
 */
export function fanInReady(
  terminalByTaskId: ReadonlyMap<string, WorkerOutcomeSummaryV1["status"]>,
  requiredTaskIds: readonly string[],
): boolean {
  return requiredTaskIds.every((taskId) => terminalByTaskId.has(taskId));
}

function truncate(value: string, maxBytes: number): { value: string; omitted: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, omitted: false };
  }
  let end = maxBytes;
  while (end > 0 && (Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes)) {
    end -= 1;
  }
  return { value: `${value.slice(0, end)}…`, omitted: true };
}

/**
 * Deterministic bounded aggregation for the Verifier. Explicit selection
 * only: summaries are truncated, output fields are the ones the operator
 * selected, artifact refs are bounded ids — never bytes, logs, chain of
 * thought, or secrets. Omissions are recorded as metadata.
 */
export function buildVerifierContext(input: {
  iterationId: string;
  iterationNumber: number;
  workers: WorkerOutcomeSummaryV1[];
  executionStateKeys: Record<string, unknown>;
  priorDecision?: { action: VerifierAction; reason: string };
  limits: VerifierContextV1["limits"];
  evidence: string[];
  /** Explicitly selected ExecutionState keys (allowlist). */
  selectedStateKeys: readonly string[];
  /** Product Phase 1: frozen workspace snapshot (bounded), when the run
   *  has one. */
  workspace?: WorkspaceSnapshotV1;
}): VerifierContextV1 {
  if (input.workers.length > COORDINATION_BOUNDS.maxAggregateWorkers) {
    throw new CoordinationError(
      "AGGREGATION_INVALID",
      `aggregation of ${input.workers.length} workers exceeds ${COORDINATION_BOUNDS.maxAggregateWorkers}`,
    );
  }
  const omitted: string[] = [];
  const workers: WorkerOutcomeSummaryV1[] = input.workers.map((worker) => {
    const summary =
      worker.summary === undefined
        ? undefined
        : truncate(worker.summary, COORDINATION_BOUNDS.maxWorkerSummaryBytes);
    if (summary?.omitted) omitted.push(`worker.${worker.taskId}.summary`);
    const selectedFields: Record<string, unknown> | undefined =
      worker.selectedFields === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(worker.selectedFields).map(([key, value]) => {
              let normalized = value;
              const rendered = JSON.stringify(value);
              if (Buffer.byteLength(rendered, "utf8") > COORDINATION_BOUNDS.maxSelectedFieldBytes) {
                normalized = { truncated: true, bytes: Buffer.byteLength(rendered, "utf8") };
                omitted.push(`worker.${worker.taskId}.field.${key}`);
              }
              return [key, normalized];
            }),
          );
    return {
      taskId: worker.taskId,
      status: worker.status,
      ...(worker.failureCode ? { failureCode: worker.failureCode } : {}),
      ...(summary ? { summary: summary.value } : {}),
      ...(selectedFields ? { selectedFields } : {}),
      artifactRefs: worker.artifactRefs.slice(0, COORDINATION_BOUNDS.maxArtifactRefs),
    };
  });
  const executionStateKeys: Record<string, unknown> = {};
  for (const key of input.selectedStateKeys) {
    if (Object.prototype.hasOwnProperty.call(input.executionStateKeys, key)) {
      if (Object.keys(executionStateKeys).length >= COORDINATION_BOUNDS.maxExecutionStateKeys) {
        omitted.push("executionStateKeys.limit");
        break;
      }
      executionStateKeys[key] = input.executionStateKeys[key];
    }
  }
  const aggregate: VerifierContextV1 = {
    schemaVersion: 1,
    iterationId: input.iterationId,
    iterationNumber: input.iterationNumber,
    workers,
    executionStateKeys,
    limits: input.limits,
    evidence: input.evidence.slice(0, COORDINATION_BOUNDS.maxEvidenceRefs),
    omitted: omitted.slice(0, COORDINATION_BOUNDS.maxEvidenceRefs),
  };
  if (input.priorDecision) {
    aggregate.priorDecision = {
      action: input.priorDecision.action,
      reason: truncate(input.priorDecision.reason, COORDINATION_BOUNDS.maxReasonLength).value,
    };
  }
  if (input.workspace) {
    aggregate.workspace = input.workspace;
  }
  if (Buffer.byteLength(JSON.stringify(aggregate), "utf8") > COORDINATION_BOUNDS.maxAggregateBytes) {
    throw new CoordinationError(
      "AGGREGATION_INVALID",
      `aggregation exceeds ${COORDINATION_BOUNDS.maxAggregateBytes} bytes`,
    );
  }
  return aggregate;
}
