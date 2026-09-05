// ============ SERVER-SIDE FIFO USER QUEUE ============
import { v4 as uuidv4 } from 'uuid';

export interface BackendQueuedMsg {
  targetId: string;
  rawMsg: string;
  isSlash: boolean;
  messageId?: string;
  timestamp: number;
}

export type DispatchUserChatFn = (params: {
  targetAgentId: string;
  rawMsg: string;
  isSlashCommand: boolean;
  isRetry?: boolean;
}) => Promise<any>;

export interface UserQueueOptions {
  dispatchUserChat: DispatchUserChatFn;
  isAgentBusy: (targetId: string) => boolean;
  chatHistory?: any[];
  saveMessage?: (msg: any) => void;
  broadcast?: (event: string, payload: any) => void;
  getAgent?: (targetId: string) => any;
}

export class UserQueueManager {
  private backendUserQueues: Record<string, Array<BackendQueuedMsg>> = {};
  private options: UserQueueOptions;

  constructor(options: UserQueueOptions) {
    this.options = options;
  }

  public normalizeQueueKey(targetId?: string): string {
    if (!targetId || targetId === 'orchestrator') return 'orchestrator';
    return targetId;
  }

  public enqueue(msg: BackendQueuedMsg): void {
    const key = this.normalizeQueueKey(msg.targetId);
    if (!this.backendUserQueues[key]) {
      this.backendUserQueues[key] = [];
    }
    this.backendUserQueues[key].push(msg);
  }

  public getQueue(rawTargetId: string): BackendQueuedMsg[] {
    const key = this.normalizeQueueKey(rawTargetId);
    return this.backendUserQueues[key] || [];
  }

  public getQueueLength(rawTargetId: string): number {
    return this.getQueue(rawTargetId).length;
  }

  public setQueue(rawTargetId: string, queue: BackendQueuedMsg[]): void {
    const key = this.normalizeQueueKey(rawTargetId);
    this.backendUserQueues[key] = queue;
  }

  public clearQueue(rawTargetId: string): void {
    const key = this.normalizeQueueKey(rawTargetId);
    this.backendUserQueues[key] = [];
  }

  public drainAll(rawTargetId: string): BackendQueuedMsg[] {
    const key = this.normalizeQueueKey(rawTargetId);
    const queue = this.backendUserQueues[key] || [];
    const items: BackendQueuedMsg[] = [];
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) items.push(item);
    }
    return items;
  }

  public processNext(rawTargetId: string): void {
    const targetId = this.normalizeQueueKey(rawTargetId);
    const queue = this.backendUserQueues[targetId];
    if (!queue || queue.length === 0) return;

    if (this.options.isAgentBusy(targetId)) {
      return;
    }

    queue.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const messagesToDispatch: BackendQueuedMsg[] = [];
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) messagesToDispatch.push(item);
    }
    if (messagesToDispatch.length === 0) return;

    let combinedRawMsg = '';
    if (messagesToDispatch.length === 1) {
      combinedRawMsg = messagesToDispatch[0].rawMsg;
    } else {
      combinedRawMsg = messagesToDispatch
        .map((m, idx) => `[Tin nhắn người dùng #${idx + 1} - Gửi lúc ${new Date(m.timestamp).toLocaleTimeString()}]:\n${m.rawMsg}`)
        .join('\n\n---\n\n');
    }

    const isSlash = messagesToDispatch.length === 1 ? messagesToDispatch[0].isSlash : false;

    setImmediate(async () => {
      try {
        const now = Date.now();
        const targetAgent = this.options.getAgent ? this.options.getAgent(targetId) : undefined;
        const dispatchedMsgIds: string[] = [];

        for (const m of messagesToDispatch) {
          const msgId = m.messageId || uuidv4();
          dispatchedMsgIds.push(msgId);
          const userMsg: any = {
            id: msgId,
            from: 'user',
            to: targetId,
            content: m.rawMsg,
            timestamp: m.timestamp || now,
            teamId: targetAgent?.teamId || (targetId === 'orchestrator' ? 'default' : undefined)
          };
          if (this.options.chatHistory) this.options.chatHistory.push(userMsg);
          if (this.options.saveMessage) this.options.saveMessage(userMsg);
          if (this.options.broadcast) this.options.broadcast('chat:message', { msg: userMsg });
        }

        if (this.options.broadcast) {
          this.options.broadcast('chat:queue:dispatched', {
            targetAgentId: targetId,
            messageIds: dispatchedMsgIds,
            count: messagesToDispatch.length,
            timestamp: now
          });
        }

        console.log(`[UserQueue] Auto-dispatching queued user message(s) (${messagesToDispatch.length} msg(s)) for ${targetId}: "${combinedRawMsg.slice(0, 80)}"`);
        await this.options.dispatchUserChat({
          targetAgentId: targetId,
          rawMsg: combinedRawMsg,
          isSlashCommand: isSlash,
          isRetry: false
        });
      } catch (err: any) {
        console.error(`[UserQueue] Error processing queued chat for ${targetId}:`, err);
      } finally {
        if (this.backendUserQueues[targetId]?.length > 0) {
          setImmediate(() => this.processNext(targetId));
        }
      }
    });
  }

  public processQueue(rawTargetId: string): void {
    this.processNext(rawTargetId);
  }
}
