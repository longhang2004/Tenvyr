import React from "react";
import {
  CheckCircle2,
  Clock,
  XCircle,
  HelpCircle,
  PlayCircle,
  Activity,
  UserCheck,
} from "lucide-react";

export type StatusBadgeProps = {
  status: string;
  className?: string;
  size?: number;
};

export function StatusBadge({ status, className = "", size = 12 }: StatusBadgeProps) {
  const normalized = (status || "UNKNOWN").toUpperCase();

  let badgeClass = "badge-neutral";
  let IconComponent = HelpCircle;

  switch (normalized) {
    case "READY":
    case "ACCEPTED":
    case "SUCCESS":
    case "COMPLETED":
      badgeClass = "badge-ready";
      IconComponent = CheckCircle2;
      break;

    case "RUNNING":
    case "WORKING":
    case "PLANNING":
    case "BATCH_VALIDATION":
    case "VERIFYING":
    case "DECIDING":
      badgeClass = "badge-running";
      IconComponent = Activity;
      break;

    case "WAITING_FOR_HUMAN":
    case "WAITING":
    case "PENDING":
    case "DRAFT":
      badgeClass = "badge-waiting";
      IconComponent = normalized.includes("HUMAN") ? UserCheck : Clock;
      break;

    case "FAILED":
    case "CANCELLED":
    case "REVOKED":
    case "LIMIT_REACHED":
    case "ERROR":
      badgeClass = "badge-failed";
      IconComponent = XCircle;
      break;

    case "CONTINUE":
      badgeClass = "badge-running";
      IconComponent = PlayCircle;
      break;

    case "ACCEPT":
      badgeClass = "badge-ready";
      IconComponent = CheckCircle2;
      break;

    case "FAIL":
      badgeClass = "badge-failed";
      IconComponent = XCircle;
      break;

    case "WAIT_FOR_HUMAN":
      badgeClass = "badge-waiting";
      IconComponent = UserCheck;
      break;

    default:
      badgeClass = "badge-neutral";
      IconComponent = HelpCircle;
  }

  const label = normalized.replace(/_/g, " ");

  return (
    <span className={`badge ${badgeClass} ${className}`}>
      <IconComponent size={size} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
