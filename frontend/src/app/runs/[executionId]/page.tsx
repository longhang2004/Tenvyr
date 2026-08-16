"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  CheckCircle2,
  XCircle,
  UserCheck,
  AlertTriangle,
  RotateCcw,
  StopCircle,
  RefreshCw,
  Shield,
} from "lucide-react";
import { tenvyrApi } from "../../../lib/tenvyr-api/client.ts";
import { parseWorkbenchCommandResult } from "../../../lib/tenvyr-api/guards.ts";
import type {
  WorkbenchExecutionProjectionV1,
  CapsuleSummaryV1,
} from "../../../lib/tenvyr-api/types.ts";
import { StatusBadge } from "../../../components/shared/StatusBadge.tsx";
import { LoadingSpinner } from "../../../components/shared/LoadingSpinner.tsx";

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const executionId = String(params.executionId || "");

  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [projection, setProjection] =
    useState<WorkbenchExecutionProjectionV1 | null>(null);
  const [capsule, setCapsule] = useState<CapsuleSummaryV1 | null>(null);
  const [activeTab, setActiveTab] = useState<"loop" | "evidence" | "capsule">(
    "loop",
  );
  const [acting, setActing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    if (!executionId) return;
    try {
      const data = await tenvyrApi.getWorkbenchExecution(executionId);
      setProjection(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Failed to load execution details",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [executionId]);

  useEffect(() => {
    loadData();
    // Poll while running / non-terminal
    const interval = setInterval(() => {
      if (
        projection?.execution?.status === "RUNNING" ||
        projection?.coordination?.run?.phase === "WAITING_FOR_HUMAN" ||
        !projection
      ) {
        loadData();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [loadData, projection]);

  const loadCapsuleData = async () => {
    try {
      const res = await tenvyrApi.getCapsule(executionId);
      setCapsule(res?.capsule ?? null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Failed to load execution capsule",
      });
    }
  };

  const handleTabChange = (tab: "loop" | "evidence" | "capsule") => {
    setActiveTab(tab);
    if (tab === "capsule" && !capsule) {
      loadCapsuleData();
    }
  };

  const handleApproveWait = async (approve: boolean) => {
    const runId = projection?.coordination?.run?.runId;
    if (!runId) return;

    setActing(approve ? "approve" : "deny");
    setNotice(null);
    try {
      const res = await tenvyrApi.resolveWait(runId, approve);
      const command = parseWorkbenchCommandResult(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setNotice({
          type: "success",
          message: approve
            ? "Decision approved. Resuming loop…"
            : "Decision denied. Terminating loop…",
        });
        await loadData();
      } else {
        setNotice({
          type: "error",
          message: command.error?.message || "Failed to resolve approval",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Approval request failed",
      });
    } finally {
      setActing(null);
    }
  };

  const handleCancel = async () => {
    if (
      !window.confirm(
        "Cancel this execution? All in-flight worker processes will be terminated.",
      )
    ) {
      return;
    }
    setActing("cancel");
    setNotice(null);
    try {
      const res = await tenvyrApi.cancelWorkbenchExecution(executionId);
      const command = parseWorkbenchCommandResult(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setNotice({ type: "info", message: "Cancellation signal recorded." });
        await loadData();
      } else {
        setNotice({
          type: "error",
          message: command.error?.message || "Failed to cancel execution",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Cancel failed" });
    } finally {
      setActing(null);
    }
  };

  const handleReplay = async () => {
    setActing("replay");
    setNotice(null);
    try {
      const res = await tenvyrApi.replayWorkbenchExecution(executionId);
      const command = parseWorkbenchCommandResult<{ executionId: string }>(res.data);
      if (
        (command.outcome === "executed" || command.outcome === "duplicate") &&
        command.result?.executionId
      ) {
        setNotice({
          type: "success",
          message: "Replay created. Navigating to new execution…",
        });
        router.push(`/runs/${encodeURIComponent(command.result.executionId)}`);
      } else {
        setNotice({
          type: "error",
          message: command.error?.message || "Replay failed",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Replay request failed" });
    } finally {
      setActing(null);
    }
  };

  if (loading && !projection) {
    return (
      <div className="page-container">
        <LoadingSpinner
          text={`Loading execution ${executionId.slice(0, 8)}…`}
        />
      </div>
    );
  }

  const execution = projection?.execution;
  const coordination = projection?.coordination;
  const run = coordination?.run;
  const iterations = coordination?.iterations ?? [];
  const attempts = projection?.attempts ?? [];
  const artifacts = projection?.artifacts ?? [];
  const isTerminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(
    execution?.status ?? "",
  );
  const isWaitingHuman = run?.phase === "WAITING_FOR_HUMAN";

  // Parse Goal Preview
  let goalText = execution?.goal?.preview || "";
  try {
    const parsed = JSON.parse(goalText);
    if (parsed && typeof parsed.goal === "string") {
      goalText = parsed.goal;
    }
  } catch {
    // raw string
  }

  return (
    <div className="page-container">
      {/* Top Navigation & Actions Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "0.25rem",
            }}
          >
            <Link
              href="/runs"
              style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}
            >
              Runs
            </Link>
            <span style={{ color: "var(--text-muted)" }}>/</span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                fontSize: "1.1rem",
              }}
            >
              {executionId.slice(0, 8)}
            </span>
            <StatusBadge status={execution?.status ?? "UNKNOWN"} />
            {run?.phase && <StatusBadge status={run.phase} />}
          </div>
          <p
            style={{
              color: "var(--text-primary)",
              fontSize: "1.05rem",
              fontWeight: 600,
              maxWidth: "700px",
            }}
          >
            {goalText}
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              loadData();
            }}
            className="btn btn-secondary btn-sm"
            disabled={refreshing}
          >
            <RefreshCw
              size={14}
              style={{
                animation: refreshing ? "spin 1s linear infinite" : "none",
              }}
            />
            <span>Refresh</span>
          </button>

          {!isTerminal && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={acting === "cancel"}
              className="btn btn-danger btn-sm"
            >
              <StopCircle size={14} />
              <span>Cancel Execution</span>
            </button>
          )}

          {isTerminal && (
            <button
              type="button"
              onClick={handleReplay}
              disabled={acting === "replay"}
              className="btn btn-primary btn-sm"
              title="Replay creates a NEW execution from initial configuration"
            >
              <RotateCcw size={14} />
              <span>
                {acting === "replay" ? "Replaying…" : "Replay as New Run"}
              </span>
            </button>
          )}
        </div>
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

      {/* Human Approval Required Attention Panel */}
      {isWaitingHuman && (
        <div
          className="notice notice-warning"
          style={{
            flexDirection: "column",
            gap: "0.75rem",
            padding: "1.25rem",
            borderWidth: "2px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
            <UserCheck size={24} color="var(--accent-amber)" />
            <div>
              <h2
                style={{
                  fontSize: "1.05rem",
                  color: "var(--accent-amber)",
                  fontWeight: 700,
                }}
              >
                Human Approval Required
              </h2>
              <p
                style={{
                  fontSize: "0.85rem",
                  color: "var(--text-primary)",
                  marginTop: "0.15rem",
                }}
              >
                The supervised loop has paused. The Verifier requested human
                authorization before proceeding.
              </p>
            </div>
          </div>

          {run?.waitReason && (
            <div
              style={{
                backgroundColor: "rgba(0, 0, 0, 0.3)",
                padding: "0.75rem 1rem",
                borderRadius: "var(--radius-md)",
                fontSize: "0.85rem",
                fontFamily: "var(--font-mono)",
                color: "var(--text-primary)",
              }}
            >
              <strong>Reason:</strong> {run.waitReason}
            </div>
          )}

          <div
            style={{ display: "flex", gap: "0.75rem", marginTop: "0.25rem" }}
          >
            <button
              type="button"
              onClick={() => handleApproveWait(true)}
              disabled={acting !== null}
              className="btn btn-success"
              style={{ padding: "0.5rem 1.5rem" }}
            >
              <CheckCircle2 size={16} />
              <span>Approve & Continue</span>
            </button>
            <button
              type="button"
              onClick={() => handleApproveWait(false)}
              disabled={acting !== null}
              className="btn btn-danger"
              style={{ padding: "0.5rem 1.5rem" }}
            >
              <XCircle size={16} />
              <span>Deny & Halt</span>
            </button>
          </div>
        </div>
      )}

      {/* Loop Overview Meta Row */}
      {run && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "0.75rem",
          }}
        >
          <div
            style={{
              backgroundColor: "var(--bg-surface)",
              padding: "0.75rem 1rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-color)",
            }}
          >
            <div
              style={{
                fontSize: "0.7rem",
                color: "var(--text-muted)",
                textTransform: "uppercase",
              }}
            >
              Iteration Progress
            </div>
            <div
              style={{
                fontSize: "1.1rem",
                fontWeight: 700,
                marginTop: "0.2rem",
              }}
            >
              {run.currentIterationNumber} / {run.maxIterations}
            </div>
          </div>

          <div
            style={{
              backgroundColor: "var(--bg-surface)",
              padding: "0.75rem 1rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-color)",
            }}
          >
            <div
              style={{
                fontSize: "0.7rem",
                color: "var(--text-muted)",
                textTransform: "uppercase",
              }}
            >
              Cumulative Workers
            </div>
            <div
              style={{
                fontSize: "1.1rem",
                fontWeight: 700,
                marginTop: "0.2rem",
              }}
            >
              {run.cumulativeWorkers} / {run.maxTotalWorkers}
            </div>
          </div>

          <div
            style={{
              backgroundColor: "var(--bg-surface)",
              padding: "0.75rem 1rem",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border-color)",
            }}
          >
            <div
              style={{
                fontSize: "0.7rem",
                color: "var(--text-muted)",
                textTransform: "uppercase",
              }}
            >
              Remaining Deadline
            </div>
            <div
              style={{
                fontSize: "1.1rem",
                fontWeight: 700,
                marginTop: "0.2rem",
              }}
            >
              {Math.max(0, Math.floor(run.remainingDeadlineMs / 1000))}s
            </div>
          </div>

          {run.workspace && (
            <div
              style={{
                backgroundColor: "var(--bg-surface)",
                padding: "0.75rem 1rem",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-color)",
              }}
            >
              <div
                style={{
                  fontSize: "0.7rem",
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                }}
              >
                Workspace
              </div>
              <div
                style={{
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  marginTop: "0.2rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={run.workspace.path}
              >
                {run.workspace.branch ? `${run.workspace.branch} · ` : ""}
                {run.workspace.headSha
                  ? `@ ${run.workspace.headSha.slice(0, 7)}`
                  : run.workspace.path}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          gap: "1.5rem",
        }}
      >
        <button
          type="button"
          onClick={() => handleTabChange("loop")}
          style={{
            background: "none",
            border: "none",
            borderBottom:
              activeTab === "loop"
                ? "2px solid var(--accent-blue)"
                : "2px solid transparent",
            padding: "0.6rem 0",
            color:
              activeTab === "loop"
                ? "var(--text-primary)"
                : "var(--text-secondary)",
            fontWeight: 600,
            fontSize: "0.9rem",
            cursor: "pointer",
          }}
        >
          Supervised Loop ({iterations.length} Iterations)
        </button>

        <button
          type="button"
          onClick={() => handleTabChange("evidence")}
          style={{
            background: "none",
            border: "none",
            borderBottom:
              activeTab === "evidence"
                ? "2px solid var(--accent-blue)"
                : "2px solid transparent",
            padding: "0.6rem 0",
            color:
              activeTab === "evidence"
                ? "var(--text-primary)"
                : "var(--text-secondary)",
            fontWeight: 600,
            fontSize: "0.9rem",
            cursor: "pointer",
          }}
        >
          Evidence & Attempts ({attempts.length})
        </button>

        <button
          type="button"
          onClick={() => handleTabChange("capsule")}
          style={{
            background: "none",
            border: "none",
            borderBottom:
              activeTab === "capsule"
                ? "2px solid var(--accent-blue)"
                : "2px solid transparent",
            padding: "0.6rem 0",
            color:
              activeTab === "capsule"
                ? "var(--text-primary)"
                : "var(--text-secondary)",
            fontWeight: 600,
            fontSize: "0.9rem",
            cursor: "pointer",
          }}
        >
          Execution Capsule
        </button>
      </div>

      {/* TAB 1: Supervised Loop View */}
      {activeTab === "loop" && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
        >
          {iterations.length === 0 ? (
            <div className="empty-state">
              <Activity size={32} color="var(--accent-blue)" />
              <h3 className="empty-state-title">Planner Decomposing Goal…</h3>
              <p className="empty-state-description">
                Tenvyr has started coordination. The Planner is authoring the
                initial bounded task plan.
              </p>
            </div>
          ) : (
            iterations.map((iteration) => (
              <div
                key={iteration.iterationNumber}
                className="card"
                style={{ padding: "1.5rem" }}
              >
                {/* Iteration Header */}
                <div className="card-header">
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.6rem",
                    }}
                  >
                    <span
                      style={{
                        backgroundColor: "var(--accent-blue)",
                        color: "#fff",
                        width: "24px",
                        height: "24px",
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                      }}
                    >
                      {iteration.iterationNumber}
                    </span>
                    <h3 style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                      Iteration {iteration.iterationNumber}
                    </h3>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                    }}
                  >
                    {iteration.decisionAction && (
                      <StatusBadge status={iteration.decisionAction} />
                    )}
                    {iteration.outcome && (
                      <span className="badge badge-neutral">
                        {iteration.outcome}
                      </span>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "1.25rem",
                  }}
                >
                  {/* 1. Planner Section */}
                  <div
                    style={{
                      backgroundColor: "var(--bg-surface)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border-color)",
                      padding: "1rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "0.75rem",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.4rem",
                        }}
                      >
                        <CheckCircle2 size={14} color="var(--accent-green)" />
                        <strong style={{ fontSize: "0.85rem" }}>
                          Planner Proposal
                        </strong>
                      </div>
                      <span
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        Step: {iteration.plannerStepId || "planner"}
                      </span>
                    </div>

                    {iteration.plannerProposal ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.5rem",
                        }}
                      >
                        {iteration.plannerProposal.reason && (
                          <p
                            style={{
                              fontSize: "0.8rem",
                              color: "var(--text-secondary)",
                              fontStyle: "italic",
                            }}
                          >
                            &ldquo;{iteration.plannerProposal.reason}&rdquo;
                          </p>
                        )}
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns:
                              "repeat(auto-fit, minmax(240px, 1fr))",
                            gap: "0.5rem",
                          }}
                        >
                          {iteration.plannerProposal.tasks.map((task, idx) => (
                            <div
                              key={task.taskId}
                              style={{
                                backgroundColor: "var(--bg-card)",
                                border: "1px solid var(--border-color)",
                                borderRadius: "var(--radius-sm)",
                                padding: "0.6rem 0.75rem",
                                fontSize: "0.8rem",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  fontWeight: 600,
                                }}
                              >
                                <span style={{ color: "var(--accent-blue)" }}>
                                  0{idx + 1} · {task.taskId}
                                </span>
                                <span
                                  style={{
                                    fontSize: "0.7rem",
                                    color: "var(--text-muted)",
                                  }}
                                >
                                  {task.agent}
                                </span>
                              </div>
                              {task.reason && (
                                <p
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "var(--text-secondary)",
                                    marginTop: "0.2rem",
                                  }}
                                >
                                  {task.reason}
                                </p>
                              )}
                              {task.dependsOn && task.dependsOn.length > 0 && (
                                <div
                                  style={{
                                    fontSize: "0.65rem",
                                    color: "var(--text-muted)",
                                    marginTop: "0.3rem",
                                  }}
                                >
                                  depends on: {task.dependsOn.join(", ")}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        Plan authorized and tasks materialized into execution
                        DAG.
                      </p>
                    )}
                  </div>

                  {/* 2. Worker Manifest */}
                  <div
                    style={{
                      backgroundColor: "var(--bg-surface)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border-color)",
                      padding: "1rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "0.75rem",
                      }}
                    >
                      <strong style={{ fontSize: "0.85rem" }}>
                        Materialized Worker Tasks (
                        {iteration.workerManifest.length})
                      </strong>
                    </div>

                    {iteration.workerManifest.length === 0 ? (
                      <p
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        No worker tasks materialized yet.
                      </p>
                    ) : (
                      <div className="table-container">
                        <table className="table" style={{ fontSize: "0.8rem" }}>
                          <thead>
                            <tr>
                              <th>Task ID</th>
                              <th>Logical Step</th>
                              <th>Requirement</th>
                              <th>Execution Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {iteration.workerManifest.map((worker) => (
                              <tr key={worker.taskId}>
                                <td
                                  style={{
                                    fontWeight: 600,
                                    fontFamily: "var(--font-mono)",
                                  }}
                                >
                                  {worker.taskId}
                                </td>
                                <td
                                  style={{
                                    color: "var(--text-muted)",
                                    fontFamily: "var(--font-mono)",
                                    fontSize: "0.75rem",
                                  }}
                                >
                                  {worker.logicalStepId}
                                </td>
                                <td>
                                  {worker.required ? (
                                    <span
                                      style={{
                                        color: "var(--accent-blue)",
                                        fontSize: "0.75rem",
                                      }}
                                    >
                                      Required
                                    </span>
                                  ) : (
                                    <span
                                      style={{
                                        color: "var(--text-muted)",
                                        fontSize: "0.75rem",
                                      }}
                                    >
                                      Optional
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <StatusBadge
                                    status={worker.status}
                                    size={10}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {/* 3. Verifier Section */}
                  <div
                    style={{
                      backgroundColor: "var(--bg-surface)",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border-color)",
                      padding: "1rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "0.5rem",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.4rem",
                        }}
                      >
                        <Shield size={14} color="var(--accent-blue)" />
                        <strong style={{ fontSize: "0.85rem" }}>
                          Verifier Evaluation
                        </strong>
                      </div>
                      {iteration.decisionAction && (
                        <StatusBadge status={iteration.decisionAction} />
                      )}
                    </div>

                    {iteration.decisionReason ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.4rem",
                        }}
                      >
                        <p
                          style={{
                            fontSize: "0.85rem",
                            color: "var(--text-primary)",
                          }}
                        >
                          <strong>Reason:</strong> {iteration.decisionReason}
                        </p>
                        {iteration.decisionRecommendation && (
                          <p
                            style={{
                              fontSize: "0.8rem",
                              color: "var(--text-secondary)",
                            }}
                          >
                            <strong>Recommendation:</strong>{" "}
                            {iteration.decisionRecommendation.reason}
                            {iteration.decisionRecommendation.focus?.length >
                              0 && (
                              <span>
                                {" "}
                                (Focus:{" "}
                                {iteration.decisionRecommendation.focus.join(
                                  ", ",
                                )}
                                )
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--text-muted)",
                        }}
                      >
                        {iteration.verifierStepId
                          ? `Verifier step ${iteration.verifierStepId} pending outcome…`
                          : "Waiting for worker completion to run Verifier audit…"}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* TAB 2: Evidence & Attempts */}
      {activeTab === "evidence" && (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
        >
          {/* Declared Acceptance Evidence */}
          {run?.acceptanceEvidence && (
            <div className="card">
              <h3 className="card-title" style={{ marginBottom: "0.75rem" }}>
                Declared Acceptance Evidence
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "0.75rem",
                  fontSize: "0.85rem",
                }}
              >
                {run.acceptanceEvidence.testCommand && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>
                      Test Command:
                    </span>{" "}
                    <code>{run.acceptanceEvidence.testCommand}</code>
                  </div>
                )}
                {run.acceptanceEvidence.buildCommand && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>
                      Build Command:
                    </span>{" "}
                    <code>{run.acceptanceEvidence.buildCommand}</code>
                  </div>
                )}
                {run.acceptanceEvidence.lintCommand && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>
                      Lint Command:
                    </span>{" "}
                    <code>{run.acceptanceEvidence.lintCommand}</code>
                  </div>
                )}
                {run.acceptanceEvidence.typecheckCommand && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>
                      Typecheck Command:
                    </span>{" "}
                    <code>{run.acceptanceEvidence.typecheckCommand}</code>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Attempts Table */}
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: "0.75rem" }}>
              Attempt History ({attempts.length})
            </h3>
            {attempts.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
                No attempts recorded yet.
              </p>
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Attempt #</th>
                      <th>Status</th>
                      <th>Terminal At</th>
                      <th>Requested Model</th>
                      <th>Observed Model</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((att, idx) => (
                      <tr key={idx}>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontWeight: 600,
                          }}
                        >
                          {att.stepId}
                        </td>
                        <td>{att.attemptNumber}</td>
                        <td>
                          <StatusBadge status={att.status} />
                        </td>
                        <td
                          style={{
                            color: "var(--text-muted)",
                            fontSize: "0.75rem",
                          }}
                        >
                          {att.terminalAt
                            ? new Date(att.terminalAt).toLocaleTimeString()
                            : "In flight"}
                        </td>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.75rem",
                          }}
                        >
                          {att.requestedModelId ?? (
                            <span style={{ color: "var(--text-muted)" }}>
                              Runtime default
                            </span>
                          )}
                        </td>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "0.75rem",
                            color: "var(--text-muted)",
                          }}
                        >
                          {att.observedModelId ?? "—"}
                        </td>
                        <td
                          style={{
                            color: "var(--accent-red)",
                            fontSize: "0.8rem",
                            maxWidth: "300px",
                          }}
                        >
                          {att.error || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Artifact References */}
          {artifacts.length > 0 && (
            <div className="card">
              <h3 className="card-title" style={{ marginBottom: "0.75rem" }}>
                Artifact Lineage References ({artifacts.length})
              </h3>
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Artifact ID</th>
                      <th>Ordinal</th>
                      <th>Descriptor Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {artifacts.map((art) => (
                      <tr key={art.artifactId}>
                        <td style={{ fontFamily: "var(--font-mono)" }}>
                          {art.artifactId.slice(0, 8)}
                        </td>
                        <td>{art.descriptorOrdinal}</td>
                        <td
                          style={{
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-muted)",
                          }}
                        >
                          {art.descriptorHash.slice(0, 16)}…
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Execution Capsule */}
      {activeTab === "capsule" && (
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: "0.75rem" }}>
            Execution Capsule & Integrity Proof
          </h3>

          {!capsule ? (
            <LoadingSpinner text="Computing Execution Capsule…" />
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
            >
              <div
                style={{
                  backgroundColor: "var(--bg-surface)",
                  padding: "1rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                  fontSize: "0.85rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.5rem",
                }}
              >
                <div>
                  <span style={{ color: "var(--text-muted)" }}>
                    Canonical Content Hash:
                  </span>{" "}
                  <code
                    style={{ color: "var(--accent-green)", fontWeight: 700 }}
                  >
                    {capsule.contentHash}
                  </code>
                </div>
                <div>
                  <span style={{ color: "var(--text-muted)" }}>
                    Point in Time:
                  </span>{" "}
                  {capsule.pointInTime}
                </div>
                <div>
                  <span style={{ color: "var(--text-muted)" }}>
                    Source Status:
                  </span>{" "}
                  <StatusBadge status={capsule.sourceStatus} />
                </div>
                <div>
                  <span style={{ color: "var(--text-muted)" }}>
                    Durable Topology:
                  </span>{" "}
                  {capsule.header.stepCount} steps ·{" "}
                  {capsule.header.revisionCount} revisions ·{" "}
                  {capsule.header.attemptCount} attempts
                </div>
              </div>

              {capsule.evidenceCompleteness &&
                capsule.evidenceCompleteness.length > 0 && (
                  <div className="notice notice-info">
                    <div>
                      <strong>Evidence Completeness Notes:</strong>
                      <ul
                        style={{ paddingLeft: "1.25rem", marginTop: "0.25rem" }}
                      >
                        {capsule.evidenceCompleteness.map((w, idx) => (
                          <li key={idx}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

              <div>
                <h4 style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
                  Raw Capsule JSON
                </h4>
                <pre
                  style={{
                    backgroundColor: "var(--bg-surface)",
                    padding: "1rem",
                    borderRadius: "var(--radius-md)",
                    fontSize: "0.75rem",
                    overflowX: "auto",
                    maxHeight: "360px",
                  }}
                >
                  {JSON.stringify(capsule, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
