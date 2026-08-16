"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import { parseWorkbenchCommandResult } from "../../lib/tenvyr-api/guards.ts";
import type { WorkbenchExecutionSummaryV1 } from "../../lib/tenvyr-api/types.ts";
import { EmptyState } from "../../components/shared/EmptyState.tsx";
import { LoadingSpinner } from "../../components/shared/LoadingSpinner.tsx";

export default function ApprovalsPage() {
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [waitingRuns, setWaitingRuns] = useState<WorkbenchExecutionSummaryV1[]>([]);
  const [actingId, setActingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);

  const loadApprovals = useCallback(async () => {
    try {
      const res = await tenvyrApi.getWorkbenchExecutions(1);
      const items = res?.items ?? [];
      const waiting = items.filter((item) => item.coordinationPhase === "WAITING_FOR_HUMAN");
      setWaitingRuns(waiting);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Failed to load pending approvals" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadApprovals();
    const interval = setInterval(loadApprovals, 4000);
    return () => clearInterval(interval);
  }, [loadApprovals]);

  const handleDecision = async (executionId: string, approve: boolean) => {
    setActingId(executionId);
    setNotice(null);
    try {
      // First fetch the execution projection to get the coordination runId
      const proj = await tenvyrApi.getWorkbenchExecution(executionId);
      const runId = proj?.coordination?.run?.runId;
      if (!runId) {
        throw new Error("No coordination run associated with execution");
      }

      const res = await tenvyrApi.resolveWait(runId, approve);
      const command = parseWorkbenchCommandResult(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setNotice({
          type: "success",
          message: approve
            ? `Run ${executionId.slice(0, 8)} approved. Loop resumed.`
            : `Run ${executionId.slice(0, 8)} denied. Loop halted.`,
        });
        await loadApprovals();
      } else {
        setNotice({ type: "error", message: command.error?.message || "Failed to record approval decision" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Approval action failed" });
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>Human Approvals Queue</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Supervised decision checkpoints requiring operator authorization to proceed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            loadApprovals();
          }}
          className="btn btn-secondary btn-sm"
          disabled={refreshing}
        >
          <RefreshCw size={14} style={{ animation: refreshing ? "spin 1s linear infinite" : "none" }} />
          <span>Refresh</span>
        </button>
      </div>

      {notice && (
        <div className={`notice notice-${notice.type}`}>
          {notice.type === "success" ? (
            <CheckCircle2 size={16} />
          ) : notice.type === "error" ? (
            <XCircle size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <div>{notice.message}</div>
        </div>
      )}

      {loading ? (
        <LoadingSpinner text="Checking for pending approvals…" />
      ) : waitingRuns.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="All Clear — No Pending Approvals"
          description="None of your active team runs are currently waiting for human intervention."
          actionText="View All Runs"
          actionHref="/runs"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {waitingRuns.map((run) => (
            <div
              key={run.id}
              className="card"
              style={{
                borderLeft: "4px solid var(--accent-amber)",
                display: "flex",
                flexDirection: "column",
                gap: "1rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Link
                      href={`/runs/${encodeURIComponent(run.id)}`}
                      style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "1.05rem" }}
                    >
                      {run.id.slice(0, 8)}
                    </Link>
                    <span className="badge badge-waiting">WAITING FOR HUMAN</span>
                    {run.iterationNumber !== null && (
                      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                        Iteration {run.iterationNumber}
                      </span>
                    )}
                  </div>
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "0.25rem" }}>
                    Execution requested operator authorization. Review the rationale and approve or deny progression.
                  </p>
                </div>

                <Link
                  href={`/runs/${encodeURIComponent(run.id)}`}
                  className="btn btn-secondary btn-sm"
                >
                  <span>Inspect Run</span>
                  <ArrowRight size={12} />
                </Link>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  justifyContent: "flex-end",
                  borderTop: "1px solid var(--border-color)",
                  paddingTop: "0.75rem",
                }}
              >
                <button
                  type="button"
                  onClick={() => handleDecision(run.id, false)}
                  disabled={actingId === run.id}
                  className="btn btn-danger btn-sm"
                >
                  <XCircle size={14} />
                  <span>Deny & Halt</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleDecision(run.id, true)}
                  disabled={actingId === run.id}
                  className="btn btn-success btn-sm"
                >
                  <CheckCircle2 size={14} />
                  <span>Approve & Continue</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
