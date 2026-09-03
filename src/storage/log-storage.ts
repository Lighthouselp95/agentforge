import type { StorageEngine } from './engine.js';
import type { SystemLogEntry, LogFilterOptions } from './types.js';
import { MAX_LOGS_ENTRIES } from './constants.js';

export class LogStorage {
  constructor(private engine: StorageEngine) {}

  saveLog(entry: Omit<SystemLogEntry, 'id' | 'timestamp'> & { id?: string; timestamp?: number }): SystemLogEntry {
    const fullEntry: SystemLogEntry = {
      id: entry.id || `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: entry.timestamp || Date.now(),
      level: entry.level || 'info',
      source: entry.source || 'system',
      agentId: entry.agentId,
      agentName: entry.agentName,
      message: entry.message || '',
      data: entry.data
    };
    this.engine.inMemoryLogs.push(fullEntry);
    if (this.engine.inMemoryLogs.length > MAX_LOGS_ENTRIES) {
      this.engine.inMemoryLogs.splice(0, this.engine.inMemoryLogs.length - MAX_LOGS_ENTRIES);
    }
    this.engine.schedulePersist();
    return fullEntry;
  }

  getLogs(opts: LogFilterOptions = {}): SystemLogEntry[] {
    let list = this.engine.inMemoryLogs;
    if (opts.level) {
      const lvl = opts.level.toLowerCase();
      list = list.filter(l => (l.level || '').toLowerCase() === lvl);
    }
    if (opts.source) {
      const src = opts.source.toLowerCase();
      list = list.filter(l => (l.source || '').toLowerCase() === src);
    }
    if (opts.agentId) {
      list = list.filter(l => l.agentId === opts.agentId);
    }
    if (opts.beforeId) {
      const idx = list.findIndex(l => l.id === opts.beforeId);
      if (idx > 0) list = list.slice(0, idx);
      else if (idx === 0) return [];
    }
    const lim = Math.max(1, Math.min(opts.limit ?? 200, MAX_LOGS_ENTRIES));
    return list.slice(-lim);
  }

  clearLogs(): void {
    this.engine.inMemoryLogs = [];
    this.engine.schedulePersist();
  }
}
