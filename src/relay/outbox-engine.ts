// ============ OUTBOX ENGINE (ACK-BASED RETRY QUEUE & BACKOFF) ============
import type { OutboxReport } from '../storage/types.js';

export interface OutboxEngineOptions {
  storage: {
    getPendingOutbox?: () => OutboxReport[];
    getOutboxForRetry?: () => OutboxReport[];
    markOutboxInFlight: (id: string) => void;
    markOutboxDelivered: (id: string) => void;
    markOutboxFailed: (id: string, err?: string) => void;
  };
  deliver: (item: OutboxReport) => Promise<boolean>;
  checkIntervalMs?: number;
  maxAttempts?: number;
  inFlightTimeoutMs?: number;
}

export class OutboxEngine {
  private options: OutboxEngineOptions;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;

  constructor(options: OutboxEngineOptions) {
    this.options = options;
  }

  public start(): void {
    // Tạm thời disable retry
    console.log('[OutboxEngine] Retry queue is temporarily disabled');
    return;
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async processQueue(): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const pending = this.options.storage.getOutboxForRetry
        ? this.options.storage.getOutboxForRetry()
        : (this.options.storage.getPendingOutbox ? this.options.storage.getPendingOutbox() : []);
      const now = Date.now();
      let processedCount = 0;

      for (const item of pending) {
        if (item.status === 'delivered') continue;
        if (item.nextAttemptAt && item.nextAttemptAt > now) continue;

        const maxAttempts = this.options.maxAttempts || 5;
        if (item.attempts >= maxAttempts) {
          console.warn(`[OutboxEngine] Record ${item.id} from ${item.fromAgentName || item.fromAgentId} reached max retry attempts (${item.attempts}/${maxAttempts}). Dropping.`);
          this.options.storage.markOutboxFailed(item.id, `Max retry attempts reached (${item.attempts}/${maxAttempts})`);
          continue;
        }

        this.options.storage.markOutboxInFlight(item.id);
        try {
          const success = await this.options.deliver(item);
          if (success) {
            this.options.storage.markOutboxDelivered(item.id);
            processedCount++;
          } else {
            this.options.storage.markOutboxFailed(item.id, 'Delivery returned false');
          }
        } catch (e: any) {
          this.options.storage.markOutboxFailed(item.id, e?.message || String(e));
        }
      }

      return processedCount;
    } finally {
      this.isProcessing = false;
    }
  }
}
