"use client";

import React, { useState, useEffect } from "react";
import { io } from "socket.io-client";
import {
  Play,
  Layers,
  Cpu,
  Activity,
  Plus,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  HelpCircle,
  AlertTriangle,
  Terminal,
  Database
} from "lucide-react";

const GATEWAY_API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
const GATEWAY_WS_URL = process.env.NEXT_PUBLIC_WS_URL || GATEWAY_API_URL;

export default function Dashboard() {
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [executions, setExecutions] = useState<any[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [selectedExecution, setSelectedExecution] = useState<any | null>(null);
  const [yamlInput, setYamlInput] = useState<string>(`name: code-review-pipeline
version: "1.0"
description: "Reviews code and checks for runtime anomalies"
steps:
  - id: review
    agent: code-reviewer
    input:
      code: "{{ pipeline.input.code }}"
      language: "{{ pipeline.input.language }}"
    timeout: 30s
    retries: 3
    onFailure: retry
  - id: observe
    agent: observability
    dependsOn: [review]
    condition: "{{ steps.review.result.score < 90 }}"
    input:
      findings: "{{ steps.review.result.findings }}"
      logs: "{{ pipeline.input.logs }}"`);

  const [pipelineInput, setPipelineInput] = useState<string>(`{
  "code": "const query = 'SELECT * FROM users WHERE id = ' + userId;\\nconsole.log(query);",
  "language": "javascript",
  "logs": "2026-05-30T16:00:00Z ERROR Database connection timeout on port 5432"
}`);

  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [successMsg, setSuccessMsg] = useState<string>("");

  // Fetch initial pipelines and executions
  const refreshData = async () => {
    try {
      const pipesRes = await fetch(`${GATEWAY_API_URL}/api/pipelines`);
      const pipesData = await pipesRes.json();
      if (pipesData.success) {
        setPipelines(pipesData.data);
        if (pipesData.data.length > 0) {
          setSelectedPipelineId((current) => current || pipesData.data[0].id);
        }
      }

      const execsRes = await fetch(`${GATEWAY_API_URL}/api/executions`);
      const execsData = await execsRes.json();
      if (execsData.success) {
        setExecutions(execsData.data);
      }
    } catch (err: any) {
      console.error("Failed to load initial data:", err.message);
    }
  };

  useEffect(() => {
    refreshData();

    // Setup WebSocket connection
    const socketConnection = io(GATEWAY_WS_URL);

    socketConnection.on("connect", () => {
      console.log("Websocket connected to Gateway: " + socketConnection.id);
    });

    socketConnection.on("execution-update", (event: any) => {
      console.log("WebSocket event execution-update:", event);
      // Reload executions list
      refreshData();
      
      // Update currently viewed execution if matches
      setSelectedExecution((current: any) => {
        if (current && current.id === event.executionId) {
          return event.data;
        }
        return current;
      });
    });

    return () => {
      socketConnection.disconnect();
    };
  }, []);

  // Poll selected execution if running to handle websocket fallback
  useEffect(() => {
    if (!selectedExecution || (selectedExecution.status !== "RUNNING" && selectedExecution.status !== "PENDING")) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${GATEWAY_API_URL}/api/executions/${selectedExecution.id}`);
        const data = await res.json();
        if (data.success) {
          setSelectedExecution(data.data);
        }
      } catch (err) {
        console.error("Failed to poll execution:", err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [selectedExecution]);

  const handleCreatePipeline = async () => {
    setLoading(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      const res = await fetch(`${GATEWAY_API_URL}/api/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yamlString: yamlInput }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccessMsg("Pipeline registered successfully!");
        refreshData();
      } else {
        setErrorMsg(data.error || "Failed to register pipeline.");
      }
    } catch (err: any) {
      setErrorMsg("Error registering pipeline: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleStartExecution = async () => {
    if (!selectedPipelineId) {
      setErrorMsg("Select a pipeline first.");
      return;
    }

    setLoading(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(pipelineInput);
      } catch (err) {
        setErrorMsg("Invalid JSON input parameters.");
        setLoading(false);
        return;
      }

      const res = await fetch(`${GATEWAY_API_URL}/api/executions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId: selectedPipelineId,
          input: parsedInput,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setSuccessMsg("Pipeline execution triggered!");
        setSelectedExecution(data.data);
        refreshData();
      } else {
        setErrorMsg(data.error || "Failed to start execution.");
      }
    } catch (err: any) {
      setErrorMsg("Error starting execution: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectExecution = async (id: string) => {
    try {
      const res = await fetch(`${GATEWAY_API_URL}/api/executions/${id}`);
      const data = await res.json();
      if (data.success) {
        setSelectedExecution(data.data);
      }
    } catch (err) {
      console.error("Failed to load execution details:", err);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "COMPLETED":
        return <CheckCircle2 size={18} color="var(--accent-green)" />;
      case "FAILED":
        return <XCircle size={18} color="var(--accent-red)" />;
      case "RUNNING":
        return <Activity size={18} color="var(--accent-blue)" className="pulse-spin" />;
      case "SKIPPED":
        return <AlertTriangle size={18} color="var(--text-secondary)" />;
      case "PENDING":
        return <Clock size={18} color="var(--accent-orange)" />;
      default:
        return <HelpCircle size={18} color="var(--text-secondary)" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "COMPLETED":
        return "rgba(16, 185, 129, 0.1)";
      case "FAILED":
        return "rgba(239, 68, 68, 0.1)";
      case "RUNNING":
        return "rgba(59, 130, 246, 0.1)";
      case "SKIPPED":
        return "rgba(255, 255, 255, 0.05)";
      default:
        return "transparent";
    }
  };

  const getStatusBorderColor = (status: string) => {
    switch (status) {
      case "COMPLETED":
        return "rgba(16, 185, 129, 0.3)";
      case "FAILED":
        return "rgba(239, 68, 68, 0.3)";
      case "RUNNING":
        return "rgba(59, 130, 246, 0.4)";
      case "SKIPPED":
        return "rgba(255, 255, 255, 0.1)";
      default:
        return "var(--border-color)";
    }
  };

  return (
    <div className="container" style={{ padding: "2rem", minHeight: "100vh", display: "flex", flexDirection: "column", gap: "2rem" }}>
      {/* Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color)", paddingBottom: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <div style={{
            background: "linear-gradient(135deg, var(--accent-blue) 0%, var(--accent-purple) 100%)",
            padding: "0.5rem",
            borderRadius: "8px",
            display: "flex",
            alignItems: "center"
          }}>
            <Cpu size={20} color="#fff" />
          </div>
          <span style={{ fontWeight: 800, fontSize: "1.25rem" }}>AgentWeave Control Center</span>
        </div>
        <button onClick={refreshData} className="btn btn-secondary" style={{ gap: "0.5rem" }}>
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      {/* Main Grid */}
      <div className="dashboard-grid">
        
        {/* Left Side: Pipeline Creator & Config */}
        <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
          
          {/* Create Pipeline Section */}
          <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Layers size={18} color="var(--accent-purple)" /> Register New Pipeline
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Define DAG workflow in YAML format:</p>
            <textarea
              value={yamlInput}
              onChange={(e) => setYamlInput(e.target.value)}
              style={{
                width: "100%",
                height: "220px",
                background: "rgba(0, 0, 0, 0.3)",
                border: "1px solid var(--border-color)",
                borderRadius: "8px",
                padding: "0.75rem",
                color: "var(--text-primary)",
                fontFamily: "var(--font-code)",
                fontSize: "0.8rem",
                resize: "vertical"
              }}
            />
            <button
              onClick={handleCreatePipeline}
              disabled={loading}
              className="btn btn-primary"
              style={{ width: "100%", gap: "0.5rem" }}
            >
              <Plus size={16} /> Register Pipeline
            </button>
          </div>

          {/* Trigger Run Section */}
          <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Play size={18} color="var(--accent-green)" /> Trigger Execution
            </h3>
            
            <label style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem" }}>
              Select Active Pipeline:
              <select
                value={selectedPipelineId}
                onChange={(e) => setSelectedPipelineId(e.target.value)}
                style={{
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  padding: "0.5rem",
                  color: "var(--text-primary)"
                }}
              >
                <option value="">-- Choose Pipeline --</option>
                {pipelines.map((pipe) => (
                  <option key={pipe.id} value={pipe.id}>
                    {pipe.name} (v{pipe.version})
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem" }}>
              Input Context Parameters (JSON):
              <textarea
                value={pipelineInput}
                onChange={(e) => setPipelineInput(e.target.value)}
                style={{
                  width: "100%",
                  height: "120px",
                  background: "rgba(0, 0, 0, 0.3)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  padding: "0.75rem",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-code)",
                  fontSize: "0.8rem",
                  resize: "vertical"
                }}
              />
            </label>

            <button
              onClick={handleStartExecution}
              disabled={loading || !selectedPipelineId}
              className="btn btn-primary"
              style={{ width: "100%", gap: "0.5rem" }}
            >
              <Play size={16} /> Run Pipeline
            </button>
          </div>

          {/* Feedback Messages */}
          {errorMsg && (
            <div style={{ background: "rgba(239, 68, 68, 0.15)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "#f87171", padding: "0.75rem 1rem", borderRadius: "8px", fontSize: "0.85rem" }}>
              {errorMsg}
            </div>
          )}
          {successMsg && (
            <div style={{ background: "rgba(16, 185, 129, 0.15)", border: "1px solid rgba(16, 185, 129, 0.3)", color: "#34d399", padding: "0.75rem 1rem", borderRadius: "8px", fontSize: "0.85rem" }}>
              {successMsg}
            </div>
          )}
        </div>

        {/* Right Side: Visual Graph Monitor & Executions List */}
        <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
          
          {/* Active Visual Graph Monitor */}
          <div className="glass-card" style={{ minHeight: "350px", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.75rem" }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Activity size={18} color="var(--accent-blue)" /> Live DAG Execution Monitor
              </h3>
              {selectedExecution && (
                <span style={{ fontSize: "0.75rem", background: "rgba(255,255,255,0.05)", padding: "0.25rem 0.5rem", borderRadius: "4px", color: "var(--text-secondary)" }}>
                  ID: {selectedExecution.id.substring(0, 8)}...
                </span>
              )}
            </div>

            {selectedExecution ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "2rem", flex: 1 }}>
                
                {/* Overall Execution Info Header */}
                <div style={{ display: "flex", gap: "2rem", background: "rgba(255, 255, 255, 0.01)", padding: "0.75rem", borderRadius: "8px", border: "1px solid var(--border-color)", fontSize: "0.85rem" }}>
                  <div>Status: <span style={{ fontWeight: "bold" }}>{selectedExecution.status}</span></div>
                  <div>Started: <span style={{ color: "var(--text-secondary)" }}>{new Date(selectedExecution.startTime).toLocaleTimeString()}</span></div>
                  {selectedExecution.endTime && (
                    <div>Completed: <span style={{ color: "var(--text-secondary)" }}>{new Date(selectedExecution.endTime).toLocaleTimeString()}</span></div>
                  )}
                </div>

                {/* Nodes Grid (DAG Visualization) */}
                <div style={{ display: "flex", flexDirection: "column", gap: "1rem", position: "relative" }}>
                  {selectedExecution.steps && selectedExecution.steps.length > 0 ? (
                    selectedExecution.steps.map((step: any, index: number) => (
                      <React.Fragment key={step.id}>
                        {index > 0 && (
                          <div style={{
                            width: "2px",
                            height: "20px",
                            backgroundColor: step.status === "RUNNING" ? "var(--accent-blue)" : "var(--border-color)",
                            marginLeft: "2rem",
                            marginTop: "-0.5rem",
                            marginBottom: "-0.5rem",
                            animation: step.status === "RUNNING" ? "connectorPulse 1.5s infinite" : "none"
                          }} />
                        )}

                        <div style={{
                          display: "flex",
                          flexDirection: "column",
                          background: getStatusColor(step.status),
                          border: `1px solid ${getStatusBorderColor(step.status)}`,
                          borderRadius: "12px",
                          padding: "1rem",
                          transition: "all 0.3s ease"
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                              {getStatusIcon(step.status)}
                              <span style={{ fontWeight: 700, fontSize: "0.9rem" }}>{step.stepId}</span>
                              <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>({step.agent})</span>
                            </div>
                            {step.endTime && step.startTime && (
                              <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                                {Math.round(new Date(step.endTime).getTime() - new Date(step.startTime).getTime())}ms
                              </span>
                            )}
                          </div>

                          {/* Expanded Step Info */}
                          {step.input && (
                            <div style={{ marginTop: "0.75rem", padding: "0.5rem", background: "rgba(0,0,0,0.2)", borderRadius: "6px", fontSize: "0.75rem", fontFamily: "var(--font-code)" }}>
                              <div style={{ color: "var(--accent-blue)", fontWeight: "bold", marginBottom: "0.25rem" }}>[Input Context]</div>
                              <div>{JSON.stringify(step.input)}</div>
                            </div>
                          )}

                          {step.output && (
                            <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "rgba(0,0,0,0.2)", borderRadius: "6px", fontSize: "0.75rem", fontFamily: "var(--font-code)" }}>
                              <div style={{ color: "var(--accent-green)", fontWeight: "bold", marginBottom: "0.25rem" }}>[Agent Output]</div>
                              <div>{JSON.stringify(step.output)}</div>
                            </div>
                          )}

                          {step.error && (
                            <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: "6px", fontSize: "0.75rem", fontFamily: "var(--font-code)", color: "#f87171" }}>
                              <div style={{ fontWeight: "bold", marginBottom: "0.25rem" }}>[Error Trace]</div>
                              <div>{step.error}</div>
                            </div>
                          )}
                        </div>
                      </React.Fragment>
                    ))
                  ) : (
                    <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", textAlign: "center", padding: "2rem" }}>
                      Pipeline starting, building nodes...
                    </div>
                  )}
                </div>

              </div>
            ) : (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", color: "var(--text-secondary)", border: "1px dashed var(--border-color)", borderRadius: "12px" }}>
                <Terminal size={32} />
                <span style={{ fontSize: "0.9rem" }}>No active run selected. Choose a run from history or start a new run.</span>
              </div>
            )}
          </div>

          {/* Execution History */}
          <div className="glass-card" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 700, display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Database size={18} color="var(--accent-blue)" /> Execution Run History
            </h3>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxHeight: "300px", overflowY: "auto" }}>
              {executions.length === 0 ? (
                <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem", textAlign: "center", padding: "1.5rem" }}>
                  No execution runs found.
                </div>
              ) : (
                executions.map((exec) => (
                  <div
                    key={exec.id}
                    onClick={() => handleSelectExecution(exec.id)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "0.75rem 1rem",
                      background: selectedExecution && selectedExecution.id === exec.id ? "rgba(255, 255, 255, 0.05)" : "rgba(255, 255, 255, 0.01)",
                      border: `1px solid ${selectedExecution && selectedExecution.id === exec.id ? "var(--accent-blue)" : "var(--border-color)"}`,
                      borderRadius: "8px",
                      cursor: "pointer",
                      transition: "all 0.2s"
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                      <span style={{ fontSize: "0.85rem", fontWeight: "bold" }}>
                        Run {exec.id.substring(0, 8)}
                      </span>
                      <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                        {new Date(exec.startTime).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>{exec.status}</span>
                      {getStatusIcon(exec.status)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>

      </div>

      {/* Inline styles */}
      <style>{`
        .pulse-spin {
          animation: spin 2s linear infinite, pulse 1s ease-in-out infinite alternate;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0% { opacity: 0.6; }
          100% { opacity: 1; }
        }
        .dashboard-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
          gap: 2rem;
        }
        @media (max-width: 980px) {
          .dashboard-grid {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 680px) {
          .container {
            padding: 1rem !important;
          }
          .glass-card {
            padding: 1rem;
          }
          header {
            align-items: flex-start !important;
            flex-direction: column;
            gap: 1rem;
          }
        }
        @keyframes connectorPulse {
          0% { opacity: 0.3; }
          50% { opacity: 1; background-color: var(--accent-blue); }
          100% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
