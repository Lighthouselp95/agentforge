// ============ GRANULAR RELAY & MESSAGING TYPES ============
import type { Agent } from '../core/agents.js';

export type SenderType = 'user' | 'orchestrator' | 'agent' | 'system';
export type TargetScope = 'user' | 'orchestrator' | 'agent' | 'broadcast' | 'team';

export interface RelayMessage<T = any> {
  id: string;
  from: string;
  to: string;
  senderType: SenderType;
  teamId: string;
  content: string;
  payload?: T;
  timestamp: number;
  task?: string;
  agentName?: string;
  agentRole?: string;
  msgType?: string;
}

export interface RelayRoutingResult {
  routed: boolean;
  targetId: string;
  targetScope: TargetScope;
  teamId: string;
  error?: string;
}

export interface ChatMsg {
  id: string;
  from: string;
  to: string;
  content: string;
  task?: string;
  timestamp: number;
  agentName?: string;
  agentRole?: string;
  teamId?: string;
  msgType?: string;
  showOnUI?: boolean;
  toolCalls?: Array<{ tool: string; input?: string; output?: string }>;
  thinking?: string;
  allowThinking?: boolean;
  parts?: Array<{ type: 'text' | 'tool' | 'thinking'; content?: string; tool?: string; input?: any; output?: any }>;
}

export interface RelayContext {
  getAgent: (id: string) => Agent | undefined;
  findAgent: (identifier: string) => Agent | undefined;
  findOrchestrator: (teamId?: string) => Agent | undefined;
  saveMessage: (msg: ChatMsg) => void;
  broadcast: (type: string, data: any) => void;
  chatHistory: ChatMsg[];
  getClient?: (agent: Agent) => any;
  getOrchClient?: (orchId: string) => any;
  buildTeamPrompt?: (targetAgentId: string) => string;
}

export interface EarlyDispatchResult {
  dispatched: boolean;
  targetId?: string;
  sig?: string;
}
