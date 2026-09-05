import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ACPClient } from '../agents/acp-client.js';

// Pha 1 refactor: toàn bộ HTTP handlers /api/agents* dời verbatim từ src/server.ts.
// Mọi closure (agents map, storage, broadcast, helpers) được inject qua deps —
// behavior giữ nguyên 1:1, server.ts chỉ còn mount router.
export interface AgentsRouteDeps {
  agents: Map<string, any>;
  storage: any;
  broadcast: (type: string, data: any) => void;
  clients: Map<string, any>;
  chatHistory: any[];
  backendUserQueues: Record<string, any[]>;
  abortingAgents: Set<string>;
  projectRoot: string;
  stopAgent: (id: string, stoppedBy?: 'user' | 'orchestrator' | 'error', errorDetail?: string) => boolean;
  resumeAgent: (id: string) => boolean;
  deleteAgent: (id: string) => Promise<boolean>;
  resolveModelForAgent: (agent: any) => string | undefined;
  truncateTask: (task: string) => string;
  autoPruneExcessAgents: (role: string, teamId?: string) => Promise<boolean>;
  checkLiveSpawnGate: (teamId: string, role: string) => { canSpawn: boolean; reason: string; code: string; usage: any; settings: any };
  getEffectiveTeamSizeLimit: (teamId?: string) => number;
  getEffectiveRoleLimit: (role: string, teamId?: string) => number;
  getAgentsByTeam: (teamId?: string) => any[];
  getAgentsByRole: (role: string, teamId?: string) => any[];
  forwardToOrchestrator: (type: string, message: string, targetOrchId: string, teamId?: string) => any;
  notifyTeamChanged: (teamId?: string) => void;
}

export function createAgentsRouter(deps: AgentsRouteDeps): Router {
  const router = Router();

  // GET /api/agents
  router.get('/', (_req, res) => {
    // Trả đủ trường token cho badge: camelCase (UI mới) + snake_case mirror (tương thích),
    // ưu tiên giá trị MỚI NHẤT trong memory; nếu memory chưa có thì bù từ storage row.
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

  // POST /api/agents (create)
  router.post('/', async (req, res) => {
    const { name, role: rawRole, type: rawType, spawnedBy, projectDir, task, model, teamId } = req.body;
    const isOrch = rawType === 'orchestrator' || rawRole === 'orchestrator';
    const role = isOrch ? 'orchestrator' : (rawRole || 'coder');
    const type = isOrch ? 'orchestrator' : (rawType || 'worker');

    // Hướng A — gán teamId cho agent mới:
    // - Orchestrator mới (+ New Team): sinh teamId UUID MỚI → lịch sử chat riêng biệt với team cũ.
    // - Worker mới: kế thừa teamId của agent cha (spawnedBy) nếu có, ngược lại 'default'.
    const parentTeamId = spawnedBy ? (deps.agents.get(spawnedBy)?.teamId || 'default') : 'default';
    const newTeamId = isOrch ? (teamId || `team-${uuidv4().slice(0, 8)}`) : (teamId || parentTeamId);

    if (!isOrch) {
      // 1. Kiểm tra bất thường: nếu vượt trần TEAM thì tự động xóa bớt (per-team)
      await deps.autoPruneExcessAgents(role, newTeamId);

      // 1.0 Cổng check sống từ Team Settings live (đồng nhất với live-check endpoint)
      const createGate = deps.checkLiveSpawnGate(newTeamId, role);
      if (!createGate.canSpawn) {
        const gateMsg = `[ERROR: CREATE_LIVE_GATE] ${createGate.reason}`;
        console.warn(`[API /api/agents] ${gateMsg}`);
        return res.status(400).json({
          error: gateMsg,
          code: createGate.code,
          teamId: newTeamId,
          usage: createGate.usage
        });
      }

      // 1.1 Kiểm tra giới hạn tổng số thành viên trong 1 team (trần live từ Team Settings)
      const effectiveCreateTeamLimit = deps.getEffectiveTeamSizeLimit(newTeamId);
      const currentTeamAgents = deps.getAgentsByTeam(newTeamId);
      if (currentTeamAgents.length >= effectiveCreateTeamLimit) {
        const teamMemberList = currentTeamAgents.map(a => `${a.name} (${a.role}, id: ${a.id}, status: ${a.status})`).join(', ');
        const errorMsg = `[ERROR: CREATE_TEAM_LIMIT]
Lý do: Đã đạt giới hạn tối đa ${effectiveCreateTeamLimit} thành viên trong team '${newTeamId}' (hiện có ${currentTeamAgents.length}/${effectiveCreateTeamLimit} thành viên bao gồm cả Orchestrator: [${teamMemberList}]).
Không thể tạo thêm agent mới trong team này. Vui lòng tái sử dụng agent hiện có.`;
        console.warn(`[API /api/agents] ${errorMsg}`);
        const targetOrch = spawnedBy || 'orchestrator';
        const limitErrMsg = deps.forwardToOrchestrator('CREATE_TEAM_LIMIT', errorMsg, targetOrch, newTeamId);
        const limitErrMsgUser: any = {
          id: uuidv4(),
          from: targetOrch,
          to: 'user',
          content: `⚠️ Không thể tạo agent "${name}" (role: ${role}): Team '${newTeamId}' đã đạt tối đa ${effectiveCreateTeamLimit} thành viên (bao gồm cả Orchestrator).`,
          timestamp: Date.now(),
          agentName: deps.agents.get(targetOrch)?.name || 'Orchestrator',
          agentRole: 'orchestrator',
          teamId: newTeamId,
          msgType: 'error'
        };
        deps.chatHistory.push(limitErrMsgUser); deps.storage.saveMessage(limitErrMsgUser);
        deps.broadcast('chat:message', { msg: limitErrMsgUser });
        return res.status(400).json({
          error: errorMsg,
          code: 'CREATE_TEAM_LIMIT',
          teamId: newTeamId,
          currentMembers: currentTeamAgents.length,
          maxMembers: effectiveCreateTeamLimit
        });
      }

      // 2. Kiểm tra hạn mức role theo TEAM (trần live từ Team Settings)
      const roleLimit = deps.getEffectiveRoleLimit(role, newTeamId);
      const activeRoleAgents = deps.getAgentsByRole(role, newTeamId);

      if (activeRoleAgents.length >= roleLimit) {
        const existingListStr = activeRoleAgents.map(a => `${a.name} (${a.id})`).join(', ');
        const firstAgentId = activeRoleAgents[0]?.id || 'agent-id';
        const errorMsg = `[ERROR: CREATE_ROLE_LIMIT]
Lý do: Đã đạt giới hạn tối đa cho vai trò '${role}' trong team '${newTeamId}' (hiện có ${activeRoleAgents.length}/${roleLimit} active: [${existingListStr}]).
Cú pháp đúng: Tái sử dụng agent hiện có bằng cách gửi tin nhắn:
<talk target="${firstAgentId}">
Nội dung phân công nhiệm vụ mới tại đây
</talk>`;
        console.warn(`[API /api/agents] ${errorMsg}`);

        // Gửi tin nhắn lỗi về Orchestrator của team
        const targetOrch = spawnedBy || (Array.from(deps.agents.values()).find(a => a.teamId === newTeamId && (a.role === 'orchestrator' || a.type === 'orchestrator'))?.id) || 'orchestrator';
        const limitErrMsg = deps.forwardToOrchestrator('CREATE_ROLE_LIMIT', errorMsg, targetOrch, newTeamId);

        // Gửi tin nhắn lỗi về User
        const limitErrMsgUser: any = {
          id: uuidv4(),
          from: 'system',
          to: 'user',
          content: errorMsg,
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system',
          teamId: newTeamId
        };
        deps.chatHistory.push(limitErrMsgUser);
        deps.storage.saveMessage(limitErrMsgUser);
        deps.broadcast('chat:message', { msg: limitErrMsgUser });

        return res.status(400).json({ ok: false, error: errorMsg });
      }
    }

    // Tạm thời: mọi agent đều dùng cwd làm projectDir (tính năng prjDir sẽ thêm sau)
    const effectiveProjectDir = deps.projectRoot;
    const id = 'agent-' + uuidv4().slice(0, 8);
    const agent: any = {
      id, name: name || (isOrch ? `Orchestrator-${id.slice(-4)}` : `Agent-${id.slice(-4)}`), role,
      type, status: 'idle', spawnedBy, projectDir: effectiveProjectDir, task, model, teamId: newTeamId, createdAt: Date.now(), sessionId: undefined,
      tasks: task ? [{ id: '1', task, status: 'pending', createdAt: Date.now() }] : []
    };
    deps.agents.set(id, agent); deps.storage.saveAgent(agent);
    deps.broadcast('agent:created', { agent });
    deps.notifyTeamChanged(newTeamId); // per-team
    // Tạo tin nhắn đầu để user thấy ngay agent đã sẵn sàng
    const spawnMsg: any = {
      id: uuidv4(), from: 'system', to: id, teamId: newTeamId,
      content: `[SPAWN] Agent "${agent.name}" (${agent.role}) created and ready.${agent.task ? ` Task: ${agent.task}` : ''}`,
      timestamp: Date.now(), agentName: agent.name, agentRole: agent.role
    };
    deps.chatHistory.push(spawnMsg); deps.storage.saveMessage(spawnMsg);
    deps.broadcast('chat:message', { msg: spawnMsg });
    console.log(`[Spawn] ${agent.name} (${agent.role}) → ${id}`);
    res.json({ ok: true, agent });
  });

  // POST /api/agents/:id/start
  router.post('/:id/start', (req, res) => {
    const a = deps.agents.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    a.status = 'idle'; a.workingSince = undefined;
    deps.storage.updateAgent(a.id, { status: 'idle', workingSince: null });
    deps.broadcast('agent:updated', { agent: a });
    res.json({ ok: true });
  });

  // POST /api/agents/:id/stop
  router.post('/:id/stop', (req, res) => {
    const a = deps.agents.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    deps.stopAgent(a.id, 'user'); res.json({ ok: true });
  });

  // POST /api/agents/:id/resume
  router.post('/:id/resume', (req, res) => {
    const a = deps.agents.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!deps.resumeAgent(a.id)) return res.json({ ok: false, error: 'Agent not stopped' });
    res.json({ ok: true });
  });

  // POST /api/agents/:id/abort
  router.post('/:id/abort', (req, res) => {
    const id = req.params.id;

    // Idempotency guard: if already aborting this agent, return success immediately
    if (deps.abortingAgents.has(id)) {
      console.log(`[Abort] Agent ${id} already aborting, returning idempotent success`);
      return res.json({ ok: true, killed: false, idempotent: true });
    }

    // Orchestrator quản lý riêng (không trong agents map) — xử lý abort riêng
    if (id === 'orchestrator') {
      deps.abortingAgents.add(id);
      try {
        const client = deps.clients.get('orchestrator');
        const orch = deps.agents.get('orchestrator');
        const killed = client ? client.abort() : false;
        if (orch) {
          orch.status = 'idle';
          orch.workingSince = undefined;
          deps.storage.updateAgent('orchestrator', { status: 'idle', workingSince: null });
          deps.broadcast('agent:updated', { agent: orch });
        } else {
          deps.broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
        }
        res.json({ ok: true, killed });
      } catch (err: any) {
        console.error(`[Abort] Error aborting orchestrator:`, err);
        res.json({ ok: true, killed: false, warning: err.message });
      } finally {
        deps.abortingAgents.delete(id);
      }
      return;
    }

    const a = deps.agents.get(id);
    if (!a) return res.status(404).json({ ok: false, error: 'Not found' });

    deps.abortingAgents.add(id);
    try {
      const client = deps.clients.get(a.id);
      const killed = client ? client.abort() : false;
      a.status = 'idle';
      a.workingSince = undefined;
      deps.storage.updateAgent(a.id, { status: 'idle', workingSince: null });
      deps.broadcast('agent:updated', { agent: a });

      // Auto-drain backendUserQueues khi abort agent: gửi tiếp các tin đang chờ
      // và broadcast chat:queue:dispatched để UI xóa sạch khay hàng đợi
      const abortQueueKey = a.id;
      const pendingQueue = deps.backendUserQueues[abortQueueKey];
      if (pendingQueue && pendingQueue.length > 0) {
        const queuedMessageIds = pendingQueue.map(m => m.messageId).filter(Boolean);
        deps.backendUserQueues[abortQueueKey] = [];
        for (const qItem of pendingQueue) {
          try { deps.storage.saveUnprocessedMessage(abortQueueKey, qItem.rawMsg); } catch {}
        }
        deps.broadcast('chat:queue:dispatched', {
          targetAgentId: a.id,
          messageIds: queuedMessageIds,
          count: queuedMessageIds.length
        });
        for (const qItem of pendingQueue) {
          const dispatchedMsg: any = {
            id: qItem.messageId || uuidv4(),
            from: 'user',
            to: a.id,
            content: qItem.rawMsg,
            timestamp: Date.now(),
            teamId: a.teamId || 'default'
          };
          deps.chatHistory.push(dispatchedMsg);
          deps.storage.saveMessage(dispatchedMsg);
          deps.broadcast('chat:message', { msg: dispatchedMsg });
        }
        console.log(`[Abort] Auto-drained ${pendingQueue.length} queued messages for ${a.id}`);
      }

      res.json({ ok: true, killed });
    } catch (err: any) {
      console.error(`[Abort] Error aborting agent ${id}:`, err);
      res.json({ ok: true, killed: false, warning: err.message });
    } finally {
      deps.abortingAgents.delete(id);
    }
  });

  // DELETE /api/agents/:id
  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const exists = deps.agents.has(id) || deps.storage.getAgent(id);
    if (!exists) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }
    try {
      const deleted = await deps.deleteAgent(id);
      res.json({ ok: true, id, sessionDeleted: deleted });
    } catch (err: any) {
      console.error(`[API DELETE /api/agents/${id}] Error:`, err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  // PATCH /api/agents/:id — Update agent fields (model, name, task)
  router.patch('/:id', (req, res) => {
    const agentId = req.params.id;
    const agent = deps.agents.get(agentId);
    if (!agent) return res.status(404).json({ ok: false, error: 'Not found' });

    const { model, name, task } = req.body || {};
    if (model !== undefined) {
      agent.model = model || undefined;
      deps.storage.updateAgent(agentId, { model: model || null });
      if (agentId === 'orchestrator') {
        deps.storage.setSetting('orchestratorModel', model || null);
        if (model) process.env.ORCHESTRATOR_MODEL = model; else delete process.env.ORCHESTRATOR_MODEL;
      }
      const client = deps.clients.get(agentId);
      if (client) {
        const resolved = deps.resolveModelForAgent(agent);
        client.setModel(resolved || undefined);
      }
    }
    if (name !== undefined) {
      agent.name = name.trim().normalize('NFC');
      deps.storage.updateAgent(agentId, { name: agent.name } as any);
    }
    if (task !== undefined) {
      agent.task = deps.truncateTask(task.trim());
      deps.storage.updateAgent(agentId, { task: agent.task } as any);
      // KHÔNG notifyTeamChanged() ở đây — task content không phải member change
    }

    deps.broadcast('agent:updated', { agent });
    res.json({ ok: true, agent });
  });

  // Delete a specific task from an agent, persist to storage, and shift succeeding task IDs down by 1
  function handleDeleteAgentTask(req: Request, res: Response) {
    const agentId = req.params.id;
    const rawTaskId = req.params.taskId;
    const agent = deps.agents.get(agentId) || (deps.storage.getAgent(agentId) as any);
    if (!agent) {
      return res.status(404).json({ ok: false, error: 'Agent not found' });
    }

    // 1. Đồng bộ cấu trúc agent.tasks nếu mảng rỗng nhưng agent.task có nội dung
    if (!Array.isArray(agent.tasks) || agent.tasks.length === 0) {
      if (agent.task && typeof agent.task === 'string' && agent.task.trim()) {
        const lines = agent.task.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
        agent.tasks = lines.map((l: string, idx: number) => {
          const clean = l.replace(/^[-*•\d+.)#]\s*/, '').replace(/^#\d+\s*/, '').trim();
          return {
            id: String(idx + 1),
            task: clean || l,
            status: (agent.status === 'working' && idx === 0) ? 'working' : 'pending',
            createdAt: Date.now()
          };
        });
      } else {
        agent.tasks = [];
      }
    }

    if (agent.tasks.length === 0) {
      return res.status(404).json({ ok: false, error: 'Agent has no tasks to delete' });
    }

    // 2. Tìm index của task cần xóa (khớp theo task.id hoặc số thứ tự 1-based)
    const targetNum = parseInt(rawTaskId, 10);
    const removeIndex = agent.tasks.findIndex((t: any, idx: number) =>
      t.id === rawTaskId || (!isNaN(targetNum) && (t.id === String(targetNum) || idx + 1 === targetNum))
    );

    if (removeIndex === -1) {
      return res.status(404).json({ ok: false, error: `Task #${rawTaskId} not found` });
    }

    // Xóa phần tử task khỏi mảng
    const [removedTask] = agent.tasks.splice(removeIndex, 1);

    // Nếu tất cả task còn lại đều đã completed -> tự xóa sạch toàn bộ
    if (agent.tasks.length > 0 && agent.tasks.every((t: any) => t.status === 'completed')) {
      agent.tasks = [];
    } else {
      // QUAN TRỌNG: Các task sau đó sẽ LÙI SỐ ID VỀ 1 LẦN (re-index lại 1, 2, 3...)
      agent.tasks.forEach((t: any, idx: number) => {
        const newId = String(idx + 1);
        t.id = newId;
        // Nếu text của task có gắn tiền tố # cũ, cập nhật lại số mới
        if (/^#\d+\b/.test(t.task)) {
          t.task = t.task.replace(/^#\d+/, `#${newId}`);
        }
      });
    }

    // 4. Cập nhật lại agent.task và status
    if (agent.tasks.length === 0) {
      agent.task = '';
      if (agent.status === 'working') {
        agent.status = 'idle';
        agent.workingSince = undefined;
      }
    } else {
      // Ưu tiên task working -> pending -> task đầu tiên còn lại
      const activeTask = agent.tasks.find((t: any) => t.status === 'working')
        || agent.tasks.find((t: any) => t.status === 'pending')
        || agent.tasks[0];
      agent.task = activeTask.task;
    }

    // 5. Cập nhật vào database / storage
    deps.storage.updateAgent(agent.id, {
      task: agent.task,
      tasks: agent.tasks,
      status: agent.status,
      workingSince: agent.workingSince ?? null
    } as any);

    // Đảm bảo đồng bộ Map agents
    deps.agents.set(agent.id, agent);

    // 6. Broadcast sự kiện cập nhật realtime qua WebSocket
    deps.broadcast('agent:updated', { agent });

    console.log(`[Tasks] Deleted task #${rawTaskId} from agent ${agent.name} (${agent.id}). Remaining: ${agent.tasks.length} tasks (re-indexed 1..${agent.tasks.length}).`);

    return res.json({
      ok: true,
      deleted: removedTask,
      agent,
      tasks: agent.tasks
    });
  }

  router.delete('/:id/tasks/:taskId', handleDeleteAgentTask);
  router.post('/:id/tasks/:taskId/delete', handleDeleteAgentTask);

  // POST /api/agents/:id/model — Update agent model
  router.post('/:id/model', (req, res) => {
    const { model } = req.body || {};
    const agentId = req.params.id;
    const agent = deps.agents.get(agentId);
    if (!agent) return res.status(404).json({ error: 'Not found' });

    agent.model = model || undefined;
    deps.storage.updateAgent(agentId, { model: model || null });

    if (agentId === 'orchestrator') {
      deps.storage.setSetting('orchestratorModel', model || null);
      if (model) process.env.ORCHESTRATOR_MODEL = model; else delete process.env.ORCHESTRATOR_MODEL;
    }

    // If agent has a client, update its model too
    const client = deps.clients.get(agentId);
    if (client) {
      const resolved = deps.resolveModelForAgent(agent);
      client.setModel(resolved || undefined);
    }

    deps.broadcast('agent:updated', { agent });
    deps.broadcast('settings:updated', { models: deps.storage.getModelSettings() });
    res.json({ ok: true, model: agent.model });
  });

  // POST /api/agents/:id/clear — Clear worker agent conversation + session opencode
  router.post('/:id/clear', async (req, res) => {
    const agentId = req.params.id;
    const agent = deps.agents.get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    let sessionDeleted = false;
    let deleteError: string | null = null;
    try {
      const client = deps.clients.get(agentId);
      if (client) {
        const sid = client.getSessionId();
        if (sid) {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              sessionDeleted = await client.deleteSession(sid);
              if (sessionDeleted) break;
            } catch (delErr: any) {
              deleteError = delErr.message;
              console.log(`[Clear] Delete session attempt ${attempt + 1} failed for agent ${agentId}: ${delErr.message}`);
            }
          }
        }
      } else if (agent.sessionId) {
        try {
          const tmpClient = new ACPClient({ id: agentId, name: agent.name, role: agent.role, type: 'worker' });
          tmpClient.setSession(agent.sessionId);
          sessionDeleted = await tmpClient.deleteSession();
        } catch (delErr: any) {
          deleteError = delErr.message;
        }
      }

      deps.clients.delete(agentId);
      ACPClient.unregisterSession(agentId);
      deps.storage.updateAgent(agentId, { sessionId: null, sessionTitle: null });

      agent.sessionId = undefined;
      agent.sessionTitle = undefined;
      deps.broadcast('agent:updated', { agent });

      // Xoá hội thoại của agent này
      const keep: any[] = [];
      deps.chatHistory.forEach(msg => {
        const isAgentView = msg.from === agentId || msg.to === agentId;
        if (!isAgentView) keep.push(msg);
      });
      deps.chatHistory.length = 0;
      deps.chatHistory.push(...keep);
      deps.storage.clearAgentConversation(agentId);
      deps.broadcast('chat:message', { action: 'clear', agentId });

      res.json({ ok: true, sessionDeleted, warning: !sessionDeleted ? 'Session delete failed, local state cleared' : undefined });
    } catch (e: any) {
      deps.clients.delete(agentId);
      ACPClient.unregisterSession(agentId);
      deps.storage.updateAgent(agentId, { sessionId: null, sessionTitle: null });

      agent.sessionId = undefined;
      agent.sessionTitle = undefined;
      deps.broadcast('agent:updated', { agent });

      res.json({ ok: false, error: e.message });
    }
  });

  return router;
}
