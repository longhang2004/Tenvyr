/**
 * Runtime guards for authoritative Gateway/Orchestrator DTOs.
 *
 * Policy: authority/health states are NEVER defaulted optimistically. A
 * missing or malformed server field is an error (the UI shows
 * "Unknown / malformed response"), never a fabricated readiness literal.
 * Status enums are exhaustive; an unknown state string maps to "UNKNOWN",
 * not to "READY".
 */
import {
  CONNECTION_STATUS_REASON_CODES,
  CONNECTION_STATUS_STATES,
  type ConnectionStatusReasonCode,
  type ConnectionStatusState,
  type ConnectionTestReceiptV1,
  type ConnectionTestResultV1,
  type WorkbenchCommandResultV1,
} from "./types.ts";

export class MalformedResponseError extends Error {
  public readonly path: string;

  constructor(path: string) {
    super(`Unknown / malformed response (invalid field: ${path})`);
    this.name = "MalformedResponseError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isConnectionStatusState(
  value: unknown,
): value is ConnectionStatusState {
  return (
    typeof value === "string" &&
    (CONNECTION_STATUS_STATES as readonly string[]).includes(value)
  );
}

export function isConnectionStatusReasonCode(
  value: unknown,
): value is ConnectionStatusReasonCode {
  return (
    typeof value === "string" &&
    (CONNECTION_STATUS_REASON_CODES as readonly string[]).includes(value)
  );
}

/** Bounded strict parse of the connection-test receipt (backend
 *  `TestConnectionReceipt`). Every field is checked; unknown fields are
 *  rejected so a changed server shape cannot be silently coerced. */
export function parseConnectionTestReceipt(
  value: unknown,
): ConnectionTestReceiptV1 {
  if (!isRecord(value)) throw new MalformedResponseError("receipt");
  if (!isNonEmptyString(value.connectionId))
    throw new MalformedResponseError("receipt.connectionId");
  if (!isFiniteNumber(value.revisionNumber) || value.revisionNumber < 1) {
    throw new MalformedResponseError("receipt.revisionNumber");
  }
  if (!isNonEmptyString(value.testedAt))
    throw new MalformedResponseError("receipt.testedAt");
  if (!isConnectionStatusState(value.state)) {
    throw new MalformedResponseError(
      `receipt.state (got ${String(value.state)})`,
    );
  }
  if (!isConnectionStatusReasonCode(value.reasonCode)) {
    throw new MalformedResponseError(
      `receipt.reasonCode (got ${String(value.reasonCode)})`,
    );
  }
  if (!isFiniteNumber(value.durationMs) || value.durationMs < 0) {
    throw new MalformedResponseError("receipt.durationMs");
  }
  const receipt: ConnectionTestReceiptV1 = {
    connectionId: value.connectionId,
    revisionNumber: value.revisionNumber,
    testedAt: value.testedAt,
    state: value.state,
    reasonCode: value.reasonCode,
    durationMs: value.durationMs,
  };
  if (value.testedVersion !== undefined) {
    if (!isNonEmptyString(value.testedVersion)) {
      throw new MalformedResponseError("receipt.testedVersion");
    }
    receipt.testedVersion = value.testedVersion;
  }
  if (value.superseded !== undefined) {
    if (typeof value.superseded !== "boolean") {
      throw new MalformedResponseError("receipt.superseded");
    }
    receipt.superseded = value.superseded;
  }
  return receipt;
}

/**
 * Strict parse of the Workbench command envelope returned by
 * `POST /api/connections/:id/test`. The receipt is nested under
 * `result.receipt`; a response without it is malformed and must surface as
 * an error — it must never fall through to a fabricated "READY".
 */
export function parseConnectionTestResult(
  value: unknown,
): ConnectionTestResultV1 {
  if (!isRecord(value))
    throw new MalformedResponseError("test-connection result");
  if (value.action !== "test-connection") {
    throw new MalformedResponseError(`action (got ${String(value.action)})`);
  }
  if (!isNonEmptyString(value.idempotencyKey)) {
    throw new MalformedResponseError("idempotencyKey");
  }
  if (
    value.outcome !== "executed" &&
    value.outcome !== "duplicate" &&
    value.outcome !== "rejected"
  ) {
    throw new MalformedResponseError(`outcome (got ${String(value.outcome)})`);
  }
  if (!isRecord(value.result)) throw new MalformedResponseError("result");
  if (!isNonEmptyString(value.result.connectionId)) {
    throw new MalformedResponseError("result.connectionId");
  }
  return {
    action: "test-connection",
    idempotencyKey: value.idempotencyKey,
    outcome: value.outcome,
    result: {
      connectionId: value.result.connectionId,
      receipt: parseConnectionTestReceipt(value.result.receipt),
    },
  };
}

/**
 * Strict parse of the audited Workbench COMMAND envelope that the gateway
 * passes through verbatim: `{ action, idempotencyKey, outcome, result? }`.
 *
 * The gateway/orchestrator response is `{ success, data: <envelope> }`;
 * consumers MUST parse `data` with this guard — the previous class of bug
 * read `outcome` at the wrong nesting level and fell into the error branch
 * for every command (the AUTH_REQUIRED -> READY pattern). A malformed
 * envelope is an error, never an optimistic default.
 */
export function parseWorkbenchCommandResult<T = unknown>(
  value: unknown,
): WorkbenchCommandResultV1<T> {
  if (!isRecord(value)) throw new MalformedResponseError("workbench command result");
  if (!isNonEmptyString(value.action)) {
    throw new MalformedResponseError(`action (got ${String(value.action)})`);
  }
  if (!isNonEmptyString(value.idempotencyKey)) {
    throw new MalformedResponseError("idempotencyKey");
  }
  if (
    value.outcome !== "executed" &&
    value.outcome !== "duplicate" &&
    value.outcome !== "rejected"
  ) {
    throw new MalformedResponseError(`outcome (got ${String(value.outcome)})`);
  }
  const result: WorkbenchCommandResultV1<T> = {
    action: value.action,
    idempotencyKey: value.idempotencyKey,
    outcome: value.outcome,
  };
  if (value.result !== undefined) {
    if (!isRecord(value.result)) {
      throw new MalformedResponseError("result");
    }
    result.result = value.result as T;
  }
  if (value.error !== undefined) {
    if (
      !isRecord(value.error) ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string"
    ) {
      throw new MalformedResponseError("error");
    }
    result.error = {
      code: value.error.code,
      message: value.error.message,
    };
  }
  return result;
}
