"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  BellRing,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Info,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import { parseWorkbenchCommandResult } from "../../lib/tenvyr-api/guards.ts";
import type { AttentionItemV1, AttentionViewV1 } from "../../lib/tenvyr-api/types.ts";
import { LoadingSpinner } from "../../components/shared/LoadingSpinner.tsx";
import { EmptyState } from "../../components/shared/EmptyState.tsx";

/**
 * PP1 Slice B: exception-driven Attention queue — the default supervision
 * experience. A READ projection over durable authority rows; resolving an
 * item ALWAYS goes through the existing authoritative commands
 * (resolveWait / approvals / cancel / workspace release). Never marks
 * authority complete merely because an item disappeared.
 */
export default function AttentionPage() {
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [view, setView] = useState<AttentionViewV1 | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    setRefreshing(true);
    try {
      const data = await tenvyrApi.getAttention();
      setView(data);
      setNotice(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Failed to load attention" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const handleWaitDecision = async (item: AttentionItemV1, approve: boolean) => {
    if (!item.runId) return;
    setActing(item.attentionId);
    try {
      const res = await tenvyrApi.resolveWait(item.runId, approve);
      parseWorkbenchCommandResult(res.data);
      setNotice({
        type: "success",
        message: approve ? "Approved and continued." : "Denied and halted.",
      });
      await load();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message });
    } finally {
      setActing(null);
    }
  };

  const handleReleaseWorkspace = async (item: AttentionItemV1) => {
    if (!item.workspaceExecutionId) return;
    setActing(item.attentionId);
    try {
      const res = await tenvyrApi.releaseExecutionWorkspace(
        item.workspaceExecutionId,
      );
      const parsed = parseWorkbenchCommandResult(res.data);
      const resultState = (parsed.result as { state?: string } | undefined)?.state;
      const failureCode = (parsed.result as { failureCode?: string } | undefined)?.failureCode;
      const retryRequired = (parsed.result as { retryRequired?: boolean } | undefined)?.retryRequired;
      // PP1 FINAL §4: never show "released safely" unless durable truth is REMOVED
      if (resultState === "REMOVED") {
        setNotice({
          type: "success",
          message: "Execution workspace released safely.",
        });
      } else if (resultState === "IN_PROGRESS" || failureCode === "OPERATION_IN_PROGRESS") {
        setNotice({
          type: "info",
          message: "Release operation is in progress; retry with the same operation to observe the final outcome.",
        });
      } else if (resultState === "INTERRUPTED" || retryRequired === true) {
        setNotice({
          type: "info",
          message: "Release was interrupted; retry with the same idempotency key to resume.",
        });
      } else if (resultState === "PRESERVED" || resultState === "NOT_FOUND") {
        const msg = (parsed.result as { error?: string })?.error ?? "Workspace is preserved; release was refused";
        setNotice({ type: "error", message: msg });
      } else {
        setNotice({
          type: "success",
          message: "Execution workspace released safely.",
        });
      }
      await load();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      if (lower.includes("in progress") || lower.includes("operation_in_progress")) {
        setNotice({ type: "info", message: "Release operation is in progress; retry to observe the final outcome." });
      } else if (lower.includes("interrupted") || lower.includes("retry_required") || lower.includes("retryrequired")) {
        setNotice({ type: "info", message: "Release was interrupted; retry with the same idempotency key to resume." });
      } else {
        setNotice({ type: "error", message });
      }
    } finally {
      setActing(null);
    }
  };

  const items = view?.items ?? [];
  const critical = items.filter((item) => item.severity === "critical");
  const warnings = items.filter((item) => item.severity === "warning");
  const info = items.filter((item) => item.severity === "info");

  const kindLabel: Record<string, string> = {
    HUMAN_APPROVAL_REQUIRED: "Human approval",
    RUN_FAILED: "Run failed",
    LIMIT_REACHED: "Limits reached",
    WORKSPACE_REQUIRES_ATTENTION: "Workspace preserved",
  };

  const KindIcon = ({ kind }: { kind: string }) => {
    if (kind === "HUMAN_APPROVAL_REQUIRED") return <UserCheck2 />;
    if (kind === "RUN_FAILED" || kind === "LIMIT_REACHED")
      return <AlertTriangle size={16} aria-hidden="true" />;
    return <Info size={16} aria-hidden="true" />;
  };

  const renderItem = (item: AttentionItemV1) => (
    <div
      key={item.attentionId}
      style={{
        backgroundColor: "var(--bg-surface)",
        border: `1px solid ${
          item.severity === "critical" ? "var(--accent-amber)" : "var(--border-color)"
        }`,
        borderRadius: "var(--radius-md)",
        padding: "0.85rem 1rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", minWidth: 0 }}>
        <div style={{ marginTop: "0.15rem" }}>
          <KindIcon kind={item.kind} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>
            {kindLabel[item.kind] ?? item.kind}
          </div>
          <div
            style={{
              color: "var(--text-muted)",
              fontSize: "0.78rem",
              marginTop: "0.15rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={item.reason}
          >
            {item.reason}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: "0.7rem", marginTop: "0.15rem" }}>
            {item.attentionId}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
        {item.kind === "HUMAN_APPROVAL_REQUIRED" && item.runId ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-success"
              disabled={acting === item.attentionId}
              onClick={() => void handleWaitDecision(item, true)}
            >
              <CheckCircle2 size={14} aria-hidden="true" /> Approve &amp; Continue
            </button>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={acting === item.attentionId}
              onClick={() => void handleWaitDecision(item, false)}
            >
              <XCircle size={14} aria-hidden="true" /> Deny
            </button>
          </>
        ) : item.kind === "WORKSPACE_REQUIRES_ATTENTION" && item.workspaceExecutionId ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger"
              disabled={acting === item.attentionId}
              onClick={() => void handleReleaseWorkspace(item)}
            >
              Safe Release
            </button>
            <Link
              href={item.actionRoute}
              className="btn btn-sm btn-secondary"
            >
              <ExternalLink size={14} aria-hidden="true" /> Inspect
            </Link>
          </>
        ) : (
          <Link
            href={item.actionRoute}
            className="btn btn-sm btn-secondary"
          >
            <ExternalLink size={14} aria-hidden="true" /> Review
          </Link>
        )}
      </div>
    </div>
  );

  if (loading && !view) {
    return (
      <div className="page-container">
        <LoadingSpinner text="Loading attention…" />
      </div>
    );
  }

  return (
    <div className="page-container">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <div>
          <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <BellRing size={20} aria-hidden="true" /> Attention
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
            Exception-driven supervision. Items exist exactly while the
            underlying durable condition exists; resolving always uses the
            existing authority commands.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void load(true)}
          disabled={refreshing}
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>

      {notice && (
        <div className={`notice notice-${notice.type}`} style={{ marginBottom: "1rem" }}>
          {notice.message}
        </div>
      )}

      {items.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={CheckCircle2}
            title="All Clear"
            description="No runs need your attention right now. Healthy activity stays in Runs."
          />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {critical.length > 0 && (
            <section>
              <h2 className="card-title" style={{ color: "var(--accent-amber)", marginBottom: "0.5rem" }}>
                NEEDS YOU
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {critical.map(renderItem)}
              </div>
            </section>
          )}
          {warnings.length > 0 && (
            <section>
              <h2 className="card-title" style={{ marginBottom: "0.5rem" }}>
                Needs review
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {warnings.map(renderItem)}
              </div>
            </section>
          )}
          {info.length > 0 && (
            <section>
              <h2 className="card-title" style={{ marginBottom: "0.5rem" }}>
                Workspace follow-up
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {info.map(renderItem)}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function UserCheck2() {
  return (
    <span style={{ color: "var(--accent-amber)", display: "inline-flex" }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <polyline points="16 11 18 13 22 9" />
      </svg>
    </span>
  );
}