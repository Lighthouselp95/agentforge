import React from 'react';

interface TabAgent {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface Props {
  agents: TabAgent[];
  selectedAgentId: string | null;
  onSelect: (id: string | null) => void;
  isMobile?: boolean;
}

export function TabBar({ agents, selectedAgentId, onSelect, isMobile }: Props) {
  if (!agents || agents.length === 0) return null;

  const statusDotClass = (status: string) =>
    status === 'working' ? 'af-tab-dot working' : status === 'blocked' ? 'af-tab-dot blocked' : 'af-tab-dot idle';

  const handleClose = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    // Hủy chọn (không xóa agent) khi đóng tab đang active
    if (selectedAgentId === id) onSelect(null);
  };

  return (
    <div className="af-tabbar" style={isMobile ? { paddingLeft: 54 } : undefined}>
      {agents.map((a) => {
        const active = a.id === selectedAgentId;
        const isWorking = a.status === 'working';
        return (
          <div
            key={a.id}
            className={`af-tab${active ? ' af-active' : ''}`}
            onClick={() => onSelect(a.id)}
            title={`${a.name} (${a.role})${a.status ? ` — ${a.status}` : ''}`}
            role="tab"
            aria-selected={active}
          >
            <span className={statusDotClass(a.status)} />
            <span className="af-tab-name">{a.name}</span>
            <span className="af-tab-role">· {a.role}</span>
            {isWorking && <span className="af-tab-spin" aria-label="working" />}
            <button
              className="af-tab-close"
              onClick={(e) => handleClose(e, a.id)}
              title="Đóng tab (không xóa agent)"
              aria-label={`Đóng tab ${a.name}`}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}