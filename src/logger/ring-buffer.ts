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

export function pushLogLine(rawArgs: any[], level: 'info' | 'warn' | 'error' | 'debug' = 'info'): string {
  const line = rawArgs.map(a => (typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : safeStringify(a)))).join(' ');
  const ts = new Date().toISOString();
  const formattedLine = `[${ts}] ${line}`;
  logBuffer.push(formattedLine);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
  
  const source = extractLogSourceTag(line);
  try {
    storage.saveLog({
      level,
      source,
      message: line
    });
  } catch {}

  const now = Date.now();
  for (const listener of logListeners) {
    try {
      listener({ level, message: line, line: formattedLine, timestamp: now });
    } catch {}
  }

  return formattedLine;
}
