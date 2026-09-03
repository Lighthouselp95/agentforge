export const ROLE_LIMITS: Record<string, number> = {
  coder: 4,
  verifier: 2,
  researcher: 2,
  tester: 2,
  reviewer: 2,
  docs: 2,
  planner: 2,
  debugger: 2,
  searcher: 2,
  idea: 2,
  orchestrator: 1
};

export const DEFAULT_ROLE_LIMIT = 2;

export function getRoleLimit(role: string): number {
  const norm = (role || '').toLowerCase().trim();
  return ROLE_LIMITS[norm] !== undefined ? ROLE_LIMITS[norm] : DEFAULT_ROLE_LIMIT;
}

export function checkRoleLimit(role: string, currentRoleCount: number): { allowed: boolean; limit: number; current: number } {
  const limit = getRoleLimit(role);
  return {
    allowed: currentRoleCount < limit,
    limit,
    current: currentRoleCount
  };
}
