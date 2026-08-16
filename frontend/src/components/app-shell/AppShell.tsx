"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Cpu,
  FolderGit2,
  PlayCircle,
  ListOrdered,
  LayoutDashboard,
  BellRing,
  Layers,
  History,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";

export type AppShellProps = {
  children: React.ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const [gatewayStatus, setGatewayStatus] = useState<"checking" | "online" | "offline">("checking");
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState<number>(0);

  useEffect(() => {
    let mounted = true;

    const checkHealth = async () => {
      try {
        const health = await tenvyrApi.getHealth();
        if (mounted && health?.success) {
          setGatewayStatus("online");
        }
      } catch {
        if (mounted) {
          setGatewayStatus("offline");
        }
      }
    };

    const checkPendingApprovals = async () => {
      try {
        const execs = await tenvyrApi.getWorkbenchExecutions(1);
        if (mounted && execs?.items) {
          const waiting = execs.items.filter((item) => item.coordinationPhase === "WAITING_FOR_HUMAN");
          setPendingApprovalsCount(waiting.length);
        }
      } catch {
        // Ignore poll error
      }
    };

    checkHealth();
    checkPendingApprovals();

    const interval = setInterval(() => {
      checkHealth();
      checkPendingApprovals();
    }, 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const isActive = (href: string) => {
    if (href === "/dashboard" && (pathname === "/dashboard" || pathname === "/workbench" || pathname === "/")) {
      return true;
    }
    return pathname.startsWith(href) && href !== "/dashboard";
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar" aria-label="Main Navigation">
        <div className="sidebar-header">
          <Link href="/dashboard" className="sidebar-brand">
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "var(--radius-sm)",
                backgroundColor: "var(--accent-blue)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
              }}
            >
              <Cpu size={16} />
            </div>
            <span>Tenvyr</span>
          </Link>
          <span
            style={{
              fontSize: "0.65rem",
              fontWeight: 700,
              textTransform: "uppercase",
              padding: "0.15rem 0.4rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "rgba(255, 255, 255, 0.06)",
              color: "var(--text-secondary)",
              letterSpacing: "0.05em",
            }}
          >
            Workbench
          </span>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section">
            <Link
              href="/dashboard"
              className={`nav-link ${isActive("/dashboard") ? "active" : ""}`}
            >
              <LayoutDashboard size={16} aria-hidden="true" />
              <span>Overview</span>
            </Link>
          </div>

          <div className="nav-section">
            <span className="nav-section-title">Work</span>
            <Link
              href="/runs/new"
              className={`nav-link ${isActive("/runs/new") ? "active" : ""}`}
              style={{
                color: isActive("/runs/new") ? "var(--accent-blue)" : "var(--accent-blue)",
                fontWeight: 600,
              }}
            >
              <PlayCircle size={16} aria-hidden="true" />
              <span>New Run</span>
            </Link>
            <Link
              href="/runs"
              className={`nav-link ${isActive("/runs") && !isActive("/runs/new") ? "active" : ""}`}
            >
              <ListOrdered size={16} aria-hidden="true" />
              <span>Runs</span>
            </Link>
            <Link
              href="/attention"
              className={`nav-link ${isActive("/attention") ? "active" : ""}`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <BellRing size={16} aria-hidden="true" />
                <span>Attention</span>
              </div>
              {pendingApprovalsCount > 0 && (
                <span
                  style={{
                    backgroundColor: "var(--accent-amber)",
                    color: "#000",
                    fontWeight: 700,
                    fontSize: "0.7rem",
                    padding: "0.1rem 0.4rem",
                    borderRadius: "10px",
                    lineHeight: 1.2,
                  }}
                >
                  {pendingApprovalsCount}
                </span>
              )}
            </Link>
          </div>

          <div className="nav-section">
            <span className="nav-section-title">Setup</span>
            <Link
              href="/runtimes"
              className={`nav-link ${isActive("/runtimes") ? "active" : ""}`}
            >
              <Cpu size={16} aria-hidden="true" />
              <span>Runtimes</span>
            </Link>
            <Link
              href="/workspaces"
              className={`nav-link ${isActive("/workspaces") ? "active" : ""}`}
            >
              <FolderGit2 size={16} aria-hidden="true" />
              <span>Workspaces</span>
            </Link>
          </div>

          <div className="nav-section">
            <span className="nav-section-title">Advanced</span>
            <Link
              href="/advanced/pipelines"
              className={`nav-link ${isActive("/advanced/pipelines") ? "active" : ""}`}
            >
              <Layers size={16} aria-hidden="true" />
              <span>Pipelines</span>
            </Link>
            <Link
              href="/advanced/audit"
              className={`nav-link ${isActive("/advanced/audit") ? "active" : ""}`}
            >
              <History size={16} aria-hidden="true" />
              <span>Audit Trail</span>
            </Link>
          </div>
        </nav>

        {/* Sidebar Footer */}
        <div
          style={{
            padding: "0.75rem 1rem",
            borderTop: "1px solid var(--border-color)",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            fontSize: "0.75rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "var(--text-muted)" }}>Gateway</span>
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
              {gatewayStatus === "online" ? (
                <>
                  <CheckCircle2 size={12} color="var(--accent-green)" />
                  <span style={{ color: "var(--accent-green)", fontWeight: 600 }}>Ready</span>
                </>
              ) : gatewayStatus === "offline" ? (
                <>
                  <AlertCircle size={12} color="var(--accent-red)" />
                  <span style={{ color: "var(--accent-red)", fontWeight: 600 }}>Offline</span>
                </>
              ) : (
                <span style={{ color: "var(--text-muted)" }}>Connecting…</span>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="main-content">
        {gatewayStatus === "offline" && (
          <div className="notice notice-error" style={{ borderRadius: 0, borderTop: 0, borderLeft: 0, borderRight: 0 }}>
            <AlertCircle size={16} />
            <div>
              <strong>Tenvyr Gateway is unreachable.</strong>{" "}
              Make sure the gateway and orchestrator services are running.
            </div>
          </div>
        )}
        <main>{children}</main>
      </div>
    </div>
  );
}
