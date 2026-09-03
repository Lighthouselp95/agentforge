import React, { useState, useEffect } from 'react';

interface Agent {
  id: string;
  name: string;
  role: string;
  model?: string;
}

interface Props {
  agents: Agent[];
  onClose: () => void;
  onSaved?: () => void;
}

const STANDARD_ROLES = [
  { value: 'coder', label: '🔨 Coder', desc: 'Lập trình, sửa bug, triển khai code' },
  { value: 'researcher', label: '🔬 Researcher', desc: 'Nghiên cứu tài liệu, phân tích codebase' },
  { value: 'tester', label: '🧪 Tester', desc: 'Viết unit test, kiểm thử chức năng' },
  { value: 'reviewer', label: '🔍 Reviewer', desc: 'Đánh giá chất lượng và kiến trúc code' },
  { value: 'verifier', label: '✅ Verifier', desc: 'Xác minh sự chính xác và chuẩn đầu ra' },
  { value: 'debugger', label: '🐛 Debugger', desc: 'Điều tra nguyên nhân gốc rễ và vết lỗi' },
  { value: 'searcher', label: '🔎 Searcher', desc: 'Tìm kiếm code, tham chiếu và pattern' },
  { value: 'idea', label: '💡 Idea', desc: 'Đề xuất giải pháp và ý tưởng sáng tạo' },
  { value: 'planner', label: '📋 Planner', desc: 'Lập kế hoạch phân rã công việc' },
  { value: 'docs', label: '📝 Docs', desc: 'Viết tài liệu kỹ thuật' }
];

export function ModelSettingsDialog({ agents, onClose, onSaved }: Props) {
  const [orchestratorModel, setOrchestratorModel] = useState('');
  const [defaultSubagentModel, setDefaultSubagentModel] = useState('');
  const [agentModelOverrides, setAgentModelOverrides] = useState<Record<string, string>>({});
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const API = window.location.port === '5173' ? '' : (window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:4001');
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        let isCacheFresh = false;
        try {
          const raw = localStorage.getItem('af-models-cache');
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed?.models) && parsed.models.length > 0) {
              setModels(parsed.models);
              if (typeof parsed.timestamp === 'number' && Date.now() - parsed.timestamp < 5 * 60 * 1000) {
                isCacheFresh = true;
              }
            }
          }
        } catch {}

        // Song song hóa 2 API calls bằng Promise.all
        const fetchModelsPromise = isCacheFresh
          ? Promise.resolve(null)
          : fetch(`${API}/api/models`).then(r => r.ok ? r.json() : null).catch(() => null);

        const fetchSettingsPromise = fetch(`${API}/api/settings/models`)
          .then(r => r.ok ? r.json() : null)
          .catch(() => null);

        const [modelsData, settingsData] = await Promise.all([
          fetchModelsPromise,
          fetchSettingsPromise
        ]);

        if (modelsData) {
          const modelList: string[] = [];
          if (Array.isArray(modelsData.models)) {
            modelList.push(...modelsData.models);
          } else if (Array.isArray(modelsData.providers)) {
            for (const p of modelsData.providers) {
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

        if (settingsData) {
          setOrchestratorModel(settingsData.orchestratorModel || '');
          setDefaultSubagentModel(settingsData.defaultSubagentModel || '');
          setAgentModelOverrides(settingsData.agentModelOverrides || {});
        }
      } catch (e) {
        console.error('Failed to load model settings:', e);
      } finally {
        setLoading(false);
      }
    };
    loadData();
  }, []);

  const handleRoleOverrideChange = (role: string, model: string) => {
    const updated = { ...agentModelOverrides };
    if (!model) {
      delete updated[`role:${role}`];
      delete updated[role];
    } else {
      updated[`role:${role}`] = model;
      delete updated[role];
    }
    setAgentModelOverrides(updated);
  };

  const handleAgentOverrideChange = (agentId: string, model: string) => {
    const updated = { ...agentModelOverrides };
    if (!model) {
      delete updated[agentId];
    } else {
      updated[agentId] = model;
    }
    setAgentModelOverrides(updated);
  };

  const getRoleModel = (role: string): string => {
    return agentModelOverrides[`role:${role}`] || agentModelOverrides[role] || '';
  };

  const getAgentModel = (agentId: string): string => {
    return agentModelOverrides[agentId] || '';
  };

  const handleSave = async () => {
    setSaving(true);
    setSavedSuccess(false);
    try {
      const payload = {
        orchestratorModel: orchestratorModel || null,
        defaultSubagentModel: defaultSubagentModel || null,
        agentModelOverrides
      };

      const res = await fetch(`${API}/api/settings/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setSavedSuccess(true);
        if (onSaved) onSaved();
        setTimeout(() => {
          setSavedSuccess(false);
          onClose();
        }, 600);
      }
    } catch (e) {
      console.error('Failed to save model settings:', e);
    } finally {
      setSaving(false);
    }
  };

  const workerAgents = (agents || []).filter(a => a.id !== 'orchestrator');

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
        width: 600,
        maxWidth: '92vw',
        maxHeight: '90vh',
        overflow: 'auto',
        border: '1px solid var(--af-border-strong)',
        boxShadow: '0 20px 45px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--bg-inset)', paddingBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)', fontWeight: 700, letterSpacing: '-0.01em' }}>
              ⚙️ Cấu hình Phân cấp Model (Model Hierarchy)
            </h3>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
              Thứ tự ưu tiên: Instance Override → Role Override → Default Subagent Model → System Default
            </div>
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

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            ⏳ Đang tải danh sách model và cấu hình...
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* 1. Global Hierarchy Settings */}
            <div style={{ background: 'var(--bg-inset)', borderRadius: 10, padding: 14, border: '1px solid var(--af-border-strong)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)', marginBottom: 12 }}>
                🌐 Model Cốt lõi & Mặc định
              </div>

              {/* Orchestrator Model */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                  👑 Orchestrator Model (Model điều phối chính)
                </label>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Dùng để tiếp nhận yêu cầu từ người dùng, lập kế hoạch và điều phối các worker.
                </div>
                <select
                  value={orchestratorModel}
                  onChange={(e) => setOrchestratorModel(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'var(--bg-panel)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--af-border-strong)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 12,
                    outline: 'none'
                  }}
                >
                  <option value="">— Mặc định hệ thống (System Default / process.env) —</option>
                  {models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              {/* Default Subagent Model */}
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                  👥 Default Subagent Model (Model chung cho Workers)
                </label>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Các worker / subagent sẽ tự động kế thừa model này nếu không có cấu hình riêng.
                </div>
                <select
                  value={defaultSubagentModel}
                  onChange={(e) => setDefaultSubagentModel(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'var(--bg-panel)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--af-border-strong)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 12,
                    outline: 'none'
                  }}
                >
                  <option value="">— Kế thừa Orchestrator Model / System Default —</option>
                  {models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 2. Role Overrides */}
            <div style={{ background: 'var(--bg-inset)', borderRadius: 10, padding: 14, border: '1px solid var(--af-border-strong)' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--wb-success-strong)', marginBottom: 4 }}>
                🎭 Ghi đè Model theo Role (Role Overrides)
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                Tối ưu hóa model phù hợp theo tính chất từng vai trò.
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto', paddingRight: 4 }}>
                {STANDARD_ROLES.map(r => {
                  const currentModel = getRoleModel(r.value);
                  return (
                    <div key={r.value} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-panel)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--af-border-strong)' }}>
                      <div style={{ flex: 1, paddingRight: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{r.label}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.desc}</div>
                      </div>
                      <select
                        value={currentModel}
                        onChange={(e) => handleRoleOverrideChange(r.value, e.target.value)}
                        style={{
                          width: 220,
                          background: currentModel ? 'var(--accent-strong)' : 'var(--bg-inset)',
                          color: 'var(--text-primary)',
                          border: currentModel ? '1px solid var(--accent)' : '1px solid var(--af-border-strong)',
                          borderRadius: 6,
                          padding: '6px 8px',
                          fontSize: 11,
                          outline: 'none'
                        }}
                      >
                        <option value="">— Kế thừa ({defaultSubagentModel || orchestratorModel || 'Default'}) —</option>
                        {models.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 3. Active Agent Overrides */}
            {workerAgents.length > 0 && (
              <div style={{ background: 'var(--bg-inset)', borderRadius: 10, padding: 14, border: '1px solid var(--af-border-strong)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--wb-warn)', marginBottom: 4 }}>
                  🎯 Ghi đè theo Instance Agent Đang chạy
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Cài đặt model riêng cho từng thực thể agent đang hoạt động.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 180, overflowY: 'auto', paddingRight: 4 }}>
                  {workerAgents.map(a => {
                    const currentModel = a.model || getAgentModel(a.id);
                    return (
                      <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-panel)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--af-border-strong)' }}>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                            {a.name} <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>({a.id})</span>
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Vai trò: {a.role}</div>
                        </div>
                        <select
                          value={currentModel}
                          onChange={(e) => handleAgentOverrideChange(a.id, e.target.value)}
                          style={{
                            width: 220,
                            background: currentModel ? 'var(--accent-strong)' : 'var(--bg-inset)',
                            color: 'var(--text-primary)',
                            border: currentModel ? '1px solid var(--accent)' : '1px solid var(--af-border-strong)',
                            borderRadius: 6,
                            padding: '6px 8px',
                            fontSize: 11,
                            outline: 'none'
                          }}
                        >
                          <option value="">— Kế thừa theo Role / Default —</option>
                          {models.map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, borderTop: '1px solid var(--bg-inset)', paddingTop: 14 }}>
          {savedSuccess && (
            <span style={{ fontSize: 12, color: 'var(--wb-success-strong)', marginRight: 'auto', fontWeight: 600 }}>
              ✓ Đã lưu cấu hình thành công!
            </span>
          )}
          <button
            onClick={onClose}
            style={{
              background: 'var(--bg-inset)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--af-border-strong)',
              borderRadius: 8,
              padding: '8px 16px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: 500
            }}
          >
            Đóng
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={{
              background: saving ? 'var(--accent-strong)' : 'linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%)',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              padding: '8px 20px',
              fontSize: 12,
              fontWeight: 600,
              cursor: saving || loading ? 'wait' : 'pointer',
              boxShadow: '0 2px 10px rgba(37, 99, 235, 0.3)'
            }}
          >
            {saving ? 'Đang lưu...' : '💾 Lưu Cài đặt'}
          </button>
        </div>
      </div>
    </div>
  );
}
