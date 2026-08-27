import React, { useState, useEffect } from 'react';

interface Agent {
  id: string;
  name: string;
  role: string;
  type: string;
  status: string;
  task?: string;
  sessionTitle?: string;
  model?: string;
  tokenUsage?: number | { totalTokens?: number; total?: number; inputTokens?: number; outputTokens?: number; cost?: number };
  contextLength?: number;
}

interface Props {
  agents: Agent[];
  onStart: (id: string) => void;
  onSpawn: () => void;
  onSelect: (id: string | null) => void;
  selectedAgentId: string | null;
  onUpdateModel?: (agentId: string, model: string | null) => void;
  onDeleteAgent?: (agentId: string) => void;
}

function formatTokens(tokens?: number): string {
  if (tokens === undefined || tokens === null || tokens < 0) return '0';
  if (tokens === 0) return '0';
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}

const getRoleIcon = (role?: string): string => {
  const r = (role || '').toLowerCase();
  if (r.includes('coder')) return '🔨';
  if (r.includes('review')) return '🔍';
  if (r.includes('test')) return '🧪';
  if (r.includes('doc')) return '📝';
  if (r.includes('plan')) return '📋';
  if (r.includes('research')) return '🔬';
  if (r.includes('verif')) return '✅';
  if (r.includes('debug')) return '🐛';
  if (r.includes('search')) return '🔎';
  if (r.includes('idea')) return '💡';
  return '🤖';
};

const renderStatusBadge = (status: string) => {
  const isWorking = status === 'working';
  const isError = status === 'error';
  const dotColor = isWorking ? '#22c55e' : isError ? '#ef4444' : '#64748b';
  const textCol = isWorking ? '#4ade80' : isError ? '#f87171' : '#94a3b8';
  const bgCol = isWorking ? 'rgba(34, 197, 94, 0.15)' : isError ? 'rgba(239, 68, 68, 0.15)' : 'rgba(100, 116, 139, 0.15)';
  const borderCol = isWorking ? 'rgba(34, 197, 94, 0.35)' : isError ? 'rgba(239, 68, 68, 0.35)' : 'rgba(100, 116, 139, 0.25)';

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '2px 8px',
      borderRadius: 9999,
      background: bgCol,
      border: `1px solid ${borderCol}`,
      fontSize: 11,
      fontWeight: 600,
      color: textCol
    }}>
      <span
        className={isWorking ? 'pulsing-green' : isError ? 'pulsing-red' : ''}
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: dotColor,
          display: 'inline-block'
        }}
      />
      <span>{status}</span>
    </div>
  );
};

export function Dashboard({ agents, onStart, onSpawn, onSelect, selectedAgentId, onUpdateModel, onDeleteAgent }: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const safeAgents = Array.isArray(agents) ? agents : [];
  const workerAgents = safeAgents.filter(a => a.id !== 'orchestrator');
  const orchAgent = safeAgents.find(a => a.id === 'orchestrator');

  useEffect(() => {
    const loadModels = async () => {
      setModelLoading(true);
      try {
        const res = await fetch('/api/models');
        const data = await res.json();
        if (Array.isArray(data.models)) setModels(data.models);
      } catch (e) {
        console.error('Failed to load models:', e);
      } finally {
        setModelLoading(false);
      }
    };
    loadModels();
  }, []);

  const handleModelChange = async (agentId: string, model: string) => {
    if (!onUpdateModel) return;
    try {
      await onUpdateModel(agentId, model || null);
    } catch (e) {
      console.error('Failed to update model:', e);
    }
  };

  const isOrchSelected = selectedAgentId === null;
    const orchRawTokens = orchAgent?.contextLength || (orchAgent?.tokenUsage && typeof orchAgent.tokenUsage === 'object' ? ((orchAgent.tokenUsage as any).totalTokens || (orchAgent.tokenUsage as any).total) : orchAgent?.tokenUsage);
  const orchTokens = formatTokens(orchRawTokens);
  const orchTooltip = (() => {
    const tu = typeof orchAgent?.tokenUsage === 'object' ? orchAgent.tokenUsage : null;
    const parts: string[] = [];
    if (orchRawTokens) parts.push(`Total: ${orchRawTokens.toLocaleString()} tokens`);
    if (tu?.inputTokens) parts.push(`Input: ${tu.inputTokens.toLocaleString()}`);
    if (tu?.outputTokens) parts.push(`Output: ${tu.outputTokens.toLocaleString()}`);
    if (tu?.cost) parts.push(`Cost: $${tu.cost.toFixed(4)}`);
    return parts.length > 0 ? parts.join(' | ') : `Context: ${orchRawTokens?.toLocaleString() || 0} tokens`;
  })();

  return (
    <div className="af-dashboard" style={{ flex: 1, overflow: 'auto', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingBottom: 4
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.02em', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
            Active Agents
          </span>
          <span style={{
            background: '#334155',
            color: 'var(--text-muted)',
            padding: '1px 7px',
            borderRadius: 9999,
            fontSize: 11,
            fontWeight: 600
          }}>
            {workerAgents.length + 1}
          </span>
        </div>
        <button
          onClick={onSpawn}
          style={{
            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            boxShadow: '0 2px 8px rgba(37, 99, 235, 0.3)',
            transition: 'all 0.2s'
          }}
          onMouseOver={(e) => { e.currentTarget.style.transform = 'scale(1.02)'; }}
          onMouseOut={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <span>✨</span>
          <span>Spawn</span>
        </button>
      </div>

      {/* Orchestrator Card */}
      <div
        onClick={() => onSelect(null)}
        className="interactive-card af-card"
        style={{
          background: isOrchSelected ? 'var(--bg-card-active)' : 'var(--bg-card)',
          borderRadius: 12,
          padding: 12,
          border: isOrchSelected ? '1px solid var(--accent)' : '1px solid var(--af-border)',
          boxShadow: isOrchSelected ? '0 0 16px -2px var(--accent-soft)' : 'none',
          cursor: 'pointer'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>👑</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>Orchestrator</span>
                <span style={{ fontSize: 10, color: '#818cf8', background: 'rgba(99, 102, 241, 0.15)', padding: '1px 6px', borderRadius: 4, fontFamily: 'monospace' }}>
                  main
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: '#38bdf8',
                    background: 'rgba(56, 189, 248, 0.12)',
                    padding: '1px 6px',
                    borderRadius: 4,
                    fontFamily: 'monospace',
                    border: '1px solid rgba(56, 189, 248, 0.25)'
                  }}
                  title={orchTooltip}
                >
                  ⚡ {orchTokens}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                Commander & Task Coordinator
              </div>
            </div>
          </div>
          {orchAgent && renderStatusBadge(orchAgent.status)}
        </div>

        {orchAgent?.sessionTitle && (
          <div style={{
            fontSize: 11,
            color: '#a5b4fc',
            background: 'rgba(99, 102, 241, 0.1)',
            padding: '3px 8px',
            borderRadius: 6,
            marginTop: 8,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            border: '1px solid rgba(99, 102, 241, 0.2)'
          }}>
            💬 {orchAgent.sessionTitle}
          </div>
        )}

        <select
          value={orchAgent?.model || ''}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.stopPropagation();
            handleModelChange('orchestrator', e.target.value);
          }}
          disabled={modelLoading}
          style={{
            marginTop: 8,
            width: '100%',
            background: 'var(--bg-input)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--af-border)',
            borderRadius: 8,
            padding: '4px 8px',
            fontSize: 11,
            cursor: modelLoading ? 'wait' : 'pointer'
          }}
        >
          <option value="">{modelLoading ? '⏳ Loading models...' : '⚡ Default (inherit config)'}</option>
          {models.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* Worker Agents Section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
        {workerAgents.length === 0 ? (
          <div style={{
            textAlign: 'center',
            color: '#64748b',
            padding: '24px 12px',
            fontSize: 12,
            background: '#111827',
            borderRadius: 10,
            border: '1px dashed #334155'
          }}>
            <div style={{ fontSize: 24, marginBottom: 6 }}>👥</div>
            <div>No subagents spawned yet.</div>
            <div style={{ marginTop: 2, fontSize: 11, color: '#475569' }}>Click "+ Spawn" to dispatch workers</div>
          </div>
        ) : (
          workerAgents.map(agent => {
            const isSelected = selectedAgentId === agent.id;
            const roleIcon = getRoleIcon(agent.role);
            const agentRawTokens = agent.contextLength || (agent.tokenUsage && typeof agent.tokenUsage === 'object' ? ((agent.tokenUsage as any).totalTokens || (agent.tokenUsage as any).total) : agent.tokenUsage);
            const agentTokens = formatTokens(agentRawTokens);
            const agentTooltip = (() => {
              const tu = typeof agent.tokenUsage === 'object' ? agent.tokenUsage : null;
              const parts: string[] = [];
              if (agentRawTokens) parts.push(`Total: ${agentRawTokens.toLocaleString()} tokens`);
              if (tu?.inputTokens) parts.push(`Input: ${tu.inputTokens.toLocaleString()}`);
              if (tu?.outputTokens) parts.push(`Output: ${tu.outputTokens.toLocaleString()}`);
              if (tu?.cost) parts.push(`Cost: $${tu.cost.toFixed(4)}`);
              return parts.length > 0 ? parts.join(' | ') : `Context: ${agentRawTokens?.toLocaleString() || 0} tokens`;
            })();
            return (
              <div
                key={agent.id}
                onClick={() => onSelect(agent.id)}
                className={`interactive-card af-card${agent.status === 'working' ? ' af-working' : ''}`}
                style={{
                  background: isSelected ? 'var(--bg-card-active)' : 'var(--bg-card)',
                  borderRadius: 12,
                  padding: 12,
                  border: isSelected ? '1px solid var(--accent)' : '1px solid var(--af-border)',
                  boxShadow: isSelected ? '0 0 16px -2px var(--accent-soft)' : 'none',
                  cursor: 'pointer'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 16 }}>{roleIcon}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        fontWeight: 600,
                        fontSize: 13,
                        color: '#f8fafc',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6
                      }}>
                        <span>{agent.name}</span>
                        <span
                          style={{
                            fontSize: 10,
                            color: '#38bdf8',
                            background: 'rgba(56, 189, 248, 0.12)',
                            padding: '1px 5px',
                            borderRadius: 4,
                            fontFamily: 'monospace',
                            border: '1px solid rgba(56, 189, 248, 0.25)'
                          }}
                          title={agentTooltip}
                        >
                          ⚡ {agentTokens}
                        </span>
                      </div>
                      <div style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 1
                      }}>
                        <span style={{
                          background: '#334155',
                          color: 'var(--text-secondary)',
                          padding: '0 5px',
                          borderRadius: 4,
                          fontSize: 10,
                          fontWeight: 500
                        }}>
                          {agent.role}
                        </span>
                        <span style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
                          {agent.id}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {renderStatusBadge(agent.status)}
                    {onDeleteAgent && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Xoá agent ${agent.name} (${agent.id})?`)) {
                            onDeleteAgent(agent.id);
                          }
                        }}
                        title="Xoá agent"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#64748b',
                          cursor: 'pointer',
                          padding: '2px 4px',
                          fontSize: 12,
                          borderRadius: 4,
                          transition: 'color 0.2s'
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ef4444'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#64748b'; }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {agent.sessionTitle && (
                  <div style={{
                    fontSize: 11,
                    color: '#34d399',
                    background: 'rgba(16, 185, 129, 0.1)',
                    padding: '3px 8px',
                    borderRadius: 6,
                    marginTop: 8,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    border: '1px solid rgba(16, 185, 129, 0.2)'
                  }}>
                    💬 {agent.sessionTitle}
                  </div>
                )}

                {agent.task && (
                  <div style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    marginTop: 6,
                    lineHeight: 1.4,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}>
                    {agent.task}
                  </div>
                )}

                <select
                  value={agent.model || ''}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation();
                    handleModelChange(agent.id, e.target.value);
                  }}
                  disabled={modelLoading}
                  style={{
                    marginTop: 8,
                    width: '100%',
                    background: '#0f172a',
                    color: 'var(--text-secondary)',
                    border: '1px solid #334155',
                    borderRadius: 6,
                    padding: '4px 8px',
                    fontSize: 11,
                    cursor: modelLoading ? 'wait' : 'pointer'
                  }}
                >
                  <option value="">{modelLoading ? '⏳ Loading models...' : '⚡ Default (inherit role)'}</option>
                  {models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
