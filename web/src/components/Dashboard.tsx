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
  onSpawn: (defaultParentId?: string) => void;
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creatingOrch, setCreatingOrch] = useState(false);
  const safeAgents = Array.isArray(agents) ? agents : [];

  // Group orchestrators and worker hierarchy
  const orchAgents = safeAgents.filter(a => a.id === 'orchestrator' || a.type === 'orchestrator' || a.role === 'orchestrator');
  // Đảm bảo Main Orchestrator ('orchestrator') luôn là đầu tiên
  const sortedOrchs = [
    ...(orchAgents.find(a => a.id === 'orchestrator') ? [orchAgents.find(a => a.id === 'orchestrator')!] : [{ id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator', status: 'idle' } as Agent]),
    ...orchAgents.filter(a => a.id !== 'orchestrator')
  ];

  const toggleCollapse = (orchId: string) => {
    setCollapsed(prev => ({ ...prev, [orchId]: !prev[orchId] }));
  };

  const handleCreateOrchestrator = async () => {
    const name = window.prompt('Nhập tên Orchestrator mới:', `Orchestrator-${Math.floor(1000 + Math.random() * 9000)}`);
    if (!name || !name.trim()) return;
    setCreatingOrch(true);
    try {
      await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          role: 'orchestrator',
          type: 'orchestrator'
        })
      });
    } catch (e) {
      console.error('Failed to create orchestrator:', e);
    } finally {
      setCreatingOrch(false);
    }
  };

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

  return (
    <div className="af-dashboard" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', width: '100%', boxSizing: 'border-box', padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--af-bg-sidebar, transparent)' }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingBottom: 4,
        gap: 6
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.02em', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
            Active Agents
          </span>
          <span style={{
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            border: '1px solid rgba(59, 130, 246, 0.2)',
            padding: '1px 7px',
            borderRadius: 9999,
            fontSize: 11,
            fontWeight: 600
          }}>
            {safeAgents.length}
          </span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={handleCreateOrchestrator}
            disabled={creatingOrch}
            title="Tạo thêm Orchestrator / Team mới"
            style={{
              background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.2) 0%, rgba(99, 102, 241, 0.2) 100%)',
              color: '#c4b5fd',
              border: '1px solid rgba(139, 92, 246, 0.35)',
              borderRadius: 9999,
              padding: '0 10px',
              height: 28,
              fontSize: 12,
              cursor: creatingOrch ? 'wait' : 'pointer',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              boxShadow: '0 1px 4px rgba(139, 92, 246, 0.15)',
              transition: 'all 0.2s'
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139, 92, 246, 0.3) 0%, rgba(99, 102, 241, 0.3) 100%)';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139, 92, 246, 0.2) 0%, rgba(99, 102, 241, 0.2) 100%)';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            <span style={{ fontSize: 13 }}>👑</span>
            <span>+ New Team</span>
          </button>

          <button
            onClick={() => onSpawn()}
            style={{
              background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
              color: 'white',
              border: 'none',
              borderRadius: 9999,
              padding: '0 11px',
              height: 28,
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              boxShadow: '0 1px 6px rgba(37, 99, 235, 0.25)',
              transition: 'all 0.2s'
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 3px 10px rgba(37, 99, 235, 0.35)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 1px 6px rgba(37, 99, 235, 0.25)';
            }}
          >
            <span style={{ fontSize: 13 }}>🤖</span>
            <span>+ New Agent</span>
          </button>
        </div>
      </div>

      {/* Orchestrator Groups & Hierarchy */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {sortedOrchs.map((orch) => {
          const isOrchSelected = selectedAgentId === (orch.id === 'orchestrator' ? null : orch.id) || (selectedAgentId === 'orchestrator' && orch.id === 'orchestrator');
          const isMain = orch.id === 'orchestrator';
          const isCollapsed = Boolean(collapsed[orch.id]);

          // Tìm các worker thuộc về orchestrator này
          const childWorkers = safeAgents.filter(a => {
            if (a.id === orch.id || a.type === 'orchestrator' || a.role === 'orchestrator') return false;
            if (a.spawnedBy === orch.id) return true;
            if (!a.spawnedBy && isMain) return true; // Chưa gán spawnedBy thì thuộc main
            return false;
          });

          const rawTokens = orch.contextLength || (orch.tokenUsage && typeof orch.tokenUsage === 'object' ? ((orch.tokenUsage as any).totalTokens || (orch.tokenUsage as any).total) : orch.tokenUsage);
          const tokens = formatTokens(rawTokens);
          const tooltip = (() => {
            const tu = typeof orch.tokenUsage === 'object' ? orch.tokenUsage : null;
            const parts: string[] = [];
            if (rawTokens) parts.push(`Total: ${rawTokens.toLocaleString()} tokens`);
            if (tu?.inputTokens) parts.push(`Input: ${tu.inputTokens.toLocaleString()}`);
            if (tu?.outputTokens) parts.push(`Output: ${tu.outputTokens.toLocaleString()}`);
            if (tu?.cost) parts.push(`Cost: $${tu.cost.toFixed(4)}`);
            return parts.length > 0 ? parts.join(' | ') : `Context: ${rawTokens?.toLocaleString() || 0} tokens`;
          })();

          return (
            <div key={orch.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Orchestrator Header Card (2-Line Compact Layout) */}
              <div
                onClick={() => onSelect(isMain ? null : orch.id)}
                className="interactive-card af-card"
                style={{
                  background: isOrchSelected ? 'var(--bg-card-active)' : 'var(--bg-card)',
                  borderRadius: 8,
                  padding: '9px 11px',
                  border: isOrchSelected ? '1px solid var(--accent)' : '1px solid var(--af-border)',
                  boxShadow: isOrchSelected ? '0 0 14px -2px var(--accent-soft)' : 'none',
                  cursor: 'pointer',
                  width: '100%',
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                  overflow: 'hidden'
                }}
              >
                {/* Line 1: Header title, count badge, status badge, delete button, collapse toggle */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 16, flexShrink: 0 }}>{isCollapsed ? '📁' : '📂'}</span>
                    <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      👑 {isMain ? 'Main Orchestrator' : (orch.name || 'Orchestrator')}
                    </span>
                    <span style={{
                      fontSize: 10.5,
                      color: 'var(--text-muted)',
                      background: 'rgba(148, 163, 184, 0.12)',
                      padding: '1px 5px',
                      borderRadius: 4,
                      fontWeight: 600,
                      flexShrink: 0
                    }}>
                      ({childWorkers.length})
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    {renderStatusBadge(orch.status)}
                    {!isMain && onDeleteAgent && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Xoá Sub-Orchestrator ${orch.name} (${orch.id})? Toàn bộ worker của team này sẽ được chuyển về Main Orchestrator.`)) {
                            onDeleteAgent(orch.id);
                          }
                        }}
                        title="Xoá Team Orchestrator này"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#f87171',
                          cursor: 'pointer',
                          padding: '2px 4px',
                          fontSize: 11,
                          fontWeight: 700,
                          borderRadius: 4,
                          transition: 'color 0.15s'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = '#ef4444'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = '#f87171'; }}
                      >
                        ✕
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapse(orch.id);
                      }}
                      title={isCollapsed ? "Mở rộng Workspace" : "Thu gọn Workspace"}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        padding: 0,
                        width: 18,
                        height: 18,
                        borderRadius: 3,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.15s ease'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
                        e.currentTarget.style.color = 'var(--text-primary)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                        e.currentTarget.style.color = 'var(--text-muted)';
                      }}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                          transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                          transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
                        }}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Line 2: Compact Model Dropdown & Token Badge */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 6, width: '100%' }}>
                  <select
                    value={orch.model || ''}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      e.stopPropagation();
                      handleModelChange(orch.id, e.target.value);
                    }}
                    disabled={modelLoading}
                    style={{
                      flex: 1,
                      maxWidth: 160,
                      background: 'var(--bg-input)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--af-border)',
                      borderRadius: 4,
                      padding: '3px 6px',
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: modelLoading ? 'wait' : 'pointer',
                      outline: 'none'
                    }}
                  >
                    <option value="" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>{modelLoading ? '⏳ Loading...' : '⚡ Default Model'}</option>
                    {models.map(m => (
                      <option key={m} value={m} style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>{m}</option>
                    ))}
                  </select>

                  <span
                    style={{
                      fontSize: 10.5,
                      color: '#38bdf8',
                      background: 'rgba(56, 189, 248, 0.12)',
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontFamily: 'monospace',
                      border: '1px solid rgba(56, 189, 248, 0.25)',
                      flexShrink: 0
                    }}
                    title={tooltip}
                  >
                    ⚡ {tokens}
                  </span>
                </div>

                {/* Session title if exists */}
                {orch.sessionTitle && (
                  <div style={{
                    fontSize: 11,
                    color: '#a5b4fc',
                    background: 'rgba(99, 102, 241, 0.08)',
                    padding: '2px 6px',
                    borderRadius: 4,
                    marginTop: 5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    border: '1px solid rgba(99, 102, 241, 0.15)'
                  }}>
                    💬 {orch.sessionTitle}
                  </div>
                )}
              </div>

              {/* Children Subagents List (Clean Minimalist Tree) */}
              {!isCollapsed && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  paddingLeft: 16,
                  marginLeft: 8,
                  borderLeft: '2px solid rgba(148, 163, 184, 0.15)'
                }}>
                  {childWorkers.length === 0 ? (
                    <div style={{
                      fontSize: 12,
                      color: '#64748b',
                      padding: '10px 12px',
                      background: 'rgba(15, 23, 42, 0.4)',
                      borderRadius: 8,
                      border: '1px dashed #334155',
                      textAlign: 'center'
                    }}>
                      Chưa có worker nào trong workspace này.
                    </div>
                  ) : (
                    childWorkers.map((agent) => {
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
                            borderRadius: 10,
                            padding: 12,
                            border: isSelected ? '1px solid var(--accent)' : '1px solid var(--af-border)',
                            boxShadow: isSelected ? '0 0 16px -2px var(--accent-soft)' : 'none',
                            cursor: 'pointer'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                              <span style={{ fontSize: 18 }}>{roleIcon}</span>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{
                                  fontWeight: 600,
                                  fontSize: 14,
                                  color: 'var(--text-primary)',
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
                                      fontSize: 11,
                                      color: '#38bdf8',
                                      background: 'rgba(56, 189, 248, 0.12)',
                                      padding: '1px 6px',
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
                                  fontSize: 12,
                                  color: 'var(--text-muted)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  marginTop: 2
                                }}>
                                  <span style={{
                                    background: 'var(--accent-soft)',
                                    color: 'var(--accent)',
                                    border: '1px solid rgba(59, 130, 246, 0.25)',
                                    padding: '1px 7px',
                                    borderRadius: 4,
                                    fontSize: 11,
                                    fontWeight: 600
                                  }}>
                                    {agent.role}
                                  </span>
                                  <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>
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
                                    fontSize: 13,
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
                              fontSize: 12,
                              color: '#34d399',
                              background: 'rgba(16, 185, 129, 0.1)',
                              padding: '3px 8px',
                              borderRadius: 4,
                              marginTop: 6,
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
                              fontSize: 12,
                              color: 'var(--text-muted)',
                              marginTop: 5,
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
                              background: 'var(--bg-input)',
                              color: 'var(--text-primary)',
                              border: '1px solid var(--af-border-strong)',
                              borderRadius: 6,
                              padding: '6px 8px',
                              fontSize: 12,
                              fontWeight: 500,
                              cursor: modelLoading ? 'wait' : 'pointer'
                            }}
                          >
                            <option value="" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>{modelLoading ? '⏳ Loading...' : '⚡ Default (inherit role)'}</option>
                            {models.map(m => (
                              <option key={m} value={m} style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>{m}</option>
                            ))}
                          </select>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
