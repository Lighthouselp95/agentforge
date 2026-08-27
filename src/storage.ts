// Fast, Robust, Crash-Resilient JSON Storage with Atomic Write & Auto-Backup
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  statSync
} from 'fs';

const __dirname_storage = dirname(fileURLToPath(new URL('.', import.meta.url)));
const STORAGE_CANDIDATE_ROOTS = [
  process.cwd(),
  dirname(process.execPath),
  join(dirname(process.execPath), '..'),
  join(__dirname_storage, '..'),
  join(__dirname_storage, '../..'),
];
function resolveProjectRootForStorage(): string {
  // Uu tien tim package.json (goc project that) truoc — tranh release/data rong thang the
  for (const r of STORAGE_CANDIDATE_ROOTS) {
    if (existsSync(join(r, 'package.json'))) return r;
  }
  // Fallback: chon thu muc co state file lon nhat (nhieu du lieu nhat)
  let best: string | null = null;
  let bestSize = -1;
  for (const r of STORAGE_CANDIDATE_ROOTS) {
    const p = join(r, 'data', 'agentforge-state.json');
    if (existsSync(p)) {
      try {
        const sz = statSync(p).size;
        if (sz > bestSize) { bestSize = sz; best = r; }
      } catch {}
    }
    if (existsSync(join(r, '.opencode')) && best === null) best = r;
  }
  if (best) return best;
  return process.cwd();
}
const PROJECT_ROOT_STORAGE = resolveProjectRootForStorage();
const DATA_DIR = join(PROJECT_ROOT_STORAGE, 'data');
const STATE_FILE = join(DATA_DIR, 'agentforge-state.json');
const BAK_FILE = join(DATA_DIR, 'agentforge-state.json.bak');

// Cap lưu trữ lịch sử chat (in-memory + persist). Yêu cầu user: tối thiểu 15.000 tin.
// Ghi đĩa vẫn dùng atomicWriteFile + .bak sẵn có nên an toàn mất điện/restart.
export const MAX_PERSISTED_MESSAGES = 15000;

// Ensure data dir exists
mkdirSync(DATA_DIR, { recursive: true });

export interface OutboxReport {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  fromAgentRole: string;
  to: string;            // 'orchestrator' hoặc agent id
  message: string;
  createdAt: number;
  attempts: number;
  status: 'pending' | 'delivered' | 'failed';
  lastError?: string;
}

// Hàng đợi chat user thất bại do backend (LLM) sập / lỗi mạng.
// Lưu trên disk (cùng state file) → không mất tin nhắn, tự gửi lại khi backend sống.
export interface ChatQueueItem {
  id: string;
  targetAgentId: string;   // '' hoặc 'orchestrator' nghĩa là gửi cho Orchestrator
  rawMsg: string;
  isSlashCommand: boolean;
  attempts: number;
  nextAttemptAt: number;   // epoch ms: thời điểm sớm nhất được phép retry
  createdAt: number;
  lastError?: string;
}

interface StorageSchema {
  agents: any[];
  history: any[];
  settings?: Record<string, any>;
  outbox?: OutboxReport[];
  chatQueue?: ChatQueueItem[];
  unprocessedUserMessages?: Record<string, string[]>;
}

let inMemoryAgents = new Map<string, any>();
let inMemoryHistory: any[] = [];
let inMemorySettings: Record<string, any> = {};
let inMemoryOutbox: OutboxReport[] = [];
let inMemoryChatQueue: ChatQueueItem[] = [];
let inMemoryUnprocessedUserMessages: Record<string, string[]> = {};
let isDirty = false;
let isWriting = false;

function validateSchema(data: any): data is StorageSchema {
  return (
    data !== null &&
    typeof data === 'object' &&
    Array.isArray(data.agents) &&
    Array.isArray(data.history)
  );
}

function parseStateContent(raw: string): StorageSchema | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const data = JSON.parse(raw);
    if (validateSchema(data)) {
      return data;
    }
  } catch {}
  return null;
}

// Load state on startup with auto-recovery from backup
function loadStateFromDisk() {
  let loadedState: StorageSchema | null = null;
  let loadedFromBackup = false;

  // 1. Try reading primary state file
  if (existsSync(STATE_FILE)) {
    try {
      const stats = statSync(STATE_FILE);
      if (stats.size > 0) {
        const raw = readFileSync(STATE_FILE, 'utf-8');
        loadedState = parseStateContent(raw);
        if (!loadedState) {
          console.warn(`[Storage] Primary state file ${STATE_FILE} contains invalid or corrupted JSON.`);
        }
      } else {
        console.warn(`[Storage] Primary state file ${STATE_FILE} is 0 bytes (empty).`);
      }
    } catch (e: any) {
      console.warn(`[Storage] Failed to read primary state file: ${e.message}`);
    }
  }

  // 2. If primary file missing or corrupted, attempt recovery from backup
  if (!loadedState && existsSync(BAK_FILE)) {
    try {
      const stats = statSync(BAK_FILE);
      if (stats.size > 0) {
        const rawBak = readFileSync(BAK_FILE, 'utf-8');
        loadedState = parseStateContent(rawBak);
        if (loadedState) {
          loadedFromBackup = true;
          console.log(`[Storage] Successfully auto-recovered state from backup file: ${BAK_FILE}`);
        } else {
          console.warn(`[Storage] Backup file ${BAK_FILE} is also corrupted.`);
        }
      }
    } catch (e: any) {
      console.warn(`[Storage] Failed to read backup file: ${e.message}`);
    }
  }

  // 3. Populate in-memory structures
  if (loadedState) {
    inMemoryAgents.clear();
    for (const a of loadedState.agents) {
      if (a && a.id) {
        // Process cũ đã chết khi restart: agent còn kẹt status='working' phải trả về 'idle'
        // để badge không treo vàng mãi (không còn tiến trình nào đang chạy nữa).
        if (a.status === 'working') {
          a.status = 'idle';
          a.workingSince = undefined;
        }
        inMemoryAgents.set(a.id, a);
      }
    }
    inMemoryHistory = loadedState.history;
    inMemorySettings = (loadedState as any).settings || {};
    inMemoryOutbox = loadedState.outbox || [];
    inMemoryChatQueue = (loadedState as any).chatQueue || [];
    inMemoryUnprocessedUserMessages = (loadedState as any).unprocessedUserMessages || {};

    // If we recovered from backup or if backup doesn't exist yet, ensure backup is up to date
    if (loadedFromBackup) {
      writeStateSync();
    } else if (!existsSync(BAK_FILE) && existsSync(STATE_FILE)) {
      try {
        copyFileSync(STATE_FILE, BAK_FILE);
      } catch {}
    }
  } else {
    // Clean initial state
    inMemoryAgents.clear();
    inMemoryHistory = [];
  }
}

// Atomic write helper with fsync and safe rename
function atomicWriteFile(targetPath: string, content: string) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  
  // Write to temporary file with explicit fsync to guarantee flush to physical disk
  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, content, 0, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  // Atomic replacement with retry loop for Windows EPERM/EBUSY locking
  let renamed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmpPath, targetPath);
      renamed = true;
      break;
    } catch (e: any) {
      if (attempt === 4) {
        // Fallback: copyFileSync + unlinkSync
        try {
          copyFileSync(tmpPath, targetPath);
          renamed = true;
        } catch (copyErr: any) {
          throw new Error(`Failed to commit atomic write to ${targetPath}: ${e.message} / ${copyErr.message}`);
        }
      }
    }
  }

  if (existsSync(tmpPath)) {
    try { unlinkSync(tmpPath); } catch {}
  }
}

// Write in-memory state to disk atomically and maintain .bak file
function writeStateSync() {
  if (isWriting) return;
  isWriting = true;

  try {
    const data: StorageSchema = {
      agents: Array.from(inMemoryAgents.values()),
      history: inMemoryHistory.slice(-MAX_PERSISTED_MESSAGES),
      settings: inMemorySettings,
      outbox: inMemoryOutbox.slice(-500),
      chatQueue: inMemoryChatQueue.slice(-200),
      unprocessedUserMessages: inMemoryUnprocessedUserMessages
    };
    const content = JSON.stringify(data, null, 2);

    // 1. Maintain backup: if primary state file exists and is non-empty, back it up
    if (existsSync(STATE_FILE)) {
      try {
        const stats = statSync(STATE_FILE);
        if (stats.size > 0) {
          atomicWriteFile(BAK_FILE, readFileSync(STATE_FILE, 'utf-8'));
        }
      } catch {}
    }

    // 2. Atomically write new state to primary file
    atomicWriteFile(STATE_FILE, content);
    isDirty = false;
  } catch (e: any) {
    console.error(`[Storage] State write error: ${e.message}`);
  } finally {
    isWriting = false;
  }
}

let saveTimer: NodeJS.Timeout | null = null;

function schedulePersist(immediate = false) {
  isDirty = true;
  if (immediate) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeStateSync();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeStateSync();
  }, 100);
  if (saveTimer.unref) {
    saveTimer.unref();
  }
}

function flushSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (isDirty) {
    writeStateSync();
  }
}

// Process lifecycle hooks to ensure state is flushed on shutdown/exit
process.on('beforeExit', () => {
  flushSync();
});

process.on('exit', () => {
  flushSync();
});

process.on('SIGINT', () => {
  flushSync();
});

process.on('SIGTERM', () => {
  flushSync();
});

// Initial load
loadStateFromDisk();

export const storage = {
  saveAgent(agent: any) {
    inMemoryAgents.set(agent.id, { ...agent });
    schedulePersist();
  },

  updateAgent(id: string, updates: { status?: string; sessionId?: string | null; sessionTitle?: string | null; model?: string | null; workingSince?: number | null; tokenUsage?: any; contextLength?: number | null }) {
    const existing = inMemoryAgents.get(id) || {};
    const updated = {
      ...existing,
      status: 'status' in updates ? updates.status : existing.status,
      session_id: 'sessionId' in updates ? (updates.sessionId !== undefined ? updates.sessionId : null) : existing.session_id,
      session_title: 'sessionTitle' in updates ? (updates.sessionTitle !== undefined ? updates.sessionTitle : null) : existing.session_title,
      model: 'model' in updates ? (updates.model !== undefined ? updates.model : null) : existing.model,
      working_since: 'workingSince' in updates ? (updates.workingSince !== undefined ? updates.workingSince : null) : existing.working_since,
      token_usage: 'tokenUsage' in updates ? (updates.tokenUsage !== undefined ? updates.tokenUsage : null) : existing.token_usage,
      context_length: 'contextLength' in updates ? (updates.contextLength !== undefined ? updates.contextLength : null) : existing.context_length
    };
    inMemoryAgents.set(id, updated);
    schedulePersist();
  },

  deleteAgent(id: string) {
    inMemoryAgents.delete(id);
    schedulePersist(true);
  },

  getAllAgents() {
    return Array.from(inMemoryAgents.values());
  },

  getAgent(id: string) {
    return inMemoryAgents.get(id);
  },

  saveMessage(msg: any) {
    inMemoryHistory.push({ ...msg });
    if (inMemoryHistory.length > MAX_PERSISTED_MESSAGES) inMemoryHistory.shift();
    schedulePersist();
  },

  getHistory(limit = 200) {
    return inMemoryHistory.slice(-limit);
  },

  // ============ REPORT OUTBOX (durable queue for agent reports) ============
  enqueueOutbox(item: OutboxReport) {
    inMemoryOutbox.push(item);
    schedulePersist();
  },

  markOutboxDelivered(id: string) {
    const it = inMemoryOutbox.find(r => r.id === id);
    if (it) {
      it.status = 'delivered';
      it.attempts = (it.attempts || 0) + 1;
    }
    schedulePersist();
  },

  markOutboxFailed(id: string, err?: any) {
    const it = inMemoryOutbox.find(r => r.id === id);
    if (it) {
      it.status = 'pending';
      it.attempts = (it.attempts || 0) + 1;
      it.lastError = err?.message || (typeof err === 'string' ? err : undefined);
    }
    schedulePersist();
  },

  getPendingOutbox() {
    return inMemoryOutbox.filter(r => r.status === 'pending');
  },

  resetOutboxAttempts(ids: string[]) {
    const set = new Set(ids);
    for (const r of inMemoryOutbox) {
      if (set.has(r.id)) r.attempts = 0;
    }
    schedulePersist();
  },

  pruneDeliveredOutbox(keep = 200) {
    const delivered = inMemoryOutbox.filter(r => r.status === 'delivered');
    if (delivered.length <= keep) return;
    delivered.sort((a, b) => a.createdAt - b.createdAt);
    const excess = new Set(delivered.slice(0, delivered.length - keep).map(r => r.id));
    inMemoryOutbox = inMemoryOutbox.filter(r => !excess.has(r.id));
    schedulePersist();
  },

  // ============ CHAT RETRY QUEUE (durable queue cho user chat khi backend sập) ============
  enqueueChatRetry(item: ChatQueueItem) {
    inMemoryChatQueue.push(item);
    schedulePersist();
  },

  getPendingChatQueue() {
    return inMemoryChatQueue.slice();
  },

  updateChatQueueItem(item: ChatQueueItem) {
    const idx = inMemoryChatQueue.findIndex(r => r.id === item.id);
    if (idx >= 0) inMemoryChatQueue[idx] = item;
    else inMemoryChatQueue.push(item);
    schedulePersist();
  },

  removeChatQueueItem(id: string) {
    inMemoryChatQueue = inMemoryChatQueue.filter(r => r.id !== id);
    schedulePersist();
  },

  pruneChatQueue(keep = 200) {
    if (inMemoryChatQueue.length <= keep) return;
    inMemoryChatQueue.sort((a, b) => a.createdAt - b.createdAt);
    inMemoryChatQueue = inMemoryChatQueue.slice(-keep);
    schedulePersist();
  },

  // ============ UNPROCESSED USER MESSAGES (Preserve on Abort / Stop) ============
  saveUnprocessedMessage(targetId: string, text: string) {
    if (!text || !text.trim()) return;
    const key = targetId || 'orchestrator';
    if (!inMemoryUnprocessedUserMessages[key]) {
      inMemoryUnprocessedUserMessages[key] = [];
    }
    const cleanText = text.trim();
    // Chống lưu trùng lặp nếu tin nhắn giống hệt đã có trong danh sách
    if (!inMemoryUnprocessedUserMessages[key].includes(cleanText)) {
      inMemoryUnprocessedUserMessages[key].push(cleanText);
      schedulePersist();
    }
  },

  getUnprocessedMessages(targetId: string): string[] {
    const key = targetId || 'orchestrator';
    return (inMemoryUnprocessedUserMessages[key] || []).slice();
  },

  clearUnprocessedMessages(targetId: string) {
    const key = targetId || 'orchestrator';
    if (inMemoryUnprocessedUserMessages[key]) {
      delete inMemoryUnprocessedUserMessages[key];
      schedulePersist();
    }
  },

  getHistoryByAgent(agentId: string, limit = 100) {
    return inMemoryHistory
      .filter(m => m.from_id === agentId || m.to_id === agentId || m.from === agentId || m.to === agentId)
      .slice(-limit);
  },

  // Paged history query: hỗ trợ limit + beforeId (trả về các tin nhắn CŨ HƠN id chỉ định) + lọc theo agent
  getHistoryPage(opts: { limit?: number; beforeId?: string | number; agentId?: string } = {}) {
    let list = inMemoryHistory;
    const aid = opts.agentId;
    if (aid) {
      list = list.filter(m => m.from_id === aid || m.to_id === aid || m.from === aid || m.to === aid);
    }
    if (opts.beforeId !== undefined && opts.beforeId !== null && String(opts.beforeId).length > 0) {
      const beforeStr = String(opts.beforeId);
      const idx = list.findIndex(m => String(m.id) === beforeStr);
      if (idx > 0) list = list.slice(0, idx);
      else if (idx === 0) return [];
      // idx === -1 → id lạ: bỏ qua điều kiện để tránh trả về rỗng ngoài ý muốn
    }
    const lim = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    return list.slice(-lim);
  },

  clearOrchestratorConversation() {
    inMemoryHistory = inMemoryHistory.filter(m =>
      (m.to_id !== 'orchestrator' && m.to !== 'orchestrator') &&
      (m.from_id !== 'orchestrator' && m.from !== 'orchestrator')
    );
    schedulePersist();
  },

  clearAgentConversation(agentId: string) {
    inMemoryHistory = inMemoryHistory.filter(m =>
      (m.to_id !== agentId && m.to !== agentId) &&
      (m.from_id !== agentId && m.from !== agentId)
    );
    schedulePersist();
  },

  updateAgentModel(id: string, model: string | null) {
    const existing = inMemoryAgents.get(id);
    if (!existing) return false;
    existing.model = model;
    schedulePersist();
    return true;
  },

  loadAgents(): any[] {
    return Array.from(inMemoryAgents.values());
  },

  loadHistory(limit = 200): any[] {
    return inMemoryHistory.slice(-limit);
  },

  getSetting(key: string, defaultValue?: any) {
    if (key in inMemorySettings) return inMemorySettings[key];
    return defaultValue;
  },

  setSetting(key: string, value: any) {
    inMemorySettings[key] = value;
    schedulePersist();
    return value;
  },

  getAllSettings() {
    return { ...inMemorySettings };
  },

  getModelSettings(): {
    orchestratorModel: string | null;
    defaultSubagentModel: string | null;
    agentModelOverrides: Record<string, string>;
  } {
    return {
      orchestratorModel: inMemorySettings.orchestratorModel || null,
      defaultSubagentModel: inMemorySettings.defaultSubagentModel || null,
      agentModelOverrides: inMemorySettings.agentModelOverrides || {}
    };
  },

  setModelSettings(settings: {
    orchestratorModel?: string | null;
    defaultSubagentModel?: string | null;
    agentModelOverrides?: Record<string, string>;
  }) {
    if ('orchestratorModel' in settings) {
      inMemorySettings.orchestratorModel = settings.orchestratorModel || null;
    }
    if ('defaultSubagentModel' in settings) {
      inMemorySettings.defaultSubagentModel = settings.defaultSubagentModel || null;
    }
    if ('agentModelOverrides' in settings) {
      inMemorySettings.agentModelOverrides = settings.agentModelOverrides || {};
    }
    schedulePersist();
    return this.getModelSettings();
  },

  flush() {
    flushSync();
  },

  checkpoint() {
    flushSync();
  },

  close() {
    flushSync();
  }
};

export default storage;
