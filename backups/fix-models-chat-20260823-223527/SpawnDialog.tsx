import React, { useState, useEffect } from 'react';

interface Props {
  onAdd: (config: any) => void;
  onClose: () => void;
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
];

export function SpawnDialog({ onAdd, onClose }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState('acp');
  const [projectDir, setProjectDir] = useState('C:/Users/Hai Dang');
  const [role, setRole] = useState('coder');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    // Load models from API
    setLoadingModels(true);
    fetch('/api/models')
      .then(r => r.json())
      .then(data => {
        if (data.models) setModels(data.models);
      })
      .catch(() => {})
      .finally(() => setLoadingModels(false));
    
    // Load default worker model from localStorage
    const saved = localStorage.getItem('default-worker-model');
    if (saved) setModel(saved);
  }, []);

  useEffect(() => {
    // ESC = close modal and stop propagation
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (e.repeat) return;
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true); // capture phase to intercept before window bubble
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const handleAdd = () => {
    if (!name.trim()) return;
    
    const config = {
      id: 'agent-' + Date.now(),
      name: name.trim(),
      role: role,
      type: type,
      projectDir: projectDir || undefined,
      model: model || undefined
    };

    console.log('Spawning agent:', config);
    onAdd(config);
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1000
    }}>
      <div style={{
        background: '#1a1a1a',
        borderRadius: 12,
        padding: 24,
        width: 440,
        maxHeight: '90vh',
        overflow: 'auto',
        border: '1px solid #333'
      }}>
        <h3 style={{ marginBottom: 16, fontSize: 16, color: '#e0e0e0' }}>Spawn New Agent</h3>

        {/* Name */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>
            Agent Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., code-refactor"
            style={{
              width: '100%',
              background: '#252525',
              color: '#e0e0e0',
              border: '1px solid #333',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 13
            }}
          />
        </div>

        {/* Role */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>
            Role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            style={{
              width: '100%',
              background: '#252525',
              color: '#e0e0e0',
              border: '1px solid #333',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 13
            }}
          >
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        {/* Type */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>
            Type
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setType('acp')}
              style={{
                flex: 1,
                background: type === 'acp' ? '#3b82f6' : '#252525',
                color: type === 'acp' ? 'white' : '#888',
                border: `1px solid ${type === 'acp' ? '#3b82f6' : '#333'}`,
                borderRadius: 6,
                padding: '8px',
                fontSize: 12,
                cursor: 'pointer'
              }}
            >
              🔗 ACP (OpenCode)
            </button>
            <button
              onClick={() => setType('api')}
              style={{
                flex: 1,
                background: type === 'api' ? '#3b82f6' : '#252525',
                color: type === 'api' ? 'white' : '#888',
                border: `1px solid ${type === 'api' ? '#3b82f6' : '#333'}`,
                borderRadius: 6,
                padding: '8px',
                fontSize: 12,
                cursor: 'pointer'
              }}
            >
              🌐 API (LLM)
            </button>
          </div>
        </div>

        {/* Project Dir (ACP only) */}
        {type === 'acp' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>
              Project Directory
            </label>
            <input
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="C:/path/to/project"
              style={{
                width: '100%',
                background: '#252525',
                color: '#e0e0e0',
                border: '1px solid #333',
                borderRadius: 6,
                padding: '8px 10px',
                fontSize: 13
              }}
            />
          </div>
        )}

        {/* Model */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>
            Model (optional — uses default if empty)
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={loadingModels}
            style={{
              width: '100%',
              background: '#252525',
              color: '#e0e0e0',
              border: '1px solid #333',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 13
            }}
          >
            <option value="">— Default (from settings)</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
            {loadingModels && <option disabled>Loading models...</option>}
          </select>
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              background: '#333',
              color: '#e0e0e0',
              border: '1px solid #444',
              borderRadius: 6,
              padding: '8px 16px',
              fontSize: 13,
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!name.trim()}
            style={{
              background: name.trim() ? '#3b82f6' : '#333',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              padding: '8px 16px',
              fontSize: 13,
              cursor: name.trim() ? 'pointer' : 'not-allowed',
              fontWeight: 600
            }}
          >
            Spawn Agent
          </button>
        </div>
      </div>
    </div>
  );
}
