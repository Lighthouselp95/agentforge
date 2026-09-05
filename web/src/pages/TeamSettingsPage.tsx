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
  onBack?: () => void;
  onSaved?: () => void;
}

export function TeamSettingsPage({ teamId = 'default', agents = [], onBack, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [liveCheck, setLiveCheck] = useState(true);
  const [roleSettings, setRoleSettings] = useState<Record<string, { maxAgents: number; taskLimit: number }>>(DEFAULT_ROLE_SETTINGS);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Tính số agent hiện tại theo role trong team này
  const currentRoleCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    (agents || []).forEach(a => {
      const aTeam = a.teamId || 'default';
      if (aTeam === teamId) {
        const r = (a.role || a.type || 'worker').toLowerCase().trim();
        counts[r] = (counts[r] || 0) + 1;
      }
    });
    return counts;
  }, [agents, teamId]);

  // Load cài đặt hiện tại từ API
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setApiError(null);

    fetch(`/api/teams/${encodeURIComponent(teamId)}/settings`)
      .then(res => {
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (!mounted) return;
        if (data && data.settings) {
          setLiveCheck(data.settings.liveCheckEnabled ?? true);
          if (data.settings.roleLimits) {
            setRoleSettings({
              ...DEFAULT_ROLE_SETTINGS,
              ...data.settings.roleLimits
            });
          }
        }
      })
      .catch(err => {
        console.warn('[TeamSettingsPage] Could not load from server, using default:', err.message);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, [teamId]);

  // Live validation
  const validateLive = (settings: Record<string, { maxAgents: number; taskLimit: number }>) => {
    if (!liveCheck) {
      setValidationErrors({});
      return true;
    }

    const errors: Record<string, string> = {};
    let hasError = false;

    Object.keys(settings).forEach(role => {
      const activeCount = currentRoleCounts[role] || 0;
      const limit = settings[role]?.maxAgents ?? 1;
      if (activeCount > limit) {
        errors[role] = `Đang có ${activeCount} agent đang chạy, vượt mức giới hạn mới (${limit})!`;
        hasError = true;
      }
    });

    setValidationErrors(errors);
    return !hasError;
  };

  const handleMaxAgentsChange = (role: string, val: number) => {
    const newSettings = {
      ...roleSettings,
      [role]: {
        ...roleSettings[role],
        maxAgents: Math.max(1, val)
      }
    };
    setRoleSettings(newSettings);
    validateLive(newSettings);
  };

  const handleTaskLimitChange = (role: string, val: number) => {
    const newSettings = {
      ...roleSettings,
      [role]: {
        ...roleSettings[role],
        taskLimit: Math.max(1, val)
      }
    };
    setRoleSettings(newSettings);
  };

  const handleResetDefaults = () => {
    setRoleSettings(DEFAULT_ROLE_SETTINGS);
    validateLive(DEFAULT_ROLE_SETTINGS);
    setSuccessMsg('Đã đặt lại thông số mặc định (bấm Lưu để áp dụng).');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  const handleSave = async () => {
    if (!validateLive(roleSettings)) {
      setApiError('Không thể lưu: Có vai trò bị vượt quá giới hạn số agent đang chạy hiện tại!');
      return;
    }

    setSaving(true);
    setApiError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamId,
          liveCheckEnabled: liveCheck,
          roleLimits: roleSettings
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.error || `HTTP ${res.status}`);
      }

      setSuccessMsg('Lưu cấu hình Team Settings thành công!');
      if (onSaved) onSaved();
      if (onBack) {
        setTimeout(() => onBack(), 700);
      }
    } catch (err: any) {
      setApiError(`Lưu thất bại: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-main, #0b1120)',
      color: '#f8fafc',
      padding: 24,
      boxSizing: 'border-box',
      overflowY: 'auto'
    }}>
      {/* Page Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: 20,
        borderBottom: '1px solid rgba(148, 163, 184, 0.15)',
        marginBottom: 20
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onBack && (
            <button
              onClick={onBack}
              style={{
                background: 'rgba(30, 41, 59, 0.6)',
                border: '1px solid rgba(148, 163, 184, 0.2)',
                color: '#94a3b8',
                borderRadius: 6,
                padding: '6px 12px',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600
              }}
            >
              ← Quay lại
            </button>
          )}
          <span style={{ fontSize: 24 }}>👥</span>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#60a5fa' }}>
              Team Settings & Role Limits Live
            </h1>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
              Cấu hình giới hạn Agent tối đa & Task limit cho Team: <span style={{ color: '#38bdf8', fontWeight: 700 }}>{teamId}</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={handleResetDefaults}
            style={{
              padding: '7px 14px',
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
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '7px 18px',
              borderRadius: 6,
              background: '#2563eb',
              border: 'none',
              color: '#ffffff',
              fontSize: 12,
              fontWeight: 700,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1
            }}
          >
            {saving ? '⏳ Đang lưu...' : '💾 Lưu cấu hình'}
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 900 }}>
        {/* Toggle Live Check */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(30, 41, 59, 0.45)',
          padding: '12px 16px',
          borderRadius: 8,
          border: '1px solid rgba(148, 163, 184, 0.15)'
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0' }}>Live check mỗi lần thực hiện</div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
              Tự động kiểm tra trực tiếp với số lượng agent đang chạy, ngăn chặn việc hạ giới hạn thấp hơn số agent đang active.
            </div>
          </div>
          <input
            type="checkbox"
            checked={liveCheck}
            onChange={(e) => {
              setLiveCheck(e.target.checked);
              if (e.target.checked) validateLive(roleSettings);
              else setValidationErrors({});
            }}
            style={{ width: 20, height: 20, cursor: 'pointer', accentColor: '#3b82f6' }}
          />
        </div>

        {/* Status Alerts */}
        {apiError && (
          <div style={{ padding: '10px 14px', borderRadius: 6, background: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#fca5a5', fontSize: 12 }}>
            ❌ {apiError}
          </div>
        )}
        {successMsg && (
          <div style={{ padding: '10px 14px', borderRadius: 6, background: 'rgba(34, 197, 94, 0.2)', border: '1px solid #22c55e', color: '#86efac', fontSize: 12 }}>
            ✅ {successMsg}
          </div>
        )}

        {/* Table View */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>⏳ Đang tải cấu hình team...</div>
        ) : (
          <div style={{ border: '1px solid rgba(148, 163, 184, 0.15)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'left' }}>
              <thead>
                <tr style={{ background: 'rgba(30, 41, 59, 0.75)', borderBottom: '1px solid rgba(148, 163, 184, 0.2)' }}>
                  <th style={{ padding: '12px 16px', color: '#cbd5e1' }}>Role</th>
                  <th style={{ padding: '12px 16px', color: '#cbd5e1' }}>Đang chạy</th>
                  <th style={{ padding: '12px 16px', color: '#cbd5e1' }}>Số agent tối đa</th>
                  <th style={{ padding: '12px 16px', color: '#cbd5e1' }}>Task limit</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(roleSettings).map((role, idx) => {
                  const active = currentRoleCounts[role] || 0;
                  const err = validationErrors[role];
                  const rowBg = idx % 2 === 0 ? 'rgba(15, 23, 42, 0.4)' : 'rgba(30, 41, 59, 0.2)';

                  return (
                    <tr key={role} style={{ background: rowBg, borderBottom: '1px solid rgba(148, 163, 184, 0.1)' }}>
                      <td style={{ padding: '12px 16px', fontWeight: 700, color: '#38bdf8', textTransform: 'capitalize' }}>
                        {role}
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <span style={{
                          padding: '3px 10px',
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
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <input
                            type="number"
                            min={1}
                            max={20}
                            value={roleSettings[role]?.maxAgents ?? 1}
                            onChange={(e) => handleMaxAgentsChange(role, parseInt(e.target.value) || 1)}
                            style={{
                              width: 90,
                              padding: '6px 10px',
                              background: '#1e293b',
                              border: `1px solid ${err ? '#ef4444' : 'rgba(148, 163, 184, 0.3)'}`,
                              borderRadius: 6,
                              color: '#f8fafc',
                              fontSize: 12,
                              outline: 'none'
                            }}
                          />
                          {err && <span style={{ color: '#f87171', fontSize: 10 }}>{err}</span>}
                        </div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={roleSettings[role]?.taskLimit ?? 6}
                          onChange={(e) => handleTaskLimitChange(role, parseInt(e.target.value) || 1)}
                          style={{
                            width: 90,
                            padding: '6px 10px',
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
    </div>
  );
}
