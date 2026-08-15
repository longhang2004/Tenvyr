import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "../components/app-shell/AppShell.tsx";

export const metadata: Metadata = {
  title: "Tenvyr Operator Workbench",
  description:
    "Framework-neutral Agent Execution Control Plane for supervised AI agent work.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
