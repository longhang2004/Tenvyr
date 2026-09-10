"use client";

import type {
  AcceptanceEvidenceV1,
  ArtifactRefV1,
  AttemptSummaryV1,
} from "../../../lib/tenvyr-api/types.ts";
import { StatusBadge } from "../../../components/shared/StatusBadge.tsx";

export function EvidenceTab({
  acceptanceEvidence,
  attempts,
  artifacts,
}: {
  acceptanceEvidence: AcceptanceEvidenceV1 | null | undefined;
  attempts: AttemptSummaryV1[];
  artifacts: ArtifactRefV1[];
}) {
  return (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
        >
          {/* Declared Acceptance Evidence */}
          {acceptanceEvidence && (
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
                {acceptanceEvidence.testCommand && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>
                      Test Command:
                    </span>{" "}
                    <code>{acceptanceEvidence.testCommand}</code>
                  </div>
                )}
                {acceptanceEvidence.buildCommand && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>
                      Build Command:
                    </span>{" "}
                    <code>{acceptanceEvidence.buildCommand}</code>
                  </div>
                )}
                {acceptanceEvidence.lintCommand && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>
                      Lint Command:
                    </span>{" "}
                    <code>{acceptanceEvidence.lintCommand}</code>
                  </div>
                )}
                {acceptanceEvidence.typecheckCommand && (
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>
                      Typecheck Command:
                    </span>{" "}
                    <code>{acceptanceEvidence.typecheckCommand}</code>
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
  );
}
