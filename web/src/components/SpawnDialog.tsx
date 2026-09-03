import React, { useState, useEffect } from 'react';

interface Props {
  onAdd: (config: any) => void;
  onClose: () => void;
  agents?: any[];
  defaultSpawnedBy?: string | null;
}

const ROLES = [
  { value: 'coder', label: '🔨 Coder — Write code, implement features' },
  { value: 'reviewer', label: '🔍 Reviewer — Review code quality' },
  { value: 'tester', label: '🧪 Tester — Write and run tests' },
  { value: 'docs', label: '📝 Docs — Write documentation' },
  { value: 'planner', label: '📋 Planner — Analyze and plan' },
  { value: 'researcher', label: '🔬 Researcher — Find info, read docs, explore codebases' },
  { value: 'verifier', label: '✅ Verifier — Validate code correctness' },
  { value: 'debugger', label: '🐛 Debugger — Trace bugs, find root causes' },
  { value: 'searcher', label: '🔎 Searcher — Find files, code patterns, references' },
  { value: 'idea', label: '💡 Idea — Generate creative ideas, features, solutions' },
  { value: 'orchestrator', label: '👑 Orchestrator — Sub-Orchestrator coordinator' },
];

export function SpawnDialog({ onAdd, onClose, agents = [], defaultSpawnedBy }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState('acp');
  const [projectDir, setProjectDir] = useState('.');
  const [role, setRole] = useState('coder');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [spawnedBy, setSpawnedBy] = useState(defaultSpawnedBy || 'orchestrator');

  const orchList = [
    { id: 'orchestrator', name: 'Main Orchestrator' },
    ...agents.filter(a => (a.type === 'orchestrator' || a.role === 'orchestrator') && a.id !== 'orchestrator')
  ];

  useEffect(() => {
    if (defaultSpawnedBy) setSpawnedBy(defaultSpawnedBy);
  }, [defaultSpawnedBy]);

  const API = window.location.port === '5173' ? '' : (window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:4001');
  useEffect(() => {
    setLoadingModels(true);
    fetch(`${API}/api/models`)
      .then(r => r.json())
      .then(data => {
        if (data.models) setModels(data.models);
      })
      .catch(() => {})
      .finally(() => setLoadingModels(false));
    
    const saved = localStorage.getItem('default-worker-model');
    if (saved) setModel(saved);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (e.repeat) return;
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const handleAdd = () => {
    if (!name.trim()) return;
    
    const config = {
      id: 'agent-' + Date.now(),
      name: name.trim(),
      role: role,
      type: role === 'orchestrator' ? 'orchestrator' : type,
      spawnedBy: role === 'orchestrator' ? undefined : (spawnedBy || 'orchestrator'),
      projectDir: projectDir || undefined,
      model: model || undefined
    };

    onAdd(config);
  };

  return (
    <div className="af-overlay" style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(8px)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1000
    }}>
      <div className="fade-in af-dialog-box" style={{
        background: 'var(--bg-panel)',
        borderRadius: 16,
        padding: 24,
        width: 480,
        maxWidth: '92vw',
        maxHeight: '90vh',
        overflow: 'auto',
        border: '1px solid var(--af-border-strong)',
        boxShadow: '0 20px 45px rgba(0, 0, 0, 0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--bg-inset)', paddingBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20 }}>✨</span>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
              Spawn New Worker Agent
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: 16,
              cursor: 'pointer',
              padding: 4
            }}
          >
            ✕
          </button>
        </div>

        {/* Name */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Agent Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., code_refactor, ui_coder, test_runner"
            style={{
              width: '100%',
              background: 'var(--bg-inset)',
              color: 'var(--text-primary)',
              border: '1px solid var(--af-border-strong)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              outline: 'none',
              transition: 'border-color 0.2s'
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--af-border-strong)'; }}
          />
        </div>

        {/* Parent Orchestrator / Team */}
        {role !== 'orchestrator' && (
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Parent Orchestrator / Team
            </label>
            <select
              value={spawnedBy}
              onChange={(e) => setSpawnedBy(e.target.value)}
              style={{
                width: '100%',
                background: 'var(--bg-inset)',
                color: 'var(--text-primary)',
                border: '1px solid var(--af-border-strong)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 13,
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              {orchList.map(o => (
                <option key={o.id} value={o.id}>
                  👑 {o.name || 'Orchestrator'} ({o.id})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Role */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Specialized Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--bg-inset)',
              color: 'var(--text-primary)',
              border: '1px solid var(--af-border-strong)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        {/* Type */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Execution Protocol
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => setType('acp')}
              style={{
                flex: 1,
                background: type === 'acp' ? 'rgba(59, 130, 246, 0.2)' : 'var(--bg-inset)',
                color: type === 'acp' ? 'var(--accent)' : 'var(--text-muted)',
                border: `1px solid ${type === 'acp' ? 'var(--accent)' : 'var(--af-border-strong)'}`,
                borderRadius: 8,
                padding: '10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              🔗 OpenCode ACP
            </button>
            <button
              onClick={() => setType('api')}
              style={{
                flex: 1,
                background: type === 'api' ? 'rgba(59, 130, 246, 0.2)' : 'var(--bg-inset)',
                color: type === 'api' ? 'var(--accent)' : 'var(--text-muted)',
                border: `1px solid ${type === 'api' ? 'var(--accent)' : 'var(--af-border-strong)'}`,
                borderRadius: 8,
                padding: '10px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              🌐 Direct LLM API
            </button>
          </div>
        </div>

        {/* Project Dir (ACP only) */}
        {type === 'acp' && (
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
              Working Directory
            </label>
            <input
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="./path/to/project"
              style={{
                width: '100%',
                background: 'var(--bg-inset)',
                color: 'var(--text-primary)',
                border: '1px solid var(--af-border-strong)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 13,
                outline: 'none'
              }}
            />
          </div>
        )}

        {/* Model */}
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Dedicated Model (Optional)
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={loadingModels}
            style={{
              width: '100%',
              background: 'var(--bg-inset)',
              color: 'var(--text-primary)',
              border: '1px solid var(--af-border-strong)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            <option value="">— Inherit Role / Default Subagent Model —</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
            {loadingModels && <option disabled>Loading available models...</option>}
          </select>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid var(--bg-inset)', paddingTop: 14 }}>
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg-inset)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--af-border-strong)',
              borderRadius: 8,
              padding: '8px 16px',
              fontSize: 13,
              cursor: 'pointer',
              fontWeight: 500
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!name.trim()}
            style={{
              background: name.trim() ? 'linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%)' : 'var(--af-border-strong)',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              padding: '8px 20px',
              fontSize: 13,
              cursor: name.trim() ? 'pointer' : 'not-allowed',
              fontWeight: 600,
              boxShadow: name.trim() ? '0 2px 10px rgba(37, 99, 235, 0.3)' : 'none'
            }}
          >
            ✨ Spawn Agent
          </button>
        </div>
      </div>
    </div>
  );
}
