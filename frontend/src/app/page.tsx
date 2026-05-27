import React from 'react';
import { ArrowRight, Cpu, Layers, Activity, ShieldAlert, FileText, CheckCircle2 } from 'lucide-react';

export default function Home() {
  return (
    <div className="container" style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      
      {/* Header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2rem 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            background: 'linear-gradient(135deg, var(--accent-blue) 0%, var(--accent-purple) 100%)',
            padding: '0.5rem',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <Cpu size={24} color="#fff" />
          </div>
          <span style={{ fontWeight: 800, fontSize: '1.25rem', letterSpacing: '-0.025em' }}>AgentWeave</span>
        </div>
        <nav style={{ display: 'flex', gap: '2rem' }}>
          <a href="#features" style={{ color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.9rem', transition: 'color 0.2s' }}>Features</a>
          <a href="#how-it-works" style={{ color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.9rem', transition: 'color 0.2s' }}>How it Works</a>
          <a href="https://github.com/longhn-lumin/AgentWeave" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.9rem', transition: 'color 0.2s' }}>GitHub</a>
        </nav>
      </header>

      {/* Hero Section */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6rem', padding: '4rem 0' }}>
        <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4rem', alignItems: 'center' }}>
          
          {/* Text content */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: 'rgba(59, 130, 246, 0.08)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              padding: '0.35rem 0.85rem',
              borderRadius: '20px',
              width: 'fit-content'
            }}>
              <Activity size={14} color="var(--accent-blue)" />
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent-blue)' }}>Kafka-Native Agent Orchestration</span>
            </div>
            
            <h1 style={{ fontSize: '3.5rem', fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.04em' }}>
              Weave Decoupled <br />
              <span style={{ background: 'linear-gradient(135deg, var(--accent-blue) 0%, var(--accent-purple) 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                AI Agents
              </span> Together
            </h1>
            
            <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem', maxWidth: '480px' }}>
              Define complex multi-agent execution graphs in YAML. Deploy polyglot agents asynchronously on a high-throughput event bus. Observe and debug everything in real time.
            </p>

            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
              <a href="/dashboard" className="btn btn-primary" style={{ gap: '0.5rem' }}>
                Go to Dashboard <ArrowRight size={16} />
              </a>
              <a href="#how-it-works" className="btn btn-secondary">
                Learn More
              </a>
            </div>
          </div>

          {/* Animated Execution Demo (CSS only) */}
          <div className="glass-card" style={{
            position: 'relative',
            height: '350px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '1.5rem',
            overflow: 'hidden'
          }}>
            {/* Header of demo window */}
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--accent-red)' }}></span>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--accent-orange)' }}></span>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--accent-green)' }}></span>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>pipeline-monitor.json</span>
              </div>
              <span style={{ color: 'var(--accent-green)', fontSize: '0.75rem', fontWeight: 600, animation: 'pulse 1.5s infinite alternate' }}>● RUNNING</span>
            </div>

            {/* Nodes Container */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', flex: 1, justifyContent: 'center' }}>
              
              {/* Step 1 */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                animation: 'stepCompleted 4s infinite'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <CheckCircle2 size={16} color="var(--accent-green)" />
                  <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>1. code-reviewer</span>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--accent-green)' }}>Completed (856ms)</span>
              </div>

              {/* Connecting path */}
              <div style={{
                width: '2px',
                height: '20px',
                backgroundColor: 'var(--accent-blue)',
                marginLeft: '1.5rem',
                marginTop: '-1.5rem',
                marginBottom: '-1.5rem',
                animation: 'pulseConnector 4s infinite'
              }}></div>

              {/* Step 2 */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.75rem 1rem',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid rgba(59, 130, 246, 0.2)',
                animation: 'stepActive 4s infinite'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <Activity size={16} color="var(--accent-blue)" style={{ animation: 'spin 2s linear infinite' }} />
                  <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>2. observability</span>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--accent-blue)' }}>Running...</span>
              </div>

            </div>

            {/* Event logs output */}
            <div style={{
              background: 'rgba(0, 0, 0, 0.2)',
              borderRadius: '6px',
              padding: '0.5rem',
              fontFamily: 'monospace',
              fontSize: '0.7rem',
              color: 'var(--text-secondary)'
            }}>
              <div style={{ color: 'var(--accent-blue)' }}>[00:01:23] Kafka consumer connected to topic: agentweave.agent.observability.task</div>
              <div style={{ animation: 'logProgress 4s infinite' }}>[00:01:24] Dispatching task with input context...</div>
            </div>
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how-it-works" style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '2rem', fontWeight: 800 }}>How It Works</h2>
            <p style={{ color: 'var(--text-secondary)' }}>A decoupled event-driven pipeline in 3 clear steps</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '2rem' }}>
            
            {/* Step 1 */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{
                background: 'rgba(59, 130, 246, 0.05)',
                border: '1px solid var(--border-color)',
                width: '40px',
                height: '40px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 'bold',
                color: 'var(--accent-blue)'
              }}>1</div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700 }}>Define Pipelines</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Write declarative YAML files specifying step execution orders, conditions, custom input parameters, and failure recovery options.
              </p>
            </div>

            {/* Step 2 */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{
                background: 'rgba(139, 92, 246, 0.05)',
                border: '1px solid var(--border-color)',
                width: '40px',
                height: '40px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 'bold',
                color: 'var(--accent-purple)'
              }}>2</div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700 }}>Deploy Agents</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Initialize specialized agents written in any language. They subscribe to Kafka topics, process tasks, and publish findings.
              </p>
            </div>

            {/* Step 3 */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{
                background: 'rgba(16, 185, 129, 0.05)',
                border: '1px solid var(--border-color)',
                width: '40px',
                height: '40px',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 'bold',
                color: 'var(--accent-green)'
              }}>3</div>
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700 }}>Observe Execution</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                Monitor execution flows live via real-time WebSockets on a react-flow graph. Track system metrics, API costs, and token footprints.
              </p>
            </div>

          </div>
        </section>
      </main>

      {/* Footer */}
      <footer style={{ borderTop: '1px solid var(--border-color)', padding: '2rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <span>&copy; {new Date().getFullYear()} AgentWeave. Open-source multi-agent orchestration framework.</span>
        <div style={{ display: 'flex', gap: '1.5rem' }}>
          <a href="/docs/agent-rules.md" style={{ color: 'inherit', textDecoration: 'none' }}>Agent Rules</a>
          <a href="/docs/codegraph.md" style={{ color: 'inherit', textDecoration: 'none' }}>CodeGraph</a>
          <a href="/docs/rtk.md" style={{ color: 'inherit', textDecoration: 'none' }}>RTK docs</a>
        </div>
      </footer>

      {/* Inline Styles for Demo Animations */}
      <style>{`
        @keyframes pulse {
          0% { opacity: 0.6; }
          100% { opacity: 1; }
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes stepCompleted {
          0%, 20% { border-color: rgba(255, 255, 255, 0.08); background: transparent; }
          40%, 100% { border-color: rgba(16, 185, 129, 0.25); background: rgba(16, 185, 129, 0.02); }
        }
        @keyframes stepActive {
          0%, 40% { border-color: rgba(255, 255, 255, 0.08); }
          60%, 80% { border-color: rgba(59, 130, 246, 0.4); background: rgba(59, 130, 246, 0.02); }
          100% { border-color: rgba(255, 255, 255, 0.08); }
        }
        @keyframes pulseConnector {
          0%, 35% { background-color: rgba(255, 255, 255, 0.08); }
          45%, 80% { background-color: var(--accent-blue); }
          100% { background-color: rgba(255, 255, 255, 0.08); }
        }
        @keyframes logProgress {
          0%, 55% { opacity: 0; }
          60%, 100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
