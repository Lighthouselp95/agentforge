import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { join } from 'path';
import { spawn } from 'child_process';
import { countRealTasks } from '../storage/agent-storage.js';

// Pha 1 refactor: toàn bộ HTTP handlers /api/history, /api/messages, /api/chat,
// /api/chat/force-send dời verbatim từ src/server.ts. Mount tại `/` của /api
// (giữ nguyên full path /api/history, /api/chat...). dispatchUserChat giữ lại
// trong server.ts (domain function) và inject qua deps.
export interface ChatRouteDeps {
  agents: Map<string, any>;
  storage: any;
  broadcast: (type: string, data: any) => void;
  clients: Map<string, any>;
  chatHistory: any[];
  backendUserQueues: Record<string, any[]>;
  findAgentByIdNameOrRole: (identifier: string, preferredTeamId?: string) => any;
  isOrchestratorLike: (agent: any) => boolean;
  getOrchClient: (orchId: string) => any;
  getClient: (agent: any) => any;
  normalizeQueueKey: (targetId?: string) => string;
  drainDispatchState: (agentId: string) => void;
  updateOrchStateSafe: (orchId: string, status: 'idle' | 'working' | 'error', taskDesc?: string) => void;
  isRetriableError: (err: any) => boolean;
  getEffectiveTaskLimit: (teamId?: string) => number;
  dispatchUserChat: (params: { targetAgentId: string; rawMsg: string; isSlashCommand: boolean; isRetry?: boolean }) => Promise<{ response: string; sid: string | null; commands: string[] }>;
}

export function createChatRouter(deps: ChatRouteDeps): Router {
  const router = Router();

  // GET /api/history (hỗ trợ lọc theo teamId, agentId, limit, beforeId)
  router.get('/history', (req, res) => {
    // Pagination support: ?limit=N (mặc định 200, tối đa 1000) & ?beforeId=<msgId> (tin nhắn cũ hơn id này) & ?agentId=<id> & ?teamId=<id>
    const qLimit = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : undefined;
    const qBeforeId = req.query.beforeId !== undefined ? String(req.query.beforeId) : undefined;
    const qAgentId = req.query.agentId !== undefined ? String(req.query.agentId) : undefined;
    const qTeamId = req.query.teamId !== undefined ? String(req.query.teamId) : undefined;
    // Phương án 1: khi client chỉ gửi agentId (không gửi teamId) → server tự resolve teamId từ agent
    // trong agents map để lọc history theo đúng team của agent đó → tách cross-team triệt để (worker
    // team cũ / tin team khác không lẫn), KHÔNG cần sửa App.tsx client.
    let teamFilter: string | undefined = qTeamId;
    if (qAgentId && teamFilter === undefined) {
      const agent = deps.agents.get(qAgentId);
      if (agent) teamFilter = agent.teamId || 'default';
    }
    const history = deps.storage.getHistoryPage({
      limit: Number.isFinite(qLimit) ? qLimit : undefined,
      beforeId: qBeforeId,
      agentId: qAgentId,
      teamId: teamFilter
    });
    // Fix interleave 6.44 (rework 6.33): khi trả history về client, GIỮ text + tool trong parts cho mọi
    // snapshot opencode (msgType==='opencode') để sau restart/reconnect vẫn render xen kẽ đúng thứ tự.
    // Chỉ guard bỏ entry null — KHÔNG lọc text. Dedup với canonical reply do client xử lý (agent view
    // lọc reply trùng nội dung khi đã có snapshot interleave; Khối 2/3 ẩn khi hasParts).
    const sanitized = history.map((m: any) => {
      if (m && m.msgType === 'opencode' && Array.isArray(m.parts)) {
        return { ...m, parts: m.parts.filter((p: any) => p && (p.type === 'tool' || p.type === 'text' || p.type === 'thinking')) };
      }
      return m;
    });
    res.json(sanitized);
  });

  // GET /api/messages
  router.get('/messages', (req, res) => {
    const qTeamId = req.query.teamId as string | undefined;
    if (qTeamId) {
      const filtered = deps.chatHistory.filter(m => (m.teamId || 'default') === qTeamId);
      return res.json(filtered);
    }
    res.json(deps.chatHistory);
  });

  // POST /api/chat
  router.post('/chat', async (req, res) => {
    let resolvedTargetId = '';
    let targetAgent: any | null = null;
    let rawMsg = '';
    let isSlashCommand = false;

    try {
      const { message, targetAgentId, agentId } = req.body || {};
      resolvedTargetId = targetAgentId || agentId || '';
      targetAgent = (resolvedTargetId && resolvedTargetId !== 'orchestrator') ? (deps.agents.get(resolvedTargetId) || deps.findAgentByIdNameOrRole(resolvedTargetId) || null) : null;

      rawMsg = (message || '').toString().trim().normalize('NFC');
      if (!rawMsg) {
        return res.status(400).json({ ok: false, error: 'Message cannot be empty' });
      }

      // Trần task list (đếm task giao việc THẬT, loại trừ tin nhắn user thường):
      // full thật → từ chối ngay, queued:false, KHÔNG tạo backendUserQueues entry, KHÔNG dispatch.
      if (targetAgent && Array.isArray(targetAgent.tasks)) {
        const chatTaskLimit = deps.getEffectiveTaskLimit(targetAgent.teamId);
        if (countRealTasks(targetAgent.tasks) >= chatTaskLimit) {
          console.log(`[TaskLimit] POST /api/chat rejected: ${targetAgent.name} task list full (${countRealTasks(targetAgent.tasks)}/${chatTaskLimit} real tasks).`);
          return res.json({ ok: false, queued: false, error: `Agent task list full (${chatTaskLimit} tasks) — cannot deliver new task until slot freed`, code: 'TASK_LIMIT_EXCEEDED', targetAgentId: targetAgent.id });
        }
      }

      const targetTeamId = targetAgent?.teamId || req.body?.teamId || 'default';
      const isTargetOrch = !targetAgent || deps.isOrchestratorLike(targetAgent) || targetAgent.id === 'orchestrator' || resolvedTargetId === 'orchestrator';
      const targetIdKey = targetAgent ? targetAgent.id : (resolvedTargetId || 'orchestrator');
      const targetStatus = targetAgent?.status || (isTargetOrch ? deps.agents.get('orchestrator')?.status || 'idle' : 'idle');
      const targetClient = isTargetOrch ? deps.getOrchClient(targetIdKey) : (targetAgent ? deps.getClient(targetAgent) : null);
      const isTargetBusy = targetStatus === 'working' || (targetClient?.isBusy() ?? false);

      const clientMessageId = (req.body?.messageId || req.body?.id || '').toString().trim();
      const userMsg: any = {
        id: clientMessageId || uuidv4(),
        from: 'user',
        to: resolvedTargetId || 'orchestrator',
        content: rawMsg,
        timestamp: Date.now(),
        teamId: targetTeamId,
        isQueued: isTargetBusy
      };

      // Nếu agent đích KHÔNG bận: ghi nhận và broadcast ngay lập tức vào khung chat
      if (!isTargetBusy) {
        deps.chatHistory.push(userMsg);
        deps.storage.saveMessage(userMsg);
        deps.broadcast('chat:message', { msg: userMsg });
      }

      isSlashCommand = rawMsg.startsWith('/');

      // Xử lý riêng lệnh /restart để khởi động lại máy chủ
      if (rawMsg.toLowerCase() === '/restart') {
        const restartTeamId = req.body?.teamId || targetAgent?.teamId || 'default';
        const restartMsg: any = {
          id: uuidv4(),
          from: 'system',
          to: 'user',
          content: '🔄 Đang khởi động lại AgentForge server...',
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system',
          teamId: restartTeamId
        };
        deps.chatHistory.push(restartMsg);
        deps.storage.saveMessage(restartMsg);
        deps.broadcast('chat:message', { msg: restartMsg, teamId: restartTeamId });

        res.json({ ok: true, result: 'Restarting AgentForge server...' });

        setTimeout(() => {
          try {
            const batPath = join(process.cwd(), 'start.bat');
            const isWin = process.platform === 'win32';
            const child = spawn(
              isWin ? 'cmd.exe' : 'sh',
              isWin ? ['/c', batPath] : ['-c', 'npm start'],
              { detached: true, stdio: 'ignore', cwd: process.cwd() }
            );
            child.unref();
          } catch (err) {
            console.error('[Restart] Error spawning start.bat:', err);
          }
          process.exit(0);
        }, 500);
        return;
      }

      // Xử lý thông báo tức thời cho lệnh /compact (chỉ kích hoạt khi là lệnh đứng độc lập)
      if (/^\s*\/compact\s*$/i.test(rawMsg)) {
        const isOrch = !targetAgent || targetAgent.id === 'orchestrator' || resolvedTargetId === 'orchestrator';
        const targetName = isOrch ? 'Orchestrator' : (targetAgent ? targetAgent.name : 'Agent');
        const targetId = isOrch ? (resolvedTargetId || 'orchestrator') : (targetAgent ? targetAgent.id : resolvedTargetId);
        const compactTeamId = req.body?.teamId || targetAgent?.teamId || (isOrch ? deps.agents.get(targetId)?.teamId : undefined) || 'default';

        const compactNotice: any = {
          id: uuidv4(),
          from: 'system',
          to: targetId,
          content: `⚡ Đang gửi lệnh /compact chính thức tới session của ${targetName}...`,
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system',
          teamId: compactTeamId
        };
        deps.chatHistory.push(compactNotice);
        deps.storage.saveMessage(compactNotice);
        deps.broadcast('chat:message', { msg: compactNotice, teamId: compactTeamId });

        try {
          const client = isOrch ? deps.getOrchClient(targetId) : (targetAgent ? deps.getClient(targetAgent) : null);
          const sid = client?.getSessionId() || targetAgent?.sessionId || (isOrch ? deps.agents.get('orchestrator')?.sessionId : undefined);
          if (!sid) {
            const errMsg: any = {
              id: uuidv4(),
              from: 'system',
              to: 'user',
              content: `⚠️ Không thể thực hiện /compact: ${targetName} chưa có sessionId đang hoạt động.`,
              timestamp: Date.now(),
              agentName: 'System',
              agentRole: 'system',
              teamId: compactTeamId
            };
            deps.chatHistory.push(errMsg); deps.storage.saveMessage(errMsg);
            deps.broadcast('chat:message', { msg: errMsg, teamId: compactTeamId });
            if (!res.headersSent) res.json({ ok: false, error: 'no_active_session' });
            return;
          }

          const ok = client ? await client.compactSession(sid) : false;
          const doneMsg: any = {
            id: uuidv4(),
            from: 'system',
            to: 'user',
            content: ok
              ? `✅ Đã gửi lệnh /compact chính thức tới session ${sid}.`
              : `❌ Gửi lệnh /compact tới session ${sid} thất bại hoặc không thể kết nối OpenCode Serve.`,
            timestamp: Date.now(),
            agentName: 'System',
            agentRole: 'system',
            teamId: compactTeamId
          };
          deps.chatHistory.push(doneMsg); deps.storage.saveMessage(doneMsg);
          deps.broadcast('chat:message', { msg: doneMsg, teamId: compactTeamId });
          if (!res.headersSent) res.json({ ok, sessionId: sid, compacted: ok });
          return;
        } catch (err: any) {
          const failMsg: any = {
            id: uuidv4(),
            from: 'system',
            to: 'user',
            content: `❌ Lỗi /compact: ${err?.message || err}`,
            timestamp: Date.now(),
            agentName: 'System',
            agentRole: 'system',
            msgType: 'error',
            teamId: compactTeamId
          };
          deps.chatHistory.push(failMsg); deps.storage.saveMessage(failMsg);
          deps.broadcast('chat:message', { msg: failMsg, teamId: compactTeamId });
          if (!res.headersSent) res.json({ ok: false, error: err?.message || 'compact_failed' });
          return;
        }
      }

      // Nếu agent đích đang bận (status working hoặc client isBusy):
      // Đưa tin nhắn vào hàng đợi backendUserQueues, lưu tin nhắn vào DB/history để UI vẫn thấy, và phản hồi { ok: true, queued: true }
      if (isTargetBusy) {
        // Validate trước enqueue/persist: rawMsg + targetId phải hợp lệ; teamId resolve đúng
        // từ targetAgent (không persist khi thiếu) — giữ nguyên auto-continue.
        if (!rawMsg || !rawMsg.trim() || !targetIdKey) {
          return res.status(400).json({ ok: false, error: 'Message or target is empty' });
        }
        const enqueueTeamId = targetAgent?.teamId || deps.agents.get(resolvedTargetId)?.teamId || req.body?.teamId || 'default';
        userMsg.teamId = enqueueTeamId;
        if (!deps.backendUserQueues[targetIdKey]) {
          deps.backendUserQueues[targetIdKey] = [];
        }
        deps.backendUserQueues[targetIdKey].push({
          targetId: targetIdKey,
          rawMsg,
          isSlash: isSlashCommand,
          messageId: userMsg.id,
          timestamp: userMsg.timestamp
        });
        // Lưu xuống đĩa cứng để sống sót qua crash / restart
        deps.storage.saveUnprocessedMessage(targetIdKey, rawMsg);
        console.log(`[BackendQueue] Target ${targetIdKey} is busy (status: ${targetStatus}). Queued message (queue length: ${deps.backendUserQueues[targetIdKey].length}, timestamp: ${userMsg.timestamp}). Persisted to disk.`);
        return res.json({ ok: true, queued: true, messageId: userMsg.id, message: 'Message queued in server for execution as soon as agent becomes idle.' });
      }

      const { response, sid, commands: commandResults } = await deps.dispatchUserChat({ targetAgentId: targetIdKey, rawMsg, isSlashCommand, isRetry: false });
      if (!res.headersSent) {
        res.json({ ok: true, response, sessionId: sid, commands: commandResults });
      }
    } catch (err: any) {
      // Lỗi backend (LLM) sập / mạng → lưu queue disk, tự gửi lại khi backend sống
      if (deps.isRetriableError(err)) {
        if (!rawMsg || !rawMsg.trim() || !resolvedTargetId) {
          if (!res.headersSent) res.status(400).json({ ok: false, error: 'Message or target is empty' });
          return;
        }
        const id = uuidv4();
        deps.storage.enqueueChatRetry({
          id,
          targetAgentId: resolvedTargetId,
          rawMsg,
          isSlashCommand,
          attempts: 0,
          nextAttemptAt: Date.now() + 5000,
          createdAt: Date.now(),
          lastError: err?.message || String(err)
        });
        const retryTeamId = targetAgent?.teamId || deps.agents.get(resolvedTargetId)?.teamId || req.body?.teamId || 'default';
        const qMsg: any = {
          id: uuidv4(),
          from: 'system',
          to: 'user',
          content: `⏳ Tin nhắn của bạn đã được lưu và sẽ tự động gửi lại khi backend (LLM) sẵn sàng: "${rawMsg.slice(0, 100)}${rawMsg.length > 100 ? '...' : ''}"`,
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system',
          teamId: retryTeamId
        };
        deps.chatHistory.push(qMsg); deps.storage.saveMessage(qMsg);
        deps.broadcast('chat:message', { msg: qMsg, teamId: retryTeamId });
        if (!res.headersSent) res.json({ ok: true, queued: true, message: 'saved for retry when backend is available' });
        return;
      }

      // Lỗi thường (không retry): kiểm tra nếu là lỗi abort thì KHÔNG broadcast tin lỗi ra UI
      const isAbortError = err?.message && /agent operation aborted by user|aborted by user/i.test(err.message);
      const errorText = `❌ Error: ${err.message || 'Model execution or request failed'}`;
      const fromId = targetAgent ? targetAgent.id : (resolvedTargetId || 'orchestrator');

      if (!isAbortError) {
        const errorMsg: any = {
          id: uuidv4(),
          from: fromId,
          to: 'user',
          content: errorText,
          timestamp: Date.now(),
          agentName: targetAgent ? targetAgent.name : 'Orchestrator',
          agentRole: targetAgent ? targetAgent.role : 'orchestrator',
          msgType: 'error',
          teamId: targetAgent?.teamId || deps.agents.get(fromId)?.teamId || 'default'
        };
        deps.chatHistory.push(errorMsg);
        deps.storage.saveMessage(errorMsg);
        deps.broadcast('chat:message', { msg: errorMsg });
      } else {
        console.log(`[Chat] Suppressed user-visible error for aborted turn: ${err.message}`);
      }

      if (targetAgent) {
        targetAgent.status = isAbortError ? 'idle' : 'error';
        targetAgent.workingSince = undefined;
        deps.storage.updateAgent(targetAgent.id, { status: targetAgent.status, workingSince: null });
        deps.broadcast('agent:updated', { agent: targetAgent });
      } else {
        const orchAgent = deps.agents.get('orchestrator');
        if (orchAgent) {
          orchAgent.status = 'idle';
          deps.storage.updateAgent('orchestrator', { status: 'idle' });
          deps.broadcast('agent:updated', { agent: orchAgent });
        } else {
          deps.broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
        }
      }
      if (!res.headersSent) {
        res.json({ ok: false, error: err.message, response: isAbortError ? undefined : errorText, aborted: isAbortError });
      }
    }
  });

  // POST /api/chat/force-send
  router.post('/chat/force-send', async (req, res) => {
    let resolvedTargetId = '';
    let targetAgent: any | null = null;
    let rawMsg = '';
    try {
      const { message, content, targetAgentId, agentId, mode, messageId } = req.body || {};
      resolvedTargetId = targetAgentId || agentId || 'orchestrator';
      targetAgent = (resolvedTargetId && resolvedTargetId !== 'orchestrator')
        ? (deps.agents.get(resolvedTargetId) || deps.findAgentByIdNameOrRole(resolvedTargetId) || null)
        : null;

      const isOrch = !targetAgent || targetAgent.id === 'orchestrator' || resolvedTargetId === 'orchestrator';
      const targetName = isOrch ? 'Orchestrator' : (targetAgent ? targetAgent.name : 'Agent');
      const targetId = isOrch ? 'orchestrator' : (targetAgent ? targetAgent.id : resolvedTargetId);
      const targetIdKey = deps.normalizeQueueKey(targetId);
      const targetTeamId = targetAgent?.teamId || req.body?.teamId || 'default';

      const client = isOrch ? deps.getOrchClient('orchestrator') : (targetAgent ? deps.getClient(targetAgent) : null);
      if (!client) {
        return res.status(400).json({ ok: false, error: `Client not found for ${targetId}` });
      }

      // 0. Xử lý mode: 'single' (bốc 1 tin cụ thể) hoặc 'all' (bốc toàn bộ hàng đợi)
      const queue = deps.backendUserQueues[targetIdKey] || [];
      let promptToSend = ((content || message) || '').toString().trim().normalize('NFC');

      if (mode === 'all') {
        // Bốc toàn bộ hàng đợi của targetIdKey
        if (queue.length > 0) {
          // Gom theo đúng thứ tự thời gian timestamp
          const sorted = [...queue].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          const combined = sorted.map((q, idx) => `[Message ${idx + 1} lúc ${new Date(q.timestamp).toLocaleTimeString()}]:\n${q.rawMsg}`).join('\n\n');
          promptToSend = promptToSend ? `${promptToSend}\n\n${combined}` : combined;
          // Xoá sạch toàn bộ hàng đợi
          deps.backendUserQueues[targetIdKey] = [];
        }
      } else {
        // mode === 'single' (mặc định)
        // Bốc duy nhất tin nhắn tương ứng (theo messageId hoặc nội dung)
        if (messageId && queue.length > 0) {
          deps.backendUserQueues[targetIdKey] = queue.filter(q => q.messageId !== messageId);
        } else if (promptToSend && queue.length > 0) {
          const foundIdx = queue.findIndex(q => q.rawMsg === promptToSend);
          if (foundIdx !== -1) {
            queue.splice(foundIdx, 1);
          }
        }
      }

      rawMsg = promptToSend;
      if (!rawMsg) {
        return res.status(400).json({ ok: false, error: 'Message content or queue is empty' });
      }

      // 1. Can thiệp ngắt tiến trình đang chạy (nếu có)
      let wasAborted = false;
      try {
        wasAborted = client.abort();
      } catch (e: any) {
        console.warn(`[ForceSend] Error aborting client for ${targetId}:`, e?.message || e);
      }

      // Vòng lặp chờ an toàn để Windows kill sạch process con và OpenCode nhả file lock SQLite
      const abortStart = Date.now();
      while (client.isBusy() && Date.now() - abortStart < 2500) {
        await new Promise(r => setTimeout(r, 50));
      }

      // Xóa sạch bộ đệm rác cũ để không gộp chéo tin cũ khi spawn lượt mới
      deps.storage.clearUnprocessedMessages(targetIdKey);
      client.clearUnprocessedPrompts();

      // 2. Dọn dẹp dispatch buffers & cập nhật trạng thái
      if (isOrch) {
        deps.drainDispatchState(targetId);
        deps.updateOrchStateSafe(targetId, 'working', `⚡ Can thiệp gửi ngay: ${rawMsg.slice(0, 50)}...`);
      } else if (targetAgent) {
        targetAgent.status = 'working';
        targetAgent.workingSince = Date.now();
        deps.storage.updateAgent(targetAgent.id, { status: 'working', workingSince: Date.now() });
        deps.broadcast('agent:updated', { agent: targetAgent });
      }

      // 3. Thông báo can thiệp lên Chat
      const noticeMsg: any = {
        id: uuidv4(),
        from: 'system',
        to: 'user',
        content: mode === 'all'
          ? `⚡ Đã ngắt lượt trước của ${targetName} và gom toàn bộ tin trong hàng đợi để "Gửi ngay".`
          : `⚡ Đã ngắt lượt trước của ${targetName} theo lệnh "Gửi ngay" và bắt đầu thực thi ngay.`,
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system',
        teamId: targetTeamId
      };
      deps.chatHistory.push(noticeMsg);
      deps.storage.saveMessage(noticeMsg);
      deps.broadcast('chat:message', { msg: noticeMsg });

      // 4. Lưu User message vào lịch sử & DB nếu chưa có
      const userMsg: any = {
        id: messageId || uuidv4(),
        from: 'user',
        to: targetId,
        content: rawMsg,
        timestamp: Date.now(),
        teamId: targetTeamId
      };
      deps.chatHistory.push(userMsg);
      deps.storage.saveMessage(userMsg);
      deps.broadcast('chat:message', { msg: userMsg });

      // Trả response ngay cho client để UI không chờ
      res.json({ ok: true, aborted: wasAborted, targetId, mode: mode || 'single' });

      // 5. Spawn tiến trình mới chạy đúng nội dung gửi ngay thông qua dispatchUserChat
      deps.dispatchUserChat({
        targetAgentId: targetId,
        rawMsg,
        isSlashCommand: rawMsg.startsWith('/'),
        isRetry: false
      }).catch(err => {
        const isAbort = err?.message && /agent operation aborted by user|aborted by user/i.test(err.message);
        if (isAbort) {
          console.log(`[ForceSend] Ignored abort error from previous run or cancellation: ${err.message}`);
          return;
        }
        console.error(`[ForceSend] Error in dispatchUserChat for ${targetId}:`, err);
        // Cập nhật trạng thái error và thông báo nếu là lỗi thực sự khác abort
        if (targetAgent) {
          targetAgent.status = 'error';
          targetAgent.workingSince = undefined;
          deps.storage.updateAgent(targetAgent.id, { status: 'error', workingSince: null });
          deps.broadcast('agent:updated', { agent: targetAgent });
        } else if (isOrch) {
          deps.updateOrchStateSafe(targetId, 'idle', 'Sẵn sàng');
        }
        const failNotice: any = {
          id: uuidv4(),
          from: targetId,
          to: 'user',
          content: `❌ Lỗi khi thực thi "Gửi ngay": ${err?.message || err}`,
          timestamp: Date.now(),
          agentName: targetName,
          agentRole: isOrch ? 'orchestrator' : (targetAgent?.role || 'worker'),
          msgType: 'error',
          teamId: targetTeamId
        };
        deps.chatHistory.push(failNotice);
        deps.storage.saveMessage(failNotice);
        deps.broadcast('chat:message', { msg: failNotice });
      });

    } catch (err: any) {
      console.error('[ForceSend] Handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err?.message || 'Force send failed' });
      }
    }
  });

  return router;
}
