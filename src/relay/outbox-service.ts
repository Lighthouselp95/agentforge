// ============ UNIFIED RELAY OUTBOX SERVICE ============
import type { Agent } from '../core/agents.js';
import type { OutboxReport } from '../storage/types.js';
import { OutboxDispatcher, type OutboxDispatcherOptions } from './outbox-dispatcher.js';
import { OutboxEngine, type OutboxEngineOptions } from './outbox-engine.js';
import { DedupManager, defaultDedupManager } from './dedup.js';

export interface RelayOutboxServiceOptions extends OutboxDispatcherOptions {
  checkIntervalMs?: number;
  maxAttempts?: number;
  inFlightTimeoutMs?: number;
}

export class RelayOutboxService {
  private dispatcher: OutboxDispatcher;
  private engine: OutboxEngine;
  private options: RelayOutboxServiceOptions;

  constructor(options: RelayOutboxServiceOptions) {
    this.options = options;
    this.dispatcher = new OutboxDispatcher(options);

    const engineOptions: OutboxEngineOptions = {
      storage: options.storage,
      deliver: async (item: OutboxReport) => {
        try {
          return true;
        } catch {
          return false;
        }
      },
      checkIntervalMs: options.checkIntervalMs,
      maxAttempts: options.maxAttempts,
      inFlightTimeoutMs: options.inFlightTimeoutMs
    };
    this.engine = new OutboxEngine(engineOptions);
  }

  public async deliverTalk(
    targetAgent: Agent,
    fromAgent: Agent,
    msg: { to: string; message: string; task?: string },
    existingReportId?: string
  ): Promise<void> {
    return this.dispatcher.deliverTalk(targetAgent, fromAgent, msg, existingReportId);
  }

  public startRetryEngine(): void {
    this.engine.start();
  }

  public stopRetryEngine(): void {
    this.engine.stop();
  }

  public async processQueue(): Promise<number> {
    return this.engine.processQueue();
  }
}
