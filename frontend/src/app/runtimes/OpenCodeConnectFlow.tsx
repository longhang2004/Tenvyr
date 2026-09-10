"use client";

import React, { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import {
  parseOpenCodeAuthBegin,
  parseProviderAuthMethods,
  parseProviderDiscovery,
  parseWorkbenchCommandResult,
} from "../../lib/tenvyr-api/guards.ts";
import type {
  OpenCodeAuthBeginV1,
  OpenCodeAuthMethodV1,
  RuntimeProviderV1,
} from "../../lib/tenvyr-api/types.ts";

export type ConnectFlowState = {
  connectionId: string;
  providerId: string;
  step: "choose" | "begin" | "completed";
  error: string | null;
  authMethods: OpenCodeAuthMethodV1[];
  loading: boolean;
  selectedMethodIndex: number | null;
  authFlowId: string | null;
  url: string | null;
  method: "auto" | "code" | null;
  instructions: string | null;
  codeInput: string;
};

/** Key per-connection::provider state identity. */
export const providerKey = (connectionId: string, providerId: string): string =>
  `${connectionId}::${providerId}`;

export function useOpenCodeConnectFlow({
  onNotice,
  setProvidersByConnection,
}: {
  onNotice: (
    notice: {
      type: "success" | "error" | "info" | "warning";
      message: string;
    } | null,
  ) => void;
  setProvidersByConnection: React.Dispatch<
    React.SetStateAction<Record<string, RuntimeProviderV1[]>>
  >;
}) {
  const [connectFlow, setConnectFlow] = useState<ConnectFlowState | null>(null);
  // Resume guard: loadData must never clobber an in-flight connect flow.
  const connectFlowRef = useRef(connectFlow);
  useEffect(() => {
    connectFlowRef.current = connectFlow;
  }, [connectFlow]);

  const handleConnectProvider = async (connectionId: string, providerId: string) => {
    setConnectFlow({
      connectionId,
      providerId,
      step: "choose",
      error: null,
      authMethods: [],
      loading: true,
      selectedMethodIndex: null,
      authFlowId: null,
      url: null,
      method: null,
      instructions: null,
      codeInput: "",
    });
    try {
      const res = await tenvyrApi.getRuntimeProviderAuthMethods(connectionId, providerId);
      const methods = res.success ? parseProviderAuthMethods(res.data).methods : [];
      setConnectFlow((current) =>
        current ? { ...current, authMethods: methods, loading: false } : current,
      );
    } catch (err: unknown) {
      setConnectFlow((current) =>
        current
          ? {
              ...current,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  /** Begin: start the flow with the SELECTED method index AND its expected
   *  fingerprint (type + label) from the snapshot the operator actually
   *  saw — a reordered/changed fresh snapshot fails closed server-side.
   *  One live session retained. */
  const handleOauthBegin = async (connectionId: string, providerId: string) => {
    const flow = connectFlow;
    if (!flow || flow.selectedMethodIndex === null) return;
    const selectedMethod = flow.authMethods.find(
      (m) => m.methodIndex === flow.selectedMethodIndex,
    );
    setConnectFlow({ ...flow, step: "begin", error: null, loading: true });
    try {
      const res = await tenvyrApi.openCodeOauthBegin(
        connectionId,
        providerId,
        flow.selectedMethodIndex,
        selectedMethod ? { type: selectedMethod.type, label: selectedMethod.label } : undefined,
      );
      const command = parseWorkbenchCommandResult<OpenCodeAuthBeginV1>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        const begun = parseOpenCodeAuthBegin(command.result);
        setConnectFlow((current) =>
          current
            ? {
                ...current,
                step: "begin",
                authFlowId: begun.authFlowId,
                url: begun.url,
                method: begun.method,
                instructions: begun.instructions,
                loading: false,
              }
            : current,
        );
      } else {
        setConnectFlow((current) =>
          current
            ? { ...current, loading: false, error: command.error?.message || "Authorization failed" }
            : current,
        );
      }
    } catch (err: unknown) {
      setConnectFlow((current) =>
        current
          ? {
              ...current,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  /** Complete through the SAME live session; the bounded code (code flow)
   *  is sent once, never logged. */
  const handleOauthComplete = async () => {
    const flow = connectFlow;
    if (!flow || !flow.authFlowId) return;
    setConnectFlow({ ...flow, loading: true, error: null });
    try {
      const res = await tenvyrApi.openCodeOauthComplete(
        flow.authFlowId,
        flow.method === "code" && flow.codeInput.trim() ? flow.codeInput.trim() : undefined,
      );
      const command = parseWorkbenchCommandResult<{ connected: boolean }>(res.data);
      const connected = command.result?.connected === true;
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setConnectFlow((current) =>
          current ? { ...current, loading: false, step: "completed" } : current,
        );
        onNotice({
          type: connected ? "success" : "warning",
          message: connected
            ? `Provider "${flow.providerId}" connected through ${flow.connectionId}.`
            : `Provider "${flow.providerId}" is still not connected according to ${flow.connectionId}.`,
        });
        // Refresh the connection's provider projection.
        const res2 = await tenvyrApi.discoverRuntimeProviders(flow.connectionId);
        if (res2.success) {
          const discovery = parseProviderDiscovery(res2.data);
          setProvidersByConnection((current) => ({
            ...current,
            [flow.connectionId]: discovery.providers,
          }));
        }
      } else {
        setConnectFlow((current) =>
          current
            ? {
                ...current,
                loading: false,
                error: command.error?.message || "OAuth completion failed",
              }
            : current,
        );
      }
    } catch (err: unknown) {
      setConnectFlow((current) =>
        current
          ? {
              ...current,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  /** Cancel: deterministic cleanup of the live management session. */
  const handleOauthCancel = async () => {
    const flow = connectFlow;
    if (!flow) return;
    if (flow.authFlowId) {
      try {
        await tenvyrApi.openCodeOauthCancel(flow.authFlowId);
      } catch {
        // best-effort cleanup
      }
    }
    setConnectFlow(null);
  };

  return {
    connectFlow,
    setConnectFlow,
    connectFlowRef,
    handleConnectProvider,
    handleOauthBegin,
    handleOauthComplete,
    handleOauthCancel,
  };
}

export function OpenCodeConnectFlow({
  connectionId,
  connectFlow,
  setConnectFlow,
  providers,
  copiedKind,
  onCopyLogin,
  onCheckAuth,
  handleOauthBegin,
  handleOauthComplete,
  handleOauthCancel,
}: {
  connectionId: string;
  connectFlow: ConnectFlowState | null;
  setConnectFlow: React.Dispatch<React.SetStateAction<ConnectFlowState | null>>;
  providers: RuntimeProviderV1[];
  copiedKind: string | null;
  onCopyLogin: (command: string, kind: string) => void;
  onCheckAuth: (connectionId: string) => void | Promise<void>;
  handleOauthBegin: (connectionId: string, providerId: string) => Promise<void>;
  handleOauthComplete: () => Promise<void>;
  handleOauthCancel: () => Promise<void>;
}) {
  if (!connectFlow || connectFlow.connectionId !== connectionId) {
    return null;
  }

  return (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "0.45rem",
                                borderTop: "1px solid var(--border-color)",
                                paddingTop: "0.5rem",
                              }}
                            >
                              <div style={{ fontSize: "0.78rem", fontWeight: 600 }}>
                                Connect provider: {connectFlow.providerId}
                              </div>
                              {connectFlow.loading && (
                                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                                  Loading…
                                </div>
                              )}
                              {connectFlow.error && (
                                <div style={{ fontSize: "0.72rem", color: "var(--accent-red)" }}>
                                  {connectFlow.error}
                                </div>
                              )}
                              {!connectFlow.loading &&
                                connectFlow.step === "choose" &&
                                connectFlow.authMethods.length === 0 && (
                                  <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                                    The runtime reports no auth methods for this provider.
                                  </div>
                                )}
                              {!connectFlow.loading && connectFlow.step === "choose" && (
                                <>
                                  {/* Auth method selection: the REAL contract is
                                  {type,label} identified by stable list index. */}
                                  <select
                                    value={connectFlow.selectedMethodIndex ?? ""}
                                    onChange={(e) =>
                                      setConnectFlow((current) =>
                                        current
                                          ? {
                                              ...current,
                                              selectedMethodIndex:
                                                e.target.value === ""
                                                  ? null
                                                  : Number(e.target.value),
                                            }
                                          : current,
                                      )
                                    }
                                    className="form-select"
                                    aria-label="Auth method"
                                  >
                                    <option value="">Select auth method…</option>
                                    {connectFlow.authMethods.map((method) => (
                                      <option key={method.methodIndex} value={method.methodIndex}>
                                        {method.label} ({method.type})
                                        {method.requiresPrompt ? " — unsupported prompt" : ""}
                                      </option>
                                    ))}
                                  </select>
                                  {(() => {
                                    const selectedMethod = connectFlow.authMethods.find(
                                      (m) => m.methodIndex === connectFlow.selectedMethodIndex,
                                    );
                                    const loginCommand =
                                      providers.find(
                                        (p) =>
                                          p.providerId === connectFlow.providerId,
                                      )?.loginCommand ?? "";
                                    if (!selectedMethod) return null;
                                    if (selectedMethod.requiresPrompt) {
                                      return (
                                        <>
                                          <div
                                            style={{
                                              fontSize: "0.7rem",
                                              color: "var(--text-muted)",
                                            }}
                                          >
                                            This method requires prompt inputs Tenvyr does not
                                            drive (fail closed). Authentication stays
                                            runtime-owned — run the official command:
                                          </div>
                                          <code
                                            style={{
                                              fontFamily: "var(--font-mono)",
                                              fontSize: "0.75rem",
                                              padding: "0.3rem 0.5rem",
                                              backgroundColor: "var(--bg-surface)",
                                              borderRadius: "var(--radius-sm)",
                                              overflowWrap: "anywhere",
                                            }}
                                          >
                                            {loginCommand}
                                          </code>
                                          <div style={{ display: "flex", gap: "0.5rem" }}>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm"
                                              onClick={() =>
                                                onCopyLogin(
                                                  loginCommand,
                                                  providerKey(
                                                    connectFlow.connectionId,
                                                    connectFlow.providerId,
                                                  ),
                                                )
                                              }
                                            >
                                              <Copy size={12} />
                                              <span>
                                                {copiedKind ===
                                                providerKey(
                                                  connectFlow.connectionId,
                                                  connectFlow.providerId,
                                                )
                                                  ? "Copied"
                                                  : "Copy Command"}
                                              </span>
                                            </button>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm"
                                              onClick={() => {
                                                setConnectFlow(null);
                                                onCheckAuth(connectFlow.connectionId);
                                              }}
                                            >
                                              <RefreshCw size={12} />
                                              <span>Check Again</span>
                                            </button>
                                          </div>
                                        </>
                                      );
                                    }
                                    if (selectedMethod.type === "api") {
                                      // API-key methods MUST NOT call
                                      // /oauth/authorize: authentication is
                                      // managed by OpenCode; Tenvyr never
                                      // collects raw provider keys.
                                      return (
                                        <>
                                          <div
                                            style={{
                                              fontSize: "0.72rem",
                                              color: "var(--text-secondary)",
                                            }}
                                          >
                                            API Key — authentication is managed by OpenCode.
                                            Run the official command in your terminal (Tenvyr
                                            never receives raw keys):
                                          </div>
                                          <code
                                            style={{
                                              fontFamily: "var(--font-mono)",
                                              fontSize: "0.75rem",
                                              padding: "0.3rem 0.5rem",
                                              backgroundColor: "var(--bg-surface)",
                                              borderRadius: "var(--radius-sm)",
                                              overflowWrap: "anywhere",
                                            }}
                                          >
                                            {loginCommand}
                                          </code>
                                          <div style={{ display: "flex", gap: "0.5rem" }}>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm"
                                              onClick={() =>
                                                onCopyLogin(
                                                  loginCommand,
                                                  providerKey(
                                                    connectFlow.connectionId,
                                                    connectFlow.providerId,
                                                  ),
                                                )
                                              }
                                            >
                                              <Copy size={12} />
                                              <span>
                                                {copiedKind ===
                                                providerKey(
                                                  connectFlow.connectionId,
                                                  connectFlow.providerId,
                                                )
                                                  ? "Copied"
                                                  : "Copy Command"}
                                              </span>
                                            </button>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm"
                                              onClick={() => {
                                                setConnectFlow(null);
                                                onCheckAuth(connectFlow.connectionId);
                                              }}
                                            >
                                              <RefreshCw size={12} />
                                              <span>Check Again</span>
                                            </button>
                                          </div>
                                        </>
                                      );
                                    }
                                    // type === "oauth" without prompts
                                    return (
                                      <button
                                        type="button"
                                        className="btn btn-primary btn-sm"
                                        onClick={() =>
                                          handleOauthBegin(
                                            connectFlow.connectionId,
                                            connectFlow.providerId,
                                          )
                                        }
                                      >
                                        Start Authorization
                                      </button>
                                    );
                                  })()}
                                </>
                              )}

                              {!connectFlow.loading &&
                                connectFlow.step === "begin" &&
                                connectFlow.url && (
                                  <>
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                                      {connectFlow.instructions ||
                                        "Complete authorization in the provider&apos;s own window, then come back."}
                                    </div>
                                    <a
                                      href={connectFlow.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="btn btn-secondary btn-sm"
                                      style={{ overflowWrap: "anywhere" }}
                                    >
                                      <ExternalLink size={12} />
                                      <span>Open authorization page</span>
                                    </a>
                                    {connectFlow.method === "auto" && (
                                      <button
                                        type="button"
                                        className="btn btn-primary btn-sm"
                                        onClick={handleOauthComplete}
                                      >
                                        I&apos;ve completed authorization
                                      </button>
                                    )}
                                    {connectFlow.method === "code" && (
                                      <>
                                        <input
                                          type="text"
                                          value={connectFlow.codeInput}
                                          onChange={(e) =>
                                            setConnectFlow((current) =>
                                              current
                                                ? { ...current, codeInput: e.target.value }
                                                : current,
                                            )
                                          }
                                          className="form-input"
                                          placeholder="Authorization code"
                                          style={{
                                            padding: "0.3rem 0.5rem",
                                            fontSize: "0.8rem",
                                            fontFamily: "var(--font-mono)",
                                          }}
                                        />
                                        <button
                                          type="button"
                                          className="btn btn-primary btn-sm"
                                          disabled={!connectFlow.codeInput.trim()}
                                          onClick={handleOauthComplete}
                                        >
                                          Submit Code
                                        </button>
                                      </>
                                    )}
                                  </>
                                )}
                              {!connectFlow.loading &&
                                connectFlow.step === "completed" && (
                                  <div style={{ fontSize: "0.75rem", color: "var(--accent-green)" }}>
                                    Flow completed — check the provider row above for the
                                    refreshed connection state.
                                  </div>
                                )}
                              {!connectFlow.loading &&
                                connectFlow.step === "begin" && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={handleOauthCancel}
                                  >
                                    Cancel
                                  </button>
                                )}

                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                  if (connectFlow?.authFlowId) {
                                    // Never silently abandon a live flow:
                                    // backend cancel first (closes the
                                    // management session), then dismiss.
                                    handleOauthCancel();
                                  } else {
                                    setConnectFlow(null);
                                  }
                                }}
                              >
                                {connectFlow?.authFlowId ? "Cancel Flow" : "Close"}
                              </button>
                            </div>
  );
}
