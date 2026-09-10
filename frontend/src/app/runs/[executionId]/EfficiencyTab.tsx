"use client";

import { BarChart3 } from "lucide-react";
import type {
  AttemptSummaryV1,
  WorkbenchEfficiencyAggregateV1,
} from "../../../lib/tenvyr-api/types.ts";
import { EmptyState } from "../../../components/shared/EmptyState.tsx";
import { StatusBadge } from "../../../components/shared/StatusBadge.tsx";
import { formatBytes, formatMs, shortHash } from "./format.ts";

export function EfficiencyTab({
  efficiencyAggregate,
  attempts,
}: {
  efficiencyAggregate: WorkbenchEfficiencyAggregateV1;
  attempts: AttemptSummaryV1[];
}) {
  return (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: "0.75rem" }}>
              Invocation Efficiency
            </h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "0.75rem",
              }}
            >
              <div
                style={{
                  backgroundColor: "var(--bg-surface)",
                  padding: "0.9rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                  Context projected
                </div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                  {formatBytes(efficiencyAggregate.projectedTotalBytes)}
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                  {efficiencyAggregate.bundleAttempts} attempts with a
                  ContextBundle
                </div>
              </div>
              <div
                style={{
                  backgroundColor: "var(--bg-surface)",
                  padding: "0.9rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                  Context bundles
                </div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                  {efficiencyAggregate.bundlesReused} reused ·{" "}
                  {efficiencyAggregate.bundlesBuilt} built
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                  Tenvyr projection reuse (MISS/HIT), never provider cache
                </div>
              </div>
              <div
                style={{
                  backgroundColor: "var(--bg-surface)",
                  padding: "0.9rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                  Provider cached-input evidence
                </div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                  {efficiencyAggregate.providerCacheEvidenceAttempts} reported
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                  {efficiencyAggregate.providerCacheHitAttempts} with
                  cachedInputTokens &gt; 0 — as reported by the runtime
                </div>
              </div>
              <div
                style={{
                  backgroundColor: "var(--bg-surface)",
                  padding: "0.9rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
                  Runtime duration
                </div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                  {efficiencyAggregate.runtimeDurationMs === null
                    ? "—"
                    : formatMs(efficiencyAggregate.runtimeDurationMs)}
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                  Completed dispatches only
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <h4 style={{ fontSize: "0.9rem", marginBottom: "0.5rem" }}>
              Per-attempt efficiency evidence
            </h4>
            {attempts.filter((entry) => entry.efficiency).length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="No efficiency evidence"
                description="This execution predates the P3 baseline or its attempts recorded no context bundle / usage."
              />
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Attempt</th>
                      <th>Status</th>
                      <th>Context Bundle</th>
                      <th>Projected</th>
                      <th>Session</th>
                      <th>Usage (input / cached / output)</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((attempt) => {
                      const eff = attempt.efficiency;
                      if (!eff) return null;
                      return (
                        <tr key={`${attempt.stepId}:${attempt.attemptNumber}`}>
                          <td>
                            <code>{attempt.stepId}</code>
                          </td>
                          <td>#{attempt.attemptNumber}</td>
                          <td>
                            <StatusBadge status={attempt.status} />
                          </td>
                          <td>
                            {eff.contextBundleHash ? (
                              <>
                                <code>{shortHash(eff.contextBundleHash)}</code>{" "}
                                {eff.contextBundleReused ? (
                                  <span className="badge badge-neutral">
                                    reused
                                  </span>
                                ) : (
                                  <span className="badge badge-neutral">
                                    built
                                  </span>
                                )}
                              </>
                            ) : (
                              <span style={{ color: "var(--text-muted)" }}>
                                none
                              </span>
                            )}
                          </td>
                          <td>
                            {eff.projectedBytes === null
                              ? "—"
                              : `${formatBytes(eff.projectedBytes)} · ${eff.selectedContextItemCount} items · ${eff.selectedArtifactCount} artifacts`}
                          </td>
                          <td>{eff.sessionMode}</td>
                          <td>
                            {eff.usageReported ? (
                              <>
                                {eff.inputTokens?.toLocaleString() ?? "—"} /{" "}
                                {eff.cachedInputTokens?.toLocaleString() ??
                                  "not reported"}{" "}
                                / {eff.outputTokens?.toLocaleString() ?? "—"}
                              </>
                            ) : (
                              <span style={{ color: "var(--text-muted)" }}>
                                Not reported by runtime
                              </span>
                            )}
                          </td>
                          <td>
                            {eff.durationMs === null
                              ? "—"
                              : formatMs(eff.durationMs)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p
              style={{
                color: "var(--text-muted)",
                fontSize: "0.75rem",
                marginTop: "0.75rem",
              }}
            >
              Tenvyr does not own provider KV cache and does not guarantee
              prompt-cache hits. “reused” = the identical deterministic
              context projection was not rebuilt; provider cached-input
              numbers appear only when the runtime reported them.
            </p>
          </div>
        </div>
  );
}
