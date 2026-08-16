"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, AlertTriangle } from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import type {
  ModelCatalogEntryV1,
  RuntimeProviderV1,
  RuntimeTargetV1,
  WorkbenchConnectionCardV1,
} from "../../lib/tenvyr-api/types.ts";

/**
 * P2 closure: reusable Runtime Target picker — Runtime -> Provider -> Model.
 *
 * The options come ONLY from providers authenticated/available THROUGH the
 * selected runtime (runtime-owned provider discovery): OpenCode `auth list`
 * + `models`, Codex best-effort catalog, Claude manual entry. A provider's
 * models are never offered for an incompatible runtime — incompatibility is
 * impossible by construction because the catalog is scoped to the runtime.
 * "Runtime default" means no model argument is composed. A refresh NEVER
 * silently changes the current selection.
 */

export type RuntimeTargetPickerProps = {
  connections: WorkbenchConnectionCardV1[];
  value: RuntimeTargetV1 | null;
  onChange: (target: RuntimeTargetV1 | null) => void;
  disabled?: boolean;
  placeholder?: string;
};

const MODEL_LIMIT = 4000;

export function RuntimeTargetPicker({
  connections,
  value,
  onChange,
  disabled = false,
  placeholder = "Select runtime…",
}: RuntimeTargetPickerProps) {
  const [providers, setProviders] = useState<RuntimeProviderV1[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntryV1[] | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogAt, setCatalogAt] = useState<string | null>(null);
  const [catalogTruncated, setCatalogTruncated] = useState(false);
  const [search, setSearch] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualModel, setManualModel] = useState("");
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const selectedConnection = useMemo(
    () => connections.find((c) => c.connectionId === value?.connectionId) ?? null,
    [connections, value],
  );

  const runtimeKind = selectedConnection?.runtimeKind ?? "";
  // Runtime-owned provider discovery exists for OpenCode (first-class) and
  // Codex (experimental best-effort). Claude/generic: manual entry only.
  const discoverable = runtimeKind === "opencode" || runtimeKind === "codex";

  const loadCatalog = useCallback(
    async (connection: WorkbenchConnectionCardV1) => {
      setLoading(true);
      setCatalogError(null);
      try {
        const res = await tenvyrApi.discoverRuntimeCatalog(connection.runtimeKind);
        if (!res.success) {
          setCatalogError(res.error || "Provider discovery failed");
          setCatalog(null);
          setProviders([]);
          return;
        }
        setProviders(res.data?.providers ?? []);
        setCatalog(res.data?.catalog?.models ?? []);
        setCatalogAt(res.data?.catalog?.discoveredAt ?? null);
        setCatalogTruncated(res.data?.catalog?.truncated === true);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setCatalogError(message || "Provider discovery failed");
        setCatalog(null);
        setProviders([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setSearch("");
    setManualMode(false);
    setSelectedProvider(null);
    if (selectedConnection && discoverable) {
      loadCatalog(selectedConnection);
    } else {
      setCatalog(null);
      setProviders([]);
      setCatalogAt(null);
      setCatalogTruncated(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.connectionId, selectedConnection?.connectionId]);

  /** Models scoped to the selected provider (or all when the runtime does
   *  not expose multiple providers). Never mixes providers. */
  const scopedModels = useMemo(() => {
    if (!catalog) return [];
    if (selectedProvider) {
      return catalog.filter((entry) => entry.providerId === selectedProvider);
    }
    return catalog;
  }, [catalog, selectedProvider]);

  const models = useMemo(() => {
    if (!scopedModels) return [];
    const needle = search.trim().toLowerCase();
    const list = needle
      ? scopedModels.filter(
          (entry) =>
            entry.modelId.toLowerCase().includes(needle) ||
            (entry.providerId ?? "").toLowerCase().includes(needle),
        )
      : scopedModels;
    return list.slice(0, MODEL_LIMIT);
  }, [scopedModels, search]);

  const modelOptions = useMemo(() => {
    const groups = new Map<string, ModelCatalogEntryV1[]>();
    for (const entry of models) {
      const group = entry.providerId ?? "Other";
      const bucket = groups.get(group) ?? [];
      bucket.push(entry);
      groups.set(group, bucket);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  const handleConnectionChange = (connectionId: string) => {
    const connection = connections.find((c) => c.connectionId === connectionId);
    if (!connection) {
      onChange(null);
      return;
    }
    // Keep the previous model ONLY when it still belongs to the same
    // connection (never silently pick a different model).
    const keepModel =
      value?.connectionId === connectionId ? value.modelId : undefined;
    onChange({ connectionId, ...(keepModel ? { modelId: keepModel } : {}) });
  };

  const selectModel = (modelId: string | undefined) => {
    if (!selectedConnection) return;
    onChange({
      connectionId: selectedConnection.connectionId,
      ...(modelId ? { modelId } : {}),
    });
  };

  const currentModelId = value?.modelId;
  const catalogHasCurrent =
    currentModelId === undefined ||
    catalog?.some((entry) => entry.modelId === currentModelId) ||
    manualMode;

  const stale =
    catalogAt !== null &&
    Date.now() - Date.parse(catalogAt) > 5 * 60 * 1000 &&
    catalog !== null &&
    catalog.length > 0;

  // Provider label for runtimes with ONE implied provider (Codex -> OpenAI,
  // Claude -> Anthropic) — shown when it adds information.
  const impliedProvider =
    runtimeKind === "codex"
      ? "OpenAI"
      : runtimeKind === "claude"
        ? "Anthropic"
        : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {/* Runtime select */}
      <select
        value={value?.connectionId ?? ""}
        onChange={(e) => handleConnectionChange(e.target.value)}
        disabled={disabled}
        className="form-select"
        aria-label="Runtime"
      >
        <option value="">{placeholder}</option>
        {connections.map((c) => (
          <option key={c.connectionId} value={c.connectionId}>
            {c.name} ({c.runtimeKind})
          </option>
        ))}
      </select>

      {selectedConnection ? (
        <>
          {/* Provider select — only when the runtime exposes providers */}
          {providers.length > 0 ? (
            <select
              value={selectedProvider ?? ""}
              onChange={(e) => setSelectedProvider(e.target.value || null)}
              disabled={disabled}
              className="form-select"
              aria-label="Provider"
            >
              <option value="">Provider: all / any</option>
              {providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {provider.providerId}
                  {provider.authenticated ? "" : " (not connected)"}
                </option>
              ))}
            </select>
          ) : impliedProvider ? (
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Provider: <span style={{ fontWeight: 600 }}>{impliedProvider}</span>
            </div>
          ) : null}

          {/* Model select */}
          {discoverable ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <Search size={12} style={{ color: "var(--text-muted)" }} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="form-input"
                  placeholder="Search models…"
                  style={{ flex: 1, padding: "0.3rem 0.5rem", fontSize: "0.8rem" }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => selectedConnection && loadCatalog(selectedConnection)}
                  disabled={loading || disabled}
                  title="Refresh model catalog"
                >
                  <RefreshCw size={12} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
                  <span>Refresh</span>
                </button>
              </div>

              {stale && !loading && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.72rem", color: "var(--accent-amber)" }}>
                  <AlertTriangle size={11} />
                  <span>Stale catalog (fetched {new Date(catalogAt!).toLocaleTimeString()}) — refresh for the latest models.</span>
                </div>
              )}
              {catalogError && (
                <div style={{ fontSize: "0.72rem", color: "var(--accent-red)" }}>{catalogError}</div>
              )}

              {loading ? (
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Loading providers & models…</div>
              ) : catalog && catalog.length > 0 ? (
                <>
                  <select
                    value={currentModelId ?? "__default__"}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "__default__") selectModel(undefined);
                      else if (val === "__manual__") setManualMode(true);
                      else selectModel(val);
                    }}
                    disabled={disabled}
                    className="form-select"
                    aria-label="Model"
                  >
                    <option value="__default__">Runtime default</option>
                    {modelOptions.map(([group, entries]: [string, ModelCatalogEntryV1[]]) => (
                      <optgroup key={group} label={group}>
                        {entries.map((entry) => (
                          <option key={entry.modelId} value={entry.modelId}>
                            {entry.modelId}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    <option value="__manual__">+ Enter model ID manually…</option>
                  </select>
                  {catalogTruncated && (
                    <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                      Catalog truncated at the model-count bound.
                    </div>
                  )}
                </>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    {providers.length > 0
                      ? `Authenticated providers: ${providers.filter((p) => p.authenticated).map((p) => p.providerId).join(", ") || "none"}`
                      : "No model catalog available (runtime-owned discovery returned nothing)."}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setManualMode(true)}
                    disabled={disabled}
                  >
                    Enter model ID manually
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <select
                value={currentModelId ?? "__default__"}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "__default__") selectModel(undefined);
                  else if (val === "__manual__") setManualMode(true);
                  else selectModel(val);
                }}
                disabled={disabled}
                className="form-select"
                aria-label="Model"
              >
                <option value="__default__">Runtime default</option>
                <option value="__manual__">+ Enter model ID manually…</option>
              </select>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                No dynamic discovery for this runtime — enter an official model ID manually.
              </div>
            </div>
          )}

          {manualMode && (
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input
                type="text"
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
                className="form-input"
                placeholder="e.g. claude-sonnet-5"
                style={{ flex: 1, padding: "0.3rem 0.5rem", fontSize: "0.8rem", fontFamily: "var(--font-mono)" }}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!manualModel.trim() || disabled}
                onClick={() => {
                  selectModel(manualModel.trim());
                  setManualMode(false);
                }}
              >
                Use
              </button>
            </div>
          )}

          {currentModelId !== undefined && !catalogHasCurrent && (
            <div style={{ fontSize: "0.72rem", color: "var(--accent-amber)" }}>
              Current model &quot;{currentModelId}&quot; is not in the catalog — the frozen
              selection is preserved until you change it (refresh never rewrites it).
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
