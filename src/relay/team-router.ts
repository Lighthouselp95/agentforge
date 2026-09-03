// ============ TEAM ROUTER & CONTEXT ============
import type { Agent } from '../core/agents.js';
import type { RelayMessage, RelayRoutingResult, TargetScope } from './types.js';

export class TeamContextManager {
  private agents: Map<string, Agent>;

  constructor(agents: Map<string, Agent>) {
    this.agents = agents;
  }

  public getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  public getTeamIdForAgent(agentId: string): string {
    const agent = this.agents.get(agentId);
    return agent?.teamId || 'default';
  }

  public getTeamMembers(teamId: string = 'default'): Agent[] {
    return Array.from(this.agents.values()).filter(a => (a.teamId || 'default') === teamId);
  }

  public findTeamOrchestrator(teamId: string = 'default'): Agent | undefined {
    // 1. Tìm orchestrator cụ thể trong team
    const teamOrch = Array.from(this.agents.values()).find(
      a => (a.teamId || 'default') === teamId && (a.type === 'orchestrator' || a.role === 'orchestrator' || a.id === 'orchestrator')
    );
    if (teamOrch) return teamOrch;

    // 2. Fallback tìm default orchestrator
    const defaultOrch = this.agents.get('orchestrator');
    if (defaultOrch) return defaultOrch;

    // 3. Fallback tìm bất kỳ orchestrator nào
    return Array.from(this.agents.values()).find(
      a => a.type === 'orchestrator' || a.role === 'orchestrator'
    );
  }

  public resolveRouting(message: RelayMessage): RelayRoutingResult {
    const targetClean = (message.to || '').trim().toLowerCase();
    const teamId = message.teamId || this.getTeamIdForAgent(message.from);

    if (targetClean === 'broadcast' || targetClean === 'all') {
      return {
        routed: true,
        targetId: 'broadcast',
        targetScope: 'broadcast',
        teamId
      };
    }

    if (targetClean === 'orchestrator' || targetClean === 'main') {
      const orch = this.findTeamOrchestrator(teamId);
      return {
        routed: true,
        targetId: orch ? orch.id : 'orchestrator',
        targetScope: 'orchestrator',
        teamId
      };
    }

    if (targetClean === 'user') {
      return {
        routed: true,
        targetId: 'user',
        targetScope: 'user',
        teamId
      };
    }

    const targetAgent = this.agents.get(message.to);
    if (targetAgent) {
      const scope: TargetScope = (targetAgent.type === 'orchestrator' || targetAgent.role === 'orchestrator')
        ? 'orchestrator'
        : 'agent';
      return {
        routed: true,
        targetId: targetAgent.id,
        targetScope: scope,
        teamId: targetAgent.teamId || teamId
      };
    }

    return {
      routed: false,
      targetId: message.to,
      targetScope: 'agent',
      teamId,
      error: `Agent not found: ${message.to}`
    };
  }
}
