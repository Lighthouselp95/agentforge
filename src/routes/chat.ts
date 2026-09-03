import { Router } from 'express';

export interface ChatRouteDeps {
  chatHistory: any[];
  storage: any;
  agents: Map<string, any>;
  dispatchUserChat: (params: { targetAgentId: string; rawMsg: string; isSlashCommand?: boolean; isRetry?: boolean; teamId?: string }) => Promise<any>;
}

export function createChatRouter(deps: ChatRouteDeps): Router {
  const router = Router();

  // GET /api/history (hỗ trợ lọc theo teamId, agentId, limit, beforeId)
  router.get('/history', (req, res) => {
    const qLimit = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : undefined;
    const qBeforeId = req.query.beforeId !== undefined ? String(req.query.beforeId) : undefined;
    const qAgentId = req.query.agentId !== undefined ? String(req.query.agentId) : undefined;
    const qTeamId = req.query.teamId !== undefined ? String(req.query.teamId) : undefined;

    let teamFilter: string | undefined = qTeamId;
    if (qAgentId && teamFilter === undefined) {
      const agent = deps.agents.get(qAgentId);
      if (agent) teamFilter = agent.teamId || 'default';
    }

    const history = deps.storage.getHistory({
      limit: qLimit,
      beforeId: qBeforeId,
      agentId: qAgentId,
      teamId: teamFilter
    });

    res.json(history);
  });

  // GET /api/messages
  router.get('/messages', (_req, res) => {
    res.json(deps.chatHistory);
  });

  // POST /api/chat
  router.post('/chat', async (req, res) => {
    const { targetAgentId, message, teamId } = req.body || {};
    if (!message || String(message).trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'Message cannot be empty' });
    }

    try {
      const result = await deps.dispatchUserChat({
        targetAgentId: targetAgentId || 'orchestrator',
        rawMsg: String(message),
        teamId
      });
      res.json({ ok: true, result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
