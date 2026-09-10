"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Check,
  Play,
  ExternalLink,
  Copy,
  LogIn,
  Database,
  Server,
} from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import {
  MalformedResponseError,
  parseActiveAuthFlows,
  parseConnectionTestResult,
  parseProviderDiscovery,
  parseWorkbenchCommandResult,
} from "../../lib/tenvyr-api/guards.ts";
import type {
  RuntimeKind,
  RuntimeOnboardingStatusV1,
  WorkbenchConnectionCardV1,
  ConnectionTemplateV1,
  ModelCatalogEntryV1,
  RuntimeProviderV1,
} from "../../lib/tenvyr-api/types.ts";
import { StatusBadge } from "../../components/shared/StatusBadge.tsx";
import { LoadingSpinner } from "../../components/shared/LoadingSpinner.tsx";
import { AdvancedConnectionForm } from "./AdvancedConnectionForm.tsx";
import { ModelSourcesTab } from "./ModelSourcesTab.tsx";
import {
  OpenCodeConnectFlow,
  providerKey,
  useOpenCodeConnectFlow,
} from "./OpenCodeConnectFlow.tsx";
const ONBOARDING_KINDS: Array<{
  kind: RuntimeKind;
  title: string;
  desc: string;
}> = [
  {
    kind: "codex",
    title: "Codex CLI",
    desc: "OpenAI Codex CLI runtime template. Version-pinned execution.",
  },
  {
    kind: "claude",
    title: "Claude Code",
    desc: "Anthropic Claude Code CLI runtime. Requires runtime-owned login.",
  },
  {
    kind: "opencode",
    title: "OpenCode",
    desc: "OpenCode CLI runtime with multi-provider model integration.",
  },
];

export default function RuntimesPage() {
  const [tab, setTab] = useState<"runtimes" | "sources">("runtimes");
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [onboardingStatuses, setOnboardingStatuses] = useState<
    Record<string, RuntimeOnboardingStatusV1>
  >({});
  const [connections, setConnections] = useState<WorkbenchConnectionCardV1[]>(
    [],
  );
  const [templates, setTemplates] = useState<ConnectionTemplateV1[]>([]);
  const [connectingKind, setConnectingKind] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: "success" | "error" | "info" | "warning";
    message: string;
  } | null>(null);
  // P2 closure round 2: runtime-owned provider projections PER CONNECTION
  // (never keyed by runtimeKind or providerId alone — two same-kind
  // connections must never share provider state).
  const [providersByConnection, setProvidersByConnection] = useState<
    Record<string, RuntimeProviderV1[]>
  >({});
  // Guided sign-in state per runtime kind
  const [signInKind, setSignInKind] = useState<string | null>(null);
  const [copiedKind, setCopiedKind] = useState<string | null>(null);
  // P2 closure round 2: per-provider state keyed by `connectionId::providerId`
  // — the same providerId on two connections keeps INDEPENDENT state.
  const [providerCatalog, setProviderCatalog] = useState<
    Record<string, ModelCatalogEntryV1[]>
  >({});
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);

  const [refreshToken, setRefreshToken] = useState<number>(0);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [editingCard, setEditingCard] =
    useState<WorkbenchConnectionCardV1 | null>(null);

  const {
    connectFlow,
    setConnectFlow,
    connectFlowRef,
    handleConnectProvider,
    handleOauthBegin,
    handleOauthComplete,
    handleOauthCancel,
  } = useOpenCodeConnectFlow({
    onNotice: setNotice,
    setProvidersByConnection,
  });

  const loadData = useCallback(async () => {
    try {
      const [connRes, templRes] = await Promise.allSettled([
        tenvyrApi.getWorkbenchConnections(),
        tenvyrApi.getConnectionTemplates(),
      ]);

      if (connRes.status === "fulfilled") {
        setConnections(connRes.value?.cards ?? []);
      }
      if (templRes.status === "fulfilled" && templRes.value?.success) {
        setTemplates(templRes.value?.data ?? []);
      }
      const statuses: Record<string, RuntimeOnboardingStatusV1> = {};
      await Promise.all(
        ONBOARDING_KINDS.map(async ({ kind }) => {
          try {
            const res = await tenvyrApi.getRuntimeOnboarding(kind);
            if (res?.status) {
              statuses[kind] = res.status;
            }
          } catch {
            // best-effort
          }
        }),
      );
      setOnboardingStatuses(statuses);

      // P2 closure round 2: CONNECTION-scoped provider projections. The
      // backend resolves each connection's CURRENT revision — two
      // same-kind connections never share provider state.
      const providerMap: Record<string, RuntimeProviderV1[]> = {};
      const providerCards = connRes.status === "fulfilled" ? (connRes.value?.cards ?? []) : [];
      await Promise.all(
        providerCards
          .filter((card) => card.runtimeKind === "opencode")
          .map(async (card) => {
            try {
              const res = await tenvyrApi.discoverRuntimeProviders(card.connectionId);
              if (res.success) {
                providerMap[card.connectionId] =
                  parseProviderDiscovery(res.data).providers;
              }
            } catch {
              // best-effort — the card still renders without providers
            }
          }),
      );
      setProvidersByConnection(providerMap);

      // Post-PP1 hardening: browser-reload resume. For any opencode
      // connection with an ACTIVE UNEXPIRED auth flow, restore the connect
      // panel with the SAME authFlowId/URL/instructions from the retained
      // session — Complete/Cancel continue through that exact session.
      // An expired flow returns nothing here; the operator starts fresh.
      if (!connectFlowRef.current) {
        for (const card of providerCards.filter((c) => c.runtimeKind === "opencode")) {
          try {
            const res = await tenvyrApi.getActiveAuthFlows(card.connectionId);
            if (!res.success) continue;
            const flows = parseActiveAuthFlows(res.data);
            const active = flows[0];
            if (active) {
              setConnectFlow({
                connectionId: active.connectionId,
                providerId: active.providerId,
                step: "begin",
                error: null,
                authMethods: [],
                loading: false,
                selectedMethodIndex: active.methodIndex,
                authFlowId: active.authFlowId,
                url: active.url,
                method: active.authorizationMethod,
                instructions: active.instructions,
                codeInput: "",
              });
              break;
            }
          } catch {
            // best-effort resume
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Failed to load runtimes data",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [connectFlowRef, setConnectFlow]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    setRefreshToken((n) => n + 1);
    loadData();
  };

  const handleConnect = async (kind: RuntimeKind) => {
    setConnectingKind(kind);
    setNotice(null);
    try {
      const res = await tenvyrApi.onboardRuntime(kind);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult<{ connectionId: string }>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setNotice({
          type: "success",
          message: `Runtime "${kind}" connected successfully (${command.result?.connectionId ?? `conn:${kind}`}).`,
        });
        await loadData();
      } else {
        setNotice({
          type: "error",
          message:
            command.error?.message ||
            `Failed to connect runtime: ${JSON.stringify(command)}`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Connection failed" });
    } finally {
      setConnectingKind(null);
    }
  };

  const handleTest = async (connectionId: string) => {
    setTestingId(connectionId);
    setNotice(null);
    try {
      const res = await tenvyrApi.testConnection(connectionId);
      if (!res.success) {
        setNotice({
          type: "error",
          message: res.error || `Connection test failed for "${connectionId}"`,
        });
        return;
      }
      // The receipt is nested under the Workbench command result
      // (data.result.receipt). Server state is authoritative and is NEVER
      // defaulted to a fabricated readiness literal: a missing or malformed
      // receipt renders as an error.
      const result = parseConnectionTestResult(res.data);
      const receipt = result.result.receipt;
      const versionStr = receipt.testedVersion
        ? ` (v${receipt.testedVersion})`
        : "";
      const supersededStr = receipt.superseded
        ? " — superseded by a newer revision"
        : "";
      const noticeType =
        receipt.state === "AVAILABLE"
          ? "success"
          : receipt.state === "AUTH_REQUIRED" || receipt.state === "DEGRADED"
            ? "warning"
            : "error";
      setNotice({
        type: noticeType,
        message: `Connection "${connectionId}" test result: ${receipt.state}${versionStr}${supersededStr}`,
      });
      await loadData();
    } catch (err: unknown) {
      if (err instanceof MalformedResponseError) {
        setNotice({ type: "error", message: err.message });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ type: "error", message: message || "Test request failed" });
      }
    } finally {
      setTestingId(null);
    }
  };
  const handleRevoke = async (connectionId: string) => {
    if (
      !window.confirm(
        `Revoke connection "${connectionId}"? Revocation is terminal and prevents future execution claims.`,
      )
    ) {
      return;
    }
    try {
      const res = await tenvyrApi.revokeConnection(connectionId);
      if (res.success) {
        setNotice({
          type: "info",
          message: `Connection "${connectionId}" revoked.`,
        });
        await loadData();
      } else {
        setNotice({ type: "error", message: res.error || "Revocation failed" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Revocation failed" });
    }
  };

  const openReviseForm = (card: WorkbenchConnectionCardV1) => {
    setEditingCard(card);
    setShowAdvanced(true);
  };

  const handleCopyLogin = async (command: string, kind: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedKind(kind);
      setTimeout(() => setCopiedKind(null), 2000);
    } catch {
      setNotice({ type: "info", message: `Run in your terminal: ${command}` });
    }
  };

  /** Per-provider [Models]: model enumeration for THIS connection/provider
   *  (documented CLI through the exact connection profile). */
  const handleProviderModels = async (
    connectionId: string,
    providerId: string,
  ) => {
    const key = providerKey(connectionId, providerId);
    if (expandedProvider === key) {
      setExpandedProvider(null);
      return;
    }
    if (!providerCatalog[key]) {
      try {
        const res = await tenvyrApi.refreshRuntimeModels(connectionId, providerId);
        const models = res.success ? (res.data?.catalog?.models ?? []) : [];
        setProviderCatalog((current) => ({ ...current, [key]: models }));
      } catch {
        setProviderCatalog((current) => ({ ...current, [key]: [] }));
      }
    }
    setExpandedProvider(key);
  };

  /** Check Authentication: structured runtime/provider state — answers
   *  ONLY "is this provider connected per the runtime?". Never claims
   *  inference usability. */
  const handleCheckAuth = async (connectionId: string) => {
    setTestingProvider(providerKey(connectionId, "*"));
    setNotice(null);
    try {
      const res = await tenvyrApi.discoverRuntimeProviders(connectionId);
      if (res.success) {
        const discovery = parseProviderDiscovery(res.data);
        const connected = discovery.providers.filter((p) => p.authenticated);
        setProvidersByConnection((current) => ({
          ...current,
          [connectionId]: discovery.providers,
        }));
        setNotice({
          type: connected.length > 0 ? "success" : "warning",
          message:
            connected.length > 0
              ? `Authentication: ${connected.map((p) => p.providerId).join(", ")} connected through ${connectionId}.`
              : `Authentication: no providers connected through ${connectionId}.`,
        });
      } else {
        setNotice({ type: "error", message: res.error || "Auth check failed" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Auth check failed" });
    } finally {
      setTestingProvider(null);
    }
  };

  /** Refresh Models: enumerate models for THIS connection/provider. */
  const handleRefreshProviderModels = async (
    connectionId: string,
    providerId: string,
  ) => {
    setTestingProvider(providerKey(connectionId, providerId));
    setNotice(null);
    try {
      const res = await tenvyrApi.refreshRuntimeModels(connectionId, providerId);
      const count = res.success ? (res.data?.catalog?.models?.length ?? 0) : 0;
      setNotice({
        type: res.success ? "success" : "error",
        message: res.success
          ? `Provider "${providerId}" through ${connectionId}: ${count} models enumerated.`
          : res.error || "Model refresh failed",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Model refresh failed" });
    } finally {
      setTestingProvider(null);
    }
  };

  /** Key per-connection::provider state identity. */
  return (
    <div className="page-container">
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>
            Runtimes
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Agent runtimes own intelligence and authentication. Tenvyr owns
            execution supervision, bounds, and model selection authority.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
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
      </div>

      {/* Tabs: Agent Runtimes | Model Sources */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          margin: "1rem 0",
          borderBottom: "1px solid var(--border-color)",
          paddingBottom: "0.5rem",
        }}
      >
        <button
          type="button"
          onClick={() => setTab("runtimes")}
          className={`btn btn-sm ${tab === "runtimes" ? "btn-primary" : "btn-secondary"}`}
        >
          <Server size={14} />
          <span>Agent Runtimes</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("sources")}
          className={`btn btn-sm ${tab === "sources" ? "btn-primary" : "btn-secondary"}`}
        >
          <Database size={14} />
          <span>Advanced Catalogs</span>
        </button>
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

      {tab === "sources" ? (
        <ModelSourcesTab refreshToken={refreshToken} onNotice={setNotice} />
      ) : (
        <>
          {/* Guided Runtime Cards */}
          <section aria-labelledby="guided-heading">
            <div style={{ marginBottom: "0.75rem" }}>
              <h2 id="guided-heading" style={{ fontSize: "1.1rem" }}>
                Guided Runtimes
              </h2>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                Automatic CLI detection and verified templates. Authentication
                stays runtime-owned.
              </p>
            </div>

            {loading ? (
              <LoadingSpinner text="Probing runtimes…" />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                  gap: "1.25rem",
                }}
              >
                {ONBOARDING_KINDS.map(({ kind, title, desc }) => {
                  const status = onboardingStatuses[kind];
                  const conn = connections.find(
                    (c) => c.runtimeKind === kind && !c.revoked,
                  );
                  const isConnecting = connectingKind === kind;
                  const isTesting =
                    testingId === (conn?.connectionId || `conn:${kind}`);

                  return (
                    <div
                      key={kind}
                      className="card"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "1rem",
                      }}
                    >
                      <div
                        className="card-header"
                        style={{ marginBottom: 0, paddingBottom: "0.75rem" }}
                      >
                        <div>
                          <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>
                            {title}
                          </h3>
                          <p
                            style={{
                              fontSize: "0.75rem",
                              color: "var(--text-muted)",
                              marginTop: "0.15rem",
                            }}
                          >
                            {desc}
                          </p>
                        </div>
                        {conn ? (
                          <StatusBadge status={conn.status} />
                        ) : status?.detected ? (
                          status.authReady === false ? (
                            <span className="badge badge-warning">
                              Auth Required
                            </span>
                          ) : (
                            <span className="badge badge-neutral">
                              Detected
                            </span>
                          )
                        ) : (
                          <span className="badge badge-failed">Not Found</span>
                        )}
                      </div>

                      {/* Status checklist */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.4rem",
                          backgroundColor: "var(--bg-surface)",
                          padding: "0.75rem",
                          borderRadius: "var(--radius-md)",
                          fontSize: "0.8rem",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Installed:
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontWeight: 600,
                            }}
                          >
                            {status?.detected ? (
                              <span
                                style={{ color: "var(--accent-green)" }}
                                title={status.executable || undefined}
                              >
                                ✓ Yes
                              </span>
                            ) : (
                              <span style={{ color: "var(--accent-red)" }}>
                                ✕ Not on PATH
                              </span>
                            )}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Version:
                          </span>
                          <span style={{ fontFamily: "var(--font-mono)" }}>
                            {status?.version ||
                              (status?.pinnedVersion
                                ? `${status.pinnedVersion} (pinned)`
                                : "—")}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Authentication:
                          </span>
                          <span>
                            {status?.authReady === null ? (
                              <span style={{ color: "var(--text-muted)" }}>
                                Runtime-owned
                              </span>
                            ) : status?.authReady ? (
                              <span
                                style={{
                                  color: "var(--accent-green)",
                                  fontWeight: 600,
                                }}
                              >
                                Ready
                              </span>
                            ) : (
                              <span
                                style={{
                                  color: "var(--accent-amber)",
                                  fontWeight: 600,
                                }}
                              >
                                Sign-in required
                              </span>
                            )}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Connection:
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontWeight: 600,
                            }}
                          >
                            {conn ? conn.status : "—"}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Default Model:
                          </span>
                          <span style={{ fontFamily: "var(--font-mono)" }}>
                            Runtime default
                          </span>
                        </div>
                      </div>

                      {/* P2 closure: runtime-owned providers. OpenCode is the
                      first-class provider experience: every provider the
                      runtime knows appears here with its own status, official
                      Connect command, Models and Test. Codex/Claude expose a
                      single implied provider (OpenAI/Anthropic) whose auth is
                      the runtime onboarding status above. */}
                      {/* P2 closure round 2: runtime-owned providers of THIS
                      connection. OpenCode is the first-class provider
                      experience: every provider the runtime knows appears
                      here with its own connection status, Check Auth,
                      Refresh Models, Models, and a runtime-owned Connect
                      flow. Codex/Claude expose a single implied provider
                      (OpenAI/Anthropic) whose auth is the runtime
                      onboarding status below. */}
                      {conn &&
                        (providersByConnection[conn.connectionId]?.length ?? 0) > 0 && (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.4rem",
                            backgroundColor: "rgba(0, 0, 0, 0.2)",
                            padding: "0.6rem 0.75rem",
                            borderRadius: "var(--radius-md)",
                            border: "1px solid var(--border-color)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <span
                              style={{
                                color: "var(--text-secondary)",
                                fontSize: "0.8rem",
                              }}
                            >
                              Providers
                            </span>
                            <span
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: "0.75rem",
                                fontWeight: 600,
                              }}
                            >
                              {providersByConnection[conn.connectionId].filter((p) => p.authenticated).length}{" "}
                              connected
                            </span>
                          </div>
                          {providersByConnection[conn.connectionId].map((provider) => {
                            const key = providerKey(conn.connectionId, provider.providerId);
                            return (
                            <div
                              key={key}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.5rem",
                                fontSize: "0.78rem",
                              }}
                            >
                              <span
                                style={{
                                  fontFamily: "var(--font-mono)",
                                  fontWeight: 600,
                                  flex: 1,
                                }}
                              >
                                {provider.providerId}
                              </span>
                              <span
                                style={{
                                  color: provider.authenticated
                                    ? "var(--accent-green)"
                                    : "var(--accent-amber)",
                                  fontSize: "0.72rem",
                                }}
                              >
                                {provider.authenticated ? "Connected" : "Not connected"}
                              </span>
                              {provider.authenticated ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() =>
                                      handleProviderModels(conn.connectionId, provider.providerId)
                                    }
                                  >
                                    Models
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() =>
                                      handleCheckAuth(conn.connectionId)
                                    }
                                    disabled={testingProvider === providerKey(conn.connectionId, "*")}
                                  >
                                    {testingProvider === providerKey(conn.connectionId, "*")
                                      ? "Checking…"
                                      : "Check Auth"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() =>
                                      handleRefreshProviderModels(conn.connectionId, provider.providerId)
                                    }
                                    disabled={testingProvider === key}
                                  >
                                    {testingProvider === key ? "Refreshing…" : "Refresh Models"}
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  onClick={() =>
                                    handleConnectProvider(conn.connectionId, provider.providerId)
                                  }
                                >
                                  Connect
                                </button>
                              )}
                            </div>
                            );
                          })}
                          {expandedProvider &&
                            (providerCatalog[expandedProvider] ?? []).length > 0 && (
                              <div
                                style={{
                                  fontSize: "0.72rem",
                                  fontFamily: "var(--font-mono)",
                                  maxHeight: "120px",
                                  overflowY: "auto",
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "0.15rem",
                                }}
                              >
                                {(providerCatalog[expandedProvider] ?? []).map(
                                  (entry) => (
                                    <span key={entry.modelId}>{entry.modelId}</span>
                                  ),
                                )}
                              </div>
                            )}
                          {/* Connect flow: runtime-owned OAuth via the official
                          Server API; api-key methods stay guided official
                          commands (Tenvyr never receives raw keys). */}
                          <OpenCodeConnectFlow
                            connectionId={conn.connectionId}
                            connectFlow={connectFlow}
                            setConnectFlow={setConnectFlow}
                            providers={
                              providersByConnection[conn.connectionId] ?? []
                            }
                            copiedKind={copiedKind}
                            onCopyLogin={handleCopyLogin}
                            onCheckAuth={handleCheckAuth}
                            handleOauthBegin={handleOauthBegin}
                            handleOauthComplete={handleOauthComplete}
                            handleOauthCancel={handleOauthCancel}
                          />
                        </div>
                      )}

                      {/* P2: guided official login — Tenvyr never collects provider
                      credentials; it only shows the runtime's OWN command. */}
                      {/* P2 closure round 2: auth repair is available for
                      EXISTING connections too — a Runtime Connection and
                      runtime authentication are SEPARATE states; an
                      AUTH_REQUIRED connection must not require
                      revoke/recreate to repair. The Sign-in flow stays
                      runtime-owned. */}
                      {(status?.authReady === false ||
                        conn?.status === "AUTH_REQUIRED") &&
                        status.loginCommand && (
                          <div
                            style={{
                              backgroundColor: "rgba(0, 0, 0, 0.2)",
                              padding: "0.6rem 0.75rem",
                              borderRadius: "var(--radius-md)",
                              border: "1px solid var(--border-color)",
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.5rem",
                            }}
                          >
                            {signInKind === kind ? (
                              <>
                                <div
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "var(--text-secondary)",
                                  }}
                                >
                                  Run the official sign-in in your own terminal
                                  (Tenvyr never sees your credentials):
                                </div>
                                <code
                                  style={{
                                    fontFamily: "var(--font-mono)",
                                    fontSize: "0.8rem",
                                    padding: "0.4rem 0.6rem",
                                    backgroundColor: "var(--bg-surface)",
                                    borderRadius: "var(--radius-sm)",
                                    overflowWrap: "anywhere",
                                  }}
                                >
                                  {status.loginCommand}
                                </code>
                                <div style={{ display: "flex", gap: "0.5rem" }}>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() =>
                                      handleCopyLogin(status.loginCommand, kind)
                                    }
                                  >
                                    <Copy size={12} />
                                    <span>
                                      {copiedKind === kind
                                        ? "Copied"
                                        : "Copy Command"}
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={async () => {
                                      setSignInKind(null);
                                      await loadData();
                                      // P1: Check Again completes the login loop — if auth is now ready, revalidate the existing connection
                                      try {
                                        const freshStatus = await tenvyrApi.getRuntimeOnboarding(kind);
                                        if (freshStatus?.status?.authReady) {
                                          const existing = connections.find((c) => c.runtimeKind === kind && !c.revoked);
                                          if (existing) {
                                            await handleTest(existing.connectionId);
                                          }
                                        }
                                      } catch {}
                                      await loadData();
                                    }}
                                  >
                                    <RefreshCw size={12} />
                                    <span>Check Again</span>
                                  </button>
                                </div>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => setSignInKind(kind)}
                              >
                                <LogIn size={12} />
                                <span>Sign in</span>
                              </button>
                            )}
                          </div>
                        )}

                      {/* Guidance block */}
                      {status?.guidance && status.guidance.length > 0 && (
                        <div
                          style={{
                            backgroundColor: "rgba(0, 0, 0, 0.2)",
                            padding: "0.6rem 0.75rem",
                            borderRadius: "var(--radius-md)",
                            border: "1px solid var(--border-color)",
                            fontSize: "0.75rem",
                            color: "var(--text-secondary)",
                            wordBreak: "break-word",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {status.guidance.map((line, idx) => (
                            <p
                              key={idx}
                              style={{
                                marginBottom:
                                  idx < status.guidance.length - 1
                                    ? "0.3rem"
                                    : 0,
                              }}
                            >
                              {line}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* Action buttons */}
                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          marginTop: "auto",
                        }}
                      >
                        {conn ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleTest(conn.connectionId)}
                              disabled={isTesting}
                              className="btn btn-secondary btn-sm"
                              style={{ flex: 1 }}
                            >
                              <Play size={12} />
                              <span>
                                {isTesting ? "Testing…" : "Test Runtime"}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openReviseForm(conn)}
                              className="btn btn-secondary btn-sm"
                            >
                              Revise
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRevoke(conn.connectionId)}
                              className="btn btn-danger btn-sm"
                            >
                              Revoke
                            </button>
                          </>
                        ) : status?.detected ? (
                          <button
                            type="button"
                            onClick={() => handleConnect(kind)}
                            disabled={isConnecting}
                            className="btn btn-primary btn-sm"
                            style={{ width: "100%" }}
                          >
                            <Check size={14} />
                            <span>
                              {isConnecting
                                ? "Connecting…"
                                : `Connect ${title}`}
                            </span>
                          </button>
                        ) : (
                          <a
                            href={status?.docUrl || "https://github.com"}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-secondary btn-sm"
                            style={{ width: "100%" }}
                          >
                            <ExternalLink size={12} />
                            <span>Installation Instructions</span>
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Active Connections Catalog */}
          <section
            aria-labelledby="connections-heading"
            style={{ marginTop: "1.5rem" }}
          >
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 id="connections-heading" className="card-title">
                    All Runtime Connections
                  </h2>
                  <p
                    style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}
                  >
                    Audited immutable connection profiles & capability records
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingCard(null);
                    setShowAdvanced(!showAdvanced);
                  }}
                  className="btn btn-secondary btn-sm"
                >
                  {showAdvanced
                    ? "Hide Configuration Form"
                    : "+ Add Custom Connection"}
                </button>
              </div>

              <AdvancedConnectionForm
                show={showAdvanced}
                editingCard={editingCard}
                templates={templates}
                onNotice={setNotice}
                onSaved={async () => {
                  setEditingCard(null);
                  setShowAdvanced(false);
                  await loadData();
                }}
                onCancel={() => setShowAdvanced(false)}
              />
              {connections.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "2rem 1rem",
                    color: "var(--text-muted)",
                  }}
                >
                  No runtime connections configured. Click &ldquo;Connect&rdquo;
                  above on Codex, Claude Code, or OpenCode.
                </div>
              ) : (
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Connection ID</th>
                        <th>Name</th>
                        <th>Kind</th>
                        <th>Status</th>
                        <th>Tested Version</th>
                        <th>Last Tested</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {connections.map((c) => (
                        <tr key={c.connectionId}>
                          <td
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontWeight: 600,
                            }}
                          >
                            {c.connectionId}
                          </td>
                          <td>{c.name}</td>
                          <td>
                            <span className="badge badge-neutral">
                              {c.runtimeKind}
                            </span>
                          </td>
                          <td>
                            <StatusBadge status={c.status} />
                          </td>
                          <td
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "0.75rem",
                            }}
                          >
                            {c.testedVersion || "—"}
                          </td>
                          <td
                            style={{
                              color: "var(--text-muted)",
                              fontSize: "0.75rem",
                            }}
                          >
                            {c.testedAt
                              ? new Date(c.testedAt).toLocaleTimeString()
                              : "Never"}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: "0.35rem" }}>
                              {!c.revoked && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleTest(c.connectionId)}
                                    disabled={testingId === c.connectionId}
                                    className="btn btn-secondary btn-sm"
                                  >
                                    Test
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openReviseForm(c)}
                                    className="btn btn-secondary btn-sm"
                                  >
                                    Revise
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRevoke(c.connectionId)}
                                    className="btn btn-danger btn-sm"
                                  >
                                    Revoke
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
