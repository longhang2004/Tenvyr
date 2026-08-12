import { PolicyError, type ActionProposal } from "./policy";

/**
 * M4-S4: durable ApprovalRequest semantics.
 *
 * - ONE request per intercepted action (proposalId unique): an approval
 *   replay returns the same outcome and never re-executes the action;
 * - transitions are exactly-once under row locks:
 *   PENDING → APPROVED | DENIED | EXPIRED; no other transition exists;
 * - WAITING is never a retryable failure: a step waiting on an approval
 *   makes NO autonomous progress (the recovery sweep only expires due
 *   requests);
 * - approving a request resumes the SAME attempt (same invocationId) —
 *   approval replay can never mint a second outbox row or a second
 *   invocation;
 * - expiry is a deterministic time-based transition; reconciliation races
 *   (approval vs cancel vs result vs expiry) serialize on the attempt and
 *   request row locks, and the loser no-ops.
 */

export type ApprovalStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

export const APPROVAL_STATUSES: ApprovalStatus[] = [
  "PENDING",
  "APPROVED",
  "DENIED",
  "EXPIRED",
];

export const APPROVAL_BOUNDS = {
  noteMaxLength: 255,
  /** Default time a request waits before the expiry sweep terminalizes it. */
  defaultExpiryMs: 7 * 24 * 60 * 60 * 1000,
  expiryMsMax: 90 * 24 * 60 * 60 * 1000,
  /** Bounded batch for the autonomous expiry sweep. */
  expireSweepBatch: 100,
} as const;

export type ApprovalTransition =
  | { from: "PENDING"; to: "APPROVED" }
  | { from: "PENDING"; to: "DENIED" }
  | { from: "PENDING"; to: "EXPIRED" };

export function assertApprovalTransition(
  from: ApprovalStatus,
  to: ApprovalStatus,
): ApprovalTransition {
  if (from !== "PENDING") {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `Approval request is ${from}; only PENDING requests can transition`,
    );
  }
  if (!["APPROVED", "DENIED", "EXPIRED"].includes(to)) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `No transition from ${from} to ${to}`,
    );
  }
  return { from: "PENDING", to: to as "APPROVED" | "DENIED" | "EXPIRED" };
}

export function approvalExpiry(now: Date, expiresInMs: number): Date {
  if (
    typeof expiresInMs !== "number" ||
    !Number.isInteger(expiresInMs) ||
    expiresInMs <= 0 ||
    expiresInMs > APPROVAL_BOUNDS.expiryMsMax
  ) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `expiresInMs must be an integer between 1 and ${APPROVAL_BOUNDS.expiryMsMax}`,
    );
  }
  return new Date(now.getTime() + expiresInMs);
}

export function boundedApprovalNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (
    typeof note !== "string" ||
    !note.trim() ||
    note.length > APPROVAL_BOUNDS.noteMaxLength
  ) {
    throw new PolicyError(
      "POLICY_CONFIG_INVALID",
      `approval note must be 1-${APPROVAL_BOUNDS.noteMaxLength} characters`,
    );
  }
  return note;
}

export type ApprovalRequestData = {
  proposal: ActionProposal;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
};
