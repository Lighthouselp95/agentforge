// ============ OUTBOX DISPATCHER & DELIVER TALK ============
import type { Agent } from '../core/agents.js';
import { DedupManager, defaultDedupManager } from './dedup.js';
import { buildWorkerTalkPrompt, isEmptyAgentOutput } from './report-parser.js';

export interface OutboxDispatcherOptions {
  storage: any;
  getClient: (agent: Agent) => any;
  buildTeamPrompt: (targetAgentId: string) => string;
  workerReminder: string;
  broadcast: (type: string, data: any) => void;
  handleAgentResponse: (content: string, agent: Agent, defaultTo: string, toolCalls?: any[], thinking?: string) => Promise<void>;
  saveTranscript: (tr: any, id: string, name: string, role: string) => void;
  validateWorkerCompletion: (content: string, agent: Agent) => { valid: boolean; reason?: string };
  buildFormatFeedbackPrompt: (reason: string, agent: Agent) => string;
  triggerOrchestrator: (agent: Agent, msg: string) => Promise<void>;
  findOrchestrator: () => Agent | undefined;
  dedupManager?: DedupManager;
}

export class OutboxDispatcher {
  private options: OutboxDispatcherOptions;
  private dedup: DedupManager;

  constructor(options: OutboxDispatcherOptions) {
    this.options = options;
    this.dedup = options.dedupManager || defaultDedupManager;
  }

  public async deliverTalk(
    targetAgent: Agent,
    fromAgent: Agent,
    msg: { to: string; message: string; task?: string },
    existingReportId?: string
  ): Promise<void> {
    const applyDedup = !existingReportId
      && msg.to !== 'orchestrator' && msg.to !== 'user' && msg.to !== 'broadcast'
      && fromAgent.role !== 'orchestrator' && targetAgent.role !== 'orchestrator';

    if (applyDedup) {
      if (this.dedup.isDeliverTalkDuplicate(fromAgent.id, targetAgent.id, msg.message)) {
        console.log(`[OutboxDedup] Skip duplicate deliverTalk ${fromAgent.id}->${targetAgent.id}`);
        return;
      }
    }

    const reportId = existingReportId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    if (!existingReportId) {
      this.options.storage.enqueueOutbox({
        id: reportId,
        fromAgentId: fromAgent.id,
        fromAgentName: fromAgent.name,
        fromAgentRole: fromAgent.role,
        to: targetAgent.id,
        message: msg.message,
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending'
      });
    }

    try {
      const tc = this.options.getClient(targetAgent);
      const needReinject = tc.getNeedPromptReinject() || !targetAgent.sessionId;
      if (needReinject) tc.setNeedPromptReinject(false);

      const explicitTask = msg.task && msg.task.trim() ? msg.task.trim() : '';
      if (explicitTask) {
        if (!targetAgent.tasks) targetAgent.tasks = [];
        const truncated = explicitTask.length > 200 ? explicitTask.slice(0, 197) + '...' : explicitTask;
        targetAgent.task = truncated;

        const existing = targetAgent.tasks.find(t => t.task.toLowerCase() === truncated.toLowerCase());
        if (existing) {
          if (existing.status !== 'completed') {
            existing.status = 'working';
          }
        } else {
          targetAgent.tasks.push({
            id: String(targetAgent.tasks.length + 1),
            task: truncated,
            status: 'working',
            createdAt: Date.now()
          });
        }
        this.options.storage.updateAgent(targetAgent.id, { task: targetAgent.task, tasks: targetAgent.tasks });
        this.options.broadcast('agent:updated', { agent: targetAgent });
      }

      const teamPrompt = this.options.buildTeamPrompt(targetAgent.id);
      const talkPrompt = buildWorkerTalkPrompt(
        teamPrompt,
        fromAgent,
        targetAgent,
        msg.message,
        this.options.workerReminder
      );

      targetAgent.status = 'working';
      targetAgent.workingSince = Date.now();
      this.options.storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
      this.options.broadcast('agent:updated', { agent: targetAgent });

      this.options.storage.markOutboxInFlight(reportId);

      const tr = await tc.enqueue(talkPrompt);
      const newSid = tc.getSessionId();
      targetAgent.sessionId = newSid || undefined;
      if (tr.tokenUsage) {
        targetAgent.tokenUsage = tr.tokenUsage;
      }
      if (tr.contextLength) targetAgent.contextLength = tr.contextLength;
      this.options.storage.updateAgent(targetAgent.id, {
        sessionId: targetAgent.sessionId,
        tokenUsage: targetAgent.tokenUsage,
        contextLength: targetAgent.contextLength
      });
      this.options.broadcast('agent:updated', { agent: targetAgent });

      this.options.storage.markOutboxDelivered(reportId);

      await this.options.handleAgentResponse(tr.content, targetAgent, 'orchestrator', tr.toolCalls, tr.thinking);
      this.options.saveTranscript(tr, targetAgent.id, targetAgent.name, targetAgent.role);

      const validation = this.options.validateWorkerCompletion(tr.content, targetAgent);
      if (!validation.valid && !isEmptyAgentOutput(tr.content)) {
        console.log(`[Talk] Agent ${targetAgent.name} completion format invalid: ${validation.reason}`);
        const orchAgent = this.options.findOrchestrator();
        if (orchAgent && targetAgent.id !== 'orchestrator') {
          const feedbackMsg = this.options.buildFormatFeedbackPrompt(validation.reason || 'Báo cáo chưa đúng định dạng', targetAgent);
          this.deliverTalk(targetAgent, orchAgent, { to: targetAgent.id, message: feedbackMsg }).catch(err => {
            console.error(`[Feedback] Failed to deliver format feedback to ${targetAgent.name}:`, err.message);
          });
        }
      }
    } catch (err: any) {
      console.error(`[DeliverTalk] Failed to deliver talk to ${targetAgent.name}:`, err.message);
      this.options.storage.markOutboxFailed(reportId, err.message);
      throw err;
    }
  }
}
