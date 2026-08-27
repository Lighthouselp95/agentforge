// AgentForge v7 — Multi-Agent Orchestrator (run transport)
import express from 'express';
import { createServer } from 'http';
import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { ACPClient } from './agents/acp-client.js';
import type { TokenUsage } from './agents/types.js';
import { storage, MAX_PERSISTED_MESSAGES } from './storage.js';

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(new URL('.', import.meta.url)));
const APP_VERSION = '0.2.0';
const PORT = parseInt(process.env.PORT || '3001');

// SEA early: phai khai bao TRUOC loadPrompt de exe copy 1 file van doc duoc src/prompts nhung trong blob
import { createRequire as _crTop } from 'module';
let earlySeaGetAsset: ((key: string) => ArrayBuffer) | null = null;
try {
  const _rTop = _crTop(import.meta.url);
  const _seaTop = _rTop('node:sea') as any;
  if (typeof _seaTop.isSea === 'function' && _seaTop.isSea()) {
    earlySeaGetAsset = _seaTop.getAsset;
  }
} catch {}
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
// Safety net: never crash the whole process on a WebSocket-level error
wss.on('error', (err: any) => {
  console.error(`[WS] WebSocket server error:`, err?.message || err);
});
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
// SEA-aware: exe chay tu release/ thi process.cwd()=release/ nen src/prompts khong thay.
// Thu lan luot nhieu vi tri cho toi khi tim thay file.
const PROMPTS_CANDIDATE_DIRS = [
  join(process.cwd(), 'src', 'prompts'),
  join(dirname(process.execPath), 'src', 'prompts'),
  join(dirname(process.execPath), '..', 'src', 'prompts'),
  join(__dirname, '..', 'src', 'prompts'),
  join(__dirname, 'prompts'),
];

function loadPrompt(name: string): string {
  // 1) SEA embedded: khi exe copy 1 file sang thu muc khac (CWD moi) van co prompt day du, dong thoi van tao .opencode tai CWD cho opencode dung
  if (earlySeaGetAsset) {
    try {
      const key = ('src/prompts/' + name).split('\\').join('/');
      const buf = earlySeaGetAsset(key);
      if (buf) return Buffer.from(buf).toString('utf-8');
    } catch {}
  }
  // 2) Filesystem: chay tu source (npm run start) hoac release co src ke ben
  for (const dir of PROMPTS_CANDIDATE_DIRS) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf-8'); } catch {}
    }
  }
  console.warn(`[Prompt] Not found: ${name} (tried ${PROMPTS_CANDIDATE_DIRS.join(' | ')}), using fallback`);
  return '';
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

5. CREATE ROLE — Create a new custom agent role with a .md prompt file:
   [CREATE ROLE name=<role-name> description=<what this role does> capabilities=<cap1,cap2,cap3> rules=<rule1|rule2|rule3>]
   After creating, you can [SPAWN role=<role-name> ...] to use it.
   Rules are separated by | (pipe). Capabilities are separated by , (comma).

=== RULES ===
1. ALWAYS decompose user tasks into specific subtasks before spawning
2. Each SPAWN must have: role, name (short lowercase), task (specific with file paths)
3. Run independent tasks in parallel (spawn multiple agents at once)
4. REUSE ONLY IF IDLE: If you SPAWN a name that already exists, reuse it ONLY when that agent is currently 'idle'. If it is 'working', you MUST spawn a new name or choose another idle agent. Do not assign new work to a working agent.
5. Orchestrator TUYỆT ĐỐI KHÔNG được xóa agent. Khi một agent không còn cần thiết, bị lỗi hoặc kẹt, Orchestrator chỉ được [STOP] agent và báo cáo/đề xuất User xóa agent trên giao diện.
6. Instance limit rules by role: coder role is limited to a maximum of 4 active instances. All other roles (researcher, verifier, tester, reviewer, docs, planner, debugger, searcher, idea) are limited to a maximum of 2 active instances. Custom roles default to a maximum of 2 active instances.
7. IDLE-FIRST dispatch: Before any [TALK]/[SPAWN], check the [TEAM] table and ONLY select agents whose status is 'idle'. If no idle agent exists for the required role, spawn a new instance. When the system sends '[Role Limit]', immediately switch to [TALK] with an available idle agent instead of spawning.
8. RESEARCH FIRST RULE: Before implementing any changes, fixing bugs, or writing code, you MUST first research the codebase, read the relevant files, check documentation, or search online resources to gather context and understand the implementation details.
9. Monitor progress — if an agent works > 3 minutes, use TALK to ask for status
10. If an agent is stuck, STOP it then RESUME with clearer instructions
11. When all agents report back, summarize results to the user
12. NEVER do the coding work yourself — delegate to specialist agents
13. If existing roles don't fit, CREATE ROLE first, then SPAWN with it
14. Use existing roles first — only CREATE ROLE when necessary

=== EXAMPLES ===
User: "Build a Python calculator with tests"
You respond with:
[SPAWN role=coder name=calc task=Create calculator.py with add(a,b), subtract(a,b), multiply(a,b), divide(a,b) functions. Add type validation and division by zero handling.]
[SPAWN role=tester name=test task=Create test_calculator.py with unit tests for all calculator functions. Test edge cases: type errors, division by zero, negative numbers.]

Example multi-coder parallel decomposition:
TASK: Build user auth with tests and docs
SUBTASKS:
1. [coder] auth-backend: Implement JWT auth in src/auth.ts
2. [coder] auth-frontend: Add login form in src/App.tsx
3. [tester] auth-test: Write unit tests in tests/auth.test.ts
4. [docs] auth-doc: Write README section for auth flow
DEPENDENCIES: 3 depends on 1; 4 depends on 1 and 2
PARALLEL_GROUPS: [1,2] run together; [3,4] run after 1 and 2 complete

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

Always decompose tasks before spawning. Do NOT do the work yourself. Orchestrator CANNOT delete agents; use [STOP AGENT] and ask the user to delete if necessary. Respond to the user in a clear, concise way.`;

const WORKER_REMINDER = `\n\n=== SYSTEM REMINDER ===
Use [TO: <target-id>] <message> for communications.
Finish with [TO: orchestrator] Task complete. === TASK REPORT ===`;

function buildWorkerPrompt(role?: string, agent?: Agent, isInitial?: boolean): string {
  // Kiến trúc SSoT: Toàn bộ Base Rules, Role Rules và Formats đã được đồng bộ sẵn vào .opencode/agents/<role>.md.
  // Mỗi turn chỉ cần reminder ngắn gọn để tối ưu token payload và giảm độ trễ tối đa.
  return WORKER_REMINDER;
}

// ============ SSoT PROMPT SYNC TO .OPENCODE/AGENTS ============
// SEA-aware: release/agentforge-web.exe co cwd=release/ -> phai tim dung project root
function resolveServerProjectRoot(): string {
  const candidates = [
    process.cwd(),
    dirname(process.execPath),
    join(dirname(process.execPath), '..'),
    join(__dirname, '..'),
    join(__dirname, '../..'),
  ];
  for (const r of candidates) {
    if (existsSync(join(r, 'package.json'))) return r;
  }
  let best: string | null = null;
  let bestSize = -1;
  for (const r of candidates) {
    const p = join(r, 'data', 'agentforge-state.json');
    if (existsSync(p)) {
      try {
        const sz = statSync(p).size;
        if (sz > bestSize) { bestSize = sz; best = r; }
      } catch {}
    }
    if (existsSync(join(r, '.opencode')) && best === null) best = r;
  }
  if (best) return best;
  return process.cwd();
}
const SERVER_PROJECT_ROOT = resolveServerProjectRoot();
const OPENCODE_AGENTS_DIR = join(SERVER_PROJECT_ROOT, '.opencode', 'agents');

const ROLE_DESCRIPTIONS: Record<string, string> = {
  coder: 'Writes clean, correct, robust, production-ready code',
  verifier: 'Validates code correctness, edge cases, tests, and compliance',
  researcher: 'Finds information, explores codebases, reads documentation',
  debugger: 'Traces bugs, finds root causes, and fixes issues with minimal changes',
  docs: 'Writes clear, comprehensive, and up-to-date technical documentation',
  idea: 'Generates creative concepts, architectural approaches, and improvements',
  searcher: 'Locates files, functions, patterns, and references fast',
  reviewer: 'Reviews code quality, architecture, security, and performance',
  planner: 'Analyzes user tasks and creates detailed execution plans',
  tester: 'Writes and executes automated unit and integration tests',
  orchestrator: 'Main Orchestrator of AgentForge'
};

function syncOpencodeAgents() {
  try {
    mkdirSync(OPENCODE_AGENTS_DIR, { recursive: true });
    
    // Load Base Rules & Formats
    const workerBase = loadPrompt('worker-base.md') || '';
    const taskReportFormat = loadPrompt(join('formats', 'task-report.md')) || '';
    const agentMsgFormat = loadPrompt(join('formats', 'agent-message.md')) || '';
    const errorReportFormat = loadPrompt(join('formats', 'error-report.md')) || '';
    const formatsSection = [taskReportFormat, agentMsgFormat, errorReportFormat].filter(Boolean).join('\n\n');

    // 1. Sync Orchestrator
    const orchPrompt = loadPrompt('orchestrator.md') || ORCH_PROMPT;
    const orchAgentContent = `---
name: orchestrator
description: ${ROLE_DESCRIPTIONS.orchestrator}
mode: primary
permission:
  "*": deny
  glob: allow
  webfetch: allow
  websearch: allow
  edit:
    "*": deny
    "*.md": allow
  read:
    "*": allow
---

${orchPrompt}
`;
    writeFileSync(join(OPENCODE_AGENTS_DIR, 'orchestrator.md'), orchAgentContent, 'utf-8');
    console.log(`[SSoT] Synced .opencode/agents/orchestrator.md`);

    // 2. Sync all worker roles
    const standardRoles = Object.keys(ROLE_DESCRIPTIONS).filter(r => r !== 'orchestrator');
    const rolesDir = PROMPTS_CANDIDATE_DIRS.map(d => join(d, 'roles')).find(d => existsSync(d)) || join(PROMPTS_CANDIDATE_DIRS[0], 'roles');
    let roleFiles: string[] = [];
    if (existsSync(rolesDir)) {
      roleFiles = readdirSync(rolesDir).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
    }
    const allRoles = Array.from(new Set([...standardRoles, ...roleFiles]));

    for (const role of allRoles) {
      const rolePrompt = loadPrompt(join('roles', `${role}.md`));
      const desc = ROLE_DESCRIPTIONS[role] || `${role} worker agent`;
      
      const fullPrompt = `---
name: ${role}
description: ${desc}
mode: primary
permission:
  "*": allow
  task: deny
---

${workerBase}

${rolePrompt ? rolePrompt : `# Role: ${role}\nYou are the ${role} specialist worker agent.`}

${formatsSection}
`;
      writeFileSync(join(OPENCODE_AGENTS_DIR, `${role}.md`), fullPrompt, 'utf-8');
      console.log(`[SSoT] Synced .opencode/agents/${role}.md`);
    }
  } catch (err: any) {
    console.warn(`[SSoT] Failed to sync .opencode/agents: ${err.message}`);
  }
}

// ============ STATE ============
interface Agent {
  id: string; name: string; role: string; type: 'orchestrator' | 'worker';
  status: 'idle' | 'working' | 'error' | 'stopped';
  spawnedBy?: string; projectDir?: string; model?: string;
  sessionId?: string; sessionTitle?: string; task?: string; createdAt: number;
  workingSince?: number;
  tokenUsage?: TokenUsage;
  contextLength?: number;
}
interface ChatMsg {
  id: string; from: string; to: string; content: string;
  timestamp: number; agentName?: string; agentRole?: string;
  msgType?: string;
  // Dữ liệu toolcall cấu trúc lấy từ event gốc của opencode (nguồn cho UI toolcall)
  toolCalls?: Array<{ tool: string; input?: string; output?: string }>;
  // Suy nghĩ nội bộ của model (reasoning/thinking) — tách khỏi content
  thinking?: string;
}

const agents = new Map<string, Agent>();
const clients = new Map<string, ACPClient>();
const chatHistory: ChatMsg[] = [];
const wsClients = new Set<WebSocket>();
const sseClients = new Set<express.Response>();

// Track unread messages for orchestrator — workers reply to orchestrator
const unreadForOrchestrator: ChatMsg[] = [];
// Track message IDs sent to orchestrator batch to prevent duplicates
const trackedMessageIds = new Set<string>();

// Prevent duplicate synthesis when multiple agents complete simultaneously
const synthesisTriggered = new Set<string>();

// Max chat history to prevent unbounded memory growth
const MAX_HISTORY = MAX_PERSISTED_MESSAGES; // lưu bền vững ≥15.000 tin (đồng bộ cap persist trong storage)

// Abort idempotency guards — prevent multiple concurrent aborts for same agent
const abortingAgents = new Set<string>();

// Track per-agent retry counts
const agentRetryCount = new Map<string, number>();

// ============ CUSTOM ROLES ============
const AGENTS_DIR = join(SERVER_PROJECT_ROOT, '.opencode', 'agents');
const CUSTOM_ROLES_PATH = join(SERVER_PROJECT_ROOT, 'data', 'custom-roles.json');

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
      if (row.name === '...' || row.id === 'agent-b895e808' || !/^[a-z0-9_-]{2,30}$/i.test(row.name)) {
        // Tự động bỏ qua và xóa các agent rác không hợp lệ
        storage.deleteAgent(row.id);
        continue;
      }
      const agent: Agent = {
        id: row.id, name: row.name, role: row.role, type: row.type,
        status: row.status === 'working' ? 'idle' : row.status,
        spawnedBy: row.spawned_by, projectDir: row.project_dir, 
        model: row.model || undefined,
        sessionId: row.session_id || undefined,
        sessionTitle: row.session_title ? String(row.session_title).normalize('NFC') : undefined,
        task: row.task ? String(row.task).normalize('NFC') : undefined,
        createdAt: row.created_at, workingSince: undefined,
        tokenUsage: row.token_usage || undefined,
        contextLength: row.context_length || undefined
      };
      agents.set(agent.id, agent);
      // Collect session entries for restoring agentSessions static map for all agents
      if (row.session_id && row.id) {
        sessionEntries.push({ agentId: row.id, sessionId: row.session_id });
      }
    }
    // Restore ACPClient.agentSessions map for all agents
    ACPClient.restoreAgentSessions(sessionEntries);
    if (!agents.has('orchestrator')) {
      const savedOrchModel = storage.getSetting('orchestratorModel', process.env.ORCHESTRATOR_MODEL);
      const orch: Agent = {
        id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator',
        status: 'idle', createdAt: Date.now(),
        model: savedOrchModel ? String(savedOrchModel).trim() : undefined
      };
      agents.set('orchestrator', orch);
      storage.saveAgent(orch);
    }
    console.log(`[Storage] Loaded ${savedAgents.length} agents, restored ${sessionEntries.length} orchestrator sessions`);
    const savedHistory = storage.loadHistory(500) as any[];
    for (const row of savedHistory) {
      chatHistory.push({
        id: row.id,
        from: row.from || row.from_id,
        to: row.to || row.to_id,
        content: row.content,
        timestamp: row.timestamp,
        agentName: row.agentName || row.agent_name,
        agentRole: row.agentRole || row.agent_role,
        msgType: row.msgType || row.msg_type || 'chat'
      });
    }
    console.log(`[Storage] Loaded ${savedHistory.length} messages`);
  } catch (e: any) { console.log(`[Storage] Load error: ${e.message}`); }
}

function broadcast(type: string, data: any) {
  const payload = { type, ...data };
  const msg = JSON.stringify(payload);
  
  // WebSocket broadcast
  wsClients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });

  // SSE broadcast
  const sseData = `data: ${msg}\n\n`;
  sseClients.forEach(res => {
    try {
      res.write(sseData);
      if (typeof (res as any).flush === 'function') (res as any).flush();
    } catch {
      sseClients.delete(res);
    }
  });
}

/** Get and consume unread messages for orchestrator with deduplication */
function consumeUnreadForOrchestrator(): ChatMsg[] {
  const msgs: ChatMsg[] = [];
  while (unreadForOrchestrator.length > 0) {
    const msg = unreadForOrchestrator.shift();
    if (!msg) continue;
    if (msg.id && trackedMessageIds.has(msg.id)) {
      continue;
    }
    if (msg.id) {
      trackedMessageIds.add(msg.id);
    }
    msgs.push(msg);
  }
  // Keep trackedMessageIds bounded to prevent memory leak
  if (trackedMessageIds.size > 2000) {
    const iterator = trackedMessageIds.values();
    for (let i = 0; i < 500; i++) {
      const next = iterator.next();
      if (next.done) break;
      trackedMessageIds.delete(next.value);
    }
  }
  return msgs;
}

/** Add a message to orchestrator's unread queue */
function addUnreadForOrchestrator(msg: ChatMsg) {
  // Chỉ thêm tin gửi tới orchestrator (không phải từ user hay orchestrator)
  if (msg.to === 'orchestrator' && msg.from !== 'orchestrator' && msg.from !== 'user') {
    if (msg.id && trackedMessageIds.has(msg.id)) {
      return;
    }
    unreadForOrchestrator.push(msg);
  }
}

// Phát mọi I/O terminal của opencode (input prompt + từng dòng JSONL output) lên UI
// dưới dạng message msgType 'opencode' gắn với agent tương ứng (chỉ hiện ở khung chat agent).
// Làm sạch terminal escape: GỠ các CSI điều khiển KHÔNG phải màu (cursor move v.v.),
// nhưng GIỮ NGUYÊN mã màu SGR kết thúc bằng 'm' (vd [32m, [1m) để frontend AnsiRenderer tô màu.
function stripAnsi(text: any): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-NPRZcf-nqry=><]/g, '');
}

function broadcastOACEvent(agentId: string, ev: any) {
  try {
    // Tách RỜI lời thoại và toolcall: content CHỈ chứa lời thoại,
    // toolCalls CHỈ chứa tool — tuyệt đối không trộn lẫn.
    let textLines: string[] = [];
    const toolCalls: Array<{ tool: string; input?: any; output?: any }> = [];
    let evThinking = '';
    const asText = (v: any): string | undefined => {
      if (v === undefined || v === null) return undefined;
      return typeof v === 'string' ? v : JSON.stringify(v);
    };
    if (ev?.kind === 'in') {
      const p = (ev.prompt || '').toString();
      textLines.push(`▶ INPUT (gửi opencode):\n${p}`);
    } else if (ev?.kind === 'batch' && Array.isArray(ev.events)) {
      for (const item of ev.events) {
        if (item?.kind === 'in') {
          textLines.push(`▶ INPUT (gửi opencode):\n${item.prompt || ''}`);
          continue;
        }
        const e = item?.event;
        if (!e || typeof e !== 'object') continue;
        const t = e.type || e.evt || 'event';
        // Bỏ qua event nội bộ step lifecycle (step_start/step_finish) — chỉ là metadata
        // đếm token, không phải nội dung hội thoại → không render lên chat UI.
        const tt = String(t).toLowerCase().replace(/-/g, '_');
        if (tt === 'step_start' || tt === 'step_finish') continue;
        // Chuẩn hoá biến thể tên event tool
        const isToolUse = t === 'tool_use' || t === 'tool-call' || t === 'tool_call';
        const isToolResult = t === 'tool_result' || t === 'tool';
        if (t === 'text' && e.part?.text) {
          textLines.push(e.part.text);
        } else if (isToolUse || isToolResult) {
          const p = e.part || {};
          const st: any = p.state || {};
          const input = asText(isToolUse ? (p.input ?? st.input) : (p.input ?? st.input));
          const outputRaw = asText(isToolUse ? (p.output ?? st.output) : (p.output ?? st.output ?? p.content ?? e.data?.output));
          const output = outputRaw === undefined ? undefined : stripAnsi(outputRaw);
          // Đẩy vào mảng cấu trúc — UI render hộp toolcall riêng, KHÔNG đụng textLines
          toolCalls.push({
            tool: String(p.tool || (isToolResult ? 'result' : 'unknown')),
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {})
          });
        } else if (t === 'error') {
          textLines.push(`✖ ERROR: ${e.error?.data?.message || e.error?.message || e.error?.name || JSON.stringify(e.error) || 'unknown'}`);
        } else if (tt === 'thinking' || tt === 'reasoning' || tt === 'thought') {
          // Suy nghĩ nội bộ: gom riêng vào msg.thinking, KHÔNG trộn vào textLines
          const rt = e.part?.text || e.text || e.part?.thinking || e.thinking;
          if (typeof rt === 'string' && rt.trim()) evThinking += (evThinking ? '\n' : '') + rt;
        } else if (t === 'assistant' || t === 'user' || t === 'system' || t === 'session' || t === 'init' || t === 'done') {
          const txt = e.part?.text || e.message || e.content || (e.parts ? JSON.stringify(e.parts) : '');
          if (txt) textLines.push(`${t.toUpperCase()}: ${txt}`);
        } else {
          // Fallback: compact JSON cho các loại event khác — vẫn là TEXT, không phải tool
          textLines.push(`◆ ${t}: ${JSON.stringify(e).slice(0, 2000)}`);
        }
      }
    }
    if (textLines.length === 0 && toolCalls.length === 0 && !evThinking) return;
    const msg: any = {
      id: `oac-${agentId}-${ev?.seq ?? 0}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: agentId,
      to: agentId,
      content: textLines.join('\n\n'), // Chỉ chứa lời thoại!
      timestamp: Date.now(),
      msgType: 'opencode',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined, // Chỉ chứa ToolCall!
      thinking: evThinking || undefined // Suy nghĩ nội bộ (hộp mờ riêng)
    };
    broadcast('chat:message', { msg });
  } catch (err) {
    console.error('[OAC] broadcastOACEvent error:', err);
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

// Chấp nhận MỌI biến thể báo cáo chuẩn của các role (task/research/verification/error)
const REPORT_BLOCK_RE = /===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===/i;
const TASK_COMPLETE_RE = /Task complete\./i;

// Validate worker response contains proper completion format (only for workers, not orchestrator)
function validateWorkerCompletion(content: string, agent: Agent): { valid: boolean; reason?: string } {
  if (agent.type === 'orchestrator' || agent.id === 'orchestrator') {
    return { valid: true };
  }
  if (!content || content.trim().length === 0) {
    return { valid: false, reason: 'Empty response' };
  }
  const hasToOrchestrator = /\[TO:\s*orchestrator\]/i.test(content);
  const hasReportBlock = REPORT_BLOCK_RE.test(content);
  const hasCompletion = TASK_COMPLETE_RE.test(content) || /STATUS:\s*completed/i.test(content);

  // AUTO-ROUTE: worker quên gắn [TO: orchestrator] nhưng có report hợp lệ
  // → backend tự coi đích đến là Orchestrator, KHÔNG BAO GIỜ đánh rơi tin.
  if (!hasToOrchestrator && hasReportBlock) {
    console.log(`[Validate] ${agent.name}: missing [TO: orchestrator] but has report block — auto-route to orchestrator`);
    return { valid: true };
  }
  if (!hasToOrchestrator) {
    return { valid: false, reason: 'Missing [TO: orchestrator] tag - response not directed to orchestrator' };
  }
  if (!hasReportBlock && !hasCompletion) {
    return { valid: false, reason: 'Missing REPORT format (TASK/RESEARCH/VERIFICATION/ERROR REPORT hoặc Task complete.)' };
  }
  return { valid: true };
}

// Called when worker agent successfully completes - clear retry tracking
function clearAgentRetry(agentId: string) {
  agentRetryCount.delete(agentId);
}

// Đồng bộ title session opencode → Agent (tiêu đề khung chat)
// TỐI ƯU HÓA THÔNG MINH: Nếu agent ĐÃ CÓ TÊN RỒI -> return ngay lập tức (0 subprocess).
// Chỉ fetch 1 lần duy nhất cho session mới tạo chưa có tên, sau khi lấy được lưu vĩnh viễn vào database.
async function syncSessionTitle(agent: Agent, client: ACPClient, _retries = 1, isNewSession = false) {
  if (agent.sessionTitle && agent.sessionTitle.trim().length > 0) {
    return;
  }

  const sid = client.getSessionId();
  if (!sid) return;

  // Gán tên ngay trong memory từ task của agent nếu có để UI hiển thị tức thì
  const defaultTitle = agent.task ? agent.task.slice(0, 60) : `Session ${sid.slice(-6)}`;
  agent.sessionTitle = defaultTitle;
  agent.sessionId = sid;
  ACPClient.registerSession(agent.id, sid);
  storage.updateAgent(agent.id, { sessionId: sid, sessionTitle: agent.sessionTitle });
  broadcast('agent:updated', { agent });
  
  // Thử lấy title async từ opencode 1 lần duy nhất trong nền nếu cần
  try {
    const stats = await client.getSessionStats(sid);
    if (stats && stats.title && stats.title !== agent.sessionTitle) {
      agent.sessionTitle = stats.title;
      agent.sessionId = sid;
      ACPClient.registerSession(agent.id, sid);
      storage.updateAgent(agent.id, { 
        sessionId: sid, 
        sessionTitle: stats.title
      });
      broadcast('agent:updated', { agent });
      console.log(`[Title] Resolved permanent session title for ${agent.name}: "${stats.title}"`);
    }
  } catch {}
}

function resolveOrchestratorModel(): string | undefined {
  const orchAgent = agents.get('orchestrator');
  if (orchAgent?.model && orchAgent.model.trim()) return orchAgent.model.trim();
  const saved = storage.getSetting('orchestratorModel', process.env.ORCHESTRATOR_MODEL);
  if (saved && String(saved).trim()) return String(saved).trim();
  return process.env.ORCHESTRATOR_MODEL || process.env.DEFAULT_MODEL || undefined;
}

function resolveModelForAgent(agent: Agent): string | undefined {
  if (agent.id === 'orchestrator' || agent.type === 'orchestrator' || agent.role === 'orchestrator') {
    return resolveOrchestratorModel();
  }
  const overrides: Record<string, string> = storage.getSetting('agentModelOverrides', {});
  // Priority 1: Agent direct model override or overrides map by id/name/role
  if (agent.model && agent.model.trim()) return agent.model.trim();
  if (agent.id && overrides[agent.id]?.trim()) return overrides[agent.id].trim();
  if (agent.name && overrides[agent.name]?.trim()) return overrides[agent.name].trim();
  if (agent.role && overrides[`role:${agent.role}`]?.trim()) return overrides[`role:${agent.role}`].trim();
  if (agent.role && overrides[agent.role]?.trim()) return overrides[agent.role].trim();

  // Priority 2: Default Subagent Model
  const defSubagent = storage.getSetting('defaultSubagentModel', process.env.DEFAULT_SUBAGENT_MODEL);
  if (defSubagent && String(defSubagent).trim()) return String(defSubagent).trim();

  // Priority 3: Default System Model (Orchestrator Model / Default Model)
  const orchModel = resolveOrchestratorModel();
  if (orchModel && orchModel.trim()) return orchModel.trim();
  return process.env.DEFAULT_MODEL || undefined;
}

function getClient(agent: Agent): ACPClient {
  const model = resolveModelForAgent(agent);
  if (!clients.has(agent.id)) {
    const c = new ACPClient({ id: agent.id, name: agent.name, role: agent.role, type: 'worker', projectDir: agent.projectDir, model });
    c.setOnEvent((ev: any) => broadcastOACEvent(agent.id, ev));
    clients.set(agent.id, c);
  } else {
    const c = clients.get(agent.id)!;
    if (model) c.setModel(model);
  }
  const client = clients.get(agent.id)!;
  if (client.getSessionId() !== (agent.sessionId || null)) {
    client.setSession(agent.sessionId || null);
  }
  return client;
}

// ============ TEAM CONTEXT VERSIONING ============
// membershipVersion: CHỈ tăng khi SPAWN hoặc DELETE agent (thay đổi thành phần team).
// Status đổi (idle/working/stopped) KHÔNG tăng version — chỉ hiển thị trên Dashboard UI, không bơm vào prompt.
let membershipVersion = 1;
// lastTeamVersionDelivered: version [TEAM UPDATE] cuối cùng đã được inject cho từng agent.
// Chỉ inject lại khi membershipVersion > lastTeamVersionDelivered[agentId].
const lastTeamVersionDelivered = new Map<string, number>();

function notifyTeamChanged() {
  // CHỈ được gọi tại SPAWN (agents.set) hoặc DELETE agent — KHÔNG bao giờ tại status change.
  membershipVersion++;
}

function shouldIncludeTeamContext(agentId: string, hasExplicitChange = false): boolean {
  if (hasExplicitChange) {
    lastTeamVersionDelivered.set(agentId, membershipVersion);
    return true;
  }
  const lastDelivered = lastTeamVersionDelivered.get(agentId) || 0;
  if (lastDelivered < membershipVersion) {
    lastTeamVersionDelivered.set(agentId, membershipVersion);
    return true;
  }
  return false;
}

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

function buildTeam(agentId: string, full: boolean = true): string {
  const self = agents.get(agentId);
  const isOrchestrator = self?.type === 'orchestrator' || agentId === 'orchestrator' || String(agentId || '').toLowerCase() === 'orchestrator' || self?.role === 'orchestrator';
  // Liệt kê đầy đủ 100% tất cả agent (cả idle, working, stopped, error) kèm ID và name
  const others = Array.from(agents.values()).filter(a => {
    if (a.id === agentId) return false;
    if (a.id === 'orchestrator' || a.type === 'orchestrator') return false;
    return true;
  });
  const suffix = isOrchestrator ? '' : WORKER_FORMAT_BLOCK;
  const lines: string[] = [];
  if (self) {
    lines.push(`Your ID: ${self.id}`);
    lines.push(`Your name: ${self.name}`);
    lines.push(`Your role: ${self.role}`);
    if (self.task) lines.push(`Your task: ${self.task.normalize('NFC')}`);
  }
  if (others.length === 0) {
    lines.push(isOrchestrator ? 'No active agents.' : 'No other agents are currently active.');
    return (lines.join('\n') + (self?.sessionId ? '' : suffix)).normalize('NFC');
  }
  const roleCounts: Record<string, number> = {};
  others.forEach(a => { roleCounts[a.role] = (roleCounts[a.role] || 0) + 1; });
  lines.push(`\nActive Team: ${others.length} agents - ${Object.entries(roleCounts).map(([r,c]) => `${c}x ${r}`).join(', ')}`);
  lines.push('\nMembers:');
  others.forEach(a => {
    const wt = a.workingSince ? ` (${Math.round((Date.now() - a.workingSince) / 1000)}s working)` : '';
    const taskInfo = a.task ? ` | Task: ${a.task.normalize('NFC')}` : '';
    lines.push(`  - ${a.name} (${a.role}) [${a.status}]${taskInfo}${wt} | ID: ${a.id}`);
  });
  return (lines.join('\n') + (self?.sessionId ? '' : suffix)).normalize('NFC');
}

const buildTeamBlock = buildTeam;

// ============ STOP/RESUME/DELETE ============
function stopAgent(id: string, stoppedBy: 'user' | 'orchestrator' | 'error' = 'user', errorDetail?: string): boolean {
  const a = agents.get(id);
  if (!a || a.status === 'stopped') return false;
  // Abort process thật sự nếu agent đang chạy (kill opencode tree) — tránh mồ côi
  const client = clients.get(id);
  if (client) {
    try { client.abort(); } catch {}
  }
  a.status = (stoppedBy === 'error') ? 'error' : 'stopped';
  a.workingSince = undefined;
  clients.delete(a.id);
  storage.updateAgent(a.id, { status: a.status, workingSince: null });
  broadcast('agent:updated', { agent: a });

  // Tạo thông báo chuẩn hóa theo loại stop
  let stopText = `🛑 [STOPPED] Agent ${a.name} was stopped by ${stoppedBy}.`;
  let msgType: ChatMsg['msgType'] = (stoppedBy === 'user') ? 'stop_user' : (stoppedBy === 'orchestrator') ? 'stop_orchestrator' : 'stop_error';
  if (stoppedBy === 'error') {
    stopText = `❌ [CRASHED] Agent ${a.name} stopped due to error: ${errorDetail || 'Unknown error'}`;
  }
  const stopMsg: ChatMsg = {
    id: uuidv4(),
    from: a.id,
    to: 'orchestrator',
    content: stopText,
    timestamp: Date.now(),
    agentName: a.name,
    agentRole: a.role,
    msgType: msgType
  };
  chatHistory.push(stopMsg);
  storage.saveMessage(stopMsg);
  broadcast('chat:message', { msg: stopMsg });

  console.log(`[Stop] ${a.name} (${a.id}) by ${stoppedBy}`);
  return true;
}

function resumeAgent(id: string): boolean {
  const a = agents.get(id);
  if (!a || a.status !== 'stopped') return false;
  a.status = 'idle';
  storage.updateAgent(a.id, { status: 'idle' });
  broadcast('agent:updated', { agent: a });
  // KHÔNG notifyTeamChanged() ở đây — chỉ member change (spawn/delete) mới cần update team context
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
    const needReinject = client.getNeedPromptReinject() || !agent.sessionId;
    if (needReinject) client.setNeedPromptReinject(false);
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
    const prompt = (agent.sessionId && !needReinject)
      ? `[TEAM UPDATE]\n${team}\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (orchestrator)\nTO: ${agent.name} (${agent.id})\n=== MESSAGE ===\n${resumeMsg}`
      : `[TASK] ${agent.task || 'General task'}\n[TEAM]\n${team}\n[/TEAM]\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator\nTO: ${agent.name} (${agent.id})\n=== MESSAGE ===\n${resumeMsg}`;
    const result = await client.enqueue(`${prompt}\n\n${buildWorkerPrompt(agent.role, agent, !agent.sessionId || needReinject)}`);
    const newSid = client.getSessionId();
    const isNewSession = Boolean(newSid && newSid !== agent.sessionId);
    agent.sessionId = newSid || agent.sessionId;
    if (result.tokenUsage) {
      // Giu nguyen TokenUsage chuan tu model API (object {inputTokens, outputTokens, totalTokens,...})
      agent.tokenUsage = result.tokenUsage;
    }
    if (result.contextLength) agent.contextLength = result.contextLength;
    if (agent.sessionId) ACPClient.registerSession(agent.id, agent.sessionId);
    storage.updateAgent(agent.id, { 
      sessionId: agent.sessionId, 
      tokenUsage: agent.tokenUsage, 
      contextLength: agent.contextLength 
    });
    broadcast('agent:updated', { agent });
    syncSessionTitle(agent, client, 3, isNewSession).catch(() => {});

    await handleAgentResponse(result.content, agent, 'orchestrator', result.toolCalls, result.thinking);
    saveTranscript(result, agent.id, agent.name, agent.role);

    agent.status = 'idle';
    agent.workingSince = undefined;
    storage.updateAgent(agent.id, { 
      status: 'idle', 
      sessionId: agent.sessionId, 
      workingSince: null,
      tokenUsage: agent.tokenUsage,
      contextLength: agent.contextLength
    });
    broadcast('agent:updated', { agent });
    checkAndSynthesize(agent.id);
  } catch (e: any) {
    const isAborted = e.message?.toLowerCase().includes('abort') || e.message?.toLowerCase().includes('aborted');
    if (isAborted) return;
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
  if (id === 'orchestrator') {
    throw new Error('Cannot delete orchestrator agent');
  }

  const a = agents.get(id) || (storage.getAgent(id) as any);
  const client = clients.get(id);

  // 1. Abort tiến trình con nếu đang chạy
  if (client) {
    try {
      client.abort();
    } catch (e: any) {
      console.warn(`[Delete] Failed to abort client for agent ${id}:`, e?.message || e);
    }
  }

  // 2. Xóa session mapping trong ACPClient
  ACPClient.unregisterSession(id);

  // 3. Xóa dọn session trong OpenCode storage
  const sid = a?.sessionId || a?.session_id || (client ? client.getSessionId() : null);
  if (client) {
    try {
      await client.deleteSession(sid || undefined);
    } catch (e: any) {
      console.warn(`[Delete] Error deleting OpenCode session via client for agent ${id}:`, e?.message || e);
    }
  } else if (sid) {
    try {
      const tmpClient = new ACPClient({ id, name: a?.name || id, role: a?.role || 'worker', type: 'worker' });
      tmpClient.setSession(sid);
      await tmpClient.deleteSession();
    } catch (e: any) {
      console.warn(`[Delete] Error deleting OpenCode session via tmpClient for agent ${id}:`, e?.message || e);
    }
  }

  // 4. Xóa toàn bộ conversation và transcript khỏi Database storage
  storage.clearAgentConversation(id);

  // 5. Xóa tin nhắn khỏi bộ nhớ RAM chatHistory
  const remainingChat = chatHistory.filter(m => m.from !== id && m.to !== id);
  chatHistory.length = 0;
  chatHistory.push(...remainingChat);

  // 6. Xóa tin nhắn chưa đọc của orchestrator và retry count
  const remainingUnread = unreadForOrchestrator.filter(m => m.from !== id && m.to !== id);
  unreadForOrchestrator.length = 0;
  unreadForOrchestrator.push(...remainingUnread);
  agentRetryCount.delete(id);

  // 7. Xóa toàn bộ agent khỏi Database storage
  storage.deleteAgent(id);

  // 9. Xóa khỏi memory map
  clients.delete(id);
  agents.delete(id);

  // 10. Broadcast sự kiện agent:deleted
  broadcast('agent:deleted', { id, agentId: id });
  notifyTeamChanged();
  console.log(`[Delete] ${a ? (a.name || a.role || id) : id} (${id}) — session and history cleaned up and removed`);
  return !!a;
}

function findAgentByName(name: string): Agent | undefined {
  const nameLower = String(name || '').toLowerCase();
  for (const [, agent] of agents) if (String(agent.name || '').toLowerCase() === nameLower) return agent;
  return undefined;
}

// ============ ROLE LIMIT & ENFORCEMENT ============
// coder max 4; mọi role khác (researcher, verifier, tester, reviewer, docs, planner,
// debugger, searcher, idea, và các custom role chưa định nghĩa) max 2.
function getRoleLimit(role: string): number {
  const r = (role || '').toLowerCase().trim();
  if (r === 'coder') return 4;
  return 2;
}

function getAgentsByRole(role: string): Agent[] {
  const r = (role || '').toLowerCase().trim();
  return Array.from(agents.values()).filter(a => a.type === 'worker' && a.id !== 'orchestrator' && (a.role || '').toLowerCase().trim() === r);
}

// Automatically delete the oldest agent of the role to free quota when spawning a new agent
async function autoPruneExcessAgents(role: string): Promise<boolean> {
  const limit = getRoleLimit(role);
  const currentAgents = getAgentsByRole(role);
  if (currentAgents.length > limit) {
    currentAgents.sort((a, b) => a.createdAt - b.createdAt);
    const numToDelete = currentAgents.length - limit;
    for (let i = 0; i < numToDelete; i++) {
      const toDelete = currentAgents[i];
      console.warn(`[Role Limit Prune] Role '${role}' has exceeded limit ${limit} (currently ${currentAgents.length}). Auto-deleting oldest agent ${toDelete.name} (${toDelete.id}).`);
      await deleteAgent(toDelete.id);
    }
    return true;
  }
  return false;
}

// ============ SYNTHESIZE ============
let synthesizeDebounceTimer: NodeJS.Timeout | null = null;
const SYNTHESIZE_DEBOUNCE_MS = 1800; // 1.8s debounce cooldown gom tat ca worker hoan thanh

function checkAndSynthesize(completedAgentId: string) {
  const completedAgent = agents.get(completedAgentId);
  if (!completedAgent) return;
  const spawnedByOrch = Array.from(agents.values()).filter(a => a.spawnedBy === 'orchestrator');
  if (spawnedByOrch.length === 0) return;
  const allDone = spawnedByOrch.every(a => a.status === 'idle' || a.status === 'error');
  if (!allDone) return;
  
  // Reset previous debounce timer if new agents are finishing
  if (synthesizeDebounceTimer) {
    clearTimeout(synthesizeDebounceTimer);
    synthesizeDebounceTimer = null;
  }

  synthesizeDebounceTimer = setTimeout(async () => {
    synthesizeDebounceTimer = null;
    const currentSpawned = Array.from(agents.values()).filter(a => a.spawnedBy === 'orchestrator');
    if (currentSpawned.length === 0) return;
    const stillAllDone = currentSpawned.every(a => a.status === 'idle' || a.status === 'error');
    if (!stillAllDone) return;

    // Guard: prevent duplicate synthesis for the same batch of agents
    const batchKey = currentSpawned.map(a => a.id).sort().join(',');
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
    const reports = currentSpawned
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
    console.log(`[Synthesize] Debounced: Sending ${currentSpawned.length} reports to orchestrator`);
    try {
      // Main dùng enqueue: tin tổng hợp xếp hàng nếu main đang bận (không mất khi busy)
      const result = await orchClient.enqueue(synthesisPrompt);
      // Fix badge token = 0: cập nhật usage sau turn tổng hợp của Orchestrator
      const synthOrchAgent = agents.get('orchestrator');
      if (synthOrchAgent && (result.tokenUsage || result.contextLength)) {
        if (result.tokenUsage) synthOrchAgent.tokenUsage = result.tokenUsage;
        if (result.contextLength) synthOrchAgent.contextLength = result.contextLength;
        storage.updateAgent('orchestrator', {
          ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
          ...(result.contextLength ? { contextLength: result.contextLength } : {})
        });
      }
      const cleanContent = stripCommandTags(result.content).trim().normalize('NFC');

      if (cleanContent && !isOrchestratorResponseDuplicate(cleanContent)) {
        const orchMsg: ChatMsg = { id: uuidv4(), from: 'orchestrator', to: 'user', content: cleanContent, timestamp: Date.now(), agentName: 'Orchestrator', agentRole: 'orchestrator' };
        chatHistory.push(orchMsg); storage.saveMessage(orchMsg);
        trimChatHistory();
        broadcast('chat:message', { msg: orchMsg });
      }
      await handleOrchestratorResponse(result.content, (result as any).thinking || '');
    } catch (e: any) {
      console.log(`[Synthesize] Error: ${e.message}`);
    }
  }, SYNTHESIZE_DEBOUNCE_MS);
}

function trimChatHistory() {
  if (chatHistory.length > MAX_HISTORY) {
    chatHistory.splice(0, chatHistory.length - MAX_HISTORY);
  }
}

// ============ COMMAND PARSING ============
async function parseAgentCommands(response: string, fromId: string): Promise<string[]> {
  const results: string[] = [];
  const cleanResponse = sanitizeCommandInput(response);
  const stopRe = /\[?STOP\s+(?:AGENT\s+)?(?:target-id|agent-id|target|id)=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))\]?/gi;
  let m: RegExpExecArray | null;
  while ((m = stopRe.exec(cleanResponse)) !== null) {
    const rawTarget = m[1] || m[2] || m[3];
    const target = findAgentByIdNameOrRole(rawTarget);
    const targetId = target ? target.id : rawTarget;
    if (stopAgent(targetId, 'orchestrator')) results.push(`Stopped ${targetId}`);
    else results.push(`Could not stop ${rawTarget}`);
  }
  const resumeRe = /\[?RESUME\s+(?:AGENT\s+)?(?:target-id|agent-id|target|id)=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))\]?/gi;
  while ((m = resumeRe.exec(cleanResponse)) !== null) {
    const rawTarget = m[1] || m[2] || m[3];
    const target = findAgentByIdNameOrRole(rawTarget);
    const targetId = target ? target.id : rawTarget;
    if (resumeAgent(targetId)) results.push(`Resumed ${targetId}`);
    else results.push(`Could not resume ${rawTarget}`);
  }
  const deleteRe = /\[?DELETE\s+(?:AGENT\s+)?(?:target-id|agent-id|target|id)=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))\]?/gi;
  while ((m = deleteRe.exec(cleanResponse)) !== null) {
    const rawTarget = m[1] || m[2] || m[3];
    const target = findAgentByIdNameOrRole(rawTarget);
    const targetId = target ? target.id : rawTarget;
    const targetName = target ? target.name : rawTarget;
    console.warn(`[Command] [DELETE AGENT] command from ${fromId} for ${targetName} (${targetId}) was blocked. Only User can delete agents.`);
    results.push(`DELETE command ignored for ${targetName} (${targetId}): Only User has permission to delete agents from UI.`);
    const warnMsg: ChatMsg = {
      id: uuidv4(),
      from: 'system',
      to: 'all',
      content: `[SYSTEM WARNING] Orchestrator/Agent attempted to delete agent "${targetName}" (${targetId}). Automatic deletion via text commands is disabled. Only the User can permanently delete agents via the Web UI. Orchestrator should use [STOP AGENT] instead.`,
      timestamp: Date.now(),
      agentName: 'System',
      agentRole: 'system'
    };
    chatHistory.push(warnMsg);
    storage.saveMessage(warnMsg);
    broadcast('chat:message', { msg: warnMsg });
  }
  return results;
}

// ============ TITLE POLLER ============
// Periodically fetch missing titles for agents that have sessionId but no sessionTitle.
// TỐI ƯU HÓA: Chỉ poll gom nhóm 1 lần cho các agent thiếu title với chu kỳ 60s (tránh subprocess spam).
let titlePollerTimer: ReturnType<typeof setInterval> | null = null;

function startTitlePoller() {
  titlePollerTimer = setInterval(async () => {
    // 1. Chỉ lọc ra các agent CÓ sessionId NHƯNG CHƯA CÓ sessionTitle
    const agentsMissingTitle = Array.from(agents.values()).filter(a => a.sessionId && !a.sessionTitle && a.type !== 'orchestrator');
    if (agentsMissingTitle.length === 0) return;

    try {
      // 2. Gom lại chỉ gọi CLI 'opencode session list' ĐÚNG 1 LẦN DUY NHẤT cho toàn bộ batch
      const projectDir = process.cwd();
      const { stdout } = await execAsync('opencode session list --format json', {
        cwd: projectDir, encoding: 'utf-8', timeout: 5000
      });
      const sessions = JSON.parse(stdout) as any[];

      // 3. Map kết quả cho các agent thiếu title
      for (const agent of agentsMissingTitle) {
        const found = sessions.find((s: any) => s.id === agent.sessionId);
        if (found && (found.title || found.slug)) {
          agent.sessionTitle = found.title || found.slug;
          storage.updateAgent(agent.id, { sessionTitle: agent.sessionTitle });
          broadcast('agent:updated', { agent });
          console.log(`[TitlePoll] Resolved missing title for ${agent.name}: "${agent.sessionTitle}"`);
        }
      }
    } catch {}
  }, 60000); // Tăng interval từ 10s lên 60s
}

// Watchdog / auto-timeout has been disabled: agents only stop on explicit command from User or Orchestrator.
function isWatchdogEnabled(): boolean {
  return false;
}
function startWorkerWatchdog() {
  // No-op: automatic timeout and auto-stop mechanisms removed
}

const INVALID_TARGET_PLACEHOLDERS = new Set([
  'target-id', '<target-id>', 'agent-id', '<agent-id>', 'id', '<id>',
  'target', '<target>', 'worker', '<worker>', 'recipient', '<recipient>',
  'your-id', '<your-id>', 'name/id', '<name/id>', 'verifier-name/id', '<verifier-name/id>',
  'undefined', 'null', 'none', 'unknown',
  '${targetagent.id}', '\\${targetagent.id}', '${agent.id}', '\\${agent.id}',
  '${targetid}', '\\${targetid}', '${id}', '\\${id}', '${name}', '\\${name}',
  'targetagent.id', 'agent.id', 'targetid'
]);

function cleanTargetIdentifier(val: string): string {
  if (!val) return '';
  let cleaned = val.trim();
  cleaned = cleaned.replace(/^[<"'\s]+|[>"'\s]+$/g, '').trim();
  const prefixRegex = /^(?:target|target-id|agent-id|id|to)\s*=\s*(.*)$/i;
  const match = cleaned.match(prefixRegex);
  if (match) {
    cleaned = match[1].trim();
  }
  cleaned = cleaned.replace(/^[<"'\s]+|[>"'\s]+$/g, '').trim();
  if (INVALID_TARGET_PLACEHOLDERS.has(cleaned.toLowerCase()) || /^<.*>$/.test(cleaned) || /^\$?\{.*\}$/.test(cleaned)) {
    return '';
  }
  return cleaned;
}

function findAgentByIdNameOrRole(identifier: string): Agent | undefined {
  if (!identifier) return undefined;
  const cleanId = cleanTargetIdentifier(identifier);
  if (!cleanId) return undefined;
  const idLower = cleanId.toLowerCase();
  if (INVALID_TARGET_PLACEHOLDERS.has(idLower) || idLower === 'worker' || idLower === 'target-id' || idLower === 'agent-id') {
    return undefined;
  }
  if (agents.has(cleanId)) return agents.get(cleanId);
  for (const [, agent] of agents) {
    if (String(agent.name || '').toLowerCase() === idLower) return agent;
  }
  for (const [, agent] of agents) {
    if (String(agent.role || '').toLowerCase() === idLower) return agent;
  }
  return undefined;
}

// ============ BALANCED BRACKET COMMAND PARSER ============
interface BracketCommand {
  tag: string;           // Tên thẻ: 'TALK', 'SPAWN', 'CREATE ROLE', etc.
  content: string;       // Nội dung bên trong cặp ngoặc ngoài cùng
  fullMatch: string;     // Chuỗi đầy đủ bao gồm cả cặp ngoặc [TAG ...]
  startIndex: number;
  endIndex: number;
}

/**
 * Trích xuất một lệnh [TAG ...] duy nhất bắt đầu từ startIndex sử dụng thuật toán đếm ngoặc cân bằng kết hợp phân tích boundary payload.
 */
function extractBracketCommand(text: string, startIndex: number): { tag: string; content: string; fullMatch: string; endIndex: number } | null {
  if (!text || startIndex < 0 || startIndex >= text.length || text[startIndex] !== "[") return null;
  
  const tagMatch = text.substring(startIndex + 1).match(/^([A-Za-z_]+(?:\s+[A-Z_]+)*)/);
  if (!tagMatch) return null;
  const tag = tagMatch[1];

  let endIdx = -1;
  let depth = 1; // startIndex is already '['
  let inQuote: string | null = null;

  for (let i = startIndex + 1; i < text.length; i++) {
    const char = text[i];
    const prevChar = text[i - 1];

    if (inQuote) {
      if (char === inQuote && prevChar !== "\\") {
        inQuote = null;
      }
    } else {
      if (char === '"' || char === "'" || char === '`' || char === '“' || char === '”') {
        inQuote = char === '“' ? '”' : char;
      } else if (char === '[') {
        depth++;
      } else if (char === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
  }

  if (endIdx !== -1 && endIdx >= startIndex) {
    const fullMatch = text.substring(startIndex, endIdx + 1);
    const inner = fullMatch.startsWith('[') && fullMatch.endsWith(']')
      ? fullMatch.substring(1, fullMatch.length - 1).trim()
      : fullMatch.replace(/^\[/, '').trim();
    const content = inner.substring(tag.length).trim();
    return { tag, content, fullMatch, endIndex: endIdx + 1 };
  } else {
    const nextTag = text.indexOf('\n[', startIndex + 1);
    const fallbackEnd = nextTag !== -1 ? nextTag : text.length;
    const fullMatch = text.substring(startIndex, fallbackEnd);
    const inner = fullMatch.replace(/^\[/, '').trim();
    const content = inner.substring(tag.length).trim();
    return { tag, content, fullMatch, endIndex: fallbackEnd };
  }
}

/** Code-span helper: BO QUA tag nam trong `...` inline hoac ```...``` fenced */
function getCodeSpanRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      if (end !== -1) { ranges.push([i, end + 3] as [number, number]); i = end + 3; continue; }
      ranges.push([i, text.length] as [number, number]); break;
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) { ranges.push([i, end + 1] as [number, number]); i = end + 1; continue; }
    }
    i++;
  }
  return ranges;
}
function isInCodeSpan(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

/**
 * Trích xuất các lệnh [TAG ...] sử dụng thuật toán đếm ngoặc cân bằng (Balanced Bracket).
 * Quản lý chính xác độ sâu lồng nhau và trạng thái quote để xử lý các message phức tạp.
 */
function extractBracketCommands(text: string, targetTags: string[] = ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME']): BracketCommand[] {
  const commands: BracketCommand[] = [];
  if (!text) return commands;
  // FIX strip-backtick: bo qua tag nam trong `inline` hoac ```fenced``` code span
  const codeRanges = getCodeSpanRanges(text);

  let pos = 0;
  while (pos < text.length) {
    let earliestTag: string | null = null;
    let earliestIdx = -1;

    for (const tag of targetTags) {
      let searchFrom = pos;
      while (true) {
        const idx = text.indexOf(`[${tag}`, searchFrom);
        if (idx === -1) break;
        const nextChar = text[idx + 1 + tag.length];
        const boundaryOk = !nextChar || /\s|:|\]|=/.test(nextChar);
        // Chi chap nhan tag NGOAI code-span (backtick don / ba backtick)
        if (boundaryOk && !isInCodeSpan(idx, codeRanges)) {
          if (earliestIdx === -1 || idx < earliestIdx) {
            earliestIdx = idx;
            earliestTag = tag;
          }
          break;
        }
        searchFrom = idx + 1; // match nam trong code-span -> thu vi tri ke tiep
      }
    }

    if (earliestIdx === -1 || !earliestTag) {
      break;
    }

    const cmd = extractBracketCommand(text, earliestIdx);
    if (cmd) {
      commands.push({
        tag: earliestTag,
        content: cmd.content,
        fullMatch: cmd.fullMatch,
        startIndex: earliestIdx,
        endIndex: cmd.endIndex
      });
      pos = cmd.endIndex;
    } else {
      pos = earliestIdx + 1 + earliestTag.length;
    }
  }

  return commands;
}

function stripCommandTags(text: string): string {
  if (!text) return '';
  const commands = extractBracketCommands(text, ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT']);
  if (commands.length === 0) return text.trim();
  let result = '';
  let lastIndex = 0;
  for (const cmd of commands) {
    result += text.substring(lastIndex, cmd.startIndex);
    lastIndex = cmd.endIndex;
  }
  result += text.substring(lastIndex);
  // Xóa sạch hoàn toàn các thẻ lệnh standalone còn sót lại.
  // FIX strip-backtick: chỉ strip tag NẰM NGOÀI code-span; tag trong `...` / ```...``` giữ nguyên
  // (tránh nuốt trắng ví dụ: "Phải dùng `[RESUME AGENT target-id=...]` để khởi động lại").
  const cleanRanges = getCodeSpanRanges(result);
  if (cleanRanges.length === 0) {
    result = result.replace(/\[(?:TALK|SPAWN|CREATE ROLE|STOP|RESUME)[^\]]*\]?/gi, '');
  } else {
    let rebuilt = '';
    let scanPos = 0;
    while (scanPos < result.length) {
      const nextRange = cleanRanges.find(([s]) => s >= scanPos);
      const segEnd = nextRange ? nextRange[0] : result.length;
      const segment = result.substring(scanPos, segEnd);
      rebuilt += segment.replace(/\[(?:TALK|SPAWN|CREATE ROLE|STOP|RESUME)[^\]]*\]?/gi, '');
      if (nextRange) {
        rebuilt += result.substring(nextRange[0], nextRange[1]); // giữ nguyên code-span
        scanPos = nextRange[1];
      } else {
        scanPos = result.length;
      }
    }
    result = rebuilt;
  }
  return result.trim();
}

function parseTalkTag(tagContent: string): { agentId: string; message: string; task?: string } | null {
  if (!tagContent) return null;
  
  const paramRe = /\b(agent-id|agent_id|target-id|target_id|target|agent|to|id|message|msg|content|task)\s*=\s*/gi;
  const found: Array<{ key: string; keyStart: number; valueStart: number }> = [];
  let pm: RegExpExecArray | null;
  while ((pm = paramRe.exec(tagContent)) !== null) {
    const before = tagContent.substring(0, pm.index);
    const inDouble = ((before.match(/"/g) || []).length % 2) === 1;
    const inSingle = ((before.match(/'/g) || []).length % 2) === 1;
    if (inDouble || inSingle) continue;
    found.push({ key: (pm[1] ?? "").toLowerCase(), keyStart: pm.index, valueStart: pm.index + pm[0].length });
  }

  const stripQuotes = (v: string): string => {
    const t = v.trim();
    if (t.length >= 2 &&
        ((t.startsWith('"') && t.endsWith('"')) ||
         (t.startsWith("'") && t.endsWith("'")) ||
         (t.startsWith('“') && t.endsWith('”')))) {
      return t.substring(1, t.length - 1).trim();
    }
    if (t.startsWith('"') || t.startsWith("'") || t.startsWith('“')) {
      const closingQuote = t[0] === '“' ? '”' : t[0];
      const lastQuote = t.lastIndexOf(closingQuote);
      if (lastQuote > 0) return t.substring(1, lastQuote).trim();
      return t.substring(1).trim();
    }
    return t;
  };

  const valueOf = (keys: string[]): string | undefined => {
    const p = found.find(f => keys.includes(f.key));
    if (!p) return undefined;
    const idx = found.indexOf(p);
    const end = idx + 1 < found.length ? found[idx + 1].keyStart : tagContent.length;
    return stripQuotes(tagContent.substring(p.valueStart, end));
  };

  const rawId = valueOf(["agent-id", "agent_id", "target-id", "target_id", "target", "agent", "to", "id"]);
  const agentId = cleanTargetIdentifier(rawId || "");
  const message = valueOf(["message", "msg", "content"]);
  const task = valueOf(["task"]);

  const finalMessage = (message && message.trim()) || (task && task.trim());
  if (agentId && finalMessage) {
    const trimmedTask = task && task.trim() ? task.trim() : undefined;
    return { agentId, message: finalMessage, ...(trimmedTask ? { task: trimmedTask } : {}) };
  }
  return null;
}

function parseAgentOutput(content: string, defaultTo: string = 'orchestrator'): { to: string; message: string }[] {
  const matches: { to: string; message: string }[] = [];
  if (!content) return matches;

  // Extract [TALK ...] commands
  const talks = parseOrchestratorCommands(content);
  for (const talk of talks) {
    let resolvedTo = 'orchestrator';
    let cleanTo = cleanTargetIdentifier(talk.agentId);
    if (!cleanTo || cleanTo.toLowerCase() === 'orchestrator' || cleanTo.toLowerCase() === 'main') {
      resolvedTo = 'orchestrator';
    } else if (cleanTo.toLowerCase() === 'user') {
      resolvedTo = 'user';
    } else {
      const found = findAgentByIdNameOrRole(cleanTo);
      resolvedTo = found ? found.id : cleanTo;
    }
    matches.push({ to: resolvedTo, message: talk.message });
  }

  const cleanContent = stripCommandTags(content);

  // Match [TO: ...] optionally preceded by [FROM: ...]
  // Handles quotes, whitespace, and angle brackets like [TO: <orchestrator>] or [TO: "agent-1"]
  const tagRegex = /(?:\[FROM:\s*[^\]]+\]\s*)?\[TO:\s*([^\]]+)\]/gi;

  const tagMatches: Array<{ index: number; length: number; rawTo: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(cleanContent)) !== null) {
    tagMatches.push({
      index: m.index,
      length: m[0].length,
      rawTo: m[1]
    });
  }

  if (tagMatches.length === 0) {
    // No [TO: ...] tags found. Strip any standalone [FROM: ...] tags from output
    const finalClean = cleanContent.replace(/\[FROM:\s*[^\]]+\]/gi, '').trim();
    if (finalClean) {
      matches.push({ to: defaultTo, message: finalClean });
    }
    return matches;
  }

  // Check if there is meaningful text before the first [TO: ...] tag
  const preText = cleanContent.substring(0, tagMatches[0].index);
  const cleanPreText = preText.replace(/\[FROM:\s*[^\]]+\]/gi, '').trim();
  if (cleanPreText) {
    matches.push({ to: defaultTo, message: cleanPreText });
  }

  for (let i = 0; i < tagMatches.length; i++) {
    const cur = tagMatches[i];
    const startIndex = cur.index + cur.length;
    const endIndex = (i + 1 < tagMatches.length) ? tagMatches[i + 1].index : cleanContent.length;

    let msgText = cleanContent.substring(startIndex, endIndex).trim();
    // Clean trailing [FROM: ...] if left at the end before next tag or end of string
    msgText = msgText.replace(/\[FROM:\s*[^\]]+\]\s*$/i, '').trim();

    // Clean destination
    let cleanTo = cleanTargetIdentifier(cur.rawTo);
    let resolvedTo = 'orchestrator';
    if (!cleanTo || cleanTo.toLowerCase() === 'orchestrator' || cleanTo.toLowerCase() === 'main') {
      resolvedTo = 'orchestrator';
    } else if (cleanTo.toLowerCase() === 'user') {
      resolvedTo = 'user';
    } else {
      const found = findAgentByIdNameOrRole(cleanTo);
      resolvedTo = found ? found.id : cleanTo;
    }

    if (msgText) {
      matches.push({ to: resolvedTo, message: msgText });
    }
  }

  // Deduplicate: nếu có 2 message cùng target + cùng nội dung → chỉ giữ 1
  const seen = new Set<string>();
  const deduped: typeof matches = [];
  for (const m of matches) {
    const key = `${m.to}|||${m.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(m);
    }
  }
  return deduped;
}

// Strip code blocks and blockquotes to avoid parsing example tags as real commands
function sanitizeCommandInput(text: string): string {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, '') // strip fenced code blocks
    .replace(/`[^`\n]*`/g, '')      // strip inline code
    .replace(/^\s*>.*$/gm, '');     // strip blockquotes
}

function parseSpawnTags(text: string): Array<{ role: string; name: string; task: string }> {
  const spawns: Array<{ role: string; name: string; task: string }> = [];
  if (!text) return spawns;
  
  // Trích xuất lệnh SPAWN nằm NGOÀI code-span (tránh bắt nhầm ví dụ trong code block / backtick)
  const commands = extractBracketCommands(text, ['SPAWN']);
  
  const INVALID_PLACEHOLDERS = new Set(['<role>', '<name>', '<task>', 'role', 'name', 'task', '...', 'none', 'undefined', 'null', 'your-name', '<your-name>']);

  for (const cmd of commands) {
    const attrsText = cmd.content;
    const roleMatch = attrsText.match(/role=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    const nameMatch = attrsText.match(/name=(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|(\S+))/i);
    
    const taskRegex = /task\s*=\s*/i;
    const taskMatch = attrsText.match(taskRegex);
    
    if (roleMatch && nameMatch && taskMatch) {
      let role = (roleMatch[1] || roleMatch[2] || roleMatch[3] || '').trim().toLowerCase();
      let name = (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4] || '').trim();
      
      // Loại bỏ dấu ngoặc nhọn <...> hoặc ngoặc kép nếu còn sót
      role = cleanTargetIdentifier(role);
      name = cleanTargetIdentifier(name);

      // Chặn placeholder rác không hợp lệ
      if (!role || !name || INVALID_PLACEHOLDERS.has(role) || INVALID_PLACEHOLDERS.has(name.toLowerCase())) {
        console.warn(`[SpawnParse] Bỏ qua SPAWN chứa placeholder không hợp lệ: role="${role}", name="${name}"`);
        continue;
      }

      // Tên và role phải tuân thủ format an toàn
      if (!/^[a-z0-9_-]{2,40}$/i.test(role) || !/^[a-z0-9_-]{2,40}$/i.test(name)) {
        console.warn(`[SpawnParse] Bỏ qua SPAWN với format tên/role không hợp lệ: role="${role}", name="${name}"`);
        continue;
      }

      const taskIndex = attrsText.search(taskRegex);
      const valStart = taskIndex + taskMatch[0].length;
      let rawTask = attrsText.substring(valStart).trim();
      
      if ((rawTask.startsWith('"') && rawTask.endsWith('"')) ||
          (rawTask.startsWith("'") && rawTask.endsWith("'")) ||
          (rawTask.startsWith('“') && rawTask.endsWith('”'))) {
        rawTask = rawTask.substring(1, rawTask.length - 1);
      } else if (rawTask.startsWith('"') || rawTask.startsWith("'") || rawTask.startsWith('“')) {
        const quote = rawTask[0];
        const closingQuote = quote === '“' ? '”' : quote;
        const lastQuote = rawTask.lastIndexOf(closingQuote);
        if (lastQuote > 0) {
          rawTask = rawTask.substring(1, lastQuote);
        }
      }
      
      const task = rawTask.trim().normalize('NFC');
      if (task && !INVALID_PLACEHOLDERS.has(task.toLowerCase())) {
        spawns.push({ role, name, task });
        console.log(`[SpawnParse] Hợp lệ: role=${role} name=${name} task="${task.slice(0, 60)}..."`);
      } else {
        console.warn(`[SpawnParse] Bỏ qua SPAWN do task rỗng hoặc là placeholder.`);
      }
    } else {
      console.warn(`[SpawnParse] Lệnh SPAWN không đủ thuộc tính role/name/task: attrs=${JSON.stringify(attrsText.slice(0, 150))}`);
    }
  }
  return spawns;
}

function parseOrchestratorCommands(text: string): Array<{ agentId: string; message: string; task?: string }> {
  const talks: Array<{ agentId: string; message: string; task?: string }> = [];
  if (!text) return talks;
  const commands = extractBracketCommands(text, ['TALK']);
  for (const cmd of commands) {
    const parsed = parseTalkTag(cmd.content);
    if (parsed) {
      talks.push(parsed);
    }
  }
  return talks;
}

// ============ ORCHESTRATOR TRIGGER DEBOUNCE & BATCHING ============
let orchTriggerDebounceTimer: NodeJS.Timeout | null = null;
let pendingOrchTriggers: Array<{ fromAgent: Agent; message: string; reportId: string; attempts: number; targetOrchId?: string }> = [];
let lastOrchestratorMessageHash: string = '';
let lastOrchestratorMessageTime: number = 0;
const ORCH_TRIGGER_DEBOUNCE_MS = 1500; // 1.5s debounce gom báo cáo từ nhiều worker
const ORCH_DEDUPLICATION_WINDOW_MS = 15000; // 15s deduplication window
const ORCH_MAX_RETRY = 5; // số lần retry in-session trước khi chờ restart replay
const ABORT_ERROR_PATTERN = /Agent operation aborted by user|turn failed/i;
// Auto-wakeup khi worker im lặng nhưng có tool_use thật: throttle 30s/agent chống loop
const TOOL_WAKEUP_THROTTLE_MS = 30000;
const lastToolWakeupAt = new Map<string, number>();

function isOrchestratorResponseDuplicate(content: string): boolean {
  if (!content || !content.trim()) return true;
  const hash = content.trim().normalize('NFC').replace(/\s+/g, ' ');
  const now = Date.now();
  if (hash === lastOrchestratorMessageHash && (now - lastOrchestratorMessageTime < ORCH_DEDUPLICATION_WINDOW_MS)) {
    return true;
  }
  lastOrchestratorMessageHash = hash;
  lastOrchestratorMessageTime = now;
  return false;
}

function resolveOrchestratorTarget(fromAgent: Agent): string {
  const parentId = fromAgent.spawnedBy;
  if (!parentId) return 'orchestrator';
  const parent = agents.get(parentId) || (storage.getAgent(parentId) as any);
  if (parent && parent.type === 'orchestrator') return parent.id;
  return 'orchestrator';
}

async function triggerOrchestrator(fromAgent: Agent, message: string, existingReportId?: string) {
  const targetOrchId = resolveOrchestratorTarget(fromAgent);
  const reportId = existingReportId || uuidv4();
  if (!existingReportId) {
    // Chỉ persist khi là report mới — replay sẽ tái dùng chính reportId cũ để không sinh bản trùng
    storage.enqueueOutbox({
      id: reportId,
      fromAgentId: fromAgent.id,
      fromAgentName: fromAgent.name,
      fromAgentRole: fromAgent.role,
      to: targetOrchId,
      message,
      createdAt: Date.now(),
      attempts: 0,
      status: 'pending'
    });
  }
  pendingOrchTriggers.push({ fromAgent, message, reportId, attempts: 0, targetOrchId });

  if (orchTriggerDebounceTimer) {
    clearTimeout(orchTriggerDebounceTimer);
    orchTriggerDebounceTimer = null;
  }

  orchTriggerDebounceTimer = setTimeout(async () => {
    orchTriggerDebounceTimer = null;
    await processOrchestratorTriggerQueue();
  }, ORCH_TRIGGER_DEBOUNCE_MS);
}

// Output rỗng tuyệt đối hoặc sentinel "(No response)" từ opencode:
// KHÔNG tạo turn mới (trigger orchestrator / deliver talk) — chỉ hiển thị lên UI cho minh bạch.
// Đây KHÔNG phải dedup filter: mọi nội dung có ký tự thực đều được forward 100% như cũ.
function isEmptyAgentOutput(text: string | undefined | null): boolean {
  const t = (text || '').trim();
  return t.length === 0 || t === '(No response)';
}

async function processOrchestratorTriggerQueue() {
  if (pendingOrchTriggers.length === 0) {
    return;
  }

  const targets = Array.from(new Set(pendingOrchTriggers.map(t => t.targetOrchId || 'orchestrator')));

  for (const orchId of targets) {
    const client = getOrchClient(orchId);
    if (client.isBusy()) {
      // Nếu Orchestrator đang bận, hẹn giờ 1s thử lại để không làm rơi tin nhắn trong hàng đợi
      if (!orchTriggerDebounceTimer) {
        orchTriggerDebounceTimer = setTimeout(processOrchestratorTriggerQueue, 1000);
      }
      continue;
    }

    const batchIndices: number[] = [];
    const batch = pendingOrchTriggers.filter((t, idx) => {
      if ((t.targetOrchId || 'orchestrator') === orchId) {
        batchIndices.push(idx);
        return true;
      }
      return false;
    });
    if (batch.length === 0) continue;

    for (let i = batchIndices.length - 1; i >= 0; i--) {
      pendingOrchTriggers.splice(batchIndices[i], 1);
    }

    let orchAgent = agents.get(orchId);
    if (!orchAgent) {
      orchAgent = { id: orchId, name: (orchId === 'orchestrator' ? 'Orchestrator' : `Orchestrator-${orchId.slice(-4)}`), role: 'orchestrator', type: 'orchestrator', status: 'idle', createdAt: Date.now() };
      agents.set(orchId, orchAgent);
    }
    orchAgent.status = 'working';
    orchAgent.workingSince = Date.now();
    storage.updateAgent(orchId, { status: 'working', workingSince: orchAgent.workingSince });
    broadcast('agent:updated', { agent: orchAgent } as any);
    
    const needReinject = client.getNeedPromptReinject() || !client.getSessionId();
    if (needReinject) client.setNeedPromptReinject(false);

    const combinedHeaders = batch.map(({ fromAgent, message }) => 
      `=== INCOMING MESSAGE ===\nFROM: ${fromAgent.name} (ID: ${fromAgent.id}, Role: ${fromAgent.role})\nTO: ${orchAgent.name || 'Orchestrator'} (${orchId})\n=== MESSAGE ===\n${message}`
    ).join('\n\n');
    
    let prompt = '';
    const includeTeam = shouldIncludeTeamContext(orchId, !client.getSessionId() || needReinject);
    if (includeTeam) {
      const team = buildTeam(orchId);
      prompt = (client.getSessionId() && !needReinject)
        ? `[TEAM UPDATE]\n${team}\n\n${combinedHeaders}`
        : `[TEAM]\n${team}\n[/TEAM]\n\n${combinedHeaders}`;
    } else {
      prompt = combinedHeaders;
    }
    if (!client.getSessionId() || needReinject) {
      prompt += ORCH_REMINDER;
    }
    
    try {
      const result = await client.enqueue(prompt);
      // Đánh dấu mọi report trong batch đã gửi thành công (xóa khỏi outbox)
      for (const item of batch) storage.markOutboxDelivered(item.reportId);
      const sid = client.getSessionId();
      if (orchAgent) {
        // Fix badge token = 0: cập nhật usage sau mỗi turn Orchestrator
        if (result.tokenUsage) orchAgent.tokenUsage = result.tokenUsage;
        if (result.contextLength) orchAgent.contextLength = result.contextLength;
        if (sid) {
          const isNewSession = orchAgent.sessionId !== sid;
          orchAgent.sessionId = sid;
          ACPClient.registerSession(orchId, sid);
          storage.updateAgent(orchId, {
            sessionId: sid,
            ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
            ...(result.contextLength ? { contextLength: result.contextLength } : {})
          });
          if (isNewSession || !orchAgent.sessionTitle) {
            syncSessionTitle(orchAgent, client, 1, isNewSession).catch(() => {});
          }
        } else if (result.tokenUsage || result.contextLength) {
          storage.updateAgent(orchId, {
            ...(result.tokenUsage ? { tokenUsage: result.tokenUsage } : {}),
            ...(result.contextLength ? { contextLength: result.contextLength } : {})
          });
        }
      }
      const cleanUserContent = stripCommandTags(result.content).trim().normalize('NFC');

      // Deduplication check: Chặn gửi nhiều phản hồi trùng nhau cho người dùng trong vòng 15s
      if (cleanUserContent && !isOrchestratorResponseDuplicate(cleanUserContent)) {
        const orchMsg: ChatMsg = {
          id: uuidv4(),
          from: orchId,
          to: 'user',
          content: cleanUserContent,
          timestamp: Date.now(),
          agentName: orchAgent.name || 'Orchestrator',
          agentRole: 'orchestrator'
        };
        chatHistory.push(orchMsg);
        storage.saveMessage(orchMsg);
        broadcast('chat:message', { msg: orchMsg });
      } else if (cleanUserContent) {
        console.log(`[Orchestrator] Suppressed duplicate response to user (within 15s): "${cleanUserContent.slice(0, 50)}..."`);
      }
      
      await handleOrchestratorResponse(result.content, (result as any).thinking || '');
    } catch (e: any) {
      console.log(`[Orchestrator Trigger] Error: ${e.message}`);
      // Lỗi Abort: xóa khỏi Outbox NGAY, không retry (chống vòng lặp spam lỗi aborted)
      const isAborted = e.message?.toLowerCase().includes('abort') || e.message?.toLowerCase().includes('aborted');
      for (const item of batch) {
        if (isAborted) {
          storage.markOutboxDelivered(item.reportId);
        } else {
          storage.markOutboxFailed(item.reportId, e.message);
          if (item.attempts < ORCH_MAX_RETRY) {
            pendingOrchTriggers.push({ fromAgent: item.fromAgent, message: item.message, reportId: item.reportId, attempts: item.attempts + 1, targetOrchId: orchId });
          }
        }
      }
    } finally {
      orchAgent.status = 'idle';
      orchAgent.workingSince = undefined;
      storage.updateAgent(orchId, { status: 'idle', workingSince: null });
      broadcast('agent:updated', { agent: orchAgent } as any);
      if (pendingOrchTriggers.length > 0) {
        if (orchTriggerDebounceTimer) clearTimeout(orchTriggerDebounceTimer);
        orchTriggerDebounceTimer = setTimeout(processOrchestratorTriggerQueue, 1500);
      }
    }
  }
}

// Lọc bỏ nhiễu toolcall trong content gửi về Orchestrator/main: dòng "● [TOOL ...]", "[TOOL RESULT ...]", "🔧 ..."
function stripToolNoiseForOrchestrator(text: string): string {
  return (text || '')
    .split('\n')
    .filter(l => !/^\s*●\s*\[TOOL/i.test(l) && !/^\s*\[TOOL RESULT\]/i.test(l) && !/^\s*🔧/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Bóc tách CHỈ lấy khối Task Report sạch từ output của worker (bỏ toàn bộ lời tự sự/log phía trên).
// Nếu không có marker thì trả nguyên văn (tin nhắn thường vẫn đi qua như cũ).
function extractCleanTaskReport(content: string): string {
  const text = content || '';
  const startMatch = text.match(/===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===/i);
  if (!startMatch || startMatch.index === undefined) return text;
  const startIdx = startMatch.index;
  let from = startIdx;
  // Giữ kèm dòng "Task complete." (hoặc "[TO: ...] Task complete.") ngay trước marker nếu có
  const before = text.slice(0, startIdx);
  const beforeTrim = before.trimEnd();
  const lastLineMatch = beforeTrim.match(/(?:^|\n)([^\n]*Task complete\.?[^\n]*)$/i);
  if (lastLineMatch) {
    from = beforeTrim.length - lastLineMatch[1].length;
  }
  // Marker kết thúc tương ứng: === END <loại> REPORT ===
  const afterStart = text.slice(startIdx);
  const endM = afterStart.match(/===\s*END[^=\n]*REPORT\s*===/i);
  const end = endM && endM.index !== undefined ? startIdx + endM.index + endM[0].length : text.length;
  return text.slice(from, end).trim();
}

async function handleAgentResponse(content: string, fromAgent: Agent, defaultTo: string = 'orchestrator', toolCalls?: Array<{ tool: string; input?: string; output?: string }>, thinking?: string) {
  await parseAgentCommands(content, fromAgent.id);
  let messages = parseAgentOutput(content, defaultTo);
  if (messages.length === 0 && content && content.trim()) {
    const fallbackText = stripCommandTags(content).trim() || content.trim();
    if (fallbackText) {
      messages = [{ to: defaultTo, message: fallbackText }];
    }
  }

  let hasOrchestratorMessage = false;
  // Deduplicate: track các nội dung đã broadcast để tránh gửi trùng
  const broadcastedContents = new Set<string>();

  for (const msg of messages) {
    const isInternal = msg.to !== 'user' && msg.to !== 'broadcast';
    // Kênh Orchestrator: bản SẠCH — bóc riêng Task Report, bỏ lời tự sự; không toolCalls/thinking.
    // Chi tiết toolcall + tự sự đầy đủ chỉ phát trên kênh nội bộ của worker (to === agentId).
    const targetOrchId = resolveOrchestratorTarget(fromAgent);
    const isToOrchestrator = msg.to === 'orchestrator' || msg.to === targetOrchId || (agents.get(msg.to)?.type === 'orchestrator');
    const resolvedTo = (msg.to === 'orchestrator') ? targetOrchId : msg.to;
    const outContent = isToOrchestrator
      ? extractCleanTaskReport(stripToolNoiseForOrchestrator(msg.message))
      : msg.message;

    // Chống broadcast trùng: nếu nội dung đã gửi rồi → skip
    const contentKey = `${resolvedTo}|||${(outContent || '').trim()}`;
    if (outContent && broadcastedContents.has(contentKey)) {
      console.log(`[Route] Skip duplicate broadcast from ${fromAgent.name} to ${resolvedTo}`);
      if (isToOrchestrator) hasOrchestratorMessage = true;
      continue;
    }
    if (outContent) broadcastedContents.add(contentKey);

    const reply: ChatMsg = {
      id: uuidv4(),
      from: fromAgent.id,
      to: resolvedTo,
      content: outContent,
      timestamp: Date.now(),
      agentName: fromAgent.name,
      agentRole: fromAgent.role,
      msgType: isInternal ? 'talk' : undefined,
      // Toolcall cấu trúc LUÔN được lưu & gửi đầy đủ cho mọi kênh (kể cả Orchestrator/main)
      ...(toolCalls && toolCalls.length ? { toolCalls } : {}),
      // Thinking nội bộ LUÔN gửi kèm (toàn tuyến) — UI render hộp mờ riêng
      ...(thinking ? { thinking } : {})
    };
    chatHistory.push(reply);
    storage.saveMessage(reply);
    broadcast('chat:message', { msg: reply });

    // Chặn turn thừa: nội dung rỗng tuyệt đối / "(No response)" đã hiển thị ở trên,
    // nhưng KHÔNG route tiếp (không trigger Orchestrator, không deliverTalk) → hết loop.
    if (isEmptyAgentOutput(msg.message)) {
      console.log(`[Route] Skip empty/no-response output from ${fromAgent.name} to ${resolvedTo} (no new turn spawned)`);
      if (isToOrchestrator) hasOrchestratorMessage = true;
      continue;
    }

    if (resolvedTo === 'orchestrator') {
      hasOrchestratorMessage = true;
      // Chuyển thẳng tin nhắn (đã lọc nhiễu tool) về Orchestrator không bị chặn
      await triggerOrchestrator(fromAgent, outContent);
    } else {
      const targetAgent = agents.get(resolvedTo) || findAgentByIdNameOrRole(resolvedTo);
      if (targetAgent) {
        if (targetAgent.type === 'orchestrator') {
          hasOrchestratorMessage = true;
          await triggerOrchestrator(fromAgent, outContent);
        } else {
          targetAgent.status = 'working';
          targetAgent.workingSince = Date.now();
          storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
          broadcast('agent:updated', { agent: targetAgent });
          deliverTalk(targetAgent, fromAgent, { to: resolvedTo, message: msg.message });
        }
      } else {
        if (msg.to !== 'user' && msg.to !== 'orchestrator' && msg.to !== 'broadcast') {
          const cleanTo = cleanTargetIdentifier(msg.to);
          const isPlaceholder = !cleanTo || INVALID_TARGET_PLACEHOLDERS.has(cleanTo.toLowerCase()) || cleanTo === 'worker' || cleanTo === 'target-id' || cleanTo === 'agent-id';
          if (!isPlaceholder) {
            const errorContent = `[ERROR] TALK: Agent not found: ${msg.to}`;
            const notFoundErrMsg: ChatMsg = {
              id: uuidv4(),
              from: 'system',
              to: 'orchestrator',
              content: errorContent,
              timestamp: Date.now(),
              agentName: 'System',
              agentRole: 'system',
              msgType: 'internal'
            };
            chatHistory.push(notFoundErrMsg);
            storage.saveMessage(notFoundErrMsg);
            addUnreadForOrchestrator(notFoundErrMsg);
            broadcast('chat:message', { msg: notFoundErrMsg });
          } else {
            console.log(`[TALK] Ignored invalid placeholder target: "${msg.to}" from ${fromAgent.name}`);
          }
        }
      }
    }
  }

  // Nếu là worker agent và chưa có tin nhắn nào chuyển về Orchestrator mà output có nội dung text:
  // Tự động chuyển toàn bộ output báo về cho Orchestrator
  if (fromAgent.role !== 'orchestrator' && fromAgent.id !== 'orchestrator' && !hasOrchestratorMessage && content && content.trim()) {
    const rawReport = extractCleanTaskReport(stripToolNoiseForOrchestrator(stripCommandTags(content).trim() || content.trim()));
    if (isEmptyAgentOutput(rawReport)) {
      console.log(`[Route] Skip auto-report: empty/(No response) output from ${fromAgent.name} (${fromAgent.role}) — no orchestrator turn`);
    } else {
      await triggerOrchestrator(fromAgent, rawReport);
    }
  }
}

// Gửi tin nhắn TALK từ fromAgent → targetAgent, bền vững qua outbox.
// existingReportId dùng khi replay để không sinh bản trùng.
async function deliverTalk(targetAgent: Agent, fromAgent: Agent, msg: { to: string; message: string }, existingReportId?: string) {
  const reportId = existingReportId || uuidv4();
  if (!existingReportId) {
    storage.enqueueOutbox({
      id: reportId,
      fromAgentId: fromAgent.id,
      fromAgentName: fromAgent.name,
      fromAgentRole: fromAgent.role,
      to: targetAgent.id,
      message: msg.message,
      createdAt: Date.now(),
      attempts: 0,
      status: 'pending'
    });
  }
  try {
    const tc = getClient(targetAgent);
    const needReinject = tc.getNeedPromptReinject() || !targetAgent.sessionId;
    if (needReinject) tc.setNeedPromptReinject(false);
    const talkHeader = `=== INCOMING MESSAGE ===\nFROM: ${fromAgent.name} (ID: ${fromAgent.id}, Role: ${fromAgent.role})\nTO: ${targetAgent.name} (ID: ${targetAgent.id}, Role: ${targetAgent.role})\n=== MESSAGE ===`;

    let talkPrompt = '';
    if (targetAgent.sessionId && !needReinject) {
      talkPrompt = `${talkHeader}\n${msg.message}`;
    } else {
      const talkTeam = buildTeam(targetAgent.id);
      talkPrompt = `[TASK] ${targetAgent.task || 'General task'}\n[TEAM]\n${talkTeam}\n[/TEAM]\n\n${talkHeader}\n${msg.message}\n\n${WORKER_REMINDER}`;
    }
    // WORKING NGAY TRƯỚC ENQUEUE: badge worker trên UI nhảy sang Working tức thì,
    // không phụ thuộc caller có set hay không (cover cả đường replay outbox).
    targetAgent.status = 'working';
    targetAgent.workingSince = Date.now();
    storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
    broadcast('agent:updated', { agent: targetAgent });

    const tr = await tc.enqueue(talkPrompt);
    const newSid = tc.getSessionId();
    const isNewSession = !!(newSid && newSid !== targetAgent.sessionId);
    targetAgent.sessionId = newSid || undefined;
    if (tr.tokenUsage) {
      // Fix badge token từng agent: GIỮ NGUYÊN Object TokenUsage (Total/Input/Output/Cost)
      // thay vì nén thành số — Dashboard/ChatPanel đọc cả 2 shape và hiển thị breakdown.
      targetAgent.tokenUsage = tr.tokenUsage;
    }
    if (tr.contextLength) targetAgent.contextLength = tr.contextLength;
    if (targetAgent.sessionId) ACPClient.registerSession(targetAgent.id, targetAgent.sessionId);
    storage.updateAgent(targetAgent.id, {
      sessionId: targetAgent.sessionId,
      tokenUsage: targetAgent.tokenUsage,
      contextLength: targetAgent.contextLength
    });
    broadcast('agent:updated', { agent: targetAgent });
    if (isNewSession || !targetAgent.sessionTitle) {
      syncSessionTitle(targetAgent, tc, 1, isNewSession).catch(() => {});
    }

    // Gửi thành công → đánh dấu delivered (xóa khỏi outbox)
    storage.markOutboxDelivered(reportId);

    await handleAgentResponse(tr.content, targetAgent, 'orchestrator', tr.toolCalls, tr.thinking);
    saveTranscript(tr, targetAgent.id, targetAgent.name, targetAgent.role);

    // Auto-wakeup: worker im lặng tuyệt đối (content rỗng/"(No response)") NHƯNG transcript
    // có dấu hiệu tool_use thực thi thật ([TOOL ...]) → sinh thông báo ngắn về Orchestrator
    // để kích hoạt triggerOrchestrator, tránh im lặng kéo dài. Chỉ gửi khi có tool_use thật;
    // throttle 30s/agent để không tạo loop (Orchestrator re-dispatch liên tục).
    if (isEmptyAgentOutput(tr.content) && /\[TOOL\s/i.test(tr.transcript || '')) {
      const now = Date.now();
      const lastAt = lastToolWakeupAt.get(targetAgent.id) || 0;
      if (now - lastAt > TOOL_WAKEUP_THROTTLE_MS) {
        lastToolWakeupAt.set(targetAgent.id, now);
        const notice = `[Worker ${targetAgent.name} completed tool execution]`;
        console.log(`[Talk] ${notice} — waking orchestrator (content rỗng nhưng transcript có tool_use)`);
        await triggerOrchestrator(targetAgent, `${notice}\n(Ghi chú: lượt này worker chỉ thực thi tool, không sinh văn bản trả lời. Nếu nhiệm vụ chưa xong hãy tiếp tục giao việc; nếu đã đủ hãy tổng hợp kết quả.)`);
      }
    }

    clearAgentRetry(targetAgent.id);

    targetAgent.status = 'idle';
    targetAgent.workingSince = undefined;
    storage.updateAgent(targetAgent.id, {
      status: 'idle',
      sessionId: targetAgent.sessionId,
      workingSince: null,
      tokenUsage: targetAgent.tokenUsage,
      contextLength: targetAgent.contextLength
    });
    broadcast('agent:updated', { agent: targetAgent });
    checkAndSynthesize(targetAgent.id);
  } catch (e: any) {
    // Lỗi Abort: xóa khỏi Outbox NGAY, không retry (chống vòng lặp spam lỗi aborted)
    const isAborted = e.message?.toLowerCase().includes('abort') || e.message?.toLowerCase().includes('aborted');
    if (isAborted) {
      storage.markOutboxDelivered(reportId);
    } else {
      storage.markOutboxFailed(reportId, e.message);
      const rec = storage.getPendingOutbox().find(r => r.id === reportId);
      if (rec && rec.attempts < ORCH_MAX_RETRY) {
        setTimeout(() => deliverTalk(targetAgent, fromAgent, msg, reportId).catch(() => {}), 2000 * rec.attempts);
      }
    }
    targetAgent.status = 'error';
    targetAgent.workingSince = undefined;
    storage.updateAgent(targetAgent.id, { status: 'error', workingSince: null });
    broadcast('agent:updated', { agent: targetAgent });
    checkAndSynthesize(targetAgent.id);
  }
}

async function handleOrchestratorResponse(response: string, extraScanText = ''): Promise<string[]> {
  const commandResults: string[] = [];
  let cmdResults: string[] = [];
  try {
    cmdResults = await parseAgentCommands(response, 'orchestrator');
  } catch (e: any) {
    console.error(`[OrchCmd] parseAgentCommands failed: ${e?.message || e}`);
  }
  commandResults.push(...cmdResults);

  // SPAWN scan gộp cả thinking/reasoning: tag có thể nằm trong phần model tự nói (không nằm
  // ở final text của opencode) — trước đây chỉ parse response nên spawn im lặng thất bại.
  const scanText = response + '\n' + (extraScanText || '');
  const spawns = parseSpawnTags(scanText);
  
  // Nếu có chuỗi [SPAWN role=...] nhưng parse thất bại (thiếu name hoặc task), chỉ cảnh báo nhẹ console,
  // tuyệt đối KHÔNG bắn tin nhắn lỗi spam về Orchestrator nếu chỉ là câu văn tự sự/ví dụ.
  if (spawns.length === 0 && /\[SPAWN\s+role=/i.test(scanText)) {
    console.warn('[SpawnParse] Phát hiện tag [SPAWN role=...] nhưng thiếu name hoặc task hợp lệ.');
  }

  for (const spawn of spawns) {
     const { role, name, task } = spawn;
     const existing = findAgentByName(name);
     if (existing) {
       if (existing.status === 'working') {
       commandResults.push(`[WARN] Agent ${name} (${existing.id}) is already working; reusing with new task may interrupt current work.`);
     }
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
        agentRole: 'orchestrator',
        msgType: 'talk'
      };
      chatHistory.push(reuseTaskMsg);
      storage.saveMessage(reuseTaskMsg);
      broadcast('chat:message', { msg: reuseTaskMsg });
      
      setTimeout(async () => {
        try {
          const tc = getClient(existing);
          const needReinject = tc.getNeedPromptReinject() || !existing.sessionId;
          if (needReinject) tc.setNeedPromptReinject(false);
          let prompt = '';
          if (existing.sessionId && !needReinject) {
            // Worker đã có session: gửi trực tiếp thông báo task mới, không nhồi format
            prompt = `=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${existing.name} (ID: ${existing.id}, Role: ${existing.role})\n=== MESSAGE ===\nNew task: ${task}`;
          } else {
            const spawnTeam = buildTeam(existing.id);
            prompt = `[TASK] ${task}\n[TEAM]\n${spawnTeam}\n[/TEAM]\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${existing.name} (ID: ${existing.id}, Role: ${existing.role})\n=== MESSAGE ===\n${task}\n\n${WORKER_REMINDER}`;
          }
          const tr = await tc.enqueue(prompt);
          const newSid = tc.getSessionId();
          const isNewSession = !!(newSid && newSid !== existing.sessionId);
          existing.sessionId = newSid || existing.sessionId;
          if (tr.tokenUsage) {
            existing.tokenUsage = tr.tokenUsage;
          }
          if (tr.contextLength) existing.contextLength = tr.contextLength;
          if (existing.sessionId) ACPClient.registerSession(existing.id, existing.sessionId);
          storage.updateAgent(existing.id, { 
            sessionId: existing.sessionId,
            tokenUsage: existing.tokenUsage,
            contextLength: existing.contextLength
          });
          broadcast('agent:updated', { agent: existing });
          syncSessionTitle(existing, tc, 3, isNewSession).catch(() => {});
          
          await handleAgentResponse(tr.content, existing, 'orchestrator', tr.toolCalls, tr.thinking);
          saveTranscript(tr, existing.id, existing.name, existing.role);
          
          clearAgentRetry(existing.id);
          
          existing.status = 'idle';
          existing.workingSince = undefined;
          storage.updateAgent(existing.id, { 
            status: 'idle', 
            sessionId: existing.sessionId, 
            workingSince: null,
            tokenUsage: existing.tokenUsage,
            contextLength: existing.contextLength
          });
          broadcast('agent:updated', { agent: existing });
          checkAndSynthesize(existing.id);
        } catch (e: any) {
          const isAborted = e.message?.toLowerCase().includes('abort') || e.message?.toLowerCase().includes('aborted');
          if (isAborted) return;
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
      // 1. Kiểm tra bất thường: nếu > 2 con thì tự động xóa bớt 1 con bất kỳ
      await autoPruneExcessAgents(role);

      // 2. Kiểm tra hạn mức role: coder/researcher tối đa 2, các role khác tối đa 1
      const roleLimit = getRoleLimit(role);
      const activeRoleAgents = getAgentsByRole(role);

      if (activeRoleAgents.length >= roleLimit) {
        const existingListStr = activeRoleAgents.map(a => `${a.name} (${a.id})`).join(', ');
        const errorContent = `[Role Limit] Không thể spawn agent "${name}" role "${role}" do đã đạt tối đa (max ${roleLimit}, hiện có ${activeRoleAgents.length}). Danh sách agent hiện có cùng role: [${existingListStr}]. Hãy dùng [TALK agent-id=... message=...] để giao việc.`;
        console.warn(`[Role Limit] ${errorContent}`);
        commandResults.push(errorContent);

        const limitErrMsg: ChatMsg = {
          id: uuidv4(),
          from: 'system',
          to: 'orchestrator',
          content: errorContent,
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system',
          msgType: 'internal'
        };
        chatHistory.push(limitErrMsg);
        storage.saveMessage(limitErrMsg);
        addUnreadForOrchestrator(limitErrMsg);
        broadcast('chat:message', { msg: limitErrMsg });

        const limitErrMsgUser: ChatMsg = {
          id: uuidv4(),
          from: 'system',
          to: 'user',
          content: errorContent,
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system'
        };
        chatHistory.push(limitErrMsgUser);
        storage.saveMessage(limitErrMsgUser);
        broadcast('chat:message', { msg: limitErrMsgUser });
        continue;
      }

      const spawnId = 'agent-' + uuidv4().slice(0, 8);
      const na: Agent = {
        id: spawnId, name, role, type: 'worker', status: 'working',
        spawnedBy: 'orchestrator', task, createdAt: Date.now(), workingSince: Date.now(),
        sessionTitle: task ? task.substring(0, 80) : undefined
      };
      agents.set(spawnId, na);
      storage.saveAgent(na);
      broadcast('agent:created', { agent: na });
      notifyTeamChanged(); // Agent mới được thêm vào team → cần update context
      
      const spawnTaskMsg: ChatMsg = {
        id: uuidv4(),
        from: 'orchestrator',
        to: spawnId,
        content: `[SPAWN] ${role} "${name}" assigned: ${task}`,
        timestamp: Date.now(),
        agentName: 'Orchestrator',
        agentRole: 'orchestrator',
        msgType: 'talk'
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
          const tr = await tc.enqueue(`[TASK] ${na.task}\n[TEAM]\n${spawnTeam}\n[/TEAM]\n\n${senderHeader}\n${na.task}\n\n${buildWorkerPrompt(na.role, na, true)}`);
          na.sessionId = tc.getSessionId() || undefined;
          if (tr.tokenUsage) {
            na.tokenUsage = tr.tokenUsage;
          }
          if (tr.contextLength) na.contextLength = tr.contextLength;
          if (na.sessionId) ACPClient.registerSession(na.id, na.sessionId);
          storage.updateAgent(na.id, { 
            sessionId: na.sessionId,
            tokenUsage: na.tokenUsage,
            contextLength: na.contextLength
          });
          broadcast('agent:updated', { agent: na });
          // New agent = new session
          syncSessionTitle(na, tc, 3, true).catch(() => {});
          
          await handleAgentResponse(tr.content, na, 'orchestrator', tr.toolCalls, tr.thinking);
          saveTranscript(tr, spawnId, name, role);
          
          clearAgentRetry(spawnId);
          
          na.status = 'idle';
          na.workingSince = undefined;
          storage.updateAgent(na.id, { 
            status: 'idle', 
            sessionId: na.sessionId, 
            workingSince: null,
            tokenUsage: na.tokenUsage,
            contextLength: na.contextLength
          });
          broadcast('agent:updated', { agent: na });
          checkAndSynthesize(spawnId);
        } catch (e: any) {
          const isAborted = e.message?.toLowerCase().includes('abort') || e.message?.toLowerCase().includes('aborted');
          if (isAborted) return;
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
  
  const talks = parseOrchestratorCommands(response);
  for (const talk of talks) {
    const { agentId, message, task } = talk;
    const ta = agents.get(agentId) || findAgentByName(agentId) || findAgentByIdNameOrRole(agentId);
    if (!ta) {
      commandResults.push(`[ERROR] TALK: agent ${agentId} not found`);
      const errorContent = `[ERROR] TALK: Agent not found: ${agentId}`;
      const notFoundErrMsg: ChatMsg = {
        id: uuidv4(),
        from: 'system',
        to: 'orchestrator',
        content: errorContent,
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system',
        msgType: 'internal'
      };
      chatHistory.push(notFoundErrMsg);
      storage.saveMessage(notFoundErrMsg);
      addUnreadForOrchestrator(notFoundErrMsg);
      broadcast('chat:message', { msg: notFoundErrMsg });
      continue;
    }
    ta.status = 'working';
    ta.workingSince = Date.now();
    // Update task if provided in TALK command
    if (task && task.trim()) {
      ta.task = task.trim().normalize('NFC');
    }
    storage.updateAgent(ta.id, { status: 'working', workingSince: ta.workingSince, task: ta.task } as any);
    broadcast('agent:updated', { agent: ta });

    const talkMsg: ChatMsg = {
      id: uuidv4(),
      from: 'orchestrator',
      to: ta.id,
      content: message,
      timestamp: Date.now(),
      agentName: 'Orchestrator',
      agentRole: 'orchestrator',
      msgType: 'talk'
    };
    chatHistory.push(talkMsg);
    storage.saveMessage(talkMsg);
    broadcast('chat:message', { msg: talkMsg });
    
    setTimeout(async () => {
      try {
        const tc = getClient(ta);
        const needReinject = tc.getNeedPromptReinject() || !ta.sessionId;
        if (needReinject) tc.setNeedPromptReinject(false);
        const talkHeader = `=== INCOMING MESSAGE ===\nFROM: Orchestrator (orchestrator)\nTO: ${ta.name} (ID: ${ta.id}, Role: ${ta.role})\n=== MESSAGE ===`;
        
        let talkPrompt = '';
        if (ta.sessionId && !needReinject) {
          // Worker đã có session: CẮT BỎ HOÀN TOÀN [TEAM UPDATE], Members:, Your task:, WORKER_REMINDER
          talkPrompt = `${talkHeader}\n${message}`;
        } else {
          // Khởi tạo session đầu tiên: nạp [TASK], [TEAM] và WORKER_REMINDER
          const talkTeam = buildTeam(ta.id);
          talkPrompt = `[TASK] ${ta.task || 'General task'}\n[TEAM]\n${talkTeam}\n[/TEAM]\n\n${talkHeader}\n${message}\n\n${WORKER_REMINDER}`;
        }
        const tr = await tc.enqueue(talkPrompt);
        const newSid = tc.getSessionId();
        const isNewSession = Boolean(newSid && newSid !== ta.sessionId);
        ta.sessionId = newSid || undefined;
        if (tr.tokenUsage) {
          ta.tokenUsage = tr.tokenUsage;
        }
        if (tr.contextLength) ta.contextLength = tr.contextLength;
        if (ta.sessionId) ACPClient.registerSession(ta.id, ta.sessionId);
        storage.updateAgent(ta.id, { 
          sessionId: ta.sessionId,
          tokenUsage: ta.tokenUsage,
          contextLength: ta.contextLength
        });
        broadcast('agent:updated', { agent: ta });
        syncSessionTitle(ta, tc, 3, isNewSession).catch(() => {});
        
        await handleAgentResponse(tr.content, ta, 'orchestrator', tr.toolCalls, tr.thinking);
        saveTranscript(tr, ta.id, ta.name, ta.role);
        
        clearAgentRetry(ta.id);
        
        ta.status = 'idle';
        ta.workingSince = undefined;
        storage.updateAgent(ta.id, { 
          status: 'idle', 
          sessionId: ta.sessionId, 
          workingSince: null,
          tokenUsage: ta.tokenUsage,
          contextLength: ta.contextLength
        });
        broadcast('agent:updated', { agent: ta });
        checkAndSynthesize(ta.id);
      } catch (e: any) {
        const isAborted = e.message?.toLowerCase().includes('abort') || e.message?.toLowerCase().includes('aborted');
        if (isAborted) return;
        ta.status = 'error';
        ta.workingSince = undefined;
        storage.updateAgent(ta.id, { status: 'error', workingSince: null });
        broadcast('agent:updated', { agent: ta });
        // KHÔNG nuốt lỗi: báo về orchestrator để main được wake và biết agent gặp sự cố
        try {
          const errMsg: ChatMsg = { id: uuidv4(), from: ta.id, to: 'orchestrator', content: `[ERROR] Agent ${ta.name} (${ta.role}) turn failed: ${e.message}`, timestamp: Date.now(), agentName: ta.name, agentRole: ta.role };
          chatHistory.push(errMsg); storage.saveMessage(errMsg);
          addUnreadForOrchestrator(errMsg);
          broadcast('chat:message', { msg: errMsg });
          await triggerOrchestrator(ta, errMsg.content);
        } catch {}
        checkAndSynthesize(ta.id);
      }
    }, 100);
  }
  
  return commandResults;
}

function getOrchClient(orchId: string = 'orchestrator'): ACPClient {
  const isMain = orchId === 'orchestrator';
  const targetAgent = agents.get(orchId) || (storage.getAgent(orchId) as any);
  const model = isMain ? resolveOrchestratorModel() : resolveModelForAgent(targetAgent || { id: orchId, name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator', createdAt: Date.now() });
  if (!clients.has(orchId)) {
    clients.set(orchId, new ACPClient({
      id: orchId,
      name: targetAgent?.name || (isMain ? 'Orchestrator' : `Orchestrator-${orchId.slice(-4)}`),
      role: 'orchestrator',
      type: 'orchestrator',
      projectDir: targetAgent?.projectDir,
      model
    }));
    clients.get(orchId)!.setOnEvent((ev: any) => broadcastOACEvent(orchId, ev));
  } else {
    const c = clients.get(orchId)!;
    if (model) c.setModel(model);
  }
  const client = clients.get(orchId)!;
  if (targetAgent && client.getSessionId() !== (targetAgent.sessionId || null)) {
    client.setSession(targetAgent.sessionId || null);
  }
  return client;
}

// ============ API ============
// Thời điểm server khởi động (epoch ms) — frontend dùng hiển thị uptime "Live WS"
const SERVER_START_TIME = Date.now();
app.get('/api/server-info', (_req, res) => {
  try {
    res.json({ serverStartTime: SERVER_START_TIME, uptimeMs: Date.now() - SERVER_START_TIME, cwd: process.cwd(), version: APP_VERSION });
  } catch (err) {
    res.json({ serverStartTime: SERVER_START_TIME, uptimeMs: Date.now() - SERVER_START_TIME, cwd: process.cwd(), version: APP_VERSION });
  }
});

app.get('/api/agents', (_req, res) => {
  // Trả đủ trường token cho badge: camelCase (UI mới) + snake_case mirror (tương thích),
  // ưu tiên giá trị MỚI NHẤT trong memory; nếu memory chưa có thì bù từ storage row.
  const rows = Array.from(agents.values()).map(a => {
    const out: any = { ...a };
    const stored = storage.getAgent(a.id) as any;
    if (out.tokenUsage === undefined && stored && stored.token_usage !== undefined && stored.token_usage !== null) {
      out.tokenUsage = stored.token_usage;
    }
    if (out.contextLength === undefined && stored && stored.context_length !== undefined && stored.context_length !== null) {
      out.contextLength = stored.context_length;
    }
    out.token_usage = out.tokenUsage ?? null;
    out.context_length = out.contextLength ?? null;
    return out;
  });
  res.json(rows);
});

app.post('/api/agents', async (req, res) => {
  const { name, role: rawRole, type: rawType, spawnedBy, projectDir, task, model } = req.body;
  const isOrch = rawType === 'orchestrator' || rawRole === 'orchestrator';
  const role = isOrch ? 'orchestrator' : (rawRole || 'coder');
  const type = isOrch ? 'orchestrator' : (rawType || 'worker');

  if (!isOrch) {
    // 1. Kiểm tra bất thường: nếu > 2 con thì tự động xóa bớt 1 con bất kỳ
    await autoPruneExcessAgents(role);

    // 2. Kiểm tra hạn mức role: coder/researcher tối đa 2 con, các role khác tối đa 1 con
    const roleLimit = getRoleLimit(role);
    const activeRoleAgents = getAgentsByRole(role);

    if (activeRoleAgents.length >= roleLimit) {
      const existingListStr = activeRoleAgents.map(a => `${a.name} (${a.id})`).join(', ');
      const errorMsg = `[Role Limit] Không thể tạo agent role "${role}" do đã đạt tối đa (max ${roleLimit}, hiện có ${activeRoleAgents.length}). Danh sách agent hiện có cùng role: [${existingListStr}]. Hãy dùng [TALK agent-id=... message=...] để giao việc.`;
      console.warn(`[API /api/agents] ${errorMsg}`);
      
      // Gửi tin nhắn lỗi về Main Orchestrator
      const limitErrMsg: ChatMsg = {
        id: uuidv4(),
        from: 'system',
        to: 'orchestrator',
        content: errorMsg,
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system',
        msgType: 'internal'
      };
      chatHistory.push(limitErrMsg);
      storage.saveMessage(limitErrMsg);
      addUnreadForOrchestrator(limitErrMsg);
      broadcast('chat:message', { msg: limitErrMsg });

      // Gửi tin nhắn lỗi về User
      const limitErrMsgUser: ChatMsg = {
        id: uuidv4(),
        from: 'system',
        to: 'user',
        content: errorMsg,
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system'
      };
      chatHistory.push(limitErrMsgUser);
      storage.saveMessage(limitErrMsgUser);
      broadcast('chat:message', { msg: limitErrMsgUser });

      return res.status(400).json({ ok: false, error: errorMsg });
    }
  }

  const id = 'agent-' + uuidv4().slice(0, 8);
  const agent: Agent = {
    id, name: name || (isOrch ? `Orchestrator-${id.slice(-4)}` : `Agent-${id.slice(-4)}`), role,
    type, status: 'idle', spawnedBy, projectDir, task, model, createdAt: Date.now(), sessionId: undefined
  };
  agents.set(id, agent); storage.saveAgent(agent);
  broadcast('agent:created', { agent });
  notifyTeamChanged(); // Agent mới được thêm vào team
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
  stopAgent(a.id, 'user'); res.json({ ok: true });
});

app.post('/api/agents/:id/resume', (req, res) => {
  const a = agents.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!resumeAgent(a.id)) return res.json({ ok: false, error: 'Agent not stopped' });
  res.json({ ok: true });
});

app.post('/api/agents/:id/abort', (req, res) => {
  const id = req.params.id;
  
  // Idempotency guard: if already aborting this agent, return success immediately
  if (abortingAgents.has(id)) {
    console.log(`[Abort] Agent ${id} already aborting, returning idempotent success`);
    return res.json({ ok: true, killed: false, idempotent: true });
  }

  // Orchestrator quản lý riêng (không trong agents map) — xử lý abort riêng
  if (id === 'orchestrator') {
    abortingAgents.add(id);
    try {
      const client = clients.get('orchestrator');
      const orch = agents.get('orchestrator');
      const killed = client ? client.abort() : false;
      if (orch) {
        orch.status = 'idle';
        orch.workingSince = undefined;
        storage.updateAgent('orchestrator', { status: 'idle', workingSince: null });
        broadcast('agent:updated', { agent: orch });
      } else {
        broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
      }
      res.json({ ok: true, killed });
    } catch (err: any) {
      console.error(`[Abort] Error aborting orchestrator:`, err);
      res.json({ ok: true, killed: false, warning: err.message });
    } finally {
      abortingAgents.delete(id);
    }
    return;
  }

  const a = agents.get(id);
  if (!a) return res.status(404).json({ ok: false, error: 'Not found' });

  abortingAgents.add(id);
  try {
    const client = clients.get(a.id);
    const killed = client ? client.abort() : false;
    a.status = 'idle';
    a.workingSince = undefined;
    storage.updateAgent(a.id, { status: 'idle', workingSince: null });
    broadcast('agent:updated', { agent: a });
    res.json({ ok: true, killed });
  } catch (err: any) {
    console.error(`[Abort] Error aborting agent ${id}:`, err);
    res.json({ ok: true, killed: false, warning: err.message });
  } finally {
    abortingAgents.delete(id);
  }
});

app.delete('/api/agents/:id', async (req, res) => {
  const { id } = req.params;
  if (id === 'orchestrator') {
    return res.status(400).json({ ok: false, error: 'Cannot delete orchestrator agent' });
  }
  const exists = agents.has(id) || storage.getAgent(id);
  if (!exists) {
    return res.status(404).json({ ok: false, error: 'Agent not found' });
  }
  try {
    const deleted = await deleteAgent(id);
    res.json({ ok: true, id, sessionDeleted: deleted });
  } catch (err: any) {
    console.error(`[API DELETE /api/agents/${id}] Error:`, err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Update agent fields (model, name, task)
app.patch('/api/agents/:id', (req, res) => {
  const agentId = req.params.id;
  const agent = agents.get(agentId);
  if (!agent) return res.status(404).json({ ok: false, error: 'Not found' });
  
  const { model, name, task } = req.body || {};
  if (model !== undefined) {
    agent.model = model || undefined;
    storage.updateAgent(agentId, { model: model || null });
    if (agentId === 'orchestrator') {
      storage.setSetting('orchestratorModel', model || null);
      if (model) process.env.ORCHESTRATOR_MODEL = model; else delete process.env.ORCHESTRATOR_MODEL;
    }
    const client = clients.get(agentId);
    if (client) {
      const resolved = resolveModelForAgent(agent);
      client.setModel(resolved || undefined);
    }
  }
  if (name !== undefined) {
    agent.name = name.trim().normalize('NFC');
    storage.updateAgent(agentId, { name: agent.name } as any);
  }
  if (task !== undefined) {
    agent.task = task.trim().normalize('NFC');
    storage.updateAgent(agentId, { task: agent.task } as any);
    // KHÔNG notifyTeamChanged() ở đây — task content không phải member change
  }
  
  broadcast('agent:updated', { agent });
  res.json({ ok: true, agent });
});

// Update agent model
app.post('/api/agents/:id/model', (req, res) => {
  const { model } = req.body || {};
  const agentId = req.params.id;
  const agent = agents.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Not found' });
  
  agent.model = model || undefined;
  storage.updateAgent(agentId, { model: model || null });
  
  if (agentId === 'orchestrator') {
    storage.setSetting('orchestratorModel', model || null);
    if (model) process.env.ORCHESTRATOR_MODEL = model; else delete process.env.ORCHESTRATOR_MODEL;
  }
  
  // If agent has a client, update its model too
  const client = clients.get(agentId);
  if (client) {
    const resolved = resolveModelForAgent(agent);
    client.setModel(resolved || undefined);
  }
  
  broadcast('agent:updated', { agent });
  broadcast('settings:updated', { models: storage.getModelSettings() });
  res.json({ ok: true, model: agent.model });
});

// ============ CHAT ============
// ============ DISPATCH USER CHAT (dùng chung HTTP handler + retry queue) ============
async function dispatchUserChat(params: { targetAgentId: string; rawMsg: string; isSlashCommand: boolean; isRetry?: boolean }): Promise<{ response: string; sid: string | null; commands: string[] }> {
  const { targetAgentId, rawMsg, isSlashCommand, isRetry } = params;
  let resolvedTargetId = targetAgentId || '';
  let targetAgent: Agent | null = (resolvedTargetId && resolvedTargetId !== 'orchestrator') ? (agents.get(resolvedTargetId) || findAgentByIdNameOrRole(resolvedTargetId) || null) : null;
  let agentName = 'Orchestrator', agentRole = 'orchestrator';
  let prompt: string;
  let sid: string | null = null;
  const client = targetAgent ? getClient(targetAgent) : getOrchClient();
  const commandResults: string[] = [];

  // ============ PRESERVE & AUTO-MERGE UNPROCESSED USER MESSAGES ============
  // Nếu lượt trước bị Stop / Abort mà còn tin nhắn chưa được xử lý,
  // tự động gộp toàn bộ tin cũ cùng tin mới vào lượt này để không bao giờ mất yêu cầu của người dùng.
  let effectiveMsg = rawMsg;
  const targetKey = resolvedTargetId || 'orchestrator';
  const storedOldMsgs = isRetry ? [] : storage.getUnprocessedMessages(targetKey);
  const clientOldPrompts = isRetry ? [] : client.getUnprocessedPrompts();
  const combinedOld = Array.from(new Set([...storedOldMsgs, ...clientOldPrompts])).filter(p => p && p.trim() && p.trim() !== rawMsg.trim());

  if (combinedOld.length > 0 && !isSlashCommand) {
    const oldFormatted = combinedOld.map((m, idx) => `[Tin ${idx + 1} chưa xử lý trước đó]:\n${m}`).join('\n\n---\n\n');
    effectiveMsg = `${oldFormatted}\n\n---\n\n[Yêu cầu mới nhất]:\n${rawMsg}`;
    
    // Dọn sạch bộ đệm sau khi đã gộp thành công
    storage.clearUnprocessedMessages(targetKey);
    client.clearUnprocessedPrompts();

    const mergeNotice: ChatMsg = {
      id: uuidv4(),
      from: 'system',
      to: targetKey,
      content: `🔄 Đã tự động gộp ${combinedOld.length} yêu cầu chưa được xử lý từ lượt trước vào lượt chat này để bảo toàn công việc.`,
      timestamp: Date.now(),
      agentName: 'System',
      agentRole: 'system'
    };
    chatHistory.push(mergeNotice);
    storage.saveMessage(mergeNotice);
    broadcast('chat:message', { msg: mergeNotice });
  }

  if (isSlashCommand) {
    client.setNeedPromptReinject(true);
  }
  const shouldReinject = (client.getNeedPromptReinject() || (targetAgent ? !targetAgent.sessionId : !client.getSessionId())) && !isSlashCommand;
  if (client.getNeedPromptReinject() && !isSlashCommand) {
    client.setNeedPromptReinject(false);
  }

  if (targetAgent) {
    agentName = targetAgent.name; agentRole = targetAgent.role;
    targetAgent.status = 'working'; targetAgent.workingSince = Date.now();
    storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
    broadcast('agent:updated', { agent: targetAgent });
    if (isSlashCommand) {
      prompt = effectiveMsg;
    } else {
      const includeTeam = shouldIncludeTeamContext(targetAgent.id, shouldReinject);
      if (includeTeam) {
        const team = buildTeam(targetAgent.id);
        prompt = (targetAgent.sessionId && !shouldReinject)
          ? `[TEAM UPDATE]\n${team}\n\n[FROM: user] [TO: ${targetAgent.id}] ${effectiveMsg}`
          : `[TASK] ${targetAgent.task || 'General task'}\n[TEAM]\n${team}\n[/TEAM]\n\n[FROM: user] [TO: ${targetAgent.id}] ${effectiveMsg}`;
      } else {
        prompt = `[FROM: user] [TO: ${targetAgent.id}] ${effectiveMsg}`;
      }
    }
  } else {
    const orchAgent = agents.get('orchestrator');
    if (orchAgent) {
      orchAgent.status = 'working';
      storage.updateAgent('orchestrator', { status: 'working' });
      broadcast('agent:updated', { agent: orchAgent });
    } else {
      broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'working' } } as any);
    }

    // Inject unread messages từ workers vào prompt (bỏ qua khi retry để không consume lại)
    const unread = isRetry ? [] : consumeUnreadForOrchestrator();
    let unreadBlock = '';
    if (unread.length > 0) {
      unreadBlock = '\n\n=== MESSAGES FROM AGENTS (you should respond to these) ===\n' +
        unread.map(m => `[FROM: ${m.agentName || m.from} (${m.from})]\n${m.content}`).join('\n\n') +
        '\n=== END MESSAGES ===\n';
    }

    if (isSlashCommand) {
      prompt = effectiveMsg;
    } else if (client.getSessionId() && !shouldReinject) {
      prompt = `${unreadBlock ? unreadBlock + '\n\n' : ''}[FROM: user] [TO: orchestrator] ${effectiveMsg}`;
    } else {
      const team = buildTeam('orchestrator');
      prompt = `[TEAM]\n${team}${unreadBlock}\n[/TEAM]\n\n[FROM: user] [TO: orchestrator] ${effectiveMsg}`;
    }
  }

  // Khi agent hoặc orchestrator đang bận → thông báo vào hàng đợi (bỏ qua với retry)
  const wasQueued = (!isRetry) && client.isBusy();
  if (wasQueued) {
    const targetName = targetAgent ? targetAgent.name : 'Orchestrator';
    const targetId = targetAgent ? targetAgent.id : 'orchestrator';
    const qMsg: ChatMsg = {
      id: uuidv4(),
      from: 'user',
      to: targetId,
      content: `[QUEUED] "${rawMsg.slice(0, 120)}${rawMsg.length > 120 ? '...' : ''}" — ${targetName} is busy, message queued (position ${client.queueLength() + 1})`,
      timestamp: Date.now()
    };
    chatHistory.push(qMsg); storage.saveMessage(qMsg);
    broadcast('chat:message', { msg: qMsg });
  }
  let finalPrompt = '';
  if (isSlashCommand) {
    finalPrompt = rawMsg;
  } else if (targetAgent) {
    finalPrompt = prompt + `\n\n${buildWorkerPrompt(targetAgent.role, targetAgent, !targetAgent.sessionId || shouldReinject)}`;
  } else {
    finalPrompt = prompt + ((client.getSessionId() && !shouldReinject) ? '' : `\n\n${ORCH_REMINDER}`);
  }
  const result = await client.enqueue(finalPrompt);
  sid = client.getSessionId();
  if (sid) {
    if (targetAgent) {
      const isNewSession = targetAgent.sessionId !== sid;
      targetAgent.sessionId = sid;
      if (result.tokenUsage) {
        targetAgent.tokenUsage = result.tokenUsage;
      }
      if (result.contextLength) targetAgent.contextLength = result.contextLength;
      ACPClient.registerSession(targetAgent.id, sid);
      storage.updateAgent(targetAgent.id, {
        sessionId: sid,
        sessionTitle: targetAgent.sessionTitle,
        tokenUsage: targetAgent.tokenUsage,
        contextLength: targetAgent.contextLength
      });
      broadcast('agent:updated', { agent: targetAgent });
      if (isNewSession || !targetAgent.sessionTitle) {
        syncSessionTitle(targetAgent, client, 1, isNewSession).catch(() => {});
      }
    } else {
      const orchAgent = agents.get('orchestrator');
      if (orchAgent) {
        const isNewSession = orchAgent.sessionId !== sid;
        orchAgent.sessionId = sid;
        if (result.tokenUsage) {
          orchAgent.tokenUsage = result.tokenUsage;
        }
        if (result.contextLength) orchAgent.contextLength = result.contextLength;
        storage.updateAgent('orchestrator', {
          sessionId: sid,
          tokenUsage: orchAgent.tokenUsage,
          contextLength: orchAgent.contextLength
        });
        if (isNewSession || !orchAgent.sessionTitle) {
          syncSessionTitle(orchAgent, client, 1, isNewSession).catch(() => {});
        }
      }
      ACPClient.registerSession('orchestrator', sid);
    }
  }

  const response = result.content;
  if (targetAgent) {
    if (isSlashCommand) {
      const reply: ChatMsg = {
        id: uuidv4(),
        from: targetAgent.id,
        to: 'user',
        content: response,
        timestamp: Date.now(),
        agentName: targetAgent.name,
        agentRole: targetAgent.role,
        ...(result.toolCalls && result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
        ...(result.thinking ? { thinking: result.thinking } : {})
      };
      chatHistory.push(reply);
      storage.saveMessage(reply);
      broadcast('chat:message', { msg: reply });
    } else {
      const messages = parseAgentOutput(response, 'user');
      let hasExplicitTo = false;
      for (const msg of messages) {
        if (msg.to !== 'user' && msg.to !== 'orchestrator') {
          hasExplicitTo = true;
          break;
        }
      }
      if (hasExplicitTo) {
        // Wake Orchestrator: message chứa báo cáo (mọi biến thể) dù route đi đâu cũng đánh thức
        for (const msg of messages) {
          if (msg.to === 'orchestrator' || REPORT_BLOCK_RE.test(msg.message)) {
            await triggerOrchestrator(targetAgent, extractCleanTaskReport(stripToolNoiseForOrchestrator(msg.message)));
            break; // 1 lần wake đủ — tránh spam
          }
        }
        await handleAgentResponse(response, targetAgent, 'user', result.toolCalls, result.thinking);
      } else {
        const reply: ChatMsg = {
          id: uuidv4(),
          from: targetAgent.id,
          to: 'user',
          content: response,
          timestamp: Date.now(),
          agentName: targetAgent.name,
          agentRole: targetAgent.role,
          ...(result.toolCalls && result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
        ...(result.thinking ? { thinking: result.thinking } : {}),
        };
        chatHistory.push(reply);
        storage.saveMessage(reply);
        broadcast('chat:message', { msg: reply });

        // AUTO-WAKE ORCHESTRATOR: worker 1-1 vừa xong việc kèm báo cáo (mọi biến thể)
        // → đánh thức Orchestrator phân tích & tổng hợp trả lời cho user ngay lập tức.
        if (REPORT_BLOCK_RE.test(response) || TASK_COMPLETE_RE.test(response)) {
          const clean = extractCleanTaskReport(stripToolNoiseForOrchestrator(response));
          await triggerOrchestrator(targetAgent, clean);
        }
      }
      saveTranscript(result, targetAgent.id, targetAgent.name, targetAgent.role);
      const validation = validateWorkerCompletion(result.content, targetAgent);
      if (!validation.valid) {
        console.log(`[Chat] Agent ${targetAgent.name} completion format invalid: ${validation.reason}`);
      }
      clearAgentRetry(targetAgent.id);
    }
    targetAgent.status = 'idle'; targetAgent.workingSince = undefined;
    storage.updateAgent(targetAgent.id, { status: 'idle', sessionId: targetAgent.sessionId, workingSince: null });
    broadcast('agent:updated', { agent: targetAgent });
  } else {
    if (isSlashCommand) {
      const aMsg: ChatMsg = {
        id: uuidv4(),
        from: 'orchestrator',
        to: 'user',
        content: response,
        timestamp: Date.now(),
        agentName: 'Orchestrator',
        agentRole: 'orchestrator'
      };
      chatHistory.push(aMsg);
      storage.saveMessage(aMsg);
      broadcast('chat:message', { msg: aMsg });
    } else {
      const commandResultsParse = await handleOrchestratorResponse(response, result.thinking || '');
      commandResults.push(...commandResultsParse);
      const cleanResponse = stripCommandTags(response).trim();
      const aMsg: ChatMsg = {
        id: uuidv4(), from: 'orchestrator', to: 'user', content: cleanResponse || response,
        timestamp: Date.now(), agentName, agentRole,
        ...(result.toolCalls && result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
        ...(result.thinking ? { thinking: result.thinking } : {})
      };
      chatHistory.push(aMsg); storage.saveMessage(aMsg);
      broadcast('chat:message', { msg: aMsg });
    }
    const orchAgent = agents.get('orchestrator');
    if (orchAgent) {
      orchAgent.status = 'idle';
      storage.updateAgent('orchestrator', { status: 'idle' });
      broadcast('agent:updated', { agent: orchAgent });
    } else {
      broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
    }
  }
  return { response, sid, commands: commandResults };
}

// Lỗi backend (LLM) sập / mạng → có thể retry sau khi backend sống lại
function isRetriableError(err: any): boolean {
  if (!err) return false;
  const m = (err?.message || String(err)).toLowerCase();
  if (m.includes('abort') || m.includes('aborted by user')) return false;
  return /cannot connect to api|fetch failed|econnrefused|failed to fetch|timed? ?out|timeout|50[0-9]|network|connection|no route|getaddrinfo|enotfound|socket|bad gateway|service unavailable|upstream|reset by peer/.test(m);
}

// Tự động gửi lại các chat user bị lỗi backend, lưu trên disk (sống sót qua restart/mất điện)
const CHAT_RETRY_INTERVAL = 30000;
let chatRetryTimer: any = null;
let chatRetryRunning = false;

async function processChatRetryQueue() {
  if (chatRetryRunning) return;
  chatRetryRunning = true;
  try {
    const pending = storage.getPendingChatQueue();
    if (pending.length === 0) return;
    const now = Date.now();
    for (const item of pending) {
      if (item.nextAttemptAt && item.nextAttemptAt > now) continue;
      // Agent đích đã bị xóa → drop khỏi queue, báo lỗi user (tránh misroute sang Orchestrator)
      if (item.targetAgentId && item.targetAgentId !== 'orchestrator' && !agents.has(item.targetAgentId) && !findAgentByIdNameOrRole(item.targetAgentId)) {
        const errMsg: ChatMsg = {
          id: uuidv4(),
          from: 'system',
          to: 'user',
          content: `❌ Không thể gửi lại tin nhắn: agent đích "${item.targetAgentId}" không còn tồn tại.\n"${item.rawMsg.slice(0, 100)}"`,
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system',
          msgType: 'error'
        };
        chatHistory.push(errMsg); storage.saveMessage(errMsg);
        broadcast('chat:message', { msg: errMsg });
        storage.removeChatQueueItem(item.id);
        continue;
      }
      try {
        await dispatchUserChat({ targetAgentId: item.targetAgentId, rawMsg: item.rawMsg, isSlashCommand: item.isSlashCommand, isRetry: true });
        storage.removeChatQueueItem(item.id);
        const okMsg: ChatMsg = {
          id: uuidv4(),
          from: 'system',
          to: 'user',
          content: `✅ Đã gửi lại tin nhắn thành công khi backend sẵn sàng: "${item.rawMsg.slice(0, 80)}${item.rawMsg.length > 80 ? '...' : ''}"`,
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system'
        };
        chatHistory.push(okMsg); storage.saveMessage(okMsg);
        broadcast('chat:message', { msg: okMsg });
      } catch (e: any) {
        if (isRetriableError(e)) {
          item.attempts = (item.attempts || 0) + 1;
          const delay = Math.min(5000 * Math.pow(2, Math.min(item.attempts, 6)), 10 * 60 * 1000);
          item.nextAttemptAt = Date.now() + delay;
          item.lastError = e?.message || String(e);
          storage.updateChatQueueItem(item);
          console.log(`[ChatQueue] Backend chưa sẵn sàng, thử lại sau ${Math.round(delay / 1000)}s (lần ${item.attempts}): ${item.rawMsg.slice(0, 40)}`);
        } else {
          const errMsg: ChatMsg = {
            id: uuidv4(),
            from: 'system',
            to: 'user',
            content: `❌ Không thể gửi lại tin nhắn (lỗi vĩnh viễn): ${e?.message || e}\n"${item.rawMsg.slice(0, 100)}"`,
            timestamp: Date.now(),
            agentName: 'System',
            agentRole: 'system',
            msgType: 'error'
          };
          chatHistory.push(errMsg); storage.saveMessage(errMsg);
          broadcast('chat:message', { msg: errMsg });
          storage.removeChatQueueItem(item.id);
        }
      }
    }
    storage.pruneChatQueue();
  } catch (e: any) {
    console.error(`[ChatQueue] process error: ${e?.message || e}`);
  } finally {
    chatRetryRunning = false;
  }
}

function scheduleChatRetry() {
  if (chatRetryTimer) return;
  chatRetryTimer = setInterval(processChatRetryQueue, CHAT_RETRY_INTERVAL);
  chatRetryTimer.unref?.();
}

app.post('/api/chat', async (req, res) => {
  let resolvedTargetId = '';
  let targetAgent: Agent | null = null;
  let rawMsg = '';
  let isSlashCommand = false;

  try {
    const { message, targetAgentId, agentId } = req.body || {};
    resolvedTargetId = targetAgentId || agentId || '';
    targetAgent = (resolvedTargetId && resolvedTargetId !== 'orchestrator') ? (agents.get(resolvedTargetId) || findAgentByIdNameOrRole(resolvedTargetId) || null) : null;

    rawMsg = (message || '').toString().trim();
    if (!rawMsg) {
      return res.status(400).json({ ok: false, error: 'Message cannot be empty' });
    }

    const userMsg: ChatMsg = { id: uuidv4(), from: 'user', to: resolvedTargetId || 'orchestrator', content: rawMsg, timestamp: Date.now() };
    chatHistory.push(userMsg); storage.saveMessage(userMsg);
    broadcast('chat:message', { msg: userMsg });

    isSlashCommand = rawMsg.startsWith('/');

    // Xử lý riêng lệnh /restart để khởi động lại máy chủ
    if (rawMsg.toLowerCase() === '/restart') {
      const restartMsg: ChatMsg = {
        id: uuidv4(),
        from: 'system',
        to: 'user',
        content: '🔄 Đang khởi động lại AgentForge server...',
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system'
      };
      chatHistory.push(restartMsg);
      storage.saveMessage(restartMsg);
      broadcast('chat:message', { msg: restartMsg });

      res.json({ ok: true, result: 'Restarting AgentForge server...' });

      setTimeout(() => {
        try {
          const batPath = join(process.cwd(), 'start.bat');
          const isWin = process.platform === 'win32';
          const child = spawn(
            isWin ? 'cmd.exe' : 'sh',
            isWin ? ['/c', batPath] : ['-c', 'npm start'],
            { detached: true, stdio: 'ignore', cwd: process.cwd() }
          );
          child.unref();
        } catch (err) {
          console.error('[Restart] Error spawning start.bat:', err);
        }
        process.exit(0);
      }, 500);
      return;
    }

    // Xử lý thông báo tức thời cho lệnh /compact
    if (rawMsg.toLowerCase().startsWith('/compact')) {
      const compactNotice: ChatMsg = {
        id: uuidv4(),
        from: 'system',
        to: resolvedTargetId || 'orchestrator',
        content: `⚡ Đang thực hiện rút gọn ngữ cảnh (/compact) cho ${targetAgent ? targetAgent.name : 'Orchestrator'}...`,
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system'
      };
      chatHistory.push(compactNotice);
      storage.saveMessage(compactNotice);
      broadcast('chat:message', { msg: compactNotice });
    }

    const { response, sid, commands: commandResults } = await dispatchUserChat({ targetAgentId: resolvedTargetId, rawMsg, isSlashCommand, isRetry: false });
    if (!res.headersSent) {
      res.json({ ok: true, response, sessionId: sid, commands: commandResults });
    }
  } catch (err: any) {
    // Lỗi backend (LLM) sập / mạng → lưu queue disk, tự gửi lại khi backend sống
    if (isRetriableError(err)) {
      const id = uuidv4();
      storage.enqueueChatRetry({
        id,
        targetAgentId: resolvedTargetId,
        rawMsg,
        isSlashCommand,
        attempts: 0,
        nextAttemptAt: Date.now() + 5000,
        createdAt: Date.now(),
        lastError: err?.message || String(err)
      });
      const qMsg: ChatMsg = {
        id: uuidv4(),
        from: 'system',
        to: 'user',
        content: `⏳ Tin nhắn của bạn đã được lưu và sẽ tự động gửi lại khi backend (LLM) sẵn sàng: "${rawMsg.slice(0, 100)}${rawMsg.length > 100 ? '...' : ''}"`,
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system'
      };
      chatHistory.push(qMsg); storage.saveMessage(qMsg);
      broadcast('chat:message', { msg: qMsg });
      if (!res.headersSent) res.json({ ok: true, queued: true, message: 'saved for retry when backend is available' });
      return;
    }

    // Lỗi thường (không retry): báo lỗi như cũ
    const errorText = `❌ Error: ${err.message || 'Model execution or request failed'}`;
    const fromId = targetAgent ? targetAgent.id : (resolvedTargetId || 'orchestrator');
    const errorMsg: ChatMsg = {
      id: uuidv4(),
      from: fromId,
      to: 'user',
      content: errorText,
      timestamp: Date.now(),
      agentName: targetAgent ? targetAgent.name : 'Orchestrator',
      agentRole: targetAgent ? targetAgent.role : 'orchestrator',
      msgType: 'error'
    };
    chatHistory.push(errorMsg);
    storage.saveMessage(errorMsg);
    broadcast('chat:message', { msg: errorMsg });

    if (targetAgent) {
      targetAgent.status = 'error';
      targetAgent.workingSince = undefined;
      storage.updateAgent(targetAgent.id, { status: 'error', workingSince: null });
      broadcast('agent:updated', { agent: targetAgent });
    } else {
      const orchAgent = agents.get('orchestrator');
      if (orchAgent) {
        orchAgent.status = 'idle';
        storage.updateAgent('orchestrator', { status: 'idle' });
        broadcast('agent:updated', { agent: orchAgent });
      } else {
        broadcast('agent:updated', { agent: { id: 'orchestrator', status: 'idle' } } as any);
      }
    }
    if (!res.headersSent) {
      res.json({ ok: false, error: err.message, response: errorText });
    }
  }
});

// ============ MODELS ============
let cachedModels: string[] = [];
let lastModelsFetch = 0;
let isFetchingModels = false;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getAvailableModels(forceRefresh = false): Promise<string[]> {
  const now = Date.now();
  if (!forceRefresh && cachedModels.length > 0 && (now - lastModelsFetch < MODELS_CACHE_TTL)) {
    return cachedModels;
  }
  if (isFetchingModels && cachedModels.length > 0) {
    return cachedModels;
  }

  isFetchingModels = true;
  return new Promise<string[]>((resolve) => {
    exec('opencode models', { encoding: 'utf-8', timeout: 30000, maxBuffer: 10 * 1024 * 1024, env: process.env, windowsHide: true }, async (err: any, stdout: string, stderr: string) => {
      isFetchingModels = false;
      const raw = (stdout || stderr || '').trim();
      if (err || !raw) {
        // Fallback: Thử lấy danh sách provider từ OpenCode Serve (nếu đang chạy trên port 4096)
        try {
          const r = await fetch('http://127.0.0.1:4096/config/providers', { signal: AbortSignal.timeout(2000) });
          if (r.ok) {
            const data: any = await r.json();
            const list: string[] = [];
            if (Array.isArray(data?.providers)) {
              for (const p of data.providers) {
                if (p?.models && typeof p.models === 'object') {
                  for (const mId of Object.keys(p.models)) {
                    list.push(`${p.id}/${mId}`);
                  }
                }
              }
            }
            if (list.length > 0) {
              cachedModels = list;
              lastModelsFetch = Date.now();
              console.log(`[Models] Cached ${cachedModels.length} models from OpenCode Serve`);
              return resolve(cachedModels);
            }
          }
        } catch {}

        if (cachedModels.length > 0) return resolve(cachedModels);
        return resolve([]);
      }
      const lines = raw.split(/\r?\n/)
        .map((s: string) => s.trim())
        .filter((s: string) => s && !s.startsWith('...') && !s.includes('output truncated') && !s.toLowerCase().includes('warning') && !s.startsWith('['));
      if (lines.length > 0) {
        cachedModels = lines;
        lastModelsFetch = Date.now();
        console.log(`[Models] Cached ${cachedModels.length} models`);
      }
      resolve(cachedModels);
    });
  });
}

// Pre-fetch models at startup
getAvailableModels().catch(() => {});

app.get('/api/models', async (req, res) => {
  try {
    const force = req.query.refresh === 'true';
    const models = await getAvailableModels(force);
    res.json({ models });
  } catch (e: any) {
    res.json({ models: cachedModels, error: e.message });
  }
});

// ============ SETTINGS API ============
app.get('/api/settings/watchdog', (_req, res) => {
  res.json({ enableWatchdog: false });
});

app.post('/api/settings/watchdog', (req, res) => {
  const { enableWatchdog } = req.body || {};
  const enabled = Boolean(enableWatchdog);
  storage.setSetting('enableWatchdog', enabled);
  broadcast('settings:updated', { enableWatchdog: enabled });
  res.json({ success: true, enableWatchdog: enabled });
});

app.get('/api/settings/models', (_req, res) => {
  const modelSettings = storage.getModelSettings();
  res.json(modelSettings);
});

app.post('/api/settings/models', (req, res) => {
  const { orchestratorModel, defaultSubagentModel, agentModelOverrides } = req.body || {};

  if (orchestratorModel !== undefined) {
    if (orchestratorModel) process.env.ORCHESTRATOR_MODEL = orchestratorModel;
    else delete process.env.ORCHESTRATOR_MODEL;
    const orchAgent = agents.get('orchestrator');
    if (orchAgent) {
      orchAgent.model = orchestratorModel || undefined;
      storage.updateAgent('orchestrator', { model: orchestratorModel || null });
    }
    const orchClient = clients.get('orchestrator');
    if (orchClient) orchClient.setModel(orchestratorModel || undefined);
  }

  const updated = storage.setModelSettings({
    orchestratorModel: orchestratorModel !== undefined ? (orchestratorModel || null) : undefined,
    defaultSubagentModel: defaultSubagentModel !== undefined ? (defaultSubagentModel || null) : undefined,
    agentModelOverrides: agentModelOverrides !== undefined ? agentModelOverrides : undefined
  });

  // Re-apply resolved models to all active clients
  for (const [id, agent] of agents.entries()) {
    if (id === 'orchestrator') continue;
    const client = clients.get(id);
    if (client) {
      const resolved = resolveModelForAgent(agent);
      client.setModel(resolved || undefined);
    }
  }

  broadcast('settings:updated', { models: updated });
  res.json({ ok: true, settings: updated });
});

// ============ ORCHESTRATOR ============
app.get('/api/history', (req, res) => {
  // Pagination support: ?limit=N (mặc định 200, tối đa 1000) & ?beforeId=<msgId> (tin nhắn cũ hơn id này) & ?agentId=<id>
  const qLimit = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : undefined;
  const qBeforeId = req.query.beforeId !== undefined ? String(req.query.beforeId) : undefined;
  const qAgentId = req.query.agentId !== undefined ? String(req.query.agentId) : undefined;
  res.json(storage.getHistoryPage({
    limit: Number.isFinite(qLimit) ? qLimit : undefined,
    beforeId: qBeforeId,
    agentId: qAgentId
  }));
});
app.get('/api/messages', (_req, res) => res.json(chatHistory));

// Set model cho main (orchestrator) — giữ session cũ, chỉ đổi model áp dụng cho session này
app.post('/api/orchestrator/model', (req, res) => {
  const { model } = req.body || {};
  if (model) process.env.ORCHESTRATOR_MODEL = model; else delete process.env.ORCHESTRATOR_MODEL;
  storage.setSetting('orchestratorModel', model || null);
  const orchAgent = agents.get('orchestrator');
  if (orchAgent) {
    orchAgent.model = model || undefined;
    storage.updateAgent('orchestrator', { model: model || null });
  }
  const orchClient = clients.get('orchestrator');
  if (orchClient) orchClient.setModel(model || undefined); // KHÔNG reset client → giữ session
  broadcast('settings:updated', { models: storage.getModelSettings() });
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

    // Xoá client + session mapping + DB record
    clients.delete('orchestrator');
    ACPClient.unregisterSession('orchestrator');
    storage.updateAgent('orchestrator', { sessionId: null, sessionTitle: null });
    
    // Update in-memory orchestrator agent immediately and broadcast for UI sync
    const orchAgent = agents.get('orchestrator');
    if (orchAgent) {
      orchAgent.sessionId = undefined;
      orchAgent.sessionTitle = undefined;
      broadcast('agent:updated', { agent: orchAgent });
    }
    
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
    storage.updateAgent('orchestrator', { sessionId: null, sessionTitle: null });
    
    // Also update in-memory agent on error path
    const orchAgent = agents.get('orchestrator');
    if (orchAgent) {
      orchAgent.sessionId = undefined;
      orchAgent.sessionTitle = undefined;
      broadcast('agent:updated', { agent: orchAgent });
    }
    
    res.json({ ok: false, error: e.message });
  }
});

// Clear worker agent conversation + session opencode
app.post('/api/agents/:id/clear', async (req, res) => {
  const agentId = req.params.id;
  const agent = agents.get(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  let sessionDeleted = false;
  let deleteError: string | null = null;
  try {
    const client = clients.get(agentId);
    if (client) {
      const sid = client.getSessionId();
      if (sid) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            sessionDeleted = await client.deleteSession(sid);
            if (sessionDeleted) break;
          } catch (delErr: any) {
            deleteError = delErr.message;
            console.log(`[Clear] Delete session attempt ${attempt + 1} failed for agent ${agentId}: ${delErr.message}`);
          }
        }
      }
    } else if (agent.sessionId) {
      try {
        const tmpClient = new ACPClient({ id: agentId, name: agent.name, role: agent.role, type: 'worker' });
        tmpClient.setSession(agent.sessionId);
        sessionDeleted = await tmpClient.deleteSession();
      } catch (delErr: any) {
        deleteError = delErr.message;
      }
    }

    clients.delete(agentId);
    ACPClient.unregisterSession(agentId);
    storage.updateAgent(agentId, { sessionId: null, sessionTitle: null });

    agent.sessionId = undefined;
    agent.sessionTitle = undefined;
    broadcast('agent:updated', { agent });

    // Xoá hội thoại của agent này
    const keep: ChatMsg[] = [];
    chatHistory.forEach(msg => {
      const isAgentView = msg.from === agentId || msg.to === agentId;
      if (!isAgentView) keep.push(msg);
    });
    chatHistory.length = 0;
    chatHistory.push(...keep);
    storage.clearAgentConversation(agentId);
    broadcast('chat:message', { action: 'clear', agentId });

    res.json({ ok: true, sessionDeleted, warning: !sessionDeleted ? 'Session delete failed, local state cleared' : undefined });
  } catch (e: any) {
    clients.delete(agentId);
    ACPClient.unregisterSession(agentId);
    storage.updateAgent(agentId, { sessionId: null, sessionTitle: null });

    agent.sessionId = undefined;
    agent.sessionTitle = undefined;
    broadcast('agent:updated', { agent });

    res.json({ ok: false, error: e.message });
  }
});

// Restart Server Endpoint (Detached Spawn)
app.post('/api/restart', (_req, res) => {
  res.json({ success: true, message: 'Restarting AgentForge server...' });
  setTimeout(() => {
    try {
      const batPath = join(process.cwd(), 'start.bat');
      const isWin = process.platform === 'win32';
      const child = spawn(
        isWin ? 'cmd.exe' : 'sh',
        isWin ? ['/c', batPath] : ['-c', 'npm start'],
        {
          detached: true,
          stdio: 'ignore',
          cwd: process.cwd()
        }
      );
      child.unref();
    } catch (e: any) {
      console.error('[Restart] Failed to spawn restart process:', e);
    }
    process.exit(0);
  }, 500);
});

// ============ STATIC ============
// SEA-aware: khi chạy bản exe Single Executable, asset nằm trong blob (node:sea.getAsset).
// Thu tu doc: SEA asset -> cwd (chay tu source) -> __dirname snapshot.
// earlySeaGetAsset da khoi tao o dau file cho loadPrompt; tai su dung de tranh log trung.
import { createRequire } from 'module';
const nodeRequire = createRequire(import.meta.url);

let seaGetAsset: ((key: string) => ArrayBuffer) | null = earlySeaGetAsset;
if (!seaGetAsset) {
  try {
    const seaMod = nodeRequire('node:sea');
    if (typeof seaMod.isSea === 'function' && seaMod.isSea()) {
      seaGetAsset = seaMod.getAsset;
      console.log('[Server] Running as SEA single executable — static assets embedded.');
    }
  } catch {}
} else {
  // da log o earlySeaGetAsset? chua log nen log 1 lan
  console.log('[Server] Running as SEA single executable — static assets embedded.');
}

const STATIC_BASES = [
  process.cwd(),
  join(__dirname, '..'),          // dist/server.js -> gốc dự án (snapshot: /snapshot)
];

function readFileStatic(relKey: string): Buffer | null {
  if (seaGetAsset) {
    try { return Buffer.from(seaGetAsset(relKey.split('\\').join('/'))); } catch {}
  }
  for (const base of STATIC_BASES) {
    const p = join(base, relKey);
    if (existsSync(p)) {
      try { return readFileSync(p); } catch {}
    }
  }
  return null;
}

function resolveStatic(...parts: string[]): string | null {
  for (const base of STATIC_BASES) {
    const p = join(base, ...parts);
    if (existsSync(p)) return p;
  }
  return null;
}

const MIME_MAP: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.html': 'text/html', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain'
};

app.use('/assets', express.static(join(process.cwd(), 'web', 'dist', 'assets')));
// Fallback cho pkg-exe: serve assets từ snapshot nếu cwd không có thư mục web
app.use('/assets', express.static(join(__dirname, '..', 'web', 'dist', 'assets')));

// Fallback SEA: serve assets nhúng trong exe
app.get('/assets/*', (req, res) => {
  const rel = join('web', 'dist', 'assets', (req.params as any)[0] || '');
  const buf = readFileStatic(rel);
  if (!buf) { res.status(404).end(); return; }
  const ext = (rel.match(/\.[a-z0-9]+$/i) || ['.txt'])[0].toLowerCase();
  res.type(MIME_MAP[ext] || 'application/octet-stream').send(buf);
});

app.get('/', (_req, res) => {
  const buf = readFileStatic(join('dist', 'index.html'));
  if (!buf) { res.status(500).send('Legacy HTML not found'); return; }
  res.type('html').send(buf.toString('utf-8'));
});
app.get(['/v2', '/v2/*'], (_req, res) => {
  const buf = readFileStatic(join('web', 'dist', 'index.html'));
  if (!buf) { res.status(500).send('Vite build not found — run: npm run build'); return; }
  res.type('html').send(buf.toString('utf-8'));
});

// ============ SSE ============
const sseHandler = (req: express.Request, res: express.Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'none',
    'Access-Control-Allow-Origin': '*'
  });

  res.write(': connected\n\n');
  if (typeof (res as any).flush === 'function') (res as any).flush();

  sseClients.add(res);

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
      if (typeof (res as any).flush === 'function') (res as any).flush();
    } catch {
      clearInterval(keepAliveTimer);
      sseClients.delete(res);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    sseClients.delete(res);
  });
};

app.get('/api/events', sseHandler);
app.get('/events', sseHandler);

// ============ WS ============
wss.on('connection', (ws) => {
  wsClients.add(ws);
  (ws as any)._isAlive = true;
  ws.on('pong', () => { (ws as any)._isAlive = true; });
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => { try { ws.terminate(); } catch {} });
});

// Heartbeat: phat hien socket chet am tham (half-open) de client reconnect kip,
// khac phuc "phai F5 moi thay tin nhan" sau khi server restart/treo mang.
const WS_HEARTBEAT_MS = 30000;
const wsHeartbeatTimer = setInterval(() => {
  wss.clients.forEach((c: any) => {
    if (c._isAlive === false) { try { c.terminate(); } catch {} return; }
    c._isAlive = false;
    try { c.ping(); } catch {}
  });
}, WS_HEARTBEAT_MS);
(wsHeartbeatTimer as any).unref?.();

// ============ STARTUP ============
loadState();
syncOpencodeAgents();
loadCustomRoles();
startTitlePoller();

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

// Graceful Shutdown
let isShuttingDown = false;
function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[Server] Graceful shutdown initiated...');

  if (titlePollerTimer) clearInterval(titlePollerTimer);

  // Close SSE clients
  sseClients.forEach(res => {
    try { res.end(); } catch {}
  });
  sseClients.clear();

  // Abort running processes and kill all child process trees
  for (const [, client] of clients) {
    try { client.abort(); } catch {}
  }
  try { ACPClient.killAllChildProcesses(); } catch {}

  // WAL checkpoint & SQLite cleanup
  try { storage.close(); } catch {}

  server.close(() => {
    console.log('[Server] Shutdown complete.');
    process.exit(0);
  });

  // Force exit after 3s if hanging
  setTimeout(() => {
    try { ACPClient.killAllChildProcesses(); } catch {}
    process.exit(0);
  }, 3000).unref();
}

process.on('exit', () => {
  try { ACPClient.killAllChildProcesses(); } catch {}
});
process.on('SIGINT', () => {
  try { ACPClient.killAllChildProcesses(); } catch {}
  gracefulShutdown();
});
process.on('SIGTERM', () => {
  try { ACPClient.killAllChildProcesses(); } catch {}
  gracefulShutdown();
});

// Khi khởi động lại (sau mất điện / crash): gửi lại mọi report còn pending trong outbox DB.
// Reset attempts về 0 để mỗi lần chạy lại đều thử gửi lại (đúng ý người dùng: "chạy lại thì gửi lại").
async function replayPendingReports() {
  const pending = storage.getPendingOutbox();
  if (pending.length === 0) return;
  console.log(`[Outbox] Replaying ${pending.length} pending report(s) from DB...`);
  storage.resetOutboxAttempts(pending.map(r => r.id));
  for (const r of pending) {
    const fromAgent = (agents.get(r.fromAgentId) || {
      id: r.fromAgentId, name: r.fromAgentName, role: r.fromAgentRole
    }) as Agent;
    if (r.to === 'orchestrator') {
      await triggerOrchestrator(fromAgent, r.message, r.id);
    } else {
      const target = agents.get(r.to) || findAgentByIdNameOrRole(r.to);
      if (target) {
        await deliverTalk(target, fromAgent, { to: r.to, message: r.message }, r.id);
      } else {
        // Agent đích đã bị xóa → đánh dấu delivered để không retry vô hạn
        storage.markOutboxDelivered(r.id);
      }
    }
  }
  storage.pruneDeliveredOutbox();
}

// ============ PORT FALLBACK LAUNCH ============
function logPortHelp(startPort: number) {
  console.error(`\n[Server] ⚠️  Không thể bind port. Hướng dẫn:`);
  console.error(`[Server]  • Đóng tiến trình đang chiếm port, HOẶC`);
  console.error(`[Server]  • Khởi chạy với PORT khác: PORT=${startPort + 1} npm run dev`);
  console.error(`[Server]  • Hoặc dùng start.bat để tự động dọn port.\n`);
}

// Dò port trống chủ động trước khi bind (tham khảo isPortAvailable dùng net.createServer
// trong src/electron/main.ts). Giữ nguyên startServerWithPortFallback (EADDRINUSE handler)
// làm lớp phòng thủ thứ 2 chống race TOCTOU: port trống lúc dò có thể bị chiếm lúc bind.
function findAvailablePort(startPort: number, maxTries = 20): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (p: number, left: number) => {
      if (left <= 0) {
        // Hết phạm vi dò → trả port gốc, để EADDRINUSE handler của startServerWithPortFallback xử lý tiếp
        resolve(startPort);
        return;
      }
      const probe = net.createServer();
      probe.once('error', () => {
        console.warn(`[Server] Port ${p} đang được sử dụng → dò port kế tiếp...`);
        tryPort(p + 1, left - 1);
      });
      probe.once('listening', () => {
        probe.close(() => resolve(p));
      });
      try {
        probe.listen(p);
      } catch {
        try { probe.close(); } catch {}
        tryPort(p + 1, left - 1);
      }
    };
    tryPort(startPort, maxTries);
  });
}

function startServerWithPortFallback(port: number) {
  const onError = (err: any) => {
    server.removeListener('error', onError);
    if (err && err.code === 'EADDRINUSE') {
      // Thử tăng port VÔ HẠN (port+1, port+2...) — chỉ dừng ở biên hợp lý 65535
      if (port >= 65535) {
        console.error(`[Server] Fatal: đã thử hết dải port hợp lệ từ ${PORT} đến 65535 mà không tìm được port trống.`);
        logPortHelp(PORT);
        process.exit(1);
        return;
      }
      const next = port + 1;
      console.warn(`[Server] Port ${port} bị chiếm → tự động thử port ${next}`);
      startServerWithPortFallback(next);
    } else {
      console.error(`[Server] Lỗi khởi động server không xác định:`, err);
      logPortHelp(PORT);
      process.exit(1);
    }
  };

  server.once('error', onError);
  server.listen(port, () => {
    server.removeListener('error', onError);
    process.env.PORT = String(port);
    console.log(`[Server] Server listening on port ${port}`);
    console.log(`\n🚀 AgentForge v7: http://localhost:${port}\n`);

    // AUTO-OPEN: mo trinh duyet mac dinh khi khoi dong standalone tren Windows.
    // Electron tu spawn server va hien cua so rieng nen KHONG mo them tab;
    // tat bang --no-open hoac OPEN_BROWSER=0.
    const noOpen = process.argv.includes('--no-open') || process.env.OPEN_BROWSER === '0'
      || !!process.env.ELECTRON_RUN_AS_NODE || !!process.env.ELECTRON;
    if (!noOpen) {
      const url = `http://localhost:${port}/v2`;
      try {
        if (process.platform === 'win32') exec(`start "" "${url}"`);
        console.log(`[Server] Opened browser: ${url}`);
      } catch {}
    }

    // Sau 1s để orchestrator client kịp init trước khi replay
    setTimeout(() => {
      replayPendingReports().catch(e => console.error(`[Outbox] Replay failed: ${e.message}`));
      processChatRetryQueue().catch(e => console.error(`[ChatQueue] Replay failed: ${e.message}`));
      scheduleChatRetry();
    }, 1000);
  });
}

// Runtime error safety net: bat toan bo loi khong xu ly, in STACK day du ra console
// va dam len UI (300 ky tu cu) de thay ngay file:dong thay vi thong bao trong.
function emitRuntimeError(kind: string, err: any) {
  const msg = err?.message || String(err || 'unknown');
  const stack = err?.stack || '';
  console.error(`[${kind}]`, stack || msg);
  try {
    const tail = stack ? stack.split('\n').slice(-4).join(' | ').slice(0, 300) : '';
    const errMsg: ChatMsg = {
      id: uuidv4(), from: 'system', to: 'user',
      content: `❌ ${kind}: ${msg}${tail ? `\n↳ ${tail}` : ''}`,
      timestamp: Date.now(), agentName: 'System', agentRole: 'system', msgType: 'error'
    };
    chatHistory.push(errMsg); storage.saveMessage(errMsg);
    broadcast('chat:message', { msg: errMsg });
  } catch {}
}
process.on('uncaughtException', (err) => {
  emitRuntimeError('UncaughtException', err);
  try { ACPClient.killAllChildProcesses(); } catch {}
});
process.on('unhandledRejection', (reason) => {
  emitRuntimeError('UnhandledRejection', reason);
  try { ACPClient.killAllChildProcesses(); } catch {}
});

// Khởi động: dò port trống chủ động từ PORT (mặc định 3001) rồi mới bind;
// startServerWithPortFallback vẫn là lớp phòng thủ EADDRINUSE nếu port bị chiếm sau lúc dò.
findAvailablePort(PORT).then((freePort) => {
  if (freePort !== PORT) {
    console.warn(`[Server] Port ${PORT} bận → dùng port trống kế tiếp ${freePort}`);
  }
  startServerWithPortFallback(freePort);
});
