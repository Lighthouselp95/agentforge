// ============ DEDUPLICATION HELPERS & ENGINE ============
import type { ChatMsg } from './types.js';

export const BROADCAST_DEDUP_TTL_MS = 30000;
export const OUTBOX_DELIVER_TALK_DEDUP_MS = 2000;
export const ORCH_TRIGGER_DEDUP_MS = 5000;

export function normCmdSigPart(v: string): string {
  return (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function talkDispatchSig(fromAgentId: string, to: string, task: string | undefined, message: string): string {
  return `talk|${normCmdSigPart(fromAgentId)}>${normCmdSigPart(to)}|${normCmdSigPart(task || '')}|${normCmdSigPart(message)}`;
}

export function spawnDispatchSig(role: string, name: string, task: string): string {
  return `spawn|${normCmdSigPart(role)}|${normCmdSigPart(name)}|${normCmdSigPart(task)}`;
}

export function broadcastDedupKey(msg: ChatMsg): string {
  const norm = String(msg.content || '').replace(/\s+/g, ' ').trim();
  return `${msg.from || ''}|${msg.to || ''}|${msg.msgType || ''}|${norm}`;
}

export class DedupManager {
  private broadcastDedup = new Map<string, number>();
  private deliverTalkDedup = new Map<string, number>();
  private orchTriggerDedup = new Map<string, number>();

  public isBroadcastDuplicate(msgOrKey: ChatMsg | string, ttlMs: number = BROADCAST_DEDUP_TTL_MS): boolean {
    const key = typeof msgOrKey === 'string' ? msgOrKey : broadcastDedupKey(msgOrKey);
    if (!key) return false;
    const now = Date.now();
    const last = this.broadcastDedup.get(key);
    if (last !== undefined && now - last < ttlMs) {
      return true;
    }
    this.broadcastDedup.set(key, now);

    if (this.broadcastDedup.size > 3000) {
      for (const [k, v] of this.broadcastDedup) {
        if (now - v > ttlMs) this.broadcastDedup.delete(k);
      }
    }
    return false;
  }

  public isDeliverTalkDuplicate(fromId: string, targetId: string, message: string, ttlMs: number = OUTBOX_DELIVER_TALK_DEDUP_MS): boolean {
    const dedupKey = `${fromId}->${targetId}::${normCmdSigPart(message)}`;
    const now = Date.now();
    const lastSent = this.deliverTalkDedup.get(dedupKey);
    if (lastSent !== undefined && now - lastSent < ttlMs) {
      return true;
    }
    this.deliverTalkDedup.set(dedupKey, now);

    if (this.deliverTalkDedup.size > 1000) {
      const cutoff = now - ttlMs * 2;
      for (const [k, t] of this.deliverTalkDedup) {
        if (t < cutoff) this.deliverTalkDedup.delete(k);
      }
    }
    return false;
  }

  public isOrchTriggerDuplicate(fromId: string, message: string, ttlMs: number = ORCH_TRIGGER_DEDUP_MS): boolean {
    const dedupKey = `${fromId}|||${message.trim().replace(/\s+/g, ' ')}`;
    const now = Date.now();
    const lastAt = this.orchTriggerDedup.get(dedupKey);
    if (lastAt !== undefined && now - lastAt < ttlMs) {
      return true;
    }
    this.orchTriggerDedup.set(dedupKey, now);

    if (this.orchTriggerDedup.size > 500) {
      for (const [k, v] of this.orchTriggerDedup) {
        if (now - v > ttlMs) this.orchTriggerDedup.delete(k);
      }
    }
    return false;
  }

  public clear(): void {
    this.broadcastDedup.clear();
    this.deliverTalkDedup.clear();
    this.orchTriggerDedup.clear();
  }
}

export const defaultDedupManager = new DedupManager();
