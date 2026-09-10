"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Play, RefreshCw, Trash2 } from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import { parseWorkbenchCommandResult } from "../../lib/tenvyr-api/guards.ts";
import type {
  ModelCatalogSnapshotV1,
  ModelSourceV1,
} from "../../lib/tenvyr-api/types.ts";
import { LoadingSpinner } from "../../components/shared/LoadingSpinner.tsx";
import { StatusBadge } from "../../components/shared/StatusBadge.tsx";

export function ModelSourcesTab({
  refreshToken,
  onNotice,
}: {
  refreshToken: number;
  onNotice: (
    notice: {
      type: "success" | "error" | "info" | "warning";
      message: string;
    } | null,
  ) => void;
}) {
  const [loading, setLoading] = useState<boolean>(true);
  const [sources, setSources] = useState<ModelSourceV1[]>([]);
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const [refreshingSourceId, setRefreshingSourceId] = useState<string | null>(
    null,
  );
  const [showAddSource, setShowAddSource] = useState<boolean>(false);
  const [srcName, setSrcName] = useState<string>("OpenAI-compatible endpoint");
  const [srcBaseUrl, setSrcBaseUrl] = useState<string>("https://example.com/v1");
  const [srcCredentialRef, setSrcCredentialRef] = useState<string>("");
  const [savingSource, setSavingSource] = useState<boolean>(false);

  const loadSources = useCallback(async () => {
    try {
      const srcRes = await tenvyrApi.getModelSources();
      if (srcRes.success) {
        setSources(srcRes.data ?? []);
      }
    } catch {
      // best-effort — same as page-level Promise.allSettled
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources, refreshToken]);

  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSource(true);
    onNotice(null);
    try {
      // P2 closure: the advanced catalog surface is the generic
      // OpenAI-compatible endpoint only. Provider state is runtime-owned
      // (OpenCode CLI discovery) — never a standalone source row, and
      // 9Router is not a Tenvyr product kind.
      const source: Record<string, unknown> = {
        sourceId: `src:${
          srcName
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_.:-]+/g, "-") || "source"
        }`,
        kind: "openai-compatible",
        displayName: srcName.trim(),
        baseUrl: srcBaseUrl.trim(),
      };
      if (srcCredentialRef.trim()) {
        source.credentialEnvRef = srcCredentialRef.trim();
      }
      const res = await tenvyrApi.createModelSource(source);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult<{ source: ModelSourceV1 }>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        onNotice({
          type: "success",
          message: `Catalog endpoint "${String(source.sourceId)}" created.`,
        });
        setShowAddSource(false);
        await loadSources();
      } else {
        onNotice({
          type: "error",
          message: command.error?.message || "Failed to create catalog endpoint",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onNotice({
        type: "error",
        message: message || "Failed to create model source",
      });
    } finally {
      setSavingSource(false);
    }
  };

  const handleTestSource = async (sourceId: string) => {
    setTestingSourceId(sourceId);
    onNotice(null);
    try {
      const res = await tenvyrApi.testModelSource(sourceId);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult<{ source: ModelSourceV1 }>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        const source = command.result?.source;
        const count = source?.modelCount
          ? ` (${source.modelCount} models)`
          : "";
        onNotice({
          type: source?.status === "AVAILABLE" ? "success" : "warning",
          message: `Catalog endpoint "${sourceId}" test result: ${source?.status ?? "UNKNOWN"}${count}`,
        });
        await loadSources();
      } else {
        onNotice({
          type: "error",
          message: command.error?.message || `Endpoint test failed for "${sourceId}"`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onNotice({
        type: "error",
        message: message || "Source test request failed",
      });
    } finally {
      setTestingSourceId(null);
    }
  };

  const handleRefreshSource = async (sourceId: string) => {
    setRefreshingSourceId(sourceId);
    onNotice(null);
    try {
      const res = await tenvyrApi.refreshModelSource(sourceId);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult<{ source: ModelSourceV1; catalog: ModelCatalogSnapshotV1 }>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        const catalog = command.result?.catalog;
        onNotice({
          type: "success",
          message: `Catalog refreshed for "${sourceId}": ${catalog?.models?.length ?? 0} models${catalog?.truncated ? " (truncated at bound)" : ""}.`,
        });
        await loadSources();
      } else {
        onNotice({
          type: "error",
          message: command.error?.message || `Refresh failed for "${sourceId}"`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onNotice({
        type: "error",
        message: message || "Refresh request failed",
      });
    } finally {
      setRefreshingSourceId(null);
    }
  };

  const handleDeleteSource = async (sourceId: string) => {
    if (
      !window.confirm(
        `Delete model source "${sourceId}"? This removes the operator configuration (catalogs are never stored).`,
      )
    ) {
      return;
    }
    try {
      const res = await tenvyrApi.deleteModelSource(sourceId);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        onNotice({
          type: "info",
          message: `Model source "${sourceId}" deleted.`,
        });
        await loadSources();
      } else {
        onNotice({
          type: "error",
          message: command.error?.message || "Delete failed",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onNotice({ type: "error", message: message || "Delete request failed" });
    }
  };

  return (
        <section aria-labelledby="sources-heading">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "0.75rem",
            }}
          >
            <div>
              <h2 id="sources-heading" style={{ fontSize: "1.1rem" }}>
                Advanced Catalogs
              </h2>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                Generic OpenAI-compatible catalog endpoints (advanced operator
                surface). Provider state is runtime-owned — providers
                authenticated through a runtime appear under the runtime card.
                Catalogs are bounded on-demand projections — never stored,
                never execution authority.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowAddSource(!showAddSource)}
            >
              {showAddSource ? "Hide Form" : "+ Add Catalog Endpoint"}
            </button>
          </div>

          {showAddSource && (
            <form
              onSubmit={handleAddSource}
              style={{
                backgroundColor: "var(--bg-surface)",
                padding: "1.25rem",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-color)",
                marginBottom: "1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "1rem",
              }}
            >
              <h3 style={{ fontSize: "0.9rem", fontWeight: 700 }}>
                Add Catalog Endpoint
              </h3>
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                }}
              >
                Generic OpenAI-compatible endpoint (kind is fixed). Provider
                state is runtime-owned — an existing 9Router instance is
                represented exactly like any other OpenAI-compatible endpoint.
              </p>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Display Name</label>
                <input
                  type="text"
                  value={srcName}
                  onChange={(e) => setSrcName(e.target.value)}
                  required
                  className="form-input"
                />
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1rem",
                }}
              >
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">
                    Base URL (http/https, no credentials in URL)
                  </label>
                  <input
                    type="text"
                    value={srcBaseUrl}
                    onChange={(e) => setSrcBaseUrl(e.target.value)}
                    required
                    className="form-input"
                    placeholder="https://example.com/v1"
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">
                    Credential Env Var Name (optional, name only)
                  </label>
                  <input
                    type="text"
                    value={srcCredentialRef}
                    onChange={(e) => setSrcCredentialRef(e.target.value)}
                    className="form-input"
                    placeholder="MY_API_KEY"
                  />
                  <p
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--text-muted)",
                      marginTop: "0.25rem",
                    }}
                  >
                    Only the NAME is stored; the value is resolved at request
                    time on the server.
                  </p>
                </div>
              </div>
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                }}
              >
                Catalogs are discovery projections only — a catalog entry
                never creates execution authority.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  onClick={() => setShowAddSource(false)}
                  className="btn btn-secondary btn-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSource}
                  className="btn btn-primary btn-sm"
                >
                  {savingSource ? "Saving…" : "Create Source"}
                </button>
              </div>
            </form>
          )}

          {loading ? (
            <LoadingSpinner text="Loading model sources…" />
          ) : sources.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "2rem 1rem",
                color: "var(--text-muted)",
              }}
            >
              No catalog endpoints configured. Add a generic
              OpenAI-compatible endpoint (advanced), or connect providers
              through the Agent Runtime cards.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                gap: "1.25rem",
              }}
            >
              {sources.map((source) => (
                <div
                  key={source.sourceId}
                  className="card"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  <div
                    className="card-header"
                    style={{ marginBottom: 0, paddingBottom: "0.6rem" }}
                  >
                    <div>
                      <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>
                        {source.displayName}
                      </h3>
                      <p
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--text-muted)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {source.sourceId} · {source.kind}
                      </p>
                    </div>
                    <StatusBadge status={source.status} />
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.35rem",
                      fontSize: "0.8rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>
                        Endpoint:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {source.baseUrl ?? "CLI catalog"}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>
                        Credential ref:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {source.credentialEnvRef ?? "none"}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>
                        Models:
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontWeight: 600,
                        }}
                      >
                        {source.modelCount ?? 0}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>
                        Last refreshed:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {source.lastCatalogRefreshAt
                          ? `${Math.max(1, Math.round((Date.now() - Date.parse(source.lastCatalogRefreshAt)) / 60000))}m ago`
                          : "never"}
                      </span>
                    </div>
                    {source.reasonCode !== "none" && (
                      <div
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--accent-amber)",
                        }}
                      >
                        reason: {source.reasonCode}
                      </div>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      marginTop: "auto",
                    }}
                  >
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleRefreshSource(source.sourceId)}
                      disabled={refreshingSourceId === source.sourceId}
                      style={{ flex: 1 }}
                    >
                      <RefreshCw
                        size={12}
                        style={{
                          animation:
                            refreshingSourceId === source.sourceId
                              ? "spin 1s linear infinite"
                              : "none",
                        }}
                      />
                      <span>
                        {refreshingSourceId === source.sourceId
                          ? "Refreshing…"
                          : "Refresh Models"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleTestSource(source.sourceId)}
                      disabled={testingSourceId === source.sourceId}
                    >
                      <Play size={12} />
                      <span>
                        {testingSourceId === source.sourceId
                          ? "Testing…"
                          : "Test Source"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDeleteSource(source.sourceId)}
                      aria-label={`Delete ${source.sourceId}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
  );
}
