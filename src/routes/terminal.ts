import { Router } from 'express';

export interface TerminalRouteDeps {
  storage: any;
  logBuffer: string[];
  maxLogBuffer: number;
}

export function createTerminalRouter(deps: TerminalRouteDeps): Router {
  const router = Router();

  // GET /logs - Ring buffer console logs
  router.get('/logs', (_req, res) => {
    res.json({ lines: [...deps.logBuffer], max: deps.maxLogBuffer, count: deps.logBuffer.length });
  });

  // GET /terminal - realtime viewer HTML
  router.get('/terminal', (_req, res) => {
    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>agentforge — terminal</title>
<style>
  * { box-sizing: border-box; }
  html, body { height:100%; margin:0; background:#090d14; color:#d4d6d9; font-family:'JetBrains Mono','Consolas','Menlo','Courier New',monospace; font-size:12.5px; }
  #bar { position:sticky; top:0; display:flex; align-items:center; justify-content:space-between; padding:6px 12px; background:#0e131d; color:#94a3b8; border-bottom:1px solid rgba(255,255,255,0.08); user-select:none; z-index:10; }
  #bar b { color:#38bdf8; font-weight:700; }
  #actions { display:flex; align-items:center; gap:8px; }
  #cnt { font-size:11px; color:#64748b; }
  .btn-clear { background:rgba(239,68,68,0.15); border:1px solid rgba(239,68,68,0.35); color:#f87171; border-radius:4px; padding:2px 8px; font-size:11px; font-weight:600; cursor:pointer; font-family:inherit; }
  .btn-clear:hover { background:rgba(239,68,68,0.25); color:#fca5a5; }
  #log { padding:10px 14px; white-space:pre-wrap; word-break:break-all; line-height:1.55; }
</style>
</head>
<body>
  <div id="bar">
    <div><b>AgentForge Terminal</b> <span id="cnt">0 lines</span></div>
    <div id="actions"><button class="btn-clear" onclick="clearLogs()">Clear</button></div>
  </div>
  <div id="log">Connecting...</div>
  <script>
    async function loadLogs() {
      try {
        const res = await fetch('/logs');
        const data = await res.json();
        document.getElementById('log').textContent = data.lines.join('\\n');
        document.getElementById('cnt').textContent = data.lines.length + ' lines';
      } catch (e) {
        document.getElementById('log').textContent = 'Failed to load logs: ' + e.message;
      }
    }
    async function clearLogs() {
      await fetch('/api/logs/clear', { method: 'POST' });
      document.getElementById('log').textContent = '';
      document.getElementById('cnt').textContent = '0 lines';
    }
    loadLogs();
  </script>
</body>
</html>`;
    res.type('html').send(html);
  });

  return router;
}
