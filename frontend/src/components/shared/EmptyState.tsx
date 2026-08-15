import React from "react";
import Link from "next/link";
import { LucideIcon } from "lucide-react";

export type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  actionText?: string;
  actionHref?: string;
  onAction?: () => void;
};

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionText,
  actionHref,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">
        <Icon size={36} aria-hidden="true" />
      </div>
      <h3 className="empty-state-title">{title}</h3>
      <p className="empty-state-description">{description}</p>
      {actionText && (
        <div style={{ marginTop: "0.5rem" }}>
          {actionHref ? (
            <Link href={actionHref} className="btn btn-primary">
              {actionText}
            </Link>
          ) : onAction ? (
            <button type="button" onClick={onAction} className="btn btn-primary">
              {actionText}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
