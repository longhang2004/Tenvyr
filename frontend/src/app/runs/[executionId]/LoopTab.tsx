"use client";

import { Activity, CheckCircle2, Shield } from "lucide-react";
import type { ProjectedIterationV1 } from "../../../lib/tenvyr-api/types.ts";
import { StatusBadge } from "../../../components/shared/StatusBadge.tsx";

export function LoopTab({
  iterations,
}: {
  iterations: ProjectedIterationV1[];
}) {
  return (
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
  );
}
