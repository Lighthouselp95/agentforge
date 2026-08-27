// Agent types — Orchestrator + Worker Agents + Communication
export type AgentType = 'orchestrator' | 'worker';
export type AgentStatus = 'idle' | 'working' | 'error' | 'stopped';
export type AgentRole = 'coder' | 'reviewer' | 'tester' | 'docs' | 'planner' | string;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  contextLength?: number;
  input?: number;
  output?: number;
  total?: number;
  contextLimit?: number;
}

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
  tokenUsage?: TokenUsage;
  contextLength?: number;
}

// Thông tin một lần gọi tool của agent — lấy từ event tool_use GỐC của opencode
// (không phải từ chuỗi transcript nối chung) để UI render có cấu trúc.
export interface ToolCallInfo {
  tool: string;
  input?: string;
  output?: string;
}

// Thông tin toolcall cấu trúc lấy từ event gốc của opencode (KHÔNG phải text nối chung)
export interface ToolCallInfo {
  tool: string;
  input?: string;
  output?: string;
}

// Cấu trúc toolcall gốc lấy từ event tool_use của opencode (KHÔNG qua text nối transcript)
export interface ToolCallInfo {
  tool: string;
  input?: string;
  output?: string;
}

export interface AgentMessage {
  id: string;
  from: string; // agent id
  to: string;   // agent id or 'user' or 'orchestrator'
  content: string;
  timestamp: number;
  taskId?: string;
  transcript?: string; // full JSONL transcript: tool calls + text, nguyen van 1 luot
  sessionTitle?: string; // Title from OpenCode session/title event
  tokenUsage?: TokenUsage;
  contextLength?: number;
  toolCalls?: ToolCallInfo[]; // toolcall có cấu trúc từ event gốc — nguồn cho UI
  thinking?: string; // suy nghĩ nội bộ của model (reasoning/thinking), tách khỏi content
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
