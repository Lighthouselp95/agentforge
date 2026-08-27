import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Dashboard } from './components/Dashboard';
import { ChatPanel } from './components/ChatPanel';
import { SpawnDialog } from './components/SpawnDialog';
import { ModelSettingsDialog } from './components/ModelSettingsDialog';

const API = window.location.port === '5173' ? '' : (window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:3001');

interface ChatMsg {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp?: number;
  agentName?: string;
  agentRole?: string;
  msgType?: string;
  toolCalls?: Array<{ tool: string; input?: string; output?: string }>;
  thinking?: string;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
  contextLimit?: number;
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
  tokenUsage?: TokenUsage | number;
  contextLength?: number;
}

export function App() {
  const [agents, setAgents] = useState<Agent[]>(() => {
    // Cache nhẹ: hiện token/status ngay lập tức khi F5, chờ fetch mạng đè lên sau
    try {
      const raw = localStorage.getItem('af-agents-cache');
      const arr = raw ? JSON.parse(raw) : null;
      return Array.isArray(arr) ? (arr as Agent[]) : [];
    } catch {
      return [];
    }
  });
  const [allMessages, setAllMessages] = useState<ChatMsg[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [showSpawn, setShowSpawn] = useState(false);
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [disconnectedAt, setDisconnectedAt] = useState<number | null>(null);
  const [serverStartTime, setServerStartTime] = useState<number | null>(null);
  const [serverCwd, setServerCwd] = useState<string>('');
  const [serverVersion, setServerVersion] = useState<string>('');
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [, setStatusTick] = useState(0);

  // Tick mỗi giây (cả online lẫn offline) để uptime/offline duration cập nhật trực tiếp
  useEffect(() => {
    const t = setInterval(() => setStatusTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const formatElapsed = (ms: number): string => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} phút`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} giờ`;
    return `${Math.floor(h / 24)} ngày`;
  };
  const offlineForText = connectionStatus === 'disconnected' && disconnectedAt ? formatElapsed(Date.now() - disconnectedAt) : '';
  // Ưu tiên uptime TỪ SERVER (serverStartTime); fallback về thời điểm connect cục bộ
  const uptimeText = connectionStatus === 'connected'
    ? (serverStartTime ? formatElapsed(Date.now() - serverStartTime) : '')
    : '';

  const fetchServerInfo = async () => {
    try {
      const res = await fetch(`${API}/api/server-info`);
      const data = await res.json();
      if (data && typeof data.serverStartTime === 'number') setServerStartTime(data.serverStartTime);
      if (data && typeof data.cwd === 'string') setServerCwd(data.cwd);
      if (data && typeof data.version === 'string') setServerVersion(data.version);
    } catch {}
  };
  const [loading, setLoading] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<ChatMsg[]>([]);
  const lastSendAtRef = useRef(0);
  const [sidebarWidth, setSidebarWidth] = useState(310);
  const [enableWatchdog, setEnableWatchdog] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  // Bản đồ agentKey -> id tin nhắn stream đang chạy (chat:chunk / chat:tool_call)
  const streamRef = useRef<Record<string, string>>({});
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('af-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });

  // Áp theme lên <html data-theme> + lưu lựa chọn (reload giữ nguyên)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('af-theme', theme); } catch {}
  }, [theme]);

  // Polling mỗi 10s: làm tươi danh sách agents (status, tokenUsage...) dù không có WS event
  useEffect(() => {
    const t = setInterval(() => {
      fetch(`${API}/api/agents`)
        .then(r => r.json())
        .then((data) => {
          if (Array.isArray(data)) applyAgents(data);
        })
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  // Spinner khớp trạng thái agent đích — debounce 700ms sau khi gửi để tránh flicker
  useEffect(() => {
    const tid = selectedAgentId || 'orchestrator';
    const cur = agents.find(a => a.id === tid);
    const serverBusy = cur ? cur.status === 'working' : false;
    if (serverBusy) setLoading(true);
    else {
      if (Date.now() - lastSendAtRef.current < 700) return;
      setLoading(false);
    }
  }, [agents, selectedAgentId]);

  // Mount: fetch NGAY khi mở trang — không chờ WS/SSE bắt tay xong mới có token
  useEffect(() => {
    fetchAgents();
    fetchServerInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling mỗi 10s: làm tươi danh sách agents -> token badge & trạng thái không bị kẹt số cũ
  useEffect(() => {
    const t = setInterval(() => {
      fetchAgents();
    }, 10000);
    return () => clearInterval(t);
  }, []);

  // Phát hiện màn hình điện thoại (<768px) để chuyển sidebar thành drawer
  useEffect(() => {
    const onResize = () => {
      const m = window.innerWidth < 768;
      setIsMobile(m);
      if (!m) setSidebarOpen(false);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const MAX_DISPLAY_MESSAGES = 1000;
  // Chỉ tải N tin nhắn mới nhất lúc khởi động → payload nhỏ, render nhanh
  const HISTORY_FETCH_LIMIT = 500;

  // Fetch settings
  const fetchSettings = async () => {
    try {
      const res = await fetch(`${API}/api/settings/watchdog`);
      const data = await res.json();
      if (typeof data.enableWatchdog === 'boolean') {
        setEnableWatchdog(data.enableWatchdog);
      }
    } catch (e) {
      console.error('Failed to fetch watchdog settings:', e);
    }
  };

  const toggleWatchdog = async (enabled: boolean) => {
    setEnableWatchdog(enabled);
    try {
      await fetch(`${API}/api/settings/watchdog`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableWatchdog: enabled })
      });
    } catch (e) {
      console.error('Failed to update watchdog settings:', e);
    }
  };

  // Cập nhật agents + ghi cache localStorage (hiện tức thì ở lần mở sau)
  const applyAgents = (data: Agent[]) => {
    setAgents(data);
    try { localStorage.setItem('af-agents-cache', JSON.stringify(data)); } catch {}
  };

  // Fetch agents
  const fetchAgents = async () => {
    try {
      const res = await fetch(`${API}/api/agents`);
      const data = await res.json();
      if (Array.isArray(data)) {
        applyAgents(data);
      }
    } catch (e) {
      console.error('Failed to fetch agents:', e);
    }
  };

  // Fetch history from DB — merge (not overwrite) to avoid race with WS messages arriving during fetch
  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API}/api/history?limit=${HISTORY_FETCH_LIMIT}`);
      const data: ChatMsg[] = await res.json();
      if (!Array.isArray(data)) return;
      setAllMessages(prev => {
        if (prev.length === 0) return data.slice(-MAX_DISPLAY_MESSAGES);
        const map = new Map<string, ChatMsg>(prev.map(m => [m.id, m]));
        for (const m of data) if (!map.has(m.id)) map.set(m.id, m);
        const sorted = Array.from(map.values()).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        return sorted.slice(-MAX_DISPLAY_MESSAGES);
      });
    } catch (e) {
      console.error('Failed to fetch history:', e);
    }
  };

  // Tạo/lấy tin nhắn stream của 1 agent rồi mutate nội dung (dùng cho chat:chunk / chat:tool_call)
  const upsertStreamMsg = (key: string, mut: (m: ChatMsg) => ChatMsg) => {
    setAllMessages(prev => {
      let sid = streamRef.current[key];
      let list = prev;
      if (!sid || !prev.some(p => p.id === sid)) {
        sid = `stream-${key}-${Date.now()}`;
        streamRef.current[key] = sid;
        list = [...prev, { id: sid, from: key, to: 'user', content: '', timestamp: Date.now() }];
      }
      return list.map(m => m.id === sid ? mut(m) : m);
    });
  };

  // Handle realtime events from WS or SSE
  const handleRealtimeEvent = useCallback((msg: any) => {
    if (!msg || typeof msg !== 'object') return;

    // Stream chữ chạy trực tuyến: chat:chunk { agentId?, from?, textDelta }
    if (msg.type === 'chat:chunk' && typeof msg.textDelta === 'string') {
      const key = String(msg.agentId || msg.from || 'orchestrator');
      const delta = msg.textDelta;
      upsertStreamMsg(key, m => ({ ...m, content: (m.content || '') + delta }));
    }

    // Tool call realtime: chat:tool_call { agentId?, toolCall? | tool/input/output }
    if (msg.type === 'chat:tool_call') {
      const key = String(msg.agentId || msg.from || 'orchestrator');
      const tcRaw: any = msg.toolCall || {};
      const tc = {
        tool: String(tcRaw.tool ?? msg.tool ?? 'tool'),
        input: tcRaw.input ?? msg.input,
        output: tcRaw.output ?? msg.output
      };
      upsertStreamMsg(key, m => ({ ...m, toolCalls: [...(m.toolCalls || []), tc] }));
    }

    // Chấp nhận nhiều tên sự kiện: chat:message (chuẩn server), message:new / message (tương thích)
    if (
      (msg.type === 'chat:message' || msg.type === 'message:new' || msg.type === 'message') &&
      (msg.msg || msg.message)
    ) {
      const m = msg.msg || msg.message;
      // Tin cuối (canonical) từ cùng agent -> gỡ bản stream tạm để không trùng nội dung
      const fkey = String(m.from || '');
      if (fkey && streamRef.current[fkey]) {
        const staleId = streamRef.current[fkey];
        delete streamRef.current[fkey];
        setAllMessages(prev => prev.filter(x => x.id !== staleId));
      }
      setAllMessages(prev => {
        if (prev.some(p => p.id === m.id)) return prev;
        if (m.from === 'user') {
          const tempIdx = prev.findIndex(p => p.id.startsWith('temp-') && p.content === m.content && p.to === m.to);
          if (tempIdx !== -1) {
            const next = [...prev];
            next[tempIdx] = {
              id: m.id,
              from: m.from,
              to: m.to,
              content: m.content,
              timestamp: m.timestamp || Date.now(),
              agentName: m.agentName,
              agentRole: m.agentRole,
              msgType: m.msgType,
              toolCalls: m.toolCalls,
              thinking: m.thinking
            };
            return next;
          }
        }
        const nextList = [...prev, {
          id: m.id,
          from: m.from,
          to: m.to,
          content: m.content || '',
          timestamp: m.timestamp || Date.now(),
          agentName: m.agentName,
          agentRole: m.agentRole,
          msgType: m.msgType,
          toolCalls: m.toolCalls,
          thinking: m.thinking
        }];
        return nextList.length > MAX_DISPLAY_MESSAGES ? nextList.slice(-MAX_DISPLAY_MESSAGES) : nextList;
      });
      // KHÔNG tắt spinner vì tin trung gian; chỉ lỗi mới tắt (spinner do agent status điều phối)
      if (m.msgType === 'error' || m.from === 'error') {
        setLoading(false);
      }
    }

    if (msg.type === 'chat:message' && msg.action === 'clear') {
      const clearedId = msg.agentId || 'orchestrator';
      setAllMessages(prev => prev.filter(m => m.from !== clearedId && m.to !== clearedId));
      fetchHistory();
    }

    if (msg.type === 'settings:updated' && typeof msg.enableWatchdog === 'boolean') {
      setEnableWatchdog(msg.enableWatchdog);
    }

    if (msg.type === 'agent:created' || msg.type === 'agent:updated' || msg.type === 'agent:deleted') {
      if (msg.type === 'agent:deleted') {
        const deletedId = msg.id || msg.agentId;
        if (deletedId) {
          setAgents(prev => prev.filter(a => a.id !== deletedId));
          if (selectedAgentId === deletedId) {
            setSelectedAgentId(null);
          }
        }
      }
      if (msg.agent) {
        const ag = msg.agent;
        const currentTarget = selectedAgentId || 'orchestrator';
        // Sync 2 chiều: spinner BẬT khi working, TẮT khi idle/error/stopped
        if (ag.id === currentTarget) {
          setLoading(ag.status === 'working');
        }
      }
      fetchAgents();
    }
  }, [selectedAgentId]);

  // Giữ handler mới nhất trong ref để effect realtime KHÔNG phụ thuộc selectedAgentId:
  // trước đây mỗi lần đổi tab agent là WS ngắt/kết nối lại -> tin gửi trong khoảng đó bị mất.
  const handleRealtimeEventRef = useRef(handleRealtimeEvent);
  useEffect(() => { handleRealtimeEventRef.current = handleRealtimeEvent; }, [handleRealtimeEvent]);

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
          setConnectionStatus('connected');
          setConnectedAt(Date.now());
          setDisconnectedAt(null); // xóa timing offline cũ
          fetchServerInfo(); // nạp lại serverStartTime mới sau reconnect
          fetchAgents();
          fetchHistory();
          fetchSettings();
        };
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleRealtimeEventRef.current(data);
          } catch {}
        };
        es.onerror = () => {
          setConnectionStatus('disconnected');
          setDisconnectedAt(Date.now());
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
        const wsHost = window.location.port === '5173' ? 'localhost:3001' : window.location.host;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${wsHost}`;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          setConnectionStatus('connected');
          setConnectedAt(Date.now());
          setDisconnectedAt(null); // xóa timing offline cũ
          fetchServerInfo(); // nạp lại serverStartTime mới sau reconnect
          reconnectAttempts = 0;
          fetchAgents();
          fetchHistory();
          fetchSettings();
          if (es) {
            es.close();
            es = null;
          }
        };

        ws.onclose = () => {
          setConnected(false);
          setConnectionStatus('disconnected');
          setDisconnectedAt(Date.now());
          connectSSE();
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
          reconnectAttempts += 1;
          reconnectTimer = window.setTimeout(connectWS, delay);
        };

        ws.onerror = () => {
          setConnected(false);
          setConnectionStatus('disconnected');
          setDisconnectedAt(Date.now());
          connectSSE();
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            handleRealtimeEventRef.current(msg);
          } catch (e) {
            console.error('WS parse error:', e);
          }
        };
      } catch {
        connectSSE();
      }
    };

    connectWS();

    // An toàn kép: quay lại tab / mạng trở lại -> kéo lịch sử mới nhất,
    // phòng trường hợp lỡ mất event trong khoảng chờ reconnect.
    const safeRefresh = () => { try { fetchAgents(); fetchHistory(); } catch {} };
    window.addEventListener('focus', safeRefresh);
    window.addEventListener('online', safeRefresh);

    return () => {
      isCleanedUp = true;
      clearTimeout(reconnectTimer);
      window.removeEventListener('focus', safeRefresh);
      window.removeEventListener('online', safeRefresh);
      if (ws) ws.close();
      if (es) es.close();
    };
  }, []);

  // Send queued message helper (actual network)
  const sendQueuedMessage = async (qmsg: ChatMsg) => {
    lastSendAtRef.current = Date.now();
    setAllMessages(prev => [...prev, qmsg]);
    setLoading(true);
    const targetId = qmsg.to;
    try {
      const body: any = { message: qmsg.content };
      if (targetId !== 'orchestrator') body.targetAgentId = targetId;
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.error) {
        setAllMessages(prev => {
          const errId = `err-${Date.now()}`;
          if (prev.some(p => p.content === `❌ Error: ${data.error}`)) return prev;
          return [...prev, { id: errId, from: targetId, to: 'user', content: `❌ Error: ${data.error}`, timestamp: Date.now(), msgType: 'error' }];
        });
        setLoading(false);
      }
    } catch (e: any) {
      setAllMessages(prev => [...prev, { id: `err-${Date.now()}`, from: targetId, to: 'user', content: `❌ Connection error: ${e.message}`, timestamp: Date.now(), msgType: 'error' }]);
      setLoading(false);
    }
  };

  // Drain queue khi server thực sự idle — gộp toàn bộ hàng đợi thành 1 lần gửi
  const flushQueue = useCallback(() => {
    if (queuedMessages.length === 0) return;
    const all = [...queuedMessages];
    setQueuedMessages([]);
    const combined = all.length === 1 ? all[0].content : all.map((m,i)=>`[Message ${i+1}]:\n${m.content}`).join('\n\n---\n\n');
    const batchMsg: ChatMsg = {
      id: `temp-batch-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      from: 'user',
      to: all[0].to,
      content: combined,
      timestamp: Date.now()
    };
    sendQueuedMessage(batchMsg);
  }, [queuedMessages]);

  useEffect(() => {
    const tid = selectedAgentId || 'orchestrator';
    const cur = agents.find(a => a.id === tid);
    const serverBusy = cur ? cur.status === 'working' : false;
    if (!serverBusy && queuedMessages.length > 0) {
      if (loading) return;
      const nextRaw = queuedMessages[0];
      const next: ChatMsg = { ...nextRaw, timestamp: Date.now() };
      setQueuedMessages(prev => prev.slice(1));
      sendQueuedMessage(next);
    }
  }, [loading, queuedMessages, agents, selectedAgentId]);

  // Send message
  const sendMessage = async (text: string) => {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const targetId = selectedAgentId || 'orchestrator';
    const userMsg: ChatMsg = {
      id: tempId,
      from: 'user',
      to: targetId,
      content: text,
      timestamp: Date.now()
    };
    // Nếu đang bận thì cho vào hàng đợi UI — hiện ở queue bar trên khung typing
    const curBusy = agents.find(a => a.id === (selectedAgentId || 'orchestrator'));
    const isBusy = loading || (curBusy ? curBusy.status === 'working' : false);
    if (isBusy) {
      setQueuedMessages(prev => [...prev, userMsg]);
      return;
    }
    lastSendAtRef.current = Date.now();
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
      if (data.error) {
        setAllMessages(prev => {
          const errId = `err-${Date.now()}`;
          if (prev.some(p => p.content === `❌ Error: ${data.error}`)) return prev;
          return [...prev, {
            id: errId,
            from: targetId,
            to: 'user',
            content: `❌ Error: ${data.error}`,
            timestamp: Date.now(),
            msgType: 'error'
          }];
        });
        setLoading(false);
      }
    } catch (e: any) {
      setAllMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        from: targetId,
        to: 'user',
        content: `❌ Connection error: ${e.message}`,
        timestamp: Date.now(),
        msgType: 'error'
      }]);
      setLoading(false);
    }
  };

  const isSystemMsg = (m: ChatMsg) => {
    if (!m) return true;
    const content = (m.content || '').trim();
    return (
      m.msgType === 'transcript' ||
      m.msgType === 'heartbeat' ||
      m.msgType === 'ping' ||
      content.startsWith('=== TURN TRANSCRIPT') ||
      content.startsWith('=== SYSTEM STATUS CHECK') ||
      content.startsWith('=== SYSTEM CHECK') ||
      content.startsWith('=== RECOVERY ATTEMPT')
    );
  };

  const isInternalMsg = (m: ChatMsg) => {
    if (!m) return false;
    // Chỉ ẩn các chỉ thị NỘI BỘ do orchestrator gửi ĐI cho agent (ví dụ [TALK agent]).
    // Tin agent báo cáo VỀ orchestrator (from=agent, to='orchestrator') PHẢI được hiển thị ở main view
    // để người dùng thấy agent phản hồi lại main.
    if (m.from === 'orchestrator' && m.to && m.to !== 'user' && m.to !== 'broadcast') return true;
    return false;
  };

  const filteredMessages = selectedAgentId
    ? allMessages.filter(m =>
        !isSystemMsg(m) && (
          m.from === selectedAgentId ||
          m.to === selectedAgentId ||
          (m.from === 'user' && m.to === selectedAgentId) ||
          (m.from === selectedAgentId && m.to === 'user') ||
          (m.msgType === 'error' && (m.from === selectedAgentId || m.to === selectedAgentId || m.to === 'user')) ||
          (m.from === 'error' && (m.to === selectedAgentId || m.to === 'user'))
        )
      )
    : allMessages.filter(m => {
        if (isSystemMsg(m)) return false;
        if (isInternalMsg(m)) return false;
        // Tab Main: ẨN 100% stream tool trung gian của opencode
        if (m.msgType === 'opencode') return false;
        const isFromWorker = m.from !== 'user' && m.from !== 'orchestrator' && m.from !== 'system' && m.from !== 'error';
        if (isFromWorker) {
          // Worker: CHỈ hiện khi là báo cáo sạch (Task Report / Task complete) — ẩn mọi tự sự
          return m.to === 'orchestrator' &&
            /=== TASK REPORT ===|Task complete\./.test(m.content || '');
        }
        return (
          (m.from === 'user' && (m.to === 'orchestrator' || !m.to)) ||
          (m.from === 'orchestrator' && (m.to === 'user' || m.to === 'broadcast' || !m.to)) ||
          (m.msgType === 'error') ||
          (m.from === 'error')
        );
      });

  const formatMessage = (msg: ChatMsg): { sender: string; content: string; isUser: boolean; timestamp?: number } => {
    const isUser = msg.from === 'user';
    let sender = msg.from;

    if (msg.from === 'orchestrator') sender = 'Orchestrator';
    else if (msg.from === 'user') sender = 'You';
    else if (msg.agentName) sender = `${msg.agentName} (${msg.agentRole || 'agent'}) [${msg.from}]`;
    else {
      const agent = agents.find(a => a.id === msg.from);
      if (agent) sender = `${agent.name} (${agent.role}) [${agent.id}]`;
    }

    return { sender, content: msg.content, isUser, timestamp: msg.timestamp };
  };

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

  const startAgent = async (agentId: string) => {
    try {
      await fetch(`${API}/api/agents/${agentId}/start`, { method: 'POST' });
      fetchAgents();
    } catch (e) {
      console.error('Failed to start agent:', e);
    }
  };

  const isAbortingRef = useRef(false);
  const lastAbortTimeRef = useRef(0);
  const ABORT_DEBOUNCE_MS = 800;

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

  const updateAgentModel = async (agentId: string, model: string | null) => {
    // Optimistic UI update for instant feedback
    setAgents(prev => prev.map(a => a.id === agentId ? { ...a, model: model || undefined } : a));
    try {
      const res = await fetch(`${API}/api/agents/${agentId}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      });
      const data = await res.json();
      if (!data.ok) {
        fetchAgents();
      }
    } catch (e) {
      console.error('Failed to update agent model:', e);
      fetchAgents();
    }
  };

  const deleteAgent = async (agentId: string) => {
    setAgents(prev => prev.filter(a => a.id !== agentId));
    if (selectedAgentId === agentId) {
      setSelectedAgentId(null);
    }
    try {
      const res = await fetch(`${API}/api/agents/${agentId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) {
        fetchAgents();
      }
    } catch (e) {
      console.error('Failed to delete agent:', e);
      fetchAgents();
    }
  };

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.repeat) return;
        if (showSpawn || showModelSettings) return;
        
        const currentAgent = selectedAgentId
          ? agents.find(a => a.id === selectedAgentId)
          : agents.find(a => a.id === 'orchestrator');
        const isWorking = loading || currentAgent?.status === 'working';
        
        if (!isWorking) return;
        
        stopAgent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stopAgent, showSpawn, showModelSettings, selectedAgentId, agents, loading]);

  const selectAgent = (agentId: string | null) => {
    setSelectedAgentId(agentId);
    if (isMobile) setSidebarOpen(false);
  };

  const sidebarStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        top: 0,
        left: 0,
        height: '100%',
        width: 'min(82vw, 320px)',
        zIndex: 50,
        borderRight: '1px solid var(--af-border)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-panel)',
        transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.25s ease',
        boxShadow: sidebarOpen ? '4px 0 24px rgba(0,0,0,0.5)' : 'none'
      }
    : {
        width: sidebarWidth,
        minWidth: 240,
        maxWidth: 600,
        borderRight: '1px solid var(--af-border)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-panel)'
      };

  return (
    <div className="af-shell" style={{ display: 'flex', height: '100%', background: 'var(--bg-main)', color: 'var(--text-primary)', overflow: 'hidden', position: 'relative' }}>
      {/* Sidebar */}
      <div className="af-sidebar" style={sidebarStyle}>
        {/* Sidebar Header */}
        <div style={{ padding: '16px 14px', borderBottom: '1px solid #1e293b' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                boxShadow: '0 2px 8px rgba(59, 130, 246, 0.3)'
              }}>
                🤖
              </div>
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, letterSpacing: '-0.02em', color: '#f8fafc' }}>
                AgentForge
              </h2>
              {/* CWD Badge — inline with logo */}
              {serverCwd && (
                <span
                  onClick={() => { navigator.clipboard.writeText(serverCwd).catch(() => {}); }}
                  title={`${serverCwd}\nClick để copy đường dẫn`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    background: 'rgba(59, 130, 246, 0.12)',
                    border: '1px solid rgba(59, 130, 246, 0.25)',
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 500,
                    color: '#93c5fd',
                    cursor: 'pointer',
                    maxWidth: 260,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    transition: 'background 0.15s',
                    lineHeight: '18px'
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.background = 'rgba(59, 130, 246, 0.22)'; }}
                  onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(59, 130, 246, 0.12)'; }}
                >
                  📁 {serverCwd}
                </span>
              )}
              {/* Version Badge */}
              {serverVersion && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 7px',
                  background: 'rgba(34, 197, 94, 0.12)',
                  border: '1px solid rgba(34, 197, 94, 0.25)',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  color: '#86efac',
                  lineHeight: '18px'
                }} title={`AgentForge v${serverVersion}`}>
                  v{serverVersion}
                </span>
              )}
            </div>

            {/* Theme Toggle + Connection Status Pill */}
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                title={theme === 'dark' ? 'Chuyển giao diện sáng' : 'Chuyển giao diện tối'}
                aria-label="Toggle theme"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: '1px solid rgba(15,23,42,0.12)',
                  background: theme === 'dark' ? 'var(--bg-input)' : '#ffffff',
                  color: theme === 'dark' ? '#fbbf24' : '#3b82f6',
                  fontSize: 15,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s'
                }}
              >
                {theme === 'dark' ? '☀️' : '🌙'}
              </button>
              <div
                className={connectionStatus === 'disconnected' ? 'af-conn-badge-off' : undefined}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  borderRadius: 9999,
                  background: connected ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.15)',
                  border: `1px solid ${connected ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.45)'}`,
                  fontSize: 11,
                  fontWeight: 600,
                  color: connected ? '#4ade80' : '#f87171',
                  whiteSpace: 'nowrap'
                }}>
              <span
                className={connected ? 'pulsing-green' : 'pulsing-red'}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  backgroundColor: connected ? '#22c55e' : '#ef4444',
                  display: 'inline-block'
                }}
              />
              <span>
                {connectionStatus === 'connected'
                  ? `Live WS${uptimeText ? ` (${uptimeText})` : ''}`
                  : `Offline${offlineForText ? ` (${offlineForText} trước)` : ''}`}
              </span>
            </div>
            </div>
          </div>

          {/* Watchdog Toggle Switch */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 14,
            padding: '8px 12px',
            background: 'var(--bg-inset)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--af-border)'
          }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', userSelect: 'none' }} title="Tự động nhắc nhở và can thiệp khi agent làm việc quá lâu">
              ⏰ Nhắc việc / Watchdog
            </span>
            <label style={{ position: 'relative', display: 'inline-block', width: 34, height: 18, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enableWatchdog}
                onChange={(e) => toggleWatchdog(e.target.checked)}
                style={{ opacity: 0, width: 0, height: 0 }}
              />
              <span style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: enableWatchdog ? '#2563eb' : '#475569',
                borderRadius: 18,
                transition: '0.2s'
              }}>
                <span style={{
                  position: 'absolute',
                  content: '""',
                  height: 14,
                  width: 14,
                  left: enableWatchdog ? 17 : 2,
                  bottom: 2,
                  backgroundColor: 'white',
                  borderRadius: '50%',
                  transition: '0.2s'
                }} />
              </span>
            </label>
          </div>

          {/* Model Hierarchy Settings Button */}
          <button
            onClick={() => setShowModelSettings(true)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              marginTop: 8,
              padding: '8px 12px',
              background: 'var(--bg-inset)',
              color: 'var(--text-secondary)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--af-border)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.borderColor = '#3b82f6';
              e.currentTarget.style.background = '#273549';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.borderColor = 'var(--af-border)';
              e.currentTarget.style.background = 'var(--bg-inset)';
            }}
          >
            <span>⚙️</span>
            <span>Cấu hình Phân cấp Model</span>
          </button>
        </div>

        {/* Dashboard / Agent List */}
        <Dashboard
          agents={agents}
          onStart={startAgent}
          onSpawn={() => setShowSpawn(true)}
          onSelect={selectAgent}
          selectedAgentId={selectedAgentId}
          onUpdateModel={updateAgentModel}
          onDeleteAgent={deleteAgent}
        />
      </div>

      {/* Backdrop + Hamburger cho mobile */}
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 40 }}
        />
      )}
      {isMobile && !sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Mở danh sách agent"
          style={{
            position: 'fixed',
            top: 10,
            left: 10,
            zIndex: 45,
            width: 44,
            height: 44,
            borderRadius: 10,
            border: '1px solid #334155',
            background: '#111827',
            color: '#f8fafc',
            fontSize: 20,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 10px rgba(0,0,0,0.4)'
          }}
        >
          ☰
        </button>
      )}

      {/* Resizer (chỉ desktop) */}
      {!isMobile && (
      <div
        onMouseDown={(e) => {
          const startX = e.clientX;
          const startW = sidebarWidth;
          const onMove = (ev: MouseEvent) => {
            const nw = Math.max(240, Math.min(600, startW + ev.clientX - startX));
            setSidebarWidth(nw);
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        style={{
          width: 5,
          cursor: 'col-resize',
          background: 'var(--af-border)',
          flexShrink: 0,
          transition: 'background 0.2s'
        }}
        className="af-resizer"
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#3b82f6'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--af-border)'; }}
      />
      )}

      {/* Chat Area */}
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
          title={selectedAgentId ? (() => {
            const a = agents.find(x => x.id === selectedAgentId);
            return a ? `${a.name} (${a.id})${a.sessionTitle ? ` — ${a.sessionTitle}` : ''}` : 'Agent';
          })() : (() => {
            const a = agents.find(x => x.id === 'orchestrator');
            return a && a.sessionTitle ? `Orchestrator (orchestrator) — ${a.sessionTitle}` : 'Orchestrator (orchestrator)';
          })()}
          tokenUsage={selectedAgentId ? agents.find(x => x.id === selectedAgentId)?.tokenUsage : agents.find(x => x.id === 'orchestrator')?.tokenUsage}
          contextLength={selectedAgentId ? agents.find(x => x.id === selectedAgentId)?.contextLength : agents.find(x => x.id === 'orchestrator')?.contextLength}
          model={selectedAgentId ? agents.find(x => x.id === selectedAgentId)?.model : agents.find(x => x.id === 'orchestrator')?.model}
          status={selectedAgentId ? agents.find(x => x.id === selectedAgentId)?.status : agents.find(x => x.id === 'orchestrator')?.status}
          formatMessage={formatMessage}
          allMessages={filteredMessages}
          agents={agents}
          isMobile={isMobile}
          connStatus={connectionStatus}
          offlineForText={offlineForText}
          uptimeText={uptimeText}
          showToolBlocks={true}
          queuedMessages={queuedMessages}
          onFlushQueue={flushQueue}
        />
      </div>

      {/* Spawn Dialog */}
      {showSpawn && (
        <SpawnDialog onAdd={addAgent} onClose={() => setShowSpawn(false)} />
      )}

      {/* Model Hierarchy Settings Dialog */}
      {showModelSettings && (
        <ModelSettingsDialog
          agents={agents}
          onClose={() => setShowModelSettings(false)}
          onSaved={fetchAgents}
        />
      )}
    </div>
  );
}
