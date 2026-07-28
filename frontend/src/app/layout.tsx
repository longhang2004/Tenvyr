import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tenvyr — Agent Execution Control Plane",
  description:
    "A framework-neutral execution control plane that runs outside agent processes to dispatch, supervise, and orchestrate durable work.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="gradient-bg">
          <div className="gradient-circle-1"></div>
          <div className="gradient-circle-2"></div>
        </div>
        {children}
      </body>
    </html>
  );
}
