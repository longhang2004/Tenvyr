"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Folder,
  FolderOpen,
  ArrowUp,
  Home,
  X,
  Check,
  Laptop,
} from "lucide-react";
import { LoadingSpinner } from "./LoadingSpinner.tsx";

export type DirectoryPickerModalProps = {
  isOpen: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelect: (selectedPath: string) => void;
};

export function DirectoryPickerModal({
  isOpen,
  initialPath = "",
  onClose,
  onSelect,
}: DirectoryPickerModalProps) {
  const [currentPath, setCurrentPath] = useState<string>(initialPath);
  const [inputPath, setInputPath] = useState<string>(initialPath);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [homePath, setHomePath] = useState<string>("");
  const [directories, setDirectories] = useState<string[]>([]);
  const [selectedDirName, setSelectedDirName] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchDirectory = useCallback(async (pathQuery: string) => {
    setLoading(true);
    setErrorMsg(null);
    setSelectedDirName(null);
    try {
      const url = `/api/fs/dirs?path=${encodeURIComponent(pathQuery)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Failed to read directory (${res.status})`);
      }

      setCurrentPath(data.currentPath);
      setInputPath(data.currentPath);
      setParentPath(data.parentPath);
      if (data.homePath) setHomePath(data.homePath);
      setDirectories(data.directories || []);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchDirectory(initialPath || "");
    }
  }, [isOpen, initialPath, fetchDirectory]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleNavigate = (subDir: string) => {
    const nextPath = currentPath.endsWith("/")
      ? `${currentPath}${subDir}`
      : `${currentPath}/${subDir}`;
    fetchDirectory(nextPath);
  };

  const handleGoParent = () => {
    if (parentPath) {
      fetchDirectory(parentPath);
    }
  };

  const handleGoInputPath = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputPath.trim()) {
      fetchDirectory(inputPath.trim());
    }
  };

  const handleNativePicker = async () => {
    if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
      try {
        const handle = await (window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> }).showDirectoryPicker();
        if (handle?.name) {
          // If native handle was selected, update current path or select it
          handleNavigate(handle.name);
        }
      } catch {
        // User cancelled picker
      }
    } else if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const firstFile = files[0];
      const relativePath = firstFile.webkitRelativePath;
      if (relativePath) {
        const rootDirName = relativePath.split("/")[0];
        if (rootDirName) {
          handleNavigate(rootDirName);
        }
      }
    }
  };

  const selectedFullPath = selectedDirName
    ? currentPath.endsWith("/")
      ? `${currentPath}${selectedDirName}`
      : `${currentPath}/${selectedDirName}`
    : currentPath;

  const handleConfirmSelect = () => {
    if (selectedFullPath) {
      onSelect(selectedFullPath);
      onClose();
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.75)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "1rem",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="dir-picker-title"
    >
      {/* Hidden file input for webkitdirectory fallback */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileInputChange}
        // @ts-expect-error webkitdirectory is standard in HTML5 directory pickers
        webkitdirectory=""
        directory=""
        style={{ display: "none" }}
      />

      <div
        style={{
          backgroundColor: "var(--bg-surface)",
          border: "1px solid var(--border-color)",
          borderRadius: "var(--radius-lg)",
          width: "100%",
          maxWidth: "680px",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "0.85rem 1.25rem",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <FolderOpen size={18} color="var(--accent-blue)" />
            <h2 id="dir-picker-title" style={{ fontSize: "1rem", fontWeight: 700 }}>
              Select Local Folder
            </h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={handleNativePicker}
              className="btn btn-secondary btn-sm"
              style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
              title="Open OS File Chooser Window"
            >
              <Laptop size={12} />
              <span>OS Dialog</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="btn btn-secondary btn-sm"
              style={{ padding: "0.25rem", borderRadius: "50%" }}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Path Navigation Bar */}
        <div
          style={{
            padding: "0.75rem 1.25rem",
            backgroundColor: "var(--bg-card)",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <form onSubmit={handleGoInputPath} style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={handleGoParent}
              disabled={!parentPath || loading}
              className="btn btn-secondary btn-sm"
              title="Go to parent directory"
            >
              <ArrowUp size={14} />
            </button>
            <input
              type="text"
              value={inputPath}
              onChange={(e) => setInputPath(e.target.value)}
              placeholder="/Users/username/project"
              className="form-input"
              style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "0.8rem", padding: "0.35rem 0.6rem" }}
            />
            <button type="submit" disabled={loading} className="btn btn-secondary btn-sm">
              Go
            </button>
          </form>

          {/* Quick bookmarks */}
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Jump to:</span>
            {homePath && (
              <button
                type="button"
                onClick={() => fetchDirectory(homePath)}
                className="btn btn-secondary btn-sm"
                style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}
              >
                <Home size={10} />
                <span>Home</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => fetchDirectory(process.cwd())}
              className="btn btn-secondary btn-sm"
              style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}
            >
              <span>Current Project</span>
            </button>
          </div>
        </div>

        {/* Folder List Area */}
        <div
          style={{
            flex: 1,
            minHeight: "260px",
            maxHeight: "360px",
            overflowY: "auto",
            padding: "0.75rem 1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.25rem",
          }}
        >
          {loading ? (
            <LoadingSpinner text="Reading directory contents…" />
          ) : errorMsg ? (
            <div className="notice notice-error" style={{ margin: "1rem 0" }}>
              <div>{errorMsg}</div>
            </div>
          ) : directories.length === 0 ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              No subdirectories found in this folder.
            </div>
          ) : (
            directories.map((dir) => {
              const isSelected = selectedDirName === dir;
              return (
                <div
                  key={dir}
                  onClick={() => setSelectedDirName(dir)}
                  onDoubleClick={() => handleNavigate(dir)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0.4rem 0.6rem",
                    borderRadius: "var(--radius-sm)",
                    backgroundColor: isSelected ? "var(--accent-blue-subtle)" : "transparent",
                    border: isSelected ? "1px solid var(--accent-blue)" : "1px solid transparent",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Folder size={14} color={isSelected ? "var(--accent-blue)" : "var(--text-secondary)"} />
                    <span style={{ fontSize: "0.85rem", fontWeight: isSelected ? 600 : 400 }}>
                      {dir}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNavigate(dir);
                    }}
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}
                  >
                    Open
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "0.85rem 1.25rem",
            borderTop: "1px solid var(--border-color)",
            backgroundColor: "var(--bg-card)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div
            style={{
              fontSize: "0.75rem",
              fontFamily: "var(--font-mono)",
              color: "var(--text-secondary)",
              maxWidth: "400px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={selectedFullPath}
          >
            Target: <strong>{selectedFullPath}</strong>
          </div>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmSelect}
              disabled={!selectedFullPath}
              className="btn btn-primary btn-sm"
            >
              <Check size={14} />
              <span>Select This Folder</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
