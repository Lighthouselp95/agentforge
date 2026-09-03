import { v4 as uuidv4 } from 'uuid';
import type { ACPClient } from './acp-client.js';
import type { TokenUsage } from './types.js';
import { storage } from '../storage.js';
import { WORKER_FORMAT_BLOCK } from '../prompts/prompt-service.js';
import { cleanTargetIdentifier, INVALID_TARGET_PLACEHOLDERS } from '../parser/string-utils.js';
import { checkRoleLimit, getRoleLimit } from './role-limits.js';

export interface AgentTask {
  id: string;
  task: string;
  status: 'pending' | 'working' | 'completed';
  createdAt: number;
  completedAt?: number;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  type: 'orchestrator' | 'worker';
  status: 'idle' | 'working' | 'error' | 'stopped';
  spawnedBy?: string;
  projectDir?: string;
  model?: string;
  teamId?: string; // Nhóm team (orchestrator) agent thuộc về — tách lịch sử chat giữa các team
  sessionId?: string;
  sessionTitle?: string;
  task?: string;
  tasks?: AgentTask[];
  createdAt: number;
  workingSince?: number;
  tokenUsage?: TokenUsage;
  contextLength?: number;
}

export interface ChatMsg {
  id: string;
  from: string;
  to: string;
  content: string;
  task?: string;
  timestamp: number;
  agentName?: string;
  agentRole?: string;
  teamId?: string;
  msgType?: string;
  showOnUI?: boolean;
  toolCalls?: Array<{ tool: string; input?: string; output?: string }>;
  thinking?: string;
  allowThinking?: boolean;
  parts?: Array<{ type: 'text' | 'tool'; content?: string; tool?: string; input?: any; output?: any }>;
}

export class AgentManager {
  private agents = new Map<string, Agent>();
  private clients = new Map<string, ACPClient>();
  private membershipVersionByTeam = new Map<string, number>();
  private lastTeamVersionDelivered = new Map<string, number>();
  private legacyMembershipVersion = 1;
  private onBroadcast?: (event: string, data: any) => void;

  constructor(options?: {
    agents?: Map<string, Agent>;
    clients?: Map<string, ACPClient>;
    onBroadcast?: (event: string, data: any) => void;
  }) {
    if (options?.agents) this.agents = options.agents;
    if (options?.clients) this.clients = options.clients;
    if (options?.onBroadcast) this.onBroadcast = options.onBroadcast;
  }

  public setBroadcastHandler(handler: (event: string, data: any) => void) {
    this.onBroadcast = handler;
  }

  public getAgentsMap(): Map<string, Agent> {
    return this.agents;
  }

  public getClientsMap(): Map<string, ACPClient> {
    return this.clients;
  }

  public getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  public getClient(id: string): ACPClient | undefined {
    return this.clients.get(id);
  }

  public setClient(id: string, client: ACPClient): void {
    this.clients.set(id, client);
  }

  public hasAgent(id: string): boolean {
    return this.agents.has(id);
  }

  public getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  public findAgentByIdNameOrRole(identifier: string): Agent | undefined {
    if (!identifier) return undefined;
    const cleanId = cleanTargetIdentifier(identifier);
    if (!cleanId) return undefined;
    const idLower = cleanId.toLowerCase();
    if (INVALID_TARGET_PLACEHOLDERS.has(idLower) || idLower === 'worker' || idLower === 'target-id' || idLower === 'agent-id') {
      return undefined;
    }
    if (this.agents.has(cleanId)) return this.agents.get(cleanId);
    for (const [, agent] of this.agents) {
      if (String(agent.name || '').toLowerCase() === idLower) return agent;
    }
    for (const [, agent] of this.agents) {
      if (String(agent.role || '').toLowerCase() === idLower) return agent;
    }
    return undefined;
  }

  public findAgentByName(name: string): Agent | undefined {
    if (!name) return undefined;
    const clean = cleanTargetIdentifier(name).toLowerCase();
    if (!clean) return undefined;
    for (const [, agent] of this.agents) {
      if (String(agent.name || '').toLowerCase() === clean) return agent;
    }
    return undefined;
  }

  public findExistingOrchestrator(teamId?: string): Agent | undefined {
    if (teamId) {
      for (const [, a] of this.agents) {
        if (a.type === 'orchestrator' && a.teamId === teamId) return a;
      }
    }
    const defaultOrch = this.agents.get('orchestrator');
    if (defaultOrch && defaultOrch.type === 'orchestrator') return defaultOrch;
    for (const [, a] of this.agents) {
      if (a.type === 'orchestrator') return a;
    }
    return undefined;
  }

  public checkLimit(role: string): { allowed: boolean; limit: number; current: number } {
    const roleLower = (role || '').toLowerCase().trim();
    let count = 0;
    for (const [, a] of this.agents) {
      if ((a.role || '').toLowerCase().trim() === roleLower) {
        count++;
      }
    }
    return checkRoleLimit(roleLower, count);
  }

  public getMembershipVersion(teamId: string): number {
    return this.membershipVersionByTeam.get(teamId || 'default') || 1;
  }

  public bumpMembershipVersion(teamId: string): void {
    const tid = teamId || 'default';
    this.membershipVersionByTeam.set(tid, this.getMembershipVersion(tid) + 1);
  }

  public notifyTeamChanged(teamId?: string): void {
    if (teamId) {
      this.bumpMembershipVersion(teamId);
      this.legacyMembershipVersion++;
    } else {
      const teams = new Set(Array.from(this.agents.values()).map(a => a.teamId || 'default'));
      for (const tid of teams) this.bumpMembershipVersion(tid);
      if (teams.size === 0) this.bumpMembershipVersion('default');
      this.legacyMembershipVersion++;
    }
  }

  public shouldIncludeTeamContext(agentId: string, hasExplicitChange = false): boolean {
    const agent = this.agents.get(agentId);
    const tid = agent?.teamId || 'default';
    const curVer = this.getMembershipVersion(tid);
    if (hasExplicitChange) {
      this.lastTeamVersionDelivered.set(agentId, curVer);
      return true;
    }
    const lastDelivered = this.lastTeamVersionDelivered.get(agentId) || 0;
    if (lastDelivered < curVer) {
      this.lastTeamVersionDelivered.set(agentId, curVer);
      return true;
    }
    return false;
  }

  public truncateTask(task: string): string {
    return (task || '').split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 100);
  }

  public formatAgentTasksSummary(a: Agent): string {
    if (Array.isArray(a.tasks) && a.tasks.length > 0) {
      const taskStrs = a.tasks.map((t, idx) => {
        const num = t.id || String(idx + 1);
        const status = t.status || 'working';
        const tNorm = (t.task || '').normalize('NFC').replace(/\s+/g, ' ').trim();
        const text = tNorm.length > 100 ? tNorm.slice(0, 97) + '...' : tNorm;
        return `#${num} [${status}] ${text}`;
      });
      return ` | Tasks: ${taskStrs.join('; ')}`;
    }
    const rawTask = a.task ? a.task.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
    return rawTask ? ` | Task: ${rawTask.length > 100 ? rawTask.slice(0, 97) + '...' : rawTask}` : ' | Tasks: (Trống)';
  }

  public buildTeam(agentId: string, full: boolean = true): string {
    const self = this.agents.get(agentId);
    const isOrchestrator = self?.type === 'orchestrator' || agentId === 'orchestrator' || String(agentId || '').toLowerCase() === 'orchestrator' || self?.role === 'orchestrator';
    const selfTeamId = self?.teamId || 'default';

    const others = Array.from(this.agents.values()).filter(a => {
      if (a.id === agentId) return false;
      if (a.id === 'orchestrator' || a.type === 'orchestrator') return false;
      if ((a.teamId || 'default') !== selfTeamId) return false;
      return true;
    });

    const suffix = isOrchestrator ? '' : WORKER_FORMAT_BLOCK;
    const lines: string[] = [];

    if (self) {
      lines.push(`Your ID: ${self.id}`);
      lines.push(`Your name: ${self.name}`);
      lines.push(`Your role: ${self.role}`);
      if (self.task) {
        const selfTask = self.task.normalize('NFC').replace(/\s+/g, ' ').trim();
        lines.push(`Your task: ${selfTask.length > 100 ? selfTask.slice(0, 97) + '...' : selfTask}`);
      }
      if (Array.isArray(self.tasks) && self.tasks.length > 0) {
        const taskStrs = self.tasks.map((t, idx) => {
          const num = t.id || String(idx + 1);
          const status = t.status || 'working';
          const tNorm = (t.task || '').normalize('NFC').replace(/\s+/g, ' ').trim();
          const text = tNorm.length > 100 ? tNorm.slice(0, 97) + '...' : tNorm;
          return `#${num} [${status}] ${text}`;
        });
        lines.push(`Your tasks: ${taskStrs.join('; ')}`);
      } else {
        lines.push(`Your tasks: (Trống)`);
      }

      const roleLower = (self.role || '').toLowerCase();
      if (roleLower.includes('verif') || roleLower.includes('reviewer')) {
        const coders = others.filter(a => (a.role || '').toLowerCase().includes('coder') || (a.role || '').toLowerCase().includes('debug'));
        let partnerCoder = coders.find(c => self.task && (self.task.includes(c.id) || self.task.includes(c.name)));
        if (!partnerCoder && coders.length > 0) partnerCoder = coders[0];
        if (partnerCoder) {
          lines.push(`Your Partner (Coder): ${partnerCoder.name} (Role: ${partnerCoder.role}, ID: ${partnerCoder.id})`);
        }
      } else if (roleLower.includes('coder') || roleLower.includes('debug')) {
        const verifiers = others.filter(a => (a.role || '').toLowerCase().includes('verif'));
        let partnerVerifier = verifiers.find(v => self.task && (self.task.includes(v.id) || self.task.includes(v.name)));
        if (!partnerVerifier && verifiers.length > 0) partnerVerifier = verifiers[0];
        if (partnerVerifier) {
          lines.push(`Your Partner (Verifier): ${partnerVerifier.name} (Role: ${partnerVerifier.role}, ID: ${partnerVerifier.id})`);
        }
      }
    }

    if (others.length === 0) {
      lines.push(isOrchestrator ? 'No active agents.' : 'No other agents are currently active.');
      return (lines.join('\n') + (self?.sessionId ? '' : suffix)).normalize('NFC');
    }

    const roleCounts: Record<string, number> = {};
    others.forEach(a => { roleCounts[a.role] = (roleCounts[a.role] || 0) + 1; });
    lines.push(`\nActive Team: ${others.length} agents - ${Object.entries(roleCounts).map(([r,c]) => `${c}x ${r}`).join(', ')}`);
    lines.push('\nMembers:');
    others.forEach(a => {
      const wt = a.workingSince ? ` (${Math.round((Date.now() - a.workingSince) / 1000)}s working)` : '';
      const taskInfo = this.formatAgentTasksSummary(a);
      lines.push(`  - ${a.name} (${a.role}) [${a.status}]${taskInfo}${wt} | ID: ${a.id}`);
    });
    return (lines.join('\n') + (self?.sessionId ? '' : suffix)).normalize('NFC');
  }

  public registerAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
    storage.saveAgent(agent);
    this.notifyTeamChanged(agent.teamId);
    if (this.onBroadcast) {
      this.onBroadcast('agent:created', { agent });
    }
  }

  public updateAgent(id: string, updates: Partial<Agent>): Agent | undefined {
    const a = this.agents.get(id);
    if (!a) return undefined;
    Object.assign(a, updates);
    storage.updateAgent(id, updates);
    if (this.onBroadcast) {
      this.onBroadcast('agent:updated', { agent: a });
    }
    return a;
  }

  public stopAgent(id: string, stoppedBy: 'user' | 'orchestrator' | 'error' = 'user', errorDetail?: string): boolean {
    const a = this.agents.get(id);
    if (!a || a.status === 'stopped') return false;
    const client = this.clients.get(id);
    if (client) {
      try { client.abort(); } catch {}
    }
    a.status = (stoppedBy === 'error') ? 'error' : 'stopped';
    a.workingSince = undefined;
    this.clients.delete(a.id);
    storage.updateAgent(a.id, { status: a.status, workingSince: null });
    if (this.onBroadcast) {
      this.onBroadcast('agent:updated', { agent: a });
    }

    let stopText = `🛑 [STOPPED] Agent ${a.name} was stopped by ${stoppedBy}.`;
    let msgType = (stoppedBy === 'user') ? 'stop_user' : (stoppedBy === 'orchestrator') ? 'stop_orchestrator' : 'stop_error';
    if (stoppedBy === 'error') {
      stopText = `❌ [CRASHED] Agent ${a.name} stopped due to error: ${errorDetail || 'Unknown error'}`;
    }
    const targetOrch = a.spawnedBy || 'orchestrator';
    const stopMsg: ChatMsg = {
      id: uuidv4(),
      from: a.id,
      to: targetOrch,
      content: stopText,
      timestamp: Date.now(),
      agentName: a.name,
      agentRole: a.role,
      msgType,
      teamId: a.teamId || 'default'
    };
    storage.saveMessage(stopMsg);
    if (this.onBroadcast) {
      this.onBroadcast('chat:message', { msg: stopMsg });
    }
    console.log(`[Stop] ${a.name} (${a.id}) by ${stoppedBy}`);
    return true;
  }

  public resumeAgent(id: string, onResumeWork?: (agent: Agent) => void): boolean {
    const a = this.agents.get(id);
    if (!a || a.status !== 'stopped') return false;
    a.status = 'idle';
    storage.updateAgent(a.id, { status: 'idle' });
    if (this.onBroadcast) {
      this.onBroadcast('agent:updated', { agent: a });
    }
    console.log(`[Resume] ${a.name} (${a.id})`);
    if (onResumeWork) {
      setTimeout(() => {
        onResumeWork(a);
      }, 300);
    }
    return true;
  }

  public deleteAgent(id: string): boolean {
    const a = this.agents.get(id);
    const client = this.clients.get(id);
    if (client) {
      try { client.abort(); } catch {}
      this.clients.delete(id);
    }
    const removed = this.agents.delete(id);
    if (a) {
      this.notifyTeamChanged(a.teamId);
    }
    storage.deleteAgent(id);
    if (this.onBroadcast) {
      this.onBroadcast('agent:deleted', { agentId: id });
    }
    console.log(`[Delete] ${a ? (a.name || a.role || id) : id} (${id}) — session and history cleaned up and removed`);
    return removed;
  }
}
