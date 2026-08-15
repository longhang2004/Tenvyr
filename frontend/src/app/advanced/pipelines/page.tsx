"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Play,
  Activity,
  Plus,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  FileCode,
  Info,
} from "lucide-react";
import { tenvyrApi } from "../../../lib/tenvyr-api/client.ts";
import type {
  Pipeline,
  LegacyExecution,
} from "../../../lib/tenvyr-api/types.ts";
import { StatusBadge } from "../../../components/shared/StatusBadge.tsx";
import { LoadingSpinner } from "../../../components/shared/LoadingSpinner.tsx";

const DEFAULT_YAML = `name: code-analysis-pipeline
version: "1.0"
description: "Deterministic code inspection pipeline compatible with standard local HTTP/CLI executors"
steps:
  - id: review
    agent: code-reviewer
    input:
      code: "{{ pipeline.input.code }}"
      language: "{{ pipeline.input.language }}"
    timeout: 30s
    retries: 2
    onFailure: retry
  - id: observe
    agent: observability
    dependsOn: [review]
    condition: "{{ steps.review.result.score < 90 }}"
    input:
      findings: "{{ steps.review.result.findings }}"
      logs: "{{ pipeline.input.logs }}"`;

const DEFAULT_JSON_INPUT = `{
  "code": "const query = 'SELECT * FROM users WHERE id = ' + userId;\\nconsole.log(query);",
  "language": "javascript",
  "logs": "2026-05-30T16:00:00Z WARN Potential SQL injection pattern detected"
}`;

export default function AdvancedPipelinesPage() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [executions, setExecutions] = useState<LegacyExecution[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [selectedExecution, setSelectedExecution] = useState<LegacyExecution | null>(null);

  const [yamlInput, setYamlInput] = useState<string>(DEFAULT_YAML);
  const [pipelineInput, setPipelineInput] = useState<string>(DEFAULT_JSON_INPUT);

  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [executing, setExecuting] = useState<boolean>(false);
  const [notice, setNotice] = useState<{ type: "success" | "error" | "info"; message: string } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [pipesRes, execsRes] = await Promise.allSettled([
        tenvyrApi.getPipelines(),
        tenvyrApi.getLegacyExecutions(),
      ]);

      if (pipesRes.status === "fulfilled" && pipesRes.value?.success) {
        const list = pipesRes.value.data ?? [];
        setPipelines(list);
        if (list.length > 0 && !selectedPipelineId) {
          setSelectedPipelineId(list[0].id);
        }
      }

      if (execsRes.status === "fulfilled" && execsRes.value?.success) {
        setExecutions(execsRes.value.data ?? []);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Failed to load pipelines" });
    } finally {
      setLoading(false);
    }
  }, [selectedPipelineId]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleRegisterPipeline = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setNotice(null);
    try {
      const res = await tenvyrApi.createPipeline({ yaml: yamlInput });
      if (res.success && res.data?.id) {
        setNotice({ type: "success", message: `Pipeline "${res.data.name}" registered successfully.` });
        setSelectedPipelineId(res.data.id);
        await loadData();
      } else {
        setNotice({ type: "error", message: res.error || "Failed to register pipeline" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Pipeline registration error" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleTriggerExecution = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPipelineId) return;

    setExecuting(true);
    setNotice(null);
    try {
      let parsedInput: unknown = {};
      if (pipelineInput.trim()) {
        parsedInput = JSON.parse(pipelineInput);
      }

      const res = await tenvyrApi.triggerLegacyExecution({
        pipelineId: selectedPipelineId,
        input: parsedInput,
      });

      if (res.success && res.data?.id) {
        setNotice({ type: "success", message: `Execution "${res.data.id.slice(0, 8)}" triggered.` });
        setSelectedExecution(res.data);
        await loadData();
      } else {
        setNotice({ type: "error", message: res.error || "Failed to trigger execution" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Execution trigger error" });
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>Advanced Pipelines</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Declarative YAML workflow DAG engine · Legacy execution control plane
          </p>
        </div>
        <button
          type="button"
          onClick={() => loadData()}
          className="btn btn-secondary btn-sm"
        >
          <RefreshCw size={14} />
          <span>Refresh</span>
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

      {/* Deployment Mode Transport Notice */}
      <div className="notice notice-info">
        <Info size={18} style={{ flexShrink: 0 }} />
          <strong>Transport Requirements:</strong> In HTTP-only deployments, pipelines dispatch directly to HTTP workers and Local Executor CLIs. Kafka-backed agent steps require active Kafka broker infrastructure.
      </div>

      {/* Grid: Register & Trigger */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
        {/* Register Pipeline */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <FileCode size={16} color="var(--accent-blue)" />
              <h2 className="card-title">Register Pipeline (YAML)</h2>
            </div>
          </div>
          <form onSubmit={handleRegisterPipeline} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Pipeline Definition</label>
              <textarea
                value={yamlInput}
                onChange={(e) => setYamlInput(e.target.value)}
                rows={12}
                className="form-textarea"
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}
                required
              />
            </div>
            <button type="submit" disabled={submitting} className="btn btn-primary btn-sm" style={{ alignSelf: "flex-end" }}>
              <Plus size={14} />
              <span>{submitting ? "Registering…" : "Register Pipeline"}</span>
            </button>
          </form>
        </div>

        {/* Trigger Execution */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Play size={16} color="var(--accent-green)" />
              <h2 className="card-title">Trigger Execution (JSON)</h2>
            </div>
          </div>
          <form onSubmit={handleTriggerExecution} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Select Registered Pipeline</label>
              <select
                value={selectedPipelineId}
                onChange={(e) => setSelectedPipelineId(e.target.value)}
                className="form-select"
                required
              >
                <option value="">— Select Pipeline —</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (v{p.version}) [{p.id}]
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Input Context (JSON payload)</label>
              <textarea
                value={pipelineInput}
                onChange={(e) => setPipelineInput(e.target.value)}
                rows={8}
                className="form-textarea"
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}
              />
            </div>

            <button
              type="submit"
              disabled={executing || !selectedPipelineId}
              className="btn btn-primary btn-sm"
              style={{ alignSelf: "flex-end" }}
            >
              <Play size={14} />
              <span>{executing ? "Triggering…" : "Run Pipeline"}</span>
            </button>
          </form>
        </div>
      </div>

      {/* Execution Monitor */}
      <div className="card">
        <div className="card-header">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Activity size={16} color="var(--accent-blue)" />
            <h2 className="card-title">Pipeline Execution History</h2>
          </div>
        </div>

        {loading ? (
          <LoadingSpinner text="Loading pipeline executions…" />
        ) : executions.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", padding: "1.5rem 0" }}>
            No pipeline executions triggered yet.
          </p>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Execution ID</th>
                  <th>Pipeline ID</th>
                  <th>Status</th>
                  <th>Started At</th>
                  <th>Step Count</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((ex) => (
                  <tr
                    key={ex.id}
                    onClick={() => setSelectedExecution(ex)}
                    style={{
                      cursor: "pointer",
                      backgroundColor: selectedExecution?.id === ex.id ? "rgba(59, 130, 246, 0.08)" : undefined,
                    }}
                  >
                    <td style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{ex.id.slice(0, 8)}</td>
                    <td style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
                      {ex.pipelineId}
                    </td>
                    <td>
                      <StatusBadge status={ex.status} />
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                      {new Date(ex.startTime).toLocaleTimeString()}
                    </td>
                    <td>{ex.steps?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Selected Execution Step DAG Details */}
      {selectedExecution && selectedExecution.steps && selectedExecution.steps.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              Execution DAG: {selectedExecution.id.slice(0, 8)} ({selectedExecution.status})
            </h3>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1rem" }}>
            {selectedExecution.steps.map((step) => (
              <div
                key={step.id}
                style={{
                  backgroundColor: "var(--bg-surface)",
                  padding: "0.75rem 1rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
                  <strong style={{ fontSize: "0.85rem" }}>{step.stepId}</strong>
                  <StatusBadge status={step.status} size={10} />
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Agent: {step.agent}</div>
                {step.error && (
                  <div style={{ fontSize: "0.75rem", color: "var(--accent-red)", marginTop: "0.3rem" }}>
                    Error: {step.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
