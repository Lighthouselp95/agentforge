import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Dashboard } from './components/Dashboard';
import { ChatPanel } from './components/ChatPanel';
import { SpawnDialog } from './components/SpawnDialog';
import { ModelSettingsDialog } from './components/ModelSettingsDialog';
import { TeamSettingsDialog } from './components/TeamSettingsDialog';
import { TabBar } from './components/TabBar';
import { parseAgentTaskList, renderAgentTaskList, ParsedAgentTask } from './utils/taskUtils';

const API = window.location.port === '5173' ? '' : (window.location.origin.startsWith('http') ? window.location.origin : 'http://localhost:4001');

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
  const [showTeamSettings, setShowTeamSettings] = useState(false);
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
  // Timestamp của chunk/event cuối cùng nhận được từ agentKey (để ngắt stream phân turn)
  const lastChunkAtRef = useRef<Record<string, number>>({});
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
  const upsertStreamMsg = (key: string, mut: (m: ChatMsg) => ChatMsg, teamId?: string, isNewTurn?: boolean) => {
    const now = Date.now();
    const lastActive = lastChunkAtRef.current[key] || 0;
    // Tự động phân tách turn stream mới nếu server gắn cờ isNewTurn hoặc gián đoạn > 10 giây
    if (isNewTurn || (lastActive > 0 && now - lastActive > 10000)) {
      delete streamRef.current[key];
    }
    lastChunkAtRef.current[key] = now;

    setAllMessages(prev => {
      let sid = streamRef.current[key];
      let list = prev;
      if (!sid || !prev.some(p => p.id === sid)) {
        sid = `stream-${key}-${Date.now()}`;
        streamRef.current[key] = sid;
        const targetAgent = agents.find(a => a.id === key || a.name === key);
        const agentRole = targetAgent?.role || targetAgent?.type || (key === 'orchestrator' ? 'orchestrator' : undefined);
        // Không bịa teamId kiểu team-${slice}: unknown agent → undefined (backend resolve đúng sau).
        const agentTeamId = teamId || targetAgent?.teamId || (key === 'orchestrator' ? 'default' : undefined);
        list = [...prev, { id: sid, from: key, to: 'user', content: '', timestamp: Date.now(), teamId: agentTeamId, agentRole }];
      }
      return list.map(m => m.id === sid ? mut(m) : m);
    });
  };

  // Handle realtime events from WS or SSE
  const handleRealtimeEvent = useCallback((msg: any) => {
    if (!msg || typeof msg !== 'object') return;

    // Khi backend xả queue và gửi thực sự đến OpenCode: dứt khoát xóa khỏi UI queue của agent tương ứng
    // Đảm bảo chỉ xóa queue sau khi bubble chat:message đã có mặt hoặc cập nhật atomic
    if (msg.type === 'chat:queue:dispatched' && msg.targetAgentId) {
      const key = String(msg.targetAgentId);
      const isOrch = key === 'orchestrator' || agents.some(a => a.id === key && (a.role === 'orchestrator' || a.type === 'orchestrator'));
      const targetKeys = isOrch ? Array.from(new Set([key, 'orchestrator'])) : [key];
      const msgIds = Array.isArray(msg.messageIds) ? new Set(msg.messageIds.map(String)) : null;

      // Hàm dọn queue an toàn
      const performQueueClear = () => {
        setAgentQueues(prev => {
          const updated = { ...prev };
          let hasChanges = false;

          targetKeys.forEach(tKey => {
            const q = prev[tKey];
            if (!q || q.length === 0) return;
            hasChanges = true;
            if (!msgIds || msgIds.size === 0) {
              delete updated[tKey];
            } else {
              // Lọc theo id trước; nếu không khớp id do lệch temp-id thì kiểm tra khớp content
              let remaining = q.filter(item => !msgIds.has(String(item.id)) && !msgIds.has(String(item.messageId)));
              // Fallback: nếu sau khi lọc ID mà độ dài queue không đổi, hoặc số tin dispatch bằng tổng queue, clear sạch để tránh kẹt temp ID cũ
              if (remaining.length === q.length && msgIds.size >= q.length) {
                delete updated[tKey];
              } else {
                if (remaining.length === 0) delete updated[tKey];
                else updated[tKey] = remaining;
              }
            }
          });

          return hasChanges ? updated : prev;
        });

        // Gỡ bỏ tag [QUEUED] trên bubble user nếu có
        setAllMessages(prev => prev.map(m => {
          const isMsgTarget = targetKeys.includes(String(m.to));
          if (m.from === 'user' && isMsgTarget && (m.isQueued || (typeof m.content === 'string' && m.content.startsWith('[QUEUED]')))) {
            if (!msgIds || msgIds.has(String(m.id)) || (msgIds.size > 0 && (!m.id || String(m.id).startsWith('temp-')))) {
              return {
                ...m,
                isQueued: false,
                content: typeof m.content === 'string' ? m.content.replace(/^\[QUEUED\]\s*/, '') : m.content
              };
            }
          }
          return m;
        }));
      };

      // Atomic check: kiểm tra allMessages đã có ít nhất 1 message bubble khớp với messageIds chưa
      setAllMessages(currentMsgs => {
        let hasRenderedBubble = true;
        if (msgIds && msgIds.size > 0) {
          hasRenderedBubble = currentMsgs.some(m => msgIds.has(String(m.id)));
        }

        if (hasRenderedBubble) {
          // Bubble đã render: xóa queue ngay lập tức
          performQueueClear();
        } else {
          // Chưa có bubble trong UI: giữ queue 1 tick (setTimeout/next tick) để chờ chat:message đến
          setTimeout(performQueueClear, 50);
        }
        return currentMsgs;
      });
    }

    // Safety: Khi nhận chat:message trùng ID hoặc content nằm trong agentQueues, xóa khỏi queue luôn
    // (đảm bảo khi server auto-drain sau STOP gửi chat:message mà không có chat:queue:dispatched)
    if (msg.type === 'chat:message' && msg.msg) {
      const m = msg.msg;
      if (m.from === 'user' && (m.id || m.content)) {
        const rawKey = String(m.to || 'orchestrator');
        const isOrch = rawKey === 'orchestrator' || agents.some(a => a.id === rawKey && (a.role === 'orchestrator' || a.type === 'orchestrator'));
        const checkKeys = isOrch ? Array.from(new Set([rawKey, 'orchestrator'])) : [rawKey];

        setAgentQueues(prev => {
          const updated = { ...prev };
          let changed = false;

          checkKeys.forEach(tKey => {
            const q = prev[tKey];
            if (!q || q.length === 0) return;
            const remaining = q.filter(item => {
              const idMatch = m.id && (item.id === m.id || item.messageId === m.id);
              const contentMatch = m.content && item.content === m.content && (item.to === m.to || (isOrch && (item.to === 'orchestrator' || !item.to)));
              return !idMatch && !contentMatch;
            });

            if (remaining.length !== q.length) {
              changed = true;
              if (remaining.length === 0) delete updated[tKey];
              else updated[tKey] = remaining;
            }
          });

          return changed ? updated : prev;
        });
      }
    }

    // Stream chữ chạy trực tuyến: chat:chunk { agentId?, from?, textDelta }
    if (msg.type === 'chat:chunk' && typeof msg.textDelta === 'string') {
      const key = String(msg.agentId || msg.from || 'orchestrator');
      // Gỡ bỏ tag [QUEUED] trên bubble user nếu có
      setAllMessages(prev => {
        const idx = prev.findIndex(m => m.from === 'user' && m.to === key && (m.isQueued || (typeof m.content === 'string' && m.content.startsWith('[QUEUED]'))));
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          isQueued: false,
          content: typeof next[idx].content === 'string' ? next[idx].content.replace(/^\[QUEUED\]\s*/, '') : next[idx].content
        };
        return next;
      });
      const delta = msg.textDelta;
      upsertStreamMsg(key, m => {
        const newParts = [...(m.parts || [])];
        const lastPart = newParts.length > 0 ? newParts[newParts.length - 1] : null;
        if (lastPart && (lastPart as any).type === 'text') {
          newParts[newParts.length - 1] = {
            ...lastPart,
            content: ((lastPart as any).content || '') + delta
          } as any;
        } else {
          newParts.push({ type: 'text' as any, content: delta });
        }
        return {
          ...m,
          content: (m.content || '') + delta,
          parts: newParts
        };
      }, msg.teamId, msg.isNewTurn);
    }

    // Thinking realtime: chat:thinking { agentId?, from?, thinkingText } — hiện hộp thinking live
    // trong CÙNG message stream với text (cùng key) để thinking tới TRƯỚC khi text chạy, không
    // chờ snapshot cuối (fix: text tới trước, thinking tới sau dù model reasoning trước).
    // Option A: push thinking vào parts xen kẽ đúng thứ tự emit (gộp consecutive thinking).
    if (msg.type === 'chat:thinking' && typeof msg.thinkingText === 'string' && msg.thinkingText.trim()) {
      const key = String(msg.agentId || msg.from || 'orchestrator');
      // Khi có event thinking stream từ server: opencode đã spawn và đang xử lý,
      // xóa queue nếu còn sót nhưng không đụng chạm đến bubble user đã render
      setAgentQueues(prev => {
        const q = prev[key];
        if (!q || q.length === 0) return prev;
        const updated = { ...prev };
        delete updated[key];
        return updated;
      });
      const thinkingDelta = msg.thinkingText;
      upsertStreamMsg(key, m => {
        const newParts = [...(m.parts || [])];
        const lastPart = newParts.length > 0 ? newParts[newParts.length - 1] : null;
        if (lastPart && (lastPart as any).type === 'thinking') {
          // Merge consecutive thinking parts: concatenate content
          newParts[newParts.length - 1] = {
            ...lastPart,
            content: ((lastPart as any).content || '') + '\n' + thinkingDelta
          } as any;
        } else {
          // Push new thinking part
          newParts.push({ type: 'thinking' as any, content: thinkingDelta });
        }
        return {
          ...m,
          thinking: (m.thinking ? m.thinking + '\n' : '') + thinkingDelta,
          parts: newParts
        };
      }, msg.teamId, msg.isNewTurn);
    }

    // Tool call realtime: chat:tool_call { agentId?, toolCall? | tool/input/output }
    if (msg.type === 'chat:tool_call') {
      const tcRaw = msg.toolCall ?? msg.tool_call ?? {};
      const key = String(msg.agentId || msg.from || 'orchestrator');
      const callId = tcRaw.callId || tcRaw.id || msg.callId;
      const toolName = String(tcRaw.tool ?? msg.tool ?? 'tool');
      const input = tcRaw.input ?? msg.input;
      const output = tcRaw.output ?? msg.output;

      const tc = {
        tool: toolName,
        input,
        output,
        ...(callId ? { callId } : {})
      };

      upsertStreamMsg(key, m => {
        const existingList = Array.isArray(m.toolCalls) ? [...m.toolCalls] : [];
        // Tìm xem toolcall này đã có chưa (theo callId hoặc match toolName đang chờ output)
        const matchIdx = callId
          ? existingList.findIndex((x: any) => x.callId === callId)
          : existingList.findLastIndex((x: any) => x.tool === toolName && !x.output && output);

        if (matchIdx !== -1) {
          // Đã có: Cập nhật output/input thay vì thêm mới
          existingList[matchIdx] = {
            ...existingList[matchIdx],
            input: input !== undefined ? input : existingList[matchIdx].input,
            output: output !== undefined ? output : existingList[matchIdx].output
          };
        } else {
          existingList.push(tc);
        }

        // Cập nhật tương tự cho m.parts
        const existingParts = Array.isArray(m.parts) ? [...m.parts] : [];
        const partMatchIdx = callId
          ? existingParts.findIndex((p: any) => p && p.type === 'tool' && p.callId === callId)
          : existingParts.findLastIndex((p: any) => p && p.type === 'tool' && p.tool === toolName && !p.output && output);

        if (partMatchIdx !== -1) {
          existingParts[partMatchIdx] = {
            ...existingParts[partMatchIdx],
            input: input !== undefined ? input : existingParts[partMatchIdx].input,
            output: output !== undefined ? output : existingParts[partMatchIdx].output
          };
        } else {
          existingParts.push({ type: 'tool', tool: tc.tool, input: tc.input, output: tc.output, ...(callId ? { callId } : {}) });
        }

        return {
          ...m,
          toolCalls: existingList,
          parts: existingParts
        };
      });
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
      let staleParts: any[] | undefined;
      // Single Stream-Message Flow: Bất kể tin chứa directive hay text thường,
      // nếu caller đang có stream active thì LUÔN merge/finalize trực tiếp vào streamRef đó.
      if (fkey && streamRef.current[fkey]) {
        const staleId = streamRef.current[fkey];
        // Stream-First Finalization: Tin cuối (canonical final) có content đầy đủ
        // TUYỆT ĐỐI KHÔNG xóa bản stream (không dùng prev.filter(x => x.id !== staleId))
        // mà cập nhật trực tiếp tại chỗ bản stream đang chứa parts xen kẽ (thinking, tool, text)
        delete streamRef.current[fkey];
        mergedIntoStream = true;
        setAllMessages(prev => prev.map(x => {
          if (x.id !== staleId) return x;
          return {
            ...x,
            id: m.id,
            from: m.from || x.from,
            to: m.to || x.to,
            content: (m.content && m.content.trim()) ? m.content : x.content,
            timestamp: m.timestamp || x.timestamp || Date.now(),
            agentName: m.agentName || x.agentName,
            agentRole: m.agentRole || x.agentRole,
            msgType: m.msgType || x.msgType,
            isStreaming: false,
            toolCalls: (m.toolCalls && m.toolCalls.length) ? m.toolCalls : x.toolCalls,
            thinking: m.thinking || x.thinking,
            parts: (m.parts && m.parts.length) ? m.parts : x.parts,
            teamId: m.teamId || x.teamId,
            task: (m as any).task || (x as any).task,
            showOnUI: (m as any).showOnUI !== undefined ? (m as any).showOnUI : (x as any).showOnUI
          };
        }));
      }
      if (!mergedIntoStream) {
        // Tự động giải phóng streamRef khi nhận tin canonical không merge (tránh stale stream cho turn sau)
        if (fkey) {
          delete streamRef.current[fkey];
        }
        setAllMessages(prev => {
          if (prev.some(p => p.id === m.id)) return prev;

          if (m.from === 'user') {
            const tempIdx = prev.findIndex(p => p.id.startsWith('temp-') && (p.content.trim() === (m.content || '').trim() || p.id === m.id));
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
                parts: m.parts || staleParts,
                teamId: m.teamId,
                task: (m as any).task,
                showOnUI: (m as any).showOnUI
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
            parts: m.parts || staleParts,
            teamId: m.teamId,
            task: (m as any).task,
            showOnUI: (m as any).showOnUI
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
          // Giải phóng streamRef dứt điểm khi agent chuyển trạng thái không còn working (idle/stopped/error)
          delete streamRef.current[ag.id];
          if (ag.name) delete streamRef.current[ag.name];
          const isOrch = ag.id === 'orchestrator' || ag.role === 'orchestrator' || ag.type === 'orchestrator';
          if (isOrch) {
            delete streamRef.current['orchestrator'];
            delete inflightTargetRef.current['orchestrator'];
          }
          // Dọn dẹp khay hàng đợi (agentQueues) để tránh tin queue bị kẹt khi agent stopped/idle
          setAgentQueues(prev => {
            const key = ag.id;
            const updated = { ...prev };
            let hasDel = false;
            if (updated[key]) {
              delete updated[key];
              hasDel = true;
            }
            if (isOrch && updated['orchestrator']) {
              delete updated['orchestrator'];
              hasDel = true;
            }
            return hasDel ? updated : prev;
          });
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
        const wsHost = window.location.port === '5173' ? 'localhost:4001' : window.location.host;
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
      const body: any = { message: (qmsg.content || '').normalize('NFC') };
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

  // Send message
  const sendMessage = async (text: string) => {
    const trimmedText = (text || '').trim().normalize('NFC');
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetId = selectedAgentId || 'orchestrator';

    // Reset stream cũ để không bao giờ bị merge lộn ngược vào turn trước
    delete streamRef.current[targetId];
    delete streamRef.current['orchestrator'];

    const targetAgentObj = agents.find(a => a.id === targetId);
    // Không bịa teamId kiểu team-${slice}: backend (POST /api/chat) resolve lại teamId đúng.
    const targetTeamId = targetAgentObj?.teamId || (targetId === 'orchestrator' ? 'default' : undefined);
    const userMsg: ChatMsg = {
      id: tempId,
      from: 'user',
      to: targetId,
      content: trimmedText,
      timestamp: Date.now(),
      teamId: targetTeamId
    };
    
    // Streamline Queue: Luôn gửi thẳng request POST /api/chat lên server ngay lập tức
    // Không chặn bởi state React (isTargetBusy / hasPendingQueue / inflightTargetRef)
    setLoading(true);

    try {
      const body: any = { message: text, teamId: targetTeamId, messageId: userMsg.id };
      if (selectedAgentId) body.targetAgentId = selectedAgentId;

      // 1. Phán đoán lạc quan: Nếu agent đích hiện tại đang bận (status === 'working')
      // thì đưa ngay vào hàng đợi UI lập tức để phản hồi tức thì với thao tác người dùng
      const isOptimisticBusy = targetAgentObj?.status === 'working';
      if (isOptimisticBusy) {
        setAgentQueues(prev => ({
          ...prev,
          [targetId]: [...(prev[targetId] || []), userMsg]
        }));
      }

      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => null);

      if (data?.queued) {
        // Server xác nhận đã đưa vào hàng đợi: đảm bảo item có mặt trong agentQueues và đồng bộ ID nếu server trả về ID khác
        const finalId = (data?.messageId || userMsg.id).toString();
        const queuedItem = finalId !== userMsg.id ? { ...userMsg, id: finalId } : userMsg;

        setAgentQueues(prev => {
          const cur = prev[targetId] || [];
          const exists = cur.some(item => item.id === userMsg.id || item.id === finalId || item.content === userMsg.content);
          if (exists) {
            // Nếu đã tồn tại nhưng mang tempId cũ, update sang finalId
            return {
              ...prev,
              [targetId]: cur.map(item => (item.id === userMsg.id ? queuedItem : item))
            };
          }
          return {
            ...prev,
            [targetId]: [...cur, queuedItem]
          };
        });
        setLoading(false);
        return;
      }

      // Nếu server không queue (agent thực tế đang idle):
      // Nếu trước đó đã lỡ add lạc quan vào queue thì dọn ra
      if (isOptimisticBusy) {
        setAgentQueues(prev => {
          const cur = prev[targetId] || [];
          const remaining = cur.filter(item => item.id !== userMsg.id);
          const updated = { ...prev };
          if (remaining.length === 0) delete updated[targetId];
          else updated[targetId] = remaining;
          return updated;
        });
      }

      // Hiển thị ngay tin nhắn người dùng vào bóng chat
      lastSendAtRef.current = Date.now();
      setAllMessages(prev => [...prev, userMsg]);

      if (!data || data.error) {
        setAllMessages(prev => {
          const errId = `err-${Date.now()}`;
          const errMsg = data?.error || 'Phản hồi không hợp lệ từ máy chủ';
          if (prev.some(p => p.content === `❌ Error: ${errMsg}`)) return prev;
          return [...prev, { id: errId, from: targetId, to: 'user', content: `❌ Error: ${errMsg}`, timestamp: Date.now(), msgType: 'error' }];
        });
        setLoading(false);
      }
    } catch (e: any) {
      setAllMessages(prev => [...prev, { id: `err-${Date.now()}`, from: targetId, to: 'user', content: `❌ Connection error: ${e.message}`, timestamp: Date.now(), msgType: 'error' }]);
      setLoading(false);
    }
  };

  const handleForceSendSingle = useCallback(async (msgId: string, content: string, targetId: string) => {
    setAgentQueues(prev => {
      const q = prev[targetId] || [];
      const updatedQ = q.filter(m => m.id !== msgId);
      const updated = { ...prev };
      if (updatedQ.length === 0) delete updated[targetId];
      else updated[targetId] = updatedQ;
      return updated;
    });
    setLoading(true);
    try {
      await fetch(`${API}/api/chat/force-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetAgentId: targetId,
          content,
          messageId: msgId,
          mode: 'single'
        })
      });
    } catch (e) {
      console.error('Force send single failed:', e);
    }
  }, []);

  const handleForceSendAll = useCallback(async (targetId: string) => {
    const q = agentQueues[targetId] || [];
    if (q.length === 0) return;
    const combined = q.length === 1 ? q[0].content : q.map((m, i) => `[Message ${i + 1}]:\n${m.content}`).join('\n\n---\n\n');
    setAgentQueues(prev => {
      const updated = { ...prev };
      delete updated[targetId];
      return updated;
    });
    setLoading(true);
    try {
      await fetch(`${API}/api/chat/force-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetAgentId: targetId,
          content: combined,
          mode: 'all'
        })
      });
    } catch (e) {
      console.error('Force send all failed:', e);
    }
  }, [agentQueues]);

  const isSystemMsg = (m: ChatMsg) => {
    if (!m) return true;
    if (m.showOnUI) return false;
    const content = (m.content || '').trim();
    // Tin hệ thống NỘI BỘ (from:'system') cho orchestrator (to:'orchestrator', msgType:'internal') → Ẩn khỏi UI.
    // GIỮ tin lỗi hệ thống hướng tới user (msgType:'error' / to:'user') để user vẫn thấy.
    if (m.from === 'system' && !(m.msgType === 'error') && m.to !== 'user') return true;
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

    // Nếu là tin nhắn giao việc (Directive, Talk, Spawn), TUYỆT ĐỐI KHÔNG ẨN:
    const content = String(m.content || '');
    const isDirective = m.msgType === 'talk' || /(?:\[(?:TALK|SPAWN|TASK)\]|<\s*(?:talk|spawn)\b)/i.test(content);
    if (isDirective) return false;

    // Chỉ ẩn các chỉ thị NỘI BỘ thuần túy do orchestrator gửi ĐI cho agent mà không phải directive giao việc
    if (m.from === 'orchestrator' && m.to && m.to !== 'user' && m.to !== 'broadcast') return true;
    // Tin hệ thống NỘI BỘ hướng tới orchestrator (forwardToOrchestrator: to='orchestrator', msgType='internal')
    // → không hiển thị trong main chat. Tin system hướng tới user (to:'user', msgType:'error') vẫn hiện.
    if (m.from === 'system' && m.to === 'orchestrator') return true;
    return false;
  };

  // Fix UI-dup: loại bỏ duplicate theo id và duplicate theo nội dung / timestamp
  const applyOacDedup = (list: typeof allMessages) => {
    const seenIds = new Set<string>();
    const seenContentKeys = new Set<string>();
    const out: typeof list = [];
    for (const m of list) {
      if (m.id) {
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
      }
      const trimmedContent = (m.content || '').trim();
      // Tránh lặp tin nhắn giống hệt nhau cùng người gửi trong cùng timestamp / gần nhau
      // Với msgType === 'talk', dedup theo (from, to, task/content) trong cửa sổ 60s
      if (trimmedContent && m.from) {
        const normContent = trimmedContent.replace(/\s+/g, ' ').slice(0, 200);
        const windowMs = m.msgType === 'talk' ? 60000 : 5000;
        const timeBucket = Math.floor((m.timestamp || 0) / windowMs);
        const taskKey = m.task ? (m.task as string).trim().replace(/\s+/g, ' ') : normContent;
        const contentKey = m.msgType === 'talk'
          ? `talk|${m.from}|${m.to || ''}|${taskKey}|${timeBucket}`
          : `${m.from}|${m.to || ''}|${normContent}|${timeBucket}`;
        if (seenContentKeys.has(contentKey)) continue;
        seenContentKeys.add(contentKey);
      }
      out.push(m);
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
            if (isInternalMsg(m)) return false;
            const orchTeamId = sel?.teamId || (sel?.id === 'orchestrator' ? 'default' : undefined);
            // orchTeamId undefined (agent lạ) → không lọc (hiện tất cả) thay vì lọc sai team bịa.
            // Ngoại lệ: tin nhắn user gửi tới Orchestrator (m.from === 'user' && (m.to === selectedAgentId || m.to === 'orchestrator'))
            // nếu có teamId là 'default' hoặc trùng orchTeamId thì luôn chấp nhận.
            if (orchTeamId && m.teamId && m.teamId !== orchTeamId) {
              const isOrchUserMsg = m.from === 'user' && (m.to === selectedAgentId || m.to === 'orchestrator' || !m.to);
              const isDefaultTeamOrch = (orchTeamId === 'default' && (!m.teamId || m.teamId === 'default')) ||
                                        (m.teamId === 'default' && (selectedAgentId === 'orchestrator' || sel?.id === 'orchestrator'));
              if (!isOrchUserMsg || !isDefaultTeamOrch) {
                return false;
              }
            }

            const isWorkerOpen = (m.msgType === 'opencode') && (m.from !== 'user') && (m.from !== selectedAgentId) && (m.agentRole !== 'orchestrator');
            if (isWorkerOpen) return false;

            if (m.msgType === 'opencode') {
              // Live stream từ stdio: chỉ hiển thị snapshot của CHÍNH orchestrator đang xem
              return m.from === selectedAgentId && !!(m.content || m.thinking || (m.toolCalls && m.toolCalls.length > 0) || (m.parts && m.parts.length > 0));
            }
            if (selectedAgentId !== 'orchestrator') {
              // Orchestrator số 2 trở đi (Sub-Orchestrator riêng biệt): Tuyệt đối KHÔNG gộp với 'orchestrator' gốc
              const isToSelf = m.to === selectedAgentId || (sel && m.to === sel.name);
              const isFromSelf = m.from === selectedAgentId || (sel && m.from === sel.name);
              const isFromRootOrch = m.from === 'orchestrator' || (!isFromSelf && (m.agentRole === 'orchestrator' || agents.some(a => a.id === m.from && (a.role === 'orchestrator' || a.type === 'orchestrator'))));
              const isFromWorker = m.from !== 'user' && !isFromSelf && !isFromRootOrch && m.from !== 'system' && m.from !== 'error';

              return (
                // Tin nhắn user gửi đích danh cho Sub-Orch này
                (m.from === 'user' && Boolean(isToSelf)) ||
                // Tin nhắn Sub-Orch này trả lời user hoặc broadcast
                (Boolean(isFromSelf) && (m.to === 'user' || m.to === 'broadcast')) ||
                // Chỉ đạo / directive do chính Sub-Orch này phát ra
                (Boolean(isFromSelf) && (
                  m.msgType === 'talk' ||
                  (typeof m.content === 'string' && /(?:\[(?:TALK|SPAWN|TASK)\]|<\s*(?:talk|spawn)\b)/i.test(m.content)) ||
                  (m.to && m.to !== 'user' && m.to !== 'broadcast')
                )) ||
                // Tin nhắn chỉ đạo từ Root Orchestrator gửi đến Sub-Orch này
                (Boolean(isFromRootOrch && isToSelf) && Boolean(m.showOnUI !== false)) ||
                // Báo cáo từ worker gửi riêng cho Sub-Orch này
                (isFromWorker && Boolean(isToSelf)) ||
                // Lỗi liên quan trực tiếp đến Sub-Orch này
                (m.msgType === 'error' && (Boolean(isToSelf) || Boolean(isFromSelf))) ||
                (m.from === 'error' && Boolean(isToSelf))
              );
            }

            const isFromWorker = m.from !== 'user' && m.from !== selectedAgentId && m.agentRole !== 'orchestrator' && m.from !== 'system' && m.from !== 'error';
            if (isFromWorker) {
              // Giữ lại báo cáo / trao đổi từ worker gửi về Orchestrator hoặc broadcast
              const isToOrch = m.to === selectedAgentId || m.to === 'orchestrator' || m.to === 'broadcast' || !m.to;
              const isReportOrTask = m.msgType === 'talk' || /(?:REPORT|HOÀN THÀNH|KẾT QUẢ|TIẾN ĐỘ|TASK|ERROR)/i.test(m.content || '');
              if (!isToOrch && !isReportOrTask) {
                return false;
              }
            }
            const isRootOrchSender = m.from === selectedAgentId || m.from === 'orchestrator';
            return (
              (m.from === 'user' && (m.to === selectedAgentId || m.to === 'orchestrator' || m.to === 'broadcast' || !m.to)) ||
              (isRootOrchSender && (m.to === 'user' || m.to === 'broadcast' || !m.to)) ||
              // Lệnh giao task (spawn/talk) của Root Orchestrator → agent: HIỂN THỊ thành cục riêng
              (isRootOrchSender &&
               (m.msgType === 'talk' || (typeof m.content === 'string' && /(?:\[(?:TALK|SPAWN|TASK)\]|<\s*(?:talk|spawn)\b)/i.test(m.content)) || (m.to && m.to !== 'user' && m.to !== 'broadcast'))) ||
              (isFromWorker && (m.to === selectedAgentId || m.to === 'orchestrator' || m.to === 'broadcast' || !m.to)) ||
              (m.msgType === 'error' && (m.to === 'user' || m.from === selectedAgentId || m.to === selectedAgentId || m.from === 'orchestrator')) ||
              (m.from === 'error' && (m.to === 'user' || m.to === selectedAgentId || m.to === 'orchestrator'))
            );
          }
          if (m.msgType === 'opencode') {
            // Live stream từ stdio: chỉ hiển thị snapshot của CHÍNH agent đang xem (from === selectedAgentId),
            // tránh thinking/tool của agent khác hiện lẫn vào view. Ẩn event tool-only (content rỗng).
            return m.from === selectedAgentId && !!(m.content || m.thinking || (m.toolCalls && m.toolCalls.length > 0) || (m.parts && m.parts.length > 0));
          }
          const isFromSel = m.from === selectedAgentId || (sel && (m.from === sel.id || m.from === sel.name));
          const isToSel = m.to === selectedAgentId || (sel && (m.to === sel.id || m.to === sel.name));
          return (
            Boolean(isFromSel) ||
            Boolean(isToSel) ||
            (m.msgType === 'error' && (Boolean(isFromSel) || Boolean(isToSel))) ||
            (m.from === 'error' && Boolean(isToSel))
          );
        });
        return base;
      })()
    : allMessages.filter(m => {
        if (isSystemMsg(m)) return false;
        if (isInternalMsg(m)) return false;
        // Fix 6.36: MAIN view chỉ hiển thị msg thuộc TEAM của Orchestrator đang active.
        // Mọi Main Orchestrator đều ngang hàng, không hardcode id 'orchestrator'.
        const defaultOrch = agents.find(a => a.type === 'orchestrator' || a.role === 'orchestrator' || a.id === 'orchestrator');
        const mainTeamId = defaultOrch?.teamId || 'default';
        if (m.teamId && m.teamId !== mainTeamId) {
          // Ngoại lệ: user message gửi tới main orchestrator mang teamId 'default' hoặc không có teamId thì luôn hiện
          const isMainOrchUserMsg = m.from === 'user' && (!m.to || m.to === 'orchestrator' || (defaultOrch && m.to === defaultOrch.id));
          const isDefaultTeamMatch = (mainTeamId === 'default' && (!m.teamId || m.teamId === 'default')) ||
                                     (m.teamId === 'default' && (!defaultOrch || defaultOrch.id === 'orchestrator'));
          if (!isMainOrchUserMsg || !isDefaultTeamMatch) {
            return false;
          }
        }
        // Tab Main: chỉ hiển thị snapshot 'opencode' của ROOT ORCHESTRATOR.
        // Ẩn hoàn toàn snapshots opencode của Sub-Orchestrators và Workers (msgType 'opencode', from !== orchId && from !== 'orchestrator').
        const orchId = defaultOrch?.id || 'orchestrator';
        const isNotRootOrch = (m.from !== orchId) && (m.from !== 'orchestrator');
        if (m.msgType === 'opencode' && isNotRootOrch) {
          return false;
        }
        if (m.msgType === 'opencode') {
          return (m.from === orchId || m.from === 'orchestrator') && !!(m.content || m.thinking || (m.toolCalls && m.toolCalls.length > 0) || (m.parts && m.parts.length > 0));
        }
        const isFromWorker = m.from !== 'user' && isNotRootOrch && m.from !== 'system' && m.from !== 'error';
        if (isFromWorker) {
          // Giữ lại báo cáo / phản hồi từ worker hoặc Sub-Orch gửi về Main Orchestrator hoặc broadcast
          const isToOrch = m.to === orchId || m.to === 'orchestrator' || m.to === 'broadcast' || !m.to;
          const isReportOrTask = m.msgType === 'talk' || /(?:REPORT|HOÀN THÀNH|KẾT QUẢ|TIẾN ĐỘ|TASK|ERROR)/i.test(m.content || '');
          if (!isToOrch && !isReportOrTask) {
            return false;
          }
        }
        const isDirective = (
          (m.from === orchId || m.from === 'orchestrator') &&
          (
            m.msgType === 'talk' ||
            (typeof m.content === 'string' && /(?:\[(?:TALK|SPAWN|TASK)\]|<\s*(?:talk|spawn)\b)/i.test(m.content)) ||
            (m.to && m.to !== 'user' && m.to !== 'orchestrator' && m.to !== 'broadcast')
          )
        );

        return (
          isDirective ||
          (m.from === 'user' && (m.to === orchId || m.to === 'orchestrator' || m.to === 'broadcast' || !m.to)) ||
          ((m.from === orchId || m.from === 'orchestrator') && (m.to === 'user' || m.to === 'broadcast' || !m.to)) ||
          (isFromWorker && (m.to === orchId || m.to === 'orchestrator' || m.to === 'broadcast' || !m.to)) ||
          (m.msgType === 'error' && (m.to === 'user' || m.from === orchId || m.from === 'orchestrator')) ||
          (m.from === 'error' && (m.to === 'user' || m.to === orchId || m.to === 'orchestrator'))
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
      const res = await fetch(`${API}/api/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        alert(data?.error || 'Không thể tạo agent');
        return;
      }
      setShowSpawn(false);
      fetchAgents();
    } catch (e: any) {
      console.error('Failed to add agent:', e);
      alert(`Lỗi khi tạo agent: ${e.message}`);
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

  const deleteTask = async (agentId: string, taskId: string | number) => {
    try {
      const res = await fetch(`${API}/api/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(String(taskId))}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.ok && data.agent) {
        setAgents(prev => prev.map(a => a.id === agentId ? { ...a, ...data.agent } : a));
      } else {
        fetchAgents();
      }
    } catch (e) {
      console.error('Failed to delete task:', e);
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
                onDeleteTask={deleteTask}
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

              {/* Team Settings Button */}
              <button
                onClick={() => setShowTeamSettings(true)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '8px 12px',
                  background: 'var(--bg-inset)',
                  color: '#60a5fa',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid rgba(59, 130, 246, 0.4)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.borderColor = '#60a5fa';
                  e.currentTarget.style.background = 'rgba(37, 99, 235, 0.15)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.4)';
                  e.currentTarget.style.background = 'var(--bg-inset)';
                }}
              >
                <span>👥</span>
                <span>Team Settings</span>
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
                selectedAgentId={selectedAgentId}
                title={selectedAgentId ? (() => {
                  const a = agents.find(x => x.id === selectedAgentId);
                  return a ? `${a.name} (${a.id})${a.sessionTitle ? ` — ${a.sessionTitle}` : ''}` : 'Agent';
                })() : (() => {
                  const a = agents.find(x => x.type === 'orchestrator' || x.role === 'orchestrator' || x.id === 'orchestrator');
                  return a ? `${a.name || 'Orchestrator'} (${a.id})${a.sessionTitle ? ` — ${a.sessionTitle}` : ''}` : 'Chưa có Orchestrator';
                })()}
                tokenUsage={selectedAgentId ? agents.find(x => x.id === selectedAgentId)?.tokenUsage : (agents.find(x => x.type === 'orchestrator' || x.role === 'orchestrator' || x.id === 'orchestrator')?.tokenUsage)}
                contextLength={selectedAgentId ? agents.find(x => x.id === selectedAgentId)?.contextLength : (agents.find(x => x.type === 'orchestrator' || x.role === 'orchestrator' || x.id === 'orchestrator')?.contextLength)}
                model={selectedAgentId ? agents.find(x => x.id === selectedAgentId)?.model : (agents.find(x => x.type === 'orchestrator' || x.role === 'orchestrator' || x.id === 'orchestrator')?.model)}
                status={selectedAgentId ? agents.find(x => x.id === selectedAgentId)?.status : (agents.find(x => x.type === 'orchestrator' || x.role === 'orchestrator' || x.id === 'orchestrator')?.status || 'idle')}
                formatMessage={formatMessage}
                allMessages={filteredMessages}
                agents={agents}
                isMobile={isMobile}
                connStatus={connectionStatus}
                offlineForText={offlineForText}
                uptimeText={uptimeText}
                showToolBlocks={true}
                queuedMessages={currentQueue}
                onFlushQueue={() => handleForceSendAll(activeTargetId)}
                onClearQueue={() => clearQueueForAgent(activeTargetId)}
                onForceSendSingle={handleForceSendSingle}
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
                                {renderAgentTaskList(parsedTasks, {
                                  agentId: ag.id,
                                  onDeleteTask: (tId) => deleteTask(ag.id, tId)
                                })}
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

      {/* Team Settings Dialog (Per-Team, defaults to current active agent's team or 'default') */}
      {showTeamSettings && (
        <TeamSettingsDialog
          teamId={selectedAgentId ? (agents.find(a => a.id === selectedAgentId)?.teamId || 'default') : 'default'}
          agents={agents}
          onClose={() => setShowTeamSettings(false)}
          onSaved={fetchAgents}
        />
      )}
    </div>
  );
}
