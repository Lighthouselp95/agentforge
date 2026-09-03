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
const HEARTBEAT_INTERVAL = 60_000;
const HEARTBEAT_TIMEOUT = 180_000;
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

// ============ ORCHESTRATOR PROMPT ============
const ORCH_PROMPT = `You are the Main Orchestrator of AgentForge. You manage a team of coding agents to complete software tasks.

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
6. ONLY you (the Orchestrator) can SPAWN agents — worker agents CANNOT spawn
7. MAX 3 agents per role. Do NOT spawn a 4th agent of the same role. If the server rejects with "[ERROR] max 3 agents per role", read the listed active agents and reuse/delete one first.
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
    for (const row of savedAgents) {
      const agent: Agent = {
        id: row.id, name: row.name, role: row.role, type: row.type,
        status: row.status === 'working' ? 'idle' : row.status,
        spawnedBy: row.spawned_by, projectDir: row.project_dir, model: row.model,
        sessionId: row.session_id, sessionTitle: row.session_title, task: row.task,
        createdAt: row.created_at, workingSince: undefined
      };
      agents.set(agent.id, agent);
    }
    console.log(`[Storage] Loaded ${savedAgents.length} agents`);
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

// Lưu transcript nguyên văn 1 lượt làm việc của agent (tool calls + text) thành message riêng
function saveTranscript(result: any, fromId: string, agentName?: string, agentRole?: string) {
  if (!result?.transcript) return;
  const tMsg: ChatMsg = { id: uuidv4(), from: fromId, to: 'orchestrator', content: result.transcript, timestamp: Date.now(), agentName, agentRole, msgType: 'transcript' };
  chatHistory.push(tMsg); storage.saveMessage(tMsg);
  broadcast('chat:message', { msg: tMsg });
}

// Đồng bộ title session opencode → Agent (tiêu đề khung chat)
async function syncSessionTitle(agent: Agent, client: ACPClient) {
  const sid = client.getSessionId();
  if (!sid) return;
  if (sid === agent.sessionId && agent.sessionTitle) return;
  const title = await client.getSessionTitle(sid);
  if (title) {
    agent.sessionTitle = title;
    agent.sessionId = sid;
    storage.updateAgent(agent.id, { sessionId: sid, sessionTitle: title });
    broadcast('agent:updated', { agent });
  }
}

function getClient(agent: Agent): ACPClient {
  if (!clients.has(agent.id)) {
    // Agent không chọn model → kế thừa model của main (ORCHESTRATOR_MODEL) nếu có
    const model = agent.model || process.env.ORCHESTRATOR_MODEL;
    const c = new ACPClient({ id: agent.id, name: agent.name, role: agent.role, type: 'worker', projectDir: agent.projectDir, model });
    if (agent.sessionId) c.setSession(agent.sessionId);
    clients.set(agent.id, c);
  }
  return clients.get(agent.id)!;
}

// ============ TEAM CONTEXT ============
function buildTeam(agentId: string, full: boolean = false): string {
  const self = agents.get(agentId);
  const isOrchestrator = self?.type === 'orchestrator' || agentId === 'orchestrator';
  const others = Array.from(agents.values()).filter(a => {
    if (a.id === agentId) return false;
    if (isOrchestrator || full) return true;
    return a.status === 'working' || a.status === 'error';
  });
  const lines: string[] = [];
  if (self) {
    lines.push(`Your ID: ${self.id}`);
    lines.push(`Your name: ${self.name}`);
    lines.push(`Your role: ${self.role}`);
    if (self.task) lines.push(`Your task: ${self.task}`);
  }
  if (others.length === 0) {
    lines.push(isOrchestrator ? 'No agents spawned yet.' : 'No other agents are currently active.');
    return lines.join('\n');
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
  return lines.join('\n');
}

// ============ STOP/RESUME/DELETE ============
function stopAgent(id: string): boolean {
  const a = agents.get(id);
  if (!a || a.status === 'stopped') return false;
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
  return true;
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
  // Chỉ lấy report MỚI NHẤT của mỗi agent (không dồn lịch sử)
  const reversed = [...chatHistory].reverse();
  const reports = spawnedByOrch
    .map(a => {
      const lastMsg = reversed.find(msg => msg.to === 'orchestrator' && msg.from === a.id);
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
      const result = await orchClient.chat(synthesisPrompt);
      const orchMsg: ChatMsg = { id: uuidv4(), from: 'orchestrator', to: 'user', content: result.content, timestamp: Date.now(), agentName: 'Orchestrator', agentRole: 'orchestrator' };
      chatHistory.push(orchMsg); storage.saveMessage(orchMsg);
      broadcast('chat:message', { msg: orchMsg });
    } catch (e: any) {
      console.log(`[Synthesize] Error: ${e.message}`);
    }
  }, 100);
}

// ============ COMMAND PARSING ============
function parseAgentCommands(response: string, fromId: string): string[] {
  const results: string[] = [];
  const stopRe = /\[?STOP\s+AGENT\s+target-id=(\S+)\]?/g;
  let m;
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
    deleteAgent(m[1]).then(ok => { if (ok) results.push(`Deleted ${m[1]}`); });
  }
  return results;
}

// ============ HEARTBEAT ============
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
          agent.status = 'idle';
          broadcast('agent:updated', { agent });
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

function getOrchClient(): ACPClient {
  if (!clients.has('orchestrator')) {
    clients.set('orchestrator', new ACPClient({ id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator', model: process.env.ORCHESTRATOR_MODEL }));
  }
  return clients.get('orchestrator')!;
}

// ============ API ============
app.get('/api/agents', (_req, res) => res.json(Array.from(agents.values())));

app.post('/api/agents', (req, res) => {
  const { name, role, type, spawnedBy, projectDir, task, model } = req.body;
  const id = 'agent-' + Date.now();
  const agent: Agent = {
    id, name: name || `Agent-${id.slice(-4)}`, role: role || 'coder',
    type: type || 'worker', status: 'idle', spawnedBy, projectDir, task, model, createdAt: Date.now()
  };
  agents.set(id, agent); storage.saveAgent(agent);
  broadcast('agent:created', { agent });
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
  const a = agents.get(req.params.id);
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

// ============ CHAT ============
app.post('/api/chat', async (req, res) => {
  const { message, targetAgentId, agentId } = req.body;
  const resolvedTargetId = targetAgentId || agentId;
  const targetAgent = resolvedTargetId ? agents.get(resolvedTargetId) : null;
  const commandResults: string[] = [];

  const userMsg: ChatMsg = { id: uuidv4(), from: 'user', to: resolvedTargetId || 'orchestrator', content: message, timestamp: Date.now() };
  chatHistory.push(userMsg); storage.saveMessage(userMsg);

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
    if (client.getSessionId()) {
      prompt = `[TEAM UPDATE]\n${team}\n\n[FROM: user] [TO: orchestrator] ${message}`;
    } else {
      prompt = `[TEAM]\n${team}\n[/TEAM]\n\n[FROM: user] [TO: orchestrator] ${message}`;
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
    const result = await client.enqueue(prompt);
    sid = client.getSessionId();
    if (sid) {
      if (targetAgent) {
        targetAgent.sessionId = sid;
        await syncSessionTitle(targetAgent, client);
      } else {
        storage.updateAgent('orchestrator', { sessionId: sid });
      }
    }

    const response = result.content;
    const commandResultsParse = parseAgentCommands(response, targetAgent?.id || 'orchestrator');
    commandResults.push(...commandResultsParse);

    // Parse [SPAWN] — ONLY orchestrator can spawn
    const isOrchestrator = !targetAgent;
    const spawnRe = isOrchestrator ? /\[?SPAWN\s+role=(\w+)\s+name=(\S+)\s+task=([^\]\r\n]+?)(?:\])/g : null;
    let m;
    while (spawnRe && (m = spawnRe.exec(response)) !== null) {
      const [, role, rawName, rawTask] = m;
      const name = rawName.replace(/^['"]|['"]$/g, '');
      const task = rawTask.replace(/^['"]|['"]$/g, '').trim();

      // GIỚI HẠN 3 agent mỗi loại (role)
      const sameRole = Array.from(agents.values()).filter(a => a.role === role && a.type !== 'orchestrator');
      if (sameRole.length >= 3) {
        const list = sameRole.map(a => `${a.name} (${a.id}) [${a.status}]`).join(', ');
        const errMsg = `[ERROR] Cannot spawn ${name}: max 3 agents per role "${role}" reached. Active ${role} agents: ${list}`;
        commandResults.push(errMsg);
        console.log(`[Orch] ${errMsg}`);
        continue;
      }

      const existing = findAgentByName(name);
      if (existing) {
        commandResults.push(`Reused ${name} (${existing.id})`);
        existing.status = 'working'; existing.workingSince = Date.now(); existing.task = task;
        storage.updateAgent(existing.id, { status: 'working', workingSince: existing.workingSince });
        broadcast('agent:updated', { agent: existing });
        setTimeout(async () => {
          try {
            const tc = getClient(existing);
            const spawnTeam = buildTeam(existing.id);
            const prompt = existing.sessionId
              ? `[TEAM UPDATE]\n${spawnTeam}\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${existing.name} (ID: ${existing.id}, Role: ${existing.role})\n=== MESSAGE ===\nNew task: ${task}`
              : `[TASK] ${task}\n[TEAM]\n${spawnTeam}\n[/TEAM]\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${existing.name} (ID: ${existing.id}, Role: ${existing.role})\n=== MESSAGE ===\n${task}`;
            const tr = await tc.enqueue(prompt);
            existing.sessionId = tc.getSessionId() || existing.sessionId;
            await syncSessionTitle(existing, tc);
            await parseAgentCommands(tr.content, existing.id);
            const reply: ChatMsg = { id: uuidv4(), from: existing.id, to: 'orchestrator', content: tr.content, timestamp: Date.now(), agentName: name, agentRole: role };
            chatHistory.push(reply); storage.saveMessage(reply);
            broadcast('chat:message', { msg: reply });
            saveTranscript(tr, existing.id, name, role);
            existing.status = 'idle'; existing.workingSince = undefined;
            storage.updateAgent(existing.id, { status: 'idle', sessionId: existing.sessionId, workingSince: null });
            broadcast('agent:updated', { agent: existing });
            checkAndSynthesize(existing.id);
          } catch (e: any) { existing.status = 'error'; existing.workingSince = undefined; storage.updateAgent(existing.id, { status: 'error', workingSince: null }); broadcast('agent:updated', { agent: existing }); }
        }, 100);
        continue;
      }

      // New agent — create
      const spawnId = 'agent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
      const na: Agent = {
        id: spawnId, name, role, type: 'worker', status: 'working',
        spawnedBy: targetAgent?.id || 'orchestrator', task, createdAt: Date.now(), workingSince: Date.now()
      };
      agents.set(spawnId, na); storage.saveAgent(na);
      broadcast('agent:created', { agent: na });
      commandResults.push(`Spawned ${name} (${role}) → ${spawnId}`);
      console.log(`[Orch] Spawned: ${name} (${role}) → ${spawnId}`);
      setTimeout(async () => {
        try {
          const tc = getClient(na);
          const spawnTeam = buildTeam(na.id);
          const senderHeader = `=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${na.name} (ID: ${spawnId}, Role: ${na.role})\n=== MESSAGE ===`;
          const tr = await tc.enqueue(`[TASK] ${na.task}\n[TEAM]\n${spawnTeam}\n[/TEAM]\n\n${senderHeader}\n${na.task}`);
          na.sessionId = tc.getSessionId() || undefined;
          await syncSessionTitle(na, tc);
          await parseAgentCommands(tr.content, na.id);
          const reply: ChatMsg = { id: uuidv4(), from: spawnId, to: 'orchestrator', content: tr.content, timestamp: Date.now(), agentName: name, agentRole: role };
          chatHistory.push(reply); storage.saveMessage(reply);
          broadcast('chat:message', { msg: reply });
          saveTranscript(tr, spawnId, name, role);
          na.status = 'idle'; na.workingSince = undefined;
          storage.updateAgent(na.id, { status: 'idle', sessionId: na.sessionId, workingSince: null });
          broadcast('agent:updated', { agent: na });
          checkAndSynthesize(spawnId);
        } catch (e: any) { na.status = 'error'; na.workingSince = undefined; storage.updateAgent(na.id, { status: 'error', workingSince: null }); broadcast('agent:updated', { agent: na }); }
      }, 100);
    }

    // Parse [TALK]
    const talkRe = /\[?TALK\s+agent-id=(\S+)\s+message=([^\]\r\n]+?)(?:\])/g;
    while ((m = talkRe.exec(response)) !== null) {
      const aid = m[1];
      const msg = m[2].replace(/^['"]|['"]$/g, '').trim();
      const ta = agents.get(aid);
      if (!ta) { commandResults.push(`[ERROR] TALK: agent ${aid} not found`); continue; }
      ta.status = 'working'; ta.workingSince = Date.now();
      storage.updateAgent(ta.id, { status: 'working', workingSince: ta.workingSince });
      broadcast('agent:updated', { agent: ta });
      setTimeout(async () => {
        try {
          const tc = getClient(ta);
          const talkTeam = buildTeam(ta.id);
          const senderName = targetAgent ? `${targetAgent.name} (${targetAgent.id})` : 'Orchestrator (orchestrator)';
          const talkHeader = `=== INCOMING MESSAGE ===\nFROM: ${senderName}\nTO: ${ta.name} (ID: ${ta.id}, Role: ${ta.role})\n=== MESSAGE ===`;
          const talkPrompt = ta.sessionId ? `[TEAM UPDATE]\n${talkTeam}\n\n${talkHeader}\n${msg}` : `[TEAM]\n${talkTeam}\n[/TEAM]\n\n${talkHeader}\n${msg}`;
          const tr = await tc.enqueue(talkPrompt);
          ta.sessionId = tc.getSessionId() || undefined;
          await syncSessionTitle(ta, tc);
          await parseAgentCommands(tr.content, ta.id);
          const reply: ChatMsg = { id: uuidv4(), from: aid, to: 'orchestrator', content: tr.content, timestamp: Date.now(), agentName: ta.name, agentRole: ta.role };
          chatHistory.push(reply); storage.saveMessage(reply);
          broadcast('chat:message', { msg: reply });
          saveTranscript(tr, aid, ta.name, ta.role);
          ta.status = 'idle'; ta.workingSince = undefined;
          storage.updateAgent(ta.id, { status: 'idle', sessionId: ta.sessionId, workingSince: null });
          broadcast('agent:updated', { agent: ta });
          checkAndSynthesize(ta.id);
        } catch (e: any) { ta.status = 'error'; ta.workingSince = undefined; storage.updateAgent(ta.id, { status: 'error', workingSince: null }); broadcast('agent:updated', { agent: ta }); }
      }, 100);
    }

    const aMsg: ChatMsg = { id: uuidv4(), from: targetAgent?.id || 'orchestrator', to: 'user', content: response, timestamp: Date.now(), agentName, agentRole };
    chatHistory.push(aMsg); storage.saveMessage(aMsg);
    broadcast('chat:message', { msg: aMsg });
    // Agent được chat trực tiếp xong → về idle
    if (targetAgent) {
      targetAgent.status = 'idle'; targetAgent.workingSince = undefined;
      storage.updateAgent(targetAgent.id, { status: 'idle', sessionId: targetAgent.sessionId, workingSince: null });
      broadcast('agent:updated', { agent: targetAgent });
    }
    res.json({ response, sessionId: sid, commands: commandResults });
  } catch (err: any) {
    if (targetAgent) { targetAgent.status = 'error'; targetAgent.workingSince = undefined; storage.updateAgent(targetAgent.id, { status: 'error', workingSince: null }); broadcast('agent:updated', { agent: targetAgent }); }
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

// Set model cho main (orchestrator)
app.post('/api/orchestrator/model', (req, res) => {
  const { model } = req.body || {};
  if (model) process.env.ORCHESTRATOR_MODEL = model; else delete process.env.ORCHESTRATOR_MODEL;
  clients.delete('orchestrator');
  res.json({ ok: true });
});

// Clear main conversation + session opencode
app.post('/api/orchestrator/clear', async (_req, res) => {
  try {
    const orchClient = clients.get('orchestrator');
    if (orchClient) {
      const sid = orchClient.getSessionId();
      if (sid) await orchClient.deleteSession(sid);
    }
    clients.delete('orchestrator');
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
    console.log('[Clear] Orchestrator conversation + session cleared');
    res.json({ ok: true });
  } catch (e: any) {
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
startHeartbeat();

process.on('SIGINT', () => { if (heartbeatTimer) clearInterval(heartbeatTimer); storage.close(); server.close(); process.exit(0); });
server.listen(PORT, () => console.log(`\n🚀 AgentForge v7: http://localhost:${PORT}\n`));
