import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Dashboard } from './components/Dashboard';
import { ChatPanel } from './components/ChatPanel';
import { SpawnDialog } from './components/SpawnDialog';
import { ModelSettingsDialog } from './components/ModelSettingsDialog';
import { TabBar } from './components/TabBar';
import { parseAgentTaskList, renderAgentTaskList, ParsedAgentTask } from './utils/taskUtils';

const API = window.location.port === '5173' ? '' : (window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:3001');

interface ChatMsg {
  id: string;
  from: string;
  to: string;
  content: string;
  task?: string;
  timestamp?: number;
  agentName?: string;
  agentRole?: string;
  msgType?: string;
  showOnUI?: boolean;
  toolCalls?: Array<{ tool: string; input?: string; output?: string }>;
  thinking?: string;
  // Ordered parts (Option C): text + tool xen kẽ theo ĐÚNG thứ tự opencode emit — server gửi trong final snapshot.
  // Client render trực tiếp theo array, không cần split content. OPTIONAL (không có → render theo cách cũ).
  parts?: Array<{ type: 'text' | 'tool'; content?: string; tool?: string; input?: string; output?: string }>;
  teamId?: string;
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
  tasks?: Array<{ id?: string; task: string; status: string }>;
  spawnedBy?: string;
  sessionId?: string;
  sessionTitle?: string;
  model?: string;
  createdAt: number;
  workingSince?: number;
  tokenUsage?: TokenUsage | number;
  contextLength?: number;
  teamId?: string;
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
  const [spawnParentId, setSpawnParentId] = useState<string | null>(null);
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
  const [agentQueues, setAgentQueues] = useState<Record<string, ChatMsg[]>>({});
  const lastSendAtRef = useRef(0);
  // In-flight per-target: agentId -> đang gửi queued message. Thay gate loading GLOBAL (theo tab hiện tại)
  // bằng check riêng theo agent đích của queue để tin queue không bị giữ lại khi chuyển tab.
  const inflightTargetRef = useRef<Record<string, boolean>>({});
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('agentforge_sidebar_width');
      return saved ? Math.max(220, Math.min(650, parseInt(saved, 10))) : 320;
    } catch {
      return 320;
    }
  });
  const [enableWatchdog, setEnableWatchdog] = useState(true);
  const [autoContinue, setAutoContinue] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // Bản đồ agentKey -> id tin nhắn stream đang chạy (chat:chunk / chat:tool_call)
  const streamRef = useRef<Record<string, string>>({});
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('af-theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });
  // Workbench (VS Code-like) layout state
  const [activeView, setActiveView] = useState<'agents' | 'files' | 'settings'>('agents');
  const [panelOpen, setPanelOpen] = useState(false);
  const [showWorkingPopover, setShowWorkingPopover] = useState(false);
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('agentforge_panel_height') || '', 10);
      return Number.isFinite(v) ? Math.max(120, Math.min(240, v)) : 160;
    } catch { return 160; }
  });
  const [activityLog, setActivityLog] = useState<{ id: string; agentId: string; name: string; status: string; ts: number }[]>([]);

  // Fix underbar 6.43: KHÔNG tự mở bottom panel khi hàng đợi/agent working.
  // Panel chỉ mở khi user CHỦ ĐỘNG toggle (nút "▸/▾ Hoạt động & Hàng đợi" ở status bar).
  // Trước đây effect này tự setPanelOpen(true) khi queue 0->>0 → đẩy/bóp khung chat khó chịu.

  // Áp theme lên <html data-theme> + lưu lựa chọn (reload giữ nguyên)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('af-theme', theme); } catch {}
  }, [theme]);


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
    try {
      const res2 = await fetch(`${API}/api/settings/autoContinue`);
      const data2 = await res2.json();
      if (typeof data2.autoContinue === 'boolean') {
        setAutoContinue(data2.autoContinue);
      }
    } catch (e) {
      console.error('Failed to fetch autoContinue settings:', e);
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

  const toggleAutoContinue = async (enabled: boolean) => {
    setAutoContinue(enabled);
    try {
      await fetch(`${API}/api/settings/autoContinue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoContinue: enabled })
      });
    } catch (e) {
      console.error('Failed to update autoContinue settings:', e);
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
  const fetchHistory = async (agentId?: string | null) => {
    try {
      const targetParam = agentId ? `&agentId=${encodeURIComponent(agentId)}` : '';
      const res = await fetch(`${API}/api/history?limit=${HISTORY_FETCH_LIMIT}${targetParam}`);
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
  const upsertStreamMsg = (key: string, mut: (m: ChatMsg) => ChatMsg, teamId?: string) => {
    setAllMessages(prev => {
      let sid = streamRef.current[key];
      let list = prev;
      if (!sid || !prev.some(p => p.id === sid)) {
        sid = `stream-${key}-${Date.now()}`;
        streamRef.current[key] = sid;
        list = [...prev, { id: sid, from: key, to: 'user', content: '', timestamp: Date.now(), teamId }];
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
      upsertStreamMsg(key, m => ({ ...m, content: (m.content || '') + delta }), msg.teamId);
    }

    // Thinking realtime: chat:thinking { agentId?, from?, thinkingText } — hiện hộp thinking live
    // trong CÙNG message stream với text (cùng key) để thinking tới TRƯỚC khi text chạy, không
    // chờ snapshot cuối (fix: text tới trước, thinking tới sau dù model reasoning trước).
    if (msg.type === 'chat:thinking' && typeof msg.thinkingText === 'string' && msg.thinkingText.trim()) {
      const key = String(msg.agentId || msg.from || 'orchestrator');
      upsertStreamMsg(key, m => ({ ...m, thinking: (m.thinking ? m.thinking + '\n' : '') + msg.thinkingText }), msg.teamId);
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
       console.log('received chat:message content:', m.content);
      const fkey = String(m.from || '');
      let staleThinking: string | undefined;
      // Snapshot opencode (msgType==='opencode') content cố ý rỗng — merge thinking/tool.
      // Final reply rỗng (msgType≠opencode, VD lệnh điều phối bị strip) → không merge, gỡ stream + thay tin rỗng.
      const isOpenEmptySnapshot = !m.content || !String(m.content).trim();
      let mergedIntoStream = false;
      if (fkey && streamRef.current[fkey]) {
        const staleId = streamRef.current[fkey];
        if (isOpenEmptySnapshot && m.msgType === 'opencode') {
          // Snapshot trung gian content rỗng: CỘNG thinking/toolCalls vào bản stream đang chứa
          // text tích lũy THAY VÌ xóa + thay rỗng → text biến mất thành thinking không còn xảy ra.
          // Bản stream vẫn sống chờ tin final (có content đầy đủ) tới để thay thế.
          // FIX raw-wrap 6.40: snapshot rỗng KHÔNG kèm thinking mới && KHÔNG toolCalls mới
          // = final reply đã bị strip hết lệnh điều phối (content trống) → xóa bubble stream
          // rác đang giữ thẻ <talk>/<spawn> thô, thay bằng bubble rỗng thay vì giữ vĩnh viễn.
          const hasNewThinking = !!(m.thinking && String(m.thinking).trim());
          const hasNewToolCalls = !!(m.toolCalls && m.toolCalls.length);
          if (!hasNewThinking && !hasNewToolCalls) {
            delete streamRef.current[fkey];
            mergedIntoStream = true;
            setAllMessages(prev => prev.map(x => x.id !== staleId ? x : {
              ...x,
              thinking: undefined,
              content: '',
              toolCalls: undefined
            }));
          } else {
            mergedIntoStream = true;
            setAllMessages(prev => prev.map(x => x.id !== staleId ? x : {
              ...x,
              thinking: m.thinking ? (x.thinking ? x.thinking + '\n' + m.thinking : m.thinking) : x.thinking,
              toolCalls: (m.toolCalls && m.toolCalls.length) ? [...(x.toolCalls || []), ...m.toolCalls] : x.toolCalls
            }));
          }
        } else {
          // Tin cuối (canonical final) có content đầy đủ -> gỡ bản stream tạm để không trùng nội dung
          delete streamRef.current[fkey];
          setAllMessages(prev => {
            const staleMsg = prev.find(x => x.id === staleId);
            if (staleMsg) staleThinking = staleMsg.thinking;
            return prev.filter(x => x.id !== staleId);
          });
        }
      }
      if (!mergedIntoStream) {
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
                thinking: m.thinking || staleThinking,
                parts: m.parts,
                teamId: m.teamId
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
            thinking: m.thinking || staleThinking,
            parts: m.parts,
            teamId: m.teamId
          }];
          return nextList.length > MAX_DISPLAY_MESSAGES ? nextList.slice(-MAX_DISPLAY_MESSAGES) : nextList;
        });
      }
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

    if (msg.type === 'settings:updated' && typeof msg.autoContinue === 'boolean') {
      setAutoContinue(msg.autoContinue);
    }

    if (msg.type === 'agent:created' || msg.type === 'agent:updated' || msg.type === 'agent:deleted') {
      if (msg.type === 'agent:deleted') {
        const deletedId = msg.id || msg.agentId;
        if (deletedId) {
          setAgents(prev => prev.filter(a => a.id !== deletedId));
          // Agent bị xoá: dọn cờ in-flight để queue không bị kẹt vĩnh viễn bởi flag của agent đã mất
          delete inflightTargetRef.current[deletedId];
          if (selectedAgentId === deletedId) {
            setSelectedAgentId(null);
          }
        }
      }
      if (msg.agent) {
        const ag = msg.agent;
        const currentTarget = selectedAgentId || 'orchestrator';
        // Khi agent đích không còn working → xoá cờ in-flight để drain tin queue kế tiếp (nếu có).
        // Điều này cho phép tuple 2+ tin tới CÙNG agent vẫn được gửi tuần tự, không bị kẹt bởi 
        // cờ in-flight còn nguyên của lần gửi trước.
        if (ag.status !== 'working') {
          delete inflightTargetRef.current[ag.id];
        }
        // Sync 2 chiều: spinner BẬT khi working, TẮT khi idle/error/stopped
        if (ag.id === currentTarget) {
          setLoading(ag.status === 'working');
        }
        // Ghi activity log cho bottom panel (giữ ~200 dòng gần nhất)
        if (ag.id && ag.name) {
          const entry = { id: `${Date.now()}-${ag.id}`, agentId: ag.id, name: ag.name, status: ag.status, ts: Date.now() };
          setActivityLog(prev => [...prev.slice(-199), entry]);
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
    const targetId = qmsg.to || 'orchestrator';
    // Đánh dấu agent đích đang có 1 queued message in-flight
    inflightTargetRef.current[targetId] = true;
    const done = () => { delete inflightTargetRef.current[targetId]; };
    try {
      const body: any = { message: qmsg.content };
      if (targetId !== 'orchestrator') body.targetAgentId = targetId;
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);
      if (!data || data.error) {
        setAllMessages(prev => {
          const errId = `err-${Date.now()}`;
          const errMsg = data?.error || 'Phản hồi không hợp lệ từ máy chủ';
          if (prev.some(p => p.content === `❌ Error: ${errMsg}`)) return prev;
          return [...prev, { id: errId, from: targetId, to: 'user', content: `❌ Error: ${errMsg}`, timestamp: Date.now(), msgType: 'error' }];
        });
        setLoading(false);
        done();
      }
    } catch (e: any) {
      setAllMessages(prev => [...prev, { id: `err-${Date.now()}`, from: targetId, to: 'user', content: `❌ Connection error: ${e.message}`, timestamp: Date.now(), msgType: 'error' }]);
      setLoading(false);
      done();
    }
  };

  // Helper thêm tin vào hàng đợi riêng của từng agent
  const enqueueMessage = useCallback((targetId: string, msg: ChatMsg) => {
    setAgentQueues(prev => ({
      ...prev,
      [targetId]: [...(prev[targetId] || []), msg]
    }));
  }, []);

  // Xả gộp và gửi hàng đợi cho riêng 1 Agent
  const flushQueueForAgent = useCallback((targetId: string) => {
    setAgentQueues(prev => {
      const queue = prev[targetId] || [];
      if (queue.length === 0) return prev;
      const combined = queue.length === 1 ? queue[0].content : queue.map((m, i) => `[Message ${i + 1}]:\n${m.content}`).join('\n\n---\n\n');
      const batchMsg: ChatMsg = {
        id: `temp-batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        from: 'user',
        to: targetId,
        content: combined,
        timestamp: Date.now()
      };
      sendQueuedMessage(batchMsg);
      const updated = { ...prev };
      delete updated[targetId];
      return updated;
    });
  }, []);

  // Xóa riêng hàng đợi của 1 Agent
  const clearQueueForAgent = useCallback((targetId: string) => {
    setAgentQueues(prev => {
      const updated = { ...prev };
      delete updated[targetId];
      return updated;
    });
  }, []);

  // Xóa toàn bộ hàng đợi của tất cả agents
  const clearAllQueues = useCallback(() => {
    setAgentQueues({});
  }, []);

  // Auto-Drain Độc Lập 100%: Quét từng agent, nếu agent nào rảnh thì tự xả gửi tin mà KHÔNG bị nghẽn bởi agent khác
  useEffect(() => {
    const entries = Object.entries(agentQueues);
    if (entries.length === 0) return;

    for (const [tgtId, queue] of entries) {
      if (!queue || queue.length === 0) continue;
      
      const cur = agents.find(a => a.id === tgtId);
      const targetBusy = cur ? cur.status === 'working' : false;
      
      // Nếu agent đích đang bận -> giữ lại chờ riêng agent đó
      if (targetBusy) continue;
      
      // Nếu agent đích KHÔNG bận nhưng cờ in-flight còn sót -> tự động dọn cờ
      if (inflightTargetRef.current[tgtId]) {
        delete inflightTargetRef.current[tgtId];
      }
      
      const nextRaw = queue[0];
      const next: ChatMsg = { ...nextRaw, timestamp: Date.now() };
      
      // Pop 1 tin khỏi hàng đợi của riêng agent đó
      setAgentQueues(prev => {
        const q = prev[tgtId] || [];
        if (q.length <= 1) {
          const updated = { ...prev };
          delete updated[tgtId];
          return updated;
        }
        return {
          ...prev,
          [tgtId]: q.slice(1)
        };
      });
      
      sendQueuedMessage(next);
    }
  }, [agentQueues, agents]);

  // Send message
  const sendMessage = async (text: string) => {
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetId = selectedAgentId || 'orchestrator';
    const userMsg: ChatMsg = {
      id: tempId,
      from: 'user',
      to: targetId,
      content: text,
      timestamp: Date.now()
    };
    
    // Hàng đợi riêng từng agent: Chỉ xếp hàng nếu chính Agent đích đang bận hoặc chính nó đã có hàng đợi
    const curBusy = agents.find(a => a.id === targetId);
    const isTargetBusy = curBusy ? curBusy.status === 'working' : false;
    const targetQueue = agentQueues[targetId] || [];
    const hasPendingQueue = targetQueue.length > 0;
    
    if (isTargetBusy || hasPendingQueue || inflightTargetRef.current[targetId]) {
      enqueueMessage(targetId, userMsg);
      return;
    }
    
    lastSendAtRef.current = Date.now();
    setAllMessages(prev => [...prev, userMsg]);
    setLoading(true);
    inflightTargetRef.current[targetId] = true;

    try {
      const body: any = { message: text };
      if (selectedAgentId) body.targetAgentId = selectedAgentId;

      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);
      if (!data || data.error) {
        setAllMessages(prev => {
          const errId = `err-${Date.now()}`;
          const errMsg = data?.error || 'Phản hồi không hợp lệ từ máy chủ';
          if (prev.some(p => p.content === `❌ Error: ${errMsg}`)) return prev;
          return [...prev, { id: errId, from: targetId, to: 'user', content: `❌ Error: ${errMsg}`, timestamp: Date.now(), msgType: 'error' }];
        });
        setLoading(false);
        delete inflightTargetRef.current[targetId];
      }
    } catch (e: any) {
      setAllMessages(prev => [...prev, { id: `err-${Date.now()}`, from: targetId, to: 'user', content: `❌ Connection error: ${e.message}`, timestamp: Date.now(), msgType: 'error' }]);
      setLoading(false);
      delete inflightTargetRef.current[targetId];
    }
  };

  const isSystemMsg = (m: ChatMsg) => {
    if (!m) return true;
    if (m.showOnUI) return false;
    const content = (m.content || '').trim();
    return (
      m.msgType === 'transcript' ||
      m.msgType === 'heartbeat' ||
      m.msgType === 'ping' ||
      m.msgType === 'opencode_input' ||
      m.msgType === 'internal_prompt' ||
      content.startsWith('▶ INPUT (gửi opencode)') ||
      content.startsWith('=== TURN TRANSCRIPT') ||
      content.startsWith('=== SYSTEM STATUS CHECK') ||
      content.startsWith('=== SYSTEM CHECK') ||
      content.startsWith('=== RECOVERY ATTEMPT')
    );
  };

  const isInternalMsg = (m: ChatMsg) => {
    if (!m) return false;
    if (m.showOnUI) return false;
    // Only hide true internal planning messages from the main chat view.
    // Final summaries/reports from the orchestrator should remain visible.
    if (m.msgType === 'orchestrator_internal') return true;
    // Chỉ ẩn các chỉ thị NỘI BỘ do orchestrator gửi ĐI cho agent (ví dụ [TALK agent]).
    // NGỌAI LỆ: msgType 'talk' (spawn/talk giao task do server tạo) KHÔNG bị ẩn —
    // user yêu cầu hiển thị lệnh giao task của Orchestrator thành cục riêng trên khung main.
    // Tin agent báo cáo VỀ orchestrator (from=agent, to='orchestrator') PHẢI được hiển thị ở main view
    // để người dùng thấy agent phản hồi lại main.
    if (m.from === 'orchestrator' && m.msgType !== 'talk' && m.to && m.to !== 'user' && m.to !== 'broadcast') return true;
    return false;
  };

  // Fix interleave 6.44: dedup canonical reply khi snapshot opencode đã có text parts (interleave đầy đủ)
  const applyOacDedup = (list: typeof allMessages) => {
    const stripTypePrefix = (s: string) => {
      if (/^[A-Z_]+:\s/u.test(s) && !/^✖|^◆/u.test(s)) return s.replace(/^[A-Z_]+:\s?/u, '');
      return s;
    };
    const out: typeof list = [];
    // from → toàn bộ text parts (strip TYPE prefix) của snapshot opencode cuối, nối lại — để so khớp
    // với canonical reply (vốn là tổng hợp mọi text event, không chỉ segment cuối).
    const oacFullText = new Map<string, string>();
    for (const m of list) {
      const fkey = m.from || '';
      if (m.msgType === 'opencode' && Array.isArray((m as any).parts)) {
        const textParts = (m as any).parts.filter((p: any) => p && p.type === 'text' && String(p.content || '').trim().length > 0);
        if (textParts.length > 0) {
          oacFullText.set(fkey, textParts.map((p: any) => stripTypePrefix(String(p.content || ''))).join('\n').trim());
        }
        out.push(m);
      } else if (m.msgType !== 'opencode' && m.content && String(m.content).trim().length > 0) {
        const fullText = oacFullText.get(fkey);
        if (fullText !== undefined && String(m.content).trim() === fullText) {
          // drop redundant canonical reply — interleaved parts already cover this text
        } else {
          out.push(m);
        }
      } else {
        out.push(m);
      }
    }
    return out;
  };

  const filteredMessages = applyOacDedup(selectedAgentId
    ? (() => {
        const sel = agents.find(a => a.id === selectedAgentId);
        const isSubOrch = sel?.type === 'orchestrator' || sel?.role === 'orchestrator';
        const base = allMessages.filter(m => {
          if (isSystemMsg(m)) return false;
          if (isSubOrch) {
            if (m.msgType === 'opencode') {
              // Live stream từ stdio: chỉ hiển thị snapshot của CHÍNH agent đang xem (from === selectedAgentId),
              // tránh thinking/tool của agent khác hiện lẫn vào view. Ẩn event tool-only.
              return m.from === selectedAgentId && !!(m.content || m.thinking || (m.toolCalls && m.toolCalls.length > 0) || (m.parts && m.parts.length > 0));
            }
            if (m.from === selectedAgentId && m.to && m.to !== 'user' && m.to !== 'broadcast') return false;
            const isFromWorker = m.from !== 'user' && m.from !== selectedAgentId && m.agentRole !== 'orchestrator' && m.from !== 'system' && m.from !== 'error';
            if (isFromWorker) {
              return false; // Ẩn hoàn toàn báo cáo của worker trên màn hình Orchestrator
            }
            return (
              (m.from === 'user' && m.to === selectedAgentId) ||
              (m.from === selectedAgentId && (m.to === 'user' || m.to === 'broadcast' || !m.to)) ||
              (m.msgType === 'error' && (m.from === selectedAgentId || m.to === selectedAgentId)) ||
              (m.from === 'error' && m.to === selectedAgentId)
            );
          }
          if (m.msgType === 'opencode') {
            // Live stream từ stdio: chỉ hiển thị snapshot của CHÍNH agent đang xem (from === selectedAgentId),
            // tránh thinking/tool của agent khác hiện lẫn vào view. Ẩn event tool-only (content rỗng).
            return m.from === selectedAgentId && !!(m.content || m.thinking || (m.toolCalls && m.toolCalls.length > 0) || (m.parts && m.parts.length > 0));
          }
          return (
            m.from === selectedAgentId ||
            m.to === selectedAgentId ||
            (m.msgType === 'error' && (m.from === selectedAgentId || m.to === selectedAgentId)) ||
            (m.from === 'error' && m.to === selectedAgentId)
          );
        });
        // Fix interleave 6.44 (rework 6.33): GIỮ text+tool trong parts snapshot opencode để render xen kẽ.
        // Dedup canonical reply trùng nội dung: xử lý bởi applyOacDedup ở outer level — không cần inline.
        // Bỏ toàn bộ cơ chế gộp/splice client 6.33 (trước đây gộp snapshot + reply thành 1 bubble).
        // Server giờ giữ text+tool trong parts; applyOacDedup lọc reply trùng nội dung.
        return base;
      })()
    : allMessages.filter(m => {
        if (isSystemMsg(m)) return false;
        if (isInternalMsg(m)) return false;
        // Fix 6.36: MAIN view (orchestrator chính) chỉ hiển thị msg thuộc TEAM của chính nó.
        // Realtime broadcast KHÔNG lọc team (server gửi toàn bộ ws/sse clients) — snapshot/thinking/chunk
        // của sub-orch team khác hiện lẫn trên MAIN. History /api/history đã lọc team đúng, chỉ thiếu
        // REALTIME. Server giờ gắn teamId vào 3 event (chat:thinking/chat:chunk/chat:message opencode),
        // client lọc ở đây: msg mang teamId khác team MAIN → ẩn.
        const mainOrch = agents.find(a => a.id === 'orchestrator');
        const mainTeamId = mainOrch?.teamId || 'default';
        if (m.teamId && m.teamId !== mainTeamId) return false;
        // Tab Main: chỉ hiển thị snapshot 'opencode' của ORCHESTRATOR + agent mục tiêu người dùng chọn.
        // Ẩn hoàn toàn snapshots opencode của WORKER (msgType 'opencode', from=worker) — worker chỉ nên
        // thấy ở tab agent của chính nó, không hiện lên màn hình MAIN (orchestrator view). Không xóa dữ liệu.
        const isWorkerOpen = (m.msgType === 'opencode') && (m.from !== 'user') && (m.from !== 'orchestrator') && (m.agentRole !== 'orchestrator');
        if (isWorkerOpen) {
          return false;
        }
        if (m.msgType === 'opencode') {
          return !!(m.content || m.thinking || (m.toolCalls && m.toolCalls.length > 0) || (m.parts && m.parts.length > 0));
        }
        const isFromWorker = m.from !== 'user' && m.from !== 'orchestrator' && m.agentRole !== 'orchestrator' && m.from !== 'system' && m.from !== 'error';
        if (isFromWorker) {
          // ẨN 100% tin nhắn và báo cáo của worker trên màn hình chat Main
          return false;
        }
        return (
          (m.from === 'user' && (m.to === 'orchestrator' || !m.to)) ||
          ((m.from === 'orchestrator' || m.agentRole === 'orchestrator') && (m.to === 'user' || m.to === 'broadcast' || !m.to)) ||
          // Lệnh giao task (spawn/talk) của Orchestrator → agent: HIỂN THỊ thành cục riêng trên main
          ((m.from === 'orchestrator' || m.agentRole === 'orchestrator') && m.msgType === 'talk' && m.to && m.to !== 'user' && m.to !== 'broadcast') ||
          (m.msgType === 'error' && (m.to === 'user' || m.from === 'orchestrator')) ||
          (m.from === 'error' && (m.to === 'user' || m.to === 'orchestrator'))
        );
      })
  );

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
    fetchHistory(agentId);
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
        overflowX: 'hidden',
        transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.25s ease',
        boxShadow: sidebarOpen ? '4px 0 24px rgba(0,0,0,0.5)' : 'none'
      }
    : {
        width: sidebarWidth,
        minWidth: 180,
        maxWidth: 600,
        borderRight: '1px solid var(--af-border)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-panel)',
        overflowX: 'hidden'
      };

  return (
    <div className="af-shell" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-main)', color: 'var(--text-primary)', overflow: 'hidden', position: 'relative' }}>

      {/* ===== TOP ROW: Activity bar + Sidebar + Resizer + Chat column ===== */}
      <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* Activity Bar (ẩn trên mobile) */}
        {!isMobile && (
          <div className="af-activitybar" role="navigation" aria-label="Activity bar">
            {[
              { id: 'agents', icon: '👥', label: 'Agents' },
              { id: 'files', icon: '📄', label: 'Files' },
              { id: 'settings', icon: '⚙️', label: 'Settings' }
            ].map(item => (
              <div key={item.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 48 }}>
                <button
                  className={`af-activitybar-item${activeView === item.id ? ' af-active' : ''}`}
                  onClick={() => setActiveView(item.id as 'agents' | 'files' | 'settings')}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={activeView === item.id ? 'page' : undefined}
                >
                  {item.icon}
                </button>
                <span className="af-activitybar-title">{item.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Sidebar — nội dung đổi theo activeView */}
        <div className="af-sidebar" style={sidebarStyle}>
          {/* Header luôn hiển thị logo + tên app */}
          <div style={{ padding: '16px 14px', borderBottom: '1px solid #1e293b' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'nowrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap' }}>
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
                <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
                  AgentForge
                </h2>
              </div>
              {/* Theme toggle giữ ở header sidebar */}
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
            </div>
          </div>

          {/* View: Agents */}
          {activeView === 'agents' && (
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', flex: 1 }}>
              <Dashboard
                agents={agents}
                onStart={startAgent}
                onSpawn={(parentId) => {
                  setSpawnParentId(parentId || selectedAgentId || 'orchestrator');
                  setShowSpawn(true);
                }}
                onSelect={selectAgent}
                selectedAgentId={selectedAgentId}
                onUpdateModel={updateAgentModel}
                onDeleteAgent={deleteAgent}
              />
            </div>
          )}

          {/* View: Settings */}
          {activeView === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', overflowY: 'auto', flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                Cài đặt
              </div>

              {/* Watchdog Toggle Switch */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
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

              {/* Auto Continue Toggle Switch */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: 'var(--bg-inset)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--af-border)'
              }}>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', userSelect: 'none' }} title="Khi mở app lại, tự động ping các agent đang working để tiếp tục task dở (không cần thao tác lại)">
                  ▶️ Auto Continue
                </span>
                <label style={{ position: 'relative', display: 'inline-block', width: 34, height: 18, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={autoContinue}
                    onChange={(e) => toggleAutoContinue(e.target.checked)}
                    style={{ opacity: 0, width: 0, height: 0 }}
                  />
                  <span style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: autoContinue ? '#2563eb' : '#475569',
                    borderRadius: 18,
                    transition: '0.2s'
                  }}>
                    <span style={{
                      position: 'absolute',
                      content: '""',
                      height: 14,
                      width: 14,
                      left: autoContinue ? 17 : 2,
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
          )}

          {/* View: Files (placeholder cho tương lai) */}
          {activeView === 'files' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 14px', overflowY: 'auto', flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Files
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                📄 Explorer file sẽ được bổ sung trong phiên bản sau.
              </div>
            </div>
          )}
        </div>

        {/* Resizer (chỉ desktop) */}
        {!isMobile && (
        <div
          onMouseDown={(e) => {
            const startX = e.clientX;
            const startW = sidebarWidth;
            const onMove = (ev: MouseEvent) => {
              const nw = Math.max(220, Math.min(650, startW + ev.clientX - startX));
              setSidebarWidth(nw);
              try { localStorage.setItem('agentforge_sidebar_width', String(nw)); } catch {}
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

        {/* Chat column: ChatPanel (gỡ bỏ top TabBar để tối đa hóa không gian đọc & soạn thảo) */}
        {(() => {
          const activeTargetId = selectedAgentId || 'orchestrator';
          const currentQueue = agentQueues[activeTargetId] || [];
          return (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
              <ChatPanel
                messages={filteredMessages.map(m => ({
                  id: m.id,
                  agentId: m.from,
                  role: m.from === 'user' ? 'user' : 'assistant',
                  content: m.content,
                  timestamp: m.timestamp,
                  thinking: m.thinking
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
                queuedMessages={currentQueue}
                onFlushQueue={() => flushQueueForAgent(activeTargetId)}
                onClearQueue={() => clearQueueForAgent(activeTargetId)}
                onRemoveQueueItem={(idx) => {
                  setAgentQueues(prev => {
                    const q = prev[activeTargetId] || [];
                    if (idx < 0 || idx >= q.length) return prev;
                    const nextQ = q.filter((_, i) => i !== idx);
                    if (nextQ.length === 0) {
                      const updated = { ...prev };
                      delete updated[activeTargetId];
                      return updated;
                    }
                    return { ...prev, [activeTargetId]: nextQ };
                  });
                }}
              />
            </div>
          );
        })()}
      </div>

      {/* Backdrop + Hamburger cho mobile (nằm ngoài sidebar vì sidebar có transform) */}
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

      {/* ===== CORNER FLOATING WIDGET (X working · Live) & POPOVER ===== */}
      {(() => {
        const workingAgents = agents.filter(a => a.status === 'working');
        const workingCount = workingAgents.length;
        const totalQueuedCount = Object.values(agentQueues).reduce((sum, q) => sum + (q ? q.length : 0), 0);

        return (
          <>
            {/* Popover Window khi bấm vào Widget */}
            {showWorkingPopover && (() => {
              const activeCount = agents.length;
              return (
                <div
                  style={{
                    position: 'fixed',
                    bottom: 48,
                    right: 16,
                    width: isMobile ? 'calc(100vw - 32px)' : 380,
                    maxHeight: 520,
                    background: 'var(--bg-panel, #0e131d)',
                    border: '1px solid var(--af-border-strong)',
                    borderRadius: 12,
                    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.55)',
                    zIndex: 75,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    animation: 'fadeIn 0.15s ease-out'
                  }}
                >
                  {/* Popover Header */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    background: 'var(--bg-input, #151d2c)',
                    borderBottom: '1px solid var(--af-border)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 14 }}>👥</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
                        Thành viên & Nhiệm vụ ({activeCount})
                      </span>
                    </div>
                    <button
                      onClick={() => setShowWorkingPopover(false)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        fontSize: 14,
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: 4
                      }}
                      title="Đóng cửa sổ"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Popover Content — All Agents Grouped */}
                  <div style={{
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    overflowY: 'auto',
                    maxHeight: 400
                  }}>
                    {agents.length === 0 ? (
                      <div style={{
                        textAlign: 'center',
                        padding: '20px 10px',
                        color: 'var(--text-muted)',
                        fontSize: 12
                      }}>
                        <div style={{ fontSize: 24, marginBottom: 6 }}>👥</div>
                        Chưa có agent nào trong team.
                      </div>
                    ) : (
                      // Sắp xếp: working lên đầu, sau đó đến blocked/error, rồi idle, stopped
                      [...agents].sort((a, b) => {
                        const rank = (s: string) => s === 'working' ? 0 : (s === 'error' || s === 'blocked') ? 1 : s === 'idle' ? 2 : 3;
                        return rank(a.status) - rank(b.status);
                      }).map(ag => {
                        const isWorking = ag.status === 'working';
                        const isError = ag.status === 'error' || ag.status === 'blocked';
                        const isIdle = ag.status === 'idle';
                        const statusColor = isWorking ? '#4ade80' : isError ? '#f87171' : isIdle ? '#94a3b8' : '#64748b';
                        const statusBg = isWorking ? 'rgba(34, 197, 94, 0.15)' : isError ? 'rgba(239, 68, 68, 0.15)' : 'rgba(148, 163, 184, 0.12)';
                        const statusBorder = isWorking ? 'rgba(34, 197, 94, 0.35)' : isError ? 'rgba(239, 68, 68, 0.35)' : 'rgba(148, 163, 184, 0.25)';
                        const elapsed = isWorking && ag.workingSince ? formatElapsed(Date.now() - ag.workingSince) : '';
                        const parsedTasks = parseAgentTaskList(ag);

                        return (
                          <div
                            key={ag.id}
                            onClick={() => {
                              selectAgent(ag.id);
                              setShowWorkingPopover(false);
                            }}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                              padding: '10px 12px',
                              background: isWorking
                                ? 'rgba(59, 130, 246, 0.08)'
                                : isError
                                ? 'rgba(239, 68, 68, 0.08)'
                                : 'rgba(255, 255, 255, 0.02)',
                              border: `1px solid ${isWorking ? 'rgba(59, 130, 246, 0.4)' : isError ? 'rgba(239, 68, 68, 0.4)' : 'var(--af-border)'}`,
                              borderRadius: 8,
                              cursor: 'pointer',
                              transition: 'all 0.15s ease'
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.borderColor = 'var(--accent, #3b82f6)';
                              e.currentTarget.style.background = isWorking ? 'rgba(59, 130, 246, 0.14)' : 'rgba(59, 130, 246, 0.06)';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.borderColor = isWorking ? 'rgba(59, 130, 246, 0.4)' : isError ? 'rgba(239, 68, 68, 0.4)' : 'var(--af-border)';
                              e.currentTarget.style.background = isWorking ? 'rgba(59, 130, 246, 0.08)' : isError ? 'rgba(239, 68, 68, 0.08)' : 'rgba(255, 255, 255, 0.02)';
                            }}
                            title="Bấm để chuyển nhanh sang tab agent này"
                          >
                            {/* Header: Agent Name + Role + Status Badge */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                                {ag.type === 'orchestrator' || ag.id === 'orchestrator' ? '👑' : '🤖'} {ag.name} <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>({ag.role})</span>
                              </span>
                              <span style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 10,
                                fontWeight: 700,
                                color: statusColor,
                                background: statusBg,
                                padding: '1px 6px',
                                borderRadius: 4,
                                border: `1px solid ${statusBorder}`,
                                textTransform: 'uppercase'
                              }}>
                                {isWorking && <span className="pulsing-green" style={{ width: 5, height: 5, borderRadius: '50%', background: '#22c55e' }} />}
                                {isError && <span>⚠️</span>}
                                {ag.status}{elapsed ? ` (${elapsed})` : ''}
                              </span>
                            </div>

                            {/* Task Content with #1, #2, #3 numbering */}
                            {Array.isArray(parsedTasks) && parsedTasks.length > 0 ? (
                              <div style={{
                                maxHeight: 110,
                                overflowY: 'auto',
                                paddingRight: 2
                              }}>
                                {renderAgentTaskList(parsedTasks)}
                              </div>
                            ) : (
                              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', paddingLeft: 4 }}>
                                (Chưa gán nhiệm vụ cụ thể)
                              </div>
                            )}

                            <div style={{ fontSize: 10, color: 'var(--accent, #3b82f6)', textAlign: 'right', fontWeight: 600 }}>
                              👉 Bấm để chuyển tab
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Popover Footer Info */}
                  <div style={{
                    padding: '8px 12px',
                    background: 'var(--bg-input, #151d2c)',
                    borderTop: '1px solid var(--af-border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 11,
                    color: 'var(--text-muted)'
                  }}>
                    <span>📁 {serverCwd ? serverCwd.split('\\').pop() : 'cwd'}</span>
                    {serverVersion && <span>v{serverVersion}</span>}
                  </div>
                </div>
              );
            })()}

            {/* Corner Floating Widget */}
            <div
              onClick={() => setShowWorkingPopover(prev => !prev)}
              style={{
                position: 'fixed',
                bottom: 8,
                right: 14,
                zIndex: 70,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 11px',
                background: showWorkingPopover ? 'var(--bg-input, #151d2c)' : 'rgba(14, 19, 29, 0.88)',
                backdropFilter: 'blur(12px)',
                border: `1px solid ${workingCount > 0 ? 'rgba(34, 197, 94, 0.45)' : 'var(--af-border-strong)'}`,
                borderRadius: 9999,
                boxShadow: workingCount > 0 ? '0 4px 20px rgba(34, 197, 94, 0.25)' : '0 4px 20px rgba(0, 0, 0, 0.4)',
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'all 0.2s ease'
              }}
              title="Bấm để mở danh sách task & agent đang chạy"
            >
              <span
                className={connected ? (workingCount > 0 ? 'pulsing-green' : '') : 'pulsing-red'}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  backgroundColor: connected ? (workingCount > 0 ? '#22c55e' : '#4ade80') : '#ef4444',
                  display: 'inline-block'
                }}
              />
              <span style={{
                fontSize: 11,
                fontWeight: 700,
                color: connected ? (workingCount > 0 ? '#4ade80' : 'var(--text-primary)') : '#f87171',
                maxWidth: isMobile ? 220 : 340,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>
                {`${workingCount} working · ${connected ? "Live" : "Offline"}`}
              </span>
              <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
                {showWorkingPopover ? '▾' : '▴'}
              </span>
            </div>
          </>
        );
      })()}

      {/* Spawn Dialog */}
      {showSpawn && (
        <SpawnDialog
          onAdd={addAgent}
          onClose={() => setShowSpawn(false)}
          agents={agents}
          defaultSpawnedBy={spawnParentId || (selectedAgentId && agents.find(a => a.id === selectedAgentId)?.type === 'orchestrator' ? selectedAgentId : 'orchestrator')}
        />
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
