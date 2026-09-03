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

  const MAX_DISPLAY_MESSAGES = 1000;

  // Fetch agents
  const fetchAgents = async () => {
    try {
      const res = await fetch(`${API}/api/agents`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setAgents(data);
      }
    } catch (e) {
      console.error('Failed to fetch agents:', e);
    }
  };

  // Fetch history from DB — merge (not overwrite) to avoid race with WS messages arriving during fetch
  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API}/api/history`);
      const data: ChatMsg[] = await res.json();
      if (!Array.isArray(data)) return;
      setAllMessages(prev => {
        if (prev.length === 0) return data.slice(-MAX_DISPLAY_MESSAGES);
        const map = new Map<string, ChatMsg>(prev.map(m => [m.id, m]));
        for (const m of data) if (!map.has(m.id)) map.set(m.id, m);
        // sort by timestamp to keep order stable if WS inserted out-of-order
        const sorted = Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
        return sorted.slice(-MAX_DISPLAY_MESSAGES);
      });
    } catch (e) {
      console.error('Failed to fetch history:', e);
    }
  };

  // Handle realtime events from WS or SSE
  const handleRealtimeEvent = useCallback((msg: any) => {
    if (!msg || typeof msg !== 'object') return;

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
        const nextList = [...prev, {
          id: m.id,
          from: m.from,
          to: m.to,
          content: m.content || '',
          timestamp: m.timestamp,
          agentName: m.agentName,
          agentRole: m.agentRole,
          msgType: m.msgType
        }];
        return nextList.length > MAX_DISPLAY_MESSAGES ? nextList.slice(-MAX_DISPLAY_MESSAGES) : nextList;
      });
      // only clear loading on actual agent/orchestrator responses (to user), not on user echo or queued notices
      if (m.to === 'user' && m.from !== 'user') setLoading(false);
    }

    // clear conversation
    if (msg.type === 'chat:message' && msg.action === 'clear') {
      const clearedId = msg.agentId || 'orchestrator';
      setAllMessages(prev => prev.filter(m => m.from !== clearedId && m.to !== clearedId));
      fetchHistory();
    }

    // Agent created/updated/deleted — fetchAgents to update sidebar
    if (msg.type === 'agent:created' || msg.type === 'agent:updated' || msg.type === 'agent:deleted') {
      fetchAgents();
    }
  }, []);

  // Realtime transport: WebSocket with SSE fallback
  useEffect(() => {
    let ws: WebSocket | null = null;
    let es: EventSource | null = null;
    let reconnectTimer: number;
    let reconnectAttempts = 0;
    let isCleanedUp = false;

    const connectSSE = () => {
      if (isCleanedUp || es) return;
      try {
        es = new EventSource(`${API}/api/events`);
        es.onopen = () => {
          setConnected(true);
          fetchAgents();
          fetchHistory();
        };
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleRealtimeEvent(data);
          } catch {}
        };
        es.onerror = () => {
          if (es) {
            es.close();
            es = null;
          }
        };
      } catch {}
    };

    const connectWS = () => {
      if (isCleanedUp) return;
      try {
        const wsUrl = window.location.protocol === 'https:' ? 'wss://localhost:3001' : 'ws://localhost:3001';
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          reconnectAttempts = 0;
          fetchAgents();
          fetchHistory();
          // Close fallback SSE if WS connected
          if (es) {
            es.close();
            es = null;
          }
        };

        ws.onclose = () => {
          setConnected(false);
          // Try fallback to SSE if WS disconnected
          connectSSE();
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
          reconnectAttempts += 1;
          reconnectTimer = window.setTimeout(connectWS, delay);
        };

        ws.onerror = () => {
          setConnected(false);
          connectSSE();
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            handleRealtimeEvent(msg);
          } catch (e) {
            console.error('WS parse error:', e);
          }
        };
      } catch {
        connectSSE();
      }
    };

    connectWS();

    return () => {
      isCleanedUp = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
      if (es) es.close();
    };
  }, [handleRealtimeEvent]);

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
  const isSystemMsg = (m: ChatMsg) => {
    if (!m) return true;
    const content = (m.content || '').trim();
    return (
      m.msgType === 'transcript' ||
      m.msgType === 'heartbeat' ||
      m.msgType === 'ping' ||
      m.msgType === 'status' ||
      /^\[(PING|HEARTBEAT|STATUS|SYSTEM)\]/i.test(content) ||
      content.startsWith('[SYSTEM]') ||
      content.startsWith('[TEAM') ||
      content.startsWith('[TEAM UPDATE]') ||
      content.startsWith('=== TURN TRANSCRIPT') ||
      content.startsWith('=== SYSTEM STATUS CHECK') ||
      content.startsWith('=== SYSTEM CHECK') ||
      content.startsWith('=== RECOVERY ATTEMPT')
    );
  };

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

  // Abort throttle & state guards
  const isAbortingRef = useRef(false);
  const lastAbortTimeRef = useRef(0);
  const ABORT_DEBOUNCE_MS = 800; // throttle window

  // Stop (abort) agent đang chạy khi chat bị treo — có debounce/throttle & kiểm tra active status
  const stopAgent = useCallback(async () => {
    const now = Date.now();
    if (isAbortingRef.current || (now - lastAbortTimeRef.current < ABORT_DEBOUNCE_MS)) {
      return;
    }

    const currentAgent = selectedAgentId
      ? agents.find(a => a.id === selectedAgentId)
      : agents.find(a => a.id === 'orchestrator');
    const isWorking = loading || currentAgent?.status === 'working';

    if (!isWorking) return;

    isAbortingRef.current = true;
    lastAbortTimeRef.current = now;
    const agentId = selectedAgentId || 'orchestrator';

    try {
      await fetch(`${API}/api/agents/${agentId}/abort`, { method: 'POST' });
      setLoading(false);
    } catch (e) {
      console.error('Failed to abort agent:', e);
    } finally {
      setTimeout(() => {
        isAbortingRef.current = false;
      }, 600);
    }
  }, [selectedAgentId, agents, loading]);

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

  // Delete agent
  const deleteAgent = async (agentId: string) => {
    try {
      const res = await fetch(`${API}/api/agents/${agentId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        if (selectedAgentId === agentId) {
          setSelectedAgentId(null);
        }
        fetchAgents();
      }
    } catch (e) {
      console.error('Failed to delete agent:', e);
    }
  };

  // Clear conversation
  const clearChat = async () => {
    try {
      const endpoint = selectedAgentId ? `${API}/api/agents/${selectedAgentId}/clear` : `${API}/api/orchestrator/clear`;
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setAllMessages(prev => {
          const clearedId = selectedAgentId || 'orchestrator';
          return prev.filter(m => m.from !== clearedId && m.to !== clearedId);
        });
        fetchAgents();
      }
    } catch (e) {
      console.error('Failed to clear chat:', e);
    }
  };

  // ESC = stop agent đang chạy (ignore repeat, modal guard, active status check)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.repeat) return; // Ignore auto-repeat when holding ESC
        if (showSpawn) return; // Spawn modal handles its own Escape
        
        // Check if there's an active agent working or loading
        const currentAgent = selectedAgentId
          ? agents.find(a => a.id === selectedAgentId)
          : agents.find(a => a.id === 'orchestrator');
        const isWorking = loading || currentAgent?.status === 'working';
        
        if (!isWorking) return; // Only abort if agent is actively running
        
        stopAgent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stopAgent, showSpawn, selectedAgentId, agents, loading]);

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
        <Dashboard agents={agents} onStart={startAgent} onSpawn={() => setShowSpawn(true)} onSelect={selectAgent} selectedAgentId={selectedAgentId} onUpdateModel={updateAgentModel} onDeleteAgent={deleteAgent} />
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
          onClear={clearChat}
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
