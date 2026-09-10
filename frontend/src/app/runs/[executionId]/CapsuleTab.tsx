"use client";

import type { CapsuleSummaryV1 } from "../../../lib/tenvyr-api/types.ts";
import { LoadingSpinner } from "../../../components/shared/LoadingSpinner.tsx";
import { StatusBadge } from "../../../components/shared/StatusBadge.tsx";

export function CapsuleTab({
  capsule,
}: {
  capsule: CapsuleSummaryV1 | null;
}) {
  return (
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
  );
}
