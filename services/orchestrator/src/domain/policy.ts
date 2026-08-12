import { sha256Json } from "./canonical-json";

/**
 * M4-S3: bounded ActionProposal and immutable PolicyDecision domain.
 *
 * Rules (SPEC M4):
 * - policy configuration is trusted and versioned; untrusted
 *   pipeline/runtime metadata can never select a more permissive policy;
 * - evaluation is deterministic under a FROZEN PolicySnapshot (version +
 *   canonical hash); every decision is append-only evidence storing the
 *   proposal hash, bounded facts, policy version/hash, effect, reasons, and
 *   timestamps;
 * - an ALLOW decision without a successful required reservation grants no
 *   authority (the dispatch boundary reserves AFTER the policy decision);
 * - rule data is minimal and deterministic: exact-match constraints on
 *   bounded proposal facts, effects allow | deny | require_approval. No
 *   executable strings, no generic policy language.
 */

export type PolicyEffect = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";

export const POLICY_EFFECTS: PolicyEffect[] = [
  "ALLOW",
  "DENY",
  "REQUIRE_APPROVAL",
];

/** Bounded action types Tenvyr can intercept before side effects. */
export type PolicyActionType =
  | "dispatch"
  | "plan_patch"
  | "delegate"
  | "executor_action";

export const POLICY_ACTION_TYPES: PolicyActionType[] = [
  "dispatch",
  "plan_patch",
  "delegate",
  "executor_action",
];

export const POLICY_BOUNDS = {
  proposalIdMaxLength: 64,
  scopeIdMaxLength: 255,
  targetMaxLength: 255,
  reasonsMaxCount: 16,
  reasonMaxLength: 255,
  rulesMaxCount: 256,
  ruleIdMaxLength: 64,
  agentsMaxCount: 64,
  agentMaxLength: 255,
  executorsMaxCount: 16,
  executorMaxLength: 255,
} as const;

export type PolicyErrorCode =
  | "POLICY_CONFIG_INVALID"
  | "POLICY_VERSION_CONFLICT"
  | "PROPOSAL_INVALID"
  | "SNAPSHOT_NOT_FOUND";

export class PolicyError extends Error {
  readonly code: PolicyErrorCode;
  constructor(code: PolicyErrorCode, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

/**
 * Bounded immutable description of ONE consequential action. The hash is
 * the canonical identity used by decisions and (later) approvals.
 */
export type ActionProposal = {
  /** Stable action identity (e.g. attempt invocation id). */
  proposalId: string;
  actionType: PolicyActionType;
  /** Bounded scope facts: execution/step identifiers. */
  scope: {
    executionId: string;
    logicalStepId?: string;
    attemptNumber?: number;
  };
  /** Bounded target facts (agent name / executor kind). */
  target?: {
    agent?: string;
    executor?: string;
  };
  /** Canonical SHA-256 of the proposal's bounded facts. */
  hash: string;
  createdAt: string;
};

export type PolicyRule = {
  id: string;
  actionType: PolicyActionType;
  effect: PolicyEffect;
  /** Exact-match agent allowlist constraint (rule applies when listed). */
  agents?: string[];
  /** Exact-match executor-kind constraint. */
  executors?: string[];
};

export type PolicySnapshotData = {
  version: number;
  /** Canonical SHA-256 of the rules. */
  hash: string;
  rules: PolicyRule[];
};

export type PolicyDecision = {
  decisionId: string;
  proposalHash: string;
  policyVersion: number;
  policyHash: string;
  effect: PolicyEffect;
  reasons: string[];
  evaluatedAt: string;
};

/** Bounded facts the dispatch boundary can offer a policy (from step config). */
export type DispatchProposalFacts = {
  executionId: string;
  logicalStepId: string;
  attemptNumber: number;
  agent: string;
  executor: string;
};

export function buildDispatchProposal(
  proposalId: string,
  facts: DispatchProposalFacts,
): ActionProposal {
  if (
    typeof proposalId !== "string" ||
    !proposalId ||
    proposalId.length > POLICY_BOUNDS.proposalIdMaxLength
  ) {
    throw new PolicyError(
      "PROPOSAL_INVALID",
      `proposalId must be 1-${POLICY_BOUNDS.proposalIdMaxLength} characters`,
    );
  }
  for (const [field, value, max] of [
    ["scope.executionId", facts.executionId, POLICY_BOUNDS.scopeIdMaxLength],
    [
      "scope.logicalStepId",
      facts.logicalStepId,
      POLICY_BOUNDS.scopeIdMaxLength,
    ],
    ["target.agent", facts.agent, POLICY_BOUNDS.targetMaxLength],
    ["target.executor", facts.executor, POLICY_BOUNDS.executorMaxLength],
  ] as const) {
    if (typeof value !== "string" || !value || value.length > max) {
      throw new PolicyError(
        "PROPOSAL_INVALID",
        `${field} must be 1-${max} characters`,
      );
    }
  }
  const proposal: ActionProposal = {
    proposalId,
    actionType: "dispatch",
    scope: {
      executionId: facts.executionId,
      logicalStepId: facts.logicalStepId,
      attemptNumber: facts.attemptNumber,
    },
    target: { agent: facts.agent, executor: facts.executor },
    hash: "",
    createdAt: new Date().toISOString(),
  };
  proposal.hash = proposalHash(proposal);
  return proposal;
}

/** M5-S4: bounded plan_patch proposal for proposal activation
 *  interception. The action is the plan change itself (not agent-specific);
 *  the proposal id is `plan:<proposalId>` so approval evidence is unique. */
export function buildPlanPatchProposal(
  proposalId: string,
  executionId: string,
): ActionProposal {
  if (
    typeof proposalId !== "string" ||
    !proposalId ||
    proposalId.length > POLICY_BOUNDS.proposalIdMaxLength
  ) {
    throw new PolicyError(
      "PROPOSAL_INVALID",
      `proposalId must be 1-${POLICY_BOUNDS.proposalIdMaxLength} characters`,
    );
  }
  if (
    typeof executionId !== "string" ||
    !executionId ||
    executionId.length > POLICY_BOUNDS.scopeIdMaxLength
  ) {
    throw new PolicyError(
      "PROPOSAL_INVALID",
      `executionId must be 1-${POLICY_BOUNDS.scopeIdMaxLength} characters`,
    );
  }
  const proposal: ActionProposal = {
    proposalId,
    actionType: "plan_patch",
    scope: { executionId },
    hash: "",
    createdAt: new Date().toISOString(),
  };
  proposal.hash = proposalHash(proposal);
  return proposal;
}

/** Bounded supervised-delegation proposal. The durable request row id is
 * used as the proposal identity so retries evaluate the same action. */
export function buildDelegationProposal(
  proposalId: string,
  executionId: string,
  requestedAgent: string,
): ActionProposal {
  for (const [field, value, max] of [
    ["proposalId", proposalId, POLICY_BOUNDS.proposalIdMaxLength],
    ["executionId", executionId, POLICY_BOUNDS.scopeIdMaxLength],
    ["requestedAgent", requestedAgent, POLICY_BOUNDS.targetMaxLength],
  ] as const) {
    if (typeof value !== "string" || !value || value.length > max) {
      throw new PolicyError(
        "PROPOSAL_INVALID",
        `${field} must be 1-${max} characters`,
      );
    }
  }
  const proposal: ActionProposal = {
    proposalId,
    actionType: "delegate",
    scope: { executionId },
    target: { agent: requestedAgent },
    hash: "",
    createdAt: new Date().toISOString(),
  };
  proposal.hash = proposalHash(proposal);
  return proposal;
}

/** Canonical hash over the bounded proposal facts (never the full payloads). */
export function proposalHash(proposal: Omit<ActionProposal, "hash">): string {
  return sha256Json({
    proposalId: proposal.proposalId,
    actionType: proposal.actionType,
    scope: proposal.scope,
    target: proposal.target,
  });
}

export function parsePolicySnapshot(value: unknown): PolicySnapshotData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError("POLICY_CONFIG_INVALID", "Policy must be an object");
  }
  const record = value as Record<string, unknown>;
  const version = record.version;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version <= 0
  ) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      "Policy version must be a positive integer",
    );
  }
  if (!Array.isArray(record.rules) || record.rules.length === 0) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      "Policy must declare at least one rule",
    );
  }
  if (record.rules.length > POLICY_BOUNDS.rulesMaxCount) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `Policy exceeds ${POLICY_BOUNDS.rulesMaxCount} rules`,
    );
  }
  const rules = record.rules.map((rule, index) => parseRule(rule, index));
  const hash = sha256Json({
    version,
    rules: rules.map((rule) => ({
      id: rule.id,
      actionType: rule.actionType,
      effect: rule.effect,
      agents: rule.agents ?? [],
      executors: rule.executors ?? [],
    })),
  });
  return { version, hash, rules };
}

function parseRule(value: unknown, index: number): PolicyRule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `rules[${index}] must be an object`,
    );
  }
  const record = value as Record<string, unknown>;
  const id = boundedString(
    record.id,
    `rules[${index}].id`,
    POLICY_BOUNDS.ruleIdMaxLength,
  );
  const actionType = record.actionType;
  if (!POLICY_ACTION_TYPES.includes(actionType as PolicyActionType)) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `rules[${index}].actionType must be one of ${POLICY_ACTION_TYPES.join(", ")}`,
    );
  }
  const effect = record.effect;
  if (!POLICY_EFFECTS.includes(effect as PolicyEffect)) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `rules[${index}].effect must be one of ${POLICY_EFFECTS.join(", ")}`,
    );
  }
  const agents = stringArray(
    record.agents,
    `rules[${index}].agents`,
    POLICY_BOUNDS.agentsMaxCount,
    POLICY_BOUNDS.agentMaxLength,
  );
  const executors = stringArray(
    record.executors,
    `rules[${index}].executors`,
    POLICY_BOUNDS.executorsMaxCount,
    POLICY_BOUNDS.executorMaxLength,
  );
  const rule: PolicyRule = {
    id,
    actionType: actionType as PolicyActionType,
    effect: effect as PolicyEffect,
  };
  if (agents) rule.agents = agents;
  if (executors) rule.executors = executors;
  return rule;
}

/**
 * Deterministic first-match evaluation: the first rule whose actionType and
 * constraints match the proposal decides. No matching rule → ALLOW (policy
 * is opt-in declarative data; a missing rule declares no restriction).
 * Untrusted proposal metadata can only match EXACT trusted constraints —
 * it can never select a more permissive rule than the config defines.
 */
export function evaluateProposal(
  proposal: ActionProposal,
  snapshot: PolicySnapshotData,
): PolicyDecision {
  for (const rule of snapshot.rules) {
    if (rule.actionType !== proposal.actionType) continue;
    if (rule.agents && !rule.agents.includes(proposal.target?.agent ?? ""))
      continue;
    if (
      rule.executors &&
      !rule.executors.includes(proposal.target?.executor ?? "")
    )
      continue;
    return {
      decisionId: proposal.proposalId,
      proposalHash: proposal.hash,
      policyVersion: snapshot.version,
      policyHash: snapshot.hash,
      effect: rule.effect,
      reasons: [`matched rule ${rule.id}`],
      evaluatedAt: new Date().toISOString(),
    };
  }
  return {
    decisionId: proposal.proposalId,
    proposalHash: proposal.hash,
    policyVersion: snapshot.version,
    policyHash: snapshot.hash,
    effect: "ALLOW",
    reasons: ["no matching rule; default allow"],
    evaluatedAt: new Date().toISOString(),
  };
}

function boundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function stringArray(
  value: unknown,
  field: string,
  maxCount: number,
  maxLength: number,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxCount) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `${field} must be an array of at most ${maxCount} strings`,
    );
  }
  return value.map((entry, index) =>
    boundedString(entry, `${field}[${index}]`, maxLength),
  );
}
