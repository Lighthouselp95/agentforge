// ============ TEAM ISOLATION & ROUTING RESOLUTION ============
import type { Agent } from '../core/agents.js';
import { DEFAULT_TEAM_SETTINGS, type SpawnGateUsage, type TeamSettings } from '../storage/types.js';

export interface TeamIsolationContext {
  getAgentsMap: () => Map<string, Agent>;
  getStorage: () => any;
}

let _context: TeamIsolationContext | null = null;

export function initTeamIsolation(ctx: TeamIsolationContext): void {
  _context = ctx;
}

export const INVALID_TARGET_PLACEHOLDERS = new Set([
  'target-id', '<target-id>', 'agent-id', '<agent-id>', 'id', '<id>',
  'coder-id', '<coder-id>', 'verifier-id', '<verifier-id>',
  'target', '<target>', 'worker', '<worker>', 'recipient', '<recipient>',
  'your-id', '<your-id>', 'name/id', '<name/id>', 'verifier-name/id', '<verifier-name/id>',
  'undefined', 'null', 'none', 'unknown',
  '${targetagent.id}', '\\${targetagent.id}', '${agent.id}', '\\${agent.id}',
  '${targetid}', '\\${targetid}', '${id}', '\\${id}', '${name}', '\\${name}',
  'targetagent.id', 'agent.id', 'targetid'
]);

export function cleanTargetIdentifier(val: string): string {
  if (!val) return '';
  let cleaned = val.trim();
  cleaned = cleaned.replace(/^[<"'\s]+|[>"'\s]+$/g, '').trim();
  const prefixRegex = /^(?:target|target-id|agent-id|id|to)\s*=\s*(.*)$/i;
  const match = cleaned.match(prefixRegex);
  if (match) {
    cleaned = match[1].trim();
  }
  cleaned = cleaned.replace(/^[<"'\s]+|[>"'\s]+$/g, '').trim();
  if (INVALID_TARGET_PLACEHOLDERS.has(cleaned.toLowerCase()) || /^<.*>$/.test(cleaned) || /^\$?\{.*\}$/.test(cleaned)) {
    return '';
  }
  return cleaned;
}

export function isOrchestratorLike(agent: Agent | null | undefined): boolean {
  if (!agent) return false;
  return agent.id === 'orchestrator' || agent.type === 'orchestrator' || agent.role === 'orchestrator';
}

export function findExistingOrchestrator(teamId?: string, ctxOverride?: Partial<TeamIsolationContext>): Agent | undefined {
  const agents = (ctxOverride?.getAgentsMap ? ctxOverride.getAgentsMap() : _context?.getAgentsMap()) || new Map<string, Agent>();
  if (teamId) {
    return Array.from(agents.values()).find(a => (a.teamId || 'default') === teamId && isOrchestratorLike(a));
  }
  const defaultOrch = agents.get('orchestrator');
  if (defaultOrch && isOrchestratorLike(defaultOrch)) return defaultOrch;
  return Array.from(agents.values()).find(a => isOrchestratorLike(a));
}

export function resolveOrchIdForMsg(
  msg: { to?: string; from?: string; teamId?: string },
  explicitOrchId?: string,
  ctxOverride?: Partial<TeamIsolationContext>
): string {
  const agents = (ctxOverride?.getAgentsMap ? ctxOverride.getAgentsMap() : _context?.getAgentsMap()) || new Map<string, Agent>();
  const storage = (ctxOverride?.getStorage ? ctxOverride.getStorage() : _context?.getStorage());

  if (explicitOrchId) {
    const explicitAgent = agents.get(explicitOrchId);
    if (explicitAgent && isOrchestratorLike(explicitAgent)) return explicitAgent.id;
    if (explicitOrchId === 'orchestrator') {
      const activeOrch = findExistingOrchestrator(msg.teamId, ctxOverride);
      return activeOrch ? activeOrch.id : 'orchestrator';
    }
    return explicitOrchId;
  }
  if (msg.to && msg.to !== 'user' && msg.to !== 'broadcast') {
    const targetAgent = agents.get(msg.to);
    if (targetAgent && isOrchestratorLike(targetAgent)) {
      return targetAgent.id;
    }
    if (msg.to === 'orchestrator') {
      const activeOrch = findExistingOrchestrator(msg.teamId, ctxOverride);
      return activeOrch ? activeOrch.id : 'orchestrator';
    }
  }
  if (msg.from) {
    const sender = agents.get(msg.from);
    if (sender?.spawnedBy) {
      const parent = agents.get(sender.spawnedBy) || (storage?.getAgent ? (storage.getAgent(sender.spawnedBy) as any) : undefined);
      if (parent && isOrchestratorLike(parent)) return parent.id;
    }
    if (sender?.teamId) {
      const teamOrch = findExistingOrchestrator(sender.teamId, ctxOverride);
      if (teamOrch) return teamOrch.id;
    }
  }
  if (msg.teamId) {
    const teamOrch = findExistingOrchestrator(msg.teamId, ctxOverride);
    if (teamOrch) return teamOrch.id;
  }
  // Không fallback về root orch (findExistingOrchestrator() không tham số) — tránh xuyên team.
  // Trả về 'orchestrator' (root) làm last resort để tránh crash.
  return 'orchestrator';
}

export function resolveOrchestratorTarget(fromAgent: Agent, ctxOverride?: Partial<TeamIsolationContext>): string {
  const agents = (ctxOverride?.getAgentsMap ? ctxOverride.getAgentsMap() : _context?.getAgentsMap()) || new Map<string, Agent>();
  const storage = (ctxOverride?.getStorage ? ctxOverride.getStorage() : _context?.getStorage());
  const parentId = fromAgent.spawnedBy;
  if (parentId) {
    const parent = agents.get(parentId) || (storage?.getAgent ? (storage.getAgent(parentId) as any) : undefined);
    if (parent && isOrchestratorLike(parent)) return parent.id;
  }
  const teamOrch = findExistingOrchestrator(fromAgent.teamId, ctxOverride);
  if (teamOrch) return teamOrch.id;
  // Không fallback về root orch — nếu team không có orch → trả về 'orchestrator' (root) để tránh crash,
  // nhưng KHÔNG gọi findExistingOrchestrator() không tham số (sẽ xuyên team).
  return 'orchestrator';
}

export function findAgentByIdNameOrRole(
  identifier: string,
  preferredTeamId?: string,
  ctxOverride?: Partial<TeamIsolationContext>
): Agent | undefined {
  if (!identifier) return undefined;
  const cleanId = cleanTargetIdentifier(identifier);
  if (!cleanId) return undefined;
  const idLower = cleanId.toLowerCase();
  if (INVALID_TARGET_PLACEHOLDERS.has(idLower) || idLower === 'worker' || idLower === 'target-id' || idLower === 'agent-id') {
    return undefined;
  }
  const agents = (ctxOverride?.getAgentsMap ? ctxOverride.getAgentsMap() : _context?.getAgentsMap()) || new Map<string, Agent>();
  // Direct ID lookup (UUID là unique, an toàn cross-team)
  if (agents.has(cleanId)) return agents.get(cleanId);

  const isOrchTarget = idLower === 'orchestrator';

  // Ưu tiên 1: Tìm theo tên hoặc role trong cùng preferredTeamId (nếu có và KHÔNG phải orch target)
  if (preferredTeamId && !isOrchTarget) {
    for (const [, agent] of agents) {
      if ((agent.teamId || 'default') === preferredTeamId && String(agent.name || '').toLowerCase() === idLower) return agent;
    }
    for (const [, agent] of agents) {
      if ((agent.teamId || 'default') === preferredTeamId && String(agent.role || '').toLowerCase() === idLower) return agent;
    }
    // Không tìm thấy trong team → KHÔNG fallback toàn cục (tránh xuyên team)
    return undefined;
  }

  // Ưu tiên 2: Fallback tìm toàn cục (khi preferredTeamId undefined hoặc target là orchestrator)
  for (const [, agent] of agents) {
    if (String(agent.name || '').toLowerCase() === idLower) return agent;
  }
  for (const [, agent] of agents) {
    if (String(agent.role || '').toLowerCase() === idLower) return agent;
  }
  return undefined;
}

export function getAgentTeamId(agentId?: string, ctxOverride?: Partial<TeamIsolationContext>): string {
  if (!agentId) {
    const err: any = new Error('TEAM_ORCH_NOT_FOUND: agentId không tồn tại');
    err.code = 'TEAM_ORCH_NOT_FOUND';
    throw err;
  }
  const agents = (ctxOverride?.getAgentsMap ? ctxOverride.getAgentsMap() : _context?.getAgentsMap()) || new Map<string, Agent>();
  const storage = (ctxOverride?.getStorage ? ctxOverride.getStorage() : _context?.getStorage());
  const a = agents.get(agentId);
  if (a?.teamId) return a.teamId;
  // Không tìm thấy trong memory → query storage.
  try {
    const stored = storage?.getAgent ? (storage.getAgent(agentId) as any) : undefined;
    const storedTeam = stored?.teamId || stored?.team_id;
    if (typeof storedTeam === 'string' && storedTeam) return storedTeam;
  } catch {}
  if (agentId !== 'orchestrator') {
    const existing = findExistingOrchestrator(undefined, ctxOverride);
    if (existing && existing.id === agentId && existing.teamId) return existing.teamId;
  }
  const err: any = new Error(`TEAM_ORCH_NOT_FOUND: Không tìm thấy teamId cho agent ${agentId}`);
  err.code = 'TEAM_ORCH_NOT_FOUND';
  throw err;
}

export function getAgentsByTeam(teamId?: string, ctxOverride?: Partial<TeamIsolationContext>): Agent[] {
  const tid = teamId ? String(teamId).trim() : 'default';
  const agents = (ctxOverride?.getAgentsMap ? ctxOverride.getAgentsMap() : _context?.getAgentsMap()) || new Map<string, Agent>();
  return Array.from(agents.values()).filter(a => {
    const aTeam = a.teamId || 'default';
    return aTeam === tid;
  });
}

export function getAgentsByRole(role: string, teamId?: string, ctxOverride?: Partial<TeamIsolationContext>): Agent[] {
  const r = (role || '').toLowerCase().trim();
  const tid = teamId ? String(teamId).trim() : undefined;
  const agents = (ctxOverride?.getAgentsMap ? ctxOverride.getAgentsMap() : _context?.getAgentsMap()) || new Map<string, Agent>();
  return Array.from(agents.values()).filter(a => {
    if (a.type !== 'worker' || a.id === 'orchestrator') return false;
    if ((a.role || '').toLowerCase().trim() !== r) return false;
    if (tid && (a.teamId || 'default') !== tid) return false;
    return true;
  });
}

export function getRoleLimit(role: string): number {
  const r = (role || '').toLowerCase().trim();
  if (r === 'coder') return 4;
  if (r === 'researcher') return 2;
  return 1;
}

export const MAX_AGENT_TASKS = 6;
export const MAX_TEAM_SIZE = 6; // Toi da 6 agent/team (bao gom ca Main Orchestrator)

export function getTeamSettingsLive(teamId?: string, ctxOverride?: Partial<TeamIsolationContext>): TeamSettings {
  const storage = (ctxOverride?.getStorage ? ctxOverride.getStorage() : _context?.getStorage());
  try {
    const s = storage?.getTeamSettings ? storage.getTeamSettings(teamId || 'default') : undefined;
    if (s && typeof s === 'object') return s;
  } catch {}
  return { ...DEFAULT_TEAM_SETTINGS, agentLimits: { ...DEFAULT_TEAM_SETTINGS.agentLimits } };
}

export function getEffectiveRoleLimit(role: string, teamId?: string, ctxOverride?: Partial<TeamIsolationContext>): number {
  const storage = (ctxOverride?.getStorage ? ctxOverride.getStorage() : _context?.getStorage());
  try {
    if (storage?.teamSettings?.getRoleLimit) {
      return storage.teamSettings.getRoleLimit(getTeamSettingsLive(teamId, ctxOverride), role);
    }
  } catch {}
  return getRoleLimit(role);
}

export function getEffectiveTeamSizeLimit(teamId?: string, ctxOverride?: Partial<TeamIsolationContext>): number {
  return getTeamSettingsLive(teamId, ctxOverride).maxTeamSize ?? MAX_TEAM_SIZE;
}

export function getEffectiveTaskLimit(teamId?: string, ctxOverride?: Partial<TeamIsolationContext>): number {
  return getTeamSettingsLive(teamId, ctxOverride).taskLimit ?? MAX_AGENT_TASKS;
}

export function checkLiveSpawnGate(
  teamId: string,
  role: string,
  ctxOverride?: Partial<TeamIsolationContext>
): { canSpawn: boolean; reason: string; code: string; usage: SpawnGateUsage; settings: TeamSettings } {
  const tid = teamId || 'default';
  const r = (role || '').toLowerCase().trim();
  const agents = (ctxOverride?.getAgentsMap ? ctxOverride.getAgentsMap() : _context?.getAgentsMap()) || new Map<string, Agent>();
  const storage = (ctxOverride?.getStorage ? ctxOverride.getStorage() : _context?.getStorage());

  let teamSize = 0;
  let roleCount = 0;
  const roles = new Set<string>();
  for (const [, a] of agents) {
    if ((a.teamId || 'default') !== tid) continue;
    teamSize++;
    const ar = String(a.role || '').toLowerCase().trim();
    if (ar) roles.add(ar);
    if (r && ar === r) roleCount++;
  }
  const usage: SpawnGateUsage = { teamSize, roleCount, distinctRoles: roles.size, roleExists: r ? roles.has(r) : false };
  const settings = getTeamSettingsLive(tid, ctxOverride);
  let gate = { canSpawn: true, reason: 'OK', code: 'OK' };
  try {
    if (storage?.checkTeamSpawnGate) {
      gate = storage.checkTeamSpawnGate(tid, role, usage) as any;
    }
  } catch {}
  return { ...gate, usage, settings };
}
