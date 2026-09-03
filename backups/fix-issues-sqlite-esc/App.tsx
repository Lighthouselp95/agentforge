import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Dashboard } from './components/Dashboard';
import { ChatPanel } from './components/ChatPanel';
import { SpawnDialog } from './components/SpawnDialog';

const API = 'http://localhost:3001';

interface ChatMsg {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  agentName?: string;
  agentRole?: string;
  msgType?: string;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  type: string;
  status: string;
  task?: string;
  spawnedBy?: string;
  sessionId?: string;
  sessionTitle?: string;
  createdAt: number;
  workingSince?: number;
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [allMessages, setAllMessages] = useState<ChatMsg[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showSpawn, setShowSpawn] = useState(false);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch agents
  const fetchAgents = async () => {
    try {
      const res = await fetch(`${API}/api/agents`);
      const data = await res.json();
      setAgents(data);
    } catch (e) {
      console.error('Failed to fetch agents:', e);
    }
  };

  // Fetch history from DB — merge (not overwrite) to avoid race with WS messages arriving during fetch
  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API}/api/history`);
      const data: ChatMsg[] = await res.json();
      setAllMessages(prev => {
        if (prev.length === 0) return data;
        const map = new Map<string, ChatMsg>(prev.map(m => [m.id, m]));
        for (const m of data) if (!map.has(m.id)) map.set(m.id, m);
        // sort by timestamp to keep order stable if WS inserted out-of-order
        return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
      });
    } catch (e) {
      console.error('Failed to fetch history:', e);
    }
  };

  // WebSocket
  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: number;
    let reconnectAttempts = 0;

    const connect = () => {
      ws = new WebSocket('ws://localhost:3001');
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectAttempts = 0; // reset backoff sau khi kết nối thành công
        fetchAgents();
        fetchHistory();
      };

      ws.onclose = () => {
        setConnected(false);
        // Exponential backoff: 1s, 2s, 4s, 8s... tối đa 30s — tránh thundering herd khi server restart
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        setConnected(false);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // Agent messages (chat:message broadcast from server)
          if (msg.type === 'chat:message' && msg.msg) {
            const m = msg.msg;
            setAllMessages(prev => {
              // dedupe by id
              if (prev.some(p => p.id === m.id)) return prev;
              // dedupe optimistic temp user message: replace temp with real id when server echoes user msg
              if (m.from === 'user') {
                const tempIdx = prev.findIndex(p => p.id.startsWith('temp-') && p.content === m.content && p.to === m.to);
                if (tempIdx !== -1) {
                  const next = [...prev];
                  next[tempIdx] = {
                    id: m.id,
                    from: m.from,
                    to: m.to,
                    content: m.content,
                    timestamp: m.timestamp,
                    agentName: m.agentName,
                    agentRole: m.agentRole,
                    msgType: m.msgType
                  };
                  return next;
                }
              }
              return [...prev, {
                id: m.id,
                from: m.from,
                to: m.to,
                content: m.content,
                timestamp: m.timestamp,
                agentName: m.agentName,
                agentRole: m.agentRole,
                msgType: m.msgType
              }];
            });
            // only clear loading on actual agent/orchestrator responses (to user), not on user echo or queued notices
            if (m.to === 'user' && m.from !== 'user') setLoading(false);
            // also clear optimistic temp if it was user echo — keep loading true until agent replies
          }
          // clear orchestrator conversation
          if (msg.type === 'chat:message' && msg.action === 'clear') {
            fetchHistory();
          }

          // Agent created/updated/deleted — fetchAgents để cập nhật sidebar
          // KHÔNG fetchHistory() ở đây vì chat messages đã được deliver qua WS broadcast
          // fetchHistory() thừa có thể gây race condition với WS state updates
          if (msg.type === 'agent:created' || msg.type === 'agent:updated' || msg.type === 'agent:deleted') {
            fetchAgents();
          }
        } catch (e) {
          console.error('WS parse error:', e);
        }
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  // Send message to orchestrator — source of truth is WS broadcast; optimistic user msg deduped by id after server echo
  const sendMessage = async (text: string) => {
    // Optimistic user message (server will echo same content with real uuid; we keep optimistic with temp id, deduped later by content+timestamp window)
    const tempId = `temp-${Date.now()}`;
    const userMsg: ChatMsg = {
      id: tempId,
      from: 'user',
      to: selectedAgentId || 'orchestrator',
      content: text,
      timestamp: Date.now()
    };
    setAllMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const body: any = { message: text };
      if (selectedAgentId) body.targetAgentId = selectedAgentId;

      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.error && !data.response) {
        setAllMessages(prev => [...prev, {
          id: `err-${Date.now()}`,
          from: 'error',
          to: 'user',
          content: `Error: ${data.error}`,
          timestamp: Date.now()
        }]);
        setLoading(false);
      }
      // Do NOT optimistically add orchestrator/agent response here — wait for WS broadcast (chat:message)
      // This avoids duplicate (HTTP + WS) and ensures spawn worker replies (async, WS-only) are not missed.
      // Fallback: if WS is disconnected, fetchHistory will pull it on reconnect; set timeout to clear loading
      setTimeout(() => setLoading(prev => prev ? false : prev), 30000);
    } catch (e: any) {
      setAllMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        from: 'error',
        to: 'user',
        content: `Error: ${e.message}`,
        timestamp: Date.now()
      }]);
      setLoading(false);
    }
  };

  // System/heartbeat/ping/transcript noise — không hiện trong giao diện chat
  const isSystemMsg = (m: ChatMsg) =>
    m.msgType === 'transcript' ||
    /^\[(PING|HEARTBEAT)\]/.test(m.content) ||
    m.msgType === 'heartbeat' ||
    m.msgType === 'ping' ||
    m.content.startsWith('[SYSTEM]') ||
    m.content.startsWith('[TEAM') ||
    m.content.startsWith('=== TURN TRANSCRIPT');

  // Filter messages for selected view
  const filteredMessages = selectedAgentId
    ? allMessages.filter(m =>
        !isSystemMsg(m) && (
          m.from === selectedAgentId ||
          m.to === selectedAgentId ||
          m.from === 'user' && m.to === selectedAgentId ||
          m.from === selectedAgentId && m.to === 'user'
        )
      )
    : allMessages.filter(m =>
        !isSystemMsg(m) && (
          (m.from === 'user' && m.to === 'orchestrator') ||
          (m.from === 'orchestrator' && m.to === 'user') ||
          (m.from !== 'user' && m.from !== 'orchestrator' && m.to === 'orchestrator')
        )
      ); // Orchestrator view — bỏ noise/transcript, giữ reports sạch

  // Format message for display
  const formatMessage = (msg: ChatMsg): { sender: string; content: string; isUser: boolean } => {
    const isUser = msg.from === 'user';
    let sender = msg.from;

    // Resolve agent IDs to names with ID
    if (msg.from === 'orchestrator') sender = 'Orchestrator (orchestrator)';
    else if (msg.from === 'user') sender = 'You';
    else if (msg.agentName) sender = `${msg.agentName} (${msg.agentRole || 'agent'}) [${msg.from}]`;
    else {
      const agent = agents.find(a => a.id === msg.from);
      if (agent) sender = `${agent.name} (${agent.role}) [${agent.id}]`;
    }

    return { sender, content: msg.content, isUser };
  };

  // Add agent
  const addAgent = async (config: any) => {
    try {
      await fetch(`${API}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      setShowSpawn(false);
      fetchAgents();
    } catch (e) {
      console.error('Failed to add agent:', e);
    }
  };

  // Start agent
  const startAgent = async (agentId: string) => {
    try {
      await fetch(`${API}/api/agents/${agentId}/start`, { method: 'POST' });
      fetchAgents();
    } catch (e) {
      console.error('Failed to start agent:', e);
    }
  };

  // Stop (abort) agent đang chạy khi chat bị treo
  const stopAgent = async () => {
    const agentId = selectedAgentId || 'orchestrator';
    try { await fetch(`${API}/api/agents/${agentId}/abort`, { method: 'POST' }); setLoading(false); } catch (e) { console.error(e); }
  };

  // Update agent model
  const updateAgentModel = async (agentId: string, model: string | null) => {
    try {
      await fetch(`${API}/api/agents/${agentId}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      });
      fetchAgents();
    } catch (e) {
      console.error('Failed to update agent model:', e);
    }
  };

  // ESC = stop agent đang chạy
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stopAgent(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedAgentId]);

  // Select agent
  const selectAgent = (agentId: string | null) => {
    setSelectedAgentId(agentId);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0f0f0f' }}>
      {/* Sidebar */}
      <div style={{
        width: sidebarWidth,
        minWidth: 220,
        maxWidth: 600,
        borderRight: '1px solid #333',
        display: 'flex',
        flexDirection: 'column',
        background: '#1a1a1a'
      }}>
        <div style={{ padding: 16, borderBottom: '1px solid #333' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>🤖 AgentForge</h2>
          <div style={{ fontSize: 12, color: connected ? '#4ade80' : '#f87171', marginTop: 4 }}>
            {connected ? '● Connected' : '● Disconnected'}
          </div>
        </div>
        <Dashboard agents={agents} onStart={startAgent} onSpawn={() => setShowSpawn(true)} onSelect={selectAgent} selectedAgentId={selectedAgentId} onUpdateModel={updateAgentModel} />
      </div>
      {/* Resizer */}
      <div
        onMouseDown={(e) => {
          const startX = e.clientX;
          const startW = sidebarWidth;
          const onMove = (ev: MouseEvent) => {
            const nw = Math.max(220, Math.min(600, startW + ev.clientX - startX));
            setSidebarWidth(nw);
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        style={{ width: 5, cursor: 'col-resize', background: '#222', flexShrink: 0 }}
      />

      {/* Chat */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <ChatPanel
          messages={filteredMessages.map(m => ({
            id: m.id,
            agentId: m.from,
            role: m.from === 'user' ? 'user' : 'assistant',
            content: m.content,
            timestamp: m.timestamp
          }))}
          onSend={sendMessage}
          onStop={stopAgent}
          loading={loading}
          title={selectedAgentId ? (() => { const a = agents.find(x => x.id === selectedAgentId); return a ? `${a.name} (${a.id})${a.sessionTitle ? ` — ${a.sessionTitle}` : ''}` : 'Agent'; })() : (() => { const a = agents.find(x => x.id === 'orchestrator'); return a && a.sessionTitle ? `Orchestrator (orchestrator) — ${a.sessionTitle}` : 'Orchestrator (orchestrator)'; })()}
          formatMessage={formatMessage}
          allMessages={filteredMessages}
        />
      </div>

      {/* Spawn Dialog */}
      {showSpawn && (
        <SpawnDialog onAdd={addAgent} onClose={() => setShowSpawn(false)} />
      )}
    </div>
  );
}
