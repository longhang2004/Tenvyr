"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  ListOrdered,
  PlayCircle,
  RefreshCw,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import type { WorkbenchExecutionSummaryV1 } from "../../lib/tenvyr-api/types.ts";
import { StatusBadge } from "../../components/shared/StatusBadge.tsx";
import { EmptyState } from "../../components/shared/EmptyState.tsx";
import { LoadingSpinner } from "../../components/shared/LoadingSpinner.tsx";

export default function RunsPage() {
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [page, setPage] = useState<number>(1);
  const [truncated, setTruncated] = useState<boolean>(false);
  const [executions, setExecutions] = useState<WorkbenchExecutionSummaryV1[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadExecutions = useCallback(async (targetPage: number) => {
    try {
      setErrorMsg(null);
      const res = await tenvyrApi.getWorkbenchExecutions(targetPage);
      setExecutions(res?.items ?? []);
      setTruncated(res?.truncated ?? false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message || "Failed to load executions");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadExecutions(page);
    const interval = setInterval(() => loadExecutions(page), 5000);
    return () => clearInterval(interval);
  }, [loadExecutions, page]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadExecutions(page);
  };

  const filteredExecutions = executions.filter((e) => {
    if (filterStatus === "ALL") return true;
    if (filterStatus === "WAITING") return e.coordinationPhase === "WAITING_FOR_HUMAN";
    if (filterStatus === "RUNNING") return e.status === "RUNNING";
    if (filterStatus === "ACCEPTED") return e.coordinationPhase === "ACCEPTED" || e.status === "COMPLETED";
    if (filterStatus === "FAILED") return e.status === "FAILED";
    return true;
  });

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>Team Runs</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Durable execution records and supervised coordination histories.
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <button
            type="button"
            onClick={handleRefresh}
            className="btn btn-secondary btn-sm"
            disabled={refreshing}
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
          <div>{errorMsg}</div>
        </div>
      )}

      {/* Filter Tabs */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {[
          { id: "ALL", label: "All Runs" },
          { id: "RUNNING", label: "Running" },
          { id: "WAITING", label: "Waiting for Human" },
          { id: "ACCEPTED", label: "Accepted" },
          { id: "FAILED", label: "Failed" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilterStatus(tab.id)}
            className={`btn btn-sm ${filterStatus === tab.id ? "btn-primary" : "btn-secondary"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Executions Table */}
      <div className="card">
        {loading ? (
          <LoadingSpinner text="Loading executions…" />
        ) : filteredExecutions.length === 0 ? (
          <EmptyState
            icon={ListOrdered}
            title="No runs match filter"
            description="Start a new team run or select a different filter."
            actionText={filterStatus !== "ALL" ? "Clear Filter" : "Start Team Run"}
            onAction={filterStatus !== "ALL" ? () => setFilterStatus("ALL") : undefined}
            actionHref={filterStatus === "ALL" ? "/runs/new" : undefined}
          />
        ) : (
          <>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Execution ID</th>
                    <th>Status</th>
                    <th>Coordination Phase</th>
                    <th>Iteration</th>
                    <th>Step Count</th>
                    <th>Started</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExecutions.map((run) => (
                    <tr key={run.id}>
                      <td style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                        <Link href={`/runs/${encodeURIComponent(run.id)}`}>
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
                        {new Date(run.createdAt).toLocaleString()}
                      </td>
                      <td>
                        <Link
                          href={`/runs/${encodeURIComponent(run.id)}`}
                          className="btn btn-sm btn-secondary"
                        >
                          Inspect <ArrowRight size={12} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: "1rem",
                fontSize: "0.85rem",
                color: "var(--text-secondary)",
              }}
            >
              <span>Page {page}</span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="btn btn-secondary btn-sm"
                >
                  <ChevronLeft size={14} />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPage(page + 1)}
                  disabled={!truncated}
                  className="btn btn-secondary btn-sm"
                >
                  <span>Next</span>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
