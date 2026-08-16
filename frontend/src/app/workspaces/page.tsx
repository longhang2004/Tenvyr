"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  FolderGit2,
  GitBranch,
  GitCommit,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Plus,
  ArrowRight,
  ShieldAlert,
} from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import { parseWorkbenchCommandResult } from "../../lib/tenvyr-api/guards.ts";
import type { WorkbenchWorkspaceV1 } from "../../lib/tenvyr-api/types.ts";
import { EmptyState } from "../../components/shared/EmptyState.tsx";
import { LoadingSpinner } from "../../components/shared/LoadingSpinner.tsx";
import { DirectoryInput } from "../../components/shared/DirectoryInput.tsx";

export default function WorkspacesPage() {
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [workspaces, setWorkspaces] = useState<WorkbenchWorkspaceV1[]>([]);
  const [newPath, setNewPath] = useState<string>("");
  const [newName, setNewName] = useState<string>("");
  const [adding, setAdding] = useState<boolean>(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await tenvyrApi.getWorkspaces();
      setWorkspaces(res?.workspaces ?? []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Failed to load workspaces" });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadWorkspaces();
  };

  const handleAddWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPath.trim()) return;

    setAdding(true);
    setNotice(null);
    try {
      const res = await tenvyrApi.createWorkspace({
        path: newPath.trim(),
        ...(newName.trim() ? { name: newName.trim() } : {}),
      });
      const command = parseWorkbenchCommandResult<{ workspace: WorkbenchWorkspaceV1 }>(res.data);

      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setNotice({
          type: "success",
          message: `Workspace "${command.result?.workspace?.name ?? newPath}" added successfully.`,
        });
        setNewPath("");
        setNewName("");
        await loadWorkspaces();
      } else {
        setNotice({
          type: "error",
          message: command.error?.message || "Failed to add workspace",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Failed to create workspace" });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>Workspaces</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Local project repositories supervised agent teams execute against.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
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

      {/* Execution Semantics Notice (PP1) */}
      <div className="notice notice-info">
        <ShieldAlert size={18} style={{ flexShrink: 0 }} />
        <div>
          <strong>Workspace Execution:</strong> A bounded git identity
          snapshot (branch, HEAD SHA, dirty state) is frozen at run launch
          and injected into worker inputs and the verifier context. Each
          Team Run chooses its execution isolation at launch:{" "}
          <strong>Git worktree</strong> executes every runtime child inside
          a Tenvyr-owned isolated worktree (source tree untouched), or{" "}
          <strong>Shared working tree</strong> executes directly against
          this mutable working tree. Workspaces are execution boundaries,
          not just provenance.
        </div>
      </div>

      {/* Add Workspace Form */}
      <div className="card">
        <h2 className="card-title" style={{ marginBottom: "1rem" }}>
          Add Workspace
        </h2>
        <form onSubmit={handleAddWorkspace} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "1rem" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Workspace Name (optional)</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="tenvyr"
                className="form-input"
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Absolute Repository Path</label>
              <DirectoryInput
                value={newPath}
                onChange={setNewPath}
                placeholder="/Users/username/repos/my-project"
                required
              />
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" disabled={adding || !newPath.trim()} className="btn btn-primary">
              <Plus size={16} />
              <span>{adding ? "Adding Workspace…" : "Add Workspace"}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Workspace Cards */}
      <div className="card">
        <h2 className="card-title" style={{ marginBottom: "1rem" }}>
          Configured Workspaces ({workspaces.length})
        </h2>

        {loading ? (
          <LoadingSpinner text="Loading workspaces…" />
        ) : workspaces.length === 0 ? (
          <EmptyState
            icon={FolderGit2}
            title="No workspaces registered"
            description="Add your local git repository path above to select it as an execution target for supervised agent runs."
          />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "1rem" }}>
            {workspaces.map((ws) => (
              <div
                key={ws.workspaceId}
                style={{
                  backgroundColor: "var(--bg-surface)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "var(--radius-md)",
                  padding: "1rem",
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <h3 style={{ fontSize: "0.95rem", fontWeight: 700 }}>{ws.name}</h3>
                    <p
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--text-muted)",
                        fontFamily: "var(--font-mono)",
                        marginTop: "0.2rem",
                        wordBreak: "break-all",
                      }}
                    >
                      {ws.path}
                    </p>
                  </div>
                  {ws.snapshot?.dirty && (
                    <span className="badge badge-warning">Dirty Tree</span>
                  )}
                </div>

                {ws.snapshot && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.75rem",
                      fontSize: "0.75rem",
                      color: "var(--text-secondary)",
                      borderTop: "1px solid var(--border-color)",
                      paddingTop: "0.6rem",
                    }}
                  >
                    {ws.snapshot.branch && (
                      <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                        <GitBranch size={12} color="var(--accent-blue)" />
                        <span>{ws.snapshot.branch}</span>
                      </div>
                    )}
                    {ws.snapshot.headSha && (
                      <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                        <GitCommit size={12} color="var(--accent-purple)" />
                        <span style={{ fontFamily: "var(--font-mono)" }}>
                          {ws.snapshot.headSha.slice(0, 8)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "auto", paddingTop: "0.5rem" }}>
                  <Link
                    href={`/runs/new?workspaceId=${encodeURIComponent(ws.workspaceId)}`}
                    className="btn btn-sm btn-secondary"
                    style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center" }}
                  >
                    <span>Use in New Run</span>
                    <ArrowRight size={12} />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
