// ============ ROUTER & DISPATCH ENGINE ============
import type { Agent } from '../core/agents.js';
import type { ChatMsg } from './types.js';
import { DedupManager, defaultDedupManager } from './dedup.js';
import {
  extractCleanTaskReport,
  stripToolNoiseForOrchestrator,
  hasReportBody,
  isEmptyAgentOutput,
  parseAgentOutput
} from './report-parser.js';
import { cleanTargetIdentifier, INVALID_TARGET_PLACEHOLDERS } from '../core/command-parser.js';

export interface RouteTargetResult {
  targetOrchId: string;
  isToOrchestrator: boolean;
  resolvedTo: string;
}

export interface RouterOptions {
  agents: Map<string, Agent>;
  findAgentByIdNameOrRole: (identifier: string) => Agent | undefined;
  findExistingOrchestrator: (teamId?: string) => Agent | undefined;
  resolveOrchestratorTarget: (agent: Agent) => string;
  updateOrchStateSafe: (orchId: string, status: 'idle' | 'working' | 'error', taskDesc?: string) => void;
  triggerOrchestrator: (fromAgent: Agent, safeOutContent: string) => Promise<void>;
  deliverTalk: (targetAgent: Agent, fromAgent: Agent, msg: { to: string; message: string; task?: string }) => Promise<void>;
  forwardToOrchestrator: (type: string, message: string, targetOrchId: string, teamId: string) => ChatMsg;
  saveMessage: (msg: ChatMsg) => void;
  broadcast: (type: string, data: any) => void;
  chatHistory: ChatMsg[];
  dispatchedCmdSigs?: Map<string, Set<string>>;
  dedupManager?: DedupManager;
}

export class MessageRouter {
  private options: RouterOptions;
  private dedup: DedupManager;

  constructor(options: RouterOptions) {
    this.options = options;
    this.dedup = options.dedupManager || defaultDedupManager;
  }

  public resolveRouting(fromAgent: Agent, to: string): RouteTargetResult {
    const targetOrchId = this.options.resolveOrchestratorTarget(fromAgent);
    const isToOrchestrator = to === 'orchestrator' || to === targetOrchId || (this.options.agents.get(to)?.type === 'orchestrator');
    const resolvedTo = (to === 'orchestrator') ? targetOrchId : to;
    return { targetOrchId, isToOrchestrator, resolvedTo };
  }

  public async routeAgentOutput(
    content: string,
    fromAgent: Agent,
    defaultTo: string = 'orchestrator',
    toolCalls?: Array<{ tool: string; input?: string; output?: string }>,
    thinking?: string
  ): Promise<{ hasOrchestratorMessage: boolean; routedMessagesCount: number }> {
    let messages = parseAgentOutput(content, defaultTo);
    if (messages.length === 0 && content && content.trim()) {
      const fallbackText = content.trim();
      if (fallbackText) {
        messages = [{ to: defaultTo, message: fallbackText }];
      }
    }

    let hasOrchestratorMessage = false;

    for (const msg of messages) {
      const isInternal = msg.to !== 'user' && msg.to !== 'broadcast';
      const { targetOrchId, isToOrchestrator, resolvedTo } = this.resolveRouting(fromAgent, msg.to);

      const cleanedForOrch = stripToolNoiseForOrchestrator(msg.message);
      const hasReportTag = /(?:===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===|<\s*(?:report|task_report|task-report)\b)/i.test(cleanedForOrch);
      const extractedReport = (isToOrchestrator || fromAgent.type === 'worker') && hasReportTag
        ? extractCleanTaskReport(cleanedForOrch)
        : '';
      const outContent = (extractedReport && extractedReport !== cleanedForOrch && hasReportBody(extractedReport))
        ? extractedReport
        : cleanedForOrch;

      const reply: ChatMsg = {
        id: (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        from: fromAgent.id,
        to: resolvedTo,
        content: outContent,
        task: msg.task,
        timestamp: Date.now(),
        agentName: fromAgent.name,
        agentRole: fromAgent.role,
        teamId: fromAgent.teamId || 'default',
        msgType:
          fromAgent.type === 'orchestrator'
            ? (isInternal ? 'orchestrator_internal' : undefined)
            : (isInternal ? 'talk' : undefined)
      };

      // Dedup broadcast UI
      if (!this.dedup.isBroadcastDuplicate(reply)) {
        this.options.chatHistory.push(reply);
        this.options.saveMessage(reply);
        this.options.broadcast('chat:message', { msg: reply });
      } else {
        console.log(`[Route] Skip duplicate broadcast bubble from ${fromAgent.name} -> ${resolvedTo} (dedup window, content-based)`);
      }

      if (isEmptyAgentOutput(msg.message)) {
        console.log(`[Route] Skip empty/no-response output from ${fromAgent.name} to ${resolvedTo} (no new turn spawned)`);
        if (isToOrchestrator) hasOrchestratorMessage = true;
        continue;
      }

      const safeOutContent = outContent && outContent.trim()
        ? outContent
        : (msg.message && msg.message.trim() ? msg.message : outContent);

      if (resolvedTo === 'orchestrator') {
        hasOrchestratorMessage = true;
        this.options.updateOrchStateSafe(resolvedTo, 'working', `Đang tiếp nhận & tổng kết báo cáo từ ${fromAgent.name}`);
        await this.options.triggerOrchestrator(fromAgent, safeOutContent);
      } else {
        const targetAgent = this.options.agents.get(resolvedTo) || this.options.findAgentByIdNameOrRole(resolvedTo);
        if (targetAgent) {
          if (targetAgent.type === 'orchestrator' || targetAgent.role === 'orchestrator') {
            hasOrchestratorMessage = true;
            this.options.updateOrchStateSafe(resolvedTo, 'working', `Đang tiếp nhận & tổng kết báo cáo từ ${fromAgent.name}`);
            await this.options.triggerOrchestrator(fromAgent, safeOutContent);
          } else {
            targetAgent.status = 'working';
            targetAgent.workingSince = Date.now();
            this.options.broadcast('agent:updated', { agent: targetAgent });

            const earlySig = `talk|${fromAgent.id.toLowerCase()}>${targetAgent.id.toLowerCase()}|${(msg.task || '').trim().toLowerCase()}|${msg.message.trim().toLowerCase()}`;
            if (this.options.dispatchedCmdSigs?.get(fromAgent.id)?.has(earlySig)) {
              console.log(`[StreamDispatch] Skip final deliverTalk (already early-dispatched): ${fromAgent.name} -> ${targetAgent.name}`);
            } else {
              await this.options.deliverTalk(targetAgent, fromAgent, { to: resolvedTo, message: msg.message, task: msg.task });
            }
          }
        } else {
          if (msg.to !== 'user' && msg.to !== 'orchestrator' && msg.to !== 'broadcast') {
            const cleanTo = cleanTargetIdentifier(msg.to);
            const isPlaceholder = !cleanTo || INVALID_TARGET_PLACEHOLDERS.has(cleanTo.toLowerCase()) || cleanTo === 'worker' || cleanTo === 'target-id' || cleanTo === 'agent-id';
            if (!isPlaceholder) {
              const notFoundMsg = `[ERROR: TALK_AGENT_NOT_FOUND]\nLý do: Không tìm thấy agent mục tiêu '${msg.to}' trong danh sách active agents.\nCú pháp đúng:\n<talk target="orchestrator">\nNội dung tin nhắn gửi về Orchestrator\n</talk>\n(Hoặc kiểm tra lại danh sách ID agent trong khối [TEAM] để lấy target-id chính xác)`;
              const errChatMsg: ChatMsg = {
                id: (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
                from: 'orchestrator',
                to: fromAgent.id,
                content: notFoundMsg,
                timestamp: Date.now(),
                agentName: 'Orchestrator',
                agentRole: 'orchestrator',
                teamId: fromAgent.teamId || 'default'
              };
              this.options.chatHistory.push(errChatMsg);
              this.options.saveMessage(errChatMsg);
              this.options.broadcast('chat:message', { msg: errChatMsg });

              const activeOrch = this.options.findExistingOrchestrator(fromAgent.teamId) || this.options.agents.get('orchestrator');
              const targetOrch = activeOrch?.id || 'orchestrator';
              this.options.forwardToOrchestrator('TALK_AGENT_NOT_FOUND', notFoundMsg, targetOrch, fromAgent.teamId || 'default');
            } else {
              console.log(`[TALK] Ignored invalid placeholder target: "${msg.to}" from ${fromAgent.name}`);
            }
          }
        }
      }
    }

    return { hasOrchestratorMessage, routedMessagesCount: messages.length };
  }
}
