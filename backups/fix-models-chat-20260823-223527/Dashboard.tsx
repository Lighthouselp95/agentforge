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

export function Dashboard({ agents, onStart, onSpawn, onSelect, selectedAgentId, onUpdateModel, onDeleteAgent }: Props) {
  const [models, setModels] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const safeAgents = Array.isArray(agents) ? agents : [];

  useEffect(() => {
    const loadModels = async () => {
      setModelLoading(true);
      try {
        const res = await fetch('http://localhost:3001/api/models');
        const data = await res.json();
        if (data.models) setModels(data.models);
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
    <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12
      }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Agents ({safeAgents.length})</span>
        <button
          onClick={onSpawn}
          style={{
            background: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          + Spawn
        </button>
      </div>

      {/* Orchestrator button */}
      <div
        onClick={() => onSelect(null)}
        style={{
          background: selectedAgentId === null ? '#333' : '#252525',
          borderRadius: 8,
          padding: 12,
          marginBottom: 8,
          border: selectedAgentId === null ? '1px solid #3b82f6' : '1px solid #333',
          cursor: 'pointer'
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>🤖 Orchestrator <span style={{fontSize: 11, color: '#888', fontFamily: 'monospace', marginLeft: 8}}>(orchestrator)</span></div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>Main agent — all messages</div>
        {models.length > 0 && (
          <select
            value={safeAgents.find(a => a.id === 'orchestrator')?.model || ''}
            onChange={(e) => handleModelChange('orchestrator', e.target.value)}
            disabled={modelLoading}
            style={{
              marginTop: 8,
              width: '100%',
              background: '#1a1a1a',
              color: '#e0e0e0',
              border: '1px solid #333',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 11
            }}
          >
            <option value="">— Default (inherit main)</option>
            {models.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}
      </div>

      {safeAgents.length === 0 ? (
        <div style={{
          textAlign: 'center',
          color: '#666',
          padding: 40,
          fontSize: 13
        }}>
          No agents yet.<br />
          Click "Spawn" to add one.
        </div>
      ) : (
        safeAgents.map(agent => {
          const isSelected = selectedAgentId === agent.id;
          const statusColor = agent.status === 'working' ? '#4ade80' : agent.status === 'error' ? '#f87171' : '#666';
          return (
            <div
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              style={{
                background: isSelected ? '#333' : '#252525',
                borderRadius: 8,
                padding: 12,
                marginBottom: 8,
                border: isSelected ? '1px solid #3b82f6' : '1px solid #333',
                cursor: 'pointer'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{agent.name} <span style={{fontSize: 11, color: '#888', fontFamily: 'monospace', marginLeft: 8}}>({agent.id})</span></div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{agent.role}</div>
                  {agent.sessionTitle && (
                    <div style={{ fontSize: 11, color: '#4ade80', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                      💬 {agent.sessionTitle}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ fontSize: 12, color: statusColor, fontWeight: 600 }}>
                    ● {agent.status}
                  </div>
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
                        color: '#666',
                        cursor: 'pointer',
                        padding: '2px 4px',
                        fontSize: 12,
                        borderRadius: 4
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ef4444'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#666'; }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
              {agent.task && (
                <div style={{ fontSize: 12, color: '#666', marginTop: 6, lineHeight: 1.3 }}>
                  {agent.task.substring(0, 80)}{agent.task.length > 80 ? '...' : ''}
                </div>
              )}
              {models.length > 0 && (
                <select
                  value={agent.model || ''}
                  onChange={(e) => {
                    e.stopPropagation(); // Don't trigger agent selection
                    handleModelChange(agent.id, e.target.value);
                  }}
                  disabled={modelLoading}
                  style={{
                    marginTop: 8,
                    width: '100%',
                    background: '#1a1a1a',
                    color: '#e0e0e0',
                    border: '1px solid #333',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11
                  }}
                >
                  <option value="">— Default (inherit main)</option>
                  {models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
