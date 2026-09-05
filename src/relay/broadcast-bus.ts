// ============ BROADCAST BUS ============
import type { WebSocket } from 'ws';
import type { Response } from 'express';

export type BroadcastHandler = (type: string, data: any) => void;

export class BroadcastBus {
  private wsClients: Set<WebSocket>;
  private sseClients: Set<Response>;
  private customListeners: Set<BroadcastHandler> = new Set();

  constructor(wsClients: Set<WebSocket> = new Set(), sseClients: Set<Response> = new Set()) {
    this.wsClients = wsClients;
    this.sseClients = sseClients;
  }

  public registerListener(fn: BroadcastHandler): () => void {
    this.customListeners.add(fn);
    return () => {
      this.customListeners.delete(fn);
    };
  }

  public broadcast(type: string, data: any): void {
    let broadcastTeamId = data?.teamId;
    if (!broadcastTeamId && data?.msg?.teamId) {
      broadcastTeamId = data.msg.teamId;
    }
    if (!broadcastTeamId && data?.agent?.teamId) {
      broadcastTeamId = data.agent.teamId;
    }

    const payload = { type, ...(broadcastTeamId ? { teamId: broadcastTeamId } : {}), ...data };
    const msg = JSON.stringify(payload);

    // WebSocket broadcast với team filter
    this.wsClients.forEach(ws => {
      try {
        if (ws.readyState === 1) { // OPEN
          const wsTeam = (ws as any).teamId;
          if (wsTeam && broadcastTeamId && wsTeam !== broadcastTeamId) {
            return;
          }
          ws.send(msg);
        }
      } catch {}
    });

    // SSE broadcast với team filter
    const sseData = `data: ${msg}\n\n`;
    this.sseClients.forEach(res => {
      try {
        const sseTeam = (res as any).teamId;
        if (sseTeam && broadcastTeamId && sseTeam !== broadcastTeamId) {
          return;
        }
        res.write(sseData);
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      } catch {
        this.sseClients.delete(res);
      }
    });

    // Custom listeners
    this.customListeners.forEach(fn => {
      try {
        fn(type, payload);
      } catch {}
    });
  }
}
