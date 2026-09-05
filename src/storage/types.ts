export interface OutboxReport {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  fromAgentRole: string;
  teamId?: string; // teamId của agent gửi — dùng khi replay để không giao nhầm team
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

// ============ TEAM SETTINGS (live per-team limits, editable via UI/API) ============
export interface TeamSettings {
  /** Max tasks chưa hoàn thành trên 1 agent (default 6, khớp MAX_AGENT_TASKS cũ). */
  taskLimit: number;
  /** Trần số agent theo từng role trong team. Role không liệt kê → fallback 1 (khớp getRoleLimit cũ). */
  agentLimits: Record<string, number>;
  /** Max tổng thành viên trong 1 team, tính cả Orchestrator (default 6, khớp MAX_TEAM_SIZE cũ). */
  maxTeamSize: number;
  /** Max số role phân biệt trong 1 team (default 12 — generous, không phá vỡ team hiện tại). */
  maxRoles: number;
}

export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  taskLimit: 6,
  agentLimits: { coder: 4, researcher: 2 },
  maxTeamSize: 6,
  maxRoles: 12
};

export interface SpawnGateUsage {
  teamSize: number;
  roleCount: number;
  distinctRoles: number;
  roleExists: boolean;
}

export interface SpawnGateResult {
  canSpawn: boolean;
  reason: string;
  code: 'OK' | 'TEAM_LIMIT' | 'ROLE_LIMIT' | 'ROLES_LIMIT';
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
