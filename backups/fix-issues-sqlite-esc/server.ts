// AgentForge v7 — Multi-Agent Orchestrator (run transport)
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { ACPClient } from './agents/acp-client.js';
import { storage } from './storage.js';

const __dirname = dirname(fileURLToPath(new URL('.', import.meta.url)));
const PORT = parseInt(process.env.PORT || '3001');
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.json());
// CORS — allow Vite dev server
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ============ PROMPT LOADING ============
// Use process.cwd() for reliability across tsx/node/esm contexts
const PROMPTS_DIR = join(process.cwd(), 'src', 'prompts');

function loadPrompt(name: string): string {
  const path = join(PROMPTS_DIR, name);
  if (!existsSync(path)) {
    console.warn(`[Prompt] Not found: ${path}, using fallback`);
    return '';
  }
  return readFileSync(path, 'utf-8');
}

const ORCH_PROMPT = loadPrompt('orchestrator.md') || `You are the Main Orchestrator of AgentForge. You manage a team of coding agents to complete software tasks.

=== YOUR IDENTITY ===
You are the Orchestrator. Your role: analyze tasks, decompose into subtasks, spawn specialist agents, monitor progress, and report results.

=== AVAILABLE ROLES ===
- coder: writes and modifies code
- tester: writes and runs tests
- reviewer: reviews code quality
- docs: writes documentation
- planner: analyzes and creates implementation plans
- researcher: finds information, reads docs, explores codebases
- verifier: validates code correctness and checks implementations
- debugger: traces bugs, finds root causes, fixes issues
- searcher: finds files, code patterns, and references in codebase
- idea: generates creative ideas, features, solutions, and improvements (brainstorming)

=== COMMANDS YOU CAN USE ===
You MUST use these exact tags in your response:

1. SPAWN — Create a new agent:
   [SPAWN role=<role> name=<name> task=<specific task description>]

2. TALK — Send message to an existing agent:
   [TALK agent-id=<agent-id> message=<your message>]

3. STOP — Stop a stuck agent:
   [STOP AGENT target-id=<agent-id>]

4. RESUME — Resume a stopped agent:
   [RESUME AGENT target-id=<agent-id>]
5. DELETE — Permanently remove an agent (must STOP first):
   [DELETE AGENT target-id=<agent-id>]

6. CREATE ROLE — Create a new custom agent role with a .md prompt file:
   [CREATE ROLE name=<role-name> description=<what this role does> capabilities=<cap1,cap2,cap3> rules=<rule1|rule2|rule3>]
   After creating, you can [SPAWN role=<role-name> ...] to use it.
   Rules are separated by | (pipe). Capabilities are separated by , (comma).

=== RULES ===
1. ALWAYS decompose user tasks into specific subtasks before spawning
2. Each SPAWN must have: role, name (short lowercase), task (specific with file paths)
3. Run independent tasks in parallel (spawn multiple agents at once)
4. Each agent name = 1 unique agent ID. If you SPAWN a name that already exists, the agent is REUSED (keeps ID + session + context). The old agent gets a new task.
5. If you want a fresh agent, you must [STOP] + [DELETE] the old one first, then SPAWN a new one
6. Spawning limit restrictions are completely removed. The Orchestrator has full autonomy to spawn as many specialized agents as needed to complete the task efficiently.
7. RESEARCH FIRST RULE: Before implementing any changes, fixing bugs, or writing code, you MUST first research the codebase, read the relevant files, check documentation, or search online resources to gather context and understand the implementation details.
8. Monitor progress — if an agent works > 3 minutes, use TALK to ask for status
9. If an agent is stuck, STOP it then RESUME with clearer instructions
10. When all agents report back, summarize results to the user
11. NEVER do the coding work yourself — delegate to specialist agents
12. If existing roles don't fit, CREATE ROLE first, then SPAWN with it
13. Use existing roles first — only CREATE ROLE when necessary

=== EXAMPLES ===
User: "Build a Python calculator with tests"
You respond with:
[SPAWN role=coder name=calc task=Create calculator.py with add(a,b), subtract(a,b), multiply(a,b), divide(a,b) functions. Add type validation and division by zero handling.]
[SPAWN role=tester name=test task=Create test_calculator.py with unit tests for all calculator functions. Test edge cases: type errors, division by zero, negative numbers.]

=== REPORT FORMAT ===
When agents finish, they report:
=== TASK REPORT ===
AGENT_ID: <id>
STATUS: completed
FILES: <list of files changed>
WHAT I DID: <summary>
=== END REPORT ===

Summarize all reports to the user in a clear, concise way.`;

const ORCH_REMINDER = `\n\n=== SYSTEM REMINDER ===
You are the Orchestrator. You MUST communicate with workers using:
[SPAWN role=<role> name=<name> task=<task>]
[TALK agent-id=<agent-id> message=<message>]
[STOP AGENT target-id=<agent-id>]
[RESUME AGENT target-id=<agent-id>]
[DELETE AGENT target-id=<agent-id>]

Always decompose tasks before spawning. Do NOT do the work yourself. Respond to the user in a clear, concise way.`;

const WORKER_BASE = loadPrompt('worker-base.md') || '';

function buildWorkerPrompt(role: string, agent: Agent): string {
  const rolePrompt = loadPrompt(join('roles', `${role}.md`)) || '';
  const base = WORKER_BASE || `\n\n=== SYSTEM REMINDER ===
You are a worker agent. Do your work directly using OpenCode tools.
To communicate with other agents or report to the orchestrator, you MUST use:
[TO: <target-id>] <your message>

When you finish the task, output:
[TO: orchestrator] Task complete.
=== TASK REPORT ===
AGENT_ID: <your-id>
STATUS: completed
WHAT I DID: <summary>
=== END REPORT ===`;
  return `${base}\n\n${rolePrompt}\n\n${WORKER_FORMAT_BLOCK}`;
}

// ============ STATE ============
interface Agent {
  id: string; name: string; role: string; type: 'orchestrator' | 'worker';
  status: 'idle' | 'working' | 'error' | 'stopped';
  spawnedBy?: string; projectDir?: string; model?: string;
  sessionId?: string; sessionTitle?: string; task?: string; createdAt: number;
  workingSince?: number;
}
interface ChatMsg {
  id: string; from: string; to: string; content: string;
  timestamp: number; agentName?: string; agentRole?: string;
  msgType?: string;
}

const agents = new Map<string, Agent>();
const clients = new Map<string, ACPClient>();
const chatHistory: ChatMsg[] = [];
const wsClients = new Set<WebSocket>();

// Track unread messages for orchestrator — workers reply to orchestrator
const unreadForOrchestrator: ChatMsg[] = [];

// Prevent duplicate synthesis when multiple agents complete simultaneously
const synthesisTriggered = new Set<string>();

// Max chat history to prevent unbounded memory growth
const MAX_HISTORY = 1000;

// ============ WORKER WATCHDOG ============
// Agent timeout thresholds (ms)
const AGENT_WORK_TIMEOUT_MS = parseInt(process.env.AGENTFORGE_WORK_TIMEOUT || '180000', 10); // 3 min default
const AGENT_STALE_CHECK_INTERVAL_MS = 30000; // Check every 30s
const MAX_RETRIES_PER_TASK = 2; // Max auto-retries per task

// Track per-agent retry counts
const agentRetryCount = new Map<string, number>();

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

// ============ CUSTOM ROLES ============
const AGENTS_DIR = join(process.cwd(), '.opencode', 'agents');
const CUSTOM_ROLES_PATH = join(process.cwd(), 'data', 'custom-roles.json');

interface CustomRole {
  name: string;
  description: string;
  capabilities: string[];
  rules: string[];
  createdAt: number;
}
const customRoles = new Map<string, CustomRole>();

function generateAgentMd(role: CustomRole): string {
  return `---
description: ${role.description}
mode: primary
permission:
  "*": allow
  "task": deny
  "plan_enter": deny
  "plan_exit": deny
---

# Role: ${role.name}

You are an AgentForge ${role.name} agent.

## What you do
${role.capabilities.map(c => `- ${c}`).join('\n')}

## Rules
${role.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

## Communication
Use ONLY [TO: <target-id>] <message> for all messages. Never spawn subagents via OpenCode.
`;
}

function createCustomRole(name: string, description: string, capabilities: string[], rules: string[]): boolean {
  const role: CustomRole = { name, description, capabilities, rules, createdAt: Date.now() };
  customRoles.set(name, role);
  try {
    const md = generateAgentMd(role);
    writeFileSync(join(AGENTS_DIR, `${name}.md`), md, 'utf-8');
    const all = Array.from(customRoles.values());
    writeFileSync(CUSTOM_ROLES_PATH, JSON.stringify(all, null, 2), 'utf-8');
    return true;
  } catch (e: any) {
    console.log(`[CreateRole] ${e.message}`);
    return false;
  }
}

function loadCustomRoles() {
  try {
    if (!existsSync(AGENTS_DIR)) {
      mkdirSync(AGENTS_DIR, { recursive: true });
    }
    // Write/overwrite orchestrator agent definition to ensure opencode uses the correct system prompt
    const orchMd = `---
description: Main Orchestrator of AgentForge
mode: primary
permission:
  "*": allow
---

# Role: orchestrator

${ORCH_PROMPT}
`;
    writeFileSync(join(AGENTS_DIR, 'orchestrator.md'), orchMd, 'utf-8');
    console.log('[Storage] Synchronized orchestrator agent definition');

    if (existsSync(CUSTOM_ROLES_PATH)) {
      const all = JSON.parse(readFileSync(CUSTOM_ROLES_PATH, 'utf-8')) as CustomRole[];
      all.forEach(r => customRoles.set(r.name, r));
      console.log(`[Storage] Loaded ${all.length} custom roles`);
    }
  } catch (e: any) { console.log(`[Storage] Custom roles load error: ${e.message}`); }
}

// ============ LOAD STATE ON STARTUP ============
function loadState() {
  try {
    const savedAgents = storage.loadAgents() as any[];
    const sessionEntries: Array<{ agentId: string; sessionId: string }> = [];
    for (const row of savedAgents) {
      const agent: Agent = {
        id: row.id, name: row.name, role: row.role, type: row.type,
        status: row.status === 'working' ? 'idle' : row.status,
        spawnedBy: row.spawned_by, projectDir: row.project_dir, model: row.model,
        // CHỈ restore sessionId cho ORCHESTRATOR — worker agents KHÔNG restore
        // để tránh cross-contamination session stale/deleted sau restart
        sessionId: row.type === 'orchestrator' ? (row.session_id || undefined) : undefined,
        sessionTitle: row.session_title || undefined,
        task: row.task,
        createdAt: row.created_at, workingSince: undefined
      };
      agents.set(agent.id, agent);
      // Collect session entries for restoring agentSessions static map (CHỈ orchestrator)
      if (row.type === 'orchestrator' && row.session_id && row.id) {
        sessionEntries.push({ agentId: row.id, sessionId: row.session_id });
      }
    }
    // Restore ACPClient.agentSessions map — chỉ orchestrator
    ACPClient.restoreAgentSessions(sessionEntries);
    if (!agents.has('orchestrator')) {
      const orch: Agent = {
        id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator',
        status: 'idle', createdAt: Date.now()
      };
      agents.set('orchestrator', orch);
      storage.saveAgent(orch);
    }
    console.log(`[Storage] Loaded ${savedAgents.length} agents, restored ${sessionEntries.length} orchestrator sessions`);
    const savedHistory = storage.loadHistory(500) as any[];
    for (const row of savedHistory) {
      chatHistory.push({
        id: row.id, from: row.from_id, to: row.to_id, content: row.content,
        timestamp: row.timestamp, agentName: row.agent_name, agentRole: row.agent_role,
        msgType: row.msg_type || 'chat'
      });
    }
    console.log(`[Storage] Loaded ${savedHistory.length} messages`);
  } catch (e: any) { console.log(`[Storage] Load error: ${e.message}`); }
}

function broadcast(type: string, data: any) {
  const msg = JSON.stringify({ type, ...data });
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

/** Get and consume unread messages for orchestrator */
function consumeUnreadForOrchestrator(): ChatMsg[] {
  const msgs = [...unreadForOrchestrator];
  unreadForOrchestrator.length = 0;
  return msgs;
}

/** Add a message to orchestrator's unread queue */
function addUnreadForOrchestrator(msg: ChatMsg) {
  // Chỉ thêm tin từ workers gửi tới orchestrator (không phải từ user hay system)
  if (msg.to === 'orchestrator' && msg.from !== 'orchestrator' && msg.from !== 'user' && msg.from !== 'system') {
    unreadForOrchestrator.push(msg);
  }
}

// Lưu transcript nguyên văn 1 lượt làm việc của agent (tool calls + text) thành message riêng
function saveTranscript(result: any, fromId: string, agentName?: string, agentRole?: string) {
  if (!result?.transcript) return;
  // Transcript là chi tiết công việc của agent → hiện trong khung chat của AGENT, KHÔNG vào khung main/orchestrator
  const tMsg: ChatMsg = { id: uuidv4(), from: fromId, to: fromId, content: result.transcript, timestamp: Date.now(), agentName, agentRole, msgType: 'transcript' };
  chatHistory.push(tMsg); storage.saveMessage(tMsg);
  broadcast('chat:message', { msg: tMsg });
}

// Validate worker response contains proper completion format
function validateWorkerCompletion(content: string, agent: Agent): { valid: boolean; reason?: string } {
  if (!content || content.trim().length === 0) {
    return { valid: false, reason: 'Empty response' };
  }
  // Check for proper completion format: [TO: orchestrator] + TASK REPORT
  const hasToOrchestrator = /\[TO:\s*orchestrator\]/i.test(content);
  const hasTaskReport = /=== TASK REPORT ===/i.test(content);
  const hasStatus = /STATUS:\s*completed/i.test(content);
  
  if (!hasToOrchestrator) {
    return { valid: false, reason: 'Missing [TO: orchestrator] tag - response not directed to orchestrator' };
  }
  if (!hasTaskReport || !hasStatus) {
    return { valid: false, reason: 'Missing TASK REPORT format (STATUS: completed, AGENT_ID, WHAT I DID)' };
  }
  return { valid: true };
}

// Called when worker agent successfully completes - clear retry tracking
function clearAgentRetry(agentId: string) {
  agentRetryCount.delete(agentId);
}

// Đồng bộ title session opencode → Agent (tiêu đề khung chat)
// Retry up to 3 lần nếu title chưa sẵn sàng (opencode có thể tạo title async)
async function syncSessionTitle(agent: Agent, client: ACPClient, retries = 3) {
  const sid = client.getSessionId();
  if (!sid) return;
  if (sid === agent.sessionId && agent.sessionTitle) return;
  for (let attempt = 0; attempt < retries; attempt++) {
    const title = await client.getSessionTitle(sid);
    if (title) {
      agent.sessionTitle = title;
      agent.sessionId = sid;
      ACPClient.registerSession(agent.id, sid);
      storage.updateAgent(agent.id, { sessionId: sid, sessionTitle: title });
      broadcast('agent:updated', { agent });
      return;
    }
    // Title chưa sẵn sàng — chờ rồi thử lại (0.5s, 1s, 2s — nhanh hơn)
    if (attempt < retries - 1) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 500));
    }
  }
  // Vẫn cập nhật sessionId kể cả không lấy được title (tránh mất session)
  if (!agent.sessionId) {
    agent.sessionId = sid;
    ACPClient.registerSession(agent.id, sid);
    storage.updateAgent(agent.id, { sessionId: sid });
  }
}

function getClient(agent: Agent): ACPClient {
  if (!clients.has(agent.id)) {
    // Agent không chọn model → kế thừa model của main (ORCHESTRATOR_MODEL) nếu có
    const model = agent.model || process.env.ORCHESTRATOR_MODEL;
    const c = new ACPClient({ id: agent.id, name: agent.name, role: agent.role, type: 'worker', projectDir: agent.projectDir, model });
    clients.set(agent.id, c);
  }
  const client = clients.get(agent.id)!;
  if (agent.sessionId && client.getSessionId() !== agent.sessionId) {
    client.setSession(agent.sessionId);
  }
  return client;
}

// ============ TEAM CONTEXT ============
// Khối định dạng bắt buộc cho worker — dạy agent cách route tin nhắn qua tag [TO:]
// Worker không được tự SPAWN; báo cáo về main bằng [TO: orchestrator]
const WORKER_FORMAT_BLOCK = `
=== RESPONSE FORMAT (MANDATORY) ===
End your reply with one or more routing lines, each on its own line:
[TO: <target-id>] <message for that target>
- To report your result to the Main Orchestrator, you MUST end with: [TO: orchestrator] <concise report>
- To message another agent, use its exact ID from the Members list.
- NEVER spawn subagents. Only the Orchestrator spawns.
====================================`;

function buildTeam(agentId: string, full: boolean = false): string {
  const self = agents.get(agentId);
  const isOrchestrator = self?.type === 'orchestrator' || agentId === 'orchestrator';
  const others = Array.from(agents.values()).filter(a => {
    if (a.id === agentId) return false;
    if (isOrchestrator || full) return true;
    return a.status === 'working' || a.status === 'error';
  });
  const suffix = isOrchestrator ? '' : WORKER_FORMAT_BLOCK;
  const lines: string[] = [];
  if (self) {
    lines.push(`Your ID: ${self.id}`);
    lines.push(`Your name: ${self.name}`);
    lines.push(`Your role: ${self.role}`);
    if (self.task) lines.push(`Your task: ${self.task}`);
  }
  if (others.length === 0) {
    lines.push(isOrchestrator ? 'No agents spawned yet.' : 'No other agents are currently active.');
    return lines.join('\n') + suffix;
  }
  const roleCounts: Record<string, number> = {};
  others.forEach(a => { roleCounts[a.role] = (roleCounts[a.role] || 0) + 1; });
  lines.push(`\nTeam: ${others.length} agents — ${Object.entries(roleCounts).map(([r,c]) => `${c}x ${r}`).join(', ')}`);
  lines.push('\nMembers:');
  others.forEach(a => {
    const wt = a.workingSince ? ` (${Math.round((Date.now() - a.workingSince) / 1000)}s working)` : '';
    const taskInfo = a.task ? ` | Task: ${a.task}` : '';
    lines.push(`  - ${a.name} (${a.role}) [${a.status}]${taskInfo}${wt} | ID: ${a.id}`);
  });
  return lines.join('\n') + suffix;
}

// ============ STOP/RESUME/DELETE ============
function stopAgent(id: string): boolean {
  const a = agents.get(id);
  if (!a || a.status === 'stopped') return false;
  // Abort process thật sự nếu agent đang chạy (kill opencode tree) — tránh mồ côi
  const client = clients.get(id);
  if (client) {
    try { client.abort(); } catch {}
  }
  a.status = 'stopped'; a.workingSince = undefined;
  clients.delete(a.id);
  storage.updateAgent(a.id, { status: 'stopped', workingSince: null });
  broadcast('agent:updated', { agent: a });
  console.log(`[Stop] ${a.name} (${a.id})`);
  return true;
}

function resumeAgent(id: string): boolean {
  const a = agents.get(id);
  if (!a || a.status !== 'stopped') return false;
  a.status = 'idle';
  storage.updateAgent(a.id, { status: 'idle' });
  broadcast('agent:updated', { agent: a });
  console.log(`[Resume] ${a.name} (${a.id})`);
  // Tự động gửi TIẾP công việc còn dở sau khi resume (không để agent đứng im chờ)
  setTimeout(() => {
    resumeAgentWork(a).catch(e => console.log(`[Resume] ${a.name} work error: ${e.message}`));
  }, 300);
  return true;
}

async function resumeAgentWork(agent: Agent) {
  try {
    const client = getClient(agent);
    const team = buildTeam(agent.id);
    const resumeMsg = `=== RESUME WORK ===
You were stopped mid-task. Continue and COMPLETE this task:
${agent.task || 'Continue your previous work.'}

Finish with:
[TO: orchestrator] Task complete.
=== TASK REPORT ===
AGENT_ID: ${agent.id}
STATUS: completed
WHAT I DID: <summary>
=== END REPORT ===`;
    const prompt = agent.sessionId
      ? `[TEAM UPDATE]\n${team}\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (orchestrator)\nTO: ${agent.name} (${agent.id})\n=== MESSAGE ===\n${resumeMsg}`
      : `[TASK] ${agent.task || 'General task'}\n[TEAM]\n${team}\n[/TEAM]\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator\nTO: ${agent.name} (${agent.id})\n=== MESSAGE ===\n${resumeMsg}`;
    const result = await client.enqueue(`${prompt}\n\n${buildWorkerPrompt(agent.role, agent)}`);
    agent.sessionId = client.getSessionId() || agent.sessionId;
    if (agent.sessionId) ACPClient.registerSession(agent.id, agent.sessionId);
    storage.updateAgent(agent.id, { sessionId: agent.sessionId });
    broadcast('agent:updated', { agent });
    syncSessionTitle(agent, client).catch(() => {});

    await handleAgentResponse(result.content, agent);
    saveTranscript(result, agent.id, agent.name, agent.role);

    agent.status = 'idle';
    agent.workingSince = undefined;
    storage.updateAgent(agent.id, { status: 'idle', sessionId: agent.sessionId, workingSince: null });
    broadcast('agent:updated', { agent });
    checkAndSynthesize(agent.id);
  } catch (e: any) {
    agent.status = 'error';
    agent.workingSince = undefined;
    storage.updateAgent(agent.id, { status: 'error', workingSince: null });
    broadcast('agent:updated', { agent });
    const errMsg: ChatMsg = { id: uuidv4(), from: agent.id, to: 'orchestrator', content: `[ERROR] Agent ${agent.name} failed after resume: ${e.message}`, timestamp: Date.now(), agentName: agent.name, agentRole: agent.role };
    chatHistory.push(errMsg); storage.saveMessage(errMsg);
    addUnreadForOrchestrator(errMsg);
    broadcast('chat:message', { msg: errMsg });
    checkAndSynthesize(agent.id);
  }
}

async function deleteAgent(id: string): Promise<boolean> {
  const a = agents.get(id);
  if (!a) return false;
  const client = clients.get(id);
  if (client) {
    await client.deleteSession(a.sessionId);
  } else if (a.sessionId) {
    const tmpClient = new ACPClient({ id, name: a.name, role: a.role, type: 'worker' });
    tmpClient.setSession(a.sessionId);
    await tmpClient.deleteSession();
  }
  ACPClient.unregisterSession(id);
  clients.delete(id); agents.delete(id);
  storage.deleteAgent(id);
  broadcast('agent:deleted', { id });
  console.log(`[Delete] ${a.name} (${a.id}) — session cleaned up`);
  return true;
}

function findAgentByName(name: string): Agent | undefined {
  for (const [, agent] of agents) if (agent.name === name) return agent;
  return undefined;
}

// ============ SYNTHESIZE ============
function checkAndSynthesize(completedAgentId: string) {
  const completedAgent = agents.get(completedAgentId);
  if (!completedAgent) return;
  const spawnedByOrch = Array.from(agents.values()).filter(a => a.spawnedBy === 'orchestrator');
  if (spawnedByOrch.length === 0) return;
  const allDone = spawnedByOrch.every(a => a.status === 'idle' || a.status === 'error');
  if (!allDone) return;
  
  // Guard: prevent duplicate synthesis for the same batch of agents
  const batchKey = spawnedByOrch.map(a => a.id).sort().join(',');
  if (synthesisTriggered.has(batchKey)) {
    console.log(`[Synthesize] Already triggered for batch: ${batchKey}`);
    return;
  }
  synthesisTriggered.add(batchKey);
  // Keep size small
  if (synthesisTriggered.size > 20) {
    const first = synthesisTriggered.values().next().value;
    if (first) synthesisTriggered.delete(first);
  }
  
  // Chỉ lấy report MỚI NHẤT của mỗi agent (không dồn lịch sử)
  const reversed = [...chatHistory].reverse();
  const reports = spawnedByOrch
    .map(a => {
      // Chỉ lấy tin báo cáo thật của agent (loại transcript/heartbeat/ping — không phải lịch sử hệ thống)
      const lastMsg = reversed.find(msg => msg.to === 'orchestrator' && msg.from === a.id && (msg.msgType === 'chat' || msg.msgType === undefined));
      return lastMsg ? `[Report from ${a.name} (${a.role})]:\n${lastMsg.content}` : null;
    })
    .filter(Boolean)
    .join('\n\n');
  if (!reports) return;
  const orchClient = getOrchClient();
  const synthesisPrompt = `All agents have completed their tasks. Here are their reports:\n\n${reports}\n\nPlease summarize all reports to the user in a clear, concise way. Highlight key results and any issues found.`;
  console.log(`[Synthesize] Sending ${spawnedByOrch.length} reports to orchestrator`);
  setTimeout(async () => {
    try {
      // Main dùng enqueue: tin tổng hợp xếp hàng nếu main đang bận (không mất khi busy)
      const result = await orchClient.enqueue(synthesisPrompt);
      const orchMsg: ChatMsg = { id: uuidv4(), from: 'orchestrator', to: 'user', content: result.content, timestamp: Date.now(), agentName: 'Orchestrator', agentRole: 'orchestrator' };
      chatHistory.push(orchMsg); storage.saveMessage(orchMsg);
      trimChatHistory();
      broadcast('chat:message', { msg: orchMsg });
    } catch (e: any) {
      console.log(`[Synthesize] Error: ${e.message}`);
    }
  }, 100);
}

function trimChatHistory() {
  if (chatHistory.length > MAX_HISTORY) {
    chatHistory.splice(0, chatHistory.length - MAX_HISTORY);
  }
}

// ============ COMMAND PARSING ============
async function parseAgentCommands(response: string, fromId: string): Promise<string[]> {
  const results: string[] = [];
  const stopRe = /\[?STOP\s+AGENT\s+target-id=(\S+)\]?/g;
  let m: RegExpExecArray | null;
  while ((m = stopRe.exec(response)) !== null) {
    if (stopAgent(m[1])) results.push(`Stopped ${m[1]}`);
    else results.push(`Could not stop ${m[1]}`);
  }
  const resumeRe = /\[?RESUME\s+AGENT\s+target-id=(\S+)\]?/g;
  while ((m = resumeRe.exec(response)) !== null) {
    if (resumeAgent(m[1])) results.push(`Resumed ${m[1]}`);
    else results.push(`Could not resume ${m[1]}`);
  }
  const deleteRe = /\[?DELETE\s+AGENT\s+target-id=(\S+)\]?/g;
  while ((m = deleteRe.exec(response)) !== null) {
    const targetId = m[1];
    const ok = await deleteAgent(targetId);
    if (ok) results.push(`Deleted ${targetId}`);
    else results.push(`Could not delete ${targetId}`);
  }
  return results;
}

// ============ HEARTBEAT ============
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 180000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat() {
  heartbeatTimer = setInterval(async () => {
    const now = Date.now();
    for (const [, agent] of agents) {
      if (agent.status === 'working' && agent.workingSince) {
        const elapsed = now - agent.workingSince;
        // Proactive PING at 150s
        if (elapsed > 150_000 && elapsed <= HEARTBEAT_TIMEOUT) {
          const lastPing = (agent as any).lastPingAt || 0;
          if (now - lastPing > 150_000) {
            (agent as any).lastPingAt = now;
            try {
              const client = getClient(agent);
              const team = buildTeam(agent.id);
              const pingMsg = `[SYSTEM] PING: You have been working for ${Math.round(elapsed/1000)}s without update. Immediately reply with [TO: orchestrator] PROGRESS: <what you are doing> or [TO: orchestrator] NEED CLARIFICATION: <question>.`;
              const prompt = agent.sessionId ? `[TEAM UPDATE]\n${team}\n\n${pingMsg}` : `[TASK] ${agent.task || 'General task'}\n[TEAM]\n${team}\n[/TEAM]\n\n${pingMsg}`;
              const result = await client.chat(prompt);
              agent.sessionId = client.getSessionId() || agent.sessionId;
              await parseAgentCommands(result.content, agent.id);
              const msg: ChatMsg = { id: uuidv4(), from: agent.id, to: 'orchestrator', content: `[PING] ${result.content}`, timestamp: now, agentName: agent.name, agentRole: agent.role };
              chatHistory.push(msg); storage.saveMessage({ ...msg, msgType: 'ping' });
              broadcast('chat:message', { msg });
              saveTranscript(result, agent.id, agent.name, agent.role);
              storage.updateAgent(agent.id, { sessionId: agent.sessionId });
              broadcast('agent:updated', { agent });
            } catch {}
          }
        }
        if (elapsed > HEARTBEAT_TIMEOUT) {
          console.log(`[Heartbeat] ${agent.name} working for ${Math.round(elapsed/1000)}s — prompting...`);
          try {
            const client = getClient(agent);
            const team = buildTeam(agent.id);
            const heartbeatMsg = `[SYSTEM] You have been working for ${Math.round(elapsed/1000)}s. Provide status update. If done, report with === TASK REPORT === === END REPORT ===`;
            const prompt = agent.sessionId ? `[TEAM UPDATE]\n${team}\n\n${heartbeatMsg}` : `[TASK] ${agent.task || 'General task'}\n[TEAM]\n${team}\n[/TEAM]\n\n${heartbeatMsg}`;
            const result = await client.chat(prompt);
            agent.sessionId = client.getSessionId() || agent.sessionId;
            await parseAgentCommands(result.content, agent.id);
            const msg: ChatMsg = { id: uuidv4(), from: agent.id, to: 'orchestrator', content: `[HEARTBEAT] ${result.content}`, timestamp: now, agentName: agent.name, agentRole: agent.role };
            chatHistory.push(msg); storage.saveMessage({ ...msg, msgType: 'heartbeat' });
            broadcast('chat:message', { msg });
            saveTranscript(result, agent.id, agent.name, agent.role);
            if (/STATUS:\s*(completed|done|finished)/i.test(result.content)) {
              agent.status = 'idle'; agent.workingSince = undefined;
              checkAndSynthesize(agent.id);
            } else { agent.status = 'working'; agent.workingSince = now; }
            storage.updateAgent(agent.id, { status: agent.status, sessionId: agent.sessionId, workingSince: agent.workingSince || null });
            broadcast('agent:updated', { agent });
          } catch (e: any) {
            agent.status = 'error'; agent.workingSince = undefined;
            storage.updateAgent(agent.id, { status: 'error', workingSince: null });
            broadcast('agent:updated', { agent });
          }
        }
      }
    }
  }, HEARTBEAT_INTERVAL);
}

// ============ TITLE POLLER ============
// Periodically fetch missing titles for agents that have sessionId but no sessionTitle.
// This catches titles that opencode generates asynchronously after the first turn.
let titlePollerTimer: ReturnType<typeof setInterval> | null = null;

function startTitlePoller() {
  titlePollerTimer = setInterval(async () => {
    for (const [id, agent] of agents) {
      if (agent.sessionId && !agent.sessionTitle && agent.type !== 'orchestrator') {
        try {
          const client = getClient(agent);
          const title = await client.getSessionTitle(agent.sessionId);
          if (title) {
            agent.sessionTitle = title;
            storage.updateAgent(agent.id, { sessionTitle: title });
            broadcast('agent:updated', { agent });
            console.log(`[TitlePoll] Found title for ${agent.name}: ${title}`);
          }
        } catch {}
      }
    }
  }, 10000); // every 10 seconds
}

// ============ WORKER WATCHDOG ============
// Monitors stuck/hung agents and auto-recovers them per Orchestrator rules
const WORKER_WATCHDOG_CONFIG = {
  checkIntervalMs: 30000,        // check every 30s
  stuckThresholdMs: 180000,      // 3 minutes = stuck (per rule #8)
  maxRetries: 2,                 // max auto-recovery attempts
  talkTimeoutMs: 30000,          // wait 30s for TALK response
};

interface WatchdogState {
  checkCount: Map<string, number>;      // agentId -> number of times flagged stuck
  lastTalkTime: Map<string, number>;    // agentId -> timestamp of last TALK sent
  awaitingTalkResponse: Set<string>;    // agentIds waiting for TALK response
}

const watchdogState: WatchdogState = {
  checkCount: new Map(),
  lastTalkTime: new Map(),
  awaitingTalkResponse: new Set(),
};

function startWorkerWatchdog() {
  watchdogTimer = setInterval(async () => {
    const now = Date.now();
    
    for (const [id, agent] of agents) {
      // Only monitor worker agents (not orchestrator) that are in "working" state
      if (agent.type === 'orchestrator' || agent.status !== 'working' || !agent.workingSince) {
        continue;
      }

      const workingDuration = now - agent.workingSince;
      
      // Check if agent is stuck (> 3 minutes)
      if (workingDuration >= WORKER_WATCHDOG_CONFIG.stuckThresholdMs) {
        const checkCount = watchdogState.checkCount.get(id) || 0;
        
        // First time flagged: send TALK to check status (rule #8)
        if (checkCount === 0 && !watchdogState.awaitingTalkResponse.has(id)) {
          watchdogState.checkCount.set(id, 1);
          watchdogState.lastTalkTime.set(id, now);
          watchdogState.awaitingTalkResponse.add(id);
          
          console.log(`[Watchdog] Agent ${agent.name} (${id}) stuck for ${Math.round(workingDuration/1000)}s — sending TALK to check status`);
          
          // Send TALK to ask for status
          try {
            const client = getClient(agent);
            const talkPrompt = `=== SYSTEM CHECK ===
The orchestrator has detected you've been working for ${Math.round(workingDuration/1000)} seconds without reporting progress.
Please respond with your current status:
- If working normally: "Still working on [brief description]"
- If stuck: "STUCK: [reason]"
- If done: "Task complete" with your report

Respond using: [TO: orchestrator] <your status>

${buildWorkerPrompt(agent.role, agent)}`;
            
            const tr = await client.enqueue(talkPrompt);
            
            // Check if response indicates stuck
            if (tr.content.toLowerCase().includes('stuck')) {
              await handleStuckAgent(id, agent, tr.content);
            } else if (tr.content.toLowerCase().includes('task complete') || 
                       tr.content.toLowerCase().includes('=== task report ===')) {
              // Agent reports done - normal completion
              watchdogState.checkCount.delete(id);
              watchdogState.awaitingTalkResponse.delete(id);
            } else {
              // Agent says still working - reset check count but keep monitoring
              console.log(`[Watchdog] Agent ${agent.name} reports still working`);
              watchdogState.awaitingTalkResponse.delete(id);
            }
          } catch (e: any) {
            console.log(`[Watchdog] TALK to ${agent.name} failed: ${e.message}`);
            watchdogState.awaitingTalkResponse.delete(id);
            await handleStuckAgent(id, agent, `Communication failed: ${e.message}`);
          }
        }
        // Subsequent checks: if still stuck after TALK, auto-recover
        else if (checkCount > 0) {
          const lastTalk = watchdogState.lastTalkTime.get(id) || 0;
          const timeSinceTalk = now - lastTalk;
          
          // If we sent TALK but no response within talkTimeoutMs
          if (watchdogState.awaitingTalkResponse.has(id) && timeSinceTalk >= WORKER_WATCHDOG_CONFIG.talkTimeoutMs) {
            console.log(`[Watchdog] Agent ${agent.name} did not respond to TALK within ${WORKER_WATCHDOG_CONFIG.talkTimeoutMs/1000}s`);
            watchdogState.awaitingTalkResponse.delete(id);
            await handleStuckAgent(id, agent, 'No response to status check');
          }
          // If TALK was answered but agent still working beyond threshold
          else if (!watchdogState.awaitingTalkResponse.has(id) && workingDuration >= WORKER_WATCHDOG_CONFIG.stuckThresholdMs * (checkCount + 1)) {
            if (checkCount < WORKER_WATCHDOG_CONFIG.maxRetries) {
              watchdogState.checkCount.set(id, checkCount + 1);
              watchdogState.lastTalkTime.set(id, now);
              watchdogState.awaitingTalkResponse.add(id);
              
              console.log(`[Watchdog] Agent ${agent.name} still stuck after ${checkCount} recovery attempt(s) — sending TALK with clearer instructions`);
              
              try {
                const client = getClient(agent);
                const retryPrompt = `=== RECOVERY ATTEMPT ${checkCount + 1}/${WORKER_WATCHDOG_CONFIG.maxRetries} ===
You were previously asked for status but appear to still be stuck on: ${agent.task || 'unknown task'}

Please either:
1. Complete the task and report with: [TO: orchestrator] Task complete. === TASK REPORT === ...
2. Report what's blocking you: [TO: orchestrator] STUCK: [specific reason]
3. If you cannot complete, say: [TO: orchestrator] CANNOT COMPLETE: [reason]

Respond now with your status.

${buildWorkerPrompt(agent.role, agent)}`;
                
                const tr = await client.enqueue(retryPrompt);
                
                if (tr.content.toLowerCase().includes('stuck') || 
                    tr.content.toLowerCase().includes('cannot complete')) {
                  await handleStuckAgent(id, agent, tr.content);
                } else if (tr.content.toLowerCase().includes('task complete') || 
                           tr.content.toLowerCase().includes('=== task report ===')) {
                  watchdogState.checkCount.delete(id);
                  watchdogState.awaitingTalkResponse.delete(id);
                } else {
                  watchdogState.awaitingTalkResponse.delete(id);
                }
              } catch (e: any) {
                console.log(`[Watchdog] Recovery TALK to ${agent.name} failed: ${e.message}`);
                watchdogState.awaitingTalkResponse.delete(id);
                await handleStuckAgent(id, agent, `Recovery failed: ${e.message}`);
              }
            } else {
              // Max retries exceeded - force stop and report to orchestrator
              console.log(`[Watchdog] Agent ${agent.name} exceeded max retries (${WORKER_WATCHDOG_CONFIG.maxRetries}) — forcing STOP and reporting to orchestrator`);
              await forceStopAndReport(id, agent);
            }
          }
        }
      }
      // Agent recovered (completed or errored) - clean up watchdog state
      else if ((agent.status as any) === 'idle' || (agent.status as any) === 'error') {
        watchdogState.checkCount.delete(id);
        watchdogState.lastTalkTime.delete(id);
        watchdogState.awaitingTalkResponse.delete(id);
      }
    }
  }, WORKER_WATCHDOG_CONFIG.checkIntervalMs);
}

async function handleStuckAgent(agentId: string, agent: Agent, reason: string) {
  console.log(`[Watchdog] Handling stuck agent ${agent.name}: ${reason}`);
  
  // STOP the agent
  stopAgent(agentId);
  
  // Send error report to orchestrator
  const errMsg: ChatMsg = {
    id: uuidv4(),
    from: agentId,
    to: 'orchestrator',
    content: `[WATCHDOG REPORT] Agent ${agent.name} (${agent.role}) was stuck for ${Math.round((Date.now() - (agent.workingSince || Date.now()))/1000)}s.\nReason: ${reason}\nTask: ${agent.task || 'none'}\nAction: Agent stopped. Awaiting orchestrator decision.`,
    timestamp: Date.now(),
    agentName: agent.name,
    agentRole: agent.role
  };
  chatHistory.push(errMsg);
  storage.saveMessage(errMsg);
  addUnreadForOrchestrator(errMsg);
  broadcast('chat:message', { msg: errMsg });
  
  // Trigger orchestrator to decide next action
  await triggerOrchestrator(agent, errMsg.content);
  
  // Clean up watchdog state
  watchdogState.checkCount.delete(agentId);
  watchdogState.awaitingTalkResponse.delete(agentId);
}

async function forceStopAndReport(agentId: string, agent: Agent) {
  console.log(`[Watchdog] Force stopping agent ${agent.name} (${agentId})`);
  
  // STOP the agent
  stopAgent(agentId);
  
  // Force cleanup: abort any running opencode process
  const client = clients.get(agentId);
  if (client) {
    client.abort();
  }
  
  // Report to orchestrator
  const errMsg: ChatMsg = {
    id: uuidv4(),
    from: agentId,
    to: 'orchestrator',
    content: `[WATCHDOG FORCE-STOP] Agent ${agent.name} (${agent.role}) exceeded max recovery attempts (${WORKER_WATCHDOG_CONFIG.maxRetries}).\nTask: ${agent.task || 'none'}\nAction: Agent forcibly stopped and removed from active pool.\nOrchestrator should decide: respawn with clearer task, reassign, or mark task failed.`,
    timestamp: Date.now(),
    agentName: agent.name,
    agentRole: agent.role
  };
  chatHistory.push(errMsg);
  storage.saveMessage(errMsg);
  addUnreadForOrchestrator(errMsg);
  broadcast('chat:message', { msg: errMsg });
  
  // Trigger orchestrator
  await triggerOrchestrator(agent, errMsg.content);
  
  // Clean up watchdog state
  watchdogState.checkCount.delete(agentId);
  watchdogState.awaitingTalkResponse.delete(agentId);
}

function findAgentByIdNameOrRole(identifier: string): Agent | undefined {
  const idLower = identifier.toLowerCase();
  if (agents.has(identifier)) return agents.get(identifier);
  for (const [, agent] of agents) {
    if (agent.name.toLowerCase() === idLower) return agent;
  }
  for (const [, agent] of agents) {
    if (agent.role.toLowerCase() === idLower) return agent;
  }
  return undefined;
}

function parseAgentOutput(content: string, defaultTo: string = 'orchestrator'): { to: string; message: string }[] {
  const matches: { to: string; message: string }[] = [];
  const regex = /\[TO:\s*([^\]]+)\]\s*([\s\S]*?)(?=\[TO:\s*[^\]]+\]|$)/gi;
  
  let match;
  let firstText = '';
  const firstMatch = content.match(/\[TO:\s*([^\]]+)\]/i);
  if (firstMatch) {
    const firstMatchIndex = content.indexOf(firstMatch[0]);
    if (firstMatchIndex > 0) {
      firstText = content.substring(0, firstMatchIndex).trim();
    }
  } else {
    firstText = content.trim();
  }
  
  if (firstText) {
    matches.push({ to: defaultTo, message: firstText });
  }
  
  while ((match = regex.exec(content)) !== null) {
    const rawTo = match[1].trim();
    const msg = match[2].trim();
    let resolvedTo = 'orchestrator';
    if (rawTo.toLowerCase() === 'orchestrator' || rawTo.toLowerCase() === 'main') {
      resolvedTo = 'orchestrator';
    } else {
      const found = findAgentByIdNameOrRole(rawTo);
      if (found) resolvedTo = found.id;
      else resolvedTo = rawTo;
    }
    if (msg) {
      matches.push({ to: resolvedTo, message: msg });
    }
  }
  
  return matches;
}

function parseSpawnTags(text: string): Array<{ role: string; name: string; task: string }> {
  const spawns: Array<{ role: string; name: string; task: string }> = [];
  const spawnRegex = /\[SPAWN\s+([\s\S]*?)\]/g;
  let match;
  while ((match = spawnRegex.exec(text)) !== null) {
    const attrsText = match[1];
    const roleMatch = attrsText.match(/role=(\S+)/i);
    const nameMatch = attrsText.match(/name=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    const taskMatch = attrsText.match(/task=(?:"([\s\S]+?)"|'([\s\S]+?)'|([\s\S]+))/i);
    
    if (roleMatch && nameMatch && taskMatch) {
      const role = roleMatch[1].trim();
      const name = (nameMatch[1] || nameMatch[2] || nameMatch[3]).trim();
      const task = (taskMatch[1] || taskMatch[2] || taskMatch[3]).trim();
      spawns.push({ role, name, task });
    }
  }
  return spawns;
}

function parseTalkTags(text: string): Array<{ agentId: string; message: string }> {
  const talks: Array<{ agentId: string; message: string }> = [];
  const talkRegex = /\[TALK\s+([\s\S]*?)\]/g;
  let match;
  while ((match = talkRegex.exec(text)) !== null) {
    const attrsText = match[1];
    const idMatch = attrsText.match(/agent-id=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    const msgMatch = attrsText.match(/message=(?:"([\s\S]+?)"|'([\s\S]+?)'|([\s\S]+))/i);
    
    if (idMatch && msgMatch) {
      const agentId = (idMatch[1] || idMatch[2] || idMatch[3]).trim();
      const message = (msgMatch[1] || msgMatch[2] || msgMatch[3]).trim();
      talks.push({ agentId, message });
    }
  }
  return talks;
}

async function triggerOrchestrator(fromAgent: Agent, message: string) {
  const client = getOrchClient();
  broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'working' } } as any);
  
  const team = buildTeam('orchestrator');
  const msgHeader = `=== INCOMING MESSAGE ===\nFROM: ${fromAgent.name} (ID: ${fromAgent.id}, Role: ${fromAgent.role})\nTO: Orchestrator (orchestrator)\n=== MESSAGE ===\n${message}`;
  
  let prompt = '';
  if (client.getSessionId()) {
    prompt = `[TEAM UPDATE]\n${team}\n\n${msgHeader}`;
  } else {
    prompt = `[TEAM]\n${team}\n[/TEAM]\n\n${msgHeader}`;
  }
  prompt += ORCH_REMINDER;
  
  try {
    const result = await client.enqueue(prompt);
    const sid = client.getSessionId();
    if (sid) {
      const orchAgent = agents.get('orchestrator');
      if (orchAgent) {
        orchAgent.sessionId = sid;
        ACPClient.registerSession('orchestrator', sid);
        storage.updateAgent('orchestrator', { sessionId: sid });
        syncSessionTitle(orchAgent, client).catch(() => {});
      }
    }
    const orchMsg: ChatMsg = {
      id: uuidv4(),
      from: 'orchestrator',
      to: 'user',
      content: result.content,
      timestamp: Date.now(),
      agentName: 'Orchestrator',
      agentRole: 'orchestrator'
    };
    chatHistory.push(orchMsg);
    storage.saveMessage(orchMsg);
    broadcast('chat:message', { msg: orchMsg });
    
    await handleOrchestratorResponse(result.content);
  } catch (e: any) {
    console.log(`[Orchestrator Trigger] Error: ${e.message}`);
  } finally {
    broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
  }
}

async function handleAgentResponse(content: string, fromAgent: Agent, defaultTo: string = 'orchestrator') {
  await parseAgentCommands(content, fromAgent.id);
  const messages = parseAgentOutput(content, defaultTo);
  for (const msg of messages) {
    const reply: ChatMsg = {
      id: uuidv4(),
      from: fromAgent.id,
      to: msg.to,
      content: msg.message,
      timestamp: Date.now(),
      agentName: fromAgent.name,
      agentRole: fromAgent.role
    };
    chatHistory.push(reply);
    storage.saveMessage(reply);
    broadcast('chat:message', { msg: reply });
    
    if (msg.to === 'orchestrator') {
      // triggerOrchestrator đã chuyển thẳng tin vào prompt main — KHÔNG thêm unread nữa (tránh main nhận 2 lần)
      await triggerOrchestrator(fromAgent, msg.message);
    } else {
      const targetAgent = agents.get(msg.to);
      if (targetAgent) {
        targetAgent.status = 'working';
        targetAgent.workingSince = Date.now();
        storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
        broadcast('agent:updated', { agent: targetAgent });
        
        setTimeout(async () => {
          try {
            const tc = getClient(targetAgent);
            const talkTeam = buildTeam(targetAgent.id);
            const talkHeader = `=== INCOMING MESSAGE ===\nFROM: ${fromAgent.name} (ID: ${fromAgent.id}, Role: ${fromAgent.role})\nTO: ${targetAgent.name} (ID: ${targetAgent.id}, Role: ${targetAgent.role})\n=== MESSAGE ===`;
            const talkPrompt = targetAgent.sessionId
              ? `[TEAM UPDATE]\n${talkTeam}\n\n${talkHeader}\n${msg.message}`
              : `[TEAM]\n${talkTeam}\n[/TEAM]\n\n${talkHeader}\n${msg.message}`;
            const tr = await tc.enqueue(`${talkPrompt}\n\n${buildWorkerPrompt(targetAgent.role, targetAgent)}`);
            targetAgent.sessionId = tc.getSessionId() || undefined;
            if (targetAgent.sessionId) ACPClient.registerSession(targetAgent.id, targetAgent.sessionId);
            storage.updateAgent(targetAgent.id, { sessionId: targetAgent.sessionId });
            broadcast('agent:updated', { agent: targetAgent });
            syncSessionTitle(targetAgent, tc).catch(() => {});
            
            await handleAgentResponse(tr.content, targetAgent);
            saveTranscript(tr, targetAgent.id, targetAgent.name, targetAgent.role);
            
            clearAgentRetry(targetAgent.id);
            
            targetAgent.status = 'idle';
            targetAgent.workingSince = undefined;
            storage.updateAgent(targetAgent.id, { status: 'idle', sessionId: targetAgent.sessionId, workingSince: null });
            broadcast('agent:updated', { agent: targetAgent });
            checkAndSynthesize(targetAgent.id);
          } catch (e: any) {
            targetAgent.status = 'error';
            targetAgent.workingSince = undefined;
            storage.updateAgent(targetAgent.id, { status: 'error', workingSince: null });
            broadcast('agent:updated', { agent: targetAgent });
            checkAndSynthesize(targetAgent.id);
          }
        }, 100);
      }
    }
  }
}

async function handleOrchestratorResponse(response: string): Promise<string[]> {
  const commandResults: string[] = [];
  const cmdResults = await parseAgentCommands(response, 'orchestrator');
  commandResults.push(...cmdResults);
  
  const spawns = parseSpawnTags(response);
  for (const spawn of spawns) {
    const { role, name, task } = spawn;
    const existing = findAgentByName(name);
    if (existing) {
      commandResults.push(`Reused ${name} (${existing.id})`);
      existing.status = 'working';
      existing.workingSince = Date.now();
      existing.task = task;
      storage.updateAgent(existing.id, { status: 'working', workingSince: existing.workingSince });
      broadcast('agent:updated', { agent: existing });
      
      const reuseTaskMsg: ChatMsg = {
        id: uuidv4(),
        from: 'orchestrator',
        to: existing.id,
        content: `[TASK] New assignment for ${name}: ${task}`,
        timestamp: Date.now(),
        agentName: 'Orchestrator',
        agentRole: 'orchestrator'
      };
      chatHistory.push(reuseTaskMsg);
      storage.saveMessage(reuseTaskMsg);
      broadcast('chat:message', { msg: reuseTaskMsg });
      
      setTimeout(async () => {
        try {
          const tc = getClient(existing);
          const spawnTeam = buildTeam(existing.id);
          const prompt = existing.sessionId
            ? `[TEAM UPDATE]\n${spawnTeam}\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${existing.name} (ID: ${existing.id}, Role: ${existing.role})\n=== MESSAGE ===\nNew task: ${task}`
            : `[TASK] ${task}\n[TEAM]\n${spawnTeam}\n[/TEAM]\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${existing.name} (ID: ${existing.id}, Role: ${existing.role})\n=== MESSAGE ===\n${task}`;
          const tr = await tc.enqueue(`${prompt}\n\n${buildWorkerPrompt(existing.role, existing)}`);
          existing.sessionId = tc.getSessionId() || existing.sessionId;
          if (existing.sessionId) ACPClient.registerSession(existing.id, existing.sessionId);
          storage.updateAgent(existing.id, { sessionId: existing.sessionId });
          broadcast('agent:updated', { agent: existing });
          syncSessionTitle(existing, tc).catch(() => {});
          
          await handleAgentResponse(tr.content, existing);
          saveTranscript(tr, existing.id, existing.name, existing.role);
          
          clearAgentRetry(existing.id);
          
          existing.status = 'idle';
          existing.workingSince = undefined;
          storage.updateAgent(existing.id, { status: 'idle', sessionId: existing.sessionId, workingSince: null });
          broadcast('agent:updated', { agent: existing });
          checkAndSynthesize(existing.id);
        } catch (e: any) {
          existing.status = 'error';
          existing.workingSince = undefined;
          storage.updateAgent(existing.id, { status: 'error', workingSince: null });
          broadcast('agent:updated', { agent: existing });
          const errMsg: ChatMsg = { id: uuidv4(), from: existing.id, to: 'orchestrator', content: `[ERROR] Agent ${existing.name} failed on first turn: ${e.message}`, timestamp: Date.now(), agentName: existing.name, agentRole: existing.role };
          chatHistory.push(errMsg); storage.saveMessage(errMsg);
          addUnreadForOrchestrator(errMsg);
          broadcast('chat:message', { msg: errMsg });
          checkAndSynthesize(existing.id);
        }
      }, 100);
    } else {
      const spawnId = 'agent-' + uuidv4().slice(0, 8);
      const na: Agent = {
        id: spawnId, name, role, type: 'worker', status: 'working',
        spawnedBy: 'orchestrator', task, createdAt: Date.now(), workingSince: Date.now(),
        sessionTitle: task ? task.substring(0, 80) : undefined
      };
      agents.set(spawnId, na);
      storage.saveAgent(na);
      broadcast('agent:created', { agent: na });
      
      const spawnTaskMsg: ChatMsg = {
        id: uuidv4(),
        from: 'orchestrator',
        to: spawnId,
        content: `[SPAWN] ${role} "${name}" assigned: ${task}`,
        timestamp: Date.now(),
        agentName: 'Orchestrator',
        agentRole: 'orchestrator'
      };
      chatHistory.push(spawnTaskMsg);
      storage.saveMessage(spawnTaskMsg);
      broadcast('chat:message', { msg: spawnTaskMsg });
      
      commandResults.push(`Spawned ${name} (${role}) → ${spawnId}`);
      console.log(`[Orch] Spawned: ${name} (${role}) → ${spawnId}`);
      
      setTimeout(async () => {
        try {
          const tc = getClient(na);
          const spawnTeam = buildTeam(na.id);
          const senderHeader = `=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${na.name} (ID: ${spawnId}, Role: ${na.role})\n=== MESSAGE ===`;
          const tr = await tc.enqueue(`[TASK] ${na.task}\n[TEAM]\n${spawnTeam}\n[/TEAM]\n\n${senderHeader}\n${na.task}\n\n${buildWorkerPrompt(na.role, na)}`);
          na.sessionId = tc.getSessionId() || undefined;
          if (na.sessionId) ACPClient.registerSession(na.id, na.sessionId);
          storage.updateAgent(na.id, { sessionId: na.sessionId });
          broadcast('agent:updated', { agent: na });
          syncSessionTitle(na, tc).catch(() => {});
          
          await handleAgentResponse(tr.content, na);
          saveTranscript(tr, spawnId, name, role);
          
          clearAgentRetry(spawnId);
          
          na.status = 'idle';
          na.workingSince = undefined;
          storage.updateAgent(na.id, { status: 'idle', sessionId: na.sessionId, workingSince: null });
          broadcast('agent:updated', { agent: na });
          checkAndSynthesize(spawnId);
        } catch (e: any) {
          na.status = 'error';
          na.workingSince = undefined;
          storage.updateAgent(na.id, { status: 'error', workingSince: null });
          broadcast('agent:updated', { agent: na });
          const errMsg: ChatMsg = { id: uuidv4(), from: na.id, to: 'orchestrator', content: `[ERROR] Agent ${na.name} failed on first turn: ${e.message}`, timestamp: Date.now(), agentName: name, agentRole: role };
          chatHistory.push(errMsg); storage.saveMessage(errMsg);
          addUnreadForOrchestrator(errMsg);
          broadcast('chat:message', { msg: errMsg });
          checkAndSynthesize(spawnId);
        }
      }, 100);
    }
  }
  
  const talks = parseTalkTags(response);
  for (const talk of talks) {
    const { agentId, message } = talk;
    const ta = agents.get(agentId) || findAgentByName(agentId);
    if (!ta) {
      commandResults.push(`[ERROR] TALK: agent ${agentId} not found`);
      continue;
    }
    ta.status = 'working';
    ta.workingSince = Date.now();
    storage.updateAgent(ta.id, { status: 'working', workingSince: ta.workingSince });
    broadcast('agent:updated', { agent: ta });
    
    setTimeout(async () => {
      try {
        const tc = getClient(ta);
        const talkTeam = buildTeam(ta.id);
        const talkHeader = `=== INCOMING MESSAGE ===\nFROM: Orchestrator (orchestrator)\nTO: ${ta.name} (ID: ${ta.id}, Role: ${ta.role})\n=== MESSAGE ===`;
        const talkPrompt = ta.sessionId ? `[TEAM UPDATE]\n${talkTeam}\n\n${talkHeader}\n${message}` : `[TEAM]\n${talkTeam}\n[/TEAM]\n\n${talkHeader}\n${message}`;
        const tr = await tc.enqueue(`${talkPrompt}\n\n${buildWorkerPrompt(ta.role, ta)}`);
        ta.sessionId = tc.getSessionId() || undefined;
        if (ta.sessionId) ACPClient.registerSession(ta.id, ta.sessionId);
        storage.updateAgent(ta.id, { sessionId: ta.sessionId });
        broadcast('agent:updated', { agent: ta });
        syncSessionTitle(ta, tc).catch(() => {});
        
        await handleAgentResponse(tr.content, ta);
        saveTranscript(tr, ta.id, ta.name, ta.role);
        
        clearAgentRetry(ta.id);
        
        ta.status = 'idle';
        ta.workingSince = undefined;
        storage.updateAgent(ta.id, { status: 'idle', sessionId: ta.sessionId, workingSince: null });
        broadcast('agent:updated', { agent: ta });
        checkAndSynthesize(ta.id);
      } catch (e: any) {
        ta.status = 'error';
        ta.workingSince = undefined;
        storage.updateAgent(ta.id, { status: 'error', workingSince: null });
        broadcast('agent:updated', { agent: ta });
        checkAndSynthesize(ta.id);
      }
    }, 100);
  }
  
  return commandResults;
}

function getOrchClient(): ACPClient {
  if (!clients.has('orchestrator')) {
    const orchAgent = agents.get('orchestrator');
    const model = orchAgent?.model || process.env.ORCHESTRATOR_MODEL;
    clients.set('orchestrator', new ACPClient({ id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator', model }));
  }
  const client = clients.get('orchestrator')!;
  const orchAgent = agents.get('orchestrator');
  if (orchAgent?.sessionId && client.getSessionId() !== orchAgent.sessionId) {
    client.setSession(orchAgent.sessionId);
  }
  return client;
}

// ============ API ============
app.get('/api/agents', (_req, res) => res.json(Array.from(agents.values())));

app.post('/api/agents', (req, res) => {
  const { name, role, type, spawnedBy, projectDir, task, model } = req.body;
  const id = 'agent-' + uuidv4().slice(0, 8);
  const agent: Agent = {
    id, name: name || `Agent-${id.slice(-4)}`, role: role || 'coder',
    type: type || 'worker', status: 'idle', spawnedBy, projectDir, task, model, createdAt: Date.now(), sessionId: undefined
  };
  agents.set(id, agent); storage.saveAgent(agent);
  broadcast('agent:created', { agent });
  // Tạo tin nhắn đầu để user thấy ngay agent đã sẵn sàng
  const spawnMsg: ChatMsg = {
    id: uuidv4(), from: 'system', to: id,
    content: `[SPAWN] Agent "${agent.name}" (${agent.role}) created and ready.${agent.task ? ` Task: ${agent.task}` : ''}`,
    timestamp: Date.now(), agentName: agent.name, agentRole: agent.role
  };
  chatHistory.push(spawnMsg); storage.saveMessage(spawnMsg);
  broadcast('chat:message', { msg: spawnMsg });
  console.log(`[Spawn] ${agent.name} (${agent.role}) → ${id}`);
  res.json({ ok: true, agent });
});

app.post('/api/agents/:id/start', (req, res) => {
  const a = agents.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  a.status = 'idle'; a.workingSince = undefined;
  storage.updateAgent(a.id, { status: 'idle', workingSince: null });
  broadcast('agent:updated', { agent: a });
  res.json({ ok: true });
});

app.post('/api/agents/:id/stop', (req, res) => {
  const a = agents.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  stopAgent(a.id); res.json({ ok: true });
});

app.post('/api/agents/:id/resume', (req, res) => {
  const a = agents.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!resumeAgent(a.id)) return res.json({ ok: false, error: 'Agent not stopped' });
  res.json({ ok: true });
});

app.post('/api/agents/:id/abort', (req, res) => {
  const id = req.params.id;
  // Orchestrator quản lý riêng (không trong agents map) — xử lý abort riêng
  if (id === 'orchestrator') {
    const client = clients.get('orchestrator');
    const killed = client ? client.abort() : false;
    broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
    return res.json({ ok: true, killed });
  }
  const a = agents.get(id);
  if (!a) return res.status(404).json({ ok: false, error: 'Not found' });
  const client = clients.get(a.id);
  const killed = client ? client.abort() : false;
  a.status = 'idle'; a.workingSince = undefined;
  storage.updateAgent(a.id, { status: 'idle', workingSince: null });
  broadcast('agent:updated', { agent: a });
  res.json({ ok: true, killed });
});

app.delete('/api/agents/:id', async (req, res) => {
  await deleteAgent(req.params.id);
  res.json({ ok: true });
});

// Update agent model
app.post('/api/agents/:id/model', (req, res) => {
  const { model } = req.body || {};
  const agentId = req.params.id;
  const agent = agents.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Not found' });
  
  agent.model = model || undefined;
  storage.updateAgent(agentId, { model: model || null });
  
  // If agent has a client, update its model too (for new sessions)
  const client = clients.get(agentId);
  if (client) {
    client.setModel(model || undefined);
  }
  
  broadcast('agent:updated', { agent });
  res.json({ ok: true, model: agent.model });
});

// ============ CHAT ============
app.post('/api/chat', async (req, res) => {
  const { message, targetAgentId, agentId } = req.body;
  const resolvedTargetId = targetAgentId || agentId;
  const targetAgent = resolvedTargetId ? agents.get(resolvedTargetId) : null;
  const commandResults: string[] = [];

  const userMsg: ChatMsg = { id: uuidv4(), from: 'user', to: resolvedTargetId || 'orchestrator', content: message, timestamp: Date.now() };
  chatHistory.push(userMsg); storage.saveMessage(userMsg);
  broadcast('chat:message', { msg: userMsg });

  let agentName = 'Orchestrator', agentRole = 'orchestrator';
  let prompt: string;
  let sid: string | null = null;

  if (targetAgent) {
    agentName = targetAgent.name; agentRole = targetAgent.role;
    targetAgent.status = 'working'; targetAgent.workingSince = Date.now();
    storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
    broadcast('agent:updated', { agent: targetAgent });
    const team = buildTeam(targetAgent.id);
    if (targetAgent.sessionId) {
      prompt = `[TEAM UPDATE]\n${team}\n\n[FROM: user] [TO: ${targetAgent.id}] ${message}`;
    } else {
      prompt = `[TASK] ${targetAgent.task || 'General task'}\n[TEAM]\n${team}\n[/TEAM]\n\n[FROM: user] [TO: ${targetAgent.id}] ${message}`;
    }
  } else {
    const team = buildTeam('orchestrator');
    const client = getOrchClient();
    const orchAgent = agents.get('orchestrator');
    if (orchAgent) {
      orchAgent.status = 'working';
      storage.updateAgent('orchestrator', { status: 'working' });
      broadcast('agent:updated', { agent: orchAgent });
    } else {
      broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'working' } } as any);
    }

    // Inject unread messages từ workers vào prompt
    const unread = consumeUnreadForOrchestrator();
    let unreadBlock = '';
    if (unread.length > 0) {
      unreadBlock = '\n\n=== MESSAGES FROM AGENTS (you should respond to these) ===\n' +
        unread.map(m => `[FROM: ${m.agentName || m.from} (${m.from})]\n${m.content}`).join('\n\n') +
        '\n=== END MESSAGES ===\n';
    }

    if (client.getSessionId()) {
      prompt = `[TEAM UPDATE]\n${team}${unreadBlock}\n\n[FROM: user] [TO: orchestrator] ${message}`;
    } else {
      prompt = `[TEAM]\n${team}${unreadBlock}\n[/TEAM]\n\n[FROM: user] [TO: orchestrator] ${message}`;
    }
  }

  try {
    const client = targetAgent ? getClient(targetAgent) : getOrchClient();
    // Agent đích đang bận → tin vào hàng đợi
    const wasQueued = !!targetAgent && client.isBusy();
    if (wasQueued) {
      const qMsg: ChatMsg = { id: uuidv4(), from: 'user', to: targetAgent.id, content: `[QUEUED] "${message.slice(0, 120)}${message.length > 120 ? '...' : ''}" — agent ${targetAgent.name} is working, message queued (position ${client.queueLength() + 1})`, timestamp: Date.now() };
      chatHistory.push(qMsg); storage.saveMessage(qMsg);
      broadcast('chat:message', { msg: qMsg });
    }
    const result = await client.enqueue(prompt + (targetAgent ? `\n\n${buildWorkerPrompt(targetAgent.role, targetAgent)}` : ORCH_REMINDER));
    sid = client.getSessionId();
    if (sid) {
      if (targetAgent) {
        targetAgent.sessionId = sid;
        ACPClient.registerSession(targetAgent.id, sid);
        // Broadcast immediately, fetch title in background - also update in-memory agent
        storage.updateAgent(targetAgent.id, { sessionId: sid, sessionTitle: targetAgent.sessionTitle });
        broadcast('agent:updated', { agent: targetAgent });
        syncSessionTitle(targetAgent, client).catch(() => {});
      } else {
        const orchAgent = agents.get('orchestrator');
        if (orchAgent) {
          orchAgent.sessionId = sid;
          storage.updateAgent('orchestrator', { sessionId: sid });
          syncSessionTitle(orchAgent, client).catch(() => {});
        }
        ACPClient.registerSession('orchestrator', sid);
      }
    }

    const response = result.content;
    if (targetAgent) {
      // Direct user-agent chat: response goes back to user, not through orchestrator
      // But also parse for [TO:] tags in case agent wants to delegate
      // IMPORTANT: pass 'user' as defaultTo so messages without [TO:] go to user, not orchestrator
      const messages = parseAgentOutput(response, 'user');
      let hasExplicitTo = false;
      for (const msg of messages) {
        if (msg.to !== 'user' && msg.to !== 'orchestrator') {
          hasExplicitTo = true;
          break;
        }
      }
      
      if (hasExplicitTo) {
        // Agent used [TO:] tags to delegate - handle via normal routing
        await handleAgentResponse(response, targetAgent, 'user');
      } else {
        // Plain response from agent to user - send directly
        const reply: ChatMsg = {
          id: uuidv4(),
          from: targetAgent.id,
          to: 'user',
          content: response,
          timestamp: Date.now(),
          agentName: targetAgent.name,
          agentRole: targetAgent.role
        };
        chatHistory.push(reply);
        storage.saveMessage(reply);
        broadcast('chat:message', { msg: reply });
      }
      saveTranscript(result, targetAgent.id, targetAgent.name, targetAgent.role);
      
      // Validate completion format and clear retry tracking
      const validation = validateWorkerCompletion(result.content, targetAgent);
      if (!validation.valid) {
        console.log(`[Chat] Agent ${targetAgent.name} completion format invalid: ${validation.reason}`);
        // Don't mark as error, just log - watchdog will handle if truly stuck
      }
      clearAgentRetry(targetAgent.id);
      
      targetAgent.status = 'idle'; targetAgent.workingSince = undefined;
      storage.updateAgent(targetAgent.id, { status: 'idle', sessionId: targetAgent.sessionId, workingSince: null });
      broadcast('agent:updated', { agent: targetAgent });
    } else {
      const commandResultsParse = await handleOrchestratorResponse(response);
      commandResults.push(...commandResultsParse);
      
      const aMsg: ChatMsg = { id: uuidv4(), from: 'orchestrator', to: 'user', content: response, timestamp: Date.now(), agentName, agentRole };
      chatHistory.push(aMsg); storage.saveMessage(aMsg);
      broadcast('chat:message', { msg: aMsg });
      const orchAgent = agents.get('orchestrator');
      if (orchAgent) {
        orchAgent.status = 'idle';
        storage.updateAgent('orchestrator', { status: 'idle' });
        broadcast('agent:updated', { agent: orchAgent });
      } else {
        broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
      }
    }
    res.json({ response, sessionId: sid, commands: commandResults });
  } catch (err: any) {
    if (targetAgent) { targetAgent.status = 'error'; targetAgent.workingSince = undefined; storage.updateAgent(targetAgent.id, { status: 'error', workingSince: null }); broadcast('agent:updated', { agent: targetAgent }); }
    else {
      const orchAgent = agents.get('orchestrator');
      if (orchAgent) {
        orchAgent.status = 'idle';
        storage.updateAgent('orchestrator', { status: 'idle' });
        broadcast('agent:updated', { agent: orchAgent });
      } else {
        broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
      }
    }
    res.json({ response: `Error: ${err.message}` });
  }
});

// ============ MODELS ============
app.get('/api/models', (_req, res) => {
  try {
    const out = execSync('opencode models 2>&1', { encoding: 'utf-8', timeout: 10000 });
    const models = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    res.json({ models });
  } catch (e: any) {
    res.json({ models: [], error: e.message });
  }
});

// ============ ORCHESTRATOR ============
app.get('/api/history', (_req, res) => res.json(chatHistory));

// Set model cho main (orchestrator) — giữ session cũ, chỉ đổi model áp dụng cho session này
app.post('/api/orchestrator/model', (req, res) => {
  const { model } = req.body || {};
  if (model) process.env.ORCHESTRATOR_MODEL = model; else delete process.env.ORCHESTRATOR_MODEL;
  const orchAgent = agents.get('orchestrator');
  if (orchAgent) {
    orchAgent.model = model || undefined;
    storage.updateAgent('orchestrator', { model: model || null });
  }
  const orchClient = clients.get('orchestrator');
  if (orchClient) orchClient.setModel(model || undefined); // KHÔNG reset client → giữ session
  res.json({ ok: true });
});

// Clear main conversation + session opencode
app.post('/api/orchestrator/clear', async (_req, res) => {
  let sessionDeleted = false;
  let deleteError: string | null = null;
  try {
    const orchClient = clients.get('orchestrator');
    if (orchClient) {
      const sid = orchClient.getSessionId();
      if (sid) {
        // Retry delete lên 2 lần nếu fail
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            sessionDeleted = await orchClient.deleteSession(sid);
            if (sessionDeleted) break;
          } catch (delErr: any) {
            deleteError = delErr.message;
            console.log(`[Clear] Delete session attempt ${attempt + 1} failed: ${delErr.message}`);
          }
        }
      }
    }
    // LUÔN xoá client + DB record kể cả delete session fail
    clients.delete('orchestrator');
    ACPClient.unregisterSession('orchestrator');
    storage.updateAgent('orchestrator', { sessionId: undefined, sessionTitle: undefined });
    // Xoá hội thoại MAIN (msg từ/tới orchestrator) — giữ hội thoại riêng của agents
    const keep: ChatMsg[] = [];
    chatHistory.forEach(msg => {
      const isMainView = msg.from === 'orchestrator' || msg.to === 'orchestrator';
      if (!isMainView) keep.push(msg);
    });
    chatHistory.length = 0;
    chatHistory.push(...keep);
    storage.clearOrchestratorConversation();
    broadcast('chat:message', { action: 'clear' });
    if (!sessionDeleted && deleteError) {
      console.log(`[Clear] WARNING: Session delete failed (${deleteError}), but local state cleared. Next chat will create fresh session.`);
    } else {
      console.log('[Clear] Orchestrator conversation + session cleared');
    }
    res.json({ ok: true, sessionDeleted, warning: !sessionDeleted ? 'Session delete failed, local state cleared' : undefined });
  } catch (e: any) {
    // Vẫn force clear local state nếu có lỗi ngoài dự kiến
    clients.delete('orchestrator');
    ACPClient.unregisterSession('orchestrator');
    storage.updateAgent('orchestrator', { sessionId: undefined, sessionTitle: undefined });
    res.json({ ok: false, error: e.message });
  }
});

// ============ STATIC ============
app.use('/assets', express.static(join(process.cwd(), 'web', 'dist', 'assets')));
app.get('/', (_req, res) => {
  try { res.type('html').send(readFileSync(join(process.cwd(), 'dist', 'index.html'), 'utf-8')); }
  catch { res.status(500).send('Legacy HTML not found'); }
});
app.get('/v2', (_req, res) => {
  const viteIndex = join(process.cwd(), 'web', 'dist', 'index.html');
  if (existsSync(viteIndex)) {
    try { return res.type('html').send(readFileSync(viteIndex, 'utf-8')); } catch {}
  }
  res.status(500).send('Vite build not found — run: cd web && npm run build');
});

// ============ WS ============
wss.on('connection', (ws) => { wsClients.add(ws); ws.on('close', () => wsClients.delete(ws)); });

// ============ STARTUP ============
loadState();
loadCustomRoles();
startTitlePoller();
startWorkerWatchdog();
startHeartbeat();

// Startup: fetch missing sessionTitles cho agents có sessionId nhưng thiếu title
async function fetchMissingTitles() {
  for (const [, agent] of agents) {
    if (agent.sessionId && !agent.sessionTitle) {
      try {
        const client = agent.id === 'orchestrator' ? getOrchClient() : getClient(agent);
        await syncSessionTitle(agent, client, 2);
      } catch {}
    }
  }
}
// Delay 2s để opencode ready, sau đó fetch title cho agents cũ
setTimeout(fetchMissingTitles, 2000);

process.on('SIGINT', () => { if (titlePollerTimer) clearInterval(titlePollerTimer); if (watchdogTimer) clearInterval(watchdogTimer); if (heartbeatTimer) clearInterval(heartbeatTimer); storage.close(); server.close(); process.exit(0); });
server.listen(PORT, () => console.log(`\n🚀 AgentForge v7: http://localhost:${PORT}\n`));
