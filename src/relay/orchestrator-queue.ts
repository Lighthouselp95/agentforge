// ============ ORCHESTRATOR TRIGGER QUEUE & DEBOUNCE ============
import type { Agent } from '../core/agents.js';
import { DedupManager, defaultDedupManager } from './dedup.js';
import { isEmptyAgentOutput } from './report-parser.js';

export const ORCH_TRIGGER_DEBOUNCE_MS = 250;

export interface PendingOrchTrigger {
  fromAgent: Agent;
  message: string;
  reportId: string;
  attempts: number;
  targetOrchId?: string;
}

export interface OrchestratorQueueOptions {
  resolveOrchestratorTarget: (agent: Agent) => string;
  enqueueOutbox: (item: any) => void;
  processQueue: (batch: PendingOrchTrigger[], targetOrchId: string) => Promise<void>;
  getOrchClientBusy: (orchId: string) => boolean;
  dedupManager?: DedupManager;
}

export class OrchestratorTriggerQueue {
  private pendingTriggers: PendingOrchTrigger[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private options: OrchestratorQueueOptions;
  private dedup: DedupManager;

  constructor(options: OrchestratorQueueOptions) {
    this.options = options;
    this.dedup = options.dedupManager || defaultDedupManager;
  }

  public async trigger(fromAgent: Agent, message: string, existingReportId?: string, explicitReportId?: string): Promise<void> {
    const targetOrchId = this.options.resolveOrchestratorTarget(fromAgent);
    if (!existingReportId && isEmptyAgentOutput(message)) {
      console.log(`[Route] Skip triggerOrchestrator: empty message from ${fromAgent.name} (${fromAgent.role})`);
      return;
    }

    if (!existingReportId) {
      if (this.dedup.isOrchTriggerDuplicate(fromAgent.id, message)) {
        console.log(`[Route] Skip duplicate orchestrator trigger from ${fromAgent.name}`);
        return;
      }
    }

    const reportId = existingReportId || explicitReportId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    if (!existingReportId) {
      this.options.enqueueOutbox({
        id: reportId,
        fromAgentId: fromAgent.id,
        fromAgentName: fromAgent.name,
        fromAgentRole: fromAgent.role,
        to: targetOrchId,
        message,
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending'
      });
    }

    this.pendingTriggers.push({
      fromAgent,
      message,
      reportId,
      attempts: 0,
      targetOrchId
    });

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.process();
    }, ORCH_TRIGGER_DEBOUNCE_MS);
  }

  public async process(): Promise<void> {
    if (this.pendingTriggers.length === 0) return;

    const targets = Array.from(new Set(this.pendingTriggers.map(t => t.targetOrchId || 'orchestrator')));

    for (const orchId of targets) {
      if (this.options.getOrchClientBusy(orchId)) {
        if (!this.debounceTimer) {
          this.debounceTimer = setTimeout(() => this.process(), 1000);
        }
        continue;
      }

      const batchIndices: number[] = [];
      const batch = this.pendingTriggers.filter((t, idx) => {
        if ((t.targetOrchId || 'orchestrator') === orchId) {
          batchIndices.push(idx);
          return true;
        }
        return false;
      });

      if (batch.length === 0) continue;

      for (let i = batchIndices.length - 1; i >= 0; i--) {
        this.pendingTriggers.splice(batchIndices[i], 1);
      }

      await this.options.processQueue(batch, orchId);
    }
  }

  public getPendingCount(): number {
    return this.pendingTriggers.length;
  }
}
