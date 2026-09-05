import type { StorageEngine } from './engine.js';
import type { OutboxReport, ChatQueueItem } from './types.js';

export class QueueStorage {
  constructor(private engine: StorageEngine) {}

  // ============ REPORT OUTBOX (durable queue for agent reports) ============
  enqueueOutbox(item: OutboxReport): void {
    this.engine.inMemoryOutbox.push(item);
    this.engine.schedulePersist();
  }

  markOutboxDelivered(id: string): void {
    const it = this.engine.inMemoryOutbox.find(r => r.id === id);
    if (it) {
      it.status = 'delivered';
      it.attempts = (it.attempts || 0) + 1;
    }
    this.engine.outboxInFlightAt.delete(id);
    this.engine.schedulePersist();
  }

  markOutboxInFlight(id: string): void {
    const it = this.engine.inMemoryOutbox.find(r => r.id === id);
    if (it) {
      it.status = 'in_flight';
      this.engine.outboxInFlightAt.set(id, Date.now());
    }
    this.engine.schedulePersist();
  }

  markOutboxFailed(id: string, err?: any): void {
    const it = this.engine.inMemoryOutbox.find(r => r.id === id);
    if (it) {
      it.status = 'failed';
      it.attempts = (it.attempts || 0) + 1;
      it.lastError = err?.message || (typeof err === 'string' ? err : undefined);
      it.nextAttemptAt = Date.now() + Math.min(5000 * Math.pow(2, Math.min(it.attempts, 6)), 10 * 60 * 1000);
    }
    this.engine.outboxInFlightAt.delete(id);
    this.engine.schedulePersist();
  }

  getPendingOutbox(): OutboxReport[] {
    return this.engine.inMemoryOutbox.filter(r => r.status === 'pending');
  }

  getOutboxRecord(id: string): OutboxReport | undefined {
    return this.engine.inMemoryOutbox.find(r => r.id === id);
  }

  getOutboxForRetry(): OutboxReport[] {
    const now = Date.now();
    return this.engine.inMemoryOutbox.filter(r => {
      if (r.status === 'pending') return true;
      if (r.status === 'failed') return (r.nextAttemptAt === undefined || r.nextAttemptAt <= now);
      if (r.status === 'in_flight') {
        const inFlightSince = this.engine.outboxInFlightAt.get(r.id);
        const OUTBOX_IN_FLIGHT_TIMEOUT_MS = 30000;
        if (inFlightSince === undefined || (now - inFlightSince) > OUTBOX_IN_FLIGHT_TIMEOUT_MS) {
          r.status = 'pending';
          this.engine.outboxInFlightAt.delete(r.id);
          return true;
        }
      }
      return false;
    });
  }

  resetOutboxAttempts(ids: string[]): void {
    const set = new Set(ids);
    for (const r of this.engine.inMemoryOutbox) {
      if (set.has(r.id)) r.attempts = 0;
    }
    this.engine.schedulePersist();
  }

  pruneDeliveredOutbox(keep = 200): void {
    const delivered = this.engine.inMemoryOutbox.filter(r => r.status === 'delivered');
    if (delivered.length <= keep) return;
    delivered.sort((a, b) => a.createdAt - b.createdAt);
    const excess = new Set(delivered.slice(0, delivered.length - keep).map(r => r.id));
    this.engine.inMemoryOutbox = this.engine.inMemoryOutbox.filter(r => !excess.has(r.id));
    this.engine.schedulePersist();
  }

  // ============ CHAT RETRY QUEUE (durable queue cho user chat khi backend sập) ============
  enqueueChatRetry(item: ChatQueueItem): void {
    this.engine.inMemoryChatQueue.push(item);
    this.engine.schedulePersist();
  }

  getPendingChatQueue(): ChatQueueItem[] {
    return this.engine.inMemoryChatQueue.slice();
  }

  updateChatQueueItem(item: ChatQueueItem): void {
    const idx = this.engine.inMemoryChatQueue.findIndex(r => r.id === item.id);
    if (idx >= 0) this.engine.inMemoryChatQueue[idx] = item;
    else this.engine.inMemoryChatQueue.push(item);
    this.engine.schedulePersist();
  }

  removeChatQueueItem(id: string): void {
    this.engine.inMemoryChatQueue = this.engine.inMemoryChatQueue.filter(r => r.id !== id);
    this.engine.schedulePersist();
  }

  pruneChatQueue(keep = 200): void {
    if (this.engine.inMemoryChatQueue.length <= keep) return;
    this.engine.inMemoryChatQueue.sort((a, b) => a.createdAt - b.createdAt);
    this.engine.inMemoryChatQueue = this.engine.inMemoryChatQueue.slice(-keep);
    this.engine.schedulePersist();
  }

  // ============ UNPROCESSED USER MESSAGES (Preserve on Abort / Stop) ============
  // Giữ nguyên auto-continue: persist mọi message hợp lệ. Validate đầu vào —
  // không persist khi thiếu text/target (tránh bản ghi mồ côi teamId sai).
  saveUnprocessedMessage(targetId: string, text: string): void {
    if (!text || !text.trim() || !targetId) return;
    if (typeof text === 'string' && (text.trim().startsWith('[TEAM]') || text.includes('Your ID:'))) return;
    const key = targetId || 'orchestrator';
    if (!this.engine.inMemoryUnprocessedUserMessages[key]) {
      this.engine.inMemoryUnprocessedUserMessages[key] = [];
    }
    const cleanText = text.trim();
    if (!this.engine.inMemoryUnprocessedUserMessages[key].includes(cleanText)) {
      this.engine.inMemoryUnprocessedUserMessages[key].push(cleanText);
      this.engine.schedulePersist();
    }
  }

  getUnprocessedMessages(targetId: string): string[] {
    const key = targetId || 'orchestrator';
    return (this.engine.inMemoryUnprocessedUserMessages[key] || []).slice();
  }

  getAllUnprocessedMessages(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(this.engine.inMemoryUnprocessedUserMessages || {})) {
      if (Array.isArray(v) && v.length > 0) {
        result[k] = v.slice();
      }
    }
    return result;
  }

  clearUnprocessedMessages(targetId: string): void {
    const key = targetId || 'orchestrator';
    if (this.engine.inMemoryUnprocessedUserMessages[key]) {
      delete this.engine.inMemoryUnprocessedUserMessages[key];
      this.engine.schedulePersist();
    }
  }
}
