import { WebSocketServer, WebSocket } from 'ws';

export interface WebSocketServiceOptions {
  heartbeatIntervalMs?: number;
}

export class WebSocketService {
  private wss: WebSocketServer;
  private wsClients: Set<WebSocket>;
  private heartbeatIntervalMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(wss: WebSocketServer, wsClients: Set<WebSocket>, options: WebSocketServiceOptions = {}) {
    this.wss = wss;
    this.wsClients = wsClients;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000;
  }

  public init(): void {
    this.wss.on('error', (err: any) => {
      console.error(`[WS] WebSocket server error:`, err?.message || err);
    });

    this.wss.on('connection', (ws: WebSocket, req: any) => {
      this.wsClients.add(ws);
      (ws as any)._isAlive = true;

      // Extract teamId from query params e.g. ws://host/?teamId=xyz
      try {
        if (req && req.url) {
          const urlObj = new URL(req.url, 'http://localhost');
          const tId = urlObj.searchParams.get('teamId');
          if (tId) (ws as any).teamId = tId;
        }
      } catch {}

      ws.on('message', (raw: any) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed && parsed.type === 'subscribe' && parsed.teamId) {
            (ws as any).teamId = parsed.teamId;
          }
        } catch {}
      });

      ws.on('pong', () => {
        (ws as any)._isAlive = true;
      });
      ws.on('close', () => this.wsClients.delete(ws));
      ws.on('error', () => {
        try {
          ws.terminate();
        } catch {}
      });
    });

    this.startHeartbeat();
  }

  public startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.wss.clients.forEach((c: any) => {
        if (c._isAlive === false) {
          try {
            c.terminate();
          } catch {}
          return;
        }
        c._isAlive = false;
        try {
          c.ping();
        } catch {}
      });
    }, this.heartbeatIntervalMs);
    (this.heartbeatTimer as any).unref?.();
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Broadcast payload tới tất cả kết nối WS hoặc có lọc theo teamId
   */
  public broadcast(type: string, data: any, filterTeamId?: string): void {
    const payload = JSON.stringify({ type, data, timestamp: Date.now() });
    for (const ws of this.wsClients) {
      if (ws.readyState === 1) { // WebSocket.OPEN = 1
        if (filterTeamId && (ws as any).teamId && (ws as any).teamId !== filterTeamId) {
          continue;
        }
        try {
          ws.send(payload);
        } catch {}
      }
    }
  }

  public getClientsCount(): number {
    return this.wsClients.size;
  }
}
