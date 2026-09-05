import type { StorageEngine } from './engine.js';
import type { UpdateAgentOptions } from './types.js';

export class AgentStorage {
  constructor(private engine: StorageEngine) {}

  saveAgent(agent: any): void {
    this.engine.inMemoryAgents.set(agent.id, { ...agent });
    this.engine.schedulePersist();
  }

  updateAgent(id: string, updates: UpdateAgentOptions): void {
    const existing = this.engine.inMemoryAgents.get(id) || {};
    const updated = {
      ...existing,
      status: 'status' in updates ? updates.status : existing.status,
      session_id: 'sessionId' in updates ? (updates.sessionId !== undefined ? updates.sessionId : null) : existing.session_id,
      session_title: 'sessionTitle' in updates ? (updates.sessionTitle !== undefined ? updates.sessionTitle : null) : existing.session_title,
      model: 'model' in updates ? (updates.model !== undefined ? updates.model : null) : existing.model,
      working_since: 'workingSince' in updates ? (updates.workingSince !== undefined ? updates.workingSince : null) : existing.working_since,
      token_usage: 'tokenUsage' in updates ? (updates.tokenUsage !== undefined ? updates.tokenUsage : null) : existing.token_usage,
      context_length: 'contextLength' in updates ? (updates.contextLength !== undefined ? updates.contextLength : null) : existing.context_length,
      task: 'task' in updates ? updates.task : existing.task,
      tasks: 'tasks' in updates ? updates.tasks : existing.tasks,
      teamId: 'teamId' in updates ? updates.teamId : (existing.teamId || (id === 'orchestrator' ? 'default' : undefined)),
      spawnedBy: 'spawnedBy' in updates ? updates.spawnedBy : existing.spawnedBy
    };
    this.engine.inMemoryAgents.set(id, updated);
    this.engine.schedulePersist();
  }

  deleteAgent(id: string): void {
    this.engine.inMemoryAgents.delete(id);
    this.engine.schedulePersist(true);
  }

  getAllAgents(): any[] {
    return Array.from(this.engine.inMemoryAgents.values());
  }

  getAgent(id: string): any {
    return this.engine.inMemoryAgents.get(id);
  }

  updateAgentModel(id: string, model: string | null): boolean {
    const existing = this.engine.inMemoryAgents.get(id);
    if (!existing) return false;
    existing.model = model;
    this.engine.schedulePersist();
    return true;
  }

  loadAgents(): any[] {
    return Array.from(this.engine.inMemoryAgents.values());
  }
}

// ============ TASK COUNT & EVICTION (pure helpers, dùng chung server.ts + routes) ============

/**
 * true nếu entry trong agent.tasks chỉ là tin nhắn user thường, KHÔNG phải task giao việc.
 * Task giao việc thật có nguồn talk/spawn/task; entry chat thường mang role='user'/type='chat'.
 */
export function isUserChatTask(t: any): boolean {
  if (!t || typeof t !== 'object') return false;
  const role = String((t as any).role || '').toLowerCase().trim();
  if (role === 'user') return true;
  const type = String((t as any).type || '').toLowerCase().trim();
  if (type === 'chat') return true;
  return false;
}

/** Đếm task giao việc thực sự (loại trừ tin nhắn user thường; completed vẫn tính để trần 6 có ý nghĩa). */
export function countRealTasks(tasks: any[]): number {
  if (!Array.isArray(tasks)) return 0;
  let n = 0;
  for (const t of tasks) {
    if (!isUserChatTask(t)) n++;
  }
  return n;
}

/**
 * Đẩy task completed CŨ NHẤT (theo createdAt, bỏ qua entry user-chat) ra khỏi list
 * + re-index id 1..N. Trả true nếu đã đẩy (caller push task mới tiếp),
 * false nếu không còn task completed nào để dọn.
 */
export function evictOldestCompletedTask(tasks: any[]): boolean {
  if (!Array.isArray(tasks) || tasks.length === 0) return false;
  let oldestIdx = -1;
  let oldestTs = Infinity;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || isUserChatTask(t) || t.status !== 'completed') continue;
    const ts = typeof t.createdAt === 'number' ? t.createdAt : i;
    if (ts < oldestTs) {
      oldestTs = ts;
      oldestIdx = i;
    }
  }
  if (oldestIdx === -1) return false;
  tasks.splice(oldestIdx, 1);
  tasks.forEach((t, idx) => {
    if (!t || typeof t !== 'object') return;
    (t as any).id = String(idx + 1);
    if (typeof (t as any).task === 'string' && /^#\d+\b/.test((t as any).task)) {
      (t as any).task = (t as any).task.replace(/^#\d+/, `#${(t as any).id}`);
    }
  });
  return true;
}
