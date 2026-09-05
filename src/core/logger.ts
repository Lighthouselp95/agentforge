import type { SystemLogEntry } from '../storage.js';

// ============ TERMINAL LOG BUFFER (ring buffer) ============
// Lưu tối đa LOG_BUFFER_MAX dòng console.log/error của server process, phục vụ GET /logs
// và push realtime qua callback/listeners.
export const LOG_BUFFER_MAX = 5000;
export const logBuffer: string[] = [];

// Lazy storage ref to avoid TDZ: storage may not be fully initialized when
// pushLogLine is called during module bootstrap (console.log override fires).
let _storageRef: any = null;
function getStorage(): any {
    if (_storageRef !== null) return _storageRef;
    try { _storageRef = require('../storage.js').storage; } catch {}
    return _storageRef;
}

type LogListener = (entry: { level: 'info' | 'warn' | 'error' | 'debug'; message: string; line: string; timestamp: number }) => void;
const logListeners = new Set<LogListener>();

export function subscribeLog(listener: LogListener): () => void {
    logListeners.add(listener);
    return () => {
        logListeners.delete(listener);
    };
}

export function safeStringify(v: any): string {
    try { return JSON.stringify(v); } catch { return String(v); }
}

export function pushLogLine(rawArgs: any[], level: 'info' | 'warn' | 'error' | 'debug' = 'info'): string {
    const line = rawArgs.map(a => (typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : safeStringify(a)))).join(' ');
    const ts = new Date().toISOString();
    const formattedLine = `[${ts}] ${line}`;
    logBuffer.push(formattedLine);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
    
    // Trích xuất source tag nếu có (ví dụ [Server], [Storage], [Outbox], [Talk])
    const tagMatch = line.match(/^\[([a-zA-Z0-9_-]+)\]/);
    const source = tagMatch ? tagMatch[1].toLowerCase() : 'system';
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

export const originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
};

export function setupConsoleOverride(onLogPushed?: (level: 'info' | 'warn' | 'error', line: string) => void) {
    console.log = (...args: any[]) => {
        const line = pushLogLine(args, 'info');
        originalConsole.log(...args);
        if (onLogPushed) {
            try { onLogPushed('info', line); } catch {}
        }
    };

    console.error = (...args: any[]) => {
        const line = pushLogLine(args, 'error');
        originalConsole.error(...args);
        if (onLogPushed) {
            try { onLogPushed('error', line); } catch {}
        }
    };

    console.warn = (...args: any[]) => {
        const line = pushLogLine(args, 'warn');
        originalConsole.warn(...args);
        if (onLogPushed) {
            try { onLogPushed('warn', line); } catch {}
        }
    };
}

// Initialize lazy storage ref AFTER all module imports have resolved (avoids TDZ)
try { _storageRef = require('../storage.js').storage; } catch {}
