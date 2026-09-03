// Agent types — Orchestrator + Worker Agents + Communication
export type AgentType = 'orchestrator' | 'worker';
export type AgentStatus = 'idle' | 'working' | 'error' | 'stopped';
export type AgentRole = 'coder' | 'reviewer' | 'tester' | 'docs' | 'planner' | string;

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  role: AgentRole;
  model?: string;
  projectDir?: string;
  systemPrompt?: string;
  spawnedBy?: string; // parent orchestrator/agent id
  sessionId?: string;
}

export interface AgentMessage {
  id: string;
  from: string; // agent id
  to: string;   // agent id or 'user' or 'orchestrator'
  content: string;
  timestamp: number;
  taskId?: string;
  transcript?: string; // full JSONL transcript: tool calls + text, nguyen van 1 luot
}

export interface Task {
  id: string;
  description: string;
  assignedTo?: string;
  assignedBy?: string;
  status: 'pending' | 'assigned' | 'working' | 'completed' | 'failed';
  result?: string;
}

export interface AgentState {
  config: AgentConfig;
  status: AgentStatus;
  running: boolean;
  tasks: Task[];
  messages: AgentMessage[];
}
