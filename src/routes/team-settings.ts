import { Router } from 'express';

export interface TeamSettingsRouteDeps {
  storage: any;
  broadcast: (type: string, data: any) => void;
  agents: Map<string, any>;
}

function teamUsage(agents: Map<string, any>, teamId: string, role?: string) {
  const tid = teamId || 'default';
  const r = (role || '').toLowerCase().trim();
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
  return {
    teamSize,
    roleCount,
    distinctRoles: roles.size,
    roleExists: r ? roles.has(r) : false
  };
}

export function createTeamSettingsRouter(deps: TeamSettingsRouteDeps): Router {
  const router = Router();

  // GET /api/teams/:teamId/settings — lấy settings live của team (merge default)
  router.get('/:teamId/settings', (req, res) => {
    const teamId = req.params.teamId || 'default';
    try {
      const settings = deps.storage.getTeamSettings(teamId);
      res.json({ ok: true, teamId, settings });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // PUT /api/teams/:teamId/settings — cập nhật settings (merge patch đã validate)
  router.put('/:teamId/settings', (req, res) => {
    const teamId = req.params.teamId || 'default';
    try {
      const settings = deps.storage.setTeamSettings(teamId, req.body || {});
      deps.broadcast('team-settings:updated', { teamId, settings });
      res.json({ ok: true, teamId, settings });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // DELETE /api/teams/:teamId/settings — reset về default
  router.delete('/:teamId/settings', (req, res) => {
    const teamId = req.params.teamId || 'default';
    try {
      const settings = deps.storage.resetTeamSettings(teamId);
      deps.broadcast('team-settings:updated', { teamId, settings });
      res.json({ ok: true, teamId, settings });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // GET /api/teams/:teamId/settings/live-check?role=coder
  // UI gọi trước mỗi spawn/talk để check sống (trả về canSpawn + reason).
  router.get('/:teamId/settings/live-check', (req, res) => {
    const teamId = req.params.teamId || 'default';
    const role = String((req.query as any)?.role || '');
    try {
      const settings = deps.storage.getTeamSettings(teamId);
      const usage = teamUsage(deps.agents, teamId, role);
      const gate = deps.storage.checkTeamSpawnGate(teamId, role, usage);
      res.json({ ok: true, teamId, role, canSpawn: gate.canSpawn, reason: gate.reason, code: gate.code, settings, usage });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  return router;
}
