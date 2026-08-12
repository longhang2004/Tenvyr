/**
 * M4-S1: budget vocabulary and append-only ledger domain.
 *
 * Pure, framework-free budget semantics shared by the ledger service and
 * tests. Rules (SPEC M4):
 * - amounts are integers in canonical base units per dimension; no binary
 *   floating-point money; dimensions never silently convert;
 * - negative amounts, overflow, unknown dimensions, and cross-unit
 *   arithmetic are rejected;
 * - every transition is append-only and idempotent; prior evidence never
 *   mutates;
 * - `unknown` usage is never zero: a hard-budget action must reserve an
 *   approved maximum or be denied; if actual never arrives the reservation
 *   remains consumed by default (only explicit policy may release it);
 * - refund/release means unused reservation only, never erasing actual work.
 *
 * Availability projection (per account, per dimension):
 *   available = ceiling + sum(adjust.delta) + sum(release.amount)
 *               - sum(reserve.amount)
 * Commit entries are actual-usage evidence and do not move availability:
 * a committed reservation keeps its reserve debit; release credits the
 * unused part back.
 */

export const BUDGET_DIMENSIONS = {
  currency_micros: "currency micros (integer, 1/1_000_000 of one unit)",
  tokens: "tokens (integer)",
  wall_time_ms: "wall-time milliseconds (integer)",
} as const;

export type BudgetDimension = keyof typeof BUDGET_DIMENSIONS;

export const BUDGET_DIMENSION_IDS = Object.keys(
  BUDGET_DIMENSIONS,
) as BudgetDimension[];

/** Actual/estimated/unknown usage semantics with source and confidence. */
export type BudgetSource = "actual" | "estimated" | "unknown";

export const BUDGET_SOURCES: BudgetSource[] = ["actual", "estimated", "unknown"];

export type LedgerOperation = "reserve" | "commit" | "release" | "adjust";

export const LEDGER_OPERATIONS: LedgerOperation[] = [
  "reserve",
  "commit",
  "release",
  "adjust",
];

export type ReservationStatus = "ACTIVE" | "COMMITTED" | "RELEASED" | "ADJUSTED";

export const RESERVATION_STATUSES: ReservationStatus[] = [
  "ACTIVE",
  "COMMITTED",
  "RELEASED",
  "ADJUSTED",
];

/** Largest amount accepted: canonical integers only, safely below 2^53. */
export const BUDGET_AMOUNT_MAX = Number.MAX_SAFE_INTEGER;

/** Bounds on untrusted inputs at every ledger boundary. */
export const BUDGET_BOUNDS = {
  scopeTypeMaxLength: 32,
  scopeIdMaxLength: 255,
  idempotencyKeyMaxLength: 255,
  actionRefMaxLength: 255,
  dimensionMaxLength: 32,
  evidenceMaxBytes: 4096,
  /** Hierarchical scope chain depth ceiling (child → root). */
  accountChainMaxDepth: 16,
  /** Maximum number of ledger entries loaded per projection page. */
  projectionPageSize: 10_000,
  confidenceMax: 100,
} as const;

export type BudgetErrorCode =
  | "DIMENSION_UNKNOWN"
  | "AMOUNT_INVALID"
  | "AMOUNT_OVERFLOW"
  | "EVIDENCE_TOO_LARGE"
  | "INSUFFICIENT_BUDGET"
  | "IDEMPOTENCY_CONFLICT"
  | "RESERVATION_NOT_ACTIVE"
  | "RESERVATION_AMOUNT_EXCEEDED"
  | "SCOPE_ALREADY_EXISTS"
  | "ACCOUNT_NOT_FOUND"
  | "CHAIN_TOO_DEEP"
  | "CHILD_CEILING_EXCEEDS_PARENT"
  | "DIMENSION_MISSING"
  | "CONFIDENCE_INVALID"
  | "DELTA_INVALID"
  | "AVAILABILITY_NEGATIVE"
  | "PROJECTION_TOO_LARGE"
  | "INPUT_INVALID";

export class BudgetError extends Error {
  readonly code: BudgetErrorCode;
  constructor(code: BudgetErrorCode, message: string) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
  }
}

export type BudgetAmounts = Partial<Record<BudgetDimension, number>>;

export function validateDimension(dimension: string): BudgetDimension {
  if (!BUDGET_DIMENSION_IDS.includes(dimension as BudgetDimension)) {
    throw new BudgetError(
      "DIMENSION_UNKNOWN",
      `Unknown budget dimension "${dimension}"; supported: ${BUDGET_DIMENSION_IDS.join(", ")}`,
    );
  }
  return dimension as BudgetDimension;
}

/**
 * Amounts are canonical positive integers in the dimension's base unit.
 * Zero is rejected for reserve/commit (a zero reservation is a no-op that
 * must not mint evidence); adjust deltas are validated separately and may
 * be negative.
 */
export function validateAmount(
  dimension: string,
  amount: unknown,
): number {
  validateDimension(dimension);
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    throw new BudgetError(
      "AMOUNT_INVALID",
      `${dimension} amounts must be positive integers in canonical base units`,
    );
  }
  if (amount > BUDGET_AMOUNT_MAX) {
    throw new BudgetError(
      "AMOUNT_OVERFLOW",
      `${dimension} amount exceeds the safe integer bound`,
    );
  }
  return amount;
}

export function validateDelta(dimension: string, delta: unknown): number {
  validateDimension(dimension);
  if (typeof delta !== "number" || !Number.isInteger(delta) || delta === 0) {
    throw new BudgetError(
      "DELTA_INVALID",
      `${dimension} adjust delta must be a non-zero integer`,
    );
  }
  if (Math.abs(delta) > BUDGET_AMOUNT_MAX) {
    throw new BudgetError("AMOUNT_OVERFLOW", `${dimension} adjust delta overflows`);
  }
  return delta;
}

export function validateSource(source: unknown): BudgetSource {
  if (!BUDGET_SOURCES.includes(source as BudgetSource)) {
    throw new BudgetError(
      "CONFIDENCE_INVALID",
      `Usage source must be one of ${BUDGET_SOURCES.join(", ")}`,
    );
  }
  return source as BudgetSource;
}

export function validateConfidence(confidence: unknown): number | undefined {
  if (confidence === undefined || confidence === null) return undefined;
  if (
    typeof confidence !== "number" ||
    !Number.isInteger(confidence) ||
    confidence < 0 ||
    confidence > BUDGET_BOUNDS.confidenceMax
  ) {
    throw new BudgetError(
      "CONFIDENCE_INVALID",
      `Confidence must be an integer between 0 and ${BUDGET_BOUNDS.confidenceMax}`,
    );
  }
  return confidence;
}

export function validateCeilings(ceilings: unknown): BudgetAmounts {
  if (ceilings === null || typeof ceilings !== "object" || Array.isArray(ceilings)) {
    throw new BudgetError("DIMENSION_MISSING", "Ceilings must be an object");
  }
  const result: BudgetAmounts = {};
  for (const [dimension, amount] of Object.entries(
    ceilings as Record<string, unknown>,
  )) {
    result[validateDimension(dimension)] = validateAmount(dimension, amount);
  }
  if (Object.keys(result).length === 0) {
    throw new BudgetError("DIMENSION_MISSING", "At least one ceiling dimension is required");
  }
  return result;
}

export function validateEvidence(evidence: unknown): Record<string, unknown> | undefined {
  if (evidence === undefined || evidence === null) return undefined;
  if (typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new BudgetError("EVIDENCE_TOO_LARGE", "Evidence must be an object");
  }
  const bytes = Buffer.byteLength(JSON.stringify(evidence), "utf8");
  if (bytes > BUDGET_BOUNDS.evidenceMaxBytes) {
    throw new BudgetError(
      "EVIDENCE_TOO_LARGE",
      `Evidence exceeds ${BUDGET_BOUNDS.evidenceMaxBytes} bytes`,
    );
  }
  return evidence as Record<string, unknown>;
}

export type BudgetEntryFact = {
  operation: LedgerOperation;
  dimension: BudgetDimension;
  /** Positive magnitude (canonical units). */
  amount: number;
  /** Signed adjust delta (adjust only). */
  delta?: number;
  source: BudgetSource;
  confidence?: number;
};

export type BudgetCeilings = {
  /** Immutable grant ceilings per dimension. */
  ceilings: BudgetAmounts;
  /** Optional soft ceilings per dimension (policy trigger, not a hard cap). */
  softCeilings?: BudgetAmounts;
};

/**
 * Pure availability projection over ledger facts for ONE account and
 * dimension:
 *   ceiling + adjustDeltas + releases − reserves
 * Commit entries are evidence only. Throws on a negative result (the ledger
 * is corrupt or the projection caller violated an invariant).
 */
export function projectAvailable(
  ceilings: BudgetAmounts,
  facts: BudgetEntryFact[],
  dimension: BudgetDimension,
): number {
  validateDimension(dimension);
  let available = ceilings[dimension] ?? 0;
  for (const fact of facts) {
    if (fact.dimension !== dimension) continue;
    if (fact.operation === "reserve") available -= fact.amount;
    else if (fact.operation === "release") available += fact.amount;
    else if (fact.operation === "adjust") available += fact.delta ?? 0;
    // commit: evidence only
  }
  if (available < 0) {
    throw new BudgetError(
      "AVAILABILITY_NEGATIVE",
      `Budget ledger projection for ${dimension} is negative (${available})`,
    );
  }
  return available;
}

/**
 * Per-dimension projection for one account. Missing dimensions project to
 * zero availability.
 */
export function projectAll(
  ceilings: BudgetAmounts,
  facts: BudgetEntryFact[],
): BudgetAmounts {
  const result: BudgetAmounts = {};
  const dimensions = new Set<BudgetDimension>([
    ...(Object.keys(ceilings) as BudgetDimension[]),
    ...facts.map((fact) => fact.dimension),
  ]);
  for (const dimension of dimensions) {
    result[dimension] = projectAvailable(ceilings, facts, dimension);
  }
  return result;
}

// ---- M4-S2: pipeline budget config and canonical usage mapping -----------

export type StepBudgetConfig = Partial<Record<BudgetDimension, number>>;

/**
 * Parses an optional pipeline/step `budget` declaration: per-dimension
 * positive canonical integers; unknown keys and non-integers are rejected.
 * `undefined` means "no budget declared" (enforcement is opt-in).
 */

// ---- M4-S5: pipeline budget envelope with optional parent scope ----------

export type BudgetParentScope = {
  scopeType: string;
  scopeId: string;
};

export type PipelineBudgetConfig = {
  /** Optional operator-managed ancestor account (must already exist). */
  parent?: BudgetParentScope;
  ceilings: StepBudgetConfig;
};

/**
 * Parses the pipeline-level budget declaration envelope:
 * `{ parent?: { scopeType, scopeId }, <dimension>: <amount>, ... }`.
 * The parent must reference an EXISTING operator-created account (the
 * pipeline never defines grants for ancestors — missing parents are a
 * deterministic safe failure at claim). Steps keep the plain dimension
 * form (`parseStepBudget`).
 */
export function parsePipelineBudget(value: unknown): PipelineBudgetConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BudgetError(
      "INPUT_INVALID",
      "Pipeline budget must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  let parent: BudgetParentScope | undefined;
  if (record.parent !== undefined && record.parent !== null) {
    if (
      typeof record.parent !== "object" ||
      Array.isArray(record.parent)
    ) {
      throw new BudgetError(
        "INPUT_INVALID",
        "Pipeline budget parent must be an object",
      );
    }
    const parentRecord = record.parent as Record<string, unknown>;
    if (
      typeof parentRecord.scopeType !== "string" ||
      !parentRecord.scopeType.trim() ||
      parentRecord.scopeType.length > BUDGET_BOUNDS.scopeTypeMaxLength ||
      typeof parentRecord.scopeId !== "string" ||
      !parentRecord.scopeId.trim() ||
      parentRecord.scopeId.length > BUDGET_BOUNDS.scopeIdMaxLength
    ) {
      throw new BudgetError(
        "INPUT_INVALID",
        "Pipeline budget parent must carry bounded scopeType and scopeId",
      );
    }
    parent = {
      scopeType: parentRecord.scopeType,
      scopeId: parentRecord.scopeId,
    };
  }
  // Idempotent round-trip: the VALIDATED envelope (parent + ceilings) is
  // what gets stored on the pipeline and re-parsed at execution time, so
  // both the flat form ({ tokens: 100 }) and the envelope form
  // ({ parent?, ceilings: { tokens: 100 } }) must parse.
  let ceilings: StepBudgetConfig;
  if (
    record.ceilings !== undefined &&
    record.ceilings !== null &&
    typeof record.ceilings === "object" &&
    !Array.isArray(record.ceilings)
  ) {
    ceilings = validateCeilings(record.ceilings) as StepBudgetConfig;
  } else {
    const { parent: _ignored, ...dimensions } = record;
    ceilings = validateCeilings(dimensions) as StepBudgetConfig;
  }
  return { ...(parent === undefined ? {} : { parent }), ceilings };
}

export function parseStepBudget(value: unknown): StepBudgetConfig | undefined {
  if (value === undefined || value === null) return undefined;
  return validateCeilings(value) as StepBudgetConfig;
}

/**
 * Deterministic reservation key for ONE attempt: one key per attempt per
 * dimension, so workflow retries charge independently and redelivery of the
 * same outbox row can never reserve twice.
 */
export function reservationKeyForAttempt(
  executionId: string,
  logicalStepId: string,
  attemptNumber: number,
  dimension: BudgetDimension,
): string {
  return `${executionId}:${logicalStepId}:${attemptNumber}:${dimension}`;
}

export type UsageObservation = {
  dimension: BudgetDimension;
  amount: number;
  source: BudgetSource;
};

/**
 * Maps the canonical result's `usage` block to ledger observations:
 * - `totalTokens` → `tokens`, source `actual` (runtime-reported within the
 *   supported protocol boundary);
 * - `costUsd` → `currency_micros` = round(costUsd × 1_000_000), source
 *   `estimated` (provider billing is an estimate, reconcilable by adjust);
 * - invalid values (negative, NaN, non-finite) are rejected — a malformed
 *   usage block must never mint or erase money.
 * Absent/missing usage maps to NO observations: the reservation then stays
 * consumed by default (unknown is never zero).
 */
export function usageFromResult(
  usage: unknown,
): UsageObservation[] {
  if (usage === undefined || usage === null) return [];
  if (typeof usage !== "object" || Array.isArray(usage)) {
    throw new BudgetError("AMOUNT_INVALID", "Result usage must be an object");
  }
  const value = usage as Record<string, unknown>;
  const observations: UsageObservation[] = [];
  if (value.totalTokens !== undefined && value.totalTokens !== null) {
    observations.push({
      dimension: "tokens",
      amount: validateAmount("tokens", value.totalTokens),
      source: "actual",
    });
  }
  if (value.costUsd !== undefined && value.costUsd !== null) {
    if (
      typeof value.costUsd !== "number" ||
      !Number.isFinite(value.costUsd) ||
      value.costUsd < 0
    ) {
      throw new BudgetError(
        "AMOUNT_INVALID",
        "Result usage costUsd must be a non-negative finite number",
      );
    }
    const micros = Math.round(value.costUsd * 1_000_000);
    if (micros <= 0) {
      throw new BudgetError(
        "AMOUNT_INVALID",
        "Result usage costUsd rounds to zero currency micros",
      );
    }
    observations.push({
      dimension: "currency_micros",
      amount: validateAmount("currency_micros", micros),
      source: "estimated",
    });
  }
  return observations;
}
