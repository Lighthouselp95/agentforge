import React, { useState, useEffect } from 'react';
import { parseAgentTaskList, renderAgentTaskList } from '../utils/taskUtils';

interface Agent {
  id: string;
  name: string;
  role: string;
  type: string;
  status: string;
  task?: string;
  tasks?: Array<{ id?: string; task: string; status: string }>;
  sessionTitle?: string;
  model?: string;
  spawnedBy?: string;
  teamId?: string;
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
  onDeleteTask?: (agentId: string, taskId: string | number) => void;
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
  const isError = status === 'error' || status === 'blocked';
  const dotColor = isWorking ? 'var(--wb-success-strong)' : isError ? '#ef4444' : 'var(--wb-muted)';
  const textCol = isWorking ? 'var(--wb-success-strong)' : isError ? '#f87171' : 'var(--text-muted)';
  const bgCol = isWorking ? 'rgba(34, 197, 94, 0.15)' : isError ? 'rgba(239, 68, 68, 0.18)' : 'rgba(100, 116, 139, 0.15)';
  const borderCol = isWorking ? 'rgba(34, 197, 94, 0.35)' : isError ? 'rgba(239, 68, 68, 0.45)' : 'rgba(100, 116, 139, 0.25)';
  const label = status === 'error' ? '⚠️ Lỗi' : status === 'blocked' ? '⚠️ Blocked' : status;

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
      fontWeight: 700,
      color: textCol,
      whiteSpace: 'nowrap'
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
      <span>{label}</span>
    </div>
  );
};

export function Dashboard({ agents, onStart, onSpawn, onSelect, selectedAgentId, onUpdateModel, onDeleteAgent, onDeleteTask }: Props) {
  const [models, setModels] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('af-models-cache');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.models)) return parsed.models;
      }
    } catch {}
    return [];
  });
  const [modelLoading, setModelLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creatingOrch, setCreatingOrch] = useState(false);
  const [deletingTaskInfo, setDeletingTaskInfo] = useState<{ agentId: string; taskId: string | number } | null>(null);
  const safeAgents = Array.isArray(agents) ? agents : [];

  const handleDeleteTask = async (agentId: string, taskId: string | number) => {
    if (onDeleteTask) {
      onDeleteTask(agentId, taskId);
      return;
    }
    setDeletingTaskInfo({ agentId, taskId });
    try {
      await fetch(`/api/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(String(taskId))}`, {
        method: 'DELETE'
      });
    } catch (err) {
      console.error('Failed to delete task:', err);
    } finally {
      setDeletingTaskInfo(null);
    }
  };

  // Card element refs & auto-scroll on error/blocked status
  const agentCardRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const prevStatusesRef = React.useRef<Record<string, string>>({});

  useEffect(() => {
    safeAgents.forEach(a => {
      const prev = prevStatusesRef.current[a.id];
      const isNowError = a.status === 'error' || a.status === 'blocked';
      const wasNotError = prev !== 'error' && prev !== 'blocked';
      if (isNowError && wasNotError) {
        const el = agentCardRefs.current[a.id];
        if (el) {
          try {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          } catch {}
        }
      }
      prevStatusesRef.current[a.id] = a.status;
    });
  }, [safeAgents]);

  // Group orchestrators and worker hierarchy: Mọi Main Orchestrator đều ngang hàng nhau
  const sortedOrchs = safeAgents.filter(a => a.id === 'orchestrator' || a.type === 'orchestrator' || a.role === 'orchestrator');

  // Lấy danh sách tất cả teamId tồn tại trong hệ thống (từ orchestrator hoặc từ worker còn lại)
  const allTeamIds = Array.from(new Set(
    safeAgents.map(a => {
      if (a.teamId) return a.teamId;
      if (a.id === 'orchestrator') return 'default';
      return 'default';
    })
  ));

  // Các team mồ côi (đã xóa Orchestrator nhưng worker vẫn còn)
  const orphanTeams = allTeamIds.filter(tId => !sortedOrchs.some(o => (o.teamId || (o.id === 'orchestrator' ? 'default' : '')) === tId));

  const toggleCollapse = (orchId: string) => {
    setCollapsed(prev => ({ ...prev, [orchId]: !prev[orchId] }));
  };

  const handleCreateOrchestrator = async () => {
    const name = window.prompt('Nhập tên Orchestrator mới:', `Orchestrator-${Math.floor(1000 + Math.random() * 9000)}`);
    if (!name || !name.trim()) return;
    setCreatingOrch(true);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          role: 'orchestrator',
          type: 'orchestrator'
        })
      });
      const data = await res.json().catch(() => null);
      // Hướng B: sau khi tạo team mới thành công → chuyển tab sang orchestrator vừa tạo
      // (không xóa history cũ trên server — chỉ tách view theo teamId mới).
      if (data?.ok && data?.agent?.id) {
        onSelect(data.agent.id);
      }
    } catch (e) {
      console.error('Failed to create orchestrator:', e);
    } finally {
      setCreatingOrch(false);
    }
  };

  useEffect(() => {
    const loadModels = async () => {
      let isFresh = false;
      try {
        const raw = localStorage.getItem('af-models-cache');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed?.models) && parsed.models.length > 0) {
            setModels(parsed.models);
            if (typeof parsed.timestamp === 'number' && Date.now() - parsed.timestamp < 5 * 60 * 1000) {
              isFresh = true;
            }
          }
        }
      } catch {}

      // Nếu cache còn hạn < 5 phút thì không cần fetch lại, không hiện loading
      if (isFresh) return;

      // Chỉ hiện modelLoading nếu chưa có model nào trong state/cache
      if (models.length === 0) {
        setModelLoading(true);
      }
      try {
        const res = await fetch('/api/models');
        if (res.ok) {
          const data = await res.json();
          const modelList: string[] = [];
          if (Array.isArray(data.models)) {
            modelList.push(...data.models);
          } else if (Array.isArray(data.providers)) {
            for (const p of data.providers) {
              if (p?.models && typeof p.models === 'object') {
                for (const mId of Object.keys(p.models)) {
                  modelList.push(`${p.id}/${mId}`);
                }
              }
            }
          }
          if (modelList.length > 0) {
            setModels(modelList);
            try {
              localStorage.setItem('af-models-cache', JSON.stringify({
                models: modelList,
                timestamp: Date.now()
              }));
            } catch {}
          }
        }
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
              color: 'var(--wb-purple)',
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
              background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%)',
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
        {sortedOrchs.length === 0 && orphanTeams.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '36px 16px',
            background: 'rgba(15, 23, 42, 0.4)',
            borderRadius: 12,
            border: '2px dashed var(--af-border-strong)',
            gap: 12,
            textAlign: 'center'
          }}>
            <span style={{ fontSize: 32 }}>👑</span>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              Chưa có Orchestrator nào trong hệ thống
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 320, lineHeight: 1.5 }}>
              Mọi Main Orchestrator đều ngang hàng và quản lý workspace riêng. Bấm nút dưới để tạo Orchestrator / Team mới.
            </div>
            <button
              onClick={handleCreateOrchestrator}
              disabled={creatingOrch}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.9) 0%, rgba(99, 102, 241, 0.9) 100%)',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '8px 16px',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: creatingOrch ? 'wait' : 'pointer',
                boxShadow: '0 2px 10px rgba(139, 92, 246, 0.35)'
              }}
            >
              <span>👑</span>
              <span>+ Tạo Orchestrator mới</span>
            </button>
          </div>
        ) : (
          <>
          {sortedOrchs.map((orch) => {
            const isOrchSelected = selectedAgentId === orch.id || (!selectedAgentId && sortedOrchs[0]?.id === orch.id);
            const isOrchError = orch.status === 'error' || orch.status === 'blocked';
            const isCollapsed = Boolean(collapsed[orch.id]);

            // Tìm các worker thuộc về orchestrator này: Khớp chính xác theo teamId hoặc spawnedBy
            const orchTeamId = orch.teamId || (orch.id === 'orchestrator' ? 'default' : '');
            const childWorkers = safeAgents.filter(a => {
              if (a.id === orch.id || a.type === 'orchestrator' || a.role === 'orchestrator') return false;
              // 1. So khớp chính xác theo teamId
              if (a.teamId && orchTeamId) {
                return a.teamId === orchTeamId;
              }
              // 2. So khớp theo spawnedBy
              if (a.spawnedBy) {
                return a.spawnedBy === orch.id;
              }
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
                  ref={(el) => { agentCardRefs.current[orch.id] = el; }}
                  onClick={() => onSelect(orch.id)}
                  className="interactive-card af-card"
                  style={{
                    background: isOrchError
                      ? 'rgba(239, 68, 68, 0.15)'
                      : isOrchSelected
                      ? 'var(--bg-card-active)'
                      : 'var(--bg-card)',
                    borderRadius: 8,
                    padding: '9px 11px',
                    border: isOrchError
                      ? '1px solid #ef4444'
                      : isOrchSelected
                      ? '2px solid #38bdf8'
                      : '1px solid var(--af-border)',
                    boxShadow: isOrchError
                      ? '0 0 16px rgba(239, 68, 68, 0.25)'
                      : isOrchSelected
                      ? '0 0 16px rgba(56, 189, 248, 0.45)'
                      : 'none',
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
                      <span className="af-card-agent-name" style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        👑 {orch.name || 'Orchestrator'}
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
                      {isOrchSelected && (
                        <span style={{ background: '#0284c7', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>🟢 ĐANG CHỌN</span>
                      )}
                      {renderStatusBadge(orch.status)}
                      {onDeleteAgent && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`Xoá Orchestrator ${orch.name || orch.id}? (Các worker trong team vẫn được giữ lại cho đến khi từng agent bị xóa)`)) {
                              onDeleteAgent(orch.id);
                            }
                          }}
                          title="Xoá Orchestrator này"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--wb-danger, #ef4444)',
                            cursor: 'pointer',
                            padding: '2px 4px',
                            fontSize: 12,
                            fontWeight: 700,
                            borderRadius: 4,
                            transition: 'color 0.15s'
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--wb-danger-strong, #dc2626)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--wb-danger, #ef4444)'; }}
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
                      color: 'var(--wb-info)',
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
                    color: 'var(--wb-purple)',
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

                {/* Orchestrator Tasks if exists */}
                {(() => {
                  const parsedOrchTasks = parseAgentTaskList(orch);
                  if (!Array.isArray(parsedOrchTasks) || parsedOrchTasks.length === 0) return null;
                  return (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      marginTop: 6,
                      padding: '6px 8px',
                      background: orch.status === 'working' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                      borderRadius: 6,
                      border: orch.status === 'working' ? '1px solid rgba(59, 130, 246, 0.45)' : '1px solid var(--af-border)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: orch.status === 'working' ? 'var(--accent, #3b82f6)' : 'var(--text-muted)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span>{orch.status === 'working' ? '⚡ Đang thực thi:' : '🎯 Nhiệm vụ:'}</span>
                        </span>
                      </div>
                      <div style={{ maxHeight: 110, overflowY: 'auto' }}>
                        {renderAgentTaskList(parsedOrchTasks, {
                          agentId: orch.id,
                          onDeleteTask: (tId) => handleDeleteTask(orch.id, tId),
                          deletingTaskId: deletingTaskInfo?.agentId === orch.id ? deletingTaskInfo.taskId : null
                        })}
                      </div>
                    </div>
                  );
                })()}
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
                      color: 'var(--wb-muted)',
                      padding: '10px 12px',
                      background: 'rgba(15, 23, 42, 0.4)',
                      borderRadius: 8,
                      border: '1px dashed var(--af-border-strong)',
                      textAlign: 'center'
                    }}>
                      Chưa có worker nào trong workspace này.
                    </div>
                  ) : (
                    childWorkers.map((agent) => {
                      const isSelected = selectedAgentId === agent.id;
                      const isError = agent.status === 'error' || agent.status === 'blocked';
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
                          ref={(el) => { agentCardRefs.current[agent.id] = el; }}
                          onClick={() => onSelect(agent.id)}
                          className={`interactive-card af-card${agent.status === 'working' ? ' af-working' : ''}`}
                          style={{
                            background: isError
                              ? 'rgba(239, 68, 68, 0.15)'
                              : isSelected
                              ? 'var(--bg-card-active)'
                              : 'var(--bg-card)',
                            borderRadius: 10,
                            padding: 12,
                            border: isError
                              ? '1px solid #ef4444'
                              : isSelected
                              ? '2px solid #38bdf8'
                              : '1px solid var(--af-border)',
                            boxShadow: isError
                              ? '0 0 16px rgba(239, 68, 68, 0.25)'
                              : isSelected
                              ? '0 0 16px rgba(56, 189, 248, 0.45)'
                              : 'none',
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
                                  <span className="af-card-agent-name" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{agent.name}</span>
                                  <span
                                    style={{
                                      fontSize: 11,
                                      color: 'var(--wb-info)',
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
                                  <span style={{ fontSize: 11, color: 'var(--wb-muted)', fontFamily: 'monospace' }}>
                                    {agent.id}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                              {isSelected && (
                                <span style={{ background: '#0284c7', color: '#fff', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>🟢 ĐANG CHỌN</span>
                              )}
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
                                    color: 'var(--wb-muted)',
                                    cursor: 'pointer',
                                    padding: '2px 4px',
                                    fontSize: 13,
                                    borderRadius: 4,
                                    transition: 'color 0.2s'
                                  }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--wb-danger-strong)'; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--wb-muted)'; }}
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          </div>

                          {agent.sessionTitle && (
                            <div style={{
                              fontSize: 12,
                              color: 'var(--wb-success-strong)',
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

                          {(() => {
                            const parsedTasks = parseAgentTaskList(agent);
                            if (!Array.isArray(parsedTasks) || parsedTasks.length === 0) return null;
                            return (
                              <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 4,
                                marginTop: 6,
                                padding: '6px 8px',
                                background: agent.status === 'working' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                                borderRadius: 6,
                                border: agent.status === 'working' ? '1px solid rgba(59, 130, 246, 0.45)' : '1px solid var(--af-border)'
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: agent.status === 'working' ? 'var(--accent, #3b82f6)' : 'var(--text-muted)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <span>{agent.status === 'working' ? '⚡ Đang thực thi:' : '🎯 Nhiệm vụ:'}</span>
                                  </span>
                                </div>
                                <div style={{ maxHeight: 110, overflowY: 'auto' }}>
                                  {renderAgentTaskList(parsedTasks, {
                                    agentId: agent.id,
                                    onDeleteTask: (tId) => handleDeleteTask(agent.id, tId),
                                    deletingTaskId: deletingTaskInfo?.agentId === agent.id ? deletingTaskInfo.taskId : null
                                  })}
                                </div>
                              </div>
                            );
                          })()}

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

          {/* Các Team còn worker nhưng Main Orchestrator đã bị xóa */}
          {orphanTeams.map((teamId) => {
            const teamWorkers = safeAgents.filter(a => {
              if (a.type === 'orchestrator' || a.role === 'orchestrator') return false;
              return (a.teamId || 'default') === teamId;
            });
            if (teamWorkers.length === 0) return null;
            const isTeamCollapsed = Boolean(collapsed[teamId]);

            return (
              <div key={teamId} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* Team Header Card */}
                <div
                  className="interactive-card af-card"
                  style={{
                    background: 'var(--bg-card)',
                    borderRadius: 8,
                    padding: '9px 11px',
                    border: '1px dashed var(--af-border-strong)',
                    width: '100%',
                    maxWidth: '100%',
                    boxSizing: 'border-box',
                    overflow: 'hidden'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>{isTeamCollapsed ? '📁' : '📂'}</span>
                      <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        👥 Team Workspace ({teamId})
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
                        ({teamWorkers.length} workers)
                      </span>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapse(teamId);
                      }}
                      title={isTeamCollapsed ? "Mở rộng Workspace" : "Thu gọn Workspace"}
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
                          transform: isTeamCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                          transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
                        }}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Main Orchestrator đã xóa. Team tự giải tán khi tất cả worker bị xóa.
                  </div>
                </div>

                {/* Danh sách Worker thuộc Team này */}
                {!isTeamCollapsed && (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    paddingLeft: 16,
                    marginLeft: 8,
                    borderLeft: '2px solid rgba(148, 163, 184, 0.15)'
                  }}>
                    {teamWorkers.map((agent) => {
                      const isSelected = selectedAgentId === agent.id;
                      const isError = agent.status === 'error' || agent.status === 'blocked';
                      const roleIcon = getRoleIcon(agent.role);
                      const agentRawTokens = agent.contextLength || (agent.tokenUsage && typeof agent.tokenUsage === 'object' ? ((agent.tokenUsage as any).totalTokens || (agent.tokenUsage as any).total) : agent.tokenUsage);
                      const agentTokens = formatTokens(agentRawTokens);

                      return (
                        <div
                          key={agent.id}
                          ref={(el) => { agentCardRefs.current[agent.id] = el; }}
                          onClick={() => onSelect(agent.id)}
                          className={`interactive-card af-card${agent.status === 'working' ? ' af-working' : ''}`}
                          style={{
                            background: isError
                              ? 'rgba(239, 68, 68, 0.15)'
                              : isSelected
                              ? 'var(--bg-card-active)'
                              : 'var(--bg-card)',
                            borderRadius: 10,
                            padding: 12,
                            border: isError
                              ? '1px solid #ef4444'
                              : isSelected
                              ? '2px solid #38bdf8'
                              : '1px solid var(--af-border)',
                            boxShadow: isError
                              ? '0 0 16px rgba(239, 68, 68, 0.25)'
                              : isSelected
                              ? '0 0 16px rgba(56, 189, 248, 0.45)'
                              : 'none',
                            cursor: 'pointer',
                            width: '100%',
                            boxSizing: 'border-box'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 6 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                              <span style={{ fontSize: 16, flexShrink: 0 }}>{roleIcon}</span>
                              <span className="af-card-agent-name" style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {agent.name || agent.role}
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                              {isSelected && (
                                <span style={{ background: '#0284c7', color: '#fff', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>🟢 ĐANG CHỌN</span>
                              )}
                              {renderStatusBadge(agent.status)}
                              {onDeleteAgent && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (window.confirm(`Xoá agent ${agent.name || agent.id}?`)) {
                                      onDeleteAgent(agent.id);
                                    }
                                  }}
                                  title="Xoá Agent này"
                                  style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--wb-danger, #ef4444)',
                                    cursor: 'pointer',
                                    padding: '2px 4px',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    borderRadius: 4
                                  }}
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{agent.role}</span>
                            <span style={{ fontSize: 10.5, color: 'var(--wb-info)', fontFamily: 'monospace' }}>⚡ {agentTokens}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          </>
        )}
      </div>
    </div>
  );
}
