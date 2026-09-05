import { Router } from 'express';
import { ACPClient } from '../agents/acp-client.js';

// Pha 1 refactor: HTTP handlers /api/orchestrator/* dời verbatim từ src/server.ts.
export interface OrchestratorRouteDeps {
  agents: Map<string, any>;
  clients: Map<string, any>;
  storage: any;
  broadcast: (type: string, data: any) => void;
  chatHistory: any[];
}

export function createOrchestratorRouter(deps: OrchestratorRouteDeps): Router {
  const router = Router();

  // POST /api/orchestrator/model — Set model cho main (giữ session cũ, chỉ đổi model)
  router.post('/model', (req, res) => {
    const { model } = req.body || {};
    if (model) process.env.ORCHESTRATOR_MODEL = model; else delete process.env.ORCHESTRATOR_MODEL;
    deps.storage.setSetting('orchestratorModel', model || null);
    const orchAgent = deps.agents.get('orchestrator');
    if (orchAgent) {
      orchAgent.model = model || undefined;
      deps.storage.updateAgent('orchestrator', { model: model || null });
    }
    const orchClient = deps.clients.get('orchestrator');
    if (orchClient) orchClient.setModel(model || undefined); // KHÔNG reset client → giữ session
    deps.broadcast('settings:updated', { models: deps.storage.getModelSettings() });
    res.json({ ok: true });
  });

  // POST /api/orchestrator/clear — Clear main conversation + session opencode
  router.post('/clear', async (_req, res) => {
    let sessionDeleted = false;
    let deleteError: string | null = null;
    try {
      const orchClient = deps.clients.get('orchestrator');
      if (orchClient) {
        const sid = orchClient.getSessionId();
        if (sid) {
          // Retry delete lên 2 lần nếu fail
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              sessionDeleted = await orchClient.deleteSession(sid);
              if (sessionDeleted) break;
            } catch (delErr: any) {
              deleteError = delErr.message;
              console.log(`[Clear] Delete session attempt ${attempt + 1} failed: ${delErr.message}`);
            }
          }
        }
      }

      // Xoá client + session mapping + DB record
      deps.clients.delete('orchestrator');
      ACPClient.unregisterSession('orchestrator');
      deps.storage.updateAgent('orchestrator', { sessionId: null, sessionTitle: null });

      // Update in-memory orchestrator agent immediately and broadcast for UI sync
      const orchAgent = deps.agents.get('orchestrator');
      if (orchAgent) {
        orchAgent.sessionId = undefined;
        orchAgent.sessionTitle = undefined;
        deps.broadcast('agent:updated', { agent: orchAgent });
      }

      // Xoá hội thoại MAIN (msg từ/tới orchestrator) — giữ hội thoại riêng của agents
      const keep: any[] = [];
      deps.chatHistory.forEach(msg => {
        const isMainView = msg.from === 'orchestrator' || msg.to === 'orchestrator';
        if (!isMainView) keep.push(msg);
      });
      deps.chatHistory.length = 0;
      deps.chatHistory.push(...keep);
      deps.storage.clearOrchestratorConversation();
      deps.broadcast('chat:message', { action: 'clear' });
      if (!sessionDeleted && deleteError) {
        console.log(`[Clear] WARNING: Session delete failed (${deleteError}), but local state cleared. Next chat will create fresh session.`);
      } else {
        console.log('[Clear] Orchestrator conversation + session cleared');
      }
      res.json({ ok: true, sessionDeleted, warning: !sessionDeleted ? 'Session delete failed, local state cleared' : undefined });
    } catch (e: any) {
      // Vẫn force clear local state nếu có lỗi ngoài dự kiến
      deps.clients.delete('orchestrator');
      ACPClient.unregisterSession('orchestrator');
      deps.storage.updateAgent('orchestrator', { sessionId: null, sessionTitle: null });

      // Also update in-memory agent on error path
      const orchAgent = deps.agents.get('orchestrator');
      if (orchAgent) {
        orchAgent.sessionId = undefined;
        orchAgent.sessionTitle = undefined;
        deps.broadcast('agent:updated', { agent: orchAgent });
      }

      res.json({ ok: false, error: e.message });
    }
  });

  return router;
}
