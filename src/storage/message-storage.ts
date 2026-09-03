import type { StorageEngine } from './engine.js';
import type { HistoryPageOptions } from './types.js';
import { MAX_PERSISTED_MESSAGES } from './constants.js';

export class MessageStorage {
  constructor(private engine: StorageEngine) {}

  // Xác định teamId của một tin nhắn dựa trên agent liên quan (from/to).
  // Ưu tiên: msg.teamId sẵn → agent theo from → agent theo to → 'default'.
  resolveTeamIdForMsg(msg: any): string {
    if (msg && msg.teamId && typeof msg.teamId === 'string') return msg.teamId;
    const candidates = [msg && msg.from, msg && msg.to];
    for (const cid of candidates) {
      if (!cid || typeof cid !== 'string') continue;
      const ag = this.engine.inMemoryAgents.get(cid);
      if (ag && ag.teamId && typeof ag.teamId === 'string') return ag.teamId;
    }
    return 'default';
  }

  saveMessage(msg: any): void {
    const m = { ...msg };
    if (!m.teamId) {
      const tid = this.resolveTeamIdForMsg(msg);
      if (tid) m.teamId = tid;
    }
    this.engine.inMemoryHistory.push(m);
    if (Number.isFinite(MAX_PERSISTED_MESSAGES) && this.engine.inMemoryHistory.length > MAX_PERSISTED_MESSAGES) {
      this.engine.inMemoryHistory.shift();
    }
    this.engine.schedulePersist();
  }

  saveOpenCodeSnapshot(msg: any): void {
    const from = msg?.from;
    if (from) {
      const prev = this.engine.inMemoryHistory.find(
        m => m.msgType === 'opencode' && (m.from === from || m.from_id === from)
      );
      if (prev) {
        if ((!msg.thinking || !String(msg.thinking).trim()) && prev.thinking) msg.thinking = prev.thinking;
        if ((!msg.toolCalls || !msg.toolCalls.length) && prev.toolCalls?.length) msg.toolCalls = prev.toolCalls;
      }
      this.engine.inMemoryHistory = this.engine.inMemoryHistory.filter(
        m => !(m.msgType === 'opencode' && (m.from === from || m.from_id === from))
      );
    }
    this.engine.inMemoryHistory.push({ ...msg });
    this.engine.schedulePersist();
  }

  getHistory(limit?: number, teamId?: string): any[] {
    let list = this.engine.inMemoryHistory;
    if (teamId) {
      list = list.filter(m => {
        const t = m.teamId || 'default';
        if (teamId === 'default') return t === 'default';
        return t === teamId;
      });
    }
    if (typeof limit === 'number' && limit > 0) {
      return list.slice(-limit);
    }
    return list;
  }

  getHistoryByAgent(agentId: string, limit = 100): any[] {
    return this.engine.inMemoryHistory
      .filter(m => m.from_id === agentId || m.to_id === agentId || m.from === agentId || m.to === agentId)
      .slice(-limit);
  }

  getHistoryPage(opts: HistoryPageOptions = {}): any[] {
    let list = this.engine.inMemoryHistory;
    const aid = opts.agentId;
    if (aid) {
      list = list.filter(m => m.from_id === aid || m.to_id === aid || m.from === aid || m.to === aid);
    }
    if (opts.teamId) {
      const teamFilter = opts.teamId === 'default'
        ? (m: any) => (m.teamId || 'default') === 'default'
        : (m: any) => (m.teamId || 'default') === opts.teamId;
      list = list.filter(teamFilter);
    }
    if (opts.beforeId !== undefined && opts.beforeId !== null && String(opts.beforeId).length > 0) {
      const beforeStr = String(opts.beforeId);
      const idx = list.findIndex(m => String(m.id) === beforeStr);
      if (idx > 0) list = list.slice(0, idx);
      else if (idx === 0) return [];
    }
    const lim = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    return list.slice(-lim);
  }

  clearOrchestratorConversation(): void {
    this.engine.inMemoryHistory = this.engine.inMemoryHistory.filter(m =>
      (m.to_id !== 'orchestrator' && m.to !== 'orchestrator') &&
      (m.from_id !== 'orchestrator' && m.from !== 'orchestrator')
    );
    this.engine.schedulePersist();
  }

  clearAgentConversation(agentId: string): void {
    this.engine.inMemoryHistory = this.engine.inMemoryHistory.filter(m =>
      (m.to_id !== agentId && m.to !== agentId) &&
      (m.from_id !== agentId && m.from !== agentId)
    );
    this.engine.schedulePersist();
  }

  loadHistory(limit?: number): any[] {
    if (typeof limit === 'number' && limit > 0) {
      return this.engine.inMemoryHistory.slice(-limit);
    }
    return this.engine.inMemoryHistory;
  }
}
