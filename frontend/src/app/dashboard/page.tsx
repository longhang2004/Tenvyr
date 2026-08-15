"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  PlayCircle,
  Cpu,
  FolderGit2,
  RefreshCw,
  ArrowRight,
  UserCheck,
  XCircle,
  Activity,
  ChevronRight,
} from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import type {
  WorkbenchExecutionSummaryV1,
  WorkbenchConnectionCardV1,
  WorkbenchWorkspaceV1,
  RuntimeOnboardingStatusV1,
} from "../../lib/tenvyr-api/types.ts";
import { StatusBadge } from "../../components/shared/StatusBadge.tsx";
import { EmptyState } from "../../components/shared/EmptyState.tsx";
import { LoadingSpinner } from "../../components/shared/LoadingSpinner.tsx";

const ONBOARDING_KINDS = ["codex", "claude", "opencode"] as const;

export default function OverviewPage() {
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [executions, setExecutions] = useState<WorkbenchExecutionSummaryV1[]>([]);
  const [connections, setConnections] = useState<WorkbenchConnectionCardV1[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkbenchWorkspaceV1[]>([]);
  const [onboardingStatuses, setOnboardingStatuses] = useState<Record<string, RuntimeOnboardingStatusV1>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setErrorMsg(null);
      const [execsRes, connsRes, wsRes] = await Promise.allSettled([
        tenvyrApi.getWorkbenchExecutions(1),
        tenvyrApi.getWorkbenchConnections(),
        tenvyrApi.getWorkspaces(),
      ]);

      if (execsRes.status === "fulfilled") {
        setExecutions(execsRes.value?.items ?? []);
      }
      if (connsRes.status === "fulfilled") {
        setConnections(connsRes.value?.cards ?? []);
      }
      if (wsRes.status === "fulfilled") {
        setWorkspaces(wsRes.value?.workspaces ?? []);
      }

      // Probe onboarding statuses for quick readiness overview
      const statuses: Record<string, RuntimeOnboardingStatusV1> = {};
      await Promise.all(
        ONBOARDING_KINDS.map(async (kind) => {
          try {
            const res = await tenvyrApi.getRuntimeOnboarding(kind);
            if (res?.status) statuses[kind] = res.status;
          } catch {
            // best effort probe
          }
        }),
      );
      setOnboardingStatuses(statuses);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message || "Failed to load overview data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const pendingApprovals = executions.filter(
    (e) => e.coordinationPhase === "WAITING_FOR_HUMAN",
  );

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>Operator Overview</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Supervised Agent Execution Control Plane · Trusted Local Operator
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button
            type="button"
            onClick={handleRefresh}
            className="btn btn-secondary btn-sm"
            disabled={refreshing}
            title="Refresh state from server"
          >
            <RefreshCw size={14} style={{ animation: refreshing ? "spin 1s linear infinite" : "none" }} />
            <span>Refresh</span>
          </button>
          <Link href="/runs/new" className="btn btn-primary">
            <PlayCircle size={16} />
            <span>New Team Run</span>
          </Link>
        </div>
      </div>

      {errorMsg && (
        <div className="notice notice-error">
          <XCircle size={16} />
          <div>{errorMsg}</div>
        </div>
      )}

      {/* Pending Approvals Attention Banner */}
      {pendingApprovals.length > 0 && (
        <div
          className="notice notice-warning"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "1rem 1.25rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <UserCheck size={20} color="var(--accent-amber)" />
            <div>
              <strong style={{ color: "var(--accent-amber)" }}>
                {pendingApprovals.length} Run{pendingApprovals.length > 1 ? "s" : ""} Waiting for Human Approval
              </strong>
              <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.15rem" }}>
                The agent loop cannot proceed until you approve or deny the requested decision.
              </p>
            </div>
          </div>
          <Link href="/approvals" className="btn btn-sm btn-primary">
            Review Approvals <ArrowRight size={14} />
          </Link>
        </div>
      )}

      {/* Readiness & Setup Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1.25rem",
        }}
      >
        {/* Runtime Readiness Card */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Cpu size={16} color="var(--accent-blue)" />
              <h2 className="card-title">Runtime Readiness</h2>
            </div>
            <Link href="/runtimes" style={{ fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.2rem" }}>
              Manage <ChevronRight size={12} />
            </Link>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            {ONBOARDING_KINDS.map((kind) => {
              const status = onboardingStatuses[kind];
              const label = kind === "codex" ? "Codex CLI" : kind === "claude" ? "Claude Code" : "OpenCode";
              const conn = connections.find((c) => c.runtimeKind === kind && !c.revoked);

              return (
                <div
                  key={kind}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0.5rem 0.75rem",
                    backgroundColor: "var(--bg-surface)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-color)",
                    fontSize: "0.8rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span style={{ fontWeight: 600 }}>{label}</span>
                    {status?.detected ? (
                      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                        v{status.version || status.pinnedVersion}
                      </span>
                    ) : (
                      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Not installed</span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {conn ? (
                      <span className="badge badge-ready">Connected</span>
                    ) : status?.detected ? (
                      status.authReady === false ? (
                        <span className="badge badge-warning">Auth Required</span>
                      ) : (
                        <Link href="/runtimes" className="btn btn-sm btn-secondary" style={{ padding: "0.15rem 0.45rem", fontSize: "0.7rem" }}>
                          Connect
                        </Link>
                      )
                    ) : (
                      <span className="badge badge-neutral">Missing</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Workspaces Card */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <FolderGit2 size={16} color="var(--accent-blue)" />
              <h2 className="card-title">Workspaces</h2>
            </div>
            <Link href="/workspaces" style={{ fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.2rem" }}>
              Manage <ChevronRight size={12} />
            </Link>
          </div>
          {workspaces.length === 0 ? (
            <div style={{ padding: "1rem 0", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
              No repositories configured yet.
              <div style={{ marginTop: "0.5rem" }}>
                <Link href="/workspaces" className="btn btn-sm btn-secondary">
                  + Add Workspace
                </Link>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              {workspaces.slice(0, 3).map((ws) => (
                <div
                  key={ws.workspaceId}
                  style={{
                    padding: "0.5rem 0.75rem",
                    backgroundColor: "var(--bg-surface)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-color)",
                    fontSize: "0.8rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
                    <span>{ws.name}</span>
                    {ws.snapshot?.branch && (
                      <span style={{ color: "var(--accent-blue)", fontSize: "0.75rem" }}>
                        {ws.snapshot.branch}
                        {ws.snapshot?.headSha ? ` @ ${ws.snapshot.headSha.slice(0, 7)}` : ""}
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      color: "var(--text-muted)",
                      fontSize: "0.7rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      marginTop: "0.15rem",
                    }}
                  >
                    {ws.path}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Active & Recent Runs Section */}
      <div className="card">
        <div className="card-header">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Activity size={16} color="var(--accent-blue)" />
            <h2 className="card-title">Recent Team Runs</h2>
          </div>
          {executions.length > 0 && (
            <Link href="/runs" style={{ fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.2rem" }}>
              View all ({executions.length}) <ChevronRight size={12} />
            </Link>
          )}
        </div>

        {loading ? (
          <LoadingSpinner text="Loading executions…" />
        ) : executions.length === 0 ? (
          <EmptyState
            icon={PlayCircle}
            title="No team runs yet"
            description="Start your first supervised team run to watch Planner, Workers, and Verifier collaborate on a code objective."
            actionText="Start Team Run"
            actionHref="/runs/new"
          />
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Execution</th>
                  <th>Status</th>
                  <th>Loop Phase</th>
                  <th>Iteration</th>
                  <th>Steps</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {executions.slice(0, 8).map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link
                        href={`/runs/${encodeURIComponent(run.id)}`}
                        style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}
                      >
                        {run.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={run.status} />
                    </td>
                    <td>
                      {run.coordinationPhase ? (
                        <StatusBadge status={run.coordinationPhase} />
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                    <td>
                      {run.iterationNumber !== null ? (
                        <span style={{ fontWeight: 600 }}>{run.iterationNumber}</span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                    <td>{run.stepCount}</td>
                    <td style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                      {new Date(run.createdAt).toLocaleTimeString()}
                    </td>
                    <td>
                      <Link
                        href={`/runs/${encodeURIComponent(run.id)}`}
                        className="btn btn-sm btn-secondary"
                      >
                        Inspect
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
