"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  History,
  GitCompare,
  RefreshCw,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { tenvyrApi } from "../../../lib/tenvyr-api/client.ts";
import type { AuditItemV1 } from "../../../lib/tenvyr-api/types.ts";
import { LoadingSpinner } from "../../../components/shared/LoadingSpinner.tsx";

export default function AuditPage() {
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [auditItems, setAuditItems] = useState<AuditItemV1[]>([]);
  const [actionFilter, setActionFilter] = useState<string>("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Compare Tool
  const [execA, setExecA] = useState<string>("");
  const [execB, setExecB] = useState<string>("");
  const [comparing, setComparing] = useState<boolean>(false);
  const [comparisonResult, setComparisonResult] = useState<unknown>(null);

  const loadAudit = useCallback(async () => {
    try {
      const res = await tenvyrApi.getAuditTrail(actionFilter.trim() || undefined);
      setAuditItems(res?.items ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Failed to load audit trail" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [actionFilter]);

  useEffect(() => {
    loadAudit();
  }, [loadAudit]);

  const handleCompare = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!execA.trim() || !execB.trim()) return;

    setComparing(true);
    setComparisonResult(null);
    setNotice(null);
    try {
      const res = await tenvyrApi.compareExecutions(execA.trim(), execB.trim());
      if (res.outcome === "executed" && res.result?.comparison) {
        setComparisonResult(res.result.comparison);
      } else {
        setNotice({ type: "error", message: res.error?.message || "Comparison failed" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Comparison request error" });
    } finally {
      setComparing(false);
    }
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>Operator Audit & Comparison</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Immutable ledger of operator actions, decisions, and execution diffs.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setRefreshing(true);
            loadAudit();
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
          {notice.type === "success" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <div>{notice.message}</div>
        </div>
      )}

      {/* Compare Tool */}
      <div className="card">
        <div className="card-header">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <GitCompare size={16} color="var(--accent-blue)" />
            <h2 className="card-title">Compare Two Executions</h2>
          </div>
        </div>

        <form onSubmit={handleCompare} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Execution A ID</label>
              <input
                type="text"
                value={execA}
                onChange={(e) => setExecA(e.target.value)}
                placeholder="UUID or execution ID"
                required
                className="form-input"
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Execution B ID</label>
              <input
                type="text"
                value={execB}
                onChange={(e) => setExecB(e.target.value)}
                placeholder="UUID or execution ID"
                required
                className="form-input"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={comparing || !execA.trim() || !execB.trim()}
            className="btn btn-primary btn-sm"
            style={{ alignSelf: "flex-end" }}
          >
            {comparing ? "Comparing…" : "Compare Executions"}
          </button>
        </form>

        {Boolean(comparisonResult) && (
          <div style={{ marginTop: "1rem" }}>
            <h3 style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>Comparison Diff</h3>
            <pre
              style={{
                backgroundColor: "var(--bg-surface)",
                padding: "1rem",
                borderRadius: "var(--radius-md)",
                fontSize: "0.75rem",
                overflowX: "auto",
                maxHeight: "300px",
              }}
            >
              {JSON.stringify(comparisonResult, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Audit Trail */}
      <div className="card">
        <div className="card-header">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <History size={16} color="var(--accent-blue)" />
            <h2 className="card-title">Operator Action Audit Trail ({auditItems.length})</h2>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              type="text"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              placeholder="Filter by action name…"
              className="form-input"
              style={{ padding: "0.3rem 0.6rem", fontSize: "0.75rem", width: "180px" }}
            />
          </div>
        </div>

        {loading ? (
          <LoadingSpinner text="Loading audit records…" />
        ) : auditItems.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", padding: "1.5rem 0" }}>
            No operator actions recorded yet.
          </p>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Target ID</th>
                  <th>Recorded At</th>
                  <th>Outcome Details</th>
                </tr>
              </thead>
              <tbody>
                {auditItems.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="badge badge-neutral">{item.action}</span>
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
                      {item.targetId || "—"}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                      {new Date(item.createdAt).toLocaleString()}
                    </td>
                    <td
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.75rem",
                        color: "var(--text-secondary)",
                        maxWidth: "400px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={JSON.stringify(item.outcome)}
                    >
                      {JSON.stringify(item.outcome)}
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
