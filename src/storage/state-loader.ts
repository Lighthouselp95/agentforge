import { existsSync, readFileSync, copyFileSync } from 'fs';
import { STATE_FILE, BAK_FILE } from './paths.js';
import type { StorageSchema } from './types.js';

export function validateSchema(data: any): StorageSchema | null {
  if (!data || typeof data !== 'object') return null;
  return {
    agents: Array.isArray(data.agents) ? data.agents : [],
    history: Array.isArray(data.history) ? data.history : [],
    settings: (data.settings && typeof data.settings === 'object') ? data.settings : {},
    outbox: Array.isArray(data.outbox) ? data.outbox : [],
    chatQueue: Array.isArray(data.chatQueue) ? data.chatQueue : [],
    logs: Array.isArray(data.logs) ? data.logs : [],
    unprocessedUserMessages: (data.unprocessedUserMessages && typeof data.unprocessedUserMessages === 'object')
      ? data.unprocessedUserMessages
      : (data.unprocessedMessages && typeof data.unprocessedMessages === 'object' ? data.unprocessedMessages : {})
  };
}

export function parseStateContent(raw: string): StorageSchema | null {
  try {
    const parsed = JSON.parse(raw);
    return validateSchema(parsed);
  } catch {
    return null;
  }
}

export function loadStateFromDisk(): StorageSchema {
  if (existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, 'utf-8');
      const data = parseStateContent(raw);
      if (data) return data;
    } catch {
      // Failed to read state file, proceed to backup
    }
  }

  if (existsSync(BAK_FILE)) {
    try {
      const raw = readFileSync(BAK_FILE, 'utf-8');
      const data = parseStateContent(raw);
      if (data) {
        try { copyFileSync(BAK_FILE, STATE_FILE); } catch {}
        return data;
      }
    } catch {}
  }

  return {
    agents: [],
    history: [],
    settings: {},
    outbox: [],
    chatQueue: [],
    logs: [],
    unprocessedUserMessages: {}
  };
}
