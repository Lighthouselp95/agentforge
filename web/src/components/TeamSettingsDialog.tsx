import React, { useState, useEffect } from 'react';

export interface RoleSetting {
  role: string;
  maxAgents: number;
  taskLimit: number;
}

export interface TeamSettingsData {
  teamId: string;
  liveCheckEnabled: boolean;
  roleLimits: Record<string, { maxAgents: number; taskLimit: number }>;
}

export const DEFAULT_ROLE_SETTINGS: Record<string, { maxAgents: number; taskLimit: number }> = {
  coder: { maxAgents: 4, taskLimit: 6 },
  researcher: { maxAgents: 2, taskLimit: 6 },
  verifier: { maxAgents: 1, taskLimit: 6 },
  tester: { maxAgents: 1, taskLimit: 6 },
  reviewer: { maxAgents: 1, taskLimit: 6 },
  docs: { maxAgents: 1, taskLimit: 6 },
  planner: { maxAgents: 1, taskLimit: 6 },
  debugger: { maxAgents: 1, taskLimit: 6 },
  searcher: { maxAgents: 1, taskLimit: 6 },
  idea: { maxAgents: 1, taskLimit: 6 },
  orchestrator: { maxAgents: 1, taskLimit: 6 }
};

interface Props {
  teamId?: string;
  agents?: any[];
  onClose: () => void;
  onSaved?: () => void;
}

export function TeamSettingsDialog({ teamId = 'default', agents = [], onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [liveCheck, setLiveCheck] = useState(true);
  const [maxTeamMembers, setMaxTeamMembers] = useState(15);
  const [autoCleanupCompleted, setAutoCleanupCompleted] = useState(true);
  const [roleSettings, setRoleSettings] = useState<Record<string, { maxAgents: number; taskLimit: number }>>(DEFAULT_ROLE_SETTINGS);
  const [apiError, setApiError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const effectiveTeamId = (teamId && teamId.trim()) ? teamId.trim() : 'default';

  // Tính số agent hiện tại theo role của đúng team này (không tính Main Orchestrator)
  const currentRoleCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    (agents || []).forEach(a => {
      const aTeam = (a.teamId && a.teamId.trim()) ? a.teamId.trim() : 'default';
      const aId = String(a.id || '').trim().toLowerCase();
      // Không tính Main Orchestrator
      if (aTeam === effectiveTeamId && aId !== 'main' && aId !== 'orchestrator') {
        const r = (a.role || a.type || 'worker').toLowerCase().trim();
        counts[r] = (counts[r] || 0) + 1;
      }
    });
    return counts;
  }, [agents, effectiveTeamId]);

  const totalActiveAgents = React.useMemo(() => {
    return Object.values(currentRoleCounts).reduce((sum, n) => sum + n, 0);
  }, [currentRoleCounts]);

  // Load cài đặt theo per-team từ API: /api/teams/:teamId/settings
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setApiError(null);

    const targetUrl = `/api/teams/${encodeURIComponent(effectiveTeamId)}/settings`;

    fetch(targetUrl)
      .then(res => {
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (!mounted) return;
        const s = data?.settings || data;
        if (s) {
          if (s.liveCheckEnabled !== undefined) setLiveCheck(Boolean(s.liveCheckEnabled));
          if (s.maxTeamMembers !== undefined) setMaxTeamMembers(Number(s.maxTeamMembers) || 15);
          if (s.autoCleanupCompleted !== undefined) setAutoCleanupCompleted(Boolean(s.autoCleanupCompleted));
          if (s.roleLimits) {
            setRoleSettings({
              ...DEFAULT_ROLE_SETTINGS,
              ...s.roleLimits
            });
          }
        }
      })
      .catch(err => {
        console.warn(`[TeamSettings] Could not load from server for team ${effectiveTeamId}, using default:`, err.message);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, [effectiveTeamId]);

  // Kiểm tra tính hợp lệ toán học: chỉ không hợp lệ khi < 0 hoặc NaN
  const isInvalidInput = React.useMemo(() => {
    if (isNaN(maxTeamMembers) || maxTeamMembers < 0) return true;
    for (const role of Object.keys(roleSettings)) {
      const item = roleSettings[role];
      if (!item || isNaN(item.maxAgents) || item.maxAgents < 0) return true;
      if (isNaN(item.taskLimit) || item.taskLimit < 0) return true;
    }
    return false;
  }, [maxTeamMembers, roleSettings]);

  const handleMaxAgentsChange = (role: string, val: number) => {
    const parsed = isNaN(val) ? 0 : val;
    const newSettings = {
      ...roleSettings,
      [role]: {
        ...roleSettings[role],
        maxAgents: parsed
      }
    };
    setRoleSettings(newSettings);
  };

  const handleTaskLimitChange = (role: string, val: number) => {
    const parsed = isNaN(val) ? 0 : val;
    const newSettings = {
      ...roleSettings,
      [role]: {
        ...roleSettings[role],
        taskLimit: parsed
      }
    };
    setRoleSettings(newSettings);
  };

  const handleResetDefaults = () => {
    setRoleSettings(DEFAULT_ROLE_SETTINGS);
    setMaxTeamMembers(15);
    setAutoCleanupCompleted(true);
    setLiveCheck(true);
    setSuccessMsg('Đã đặt lại thông số mặc định (bấm Lưu để áp dụng).');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  const handleSave = async () => {
    if (isInvalidInput) {
      setApiError('Không thể lưu: Giới hạn số lượng không được để trống, âm hoặc NaN!');
      return;
    }

    setSaving(true);
    setApiError(null);
    setSuccessMsg(null);

    const payload = {
      teamId: effectiveTeamId,
      liveCheckEnabled: liveCheck,
      maxTeamMembers,
      autoCleanupCompleted,
      roleLimits: roleSettings
    };

    try {
      const res = await fetch(`/api/teams/${encodeURIComponent(effectiveTeamId)}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || `HTTP ${res.status}`);
      }

      setSuccessMsg(`Lưu cấu hình cho Team "${effectiveTeamId}" thành công!`);
      if (onSaved) onSaved();
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: any) {
      setApiError(`Lưu thất bại: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 99999,
      padding: 16
    }}>
      <div style={{
        background: '#0f172a',
        border: '1px solid rgba(59, 130, 246, 0.3)',
        borderRadius: 12,
        width: '100%',
        maxWidth: 760,
        maxHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
        color: '#f8fafc',
        fontFamily: 'inherit'
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>⚙️</span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 800, fontSize: 16, color: '#60a5fa' }}>
                  Team Settings
                </span>
                <span style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  background: 'rgba(59, 130, 246, 0.15)',
                  border: '1px solid rgba(59, 130, 246, 0.35)',
                  color: '#93c5fd',
                  fontSize: 11,
                  fontWeight: 700
                }}>
                  Team: {effectiveTeamId}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                Cấu hình giới hạn thành viên (Team Constraints) &amp; Giới hạn theo Role cho team "{effectiveTeamId}"
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: 20,
              cursor: 'pointer',
              padding: 4
            }}
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Global Constraints Section */}
          <div style={{
            background: 'rgba(30, 41, 59, 0.45)',
            padding: '14px 16px',
            borderRadius: 8,
            border: '1px solid rgba(148, 163, 184, 0.15)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              🛡️ Team Constraints
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              {/* Max Team Members */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600 }}>
                    Tổng thành viên tối đa (Max Team Members) <span style={{ color: '#94a3b8', fontWeight: 400 }}>(không tính Main Orchestrator)</span>
                  </label>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>
                    Hiện có: {totalActiveAgents} agent
                  </span>
                </div>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={maxTeamMembers}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value);
                    const val = isNaN(parsed) ? 0 : parsed;
                    setMaxTeamMembers(val);
                  }}
                  style={{
                    padding: '6px 10px',
                    background: '#1e293b',
                    border: '1px solid rgba(148, 163, 184, 0.3)',
                    borderRadius: 6,
                    color: '#f8fafc',
                    fontSize: 12,
                    outline: 'none',
                    width: '100%',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              {/* Auto Cleanup Completed */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#1e293b', borderRadius: 6, border: '1px solid rgba(148, 163, 184, 0.2)' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1' }}>Tự động dọn task đã xong</div>
                  <div style={{ fontSize: 10.5, color: '#94a3b8' }}>Auto-cleanup completed tasks</div>
                </div>
                <input
                  type="checkbox"
                  checked={autoCleanupCompleted}
                  onChange={(e) => setAutoCleanupCompleted(e.target.checked)}
                  style={{ width: 18, height: 18, cursor: 'pointer', accentColor: '#3b82f6' }}
                />
              </div>
            </div>

            {/* Toggle Live Check */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 10,
              borderTop: '1px solid rgba(148, 163, 184, 0.1)'
            }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: '#e2e8f0' }}>Live check mỗi lần thực hiện</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>Bật kiểm tra tức thời số lượng agent đang chạy trong team</div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={liveCheck}
                  onChange={(e) => setLiveCheck(e.target.checked)}
                  style={{ width: 18, height: 18, cursor: 'pointer', accentColor: '#3b82f6' }}
                />
              </label>
            </div>
          </div>

          {/* Feedback Banners */}
          {apiError && (
            <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#fca5a5', fontSize: 12 }}>
              ❌ {apiError}
            </div>
          )}
          {successMsg && (
            <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(34, 197, 94, 0.2)', border: '1px solid #22c55e', color: '#86efac', fontSize: 12 }}>
              ✅ {successMsg}
            </div>
          )}

          {/* Role Table */}
          {loading ? (
            <div style={{ textAlign: 'center', padding: 30, color: '#94a3b8' }}>⏳ Đang tải cấu hình team...</div>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid rgba(148, 163, 184, 0.15)', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'left' }}>
                <thead>
                  <tr style={{ background: 'rgba(30, 41, 59, 0.8)', borderBottom: '1px solid rgba(148, 163, 184, 0.2)' }}>
                    <th style={{ padding: '10px 14px', color: '#cbd5e1' }}>Role</th>
                    <th style={{ padding: '10px 14px', color: '#cbd5e1' }}>Đang chạy</th>
                    <th style={{ padding: '10px 14px', color: '#cbd5e1' }}>Số agent tối đa</th>
                    <th style={{ padding: '10px 14px', color: '#cbd5e1' }}>Task limit</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(roleSettings).map((role, idx) => {
                    const active = currentRoleCounts[role] || 0;
                    const rowBg = idx % 2 === 0 ? 'rgba(15, 23, 42, 0.4)' : 'rgba(30, 41, 59, 0.2)';

                    return (
                      <tr key={role} style={{ background: rowBg, borderBottom: '1px solid rgba(148, 163, 184, 0.1)' }}>
                        <td style={{ padding: '10px 14px', fontWeight: 700, color: '#38bdf8', textTransform: 'capitalize' }}>
                          {role}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{
                            padding: '2px 8px',
                            borderRadius: 12,
                            background: active > 0 ? 'rgba(34, 197, 94, 0.2)' : 'rgba(148, 163, 184, 0.1)',
                            border: `1px solid ${active > 0 ? 'rgba(34, 197, 94, 0.4)' : 'rgba(148, 163, 184, 0.2)'}`,
                            color: active > 0 ? '#86efac' : '#94a3b8',
                            fontSize: 11,
                            fontWeight: 700
                          }}>
                            {active}
                          </span>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <input
                              type="number"
                              min={0}
                              max={20}
                              value={roleSettings[role]?.maxAgents ?? 0}
                              onChange={(e) => {
                                const parsed = parseInt(e.target.value);
                                handleMaxAgentsChange(role, isNaN(parsed) ? 0 : parsed);
                              }}
                              style={{
                                width: 80,
                                padding: '5px 8px',
                                background: '#1e293b',
                                border: '1px solid rgba(148, 163, 184, 0.3)',
                                borderRadius: 6,
                                color: '#f8fafc',
                                fontSize: 12,
                                outline: 'none'
                              }}
                            />
                            {active > 0 && (
                              <span style={{ color: '#94a3b8', fontSize: 10.5, lineHeight: 1.3 }}>
                                Hiện có: {active} agent
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <input
                            type="number"
                            min={0}
                            max={50}
                            value={roleSettings[role]?.taskLimit ?? 6}
                            onChange={(e) => {
                              const parsed = parseInt(e.target.value);
                              handleTaskLimitChange(role, isNaN(parsed) ? 0 : parsed);
                            }}
                            style={{
                              width: 80,
                              padding: '5px 8px',
                              background: '#1e293b',
                              border: '1px solid rgba(148, 163, 184, 0.3)',
                              borderRadius: 6,
                              color: '#f8fafc',
                              fontSize: 12,
                              outline: 'none'
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer Buttons */}
        <div style={{
          padding: '14px 20px',
          borderTop: '1px solid rgba(148, 163, 184, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(15, 23, 42, 0.8)'
        }}>
          <button
            onClick={handleResetDefaults}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              background: 'transparent',
              border: '1px solid rgba(148, 163, 184, 0.3)',
              color: '#cbd5e1',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            🔄 Reset default
          </button>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={onClose}
              style={{
                padding: '7px 16px',
                borderRadius: 6,
                background: 'rgba(51, 65, 85, 0.5)',
                border: '1px solid rgba(148, 163, 184, 0.2)',
                color: '#e2e8f0',
                fontSize: 12,
                cursor: 'pointer'
              }}
            >
              Đóng
            </button>
            <button
              onClick={handleSave}
              disabled={saving || isInvalidInput}
              style={{
                padding: '7px 18px',
                borderRadius: 6,
                background: '#2563eb',
                border: 'none',
                color: '#ffffff',
                fontSize: 12,
                fontWeight: 700,
                cursor: (saving || isInvalidInput) ? 'not-allowed' : 'pointer',
                opacity: (saving || isInvalidInput) ? 0.6 : 1
              }}
            >
              {saving ? '⏳ Đang lưu...' : '💾 Lưu cài đặt'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
