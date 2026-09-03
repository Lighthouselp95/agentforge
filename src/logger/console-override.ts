import { pushLogLine } from './ring-buffer.js';

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
