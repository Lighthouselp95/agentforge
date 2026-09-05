export const ROLE_LIMITS: Record<string, number> = {
  coder: 4,
  researcher: 2,
  verifier: 1,
  tester: 1,
  reviewer: 1,
  docs: 1,
  planner: 1,
  debugger: 1,
  searcher: 1,
  idea: 1,
  orchestrator: 1
};

export const DEFAULT_ROLE_LIMIT = 1;

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
