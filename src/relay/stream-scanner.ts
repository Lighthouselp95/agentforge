// ============ STREAM SCANNER & EARLY DISPATCH ============
import type { Agent } from '../core/agents.js';
import {
  extractDualCommands,
  parseTalkCommand,
  cleanTargetIdentifier
} from '../core/command-parser.js';
import { talkDispatchSig } from './dedup.js';

export const MAX_DISPATCH_BUF = 200_000;

export interface StreamScannerOptions {
  onDeliverEarlyTalk: (targetAgent: Agent, fromAgent: Agent, msg: { to: string; message: string; task?: string }) => Promise<void>;
  findAgent: (cleanTo: string) => Agent | undefined;
  onEarlyBroadcastTalk?: (fromAgent: Agent, targetAgent: Agent, message: string, task?: string) => void;
}

export class StreamScanner {
  private dispatchTextBuf: Record<string, string> = {};
  private dispatchedCmdSigs: Map<string, Set<string>> = new Map();
  private options: StreamScannerOptions;

  constructor(options: StreamScannerOptions) {
    this.options = options;
  }

  public getDispatchedSigs(agentId: string): Set<string> | undefined {
    return this.dispatchedCmdSigs.get(agentId);
  }

  public appendText(agentId: string, rawPart: string): void {
    this.dispatchTextBuf[agentId] = this.dispatchTextBuf[agentId]
      ? `${this.dispatchTextBuf[agentId]}\n${rawPart}`
      : rawPart;
    if (this.dispatchTextBuf[agentId].length > MAX_DISPATCH_BUF) {
      this.dispatchTextBuf[agentId] = this.dispatchTextBuf[agentId].slice(-MAX_DISPATCH_BUF);
    }
  }

  public scanAndDispatch(agent: Agent): void {
    if (!this.dispatchTextBuf[agent.id]) return;
    this.dispatchTextBuf[agent.id] = this.scanStreamForDispatch(agent, this.dispatchTextBuf[agent.id]);
  }

  public scanStreamForDispatch(fromAgent: Agent, accumulated: string): string {
    if (!accumulated || !accumulated.trim()) return accumulated;

    const talks = extractDualCommands(accumulated, ['TALK']);
    for (const cmd of talks) {
      if (cmd.tag.toUpperCase() !== 'TALK') continue;
      const parsed = parseTalkCommand(cmd);
      if (!parsed || !parsed.agentId) continue;

      // Chặn dispatch talk XML chưa hoàn chỉnh
      if (cmd.syntax === 'xml' && !/\/>(\s*)$/.test(cmd.fullMatch || '') && !/<\/talk>\s*$/i.test(cmd.fullMatch || '')) {
        continue;
      }

      const cleanTo = cleanTargetIdentifier(parsed.agentId);
      if (!cleanTo || cleanTo.toLowerCase() === 'orchestrator' || cleanTo.toLowerCase() === 'main' || cleanTo.toLowerCase() === 'user') {
        continue;
      }
      const targetAgent = this.options.findAgent(cleanTo);
      if (!targetAgent) {
        continue;
      }
      if (targetAgent.type === 'orchestrator' || targetAgent.id === 'orchestrator') {
        continue;
      }
      const task = parsed.task;
      const message = parsed.message || '';
      const sig = talkDispatchSig(fromAgent.id, targetAgent.id, task, message);
      if (this.dispatchedCmdSigs.get(fromAgent.id)?.has(sig)) continue;

      try {
        if (!this.dispatchedCmdSigs.has(fromAgent.id)) {
          this.dispatchedCmdSigs.set(fromAgent.id, new Set());
        }
        this.dispatchedCmdSigs.get(fromAgent.id)!.add(sig);

        if (this.options.onEarlyBroadcastTalk) {
          try {
            this.options.onEarlyBroadcastTalk(fromAgent, targetAgent, message, task);
          } catch {}
        }

        this.options.onDeliverEarlyTalk(targetAgent, fromAgent, {
          to: targetAgent.id,
          message,
          task
        }).catch((err: any) => {
          console.error(`[StreamDispatch] deliverTalk failed (${fromAgent.name}->${targetAgent.name}): ${err?.message || err}`);
        });
      } catch (err: any) {
        console.error(`[StreamDispatch] dispatch error: ${err?.message || err}`);
      }
      if (cmd.fullMatch) {
        const matchIdx = accumulated.indexOf(cmd.fullMatch);
        if (matchIdx !== -1) {
          accumulated = accumulated.substring(0, matchIdx) + accumulated.substring(matchIdx + cmd.fullMatch.length);
        } else {
          accumulated = accumulated.replace(cmd.fullMatch, '');
        }
      }
    }

    return accumulated;
  }

  public drain(agentId: string): void {
    delete this.dispatchTextBuf[agentId];
    this.dispatchedCmdSigs.delete(agentId);
  }
}
