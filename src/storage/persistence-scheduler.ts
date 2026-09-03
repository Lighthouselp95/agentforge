import { copyFileSync, existsSync } from 'fs';
import { STATE_FILE, BAK_FILE } from './paths.js';
import { atomicWriteFile } from './atomic-disk.js';
import type { StorageSchema } from './types.js';

export class PersistenceScheduler {
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  public isDirty = false;
  public isWriting = false;

  constructor(private getState: () => StorageSchema) {}

  public schedulePersist(delayMs = 100): void {
    this.isDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushSync();
    }, delayMs);
  }

  public flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.isDirty) return;

    this.isWriting = true;
    try {
      const state = this.getState();
      const payload = JSON.stringify(state, null, 2);

      // Backup current file first
      if (existsSync(STATE_FILE)) {
        try { copyFileSync(STATE_FILE, BAK_FILE); } catch {}
      }

      atomicWriteFile(STATE_FILE, payload);
      this.isDirty = false;
    } catch (e: any) {
      console.error('[PersistenceScheduler] Failed to write state:', e.message);
    } finally {
      this.isWriting = false;
    }
  }
}
