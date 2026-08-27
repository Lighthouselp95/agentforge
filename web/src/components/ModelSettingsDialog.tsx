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
  const [models, setModels] = useState<string[]>([]);
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

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        const modelsRes = await fetch('/api/models');
        const modelsData = await modelsRes.json();
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
        setModels(modelList);

        const settingsRes = await fetch('/api/settings/models');
        if (settingsRes.ok) {
          const settingsData = await settingsRes.json();
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

      const res = await fetch('/api/settings/models', {
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
        background: '#0f172a',
        borderRadius: 16,
        padding: 24,
        width: 600,
        maxWidth: '92vw',
        maxHeight: '90vh',
        overflow: 'auto',
        border: '1px solid #334155',
        boxShadow: '0 20px 45px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #1e293b', paddingBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, color: '#f8fafc', fontWeight: 700, letterSpacing: '-0.01em' }}>
              ⚙️ Cấu hình Phân cấp Model (Model Hierarchy)
            </h3>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 3 }}>
              Thứ tự ưu tiên: Instance Override → Role Override → Default Subagent Model → System Default
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: 16,
              cursor: 'pointer',
              padding: 4
            }}
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
            ⏳ Đang tải danh sách model và cấu hình...
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* 1. Global Hierarchy Settings */}
            <div style={{ background: '#1e293b', borderRadius: 10, padding: 14, border: '1px solid #334155' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', marginBottom: 12 }}>
                🌐 Model Cốt lõi & Mặc định
              </div>

              {/* Orchestrator Model */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9', display: 'block', marginBottom: 4 }}>
                  👑 Orchestrator Model (Model điều phối chính)
                </label>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
                  Dùng để tiếp nhận yêu cầu từ người dùng, lập kế hoạch và điều phối các worker.
                </div>
                <select
                  value={orchestratorModel}
                  onChange={(e) => setOrchestratorModel(e.target.value)}
                  style={{
                    width: '100%',
                    background: '#0f172a',
                    color: '#f8fafc',
                    border: '1px solid #334155',
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
                <label style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9', display: 'block', marginBottom: 4 }}>
                  👥 Default Subagent Model (Model chung cho Workers)
                </label>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
                  Các worker / subagent sẽ tự động kế thừa model này nếu không có cấu hình riêng.
                </div>
                <select
                  value={defaultSubagentModel}
                  onChange={(e) => setDefaultSubagentModel(e.target.value)}
                  style={{
                    width: '100%',
                    background: '#0f172a',
                    color: '#f8fafc',
                    border: '1px solid #334155',
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
            <div style={{ background: '#1e293b', borderRadius: 10, padding: 14, border: '1px solid #334155' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#34d399', marginBottom: 4 }}>
                🎭 Ghi đè Model theo Role (Role Overrides)
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>
                Tối ưu hóa model phù hợp theo tính chất từng vai trò.
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto', paddingRight: 4 }}>
                {STANDARD_ROLES.map(r => {
                  const currentModel = getRoleModel(r.value);
                  return (
                    <div key={r.value} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#0f172a', padding: '8px 10px', borderRadius: 8, border: '1px solid #334155' }}>
                      <div style={{ flex: 1, paddingRight: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#f8fafc' }}>{r.label}</div>
                        <div style={{ fontSize: 10, color: '#94a3b8' }}>{r.desc}</div>
                      </div>
                      <select
                        value={currentModel}
                        onChange={(e) => handleRoleOverrideChange(r.value, e.target.value)}
                        style={{
                          width: 220,
                          background: currentModel ? '#1e3a8a' : '#1e293b',
                          color: '#f8fafc',
                          border: currentModel ? '1px solid #3b82f6' : '1px solid #334155',
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
              <div style={{ background: '#1e293b', borderRadius: 10, padding: 14, border: '1px solid #334155' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', marginBottom: 4 }}>
                  🎯 Ghi đè theo Instance Agent Đang chạy
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>
                  Cài đặt model riêng cho từng thực thể agent đang hoạt động.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 180, overflowY: 'auto', paddingRight: 4 }}>
                  {workerAgents.map(a => {
                    const currentModel = a.model || getAgentModel(a.id);
                    return (
                      <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#0f172a', padding: '8px 10px', borderRadius: 8, border: '1px solid #334155' }}>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: '#f8fafc' }}>
                            {a.name} <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>({a.id})</span>
                          </div>
                          <div style={{ fontSize: 10, color: '#94a3b8' }}>Vai trò: {a.role}</div>
                        </div>
                        <select
                          value={currentModel}
                          onChange={(e) => handleAgentOverrideChange(a.id, e.target.value)}
                          style={{
                            width: 220,
                            background: currentModel ? '#1e3a8a' : '#1e293b',
                            color: '#f8fafc',
                            border: currentModel ? '1px solid #3b82f6' : '1px solid #334155',
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, borderTop: '1px solid #1e293b', paddingTop: 14 }}>
          {savedSuccess && (
            <span style={{ fontSize: 12, color: '#4ade80', marginRight: 'auto', fontWeight: 600 }}>
              ✓ Đã lưu cấu hình thành công!
            </span>
          )}
          <button
            onClick={onClose}
            style={{
              background: '#1e293b',
              color: '#cbd5e1',
              border: '1px solid #334155',
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
              background: saving ? '#2563eb' : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
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
