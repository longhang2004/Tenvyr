"use client";

import React, { useEffect, useState } from "react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import type {
  ConnectionTemplateV1,
  WorkbenchConnectionCardV1,
} from "../../lib/tenvyr-api/types.ts";
import { DirectoryInput } from "../../components/shared/DirectoryInput.tsx";

export function AdvancedConnectionForm({
  show,
  editingCard,
  templates,
  onNotice,
  onSaved,
  onCancel,
}: {
  show: boolean;
  editingCard: WorkbenchConnectionCardV1 | null;
  templates: ConnectionTemplateV1[];
  onNotice: (
    notice: {
      type: "success" | "error" | "info" | "warning";
      message: string;
    } | null,
  ) => void;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [editingConnId, setEditingConnId] = useState<string | null>(null);
  const [advConnectionId, setAdvConnectionId] = useState<string>("conn:custom");
  const [advName, setAdvName] = useState<string>("Custom CLI");
  const [advKind, setAdvKind] = useState<string>("generic-cli");
  const [advCommand, setAdvCommand] = useState<string>("");
  const [advArgs, setAdvArgs] = useState<string>("");
  const [advCwd, setAdvCwd] = useState<string>("");
  const [advSecrets, setAdvSecrets] = useState<string>("");
  const [advProbeArgs, setAdvProbeArgs] = useState<string>("--version");
  const [savingAdv, setSavingAdv] = useState<boolean>(false);

  useEffect(() => {
    if (!show) return;
    if (editingCard) {
      setEditingConnId(editingCard.connectionId);
      setAdvConnectionId(editingCard.connectionId);
      setAdvName(editingCard.name);
      setAdvKind(editingCard.runtimeKind);
      setAdvCommand("");
    } else {
      setEditingConnId(null);
      setAdvConnectionId("conn:custom");
      setAdvName("Custom CLI");
      setAdvKind("generic-cli");
      setAdvCommand("");
    }
  }, [show, editingCard]);

  const handleSaveAdvanced = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAdv(true);
    onNotice(null);

    const splitList = (val: string) =>
      val
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

    try {
      let profile: Record<string, unknown>;
      if (advKind === "generic-cli") {
        const secrets = splitList(advSecrets);
        profile = {
          name: advName.trim(),
          executorId: "local-host",
          runtimeKind: "generic-cli",
          version: "0.1.0",
          credentialRefs: secrets.map((name) => ({ kind: "env", name })),
          declaredCapabilities: {
            invocation: { supported: true, source: "configured" },
            structuredResult: { supported: true, source: "configured" },
            localProcessTermination: { supported: true, source: "configured" },
          },
          cli: {
            command: advCommand.trim(),
            args: splitList(advArgs),
            ...(advCwd.trim() ? { cwd: advCwd.trim() } : {}),
            ...(secrets.length
              ? { secrets: Object.fromEntries(secrets.map((n) => [n, n])) }
              : {}),
            probe: { args: splitList(advProbeArgs), expectsVersion: true },
          },
        };
      } else {
        const template = templates.find((t) => t.runtimeKind === advKind);
        if (!template) throw new Error(`Unknown runtime template "${advKind}"`);
        profile = {
          name: advName.trim(),
          executorId: "local-host",
          runtimeKind: advKind,
          version: template.pinnedVersion,
          credentialRefs: template.credentialEnvRefs.map((name) => ({
            kind: "env",
            name,
          })),
          declaredCapabilities: template.declaredCapabilities,
          cli: {
            command: advCommand.trim(),
            args: template.runArgs,
            probe: template.probe,
            ...(template.authProbe ? { authProbe: template.authProbe } : {}),
          },
        };
      }

      if (editingConnId) {
        await tenvyrApi.reviseConnection(editingConnId, profile);
        onNotice({
          type: "success",
          message: `Connection "${editingConnId}" revision saved.`,
        });
      } else {
        await tenvyrApi.createConnection(advConnectionId.trim(), profile);
        onNotice({
          type: "success",
          message: `Connection "${advConnectionId}" created.`,
        });
      }

      setEditingConnId(null);
      await onSaved();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      onNotice({
        type: "error",
        message: message || "Failed to save connection",
      });
    } finally {
      setSavingAdv(false);
    }
  };

  if (!show) return null;

  return (
                <form
                  onSubmit={handleSaveAdvanced}
                  style={{
                    backgroundColor: "var(--bg-surface)",
                    padding: "1.25rem",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-color)",
                    marginBottom: "1.5rem",
                    display: "flex",
                    flexDirection: "column",
                    gap: "1rem",
                  }}
                >
                  <h3 style={{ fontSize: "0.9rem", fontWeight: 700 }}>
                    {editingConnId
                      ? `Revise Connection: ${editingConnId}`
                      : "Create Custom Connection"}
                  </h3>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "1rem",
                    }}
                  >
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Connection ID</label>
                      <input
                        type="text"
                        value={advConnectionId}
                        onChange={(e) => setAdvConnectionId(e.target.value)}
                        disabled={Boolean(editingConnId)}
                        required
                        className="form-input"
                        placeholder="conn:custom"
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Display Name</label>
                      <input
                        type="text"
                        value={advName}
                        onChange={(e) => setAdvName(e.target.value)}
                        required
                        className="form-input"
                        placeholder="Custom CLI Runtime"
                      />
                    </div>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "1rem",
                    }}
                  >
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Runtime Kind</label>
                      <select
                        value={advKind}
                        onChange={(e) => setAdvKind(e.target.value)}
                        className="form-select"
                      >
                        <option value="generic-cli">Generic CLI</option>
                        <option value="codex">Codex CLI Template</option>
                        <option value="claude">Claude Code Template</option>
                        <option value="opencode">OpenCode Template</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">
                        Executable Absolute Path
                      </label>
                      <input
                        type="text"
                        value={advCommand}
                        onChange={(e) => setAdvCommand(e.target.value)}
                        required
                        className="form-input"
                        placeholder="/usr/local/bin/codex"
                      />
                    </div>
                  </div>

                  {advKind === "generic-cli" && (
                    <>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: "1rem",
                        }}
                      >
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label className="form-label">
                            Arguments (comma separated)
                          </label>
                          <input
                            type="text"
                            value={advArgs}
                            onChange={(e) => setAdvArgs(e.target.value)}
                            className="form-input"
                            placeholder="exec, --json"
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label className="form-label">
                            Working Directory (optional)
                          </label>
                          <DirectoryInput
                            value={advCwd}
                            onChange={setAdvCwd}
                            placeholder="/srv/work"
                          />
                        </div>
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
                            Secret Environment Variable Names (names only)
                          </label>
                          <input
                            type="text"
                            value={advSecrets}
                            onChange={(e) => setAdvSecrets(e.target.value)}
                            className="form-input"
                            placeholder="OPENAI_API_KEY, ANTHROPIC_API_KEY"
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label className="form-label">Probe Arguments</label>
                          <input
                            type="text"
                            value={advProbeArgs}
                            onChange={(e) => setAdvProbeArgs(e.target.value)}
                            className="form-input"
                            placeholder="--version"
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      type="button"
                      onClick={onCancel}
                      className="btn btn-secondary btn-sm"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={savingAdv}
                      className="btn btn-primary btn-sm"
                    >
                      {savingAdv
                        ? "Saving…"
                        : editingConnId
                          ? "Save Revision"
                          : "Create Connection"}
                    </button>
                  </div>
                </form>
  );
}
