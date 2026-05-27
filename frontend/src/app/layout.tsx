import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentWeave — Multi-Agent Orchestration Framework',
  description: 'An open-source multi-agent orchestration framework utilizing Kafka as the event bus to connect and coordinate specialized AI agents.',
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
