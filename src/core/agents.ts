import type { TokenUsage } from '../agents/types.js';
import { INVALID_TARGET_PLACEHOLDERS, cleanTargetIdentifier } from './command-parser.js';
import { WORKER_FORMAT_BLOCK } from './prompts.js';

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

export class AgentRegistry {
  private agents = new Map<string, Agent>();
  private membershipVersionByTeam = new Map<string, number>();
  private lastTeamVersionDelivered = new Map<string, number>();
  private legacyMembershipVersion = 1;

  constructor(initialAgents?: Map<string, Agent>) {
    if (initialAgents) {
      this.agents = initialAgents;
    }
  }

  public getRawMap(): Map<string, Agent> {
    return this.agents;
  }

  public get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  public set(id: string, agent: Agent): void {
    this.agents.set(id, agent);
  }

  public has(id: string): boolean {
    return this.agents.has(id);
  }

  public delete(id: string): boolean {
    return this.agents.delete(id);
  }

  public values(): IterableIterator<Agent> {
    return this.agents.values();
  }

  public entries(): IterableIterator<[string, Agent]> {
    return this.agents.entries();
  }

  public get size(): number {
    return this.agents.size;
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

      // Pair Context: Tự động gắn thông tin Coder & Verifier đồng hành
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
}
