"use client";

import React, { useState } from "react";
import { FolderOpen } from "lucide-react";
import { DirectoryPickerModal } from "./DirectoryPickerModal.tsx";

export type DirectoryInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
};

export function DirectoryInput({
  value,
  onChange,
  placeholder = "/path/to/project",
  required = false,
  className = "",
  id,
  name,
  disabled = false,
}: DirectoryInputProps) {
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);

  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", width: "100%" }}>
      <input
        type="text"
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        className={`form-input ${className}`}
        style={{ flex: 1, fontFamily: "var(--font-mono)" }}
      />
      <button
        type="button"
        onClick={() => setIsModalOpen(true)}
        disabled={disabled}
        className="btn btn-secondary"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4rem",
          padding: "0.5rem 0.85rem",
          flexShrink: 0,
        }}
        title="Open directory chooser window"
      >
        <FolderOpen size={15} color="var(--accent-blue)" />
        <span>Browse…</span>
      </button>

      <DirectoryPickerModal
        isOpen={isModalOpen}
        initialPath={value || ""}
        onClose={() => setIsModalOpen(false)}
        onSelect={(selectedPath) => onChange(selectedPath)}
      />
    </div>
  );
}
