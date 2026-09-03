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
    const payload = { type, ...data };
    const msg = JSON.stringify(payload);

    // WebSocket broadcast
    this.wsClients.forEach(ws => {
      try {
        if (ws.readyState === 1) { // OPEN
          ws.send(msg);
        }
      } catch {}
    });

    // SSE broadcast
    const sseData = `data: ${msg}\n\n`;
    this.sseClients.forEach(res => {
      try {
        res.write(sseData);
        if (typeof (res as any).flush === 'function') {
          (res as any).flush();
        }
      } catch {
        this.sseClients.delete(res);
      }
    });

    // Custom listeners
    for (const listener of this.customListeners) {
      try {
        listener(type, data);
      } catch {}
    }
  }
}
