import { Router } from 'express';

export interface AgentsRouteDeps {
  agents: Map<string, any>;
  storage: any;
  stopAgent: (id: string, stoppedBy?: 'user' | 'orchestrator' | 'error', errorDetail?: string) => Promise<boolean>;
  deleteSingleAgentOnly: (id: string) => Promise<boolean>;
  dispatchTaskToAgent?: (agentId: string, task: string) => Promise<any>;
}

export function createAgentsRouter(deps: AgentsRouteDeps): Router {
  const router = Router();

  // GET /api/agents
  router.get('/', (_req, res) => {
    const rows = Array.from(deps.agents.values()).map(a => {
      const out: any = { ...a };
      const stored = deps.storage.getAgent(a.id) as any;
      if (out.tokenUsage === undefined && stored && stored.token_usage !== undefined && stored.token_usage !== null) {
        out.tokenUsage = stored.token_usage;
      }
      if (out.contextLength === undefined && stored && stored.context_length !== undefined && stored.context_length !== null) {
        out.contextLength = stored.context_length;
      }
      out.token_usage = out.tokenUsage ?? null;
      out.context_length = out.contextLength ?? null;
      return out;
    });
    res.json(rows);
  });

  // POST /api/agents/:id/stop
  router.post('/:id/stop', async (req, res) => {
    const agentId = req.params.id;
    try {
      const stopped = await deps.stopAgent(agentId, 'user');
      res.json({ ok: stopped });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // DELETE /api/agents/:id
  router.delete('/:id', async (req, res) => {
    const agentId = req.params.id;
    try {
      const deleted = await deps.deleteSingleAgentOnly(agentId);
      res.json({ ok: deleted });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
