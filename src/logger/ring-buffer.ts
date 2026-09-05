import { storage } from '../storage.js';
import { safeStringify, extractLogSourceTag } from './log-formatter.js';

export const LOG_BUFFER_MAX = 5000;
export const logBuffer: string[] = [];

export type LogListener = (entry: { level: 'info' | 'warn' | 'error' | 'debug'; message: string; line: string; timestamp: number }) => void;
const logListeners = new Set<LogListener>();

export function subscribeLog(listener: LogListener): () => void {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

// Lazy storage ref to avoid TDZ: storage is imported at top-level but `pushLogLine`
// may be called DURING module evaluation (when console.log override fires).
let storageRef: any = null;
function getStorage(): any {
  if (storageRef !== null) return storageRef;
  try { storageRef = require('../storage.js').storage; } catch {}
  return storageRef;
}

export function pushLogLine(rawArgs: any[], level: 'info' | 'warn' | 'error' | 'debug' = 'info'): string {
  const line = rawArgs.map(a => (typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : safeStringify(a)))).join(' ');
  const ts = new Date().toISOString();
  const formattedLine = `[${ts}] ${line}`;
  logBuffer.push(formattedLine);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  
  const source = extractLogSourceTag(line);
  try {
    const stor = getStorage();
    if (stor) {
      stor.saveLog({
        level,
        source,
        message: line
      });
    }
  } catch {}

  const now = Date.now();
  for (const listener of logListeners) {
    try {
      listener({ level, message: line, line: formattedLine, timestamp: now });
    } catch {}
  }

  return formattedLine;
}

// Initialize lazy storage ref AFTER module imports have resolved
storageRef = require('../storage.js').storage;
