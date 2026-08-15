import React from "react";
import { Loader2 } from "lucide-react";

export function LoadingSpinner({ text = "Loading…" }: { text?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        padding: "2rem 1rem",
        color: "var(--text-secondary)",
        fontSize: "0.85rem",
      }}
      role="status"
      aria-live="polite"
    >
      <Loader2
        size={16}
        style={{ animation: "spin 1s linear infinite" }}
        aria-hidden="true"
      />
      <span>{text}</span>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
