export interface OutboxReport {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  fromAgentRole: string;
  to: string; // 'orchestrator' hoặc agent id
  message: string;
  createdAt: number;
  attempts: number;
  // ACK-based state machine: pending → in_flight → delivered | failed → (retrying qua backoff).
  // 'delivered' CHỈ đặt khi client.enqueue/deliverTalk THÀNH CÔNG (client ACK).
  status: 'pending' | 'in_flight' | 'delivered' | 'failed';
  lastError?: string;
  // Thời điểm sớm nhất được phép retry (epoch ms) — dùng cho trạng thái 'failed' (backoff).
  nextAttemptAt?: number;
}

export interface ChatQueueItem {
  id: string;
  targetAgentId: string; // '' hoặc 'orchestrator' nghĩa là gửi cho Orchestrator
  rawMsg: string;
  isSlashCommand: boolean;
  attempts: number;
  nextAttemptAt: number; // epoch ms: thời điểm sớm nhất được phép retry
  createdAt: number;
  lastError?: string;
}

export interface SystemLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  agentId?: string;
  agentName?: string;
  message: string;
  data?: any;
}

export interface StorageSchema {
  agents: any[];
  history: any[];
  settings?: Record<string, any>;
  outbox?: OutboxReport[];
  chatQueue?: ChatQueueItem[];
  unprocessedUserMessages?: Record<string, string[]>;
  logs?: SystemLogEntry[];
}

export interface HistoryPageOptions {
  limit?: number;
  beforeId?: string | number;
  agentId?: string;
  teamId?: string;
}

export interface LogFilterOptions {
  level?: string;
  source?: string;
  agentId?: string;
  limit?: number;
  beforeId?: string;
}

export interface ModelSettings {
  orchestratorModel: string | null;
  defaultSubagentModel: string | null;
  agentModelOverrides: Record<string, string>;
}

export interface UpdateAgentOptions {
  status?: string;
  sessionId?: string | null;
  sessionTitle?: string | null;
  model?: string | null;
  workingSince?: number | null;
  tokenUsage?: any;
  contextLength?: number | null;
  task?: string;
  tasks?: any[];
  teamId?: string;
  spawnedBy?: string;
}
