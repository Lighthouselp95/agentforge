import { Router } from 'express';
import { join } from 'path';
import { spawn } from 'child_process';

export interface SystemRouteDeps {
  appVersion: string;
  port: number;
  serverStartTime: number;
  sseClients: Set<any>;
  wsClients: Set<any>;
  agents: Map<string, any>;
  storage: any;
  logBuffer: string[];
}

export function createSystemRouter(deps: SystemRouteDeps): Router {
  const router = Router();

  // GET /api/server-info
  router.get('/server-info', (_req, res) => {
    res.json({
      serverStartTime: deps.serverStartTime,
      uptimeMs: Date.now() - deps.serverStartTime,
      cwd: process.cwd(),
      version: deps.appVersion
    });
  });

  // GET /api/logs
  router.get('/logs', (req, res) => {
    const { level, source, agentId, limit, beforeId } = req.query;
    const logs = deps.storage.getLogs({
      level: typeof level === 'string' ? level : undefined,
      source: typeof source === 'string' ? source : undefined,
      agentId: typeof agentId === 'string' ? agentId : undefined,
      limit: typeof limit === 'string' ? parseInt(limit, 10) : undefined,
      beforeId: typeof beforeId === 'string' ? beforeId : undefined,
    });
    res.json({ logs, count: logs.length });
  });

  // POST /api/logs/clear
  router.post('/logs/clear', (_req, res) => {
    deps.storage.clearLogs();
    deps.logBuffer.length = 0;
    res.json({ success: true, message: 'Logs cleared successfully' });
  });

  // POST /api/restart — Restart Server Endpoint (Detached Spawn), dời verbatim từ server.ts
  router.post('/restart', (_req, res) => {
    res.json({ success: true, message: 'Restarting AgentForge server...' });
    setTimeout(() => {
      try {
        const batPath = join(process.cwd(), 'start.bat');
        const isWin = process.platform === 'win32';
        const child = spawn(
          isWin ? 'cmd.exe' : 'sh',
          isWin ? ['/c', batPath] : ['-c', 'npm start'],
          {
            detached: true,
            stdio: 'ignore',
            cwd: process.cwd()
          }
        );
        child.unref();
      } catch (e: any) {
        console.error('[Restart] Failed to spawn restart process:', e);
      }
      process.exit(0);
    }, 500);
  });

  return router;
}
