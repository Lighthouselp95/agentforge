import { Router } from 'express';

export interface SettingsRouteDeps {
  storage: any;
  broadcast: (type: string, data: any) => void;
  agents: Map<string, any>;
  clients: Map<string, any>;
  resolveModelForAgent: (agent: any) => string | undefined;
}

export function createSettingsRouter(deps: SettingsRouteDeps): Router {
  const router = Router();

  // GET /api/settings/watchdog
  router.get('/watchdog', (_req, res) => {
    res.json({ enableWatchdog: false });
  });

  // POST /api/settings/watchdog
  router.post('/watchdog', (req, res) => {
    const { enableWatchdog } = req.body || {};
    const enabled = Boolean(enableWatchdog);
    deps.storage.setSetting('enableWatchdog', enabled);
    deps.broadcast('settings:updated', { enableWatchdog: enabled });
    res.json({ success: true, enableWatchdog: enabled });
  });

  // GET /api/settings/autoContinue
  router.get('/autoContinue', (_req, res) => {
    res.json({ autoContinue: deps.storage.getSetting('autoContinue', false) === true });
  });

  // POST /api/settings/autoContinue
  router.post('/autoContinue', (req, res) => {
    const { autoContinue } = req.body || {};
    const enabled = Boolean(autoContinue);
    deps.storage.setSetting('autoContinue', enabled);
    deps.broadcast('settings:updated', { autoContinue: enabled });
    res.json({ success: true, autoContinue: enabled });
  });

  // GET /api/settings/models
  router.get('/models', (_req, res) => {
    const modelSettings = deps.storage.getModelSettings();
    res.json(modelSettings);
  });

  // POST /api/settings/models
  router.post('/models', (req, res) => {
    const { orchestratorModel, defaultSubagentModel, agentModelOverrides } = req.body || {};

    if (orchestratorModel !== undefined) {
      if (orchestratorModel) process.env.ORCHESTRATOR_MODEL = orchestratorModel;
      else delete process.env.ORCHESTRATOR_MODEL;
      const orchAgent = deps.agents.get('orchestrator');
      if (orchAgent) {
        orchAgent.model = orchestratorModel || undefined;
        deps.storage.updateAgent('orchestrator', { model: orchestratorModel || null });
      }
      const orchClient = deps.clients.get('orchestrator');
      if (orchClient) orchClient.setModel(orchestratorModel || undefined);
    }

    const updated = deps.storage.setModelSettings({
      orchestratorModel: orchestratorModel !== undefined ? (orchestratorModel || null) : undefined,
      defaultSubagentModel: defaultSubagentModel !== undefined ? (defaultSubagentModel || null) : undefined,
      agentModelOverrides: agentModelOverrides !== undefined ? agentModelOverrides : undefined
    });

    // Re-apply resolved models to all active clients
    for (const [id, agent] of deps.agents.entries()) {
      if (id === 'orchestrator') continue;
      const client = deps.clients.get(id);
      if (client) {
        const resolved = deps.resolveModelForAgent(agent);
        client.setModel(resolved || undefined);
      }
    }

    deps.broadcast('settings:updated', { models: updated });
    res.json({ ok: true, settings: updated });
  });

  return router;
}
