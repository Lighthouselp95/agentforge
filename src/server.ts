// AgentForge v7 — Multi-Agent Orchestrator (run transport)
import express from 'express';
import { createServer } from 'http';
import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketManager } from './ws/index.js';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { exec, execSync, spawn } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { ACPClient } from './agents/acp-client.js';
import type { TokenUsage } from './agents/types.js';
import { storage, MAX_PERSISTED_MESSAGES, DEFAULT_TEAM_SETTINGS, countRealTasks, evictOldestCompletedTask, type SystemLogEntry, type TeamSettings, type SpawnGateUsage } from './storage.js';
import { createApiRouter } from './routes/index.js';
import { createTerminalRouter } from './routes/terminal.js';
import {
  initTeamIsolation,
  isOrchestratorLike,
  findExistingOrchestrator,
  resolveOrchIdForMsg,
  resolveOrchestratorTarget,
  findAgentByIdNameOrRole,
  getAgentTeamId,
  getAgentsByTeam,
  getAgentsByRole,
  getRoleLimit,
  MAX_AGENT_TASKS,
  MAX_TEAM_SIZE,
  getTeamSettingsLive,
  getEffectiveRoleLimit,
  getEffectiveTeamSizeLimit,
  getEffectiveTaskLimit,
  checkLiveSpawnGate,
  cleanTargetIdentifier,
  INVALID_TARGET_PLACEHOLDERS
} from './relay/index.js';

const execAsync = promisify(exec);

// ============ TERMINAL LOG BUFFER (ring buffer) ============
// Lưu tối đa LOG_BUFFER_MAX dòng console.log/error của server process, phục vụ GET /logs
// và push realtime qua broadcast('terminal:line') cho trang /terminal.
const LOG_BUFFER_MAX = 5000;
const logBuffer: string[] = [];

// Lazy storage ref to avoid TDZ: storage is imported at top-level but `pushLogLine`
// may be called DURING module evaluation (when console.log override fires), before
// the imported `storage` binding is fully resolved. This ref gets initialized lazily.
let storageRef: any = null;

function pushLogLine(rawArgs: any[], level: 'info' | 'warn' | 'error' | 'debug' = 'info'): string {
    const line = rawArgs.map(a => (typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : safeStringify(a)))).join(' ');
    const ts = new Date().toISOString();
    logBuffer.push(`[${ts}] ${line}`);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
    
    // Trích xuất source tag nếu có (ví dụ [Server], [Storage], [Outbox], [Talk])
    const tagMatch = line.match(/^\[([a-zA-Z0-9_-]+)\]/);
    const source = tagMatch ? tagMatch[1].toLowerCase() : 'system';
    try {
        const stor = storageRef;
        if (stor) {
            stor.saveLog({
                level,
                source,
                message: line
            });
        }
    } catch {}

    return line;
}
function safeStringify(v: any): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn = console.warn.bind(console);
console.log = (...args: any[]) => {
  const line = pushLogLine(args, 'info');
  _origLog(...args);
  try { broadcast('terminal:line', { line }); broadcast('log:entry', { level: 'info', message: line, timestamp: Date.now() }); } catch {}
};
console.error = (...args: any[]) => {
  const line = pushLogLine(args, 'error');
  _origError(...args);
  try { broadcast('terminal:line', { line }); broadcast('log:entry', { level: 'error', message: line, timestamp: Date.now() }); } catch {}
};
console.warn = (...args: any[]) => {
  const line = pushLogLine(args, 'warn');
  _origWarn(...args);
  try { broadcast('terminal:line', { line }); broadcast('log:entry', { level: 'warn', message: line, timestamp: Date.now() }); } catch {}
};

// Initialize lazy storage ref AFTER module imports have resolved (avoids TDZ)
storageRef = storage;

const __dirname = dirname(fileURLToPath(new URL('.', import.meta.url)));
const APP_VERSION = '7.0.30';
const PORT = parseInt(process.env.PORT || '4001');

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
let wsManager: WebSocketManager;
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
  // 1) Filesystem first: uu tien doc tu src/prompts de bat kip thay doi code/prompt ma khong bi cache SEA
  for (const dir of PROMPTS_CANDIDATE_DIRS) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf-8'); } catch {}
    }
  }
  // 2) SEA embedded: khi exe copy sang thu muc khac khong co thu muc src/prompts
  if (earlySeaGetAsset) {
    try {
      const key = ('src/prompts/' + name).split('\\').join('/');
      const buf = earlySeaGetAsset(key);
      if (buf) return Buffer.from(buf).toString('utf-8');
    } catch {}
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
Hệ thống hỗ trợ song song 2 định dạng lệnh (Dual-Syntax). Khuyến nghị ưu tiên cú pháp XML tags <...>:

CRITICAL SYNTAX RULE: Khi phát lệnh điều phối (<spawn>, <talk>, <stop>, <resume>, <create_role>, <task_update>), BẮT BUỘC viết thẻ XML trực tiếp ngoài văn bản (Bare XML Tags). TUYỆT ĐỐI KHÔNG bọc thẻ lệnh thực thi bên trong fenced code blocks hoặc dấu backtick, vì parser sẽ coi đó là code minh họa và bỏ qua không thực thi.

1. SPAWN — Khởi tạo agent mới:
   <spawn role="<role>" name="<name>" task="<specific task description>" />

2. TALK — Gửi tin nhắn tới agent đang tồn tại (và cập nhật task mới nếu có):
   <talk target="<name/id>" task="<specific new task description (optional)>">message</talk>
   hoặc <talk target="<name/id>">message</talk>

3. STOP — Dừng agent bị kẹt:
   <stop target="<agent-id>" />

4. RESUME — Phục hồi agent đã dừng:
   <resume target="<agent-id>" />

5. CREATE ROLE — Tạo role agent tùy biến kèm prompt file:
   <create_role name="<role-name>" description="<what this role does>" capabilities="<cap1,cap2,cap3>" rules="<rule1|rule2|rule3>" />
   Sau khi tạo, có thể dùng <spawn role="<role-name>" ... /> để khởi chạy.
   Rules phân tách bằng dấu | (pipe). Capabilities phân tách bằng dấu , (comma).

6. TASK_UPDATE — Cập nhật nhiệm vụ và trạng thái của Agent:
   <task_update agent="<name/id>" task="<nội dung task mới>" status="pending|working|completed|idle" />

=== RULES ===
1. CRITICAL SYNTAX RULE: Khi phát lệnh điều phối (<spawn>, <talk>, <stop>, <resume>, <create_role>, <task_update>), BẮT BUỘC viết thẻ XML trực tiếp ngoài văn bản (Bare XML Tags). TUYỆT ĐỐI KHÔNG bọc thẻ lệnh thực thi bên trong fenced code blocks hoặc dấu backtick, vì parser sẽ coi đó là code minh họa và bỏ qua không thực thi.
2. ALWAYS decompose user tasks into specific subtasks before spawning
3. Each SPAWN must have: role, name (short lowercase), task (specific with file paths)
4. PARALLEL DECOMPOSITION & NON-CONFLICTING LOGIC MANDATE: Mọi bài toán/nhiệm vụ có các nhánh logic độc lập (không chỉ khác tệp, mà kể cả khi chung một tệp hoặc cùng một tầng nhưng xử lý các hàm khác nhau, endpoint khác nhau, UI component khác nhau hoặc luồng logic hoàn toàn không phụ thuộc lẫn nhau) BẮT BUỘC PHẢI PHÂN RÃ VÀ SPAWN/DISPATCH ĐỒNG LOẠT SONG SONG NGAY TỪ ĐẦU cho nhiều Coder/Specialist agents cùng làm. TUYỆT ĐỐI KHÔNG làm tuần tự khi các luồng logic không va chạm.
5. REUSE ONLY IF IDLE: If you SPAWN a name that already exists, reuse it ONLY when that agent is currently 'idle'. If it is 'working', you MUST spawn a new name or choose another idle agent. Do not assign new work to a working agent.
6. Orchestrator TUYỆT ĐỐI KHÔNG được xóa agent. Khi một agent không còn cần thiết, bị lỗi hoặc kẹt, Orchestrator chỉ được <stop target="..." /> agent và báo cáo/đề xuất User xóa agent trên giao diện.
7. Instance limit rules by role: coder role is limited to a maximum of 4 active instances. researcher role is limited to a maximum of 2 active instances. All other roles (verifier, tester, reviewer, docs, planner, debugger, searcher, idea, and any custom role) are limited to a maximum of 1 active instance.
8. IDLE-FIRST dispatch: Before any <talk>/<spawn>, check the [TEAM] table and ONLY select agents whose status is 'idle'. If no idle agent exists for the required role, spawn a new instance. When the system sends '[Role Limit]', immediately switch to <talk target="..." /> with an available idle agent instead of spawning.
9. RESEARCH FIRST RULE: Before implementing any changes, fixing bugs, or writing code, you MUST first research the codebase, read the relevant files, check documentation, or search online resources to gather context and understand the implementation details.
10. Monitor progress — if an agent works > 3 minutes, use <talk target="..."> to ask for status
11. If an agent is stuck, STOP it then RESUME with clearer instructions
12. When all agents report back, summarize results to the user
13. NEVER do the coding work yourself — delegate to specialist agents
14. If existing roles don't fit, CREATE ROLE first, then SPAWN with it
15. Use existing roles first — only CREATE ROLE when necessary
16. PHÂN QUYỀN THỰC THI TÀI LIỆU MARKDOWN: Main Orchestrator có toàn quyền ghi chép, chỉnh sửa, tạo mới và cập nhật trực tiếp toàn bộ các tài liệu markdown (*.md), bao gồm CHANGELOG.md, README.md, tài liệu kiến trúc và hướng dẫn kỹ thuật mà không bị giới hạn quyền. Orchestrator có thể tự mình cập nhật tài liệu hoặc giao việc cho worker khi cần.
17. QUY TẮC BẮT BUỘC: CÁC AGENT KHÔNG CHUNG TRÍ NHỚ (ISOLATED SESSIONS & INFORMATION RELAY): Mỗi agent hoạt động trong một session độc lập và HOÀN TOÀN KHÔNG BIẾT trí nhớ hay tiến trình làm việc của agent khác trừ khi được truyền đạt. Khi giao tiếp/giao việc (<talk>, <spawn>), BẮT BUỘC phải cung cấp đầy đủ ngữ cảnh kỹ thuật: đường dẫn tệp tin chính xác (exact paths), thông điệp lỗi (verbatim errors), các quyết định trước đó và yêu cầu nghiệm thu cụ thể, không giả định đối phương đã biết.

=== EXAMPLES ===
User: "Build a Python calculator with tests"
You respond with:
<spawn role="coder" name="calc" task="Create calculator.py with add(a,b), subtract(a,b), multiply(a,b), divide(a,b) functions. Add type validation and division by zero handling." />
<spawn role="tester" name="test" task="Create test_calculator.py with unit tests for all calculator functions. Test edge cases: type errors, division by zero, negative numbers." />

Example multi-coder parallel decomposition:
TASK: Build user auth with tests and docs
SUBTASKS:
1. [coder] auth-backend: Implement JWT auth in src/auth.ts
2. [coder] auth-frontend: Add login form in src/App.tsx
3. [tester] auth-test: Write unit tests in tests/auth.test.ts
4. [docs] auth-doc: Write README section for auth flow
DEPENDENCIES: 3 depends on 1; 4 depends on 1 and 2
PARALLEL_GROUPS: [1,2] run together; [3,4] run after 1 and 2 complete

Summarize all progress to the user in a clear, concise way.`;

const ORCH_REMINDER = `\n\n=== SYSTEM REMINDER ===
You are the Orchestrator. You MUST communicate with workers using:
<spawn role="<role>" name="<name>" task="<task>" />
<talk target="<name/id>" task="<task>">your message</talk>
<stop target="<target-id>" />
<resume target="<target-id>" />
<task_update agent="<target-id>" id="<task-id>" status="pending|working|completed|idle" />
<task_update agent="<target-id>" task="<task-mới>" status="working|pending" />

Always decompose tasks before spawning. Do NOT do the work yourself. Orchestrator CANNOT delete agents; use <stop target="..." /> and ask the user to delete if necessary. Respond to the user in a clear, concise way.`;

const WORKER_REMINDER = `\n\n=== SYSTEM REMINDER ===
Use <talk target="<target-id>">your message</talk> for communications.`;

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

function syncOpencodeAgents(targetProjectDir?: string) {
  try {
    const isCustomDir = !!(targetProjectDir && resolve(targetProjectDir) !== resolve(SERVER_PROJECT_ROOT));
    const agentsDir = isCustomDir ? join(targetProjectDir, '.opencode', 'agents') : OPENCODE_AGENTS_DIR;
    mkdirSync(agentsDir, { recursive: true });
    
    // Load Base Rules & Formats
    const workerBase = loadPrompt('worker-base.md') || '';
    const agentMsgFormat = loadPrompt(join('formats', 'agent-message.md')) || '';
    const formatsSection = [agentMsgFormat].filter(Boolean).join('\n\n');

    // 1. Sync Orchestrator
    const orchPrompt = loadPrompt('orchestrator.md') || ORCH_PROMPT;
    const orchAgentContent = `---
name: orchestrator
description: ${ROLE_DESCRIPTIONS.orchestrator}
mode: primary
permission:
  "*": deny
  edit:
    "*": deny
    "*.md": allow
  write:
    "*": deny
    "*.md": allow
  glob: allow
  webfetch: allow
  websearch: allow
  task: deny
  bash: deny
---

${orchPrompt}
`;
    writeFileSync(join(agentsDir, 'orchestrator.md'), orchAgentContent, 'utf-8');
    console.log(`[SSoT] Synced ${isCustomDir ? join(targetProjectDir!, '.opencode', 'agents') : '.opencode/agents'}/orchestrator.md`);

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
      writeFileSync(join(agentsDir, `${role}.md`), fullPrompt, 'utf-8');
      console.log(`[SSoT] Synced ${isCustomDir ? join(targetProjectDir!, '.opencode', 'agents') : '.opencode/agents'}/${role}.md`);
    }
  } catch (err: any) {
    console.warn(`[SSoT] Failed to sync .opencode/agents${targetProjectDir ? ` in ${targetProjectDir}` : ''}: ${err.message}`);
  }
}

// ============ STATE ============
export interface AgentTask {
  id: string;
  task: string;
  status: 'pending' | 'working' | 'completed';
  createdAt: number;
  completedAt?: number;
}

interface Agent {
  id: string; name: string; role: string; type: 'orchestrator' | 'worker';
  status: 'idle' | 'working' | 'error' | 'stopped';
  spawnedBy?: string; projectDir?: string; model?: string;
  teamId?: string; // Nhóm team (orchestrator) agent thuộc về — tách lịch sử chat giữa các team
  sessionId?: string; sessionTitle?: string;
  task?: string;
  tasks?: AgentTask[];
  createdAt: number;
  workingSince?: number;
  tokenUsage?: TokenUsage;
  contextLength?: number;
}
interface ChatMsg {
  id: string; from: string; to: string; content: string;
  task?: string;
  timestamp: number; agentName?: string; agentRole?: string;
  teamId?: string; // Nhóm team tin nhắn thuộc về — dùng tách lịch sử giữa các team
  msgType?: string;
  showOnUI?: boolean;
  isQueued?: boolean;
  // Dữ liệu toolcall cấu trúc lấy từ event gốc của opencode (nguồn cho UI toolcall)
  toolCalls?: Array<{ tool: string; input?: string; output?: string }>;
  // Suy nghĩ nội bộ của model (reasoning/thinking) — tách khỏi content
  thinking?: string;
  // Cho phép hiển thị thinking block (chỉ khi có explicit 'in' event)
  allowThinking?: boolean;
  // Option C: ordered parts (text + tool xen kẽ theo đúng thứ tự opencode emit)
  parts?: Array<{ type: 'text' | 'tool'; content?: string; tool?: string; input?: any; output?: any }>;
}

const agents = new Map<string, Agent>();
const clients = new Map<string, ACPClient>();
const chatHistory: ChatMsg[] = [];

// Initialize Team Isolation and Relay Resolution context
initTeamIsolation({
  getAgentsMap: () => agents,
  getStorage: () => storage
});

/**
 * Tạo ChatMsg với teamId BẮT BUỘC được resolve đúng — thay thế mọi literal `new ChatMsg`
 * thiếu teamId (nguồn relay sai team). Thứ tự resolve:
 * 1. fields.teamId (explicit) → 2. agent `to` trong memory → 3. agent `from` trong
 * memory → 4. storage.getAgent(to/from) → 5. KHÔNG bịa team-${slice}: trả undefined
 * để caller/bộ lọc xử lý trung thực.
 */
function createChatMsg(
  to: string,
  from: string,
  content: string,
  fields: Partial<ChatMsg> = {}
): ChatMsg {
  let teamId: string | undefined = fields.teamId;
  if (!teamId) {
    if (to === 'orchestrator' || from === 'orchestrator') {
      teamId = findExistingOrchestrator()?.teamId || 'default';
    }
  }
  if (!teamId) {
    const toAgent = agents.get(to);
    if (toAgent?.teamId) teamId = toAgent.teamId;
  }
  if (!teamId && from !== 'user' && from !== 'system') {
    const fromAgent = agents.get(from);
    if (fromAgent?.teamId) teamId = fromAgent.teamId;
  }
  if (!teamId) {
    try {
      const stored: any = storage.getAgent(to) || storage.getAgent(from);
      const st = stored?.teamId || stored?.team_id;
      if (typeof st === 'string' && st) teamId = st;
    } catch {}
  }
  return {
    id: uuidv4(),
    from,
    to,
    content,
    timestamp: Date.now(),
    ...fields,
    ...(teamId ? { teamId } : {})
  };
}
const wsClients = new Set<WebSocket>();
const sseClients = new Set<express.Response>();
wsManager = new WebSocketManager(wss, wsClients);
wsManager.init();

// Track unread messages per orchestrator (Map<orchId, ChatMsg[]>) — workers reply to orchestrator
const unreadForOrchestrator = new Map<string, ChatMsg[]>();
// Track message IDs sent to orchestrator batch to prevent duplicates
const trackedMessageIds = new Set<string>();

// ===== Dedup broadcast UI: chống nhân đôi bubble khi cùng nội dung xử lý 2 lần =====
// Khóa dedup = content-based (from|to|msgType|chuẩn hoá whitespace content) trong cửa sổ TTL.
// Trước đây khóa = msg.id (uuidv4 mới mỗi call) → dedup vô hiệu với bubble trùng từ 2 call riêng biệt.
const BROADCAST_DEDUP_TTL_MS = 30000;
const broadcastDedup = new Map<string, number>();
function broadcastDedupKey(msg: ChatMsg): string {
  const norm = String(msg.content || '').replace(/\s+/g, ' ').trim();
  return `${msg.from || ''}|${msg.to || ''}|${msg.msgType || ''}|${norm}`;
}
function isBroadcastDuplicate(key: string): boolean {
  if (!key) return false;
  const now = Date.now();
  const last = broadcastDedup.get(key);
  if (last !== undefined && now - last < BROADCAST_DEDUP_TTL_MS) {
    return true;
  }
  broadcastDedup.set(key, now);
  // Dọn dẹp bounded: xóa các entry quá cũ để tránh memory leak
  if (broadcastDedup.size > 3000) {
    for (const [k, v] of broadcastDedup) {
      if (now - v > BROADCAST_DEDUP_TTL_MS) broadcastDedup.delete(k);
    }
  }
  return false;
}

// Per-agent thinking gate: cho phép broadcast realtime chat:thinking chỉ khi
// agent đã nhận event 'in' (prompt input) → user chưa tắt thinking.
// Set true khi 'in' event đến, reset ở turn mới (nếu cần).
const agentThinkingAllowed = new Set<string>();

// Prevent duplicate synthesis when multiple agents complete simultaneously
const synthesisTriggered = new Set<string>();

// ===== FIX DUP ORCHESTRATOR (Option A): Batch-level coordination =====
// 2 path song song cùng broadcast orchestrator→user cho 1 lần agent hoàn thành:
//   Path A processOrchestratorTriggerQueue (L2359) — per-report turn.
//   Path B checkAndSynthesize (L1266) — summary tổng hợp khi TẤT CẢ spawnedByOrch idle.
// Cả 2 dùng prompt khác nên content khác → dedup content-based KHÔNG bắt → 2 bubble main.
// Giải pháp: khi checkAndSynthesize xác nhận 1 batch allDone (đang chờ synthesis 1.8s),
// đánh dấu batchKey vào set này NGAY (trước khi trigger queue fire 1.5s).
// processOrchestratorTriggerQueue kiểm tra set: nếu batch đang chờ synthesis → KHÔNG
// broadcast bubble per-report (vẫn enqueue orchestrator để không mất điều phối).
// Xóa khi synthesis chạy xong để agent cùng batch, turn mới vẫn broadcast bình thường.
// In-memory chỉ (restart reset) → replay outbox không bị chặn nhầm.
const synthesisPendingBatches = new Set<string>();

function markBatchAwaitingSynthesis(agentIds: string[]): void {
  if (!agentIds.length) return;
  synthesisPendingBatches.add(agentIds.slice().sort().join(','));
  // Bounded: giữ tối đa 40 batch; entry tự xóa khi synthesis chạy xong.
  if (synthesisPendingBatches.size > 40) {
    const first = synthesisPendingBatches.values().next().value;
    if (first) synthesisPendingBatches.delete(first);
  }
}

// Trả về true nếu MỌI agent trong agentIds đều thuộc ít nhất 1 batch đang chờ synthesis.
// Dùng cho trigger queue: nếu toàn bộ report batch này sẽ bị synthesis che → skip broadcast.
function isBatchAwaitingSynthesis(agentIds: string[]): boolean {
  if (!agentIds.length) return false;
  for (const batchKey of synthesisPendingBatches) {
    const ids = batchKey.split(',');
    if (agentIds.every((id) => ids.includes(id))) return true;
  }
  return false;
}

// Max chat history to prevent unbounded memory growth
const MAX_HISTORY = MAX_PERSISTED_MESSAGES; // Unlimited: giữ toàn bộ lịch sử tin nhắn trong RAM và Database

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
    // Auto Continue bật → KHÔNG ép agent đang 'working' về 'idle' khi restart,
    // giữ nguyên task + workingSince để autoResumeWorkingAgents() ping tiếp tục task dở.
    const autoContinue = storage.getSetting('autoContinue', false) === true;
    const sessionEntries: Array<{ agentId: string; sessionId: string }> = [];
    for (const row of savedAgents) {
      if (row.name === '...' || row.id === 'agent-b895e808' || !/^[a-z0-9_-]{2,30}$/i.test(row.name)) {
        // Tự động bỏ qua và xóa các agent rác không hợp lệ
        storage.deleteAgent(row.id);
        continue;
      }
      const keepWorking = autoContinue && row.status === 'working';
      const rawTasks = Array.isArray(row.tasks) ? row.tasks : (row.task ? [{ id: '1', task: String(row.task).normalize('NFC'), status: (keepWorking ? 'working' : (row.status === 'working' ? 'working' : 'pending')), createdAt: row.created_at || Date.now() }] : []);
      const rowTasks: AgentTask[] = rawTasks.map((t: any, idx: number) => ({
        id: String(idx + 1),
        task: String(t.task || ''),
        status: (t.status === 'completed' || t.status === 'pending' || t.status === 'working') ? t.status : 'working',
        createdAt: Number(t.createdAt) || Date.now(),
        completedAt: t.completedAt ? Number(t.completedAt) : undefined
      }));
      const agent: Agent = {
        id: row.id, name: row.name, role: row.role, type: row.type,
        status: keepWorking ? 'working' : (row.status === 'working' ? 'idle' : row.status),
        spawnedBy: row.spawnedBy || row.spawned_by || undefined,
        projectDir: row.projectDir || row.project_dir || SERVER_PROJECT_ROOT, 
        teamId: row.teamId || row.team_id || (row.type === 'orchestrator' ? (row.id === 'orchestrator' ? 'default' : '') : 'default'),
        model: row.model || undefined,
        sessionId: row.session_id || row.sessionId || undefined,
        sessionTitle: row.session_title ? String(row.session_title).normalize('NFC') : (row.sessionTitle ? String(row.sessionTitle).normalize('NFC') : undefined),
        task: row.task ? String(row.task).normalize('NFC') : undefined,
        tasks: rowTasks,
        createdAt: row.created_at || row.createdAt || Date.now(), workingSince: keepWorking ? (row.workingSince || row.working_since || Date.now()) : undefined,
        tokenUsage: row.token_usage || row.tokenUsage || undefined,
        contextLength: row.context_length || row.contextLength || undefined
      };
      agents.set(agent.id, agent);
      // Collect session entries for restoring agentSessions static map for all agents
      const sid = row.session_id || row.sessionId;
      if (sid && row.id) {
        sessionEntries.push({ agentId: row.id, sessionId: sid });
      }
    }
    // Restore ACPClient.agentSessions map for all agents
    ACPClient.restoreAgentSessions(sessionEntries);
    
    // Mọi Orchestrator đều ngang hàng: CHỈ tạo orchestrator khởi đầu nếu DB hoàn toàn chưa có bất kỳ agent nào
    const hasAnyOrchestrator = Array.from(agents.values()).some(a => a.type === 'orchestrator' || a.role === 'orchestrator');
    if (savedAgents.length === 0 && !hasAnyOrchestrator) {
      const storedOrch = storage.getAgent('orchestrator');
      const keepOrchWorking = autoContinue && storedOrch?.status === 'working';
      const savedOrchModel = storage.getSetting('orchestratorModel', process.env.ORCHESTRATOR_MODEL);
      const rawOrchTasks = Array.isArray(storedOrch?.tasks) ? storedOrch.tasks : (storedOrch?.task ? [{ id: '1', task: String(storedOrch.task), status: (keepOrchWorking ? 'working' : 'pending'), createdAt: storedOrch.createdAt || Date.now() }] : []);
      const orchTasks: AgentTask[] = rawOrchTasks.map((t: any, idx: number) => ({
        id: String(idx + 1),
        task: String(t.task || ''),
        status: (t.status === 'completed' || t.status === 'pending' || t.status === 'working') ? t.status : 'working',
        createdAt: Number(t.createdAt) || Date.now(),
        completedAt: t.completedAt ? Number(t.completedAt) : undefined
      }));
      const orch: Agent = {
        id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator',
        status: keepOrchWorking ? 'working' : 'idle',
        createdAt: storedOrch?.createdAt || Date.now(),
        workingSince: keepOrchWorking ? (storedOrch?.workingSince || Date.now()) : undefined,
        task: storedOrch?.task,
        tasks: orchTasks,
        sessionId: storedOrch?.sessionId,
        sessionTitle: storedOrch?.sessionTitle,
        model: savedOrchModel ? String(savedOrchModel).trim() : undefined,
        teamId: storedOrch?.teamId || 'default'
      };
      agents.set('orchestrator', orch);
      storage.saveAgent(orch);
    }
    console.log(`[Storage] Loaded ${savedAgents.length} agents, restored ${sessionEntries.length} orchestrator sessions`);
    const savedHistory = storage.loadHistory() as any[];
    for (const row of savedHistory) {
      chatHistory.push({
        id: row.id,
        from: row.from || row.from_id,
        to: row.to || row.to_id,
        content: row.content,
        timestamp: row.timestamp,
        agentName: row.agentName || row.agent_name,
        agentRole: row.agentRole || row.agent_role,
        msgType: row.msgType || row.msg_type || 'chat',
        thinking: row.thinking
      });
    }
    console.log(`[Storage] Loaded ${savedHistory.length} messages`);
    const savedLogs = storage.getLogs({ limit: LOG_BUFFER_MAX });
    if (savedLogs && savedLogs.length > 0) {
      logBuffer.length = 0;
      for (const entry of savedLogs) {
        const ts = new Date(entry.timestamp).toISOString();
        logBuffer.push(`[${ts}] ${entry.message}`);
      }
      console.log(`[Storage] Loaded ${savedLogs.length} persisted logs into terminal buffer`);
    }
  } catch (e: any) { console.log(`[Storage] Load error: ${e.message}`); }
}

function broadcast(type: string, data: any) {
  // Tự động resolve teamId nếu trong data có msg hoặc agent
  let broadcastTeamId = data?.teamId;
  if (!broadcastTeamId && data?.msg?.teamId) {
    broadcastTeamId = data.msg.teamId;
  }
  if (!broadcastTeamId && data?.agent?.teamId) {
    broadcastTeamId = data.agent.teamId;
  }
  if (!broadcastTeamId && data?.toolCall && data?.teamId) {
    broadcastTeamId = data.teamId;
  }

  const payload = { type, ...(broadcastTeamId ? { teamId: broadcastTeamId } : {}), ...data };
  const msg = JSON.stringify(payload);
  
  // WebSocket broadcast với team filter
  wsClients.forEach(ws => {
    if (ws.readyState === 1) {
      const wsTeam = (ws as any).teamId;
      if (wsTeam && broadcastTeamId && wsTeam !== broadcastTeamId) {
        return;
      }
      ws.send(msg);
    }
  });

  // SSE broadcast với team filter
  const sseData = `data: ${msg}\n\n`;
  sseClients.forEach(res => {
    try {
      const sseTeam = (res as any).teamId;
      if (sseTeam && broadcastTeamId && sseTeam !== broadcastTeamId) {
        return;
      }
      res.write(sseData);
      if (typeof (res as any).flush === 'function') (res as any).flush();
    } catch {
      sseClients.delete(res);
    }
  });
}

interface CommandErrorInfo {
  type: 'SPAWN_ROLE_LIMIT' | 'SPAWN_PARSE_FAIL' | 'SPAWN_TASK_LONG' | 'SPAWN_EMPTY_TASK' | 'TALK_PARSE_FAIL' | 'TALK_AGENT_NOT_FOUND' | 'TASK_BARRIER_VIOLATION' | 'CREATE_ROLE_LIMIT' | 'TASK_UPDATE_ERROR';
  issuerId: string; // ID của agent hoặc orchestrator đã phát lệnh
  issuerName?: string;
  issuerRole?: string;
  commandName: 'SPAWN' | 'TALK' | 'STOP' | 'RESUME' | 'TASK_UPDATE';
  details: {
    attemptedRole?: string;
    attemptedName?: string;
    attemptedTask?: string;
    rawSnippet?: string;
    fileLocation?: string;
    reason: string;
  };
  teamId?: string;
}

async function relayErrorToIssuer(info: CommandErrorInfo): Promise<ChatMsg> {
  const teamId = info.teamId || agents.get(info.issuerId)?.teamId || 'default';
  const allTeamAgents = Array.from(agents.values()).filter(a => (a.teamId || 'default') === teamId && a.type !== 'orchestrator' && a.role !== 'orchestrator');
  const idleAgents = allTeamAgents.filter(a => a.status === 'idle');
  const workingAgents = allTeamAgents.filter(a => a.status === 'working');

  const idleListStr = idleAgents.length > 0
    ? idleAgents.map(a => `- [IDLE] ${a.name} (${a.role}) [ID: ${a.id}]`).join('\n')
    : '(Không có agent nào đang idle)';
  const workingListStr = workingAgents.length > 0
    ? workingAgents.map(a => `- [WORKING] ${a.name} (${a.role}) [ID: ${a.id}]`).join('\n')
    : '(Không có agent nào đang working)';

  const candidateId = idleAgents[0]?.id || workingAgents[0]?.id || 'agent-id';

  const fullErrorMessage = `[ERROR: ${info.type}]
VỊ TRÍ PHÁT HIỆN: ${info.details.fileLocation || 'src/server.ts'}
LỆNH GẶP SỰ CỐ: <${info.commandName.toLowerCase()} ${info.details.attemptedRole ? `role="${info.details.attemptedRole}" ` : ''}${info.details.attemptedName ? `name="${info.details.attemptedName}" ` : ''}/>
TIÊU ĐỀ TASK: "${info.details.attemptedTask || 'N/A'}"
NGUYÊN NHÂN: ${info.details.reason}

HIỆN TRẠNG AGENTS TRONG TEAM '${teamId}':
Agents đang rảnh (IDLE - sẵn sàng nhận việc):
${idleListStr}

Agents đang bận (WORKING):
${workingListStr}

HƯỚNG DẪN XỬ LÝ:
Vui lòng tái sử dụng agent đang IDLE bằng cú pháp:
<talk target="${candidateId}">
Nội dung phân công công việc cụ thể tại đây
</talk>`;

  const issuerAgent = agents.get(info.issuerId);
  const isOrchIssuer = info.issuerId === 'orchestrator' || (issuerAgent && isOrchestratorLike(issuerAgent));

  const msg: ChatMsg = {
    id: uuidv4(),
    from: 'system',
    to: info.issuerId,
    content: fullErrorMessage,
    timestamp: Date.now(),
    agentName: 'System',
    agentRole: 'system',
    teamId,
    msgType: 'internal'
  };

  chatHistory.push(msg);
  storage.saveMessage(msg);
  broadcast('chat:message', { msg });
  console.log(`[RelayErrorToIssuer] [${info.type}] → ${info.issuerId}: ${fullErrorMessage.slice(0, 120)}`);

  if (isOrchIssuer) {
    addUnreadForOrchestrator(msg, info.issuerId);
    const sysAgent: Agent = {
      id: 'system',
      name: 'System',
      role: 'system',
      type: 'worker',
      status: 'idle',
      teamId,
      spawnedBy: info.issuerId,
      createdAt: Date.now()
    };
    triggerOrchestrator(sysAgent, fullErrorMessage).catch(err => {
      console.error(`[RelayErrorToIssuer] Trigger Orchestrator for ${info.type} failed:`, err);
    });
  } else if (issuerAgent) {
    const sysAgent: Agent = {
      id: 'system',
      name: 'System',
      role: 'system',
      type: 'orchestrator',
      status: 'idle',
      teamId,
      createdAt: Date.now()
    };
    deliverTalk(issuerAgent, sysAgent, {
      to: issuerAgent.id,
      message: fullErrorMessage,
      task: `Xử lý lỗi thực thi lệnh: ${info.type}`
    }).catch(err => {
      console.error(`[RelayErrorToIssuer] DeliverTalk to ${issuerAgent.name} failed:`, err);
    });
  }

  return msg;
}

/** Forward a system-generated notification to the Orchestrator as a [FROM: System] message.
 *  Creates a normalized ChatMsg, persists it, queues it for the Orchestrator's unread
 *  injection loop, and broadcasts it to all clients. */
function forwardToOrchestrator(type: string, message: string, targetOrchId: string = 'orchestrator', teamId?: string): ChatMsg {
  const resolvedTeamId = teamId || agents.get(targetOrchId)?.teamId || 'default';
  const msg: ChatMsg = {
    id: uuidv4(),
    from: 'system',
    to: targetOrchId,
    content: message,
    timestamp: Date.now(),
    agentName: 'System',
    agentRole: 'system',
    teamId: resolvedTeamId,
    msgType: 'internal'
  };
  chatHistory.push(msg);
  storage.saveMessage(msg);
  addUnreadForOrchestrator(msg, targetOrchId);
  broadcast('chat:message', { msg });
  console.log(`[Forward] [${type}] → Orchestrator (${targetOrchId}): ${message.slice(0, 120)}`);

  // Tự động kích hoạt lượt chat mới cho Orchestrator nếu là lỗi nghiêm trọng (SPAWN_ROLE_LIMIT, SPAWN_PARSE_FAIL, v.v.)
  const criticalTypes = new Set(['SPAWN_ROLE_LIMIT', 'SPAWN_TEAM_LIMIT', 'SPAWN_PARSE_FAIL', 'TASK_BARRIER_VIOLATION', 'CREATE_ROLE_LIMIT', 'CREATE_TEAM_LIMIT', 'TASK_LIMIT_EXCEEDED']);
  if (criticalTypes.has(type)) {
    const sysAgent: Agent = {
      id: 'system',
      name: 'System',
      role: 'system',
      type: 'worker',
      status: 'idle',
      teamId: resolvedTeamId,
      spawnedBy: targetOrchId,
      createdAt: Date.now()
    };
    triggerOrchestrator(sysAgent, message).catch(err => {
      console.error(`[Forward] Trigger Orchestrator for ${type} failed:`, err);
    });
  }

  return msg;
}

/** Get and consume unread messages for orchestrator with deduplication */
function consumeUnreadForOrchestrator(orchId: string = 'orchestrator'): ChatMsg[] {
  const list = unreadForOrchestrator.get(orchId);
  if (!list || list.length === 0) return [];

  const msgs: ChatMsg[] = [];
  while (list.length > 0) {
    const msg = list.shift();
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
function addUnreadForOrchestrator(msg: ChatMsg, targetOrchId?: string) {
  const orchId = resolveOrchIdForMsg(msg, targetOrchId);
  if (msg.from === orchId || msg.from === 'user') return;
  if (msg.id && trackedMessageIds.has(msg.id)) return;

  let list = unreadForOrchestrator.get(orchId);
  if (!list) {
    list = [];
    unreadForOrchestrator.set(orchId, list);
  }
  list.push(msg);
}

// Phát mọi I/O terminal của opencode (input prompt + từng dòng JSONL output) lên UI
// dưới dạng message msgType 'opencode' gắn với agent tương ứng (chỉ hiện ở khung chat agent).
// Làm sạch terminal escape: GỠ các CSI điều khiển KHÔNG phải màu (cursor move v.v.),
// nhưng GIỮ NGUYÊN mã màu SGR kết thúc bằng 'm' (vd [32m, [1m) để frontend AnsiRenderer tô màu.
function stripAnsi(text: any): string {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-NPRZcf-nqry=><]/g, '');
}

// ============ EARLY DISPATCH IN STREAM (server-dedup / ui-render-dup design) ============
// Mục tiêu: dispatch lệnh <talk>/<spawn> NGAY trong luồng streaming thay vì chờ process close.
// Giảm độ trễ delivery: target agent bắt đầu làm việc sớm hơn (không chờ turn đầy đủ kết thúc).
//
// CẢNH BÁO DOUBLE-DISPATCH: cùng một lệnh vẫn xuất hiện trong full content mà final pass
// (handleAgentResponse) parse lại → nếu dispatch sớm MÀ KHÔNG dedup → nhân đôi delivery.
// Giải pháp: lưu `dispatchedCmdSigs` (signature chuẩn hoá của talk đã dispatch sớm), final pass
// sẽ SKIP những talk đã có signature này. Signature dựa trên (from > target | task | message)
// chuẩn hoá whitespace → KHỚP giữa stream buffer và full content bất kể chunk-boundary khác nhau.
//
// PHẠM VI dispatch sớm: CHỈ talk hướng tới AGENT KHÁC (non-orchestrator, non-user).
// - talk→orchestrator / talk→user / broadcast: giữ nguyên final pass (triggerOrchestrator / user route).
// - spawn: KHÔNG dispatch sớm (orchestrator-only, có role-limit/reuse logic phức tạp) → giữ final pass.
// - stop/resume/delete/task_update: giữ final pass (parseAgentCommands).
const dispatchTextBuf: Record<string, string> = {};
// Signature theo TỪNG agent gửi (fromAgentId → Set<sig>): giúp (a) không nhầm lẫn giữa các agent
// stream song song, (b) xoá đúng sig của agent khi turn kết thúc → không chặn nhầm talk trùng lặp
// ở turn SAU (cùng agent gửi lại nội dung giống hệt), tránh mất delivery.
const dispatchedCmdSigs: Map<string, Set<string>> = new Map();

// ============ OUTBOX CONTENT DEDUP WORKER↔WORKER ============
// Chặn duplicate message trong outbox khi deliverTalk worker↔worker (root cause report lặp 3-4 lần).
// 7 call-site nest route cùng nội dung → có thể enqueue uuidv4 MỚI nhiều lần. Guard ngay đầu
// deliverTalk chặn nếu cùng content gửi tới cùng agent trong cửa sổ ngắn.
const OUTBOX_DELIVER_TALK_DEDUP_MS = 2000; // 2s
const deliverTalkDedup = new Map<string, number>();
// Chặn buffer phình vô hạn khi turn bị dừng giữa chừng (agent stopped → handleAgentResponse không
// drain). Cắt từ ĐẦU giữ phần CUỐI (lệnh dispatch thường xuất hiện cuối output).
const MAX_DISPATCH_BUF = 200_000;

// FIX 2 — DEDUP SPAWN theo signature (role+name+task normalized). Trong cùng 1 response của
// orchestration, model có thể emit lệnh <spawn> đồng signature nhiều lần; Set này chặn xử lý
// lệnh spawn trùng signature để tránh SPAWN lặp / SPAWN_ROLE_LIMIT spam. Được clear ở ĐẦU mỗi
// lần handleOrchestratorResponse (mỗi response = 1 turn orchestration riêng) nên không chặn nhầm
// spawn hợp lệ ở turn sau.
const handledSpawnSigs: Set<string> = new Set();

/** Signature chuẩn hoá của 1 lệnh spawn (role+name+task) — dedup trong phạm vi 1 response. */
function spawnDispatchSig(role: string, name: string, task: string): string {
  return `spawn|${normCmdSigPart(role)}|${normCmdSigPart(name)}|${normCmdSigPart(task)}`;
}

/** Chuẩn hoá whitespace cho signature dedup — khớp giữa stream buffer và full content. */
function normCmdSigPart(v: string): string {
  return (v || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Signature của 1 talk (fromAgent > target | task | message | occurrence) — dùng cả 2 phía stream + final. */
function talkDispatchSig(fromAgentId: string, to: string, task: string | undefined, message: string, occurrenceIndex: number = 0): string {
  return `talk|${normCmdSigPart(fromAgentId)}>${normCmdSigPart(to)}|${normCmdSigPart(task || '')}|${normCmdSigPart(message)}|#${occurrenceIndex}`;
}

/**
 * Quét buffer stream của agent, phát hiện lệnh <talk>/[TALK] HOÀN CHỈNH hướng tới agent khác
 * và dispatch sớm qua deliverTalk. Trả về buffer còn lại (đã loại bỏ lệnh đã dispatch).
 * Chỉ trả về phần text CHƯA phải lệnh hoàn chỉnh; lệnh hoàn chỉnh được dispatch + ghi signature.
 */
function scanStreamForDispatch(agentId: string, accumulated: string): string {
  if (!accumulated || !accumulated.trim()) return accumulated;
  const fromAgent = agents.get(agentId);
  if (!fromAgent) return accumulated;

  // Đảm bảo agent đang phát stream có trạng thái 'working'
  if (fromAgent.status !== 'working') {
    fromAgent.status = 'working';
    fromAgent.workingSince = fromAgent.workingSince || Date.now();
    storage.updateAgent(fromAgent.id, { status: 'working', workingSince: fromAgent.workingSince });
    broadcast('agent:updated', { agent: fromAgent });
  }

  // 1. Trích lệnh TALK hoàn chỉnh (bracket + xml), bỏ qua tag trong code block/quoted.
  // extractDualCommands CHỈ trả về lệnh cân bằng ngoặc / cặp thẻ đóng-mở đầy đủ → an toàn với buffer partial.
  const talks = extractDualCommands(accumulated, ['TALK']);
  let remaining = accumulated;
  let changed = false;

  let cmdOccurrence = 0;
  for (const cmd of talks) {
    if (cmd.tag.toUpperCase() !== 'TALK') continue;
    // Bỏ qua TALK nằm trong code block giữa buffer (đề phòng inline) — extractDualCommands đã loại.
    const parsed = parseTalkCommand(cmd, fromAgent.type === 'orchestrator' ? fromAgent.id : 'orchestrator');
    if (!parsed || !parsed.agentId) continue;
    const currentOccurrence = cmdOccurrence++;

    // ══ FIX 1: Chặn dispatch talk XML chưa hoàn chỉnh (partial/unclosed) ══
    // nhánh "Unclosed XML tag fallback" trong extractXmlCommand (L2223-2238) có thể trả về talk
    // PARTIAL (fullMatch kéo dài tới next command/EOF khi buffer chưa đủ <talk>...</talk>).
    // Dispatch vội + xóa buffer (split(fullMatch).join('')) sẽ NUỐT talk thứ 2 phía sau.
    // CHỈ dispatch khi tag XML ĐÃ hoàn chỉnh: self-closing (kết thúc "/>") HOẶC có closing tag
    // ("</talk>"). Còn lại (unclosed kéo dài tới next cmd/EOF) = partial → chờ buffer đủ rồi mới dispatch.
    if (cmd.syntax === 'xml' && !/\/>(\s*)$/.test(cmd.fullMatch || '') && !/<\/talk>\s*$/i.test(cmd.fullMatch || '')) {
      console.log(`[StreamDispatch] SKIP partial talk target=${parsed.agentId || '?'} (chưa có closing tag) — chờ buffer đủ.`);
      continue;
    }

    const cleanTo = cleanTargetIdentifier(parsed.agentId);
    if (!cleanTo || cleanTo.toLowerCase() === 'orchestrator' || cleanTo.toLowerCase() === 'main' || cleanTo.toLowerCase() === 'user') {
      // talk→orchestrator / user / broadcast: KHÔNG dispatch sớm — giữ final pass.
      continue;
    }
    const targetAgent = findAgentByIdNameOrRole(cleanTo, fromAgent?.teamId);
    if (!targetAgent) {
      // Target chưa tồn tại → không dispatch sớm (final pass sẽ forward TALK_AGENT_NOT_FOUND).
      continue;
    }
    if (targetAgent.type === 'orchestrator' || targetAgent.id === 'orchestrator') {
      continue; // orchestrator không dispatch sớm — triggerOrchestrator ở final pass.
    }
    const task = parsed.task;
    const message = parsed.message || '';
    const sig = talkDispatchSig(fromAgent.id, targetAgent.id, task, message, currentOccurrence);
    if (dispatchedCmdSigs.get(fromAgent.id)?.has(sig)) continue; // đã dispatch sớm rồi → tránh trùng lặp trong stream.

    // Dispatch sớm: status working + broadcast + deliverTalk (giống final pass, NHƯNG sớm hơn).
    try {
      targetAgent.status = 'working';
      targetAgent.workingSince = Date.now();
      storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
      broadcast('agent:updated', { agent: targetAgent });

      // BROADCAST NGAY LẬP TỨC tin nhắn Talk sang UI để cả 2 agent (A và B) thấy bubble lập tức
      const earlyTalkChatMsg: ChatMsg = {
        id: uuidv4(),
        from: fromAgent.id,
        to: targetAgent.id,
        content: message,
        task: task,
        timestamp: Date.now(),
        agentName: fromAgent.name,
        agentRole: fromAgent.role,
        teamId: fromAgent.teamId || targetAgent.teamId || 'default',
        msgType: 'talk',
        showOnUI: true
      };
      const earlyDedupKey = broadcastDedupKey(earlyTalkChatMsg);
      if (!isBroadcastDuplicate(earlyDedupKey)) {
        chatHistory.push(earlyTalkChatMsg);
        storage.saveMessage(earlyTalkChatMsg);
        broadcast('chat:message', { msg: earlyTalkChatMsg });
      }

      deliverTalk(targetAgent, fromAgent, { to: targetAgent.id, message, task }).catch((err: any) => {
        console.error(`[StreamDispatch] deliverTalk failed (${fromAgent.name}->${targetAgent.name}): ${err?.message || err}`);
      });
      if (!dispatchedCmdSigs.has(fromAgent.id)) dispatchedCmdSigs.set(fromAgent.id, new Set());
      dispatchedCmdSigs.get(fromAgent.id)!.add(sig);
      // Đồng thời add signature index 0 để tương thích nếu final pass không truyền index
      dispatchedCmdSigs.get(fromAgent.id)!.add(talkDispatchSig(fromAgent.id, targetAgent.id, task, message, 0));
      console.log(`[StreamDispatch] Early dispatched talk ${fromAgent.name} -> ${targetAgent.name} (during stream)`);
    } catch (e: any) {
      console.error(`[StreamDispatch] Early dispatch error: ${e?.message || e}`);
    }

    // Loại lệnh đã dispatch khỏi buffer → không quét lại lần sau.
    // Dùng cắt chuỗi theo chỉ số vị trí (index-based substring) để loại đúng lệnh khỏi remaining,
    // giữ nguyên toàn vẹn phần còn lại và cấu trúc của các lệnh tiếp theo.
    if (cmd.fullMatch) {
      const matchIdx = remaining.indexOf(cmd.fullMatch);
      if (matchIdx !== -1) {
        remaining = remaining.substring(0, matchIdx) + remaining.substring(matchIdx + cmd.fullMatch.length);
        changed = true;
      } else {
        remaining = remaining.replace(cmd.fullMatch, '');
        changed = true;
      }
    }
  }

  // Dồn lại buffer để tránh phình vô hạn khi nhiều lệnh hoàn chỉnh đã bị loại.
  return changed ? remaining : accumulated;
}

// ============ SERVER-SIDE FIFO USER QUEUE ============
interface BackendQueuedMsg {
  targetId: string;
  rawMsg: string;
  isSlash: boolean;
  messageId?: string;
  timestamp: number;
}

const backendUserQueues: Record<string, Array<BackendQueuedMsg>> = {};

function normalizeQueueKey(targetId?: string): string {
  if (!targetId || targetId === 'orchestrator') return 'orchestrator';
  return targetId;
}

function processNextBackendUserQueue(rawTargetId: string): void {
  const targetId = normalizeQueueKey(rawTargetId);
  const queue = backendUserQueues[targetId];
  if (!queue || queue.length === 0) return;

  const agent = agents.get(targetId) || (targetId === 'orchestrator' ? findExistingOrchestrator() : null);
  const client = (targetId === 'orchestrator' || (agent && isOrchestratorLike(agent))) ? getOrchClient(targetId) : (agent ? getClient(agent) : null);
  const effectiveTeamId = agent?.teamId || (targetId === 'orchestrator' ? (findExistingOrchestrator()?.teamId || 'default') : 'default');

  // Nếu client hoặc agent vẫn đang bận/working, không dequeue vội
  if (client?.isBusy() || agent?.status === 'working') {
    return;
  }

  // Sắp xếp các tin theo đúng thứ tự thời gian gốc (timestamp)
  queue.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  // Khi agent/orchestrator tự nguyện đóng lượt và idle:
  // Gom toàn bộ các tin nhắn đang chờ thành một khối liên hoàn theo thứ tự thời gian gốc
  const messagesToDispatch: BackendQueuedMsg[] = [];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item) messagesToDispatch.push(item);
  }
  if (messagesToDispatch.length === 0) return;

  // Ghép các tin nhắn với timestamp rõ ràng để timing tuyệt đối chính xác
  let combinedRawMsg = '';
  if (messagesToDispatch.length === 1) {
    combinedRawMsg = messagesToDispatch[0].rawMsg;
  } else {
    combinedRawMsg = messagesToDispatch
      .map((m, idx) => `[Tin nhắn người dùng #${idx + 1} - Gửi lúc ${new Date(m.timestamp).toLocaleTimeString()}]:\n${m.rawMsg}`)
      .join('\n\n---\n\n');
  }

  const isSlash = messagesToDispatch.length === 1 ? messagesToDispatch[0].isSlash : false;

  setImmediate(async () => {
    try {
      const now = Date.now();
      // Khi bắt đầu thực sự spawn opencode (cùng tick với dispatchUserChat):
      // 1. Tạo bubble mang timestamp gốc của tin nhắn trong queue (m.timestamp || now)
      // 2. Lưu vào chatHistory và DB
      // 3. Broadcast chat:message TRƯỚC
      const dispatchedMsgIds: string[] = [];
      for (const m of messagesToDispatch) {
        const msgId = m.messageId || uuidv4();
        dispatchedMsgIds.push(msgId);
        const dispatchedUserMsg: ChatMsg = {
          id: msgId,
          from: 'user',
          to: targetId,
          content: m.rawMsg,
          timestamp: m.timestamp || now,
          teamId: effectiveTeamId
        };
        chatHistory.push(dispatchedUserMsg);
        storage.saveMessage(dispatchedUserMsg);
        broadcast('chat:message', { msg: dispatchedUserMsg });
      }

      // 4. Phát event chat:queue:dispatched SAU KHI đã broadcast chat:message
      // Đính kèm luôn message objects để UI xử lý atomic hoàn toàn nếu cần
      broadcast('chat:queue:dispatched', {
        targetAgentId: targetId,
        messageIds: dispatchedMsgIds,
        count: messagesToDispatch.length,
        timestamp: now
      });

      console.log(`[BackendQueue] Auto-dispatching queued user message(s) (${messagesToDispatch.length} msg(s)) for ${targetId}: "${combinedRawMsg.slice(0, 80)}"`);
      await dispatchUserChat({
        targetAgentId: targetId,
        rawMsg: combinedRawMsg,
        isSlashCommand: isSlash,
        isRetry: false
      });
    } catch (err: any) {
      console.error(`[BackendQueue] Error processing queued chat for ${targetId}:`, err);
    } finally {
      // Tiếp tục kiểm tra còn tin nào trong queue nữa không
      if (backendUserQueues[targetId]?.length > 0) {
        setImmediate(() => processNextBackendUserQueue(targetId));
      }
    }
  });
}

const streamMaskingBuf: Record<string, string> = {};

/** Reset buffer + signature của 1 agent — gọi khi final pass đã xử lý xong content (drain buffer).
 *  Xoá CHỈ state của agent này; không đụng các agent stream song song khác.
 */
function drainDispatchState(agentId: string): void {
  delete dispatchTextBuf[agentId];
  delete streamMaskingBuf[agentId];
  dispatchedCmdSigs.delete(agentId);
  // Tự động kiểm tra và xả queue người dùng nếu agent rảnh
  processNextBackendUserQueue(agentId);
}

function broadcastOACEvent(agentId: string, ev: any) {
  try {
    const asText = (v: any): string | undefined => {
      if (v === undefined || v === null) return undefined;
      return typeof v === 'string' ? v : JSON.stringify(v);
    };

    if (ev?.kind === 'in') {
      agentThinkingAllowed.add(agentId);
      return;
    }

    const rawList: any[] = (ev?.kind === 'batch' && Array.isArray(ev?.events))
      ? ev.events
      : (Array.isArray(ev?.events) ? ev.events : (ev ? [ev] : []));

    if (rawList.length === 0) return;

    // Đảm bảo khi có stream event về từ process của agent, trạng thái agent chuyển sang 'working'
    const currentAgent = agents.get(agentId);
    if (currentAgent && currentAgent.status !== 'working') {
      currentAgent.status = 'working';
      currentAgent.workingSince = currentAgent.workingSince || Date.now();
      storage.updateAgent(currentAgent.id, { status: 'working', workingSince: currentAgent.workingSince });
      broadcast('agent:updated', { agent: currentAgent });
    }

    const teamId = getAgentTeamId(agentId);

    // Tách và phát trực tiếp từng event theo thứ tự phát sinh (Realtime FIFO)
    for (const item of rawList) {
      if (item?.kind === 'in') continue;
      const e = item?.event || item;
      if (!e || typeof e !== 'object') continue;

      const t = e.type || e.evt || 'event';
      const tt = String(t).toLowerCase().replace(/-/g, '_');
      if (tt === 'step_start' || tt === 'step_finish') continue;
      if (t === 'user' || t === 'system' || t === 'session' || t === 'init') continue;

      const eventTs = typeof e.timestamp === 'number' ? e.timestamp : (typeof e.time === 'number' ? e.time : Date.now());

      const isToolUse = t === 'tool_use' || t === 'tool-call' || t === 'tool_call' || (e as any).part?.type === 'tool' || Boolean((e as any).part?.tool);
      const isToolResult = t === 'tool_result' || t === 'tool';

      if (isToolUse || isToolResult) {
        const p = e.part || {};
        const st: any = p.state || {};
        const callId = p.callID || p.call_id || p.id || st.callID || st.id || e.callID || e.id;
        const input = asText(isToolUse ? (p.input ?? st.input) : (p.input ?? st.input));
        const outputRaw = asText(isToolUse ? (p.output ?? st.output) : (p.output ?? st.output ?? p.content ?? e.data?.output));
        const output = outputRaw === undefined ? undefined : stripAnsi(outputRaw);
        const toolName = String(p.tool || st.tool || 'tool');

        const tc: any = {
          tool: toolName,
          ...(callId ? { callId } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(output !== undefined ? { output } : {})
        };

        broadcast('chat:tool_call', {
          agentId,
          from: agentId,
          toolCall: tc,
          teamId,
          timestamp: eventTs
        });
      } else if (tt === 'thinking' || tt === 'reasoning' || tt === 'thought') {
        const rt = e.part?.text || e.text || e.part?.thinking || e.thinking;
        if (typeof rt === 'string' && rt.trim()) {
          broadcast('chat:thinking', {
            agentId,
            from: agentId,
            thinkingText: rt,
            teamId,
            timestamp: eventTs
          });
        }
      } else if (t === 'text' || t === 'assistant' || t === 'done') {
        const txt = e.part?.text || e.message || e.content || (e.parts ? JSON.stringify(e.parts) : '');
        if (txt) {
          const rawPart = String(txt);
          dispatchTextBuf[agentId] = dispatchTextBuf[agentId]
            ? `${dispatchTextBuf[agentId]}\n${rawPart}`
            : rawPart;
          if (dispatchTextBuf[agentId].length > MAX_DISPATCH_BUF) {
            dispatchTextBuf[agentId] = dispatchTextBuf[agentId].slice(-MAX_DISPATCH_BUF);
          }

          // FIX 5: Streaming masking buffer để không rò rỉ token dở của tag điều phối (<talk, <spawn, ...) ra UI
          const currentBuf = (streamMaskingBuf[agentId] || '') + rawPart;
          // Tìm tag điều phối bắt đầu: <talk, <spawn, <stop, <resume, [TALK, [SPAWN...
          const partialTagMatch = currentBuf.match(/(?:<\s*(?:talk|spawn|stop|resume|create_role|create-role|delete_agent)\b|\[(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE)\b)[^>\]]*$/i);

          let emitText = '';
          if (partialTagMatch && partialTagMatch.index !== undefined) {
            // Có tag điều phối đang mở dở ở cuối chuỗi -> chỉ phát phần text an toàn trước tag
            const safePrefix = currentBuf.substring(0, partialTagMatch.index);
            emitText = stripCommandTags(safePrefix);
            streamMaskingBuf[agentId] = currentBuf.substring(partialTagMatch.index);
          } else {
            // Không có tag dở ở cuối -> strip toàn bộ command hoàn chỉnh và phát ra
            emitText = stripCommandTags(currentBuf);
            streamMaskingBuf[agentId] = '';
          }

          if (emitText) {
            broadcast('chat:chunk', {
              agentId,
              from: agentId,
              to: agentId,
              textDelta: emitText,
              teamId,
              timestamp: eventTs
            });
          }
        }
      } else {
        const fallbackTxt = `◆ ${t}: ${JSON.stringify(e).slice(0, 2000)}`;
        broadcast('chat:chunk', {
          agentId,
          from: agentId,
          to: agentId,
          textDelta: fallbackTxt,
          teamId,
          timestamp: eventTs
        });
      }
    }

    try {
      if (dispatchTextBuf[agentId]) {
        dispatchTextBuf[agentId] = scanStreamForDispatch(agentId, dispatchTextBuf[agentId]);
      }
    } catch (e: any) {
      console.error(`[StreamDispatch] scan error: ${e?.message || e}`);
    }
  } catch (err: any) {
    console.error('[OAC] broadcastOACEvent error:', err);
    if (err?.code === 'TEAM_ORCH_NOT_FOUND') {
      const issuerAgent = agents.get(agentId);
      const content = `❌ Lỗi định tuyến: Không tìm thấy team/orchestrator cho agent ${agentId} (${err.message})`;
      const errChatMsg: ChatMsg = {
        id: uuidv4(),
        from: 'system',
        to: 'user',
        content,
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system',
        msgType: 'error'
      };
      chatHistory.push(errChatMsg);
      try { storage.saveMessage(errChatMsg); } catch {}
      broadcast('chat:message', { msg: errChatMsg });

      if (issuerAgent) {
        const sysAgent: Agent = {
          id: 'system',
          name: 'System',
          role: 'system',
          type: 'orchestrator',
          status: 'idle',
          createdAt: Date.now()
        };
        deliverTalk(issuerAgent, sysAgent, {
          to: issuerAgent.id,
          message: content,
          task: 'Xử lý lỗi định tuyến: TEAM_ORCH_NOT_FOUND'
        }).catch((e: any) => {
          console.error(`[broadcastOACEvent] deliverTalk to issuerAgent ${issuerAgent.name} failed:`, e?.message || e);
        });
      }
    }
  }
}

function saveTranscript(result: any, fromId: string, agentName?: string, agentRole?: string) {
  if (!result?.transcript) return;
  // Transcript lưu vào storage để audit/replay, TUYỆT ĐỐI KHÔNG broadcast đè lên UI gây nhân đôi bong bóng chat
  const tMsg: ChatMsg = createChatMsg(fromId, fromId, result.transcript, { agentName, agentRole, msgType: 'transcript' });
  storage.saveMessage(tMsg);
}

// Chấp nhận MỌI biến thể báo cáo chuẩn của các role (task/research/verification/error) dạng Bracket lẫn XML <report>
const REPORT_BLOCK_RE = /===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===|<\s*(?:report|task_report|task-report|error_report|error-report)\b/i;
const TASK_COMPLETE_RE = /Task complete\./i;

// Validate worker response: Giữ tính năng <report> hoặc <talk> hoặc nội dung phản hồi tự do, không ép format cứng
function validateWorkerCompletion(content: string, agent: Agent): { valid: boolean; reason?: string } {
  if (agent.type === 'orchestrator' || agent.id === 'orchestrator') {
    return { valid: true };
  }
  if (!content || content.trim().length === 0) {
    return { valid: false, reason: 'Empty response' };
  }
  return { valid: true };
}

function buildFormatFeedbackPrompt(reason: string, agent: Agent): string {
  return `[SYSTEM ERROR - THIẾU THẺ GIAO TIẾP HOẶC ĐÍCH ĐẾN]
Lý do bị từ chối: ${reason}

BẮT BUỘC bạn phải gửi lại nội dung bằng thẻ XML điều phối chuẩn:
<talk target="orchestrator">
Nội dung báo cáo, tiến độ hoặc kết quả thực hiện tại đây.
</talk>`;
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
  // Hierarchy 6 tầng: agent card -> main card -> agent setting -> role setting -> default agent setting -> main setting
  // 1) Agent card (trực tiếp trên Dashboard card)
  if (agent.model && agent.model.trim()) return agent.model.trim();
  // 2) Main card — model của main orchestrator (kế thừa nếu worker chưa có card riêng)
  //    Lưu ý: main card và main setting cùng key orchestratorModel, giữ để UI tách biệt nhưng logic gộp
  //    Nếu muốn ưu tiên main card trước agent setting, lấy orchestratorModel ở đây.
  //    Hiện giữ thứ tự user yêu cầu: agent card -> main card -> agent setting ...
  const mainCardModel = resolveOrchestratorModel();
  // Để tuân thủ đúng thứ tự user: agent card - main card - agent setting - role setting - default agent - main setting
  // Ta kiểm tra main card NGAY SAU agent card, TRƯỚC agent setting chỉ khi worker chưa có setting riêng.
  // Tuy nhiên nếu có agent setting/role setting thì chúng ưu tiên hơn main card → cần quyết định.
  // Thực tế hiện tại: agent setting/role setting ưu tiên hơn main card sẽ hợp lý hơn, nên giữ fallback sau.
  // Giữ nguyên thứ tự chuẩn: agent card -> agent setting -> role setting -> default agent -> main setting
  // và main card được coi là alias của main setting (fallback cuối). Nếu bạn muốn main card ưu tiên hơn
  // agent setting, hoán đổi 2 khối dưới.
  // 3) Agent setting (ModelSettingsDialog -> agentModelOverrides[agentId])
  if (agent.id && overrides[agent.id]?.trim()) return overrides[agent.id].trim();
  if (agent.name && overrides[agent.name]?.trim()) return overrides[agent.name].trim();
  // 4) Role setting (ModelSettingsDialog -> role:xxx)
  if (agent.role && overrides[`role:${agent.role}`]?.trim()) return overrides[`role:${agent.role}`].trim();
  if (agent.role && overrides[agent.role]?.trim()) return overrides[agent.role].trim();
  
  // 5) Default agent setting (ModelSettingsDialog -> defaultSubagentModel)
  const defSubagent = storage.getSetting('defaultSubagentModel', process.env.DEFAULT_SUBAGENT_MODEL);
  if (defSubagent && String(defSubagent).trim()) return String(defSubagent).trim();
  
  // 6) Main setting (orchestratorModel / DEFAULT_MODEL)
  if (mainCardModel && mainCardModel.trim()) return mainCardModel.trim();
  return process.env.DEFAULT_MODEL || undefined;
}

function getClient(agent: Agent): ACPClient {
  if (agent.projectDir) {
    syncOpencodeAgents(agent.projectDir);
  }
  // Mỗi lượt gọi đều resolve lại model theo hierarchy 6 tầng -> opencode run luôn đúng
  const model = resolveModelForAgent(agent);
  if (!clients.has(agent.id)) {
    const c = new ACPClient({ id: agent.id, name: agent.name, role: agent.role, type: 'worker', projectDir: agent.projectDir, model });
    c.setOnEvent((ev: any) => broadcastOACEvent(agent.id, ev));
    c.setOnStatusChange((busy) => {
      const cur = agents.get(agent.id);
      if (cur) {
        const newStatus = busy ? 'working' : 'idle';
        if (cur.status === newStatus) return; // Guard chống broadcast thừa
        cur.status = newStatus;
        cur.workingSince = busy ? (cur.workingSince || Date.now()) : undefined;
        storage.updateAgent(cur.id, { status: cur.status, workingSince: cur.workingSince || null });
        broadcast('agent:updated', { agent: cur });
      }
    });
    clients.set(agent.id, c);
  } else {
    const c = clients.get(agent.id)!;
    // Luôn cập nhật model mỗi lượt, kể cả khi model = undefined (clear để kế thừa)
    c.setModel(model);
  }
  const client = clients.get(agent.id)!;
  if (client.getSessionId() !== (agent.sessionId || null)) {
    client.setSession(agent.sessionId || null);
  }
  return client;
}

// ============ TEAM CONTEXT VERSIONING ============
// membershipVersion: CHỈ tăng khi SPAWN hoặc DELETE agent (thay đổi thành phần team).
// ĐÃ TÁCH PER-TEAM: mỗi team có version riêng, tránh team A spawn làm team B bị inject [TEAM UPDATE] thừa.
// Status đổi (idle/working/stopped) KHÔNG tăng version.
const membershipVersionByTeam = new Map<string, number>();
function getMembershipVersion(teamId: string): number { return membershipVersionByTeam.get(teamId || 'default') || 1; }
function bumpMembershipVersion(teamId: string): void {
  const tid = teamId || 'default';
  membershipVersionByTeam.set(tid, getMembershipVersion(tid) + 1);
}
// Giữ biến global legacy cho tương thích đọc cũ (không dùng để so sánh nữa)
let membershipVersion = 1;
// lastTeamVersionDelivered: version [TEAM UPDATE] cuối cùng đã được inject cho từng agent.
const lastTeamVersionDelivered = new Map<string, number>();

function notifyTeamChanged(teamId?: string) {
  // CHỈ được gọi tại SPAWN hoặc DELETE — teamId xác định team nào thay đổi.
  if (teamId) {
    bumpMembershipVersion(teamId);
    membershipVersion++; // giữ đồng bộ legacy
  } else {
    // Fallback: bump tất cả team đang tồn tại (hiếm khi dùng, khi không biết teamId)
    const teams = new Set(Array.from(agents.values()).map(a => a.teamId || 'default'));
    for (const tid of teams) bumpMembershipVersion(tid);
    if (teams.size === 0) bumpMembershipVersion('default');
    membershipVersion++;
  }
}

function shouldIncludeTeamContext(agentId: string, hasExplicitChange = false): boolean {
  const agent = agents.get(agentId);
  const tid = agent?.teamId || 'default';
  const curVer = getMembershipVersion(tid);
  if (hasExplicitChange) {
    lastTeamVersionDelivered.set(agentId, curVer);
    return true;
  }
  const lastDelivered = lastTeamVersionDelivered.get(agentId) || 0;
  if (lastDelivered < curVer) {
    lastTeamVersionDelivered.set(agentId, curVer);
    return true;
  }
  return false;
}

// Khối định dạng bắt buộc cho worker — dạy agent cách route tin nhắn qua tag [TO:] hoặc thẻ XML <talk target="...">
// Worker không được tự SPAWN; báo cáo về main bằng <talk target="orchestrator"> hoặc [TO: orchestrator]
const WORKER_FORMAT_BLOCK = `
=== RESPONSE FORMAT (MANDATORY) ===
End your reply with one or more routing lines, each on its own line:
<talk target="<target-id>">your message</talk>
(or [TO: <target-id>] <your message>)
- To report your result to the Main Orchestrator, you MUST end with: <talk target="orchestrator">Task complete. === TASK REPORT === ...</talk> (or [TO: orchestrator] <concise report>)
- To message another agent, use its exact ID from the Members list.
- NEVER spawn subagents. Only the Orchestrator spawns.
====================================`;

// Helper: truncate task to first line, strip leading markdown headers, max 100 chars (15-18 words)
function truncateTask(task: string): string {
  return (task || '').split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 100);
}

// Helper: format agent tasks summary for [TEAM] context
function formatAgentTasksSummary(a: Agent): string {
  if (Array.isArray(a.tasks) && a.tasks.length > 0) {
    const taskStrs = a.tasks.map((t, idx) => {
      const num = t.id || String(idx + 1);
      const status = t.status || 'working';
      const tNorm = (t.task || '').normalize('NFC').replace(/\s+/g, ' ').trim();
      const text = tNorm.length > 100 ? tNorm.slice(0, 97) + '...' : tNorm;
      return `#${num} [${status}] ${text}`;
    });
    return ` | Tasks: ${taskStrs.join('; ')}`;
  }
  const rawTask = a.task ? a.task.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  return rawTask ? ` | Task: ${rawTask.length > 100 ? rawTask.slice(0, 97) + '...' : rawTask}` : ' | Tasks: (Trống)';
}

function buildTeam(agentId: string, full: boolean = true): string {
  const self = agents.get(agentId);
  const isOrchestrator = self?.type === 'orchestrator' || agentId === 'orchestrator' || String(agentId || '').toLowerCase() === 'orchestrator' || self?.role === 'orchestrator';
  // PER-TEAM: chỉ liệt kê agent cùng team với self (tránh main team thấy worker team khác)
  const selfTeamId = self?.teamId || 'default';
  const others = Array.from(agents.values()).filter(a => {
    if (a.id === agentId) return false;
    if (a.id === 'orchestrator' || a.type === 'orchestrator') return false;
    if ((a.teamId || 'default') !== selfTeamId) return false;
    return true;
  });
  const suffix = isOrchestrator ? '' : WORKER_FORMAT_BLOCK;
  const lines: string[] = [];
  if (self) {
    lines.push(`Your ID: ${self.id}`);
    lines.push(`Your name: ${self.name}`);
    lines.push(`Your role: ${self.role}`);
    if (self.task) {
      const selfTask = self.task.normalize('NFC').replace(/\s+/g, ' ').trim();
      lines.push(`Your task: ${selfTask.length > 100 ? selfTask.slice(0, 97) + '...' : selfTask}`);
    }
    if (Array.isArray(self.tasks) && self.tasks.length > 0) {
      const taskStrs = self.tasks.map((t, idx) => {
        const num = t.id || String(idx + 1);
        const status = t.status || 'working';
        const tNorm = (t.task || '').normalize('NFC').replace(/\s+/g, ' ').trim();
        const text = tNorm.length > 100 ? tNorm.slice(0, 97) + '...' : tNorm;
        return `#${num} [${status}] ${text}`;
      });
      lines.push(`Your tasks: ${taskStrs.join('; ')}`);
    } else {
      lines.push(`Your tasks: (Trống)`);
    }

    // Pair Context: Tự động gắn thông tin Coder & Verifier đồng hành
    const roleLower = (self.role || '').toLowerCase();
    if (roleLower.includes('verif') || roleLower.includes('reviewer')) {
      const coders = others.filter(a => (a.role || '').toLowerCase().includes('coder') || (a.role || '').toLowerCase().includes('debug'));
      let partnerCoder = coders.find(c => self.task && (self.task.includes(c.id) || self.task.includes(c.name)));
      if (!partnerCoder && coders.length > 0) partnerCoder = coders[0];
      if (partnerCoder) {
        lines.push(`Your Partner (Coder): ${partnerCoder.name} (Role: ${partnerCoder.role}, ID: ${partnerCoder.id})`);
      }
    } else if (roleLower.includes('coder') || roleLower.includes('debug')) {
      const verifiers = others.filter(a => (a.role || '').toLowerCase().includes('verif'));
      let partnerVerifier = verifiers.find(v => self.task && (self.task.includes(v.id) || self.task.includes(v.name)));
      if (!partnerVerifier && verifiers.length > 0) partnerVerifier = verifiers[0];
      if (partnerVerifier) {
        lines.push(`Your Partner (Verifier): ${partnerVerifier.name} (Role: ${partnerVerifier.role}, ID: ${partnerVerifier.id})`);
      }
    }
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
    const taskInfo = formatAgentTasksSummary(a);
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
  const targetOrch = a.spawnedBy || 'orchestrator';
  const stopMsg: ChatMsg = {
    id: uuidv4(),
    from: a.id,
    to: targetOrch,
    content: stopText,
    timestamp: Date.now(),
    agentName: a.name,
    agentRole: a.role,
    msgType: msgType,
    teamId: a.teamId || 'default'
  };
  chatHistory.push(stopMsg);
  storage.saveMessage(stopMsg);
  addUnreadForOrchestrator(stopMsg, targetOrch);
  broadcast('chat:message', { msg: stopMsg });

  // Auto-drain backendUserQueues khi STOP agent: gửi tiếp các tin đang chờ
  // để không bị mất tin, đồng thời broadcast chat:queue:dispatched để UI xóa sạch
  // khay hàng đợi (agentQueues) cho agent này
  const agentQueueKey = a.id;
  const pendingQueue = backendUserQueues[agentQueueKey];
  if (pendingQueue && pendingQueue.length > 0) {
    const queuedMessageIds = pendingQueue.map(m => m.messageId).filter(Boolean);
    // Xóa tất cả tin khỏi hàng đợi backend
    backendUserQueues[agentQueueKey] = [];
    // Lưu tin đã drain xuống đĩa để phục hồi
    for (const qItem of pendingQueue) {
      try { storage.saveUnprocessedMessage(agentQueueKey, qItem.rawMsg); } catch {}
    }
    // Broadcast để UI xóa sạch khay hàng đợi ngay lập tức
    broadcast('chat:queue:dispatched', {
      targetAgentId: a.id,
      messageIds: queuedMessageIds,
      count: queuedMessageIds.length
    });
    // Ghi nhận tin đã dispatch vào chatHistory để UI hiển thị bubble chat
    for (const qItem of pendingQueue) {
      const dispatchedMsg: ChatMsg = {
        id: qItem.messageId || uuidv4(),
        from: 'user',
        to: a.id,
        content: qItem.rawMsg,
        timestamp: Date.now(),
        teamId: a.teamId || 'default'
      };
      chatHistory.push(dispatchedMsg);
      storage.saveMessage(dispatchedMsg);
      broadcast('chat:message', { msg: dispatchedMsg });
    }
    console.log(`[Stop] Auto-drained ${pendingQueue.length} queued messages for ${a.id}`);
  }

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
    const prompt = `[TASK] ${agent.task || 'Continue your previous work.'}\n[TEAM]\n${team}\n[/TEAM]\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (orchestrator)\nTO: ${agent.name} (${agent.id})\n=== MESSAGE ===\n${resumeMsg}`;
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
    const targetOrch = agent.spawnedBy || 'orchestrator';
    const errMsg: ChatMsg = { id: uuidv4(), from: agent.id, to: targetOrch, content: `[ERROR] Agent ${agent.name} failed after resume: ${e.message}`, timestamp: Date.now(), agentName: agent.name, agentRole: agent.role, teamId: agent.teamId || 'default' };
    chatHistory.push(errMsg); storage.saveMessage(errMsg);
    addUnreadForOrchestrator(errMsg, targetOrch);
    broadcast('chat:message', { msg: errMsg });
    checkAndSynthesize(agent.id);
  }
}

async function deleteAgent(id: string): Promise<boolean> {
  // Xóa bất kỳ agent nào (kể cả Orchestrator) chỉ xóa chính bản thân agent đó.
  // Các worker trong team vẫn được bảo toàn và team chỉ bị xóa khi tất cả thành viên trong team đều bị xóa.
  return await deleteSingleAgentOnly(id);
}

async function deleteSingleAgentOnly(id: string): Promise<boolean> {
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
  for (const [orchKey, list] of unreadForOrchestrator.entries()) {
    const remaining = list.filter(m => m.from !== id && m.to !== id);
    if (remaining.length > 0) {
      unreadForOrchestrator.set(orchKey, remaining);
    } else {
      unreadForOrchestrator.delete(orchKey);
    }
  }
  unreadForOrchestrator.delete(id);
  agentRetryCount.delete(id);

  // 7. Xóa toàn bộ agent khỏi Database storage
  storage.deleteAgent(id);

  // 8. Xóa khỏi memory map
  clients.delete(id);
  agents.delete(id);

  // 9. Broadcast sự kiện agent:deleted — per-team
  const deletedTeamId = a?.teamId || 'default';
  broadcast('agent:deleted', { id, agentId: id });
  notifyTeamChanged(deletedTeamId);
  console.log(`[Delete] ${a ? (a.name || a.role || id) : id} (${id}) — session and history cleaned up and removed`);
  return !!a;
}

function findAgentByName(name: string): Agent | undefined {
  const nameLower = String(name || '').toLowerCase();
  for (const [, agent] of agents) if (String(agent.name || '').toLowerCase() === nameLower) return agent;
  return undefined;
}

function deleteTaskFromAgent(agent: Agent, rawTargetIdOrNum: string): boolean {
  if (!Array.isArray(agent.tasks) || agent.tasks.length === 0) {
    if (agent.task && typeof agent.task === 'string' && agent.task.trim()) {
      const lines = agent.task.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
      agent.tasks = lines.map((l: string, idx: number) => {
        const clean = l.replace(/^[-*•\d+.)#]\s*/, '').replace(/^#\d+\s*/, '').trim();
        return {
          id: String(idx + 1),
          task: clean || l,
          status: (agent.status === 'working' && idx === 0) ? 'working' : 'pending',
          createdAt: Date.now()
        };
      });
    } else {
      agent.tasks = [];
    }
  }

  if (agent.tasks.length === 0) return false;

  // Hỗ trợ chính tả: "tassk 1", "tassk #1", "task 1", "task #1", "#1", "1", v.v.
  const cleanedInput = (rawTargetIdOrNum || '')
    .trim()
    .replace(/^tass*k\s*#?/i, '')
    .replace(/^#/, '')
    .trim();
  const targetNum = parseInt(cleanedInput, 10);

  const removeIndex = agent.tasks.findIndex((t: any, idx: number) =>
    t.id === cleanedInput ||
    t.id === rawTargetIdOrNum ||
    (!isNaN(targetNum) && (t.id === String(targetNum) || idx + 1 === targetNum)) ||
    t.task.toLowerCase().includes(rawTargetIdOrNum.toLowerCase())
  );

  if (removeIndex === -1) return false;

  agent.tasks.splice(removeIndex, 1);

  // Re-index lại 1..N
  agent.tasks.forEach((t: any, idx: number) => {
    const newId = String(idx + 1);
    t.id = newId;
    if (/^#\d+\b/.test(t.task)) {
      t.task = t.task.replace(/^#\d+/, `#${newId}`);
    }
  });

  // Kiểm tra nếu tất cả task đã completed -> tự xóa sạch toàn bộ
  const allCompleted = agent.tasks.length > 0 && agent.tasks.every(t => t.status === 'completed');
  if (allCompleted || agent.tasks.length === 0) {
    agent.tasks = [];
    agent.task = '';
    if (agent.status === 'working') {
      agent.status = 'idle';
      agent.workingSince = undefined;
    }
  } else {
    const activeTask = agent.tasks.find((t: any) => t.status === 'working')
      || agent.tasks.find((t: any) => t.status === 'pending')
      || agent.tasks[0];
    agent.task = activeTask ? activeTask.task : '';
  }

  storage.updateAgent(agent.id, {
    task: agent.task,
    tasks: agent.tasks,
    status: agent.status,
    workingSince: agent.workingSince ?? null
  } as any);
  broadcast('agent:updated', { agent });
  notifyTeamChanged(agent.teamId || 'default');
  return true;
}

// Automatically delete the oldest agent of the role to free quota when spawning a new agent (per-team)
async function autoPruneExcessAgents(role: string, teamId?: string): Promise<boolean> {
  const limit = getEffectiveRoleLimit(role, teamId);
  const currentAgents = getAgentsByRole(role, teamId);
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

// ============ STANDARDIZED AGENT ERROR RECOVERY & FORCE-CLOSE ============
/**
 * Chuẩn hóa xử lý lỗi khi thực thi lệnh/turn của một agent:
 * 1. Force close/abort ngay lập tức tiến trình hiện tại để giải phóng hoàn toàn subprocess, file lock và port.
 * 2. Cập nhật agent về trạng thái an toàn (error hoặc idle kèm reset working timestamp).
 * 3. Chuẩn bị lại client/session mới để các lệnh kế tiếp được chạy trên tiến trình sạch sẽ.
 * 4. Bắn tin nhắn báo lỗi chuẩn mực về Orchestrator / Issuer và broadcast UI.
 */
async function handleStandardizedAgentError(
  agent: Agent,
  error: any,
  context: {
    originOrchId?: string;
    actionDescription?: string;
    wakeOrchestrator?: boolean;
  } = {}
): Promise<ChatMsg | null> {
  const isAborted = error?.message?.toLowerCase().includes('abort') || error?.message?.toLowerCase().includes('aborted');
  if (isAborted) {
    return null;
  }

  const agentId = agent.id;
  const client = (agent.type === 'orchestrator' || agent.id === 'orchestrator') ? getOrchClient(agentId) : getClient(agent);

  // 1. Force close triệt để tiến trình con đang chạy
  try {
    if (client) {
      client.abort();
    }
  } catch (err: any) {
    console.warn(`[StandardizedError] Force abort failed for agent ${agent.name} (${agentId}):`, err?.message || err);
  }

  // 2. Cập nhật trạng thái agent và lưu DB
  agent.status = 'error';
  agent.workingSince = undefined;
  storage.updateAgent(agentId, { status: 'error', workingSince: null });
  broadcast('agent:updated', { agent });

  // 3. Chuẩn bị client cho tiến trình mới
  if (client) {
    try {
      client.setNeedPromptReinject(true);
      client.clearUnprocessedPrompts();
    } catch {}
  }

  // 4. Sinh tin nhắn báo lỗi chuẩn mực
  const targetOrch = agent.spawnedBy || context.originOrchId || 'orchestrator';
  const actionText = context.actionDescription ? ` khi ${context.actionDescription}` : '';
  const errorMsgStr = `[ERROR] Agent ${agent.name} (${agent.role})${actionText} gặp sự cố: ${error?.message || error}. Tiến trình đã được force close và sẵn sàng nhận lệnh mới.`;

  const errMsg: ChatMsg = {
    id: uuidv4(),
    from: agentId,
    to: targetOrch,
    content: errorMsgStr,
    timestamp: Date.now(),
    agentName: agent.name,
    agentRole: agent.role,
    teamId: agent.teamId || 'default',
    msgType: 'error'
  };

  chatHistory.push(errMsg);
  storage.saveMessage(errMsg);
  addUnreadForOrchestrator(errMsg, targetOrch);
  broadcast('chat:message', { msg: errMsg });

  // Gửi lại lỗi về chính agent nếu người ra lệnh là agent khác (để agent gọi biết và tự xử lý)
  if (context.originOrchId && context.originOrchId !== targetOrch && context.originOrchId !== agentId) {
    const issuerAgent = agents.get(context.originOrchId);
    if (issuerAgent && issuerAgent.type !== 'orchestrator') {
      const issuerErrMsg: ChatMsg = {
        id: uuidv4(),
        from: 'system',
        to: context.originOrchId,
        content: errorMsgStr,
        timestamp: Date.now(),
        agentName: 'System',
        agentRole: 'system',
        teamId: agent.teamId || 'default',
        msgType: 'internal'
      };
      chatHistory.push(issuerErrMsg);
      storage.saveMessage(issuerErrMsg);
      broadcast('chat:message', { msg: issuerErrMsg });
    }
  }

  // 5. Wake Orchestrator nếu cần thiết
  if (context.wakeOrchestrator !== false) {
    try {
      await triggerOrchestrator(agent, errorMsgStr);
    } catch (wakeErr) {
      console.error(`[StandardizedError] triggerOrchestrator failed for ${agent.name}:`, wakeErr);
    }
  }

  checkAndSynthesize(agentId);
  return errMsg;
}

// ============ SYNTHESIZE ============
let synthesizeDebounceTimer: NodeJS.Timeout | null = null;
const SYNTHESIZE_DEBOUNCE_MS = 1800; // 1.8s debounce cooldown gom tat ca worker hoan thanh

function checkAndSynthesize(completedAgentId: string) {
  const completedAgent = agents.get(completedAgentId);
  if (!completedAgent) return;
  // PER-TEAM: chỉ xét worker cùng team với completedAgent (tránh team A chờ team B)
  const teamId = completedAgent.teamId || 'default';
  const spawnedByOrch = Array.from(agents.values()).filter(a => a.spawnedBy === 'orchestrator' && (a.teamId || 'default') === teamId);
  if (spawnedByOrch.length === 0) return;
  const allDone = spawnedByOrch.every(a => a.status === 'idle' || a.status === 'error');
  if (!allDone) return;

  // FIX DUP ORCHESTRATOR (Option A): Đánh dấu batch này đang chờ synthesis NGAY
  markBatchAwaitingSynthesis(spawnedByOrch.map(a => a.id));
  
  // Reset previous debounce timer if new agents are finishing
  if (synthesizeDebounceTimer) {
    clearTimeout(synthesizeDebounceTimer);
    synthesizeDebounceTimer = null;
  }

  synthesizeDebounceTimer = setTimeout(async () => {
    synthesizeDebounceTimer = null;
    // PER-TEAM: dùng teamId đã capture từ completedAgent
    const currentSpawned = Array.from(agents.values()).filter(a => a.spawnedBy === 'orchestrator' && (a.teamId || 'default') === teamId);
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
      // Display content: bóc command tags, nếu có nội dung user-facing thì hiển thị trên UI
      const displayContent = (result.content || '').trim().normalize('NFC');

      if (displayContent) {
        const userText = stripCommandTags(displayContent).trim();
        const isInternal = !userText;
        const orchMsg: ChatMsg = {
          id: uuidv4(),
          from: 'orchestrator',
          to: 'user',
          content: userText,
          timestamp: Date.now(),
          agentName: 'Orchestrator',
          agentRole: 'orchestrator',
          teamId: synthOrchAgent?.teamId || 'default',
          msgType: isInternal ? 'orchestrator_internal' : undefined,
          showOnUI: !isInternal,
          ...((result as any).thinking ? { thinking: (result as any).thinking } : {})
        };
        // Guard dedup broadcast (giống L2359 processOrchestratorTriggerQueue): tránh message
        // orchestrator→user bị sinh 2 lần (Kênh synthesis này + Kênh trigger queue) hiện 2 bubble
        // trên main vì uuidv4() mới mỗi call → dedup theo id không bắt được.
        // Bọc CẢ push + save + broadcast trong guard: nếu duplicate thì KHÔNG tích vào chatHistory
        // (nếu chỉ chặn broadcast mà vẫn push thì sau rehydrate UI sẽ lại duplicate).
        if (!isBroadcastDuplicate(broadcastDedupKey(orchMsg))) {
          chatHistory.push(orchMsg);
          storage.saveMessage(orchMsg);
          trimChatHistory();
          broadcast('chat:message', { msg: orchMsg });
        }
      }
      await handleOrchestratorResponse(result.content, (result as any).thinking || '');
      // FIX DUP ORCHESTRATOR (Option A) + ROOT-CAUSE FIX (outbox loop):
      // synthesis đã broadcast summary xong → xóa flag batch để agent cùng batch, turn MỚI sau này
      // vẫn broadcast bình thường. Đồng thời xóa synthesisTriggered — nếu không, batch agent này
      // hoàn thành turn MỚI vẫn bị L1629 has(batchKey) chặn → "[Synthesize] Already triggered"
      // lặp vô hạn, không tổng hợp lại → outbox report ứ đọng → "[Outbox] Replaying N" retry vô hạn.
      if (currentSpawned.length > 0) {
        synthesisPendingBatches.delete(currentSpawned.map(a => a.id).sort().join(','));
        synthesisTriggered.delete(currentSpawned.map(a => a.id).sort().join(','));
      }
    } catch (e: any) {
      console.log(`[Synthesize] Error: ${e.message}`);
    }
  }, SYNTHESIZE_DEBOUNCE_MS);
}

function trimChatHistory() {
  if (Number.isFinite(MAX_HISTORY) && chatHistory.length > MAX_HISTORY) {
    chatHistory.splice(0, chatHistory.length - MAX_HISTORY);
  }
}

// ============ COMMAND PARSING ============
async function parseAgentCommands(response: string, fromId: string): Promise<string[]> {
  const results: string[] = [];
  const fromAgent = agents.get(fromId);
  const preferredTeamId = fromAgent?.teamId;
  const cleanResponse = sanitizeCommandInput(response);
  const stopRe = /\[?STOP\s+(?:AGENT\s+)?(?:target-id|agent-id|target|id)=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))\]?/gi;
  let m: RegExpExecArray | null;
  while ((m = stopRe.exec(cleanResponse)) !== null) {
    const rawTarget = m[1] || m[2] || m[3];
    const target = findAgentByIdNameOrRole(rawTarget, preferredTeamId);
    const targetId = target ? target.id : rawTarget;
    if (stopAgent(targetId, 'orchestrator')) results.push(`Stopped ${targetId}`);
    else results.push(`Could not stop ${rawTarget}`);
  }
  const resumeRe = /\[?RESUME\s+(?:AGENT\s+)?(?:target-id|agent-id|target|id)=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))\]?/gi;
  while ((m = resumeRe.exec(cleanResponse)) !== null) {
    const rawTarget = m[1] || m[2] || m[3];
    const target = findAgentByIdNameOrRole(rawTarget, preferredTeamId);
    const targetId = target ? target.id : rawTarget;
    if (resumeAgent(targetId)) results.push(`Resumed ${targetId}`);
    else results.push(`Could not resume ${rawTarget}`);
  }
  const deleteRe = /\[?DELETE\s+(?:AGENT\s+)?(?:target-id|agent-id|target|id)=(?:"([^"]+)"|'([^']+)'|([^\s\]]+))\]?/gi;
  while ((m = deleteRe.exec(cleanResponse)) !== null) {
    const rawTarget = m[1] || m[2] || m[3];
    const target = findAgentByIdNameOrRole(rawTarget, preferredTeamId);
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

  // 2. XML commands: <stop .../>, <stop_agent .../>, <resume .../>, <resume_agent .../>, <delete .../>
  const xmlCmds = extractBracketCommands(cleanResponse, ['STOP', 'STOP AGENT', 'RESUME', 'RESUME AGENT', 'DELETE', 'DELETE AGENT']).filter(c => c.syntax === 'xml');
  for (const cmd of xmlCmds) {
    const attrText = cmd.attributes || '';
    const targetMatch = attrText.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    const rawTarget = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4] || targetMatch[5]) : (cmd.body || '').trim();
    if (!rawTarget) continue;
    const target = findAgentByIdNameOrRole(rawTarget, preferredTeamId);
    const targetId = target ? target.id : rawTarget;
    const tag = String(cmd?.tag ?? '').toLowerCase();
    if (tag.includes('stop')) {
      if (stopAgent(targetId, 'orchestrator')) results.push(`Stopped ${targetId}`);
      else results.push(`Could not stop ${rawTarget}`);
    } else if (tag.includes('resume')) {
      if (resumeAgent(targetId)) results.push(`Resumed ${targetId}`);
      else results.push(`Could not resume ${rawTarget}`);
    } else if (tag.includes('delete')) {
      const targetName = target ? target.name : rawTarget;
      console.warn(`[Command] <delete> command from ${fromId} for ${targetName} (${targetId}) was blocked. Only User can delete agents.`);
      results.push(`DELETE command ignored for ${targetName} (${targetId}): Only User has permission to delete agents from UI.`);
    }
  }

    // 3.1 Task Update commands: <task_update agent="..." task="..." status="..." /> or [TASK_UPDATE agent=... task=... status=...]
    // 3.2 Delete Task commands: <delete_task agent="..." task="..." /> or [DELETE_TASK agent=... task=...]
    const deleteTaskCmds = extractDualCommands(cleanResponse, ['DELETE_TASK', 'DELETE TASK']);
    for (const dCmd of deleteTaskCmds) {
      const dAttr = dCmd.attributes || '';
      const dAgentMatch = dAttr.match(/(?:agent|target|agent_id|agent-id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
      const rawTarget = dAgentMatch ? (dAgentMatch[1] || dAgentMatch[2] || dAgentMatch[3] || dAgentMatch[4] || dAgentMatch[5]) : '';
      const dTaskMatch = dAttr.match(/(?:task|task_id|task-id|taskId|id|task_num|task-num)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
      const rawTask = dTaskMatch ? (dTaskMatch[1] || dTaskMatch[2] || dTaskMatch[3] || dTaskMatch[4] || dTaskMatch[5]) : (dCmd.body || '').trim();

      if (!rawTarget || !rawTask) {
        const err = `[ERROR: DELETE_TASK]
Lý do: Thiếu thuộc tính bắt buộc 'agent' hoặc 'task'.
Cú pháp đúng: <delete_task agent="<name/id>" task="1" /> hoặc <delete_task agent="<name/id>" task="#1" />`;
        forwardToOrchestrator('DELETE_TASK_ERROR', err, fromId);
        results.push(err);
        continue;
      }

      const targetAgent = findAgentByIdNameOrRole(rawTarget, preferredTeamId);
      if (!targetAgent) {
        const err = `[ERROR: DELETE_TASK] Không tìm thấy agent '${rawTarget}'.`;
        forwardToOrchestrator('DELETE_TASK_ERROR', err, fromId);
        results.push(err);
        continue;
      }

      const delResult = deleteTaskFromAgent(targetAgent, rawTask);
      if (delResult) {
        results.push(`Đã xóa task "${rawTask}" khỏi agent ${targetAgent.name} (${targetAgent.id})`);
      } else {
        const err = `[ERROR: DELETE_TASK] Không tìm thấy task "${rawTask}" trong danh sách của agent ${targetAgent.name}.`;
        forwardToOrchestrator('DELETE_TASK_ERROR', err, fromId);
        results.push(err);
      }
    }

    const taskUpdateCmds = extractDualCommands(cleanResponse, ['TASK_UPDATE', 'TASK UPDATE']);
  for (const cmd of taskUpdateCmds) {
    const attrText = cmd.attributes || '';
    const agentMatch = attrText.match(/(?:agent|target|agent_id|agent-id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    const rawTarget = agentMatch ? (agentMatch[1] || agentMatch[2] || agentMatch[3] || agentMatch[4] || agentMatch[5]) : '';
    const taskIdMatch = attrText.match(/(?:task_id|task-id|taskId|id|task_num|task-num)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    const rawTaskId = taskIdMatch ? (taskIdMatch[1] || taskIdMatch[2] || taskIdMatch[3] || taskIdMatch[4] || taskIdMatch[5]) : '';
    const taskMatch = attrText.match(/task\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    const newTask = taskMatch ? (taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4] || taskMatch[5]) : (cmd.body || '').trim();
    const statusMatch = attrText.match(/status\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    const newStatus = statusMatch ? (statusMatch[1] || statusMatch[2] || statusMatch[3] || statusMatch[4] || statusMatch[5]).toLowerCase() : '';

    if (!rawTarget) {
      const err = `[ERROR: TASK_UPDATE]
Lý do: Thiếu thuộc tính bắt buộc 'agent' để xác định agent cần cập nhật task.
Cú pháp đúng:
<task_update agent="<name/id>" task="1" status="completed" /> (hoặc task="<mô tả task>")`;
      forwardToOrchestrator('TASK_UPDATE_ERROR', err, fromId);
      results.push(err);
      continue;
    }

    const target = findAgentByIdNameOrRole(rawTarget, preferredTeamId);
    if (!target) {
      const err = `[ERROR: TASK_UPDATE]
Lý do: Không tìm thấy agent '${rawTarget}' trong danh sách active agents.
Cú pháp đúng:
<task_update agent="<tên_hoặc_id_chính_xác>" task="1" status="completed" />`;
      forwardToOrchestrator('TASK_UPDATE_ERROR', err, fromId);
      results.push(err);
      continue;
    }

    const updates: Partial<Agent> = {};
    if (!target.tasks) target.tasks = [];

    const normStatus = newStatus === 'completed' ? 'completed' : (newStatus === 'pending' ? 'pending' : (newStatus === 'working' ? 'working' : ''));
    const targetTaskId = rawTaskId || (newTask && /^#?\d+$/.test(newTask.trim()) ? newTask.trim().replace(/^#/, '') : '');

    if (targetTaskId) {
      // Hỗ trợ hoàn tất/cập nhật theo Số Thứ Tự task #1, #2, #3...
      const targetIndex = parseInt(targetTaskId, 10);
      let found = target.tasks.find((t, idx) => t.id === targetTaskId || (!isNaN(targetIndex) && (t.id === String(targetIndex) || idx + 1 === targetIndex)));
      if (found) {
        if (normStatus) {
          found.status = normStatus as any;
          if (normStatus === 'completed') {
            found.completedAt = Date.now();
          }
        }
      }
      // Khi task completed: splice xóa luôn khỏi agent.tasks, không giữ lại
      if (normStatus === 'completed') {
        const completedTaskId = found?.id;
        target.tasks = target.tasks.filter(t => t.status !== 'completed' && (!completedTaskId || t.id !== completedTaskId));
        // Re-index 1..N
        target.tasks.forEach((t, idx) => {
          t.id = String(idx + 1);
          if (/^#\d+\b/.test(t.task)) {
            t.task = t.task.replace(/^#\d+/, `#${t.id}`);
          }
        });
        const activeTask = target.tasks.find(t => t.status === 'working') || target.tasks.find(t => t.status === 'pending') || target.tasks[0];
        target.task = activeTask ? activeTask.task : '';
        updates.task = target.task;
      }
      updates.tasks = target.tasks;
    } else if (newTask) {
      const truncated = truncateTask(newTask);
      target.task = truncated;
      updates.task = target.task;

      let found = target.tasks.find(t => t.task.toLowerCase() === truncated.toLowerCase() || t.task.toLowerCase().includes(truncated.toLowerCase()));
      if (found) {
        if (normStatus) {
          found.status = normStatus as any;
          if (normStatus === 'completed') {
            found.completedAt = Date.now();
            target.tasks = target.tasks.filter(t => t.status !== 'completed' && t.id !== found!.id);
            // Re-index 1..N
            target.tasks.forEach((t, idx) => {
              t.id = String(idx + 1);
              if (/^#\d+\b/.test(t.task)) {
                t.task = t.task.replace(/^#\d+/, `#${t.id}`);
              }
            });
            const activeTask = target.tasks.find(t => t.status === 'working') || target.tasks.find(t => t.status === 'pending') || target.tasks[0];
            target.task = activeTask ? activeTask.task : '';
            updates.task = target.task;
          }
        }
      } else {
        // Kiểm tra trần số task: Tối đa trần live Team Settings (chỉ tính task active)
        const effectiveTaskLimit = getEffectiveTaskLimit(target.teamId);
        if (countRealTasks(target.tasks) >= effectiveTaskLimit) {
          // Ưu tiên 1: Đẩy/xóa bớt các task đã completed cũ nhất nếu còn
          if (!evictOldestCompletedTask(target.tasks)) {
            // Không có task completed nào: Báo lỗi vượt quá giới hạn task
            const taskErr = `[ERROR: TASK_LIMIT_EXCEEDED]
Lý do: Agent '${target.name}' (${target.id}) đã đạt tối đa ${effectiveTaskLimit} task chưa hoàn thành.
Yêu cầu bị từ chối: task="${truncated}"

Hành động bắt buộc:
1. Đánh giá hoàn thành các task hiện có:
   <task_update agent="${target.id}" task="1" status="completed" /> (hoặc task="2", task="3"...)
2. Hoặc xóa bỏ task không còn cần thiết:
   <delete_task agent="${target.id}" task="1" /> (hoặc [DELETE_TASK agent=${target.id} task="task #1"])`;
            forwardToOrchestrator('TASK_LIMIT_EXCEEDED', taskErr, fromId, target.teamId || 'default');
            results.push(taskErr);
            continue;
          }
        }

        const itemStatus = (normStatus as any) || 'working';
        if (itemStatus !== 'completed') {
          target.tasks.push({
            id: String(target.tasks.length + 1),
            task: truncated,
            status: itemStatus,
            createdAt: Date.now()
          });
        }
      }
      updates.tasks = target.tasks;
    } else if (normStatus === 'completed') {
      // Đánh dấu task đang working/pending gần nhất thành completed và xóa ngay lập tức
      const activeWorking = target.tasks.slice().reverse().find(t => t.status === 'working' || t.status === 'pending');
      if (activeWorking) {
        activeWorking.status = 'completed';
        activeWorking.completedAt = Date.now();
        target.tasks = target.tasks.filter(t => t.status !== 'completed' && t.id !== activeWorking.id);
        // Re-index 1..N
        target.tasks.forEach((t, idx) => {
          t.id = String(idx + 1);
          if (/^#\d+\b/.test(t.task)) {
            t.task = t.task.replace(/^#\d+/, `#${t.id}`);
          }
        });
      } else {
        target.tasks = target.tasks.filter(t => t.status !== 'completed');
      }
      const activeTask = target.tasks.find(t => t.status === 'working') || target.tasks.find(t => t.status === 'pending') || target.tasks[0];
      target.task = activeTask ? activeTask.task : '';
      updates.task = target.task;
      updates.tasks = target.tasks;
    }

    if (newStatus && ['idle', 'working', 'blocked', 'stopped', 'error', 'completed', 'pending'].includes(newStatus)) {
      if (newStatus === 'completed' || newStatus === 'idle') {
        // Nếu không còn task nào -> tự động chuyển idle
        if (target.tasks.length === 0) {
          target.tasks = [];
          target.task = '';
          target.status = 'idle';
          target.workingSince = undefined;
          updates.tasks = [];
          updates.task = '';
          updates.status = 'idle';
          updates.workingSince = null as any;
        } else {
          const hasWorking = target.tasks.some(t => t.status === 'working');
          const nextPending = target.tasks.find(t => t.status === 'pending');
          if (hasWorking) {
            target.status = 'working';
          } else if (nextPending && newStatus !== 'idle') {
            nextPending.status = 'working';
            target.task = nextPending.task;
            target.status = 'working';
            target.workingSince = Date.now();
            updates.task = target.task;
          } else {
            target.status = 'idle';
            target.workingSince = undefined;
            updates.workingSince = null as any;
          }
        }
      } else if (newStatus === 'working') {
        target.status = 'working';
        target.workingSince = Date.now();
        updates.workingSince = target.workingSince;
      } else if (newStatus === 'pending') {
        // keep agent status or idle if not working
        if (target.status !== 'working') {
          target.status = 'idle';
        }
      } else {
        target.status = newStatus as any;
      }
      updates.status = target.status;
    }

    storage.updateAgent(target.id, updates as any);
    broadcast('agent:updated', { agent: target });
    notifyTeamChanged(target.teamId || 'default');
    results.push(`Updated task for ${target.name} (${target.id}): task="${target.task || ''}", status="${target.status}", totalTasks=${target.tasks.length}`);
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

// ============ BALANCED BRACKET COMMAND PARSER ============
interface BracketCommand {
  tag: string;           // Tên thẻ: 'TALK', 'SPAWN', 'CREATE ROLE', etc.
  content?: string;      // Nội dung bên trong cặp ngoặc ngoài cùng (bracket syntax)
  attributes?: string;   // Chuỗi thuộc tính (XML syntax)
  body?: string;         // Nội dung bên trong cặp thẻ <tag>...</tag> (XML syntax)
  fullMatch: string;     // Chuỗi đầy đủ bao gồm cả cặp ngoặc [TAG ...] hoặc <tag>...</tag>
  startIndex: number;
  endIndex: number;
  syntax?: 'bracket' | 'xml';
}

interface BracketRange {
  tag: string;
  startIndex: number;
  closeIndex: number;
  endIndex: number;
  raw: string;
  content: string;
}

/**
 * Tìm phạm vi lệnh [TAG ...] cân bằng ngoặc (Balanced Bracket Range).
 * Quản lý độ sâu ngoặc vuông lồng nhau, bỏ qua ngoặc trong chuỗi trích dẫn ("...", '...', `...`, “...”)
 * và khối code block (```...```).
 */
function findBalancedBracketRange(text: string, startIndex: number): BracketRange | null {
  if (!text || startIndex < 0 || startIndex >= text.length || text[startIndex] !== '[') return null;

  const remaining = text.substring(startIndex + 1);
  const multiMatch = remaining.match(/^(CREATE\s+ROLE|STOP\s+AGENT|RESUME\s+AGENT|DELETE\s+AGENT)\b/i);
  let tag = '';
  let tagLen = 0;
  if (multiMatch) {
    tag = multiMatch[1].toUpperCase();
    tagLen = multiMatch[1].length;
  } else {
    const singleMatch = remaining.match(/^([A-Za-z_]+)\b/);
    if (!singleMatch) return null;
    tag = singleMatch[1].toUpperCase();
    tagLen = singleMatch[1].length;
  }

  let depth = 0;
  let inQuote: string | null = null;
  let inCodeBlock = false;
  let closeIndex = -1;
  const len = text.length;

  for (let j = startIndex; j < len; j++) {
    const char = text[j];
    const prev = j > startIndex ? text[j - 1] : '';

    // Xử lý Escape: \char
    if (prev === '\\') continue;

    // Xử lý Code Block ```
    if (text.startsWith('```', j)) {
      inCodeBlock = !inCodeBlock;
      j += 2;
      continue;
    }
    if (inCodeBlock) continue;

    // Xử lý Quoted String (nháy kép, nháy đơn, inline backtick, nháy cong “ ”)
    if (char === '"' || char === "'" || char === '`' || char === '“' || char === '”') {
      const matchQuote = char === '“' ? '”' : char;
      if (!inQuote) {
        inQuote = matchQuote;
        continue;
      } else if (inQuote === char || (inQuote === '”' && char === '”')) {
        inQuote = null;
        continue;
      }
    }
    if (inQuote) continue; // Bỏ qua mọi dấu ngoặc vuông nằm trong chuỗi trích dẫn

    // Cân bằng độ sâu ngoặc vuông
    if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) {
        closeIndex = j;
        break; // Đã tìm thấy dấu đóng tương ứng của lệnh ngoài cùng!
      }
    }
  }

  if (closeIndex !== -1) {
    const raw = text.substring(startIndex, closeIndex + 1);
    const inner = raw.substring(1, raw.length - 1).trim();
    const content = inner.substring(tagLen).trim();

    // Guard: command tags must have actual command attributes, not just conversational mentions like [TALK] or [SPAWN]
    const tagUpper = tag.toUpperCase();
    if (tagUpper === 'TALK') {
      if (!/\b(?:target|agent|agent-id|agent_id|target-id|target_id|to|id)\s*=/i.test(content)) {
        return null;
      }
    } else if (tagUpper === 'SPAWN') {
      if (!/\b(?:role|name)\s*=/i.test(content)) {
        return null;
      }
    }

    return {
      tag,
      startIndex,
      closeIndex,
      endIndex: closeIndex + 1,
      raw,
      content
    };
  }

  return null;
}

/**
 * Trích xuất một lệnh [TAG ...] duy nhất bắt đầu từ startIndex sử dụng thuật toán đếm ngoặc cân bằng.
 */
function extractBracketCommand(text: string, startIndex: number): { tag: string; content: string; fullMatch: string; startIndex: number; endIndex: number } | null {
  const match = findBalancedBracketRange(text, startIndex);
  if (!match) return null;
  return {
    tag: match.tag,
    content: match.content,
    fullMatch: match.raw,
    startIndex: match.startIndex,
    endIndex: match.endIndex
  };
}

/**
 * Trích xuất một lệnh XML-style <tag ...>...</tag> hoặc self-closing <tag ... />
 */
function extractXmlCommand(text: string, startIndex: number, targetTag: string): BracketCommand | null {
  const normTag = targetTag.toLowerCase().replace(/[\s_-]+/g, '[-_\\s]?');
  const openPattern = new RegExp(`^<(${normTag})(?:\\s+(?:[^>"']|"[^"]*"|'[^']*')*)?(?:>|\\/>)`, 'i');
  const match = text.substring(startIndex).match(openPattern);
  if (!match) return null;

  const openTag = match[0];
  const isSelfClosing = openTag.endsWith('/>') || openTag.endsWith('/ >');
  const tagUpper = targetTag.toUpperCase().replace(/[-_]+/g, ' ');

  // Extract raw attribute string
  const rawTagMatch = openTag.match(/^<([a-zA-Z0-9_-]+)/);
  const matchedTagName = rawTagMatch ? rawTagMatch[1] : targetTag;
  const attrText = openTag.slice(matchedTagName.length + 1, isSelfClosing ? (openTag.endsWith('/ >') ? -3 : -2) : -1).trim();

  // Validate that it is a REAL command tag, not just a conversational mention of <talk> or <spawn>
  const tagLower = tagUpper.toLowerCase();
  const hasRoutingAttr = /\b(?:target|target-id|target_id|agent-id|agent_id|agent|role|name|to|id)\s*=/i.test(attrText);

  // If tag is embedded in prose (has non-whitespace prefix on the same line that is not a tag closing),
  // and is self-closing or does not wrap the rest of the message, treat it as inline documentation
  const lineStart = text.lastIndexOf('\n', startIndex) + 1;
  const linePrefix = text.substring(lineStart, startIndex).trim();
  const isInlineInProse = linePrefix.length > 0 && !/^(?:<\/[a-z0-9_-]+>|\[\/[A-Z\s]+\])$/i.test(linePrefix);
  if (isInlineInProse && isSelfClosing) {
    return null;
  }

  if (isSelfClosing) {
    if (!hasRoutingAttr && (tagLower === 'talk' || tagLower === 'spawn')) return null;
    return {
      tag: tagUpper,
      attributes: attrText,
      body: '',
      fullMatch: openTag,
      startIndex,
      endIndex: startIndex + openTag.length,
      syntax: 'xml'
    };
  }

  // Look for closing tag </targetTag>
  const closeTagPattern = new RegExp(`</${normTag}>`, 'i');
  const afterOpen = text.substring(startIndex + openTag.length);
  const closeMatch = afterOpen.match(closeTagPattern);

  if (!closeMatch && !hasRoutingAttr && !isSelfClosing) {
    return null;
  }
  if (tagLower === 'talk' && !hasRoutingAttr && !closeMatch) {
    return null;
  }
  if (tagLower === 'spawn' && !hasRoutingAttr && !closeMatch) {
    return null;
  }

  if (closeMatch && closeMatch.index !== undefined) {
    const body = afterOpen.substring(0, closeMatch.index);
    const totalLength = openTag.length + closeMatch.index + closeMatch[0].length;
    return {
      tag: tagUpper,
      attributes: attrText,
      body: body.trim(),
      fullMatch: text.substring(startIndex, startIndex + totalLength),
      startIndex,
      endIndex: startIndex + totalLength,
      syntax: 'xml'
    };
  } else {
    // Unclosed XML tag fallback - extends to next valid command tag or EOF
    // THẺ <spawn> BẮT BUỘC PHẢI LÀ SELF-CLOSING HOẶC CÓ THẺ ĐÓNG ĐẦY ĐỦ </spawn>
    // NẾU LÀ <spawn> MÀ KHÔNG CÓ THẺ ĐÓNG -> KHÔNG ĐƯỢC FALLBACK NUỐT TEXT CỦA USER/MÔ TẢ LÀM BODY/TASK
    if (tagLower === 'spawn') {
      return null;
    }

    // Search strictly for known command tags: <talk, <spawn, <stop, <resume, <create_role, [TALK, [SPAWN, [STOP, [RESUME, [CREATE ROLE
    const nextTagIdx = afterOpen.search(/(?:<\s*(?:talk|spawn|stop|resume|create_role|create-role|stop_agent|resume_agent|delete_agent)\b|\[(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE|STOP AGENT|RESUME AGENT|DELETE AGENT)\b)/i);
    const bodyLength = nextTagIdx !== -1 ? nextTagIdx : afterOpen.length;
    const body = afterOpen.substring(0, bodyLength);
    const totalLength = openTag.length + bodyLength;
    return {
      tag: tagUpper,
      attributes: attrText,
      body: body.trim(),
      fullMatch: text.substring(startIndex, startIndex + totalLength),
      startIndex,
      endIndex: startIndex + totalLength,
      syntax: 'xml'
    };
  }
}

/** Code-span helper: BO QUA tag nam trong `...` inline hoac ```...``` fenced */
// Detect ONLY code-fence (```) and inline backtick spans. Used to exclude literal
// `=== TASK REPORT ===` markers / `<report>` tags that appear INSIDE code examples,
// so extractCleanTaskReport doesn't disembowel a genuine report or swallow a code sample.
export function getCodeFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3);
      if (end !== -1) { ranges.push([i, end + 3] as [number, number]); i = end + 3; continue; }
      ranges.push([i, text.length] as [number, number]); break;
    }
    if (text[i] === '`') {
      const nextNewline = text.indexOf('\n', i + 1);
      const end = text.indexOf('`', i + 1);
      if (end !== -1 && (nextNewline === -1 || end < nextNewline)) {
        ranges.push([i, end + 1] as [number, number]);
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return ranges;
}

function getCodeSpanRanges(text: string): Array<[number, number]> {
  const ranges = getCodeFenceRanges(text);
  // Also protect Task Report blocks: === TASK REPORT === ... === END REPORT === and <report> ... </report>
  const reportStartRe = /(?:===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===|<\s*(?:report|task_report|task-report|error_report|error-report)\b[^>]*>)/gi;
  const reportEndRe = /(?:===\s*END[^=\n]*REPORT\s*===|<\/\s*(?:report|task_report|task-report|error_report|error-report)\s*>)/gi;
  let rm: RegExpExecArray | null;
  while ((rm = reportStartRe.exec(text)) !== null) {
    const startIdx = rm.index;
    reportEndRe.lastIndex = startIdx + rm[0].length;
    const em = reportEndRe.exec(text);
    if (em) {
      ranges.push([startIdx, em.index + em[0].length] as [number, number]);
    }
  }
  // Protect quoted attribute values of message=/msg=/content= inside TALK/SPAWN tags
  // to prevent nested [SPAWN]/[TALK] examples from being executed as real commands.
  let scan = 0;
  while (scan < text.length) {
    const talkIdx = text.indexOf('[TALK', scan);
    const spawnIdx = text.indexOf('[SPAWN', scan);
    const nextTag = Math.min(
      talkIdx === -1 ? Infinity : talkIdx,
      spawnIdx === -1 ? Infinity : spawnIdx
    );
    if (nextTag === Infinity) break;
    const cmd = findBalancedBracketRange(text, nextTag);
    if (!cmd) { scan = nextTag + 1; continue; }
    const attrMatch = cmd.content.match(/\b(?:message|msg|content)\s*=\s*(?:"|'|“)([\s\S]*?)(?:"|'|”)/);
    if (attrMatch && attrMatch[1] !== undefined) {
      const valueStart = cmd.startIndex + cmd.raw.indexOf(attrMatch[1]);
      ranges.push([valueStart, valueStart + attrMatch[1].length] as [number, number]);
    }
    scan = cmd.endIndex;
  }
  // Protect blockquotes: dòng bắt đầu bằng ">" là DỮ LIỆU trích dẫn minh họa, không phải lệnh.
  // Chặn cả dòng để tag [TALK]/[SPAWN] trong blockquote không được thực thi (thay cho sanitize).
  const bqRe = /^[ \t]*>[ \t]?\S.*$/gm;
  let bm: RegExpExecArray | null;
  while ((bm = bqRe.exec(text)) !== null) {
    ranges.push([bm.index, bm.index + bm[0].length] as [number, number]);
  }
  // Protect markdown list items and prose quotations that mention command tags as documentation/instruction
  // (e.g. "- Dùng thẻ <spawn role="..." />", "1. Hãy dùng <talk target="...">", "Hướng dẫn: <spawn ...>")
  const docListRe = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+.*$/gm;
  let dlm: RegExpExecArray | null;
  while ((dlm = docListRe.exec(text)) !== null) {
    if (/<(?:talk|spawn|stop|resume|create_role|create-role|delete_agent)\b|\[(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE)\b/i.test(dlm[0])) {
      ranges.push([dlm.index, dlm.index + dlm[0].length] as [number, number]);
    }
  }
  return ranges;
}
function isInCodeSpan(idx: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) if (idx >= s && idx < e) return true;
  return false;
}

/**
 * Trích xuất các lệnh [TAG ...] hoặc XML tags <tag ...> sử dụng thuật toán Dual-Syntax Scanner.
 * Hỗ trợ song song cả hai cú pháp Bracket và XML, nhận diện chính xác độ sâu lồng nhau và trạng thái quote.
 */
function extractDualCommands(text: string, targetTags: string[] = ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT'], ignoreMarkdownDoc: boolean = false): BracketCommand[] {
  const commands: BracketCommand[] = [];
  if (!text) return commands;
  const codeRanges = ignoreMarkdownDoc ? getCodeFenceRanges(text) : getCodeSpanRanges(text);

  let pos = 0;
  while (pos < text.length) {
    let earliestMatch: { type: 'bracket' | 'xml'; tag: string; searchTag: string } | null = null;
    let earliestIdx = -1;

    for (const tag of targetTags) {
      // 1. Bracket search: [TAG ...
      let searchBracket = pos;
      while (true) {
        const idx = text.indexOf(`[${tag}`, searchBracket);
        if (idx === -1) break;
        const nextChar = text[idx + 1 + tag.length];
        const boundaryOk = !nextChar || /\s|:|\]|=/.test(nextChar);
        if (boundaryOk && !isInCodeSpan(idx, codeRanges)) {
          if (earliestIdx === -1 || idx < earliestIdx) {
            earliestIdx = idx;
            earliestMatch = { type: 'bracket', tag, searchTag: tag };
          }
          break;
        }
        searchBracket = idx + 1;
      }

      // 2. XML search: <tag ... or <TAG ...
      let searchXml = pos;
      const tagLower = tag.toLowerCase().replace(/\s+/g, '_');
      const tagLowerDash = tag.toLowerCase().replace(/\s+/g, '-');
      const xmlVariants = [tagLower];
      if (tagLowerDash !== tagLower) xmlVariants.push(tagLowerDash);

      for (const variant of xmlVariants) {
        let sXml = searchXml;
        while (true) {
          const idxLower = text.toLowerCase().indexOf(`<${variant}`, sXml);
          if (idxLower === -1) break;
          const nextChar = text[idxLower + 1 + variant.length];
          const boundaryOk = !nextChar || /\s|>|\//.test(nextChar);
          if (boundaryOk && !isInCodeSpan(idxLower, codeRanges)) {
            if (earliestIdx === -1 || idxLower < earliestIdx) {
              earliestIdx = idxLower;
              earliestMatch = { type: 'xml', tag, searchTag: variant };
            }
            break;
          }
          sXml = idxLower + 1;
        }
      }
    }

    if (earliestIdx === -1 || !earliestMatch) break;

    if (earliestMatch.type === 'bracket') {
      const cmd = extractBracketCommand(text, earliestIdx);
      if (cmd) {
        commands.push({ ...cmd, syntax: 'bracket' });
        pos = cmd.endIndex;
      } else {
        pos = earliestIdx + 1;
      }
    } else if (earliestMatch.type === 'xml') {
      const cmd = extractXmlCommand(text, earliestIdx, earliestMatch.searchTag);
      if (cmd) {
        commands.push(cmd);
        pos = cmd.endIndex;
      } else {
        pos = earliestIdx + 1;
      }
    }
  }

  return commands;
}

function extractBracketCommands(text: string, targetTags: string[] = ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT', 'TASK_UPDATE', 'TASK UPDATE']): BracketCommand[] {
  return extractDualCommands(text, targetTags);
}

function stripCommandTags(text: string): string {
  if (!text) return '';
  // FIX 6: stripCommandTags dùng ignoreMarkdownDoc: true để đảm bảo mọi thẻ điều phối thực sự
  // (<talk>, <spawn>, ...) luôn được loại bỏ sạch sẽ khỏi nội dung hiển thị text trái của chat bubble,
  // kể cả khi nằm cạnh hoặc bên trong markdown list/blockquote.
  const commands = extractDualCommands(text, ['TALK', 'SPAWN', 'CREATE ROLE', 'STOP', 'RESUME', 'STOP AGENT', 'RESUME AGENT', 'DELETE AGENT', 'TASK_UPDATE', 'TASK UPDATE'], true);
  if (commands.length === 0) return text.trim();
  let result = '';
  let lastIndex = 0;
  for (const cmd of commands) {
    result += text.substring(lastIndex, cmd.startIndex);
    lastIndex = cmd.endIndex;
  }
  result += text.substring(lastIndex);
  // Loại bỏ các thẻ đóng BBCode và XML closing tags nếu còn sót
  result = result.replace(/\[\/(?:TALK|SPAWN|STOP|RESUME|CREATE ROLE|STOP AGENT|RESUME AGENT|DELETE AGENT|TASK_UPDATE|TASK UPDATE)\]/gi, '');
  result = result.replace(/<\/(?:talk|spawn|stop|stop_agent|stop-agent|resume|resume_agent|resume-agent|create_role|create-role|delete|delete_agent|delete-agent|task_update|task-update)>/gi, '');
  return result.trim();
}

function stripQuotes(v: string): string {
  if (!v) return '';
  let t = v.trim();
  if (t.length >= 2 &&
      ((t.startsWith('"') && t.endsWith('"')) ||
       (t.startsWith("'") && t.endsWith("'")) ||
       (t.startsWith('“') && t.endsWith('”')) ||
       (t.startsWith('‘') && t.endsWith('’')))) {
    return t.substring(1, t.length - 1).trim();
  }
  if (t.startsWith('"') || t.startsWith("'") || t.startsWith('“') || t.startsWith('‘')) {
    const startChar = t[0];
    const closingQuote = startChar === '“' ? '”' : (startChar === '‘' ? '’' : startChar);
    const lastQuote = t.lastIndexOf(closingQuote);
    if (lastQuote > 0) return t.substring(1, lastQuote).trim();
    return t.substring(1).trim();
  }
  if (t.endsWith(']')) {
    t = t.substring(0, t.length - 1).trim();
  }
  return t;
}

function parseTalkTag(tagContent: string): { agentId: string; message: string; task?: string } | null {
  if (!tagContent) return null;

  // 1. Trích xuất target/agent-id trước
  const targetMatch = tagContent.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s\]]+))/i);
  const rawId = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4]) : '';
  const agentId = cleanTargetIdentifier(rawId);
  if (!agentId) return null;

  // 2. Trích xuất task nếu có
  let task: string | undefined = undefined;
  const taskMarkerMatch = tagContent.match(/\btask\s*=\s*/i);
  if (taskMarkerMatch && taskMarkerMatch.index !== undefined) {
    const taskStart = taskMarkerMatch.index + taskMarkerMatch[0].length;
    // task= value kết thúc trước message=/msg=/content= hoặc cuối tagContent
    const afterTask = tagContent.substring(taskStart);
    const nextAttrMatch = afterTask.match(/\b(?:message|msg|content)\s*=/i);
    const rawTask = nextAttrMatch && nextAttrMatch.index !== undefined
      ? afterTask.substring(0, nextAttrMatch.index).trim()
      : afterTask.trim();
    if (rawTask) task = stripQuotes(rawTask);
  }

  // 3. Trích xuất message: lấy nội dung từ sau 'message=' đến trước 'task=' (nếu task= đứng sau)
  const msgMarkerMatch = tagContent.match(/\b(message|msg|content)\s*=\s*/i);
  let message: string | undefined = undefined;
  if (msgMarkerMatch && msgMarkerMatch.index !== undefined) {
    const msgStart = msgMarkerMatch.index + msgMarkerMatch[0].length;
    const afterMsg = tagContent.substring(msgStart);
    // Dừng trước task= nếu task= đứng SAU message=
    const taskAfterMatch = afterMsg.match(/\btask\s*=/i);
    const rawMsg = taskAfterMatch && taskAfterMatch.index !== undefined
      ? afterMsg.substring(0, taskAfterMatch.index).trim()
      : afterMsg.trim();
    message = stripQuotes(rawMsg);
  }

  // task và message là 2 field ĐỘC LẬP:
  // - task → update targetAgent.task (qua truncateTask)
  // - message → inject vào agent prompt
  // Khi chỉ có task= mà không có message= → tạo message mặc định ngắn gọn
  const trimmedTask = task && task.trim() ? task.trim() : undefined;
  const trimmedMessage = message && message.trim() ? message.trim() : undefined;
  const finalMessage = trimmedMessage || (trimmedTask ? `New task: ${trimmedTask}` : '');
  if (agentId && finalMessage) {
    return { agentId, message: finalMessage, ...(trimmedTask ? { task: trimmedTask } : {}) };
  }
  return null;
}

function parseTalkCommand(cmd: BracketCommand, targetOrchId: string = 'orchestrator'): { agentId: string; message: string; task?: string } | null {
  if (!cmd) return null;

  if (cmd.syntax === 'xml') {
    const attrText = cmd.attributes || '';
    const targetMatch = attrText.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    const rawId = targetMatch ? (targetMatch[1] || targetMatch[2] || targetMatch[3] || targetMatch[4] || targetMatch[5]) : '';
    const agentId = cleanTargetIdentifier(rawId);
    if (!agentId) return null;

    let task: string | undefined = undefined;
    const taskMatch = attrText.match(/\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
    if (taskMatch) {
      task = stripQuotes(taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4] || taskMatch[5] || '');
    }

    // Message can be body or message attribute
    let message = cmd.body || '';
    if (task && message) {
      const taskTagMatch = message.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskTagMatch) {
        task = taskTagMatch[1].trim();
        message = message.replace(/<task>[\s\S]*?<\/task>/i, '').trim();
      }
    }
    if (!task && message) {
      const taskTagMatch2 = message.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskTagMatch2) {
        task = taskTagMatch2[1].trim();
        message = message.replace(/<task>[\s\S]*?<\/task>/i, '').trim();
      }
    }
    if (!message) {
      const msgAttrMatch = attrText.match(/\b(?:message|msg|content)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i);
      if (msgAttrMatch) {
        message = stripQuotes(msgAttrMatch[1] || msgAttrMatch[2] || msgAttrMatch[3] || msgAttrMatch[4] || msgAttrMatch[5] || '');
      }
    }

    const finalMessage = message.trim() || (task ? `New task: ${task}` : '');
    if (agentId && finalMessage) {
      if (task) {
        const words = task.trim().split(/\s+/).filter(Boolean);
        if (words.length > 30) {
          forwardToOrchestrator(
            'TASK_BARRIER_VIOLATION',
            `❌ [BARRIER REJECT] Thuộc tính task="..." vượt quá giới hạn 30 từ (${words.length} từ). Thuộc tính task chỉ được dùng làm tiêu đề ngắn (<= 30 từ). Toàn bộ hướng dẫn chi tiết phải đặt trong body thẻ!`,
            targetOrchId
          );
          return null;
        }
      }
      return { agentId, message: finalMessage, ...(task ? { task: task.trim() } : {}) };
    }
    return null;
  }

  // Bracket syntax fallback
  return parseTalkTag(cmd.content || '');
}

function parseAgentOutput(content: string, defaultTo: string = 'orchestrator'): { to: string; message: string; task?: string }[] {
  const matches: { to: string; message: string; task?: string }[] = [];
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
    matches.push({ to: resolvedTo, message: talk.message, task: (talk as any).task });
  }

  const cleanContent = stripCommandTags(content);

  // Match [TO: ...] optionally preceded by [FROM: ...]
  // Handles quotes, whitespace, and angle brackets like [TO: <orchestrator>] or [TO: "agent-1"]
  const tagRegex = /(?:\[FROM:\s*[^\]]+\]\s*)?\[TO:\s*([^\]]+)\]/gi;

  function isInsideCodeBlockOrSpan(text: string, index: number): boolean {
    let inFenced = false;
    let inInline = false;
    for (let i = 0; i < index && i < text.length; i++) {
      if (text.startsWith('```', i)) {
        inFenced = !inFenced;
        i += 2;
      } else if (text[i] === '`' && !inFenced) {
        inInline = !inInline;
      }
    }
    return inFenced || inInline;
  }

  const tagMatches: Array<{ index: number; length: number; rawTo: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(cleanContent)) !== null) {
    if (isInsideCodeBlockOrSpan(cleanContent, m.index)) {
      continue;
    }
    const cleanCandidate = cleanTargetIdentifier(m[1]);
    const rawTarget = (m[1] || '').trim();
    const cleanLower = (cleanCandidate || '').toLowerCase();
    // Special routing keywords cho phép bất kỳ format nào (orchestrator/user/main/all/broadcast)
    const isSpecialRoute = cleanLower === 'orchestrator' || cleanLower === 'user' || cleanLower === 'main' || cleanLower === 'all' || cleanLower === 'broadcast';
    // STRICT VALIDATION (fix mất tin): target phải là agent-id/name hợp lệ (chỉ chữ-số-underscore-dash).
    // Chặn regex-fragment như '\s*([^' lọt vào làm target → sinh TALK_AGENT_NOT_FOUND sai + mất tin định tuyến.
    const isValidId = /^[A-Za-z0-9_-]+$/.test(cleanCandidate);
    const isPlaceholder = INVALID_TARGET_PLACEHOLDERS.has(cleanLower) || /^<.*>$/.test(rawTarget) || !cleanCandidate || !isValidId;
    if (isPlaceholder && !isSpecialRoute) {
      continue; // Skip placeholder/invalid/đoạn regex-fragment như [TO: '\s*([^' ]
    }
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

  // Khi ĐÃ CÓ tag [TO: ...] trong output, CHỈ trích xuất các phân đoạn sau từng tag [TO:].
  // Bỏ qua preText mở đầu tự sự phía trước để tránh sinh ra 2 Message Object cùng gửi tới 1 đích.
  for (let i = 0; i < tagMatches.length; i++) {
    const cur = tagMatches[i];
    const startIndex = cur.index + cur.length;
    const endIndex = (i + 1 < tagMatches.length) ? tagMatches[i + 1].index : cleanContent.length;

    let msgText = cleanContent.substring(startIndex, endIndex).trim();
    // Clean trailing [FROM: ...] if left at the end before next tag or end of string
    msgText = msgText.replace(/\[FROM:\s*[^\]]+\]\s*$/i, '').trim();

    // Extract [TASK] block if present: only the FIRST LINE of task content, max 80 chars
    // [TASK] can be on its own line or inline: [TASK] Some task\nMore content
    let extractedTask: string | undefined = undefined;
    const taskBlockMatch = msgText.match(/^\s*\[TASK\]\s*\n?([^\[]*)/i);
    if (taskBlockMatch) {
      const taskContent = taskBlockMatch[1] || '';
      const firstLine = taskContent.split('\n')[0].trim();
      extractedTask = firstLine ? firstLine.slice(0, 80) : undefined;
      // Remove the [TASK] block from message body so it doesn't appear as content
      msgText = msgText.replace(/^\s*\[TASK\]\s*\n?[^\[]*/i, '').trim();
    }

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
      matches.push({ to: resolvedTo, message: msgText, ...(extractedTask ? { task: extractedTask } : {}) });
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

  // Gộp segment trùng Orchestrator:
  // Chỉ gộp khi chúng thực sự là phân đoạn nối tiếp do cú pháp chia đoạn lỗi hoặc unclosed,
  // tuyệt đối KHÔNG gộp tuỳ tiện 2 thẻ talk/report hoàn chỉnh độc lập.
  const merged: typeof deduped = [];
  for (const m of deduped) {
    const last = merged[merged.length - 1];
    // Chỉ gộp nếu thẻ trước đó có dấu hiệu unclosed hoặc rỗng/nối tiếp ngắn
    const isUnclosedOrContinuation = last && (last as any).unclosed === true;
    if (isUnclosedOrContinuation && last.to === 'orchestrator' && m.to === 'orchestrator') {
      last.message = `${last.message}\n\n${m.message}`;
      if (m.task) last.task = last.task || m.task;
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

// Strip code blocks and blockquotes to avoid parsing example tags as real commands
function sanitizeCommandInput(text: string): string {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, '') // strip fenced code blocks
    .replace(/`[^`\n]*`/g, '')      // strip inline code
    .replace(/^\s*>.*$/gm, '');     // strip blockquotes
}

function parseSpawnCommand(cmd: BracketCommand, targetOrchId: string = 'orchestrator'): { role: string; name: string; task: string } | null {
  if (!cmd) return null;

  const INVALID_PLACEHOLDERS = new Set(['<role>', '<name>', '<task>', 'role', 'name', 'task', '...', 'none', 'undefined', 'null', 'your-name', '<your-name>']);

  if (cmd.syntax === 'xml') {
    const attrText = cmd.attributes || '';
    const roleMatch = attrText.match(/\brole\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);
    const nameMatch = attrText.match(/\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);
    const taskMatch = attrText.match(/\btask\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i);

    const role = cleanTargetIdentifier(roleMatch ? (roleMatch[1] || roleMatch[2] || roleMatch[3] || roleMatch[4]) : '').toLowerCase();
    const name = cleanTargetIdentifier(nameMatch ? (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4]) : '');
    let rawTaskAttr = stripQuotes(taskMatch ? (taskMatch[1] || taskMatch[2] || taskMatch[3] || taskMatch[4]) : '');
    if (rawTaskAttr) {
      const words = rawTaskAttr.trim().split(/\s+/).filter(Boolean);
      if (words.length > 30) {
        forwardToOrchestrator(
          'TASK_BARRIER_VIOLATION',
          `❌ [BARRIER REJECT] Thuộc tính task="..." vượt quá giới hạn 30 từ (${words.length} từ). Thuộc tính task chỉ được dùng làm tiêu đề ngắn (<= 30 từ). Toàn bộ hướng dẫn chi tiết phải đặt trong body thẻ!`,
          targetOrchId
        );
        return null;
      }
    }
    let task = rawTaskAttr;
    let bodyContent = '';
    if (cmd.body) {
      const taskTagMatch = cmd.body.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskTagMatch) {
        if (!task) task = taskTagMatch[1].trim();
        bodyContent = cmd.body.replace(/<task>[\s\S]*?<\/task>/i, '').trim();
      } else {
        bodyContent = cmd.body.trim();
      }
    }
    if (task && bodyContent) {
      task = `${task} — ${bodyContent}`;
    } else if (!task && bodyContent) {
      task = bodyContent;
    }

    if (role && name && task && !INVALID_PLACEHOLDERS.has(role) && !INVALID_PLACEHOLDERS.has(name.toLowerCase())) {
      return { role, name, task };
    }
    return null;
  }

  // Bracket syntax
  const attrsText = cmd.content || '';
  const roleMatch = attrsText.match(/role=(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  const nameMatch = attrsText.match(/name=(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|(\S+))/i);
  const taskRegex = /task\s*=\s*/i;
  const taskMatch = attrsText.match(taskRegex);

  if (roleMatch && nameMatch && taskMatch) {
    let role = (roleMatch[1] || roleMatch[2] || roleMatch[3] || '').trim().toLowerCase();
    let name = (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4] || '').trim();
    role = cleanTargetIdentifier(role);
    name = cleanTargetIdentifier(name);
    if (!role || !name || INVALID_PLACEHOLDERS.has(role) || INVALID_PLACEHOLDERS.has(name.toLowerCase())) {
      return null;
    }
    const taskIndex = attrsText.search(taskRegex);
    const valStart = taskIndex + taskMatch[0].length;
    let rawTask = attrsText.substring(valStart).trim();
    rawTask = stripQuotes(rawTask);
    const task = rawTask.trim().normalize('NFC');
    if (task && !INVALID_PLACEHOLDERS.has(task.toLowerCase())) {
      return { role, name, task };
    }
  }
  return null;
}

function parseSpawnTags(text: string, targetOrchId: string = 'orchestrator'): Array<{ role: string; name: string; task: string }> {
  const spawns: Array<{ role: string; name: string; task: string }> = [];
  if (!text) return spawns;
  const commands = extractBracketCommands(text, ['SPAWN']);
  for (const cmd of commands) {
    const parsed = parseSpawnCommand(cmd, targetOrchId);
    if (parsed) {
      spawns.push(parsed);
      console.log(`[SpawnParse] Hợp lệ: role=${parsed.role} name=${parsed.name} task="${parsed.task.slice(0, 60)}..."`);
    }
  }
  return spawns;
}

function parseOrchestratorCommands(text: string, targetOrchId: string = 'orchestrator'): Array<{ agentId: string; message: string; task?: string }> {
  const talks: Array<{ agentId: string; message: string; task?: string }> = [];
  if (!text) return talks;
  const commands = extractBracketCommands(text, ['TALK']);
  for (const cmd of commands) {
    const parsed = parseTalkCommand(cmd, targetOrchId);
    if (parsed) {
      talks.push(parsed);
    } else if (cmd.attributes) {
      // parseTalkCommand return null (thiếu target thực hoặc thiếu message). CHỈ forward cảnh báo khi
      // tag có attribute TALK THỰC (target= không phải placeholder) để không bắn tin giả từ câu văn
      // tự sự/ví dụ chứa <talk target="target-id"> mô tả. Nhánh placeholder/narrative giữ im lặng.
      const attrText = cmd.attributes;
      const rawTarget = (attrText.match(/(?:agent-id|agent_id|target-id|target_id|target|agent|to|id)\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|[‘]([^’]+)[’]|([^\s>]+))/i) || []).slice(1).find(v => v);
      if (rawTarget) {
        const cleanRaw = cleanTargetIdentifier(rawTarget.trim());
        const isPlaceholder = !cleanRaw || INVALID_TARGET_PLACEHOLDERS.has(cleanRaw.toLowerCase()) || cleanRaw === 'worker' || cleanRaw === 'target-id' || cleanRaw === 'agent-id';
        if (!isPlaceholder) {
          forwardToOrchestrator('TALK_PARSE_FAIL', `[ERROR] TALK parse thất bại: target "${cleanRaw}" nhưng thiếu message nội dung. Raw: ${attrText.slice(0, 120)}`, targetOrchId);
        }
      }
    }
  }
  return talks;
}

// ============ ORCHESTRATOR TRIGGER DEBOUNCE & BATCHING ============
let orchTriggerDebounceTimer: NodeJS.Timeout | null = null;
let pendingOrchTriggers: Array<{ fromAgent: Agent; message: string; reportId: string; attempts: number; targetOrchId?: string }> = [];
const ORCH_TRIGGER_DEBOUNCE_MS = 1500; // 1.5s debounce gom báo cáo từ nhiều worker
const ORCH_MAX_RETRY = 5; // số lần retry in-session trước khi chờ restart replay
const deliveredReportIds = new Set<string>(); // Idempotency: tránh phát lặp 2 lần cùng một reportId trong memory lifecycle
const AUTO_RESUME_MAX_STALE_MS = 600 * 1000; // Fix 6.42: agent workingSince quá lâu (>10 phút) khi restart → reset idle, không auto-resume
const ABORT_ERROR_PATTERN = /Agent operation aborted by user|turn failed/i;
// Dedup triggerOrchestrator: chống gửi trùng (fromAgent.id, nội dung) trong cửa sổ ngắn
const ORCH_TRIGGER_DEDUP_MS = 2000;
const orchTriggerDedupAt = new Map<string, number>();
// Auto-wakeup khi worker im lặng nhưng có tool_use thật: throttle 30s/agent chống loop
const TOOL_WAKEUP_THROTTLE_MS = 30000;
const lastToolWakeupAt = new Map<string, number>();

async function triggerOrchestrator(fromAgent: Agent, message: string, existingReportId?: string) {
  const targetOrchId = resolveOrchestratorTarget(fromAgent);
  // Guard: không trigger khi message rỗng tuyệt đối (tránh gửi rỗng về Orchestrator)
  if (!existingReportId && isEmptyAgentOutput(message)) {
    console.log(`[Route] Skip triggerOrchestrator: empty message from ${fromAgent.name} (${fromAgent.role})`);
    return;
  }
  // Dedup: (fromAgent.id, nội dung CHUẨN HOÁ) đã trigger trong cửa sổ ~5s → bỏ qua, tránh Orchestrator
  // nhận lặp cùng một báo cáo (UI nhân đôi bubble + orchestrator xử lý 2 lần).
  if (!existingReportId) {
    const dedupKey = `${fromAgent.id}|||${message.trim().replace(/\s+/g, ' ')}`;
    const now = Date.now();
    const lastAt = orchTriggerDedupAt.get(dedupKey);
    if (lastAt !== undefined && now - lastAt < ORCH_TRIGGER_DEDUP_MS) {
      console.log(`[Route] Skip duplicate orchestrator trigger from ${fromAgent.name} (dedup ${ORCH_TRIGGER_DEDUP_MS}ms)`);
      return;
    }
    orchTriggerDedupAt.set(dedupKey, now);
    if (orchTriggerDedupAt.size > 500) {
      for (const [k, v] of orchTriggerDedupAt) {
        if (now - v > ORCH_TRIGGER_DEDUP_MS) orchTriggerDedupAt.delete(k);
      }
    }
  }
  const reportId = existingReportId || uuidv4();
  if (!existingReportId) {
    // Chỉ persist khi là report mới — replay sẽ tái dùng chính reportId cũ để không sinh bản trùng
    storage.enqueueOutbox({
      id: reportId,
      fromAgentId: fromAgent.id,
      fromAgentName: fromAgent.name,
      fromAgentRole: fromAgent.role,
      teamId: fromAgent.teamId,
      to: targetOrchId,
      message,
      createdAt: Date.now(),
      attempts: 0,
      status: 'pending'
    });
  }
  pendingOrchTriggers.push({ fromAgent, message, reportId, attempts: 0, targetOrchId });

  // Kiểm tra targetOrch có đang rảnh (idle và client không busy) không
  const targetClient = getOrchClient(targetOrchId);
  const targetAgent = agents.get(targetOrchId);
  const isOrchIdle = (targetAgent?.status || 'idle') === 'idle' && !targetClient.isBusy();

  if (isOrchIdle) {
    if (orchTriggerDebounceTimer) {
      clearTimeout(orchTriggerDebounceTimer);
      orchTriggerDebounceTimer = null;
    }
    setImmediate(async () => {
      await processOrchestratorTriggerQueue();
    });
    return;
  }

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

function updateOrchStateSafe(orchId: string, status: 'idle' | 'working' | 'error', taskDesc?: string) {
  const orch = agents.get(orchId);
  if (!orch) return;
  const newDesc = taskDesc !== undefined ? taskDesc : orch.task;
  if (orch.status === status && orch.task === newDesc) return; // Guard không đổi thì không spam
  orch.status = status;
  if (status === 'working') orch.workingSince = Date.now();
  if (status === 'idle') orch.workingSince = undefined;
  if (taskDesc !== undefined) orch.task = taskDesc;
  storage.updateAgent(orch.id, { status: orch.status, workingSince: orch.workingSince, task: orch.task } as any);
  broadcast('agent:updated', { agent: orch });
  if (status === 'idle') {
    processNextBackendUserQueue(orchId);
  }
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

    let orchAgent = agents.get(orchId) || findExistingOrchestrator(batch[0]?.fromAgent?.teamId) || findExistingOrchestrator();
    if (!orchAgent) {
      orchAgent = { id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator', status: 'idle', createdAt: Date.now(), teamId: 'default' };
      agents.set('orchestrator', orchAgent);
    }
    updateOrchStateSafe(orchId, 'working', 'Đang tổng hợp báo cáo & điều phối');
    
    const needReinject = client.getNeedPromptReinject() || !client.getSessionId();
    if (needReinject) client.setNeedPromptReinject(false);

    // Kiểm tra và gộp cả tin nhắn người dùng trong hàng đợi (backendUserQueues) nếu có
    // Sắp xếp các tin theo thứ tự thời gian gốc (timestamp) giữa Worker Report và User Messages
    const orchQueueKey = normalizeQueueKey(orchId);
    const userQueue = backendUserQueues[orchQueueKey] || [];
    const queuedUserMsgs: BackendQueuedMsg[] = [];
    while (userQueue.length > 0) {
      const q = userQueue.shift();
      if (q) queuedUserMsgs.push(q);
    }

    const targetTeamId = orchAgent.teamId || findExistingOrchestrator()?.teamId || 'default';

    if (queuedUserMsgs.length > 0) {
      // Phát event dọn sạch khỏi queue UI ngay lập tức
      broadcast('chat:queue:dispatched', {
        targetAgentId: orchId,
        messageIds: queuedUserMsgs.map(m => m.messageId).filter(Boolean),
        count: queuedUserMsgs.length
      });

      // Tạo và broadcast bubble vào khung chat cho từng tin nhắn người dùng với timestamp gốc
      for (const uMsg of queuedUserMsgs) {
        const dispatchedUserMsg: ChatMsg = {
          id: uMsg.messageId || uuidv4(),
          from: 'user',
          to: orchId,
          content: uMsg.rawMsg,
          timestamp: uMsg.timestamp || Date.now(),
          teamId: targetTeamId
        };
        chatHistory.push(dispatchedUserMsg);
        storage.saveMessage(dispatchedUserMsg);
        broadcast('chat:message', { msg: dispatchedUserMsg });
      }
    }

    // Xây dựng danh sách các sự kiện theo dòng thời gian thống nhất
    interface TimelineEntry {
      timestamp: number;
      text: string;
    }
    const timelineEntries: TimelineEntry[] = [];

    for (const { fromAgent, message, reportId } of batch) {
      const outboxRec = storage.getOutboxRecord(reportId);
      const ts = outboxRec?.createdAt || Date.now();
      timelineEntries.push({
        timestamp: ts,
        text: `=== INCOMING WORKER REPORT ===\nFROM: ${fromAgent.name} (ID: ${fromAgent.id}, Role: ${fromAgent.role})\nTO: ${orchAgent.name || 'Orchestrator'} (${orchId})\nTIME: ${new Date(ts).toLocaleTimeString()}\n=== CONTENT ===\n${message}`
      });
    }

    for (const uMsg of queuedUserMsgs) {
      timelineEntries.push({
        timestamp: uMsg.timestamp,
        text: `=== INCOMING USER MESSAGE (QUEUED) ===\nFROM: User\nTO: ${orchAgent.name || 'Orchestrator'} (${orchId})\nTIME: ${new Date(uMsg.timestamp).toLocaleTimeString()}\n=== CONTENT ===\n${uMsg.rawMsg}`
      });
    }

    // Sắp xếp tăng dần theo timestamp để Orchestrator nhận được diễn biến thời gian chính xác 100%
    timelineEntries.sort((a, b) => a.timestamp - b.timestamp);

    const combinedTimeline = timelineEntries.map(e => e.text).join('\n\n');

    const team = buildTeam(orchId);
    let prompt = `[TEAM]\n${team}\n[/TEAM]\n\n${combinedTimeline}`;
    if (!client.getSessionId() || needReinject) {
      prompt += ORCH_REMINDER;
    }
    
    try {
      // ACK-based: đánh dấu in_flight TRƯỚC enqueue — nếu enqueue thất bại, record không bị
      // markDelivered sớm → vòng quét định kỳ sẽ retry (không mất report).
      for (const item of batch) storage.markOutboxInFlight(item.reportId);
      const result = await client.enqueue(prompt);
      // Đánh dấu mọi report trong batch đã gửi thành công — CHỈ sau khi enqueue resolve (client ACK)
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
      // Display content: bóc command tags, nếu có nội dung user-facing thì hiển thị trên UI
      const cleanUserContent = (result.content || '').trim().normalize('NFC');

      if (cleanUserContent) {
        const userText = stripCommandTags(cleanUserContent).trim();
        const isInternal = !userText;
        const orchMsg: ChatMsg = {
          id: uuidv4(),
          from: orchId,
          to: 'user',
          content: userText,
          timestamp: Date.now(),
          agentName: orchAgent.name || 'Orchestrator',
          agentRole: 'orchestrator',
          teamId: orchAgent.teamId || 'default',
          msgType: isInternal ? 'orchestrator_internal' : undefined,
          showOnUI: !isInternal,
          ...((result as any).thinking ? { thinking: (result as any).thinking } : {})
        };
        // FIX DUP ORCHESTRATOR (Option A): nếu mọi agent trong batch này đều thuộc 1 batch đang
        // chờ synthesis (checkAndSynthesize đã đánh dấu, synthesis sẽ broadcast summary 1.8s) →
        // KHÔNG broadcast bubble per-report (tránh 2 message orchestrator→user cho cùng 1 batch).
        // Vẫn giữ nguyên enqueue orchestrator ở trên (không mất điều phối/delivery), chỉ bỏ bubble UI.
        const triggerAwaitingSynthesis = isBatchAwaitingSynthesis(batch.map(t => t.fromAgent.id));
        if (!triggerAwaitingSynthesis && !isBroadcastDuplicate(broadcastDedupKey(orchMsg))) {
          chatHistory.push(orchMsg);
          storage.saveMessage(orchMsg);
          broadcast('chat:message', { msg: orchMsg });
        } else if (triggerAwaitingSynthesis) {
          console.log(`[Orchestrator Trigger] Skip per-report bubble (batch chờ synthesis tổng hợp) — ${batch.map(t => t.fromAgent.name).join(', ')}`);
        }
      }
      
      await handleOrchestratorResponse(result.content, (result as any).thinking || '', orchId);
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
      updateOrchStateSafe(orchId, 'idle', 'Sẵn sàng');
      if (pendingOrchTriggers.length > 0) {
        if (orchTriggerDebounceTimer) clearTimeout(orchTriggerDebounceTimer);
        orchTriggerDebounceTimer = null;
        setImmediate(processOrchestratorTriggerQueue);
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

// Kiểm tra khối report có ≥1 dòng KEY:/ JSON thực sự (không rỗng / không chỉ tag trần)
function hasReportBody(text: string): boolean {
  const body = (text || '').trim();
  if (!body) return false;
  // Loại bỏ thẻ mở/đóng thuần (VD === TASK REPORT === / === END REPORT === / <report>).
  const stripped = body
    .replace(/===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===/gi, '')
    .replace(/===\s*END[^=\n]*REPORT\s*===/gi, '')
    .replace(/<\/?\s*(?:report|task_report|task-report|error_report|error-report)\s*>?/gi, '')
    .trim();
  if (!stripped) return false;
  // Có ít nhất 1 dòng "KEY: value" (UPPER/Snake) hoặc JSON object → được xem là report thực.
  return /^[A-Z][A-Z_0-9]*(?:\s*:)/mi.test(stripped) || /^\s*\{[\s\S]*\}/.test(stripped);
}

// Bóc tách CHỈ lấy khối Task Report sạch từ output của worker (bỏ toàn bộ lời tự sự/log phía trên).
// Hỗ trợ cả thẻ XML <report>...</report> lẫn cú pháp Bracket === TASK REPORT ===.
// Tim marker REPORT ngoài code fence. Trả về { index } của marker thực đầu tiên,
// bỏ qua literal marker nằm trong khối code (``` / backtick) hoặc attribute-đã-escaped.
function findReportMarkerOutsideCode(text: string): number | undefined {
  const fences = getCodeFenceRanges(text);
  const isCoded = (idx: number) => {
    for (const [s, e] of fences) if (idx >= s && idx < e) return true;
    return false;
  };
  const re = /===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!isCoded(m.index)) return m.index;
  }
  return undefined;
}

function extractCleanTaskReport(content: string): string {
  const text = content || '';

  // 0. Nếu marker xuất hiện TRONG code fence (literal ví dụ) → KHÔNG phải report thật,
  // trả về text gốc để không bóc nhầm code sample thành report (hoặc cắt rỗng gốc).
  const haveRealMarker = findReportMarkerOutsideCode(text) !== undefined;

  // 1. Thẻ XML <report>...</report> (hoặc <task_report>, <error_report>)
  // Chỉ chấp nhận khi có marker header thật ngoài code, hoặc thẻ XML xuất hiện ngoài code fence.
  const xmlReportMatch = text.match(/<(?:\s*(?:report|task_report|task-report|error_report|error-report))\b[^>]*>([\s\S]*?)<\/\s*(?:report|task_report|task-report|error_report|error-report)\s*>/i);
  if (xmlReportMatch && xmlReportMatch.index !== undefined && !isInCodeSpan(xmlReportMatch.index, getCodeFenceRanges(text))) {
    return xmlReportMatch[0].trim();
  }

  // 2. Cú pháp Bracket === TASK REPORT === ... === END REPORT ===
  const startIdx = findReportMarkerOutsideCode(text);
  if (startIdx === undefined || !haveRealMarker) return text;
  let from = startIdx;
  // Giữ kèm dòng "Task complete." (hoặc "[TO: ...] Task complete.") ngay trước marker nếu có
  const before = text.slice(0, startIdx);
  const beforeTrim = before.trimEnd();
  const lastLineMatch = beforeTrim.match(/(?:^|\n)([^\n]*Task complete\.?[^\n]*)$/i);
  if (lastLineMatch) {
    from = beforeTrim.length - lastLineMatch[1].length;
  }
  // Marker kết thúc tương ứng: === END <loại> REPORT === (tìm ngoài code fence nếu có thể)
  const afterStart = text.slice(startIdx);
  const fencesAfter = getCodeFenceRanges(afterStart);
  const isCodedAfter = (idx: number) => {
    for (const [s, e] of fencesAfter) if (idx >= s && idx < e) return true;
    return false;
  };
  let end = text.length;
  const endRe = /===\s*END[^=\n]*REPORT\s*===/gi;
  let em: RegExpExecArray | null;
  while ((em = endRe.exec(afterStart)) !== null) {
    if (!isCodedAfter(em.index)) { end = startIdx + em.index + em[0].length; break; }
  }
  const report = text.slice(from, end).trim();
  // Nếu khối report sau khi bóc chỉ còn tag/trống → KHÔNG nuốt thành <report>...</report> trống,
  // trả về toàn bộ text gốc để fallback ở candidate xử lý.
  return hasReportBody(report) ? report : text.trim();
}

// Deduplicate: track các nội dung broadcast gần đây (4s window) để tránh nhân đôi report
async function handleAgentResponse(content: string, fromAgent: Agent, defaultTo: string = 'orchestrator', toolCalls?: Array<{ tool: string; input?: string; output?: string }>, thinking?: string) {
  await parseAgentCommands(content, fromAgent.id);
  let messages = parseAgentOutput(content, defaultTo);
if (messages.length === 0 && content && content.trim()) {
     const fallbackText = content.trim();
     if (fallbackText) {
       messages = [{ to: defaultTo, message: fallbackText }];
     }
   }

  let hasOrchestratorMessage = false;

  for (const msg of messages) {
    const isInternal = msg.to !== 'user' && msg.to !== 'broadcast';
    // Kênh Orchestrator: bản SẠCH — bóc riêng Task Report, bỏ lời tự sự; không toolCalls/thinking.
    // Chi tiết toolcall + tự sự đầy đủ chỉ phát trên kênh nội bộ của worker (to === agentId).
    const targetOrchId = resolveOrchestratorTarget(fromAgent);
    const isToOrchestrator = msg.to === 'orchestrator' || msg.to === targetOrchId || (agents.get(msg.to)?.type === 'orchestrator');
    const resolvedTo = (msg.to === 'orchestrator') ? targetOrchId : msg.to;
    const cleanedForOrch = stripToolNoiseForOrchestrator(msg.message);
    const hasReportTag = /(?:===\s*(?:TASK|RESEARCH|VERIFICATION|ERROR)\s+REPORT\s*===|<\s*(?:report|task_report|task-report)\b)/i.test(cleanedForOrch);
    const extractedReport = (isToOrchestrator || fromAgent.type === 'worker') && hasReportTag
      ? extractCleanTaskReport(cleanedForOrch)
      : '';
    const outContent = (extractedReport && extractedReport !== cleanedForOrch && hasReportBody(extractedReport))
      ? extractedReport
      : cleanedForOrch;

    const earlySig = talkDispatchSig(fromAgent.id, resolvedTo, msg.task, msg.message);
    const isAlreadyEarlyDispatched = dispatchedCmdSigs.get(fromAgent.id)?.has(earlySig);

    const reply: ChatMsg = {
      id: uuidv4(),
      from: fromAgent.id,
      to: resolvedTo,
      content: outContent,
      timestamp: Date.now(),
      agentName: fromAgent.name,
      agentRole: fromAgent.role,
      teamId: fromAgent.teamId || 'default',
      // msgType phản ánh NGƯỜI GỬI, không phải đích (fix arch-dbg):
      // - orchestrator_internal CHỈ khi NGƯỜI GỬI là orchestrator (planning nội bộ, ẩn trong khung worker).
      // - worker gửi báo cáo cho orchestrator dùng 'talk' (hoặc undefined nếu to user/broadcast) —
      //   KHÔNG gán orchestrator_internal → trước đây ChatPanel L1954 (isOrchestratorInternal && !showOnUI)
      //   ẩn mất báo cáo worker khỏi khung chat agent.
      msgType:
        fromAgent.type === 'orchestrator'
          ? (isInternal ? 'orchestrator_internal' : undefined)
          : (isInternal ? 'talk' : undefined)
    };

    // Dedup broadcast UI:
    // 1. Nếu lệnh này ĐÃ được broadcast sớm trong luồng stream (isAlreadyEarlyDispatched) -> BỎ QUA broadcast lại ở final pass.
    // 2. Khóa content-based (từ|đến|nội dung chuẩn hoá) trong cửa sổ TTL -> nếu trùng thì bỏ qua.
    if (!isAlreadyEarlyDispatched && !isBroadcastDuplicate(broadcastDedupKey(reply))) {
      chatHistory.push(reply);
      storage.saveMessage(reply);
      broadcast('chat:message', { msg: reply });
    } else {
      console.log(`[Route] Skip duplicate broadcast bubble from ${fromAgent.name} -> ${resolvedTo} (early-dispatched or dedup window)`);
    }

    // Chặn turn thừa: nội dung rỗng tuyệt đối / "(No response)" đã hiển thị ở trên,
    // nhưng KHÔNG route tiếp (không trigger Orchestrator, không deliverTalk) → hết loop.
    if (isEmptyAgentOutput(msg.message)) {
      console.log(`[Route] Skip empty/no-response output from ${fromAgent.name} to ${resolvedTo} (no new turn spawned)`);
      if (isToOrchestrator) hasOrchestratorMessage = true;
      continue;
    }

    // Fallback chống "cắt rỗng": nếu bóc-tách report làm outContent rỗng/mất nội dung so với
    // tin gốc → giữ nguyên message gốc (không gửi rỗng về Orchestrator, không mất delivery).
    const safeOutContent = outContent && outContent.trim()
      ? outContent
      : (msg.message && msg.message.trim() ? msg.message : outContent);

    if (resolvedTo === 'orchestrator') {
      hasOrchestratorMessage = true;
      updateOrchStateSafe(resolvedTo, 'working', `Đang tiếp nhận & tổng kết báo cáo từ ${fromAgent.name}`);
      // Chuyển thẳng tin nhắn (đã lọc nhiễu tool) về Orchestrator không bị chặn
      await triggerOrchestrator(fromAgent, safeOutContent);
    } else {
      const targetAgent = agents.get(resolvedTo) || findAgentByIdNameOrRole(resolvedTo, fromAgent.teamId);
      if (targetAgent) {
        // FIX A: cho phép secondary orchestrator (role='orchestrator', type có thể là 'worker').
        // Nếu chỉ nhận type==='orchestrator', secondary được spawn với type:'worker' sẽ rơi vào
        // nhánh deliverTalk → handleAgentResponse (KHÔNG parse spawn) → <spawn> bị loại im lặng.
        if (targetAgent.type === 'orchestrator' || targetAgent.role === 'orchestrator') {
          hasOrchestratorMessage = true;
          updateOrchStateSafe(resolvedTo, 'working', `Đang tiếp nhận & tổng kết báo cáo từ ${fromAgent.name}`);
          await triggerOrchestrator(fromAgent, safeOutContent);
        } else {
          targetAgent.status = 'working';
          targetAgent.workingSince = Date.now();
          storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
          broadcast('agent:updated', { agent: targetAgent });
          // EARLY DISPATCH DEDUP: nếu talk này đã được dispatch SỚM trong luồng stream
          // (cùng from>target|task|message signature), thì KHÔNG deliverTalk lại lần 2 —
          // tránh nhân đôi delivery khi final pass chạy. UI bubble vẫn được broadcast ở trên.
          const earlySig = talkDispatchSig(fromAgent.id, targetAgent.id, msg.task, msg.message);
          if (dispatchedCmdSigs.get(fromAgent.id)?.has(earlySig)) {
            console.log(`[StreamDispatch] Skip final deliverTalk (already early-dispatched): ${fromAgent.name} -> ${targetAgent.name}`);
          } else {
            deliverTalk(targetAgent, fromAgent, { to: resolvedTo, message: msg.message, task: msg.task });
          }
        }
      } else {
        if (msg.to !== 'user' && msg.to !== 'orchestrator' && msg.to !== 'broadcast') {
          const cleanTo = cleanTargetIdentifier(msg.to);
          const isPlaceholder = !cleanTo || INVALID_TARGET_PLACEHOLDERS.has(cleanTo.toLowerCase()) || cleanTo === 'worker' || cleanTo === 'target-id' || cleanTo === 'agent-id';
          if (!isPlaceholder) {
            const notFoundMsg = `[ERROR: TALK_AGENT_NOT_FOUND]
Lý do: Không tìm thấy agent mục tiêu '${msg.to}' trong danh sách active agents.
Cú pháp đúng:
<talk target="orchestrator">
Nội dung tin nhắn gửi về Orchestrator
</talk>
(Hoặc kiểm tra lại danh sách ID agent trong khối [TEAM] để lấy target-id chính xác)`;
            // 1. Gửi thông báo lỗi trực tiếp vào chat của chính fromAgent để agent biết sai ngay lập tức
            const errChatMsg: ChatMsg = {
              id: uuidv4(),
              from: 'orchestrator',
              to: fromAgent.id,
              content: notFoundMsg,
              timestamp: Date.now(),
              agentName: 'Orchestrator',
              agentRole: 'orchestrator',
              teamId: fromAgent.teamId || 'default'
            };
            chatHistory.push(errChatMsg);
            storage.saveMessage(errChatMsg);
            broadcast('chat:message', { msg: errChatMsg });

            // 2. Forward về Orchestrator hợp lệ hiện hữu (dùng findExistingOrchestrator để tránh trỏ vào ID cũ đã mất)
            const activeOrch = findExistingOrchestrator(fromAgent.teamId) || agents.get('orchestrator');
            const targetOrch = activeOrch?.id || 'orchestrator';
            forwardToOrchestrator('TALK_AGENT_NOT_FOUND', notFoundMsg, targetOrch, fromAgent.teamId || 'default');
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

  // Drain buffer stream: turn của agent này đã kết thúc, xoá buffer đã tích luỹ để không phình bộ nhớ.
  drainDispatchState(fromAgent.id);
}

// Gửi tin nhắn TALK từ fromAgent → targetAgent, bền vững qua outbox.
// existingReportId dùng khi replay để không sinh bản trùng.
async function deliverTalk(targetAgent: Agent, fromAgent: Agent, msg: { to: string; message: string; task?: string }, existingReportId?: string) {
  // === OUTBOX CONTENT DEDUP WORKER↔WORKER ===
  // Prevent duplicate enqueue when same content sent to same agent within 2s window.
  // Root cause report lặp 3-4 lần: 7 call-site nest route cùng nội dung → enqueue uuidv4 MỚI nhiều lần.
  // Guard này CHỈ áp dụng cho giao worker↔worker (KHÔNG target orchestrator/user/broadcast) và
  // KHÔNG áp dụng khi replay outbox (existingReportId) — replay là delivery chính đáng, không dedup.
  const applyDedup = !existingReportId
    && msg.to !== 'orchestrator' && msg.to !== 'user' && msg.to !== 'broadcast'
    && fromAgent.role !== 'orchestrator' && targetAgent.role !== 'orchestrator';
  if (applyDedup) {
    const dedupKey = `${fromAgent.id}->${targetAgent.id}::${normCmdSigPart(msg.message)}`;
    const now = Date.now();
    const lastSent = deliverTalkDedup.get(dedupKey);
    if (lastSent !== undefined && (now - lastSent) < OUTBOX_DELIVER_TALK_DEDUP_MS) {
      console.log(`[OutboxDedup] Skip duplicate deliverTalk ${fromAgent.id}->${targetAgent.id} within ${OUTBOX_DELIVER_TALK_DEDUP_MS}ms: ${dedupKey.slice(0, 80)}`);
      // Deduplicate: skip enqueue hoàn toàn (không gửi trùng). Không persist outbox record mới.
      return;
    }
    deliverTalkDedup.set(dedupKey, now);
    // Clean old entries periodically để map không phình vô hạn
    if (deliverTalkDedup.size > 1000) {
      const cutoff = now - OUTBOX_DELIVER_TALK_DEDUP_MS * 2;
      for (const [k, t] of deliverTalkDedup) {
        if (t < cutoff) deliverTalkDedup.delete(k);
      }
    }
  }

  // Cập nhật task cho targetAgent: CHỈ cập nhật khi lệnh có truyền explicit task="..."
  // (parse TRƯỚC outbox enqueue để kiểm tra trần cứng trước — full thì KHÔNG enqueue,
  // KHÔNG gửi tin, KHÔNG broadcast).
  const explicitTask = msg.task && msg.task.trim() ? msg.task.trim() : '';
  const truncated = explicitTask ? truncateTask(explicitTask) : '';
  if (explicitTask) {
    if (!targetAgent.tasks) targetAgent.tasks = [];
    // Đếm task giao việc THẬT (loại trừ tin nhắn user thường). Full → đẩy completed
    // cũ nhất rồi push tiếp (persist+broadcast sau); hết completed mới báo lỗi
    // (không enqueue outbox, không gửi tin).
    const effectiveTaskLimit = getEffectiveTaskLimit(targetAgent.teamId);
    const dupTask = targetAgent.tasks.find(t => t.task.toLowerCase() === truncated.toLowerCase());
    if (!dupTask && countRealTasks(targetAgent.tasks) >= effectiveTaskLimit && !evictOldestCompletedTask(targetAgent.tasks)) {
      const taskErr = `[ERROR: TASK_LIMIT_EXCEEDED]
Lý do: Agent '${targetAgent.name}' (${targetAgent.id}) đã đạt tối đa ${effectiveTaskLimit} task giao việc (không còn task completed để dọn).
Yêu cầu bị từ chối: task="${truncated}" — không gửi tin nhắn, không enqueue retry.

Hành động bắt buộc:
1. Đánh giá hoàn thành các task hiện có:
   <task_update agent="${targetAgent.id}" task="1" status="completed" /> (hoặc task="2", task="3"...)
2. Hoặc xóa bỏ task không còn cần thiết:
   <delete_task agent="${targetAgent.id}" task="1" /> (hoặc [DELETE_TASK agent=${targetAgent.id} task="task #1"])`;
      forwardToOrchestrator('TASK_LIMIT_EXCEEDED', taskErr, fromAgent.id, targetAgent.teamId || 'default');
      return;
    }
  }

  const reportId = existingReportId || uuidv4();
  if (!existingReportId) {
    storage.enqueueOutbox({
      id: reportId,
      fromAgentId: fromAgent.id,
      fromAgentName: fromAgent.name,
      fromAgentRole: fromAgent.role,
      teamId: fromAgent.teamId,
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

    if (explicitTask) {
      if (!targetAgent.tasks) targetAgent.tasks = [];
      targetAgent.task = truncated;

      const existing = targetAgent.tasks.find(t => t.task.toLowerCase() === truncated.toLowerCase());
      if (existing) {
        if (existing.status !== 'completed') {
          existing.status = 'working';
        }
      } else {
        targetAgent.tasks.push({
          id: String(targetAgent.tasks.length + 1),
          task: truncated,
          status: 'working',
          createdAt: Date.now()
        });
      }
      storage.updateAgent(targetAgent.id, { task: targetAgent.task, tasks: targetAgent.tasks } as any);
      broadcast('agent:updated', { agent: targetAgent });
    }

    const talkHeader = `=== INCOMING MESSAGE ===\nFROM: ${fromAgent.name} (ID: ${fromAgent.id}, Role: ${fromAgent.role})\nTO: ${targetAgent.name} (ID: ${targetAgent.id}, Role: ${targetAgent.role})\n=== MESSAGE ===`;

    const isFromOrch = isOrchestratorLike(fromAgent);
    const teamBlock = isFromOrch ? `[TEAM]\n${buildTeam(targetAgent.id)}\n[/TEAM]\n\n` : '';
    const talkPrompt = `${teamBlock}${talkHeader}\n${msg.message}\n\n${WORKER_REMINDER}`;
    // WORKING NGAY TRƯỚC ENQUEUE: badge worker trên UI nhảy sang Working tức thì,
    // không phụ thuộc caller có set hay không (cover cả đường replay outbox).
    targetAgent.status = 'working';
    targetAgent.workingSince = Date.now();
    storage.updateAgent(targetAgent.id, { status: 'working', workingSince: targetAgent.workingSince });
    broadcast('agent:updated', { agent: targetAgent });

    // ACK-based: đánh dấu in_flight TRƯỚC enqueue — delivered CHỈ sau khi enqueue thành công (client ACK)
    storage.markOutboxInFlight(reportId);

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

    const validation = validateWorkerCompletion(tr.content, targetAgent);
    if (!validation.valid && !isEmptyAgentOutput(tr.content)) {
      console.log(`[Talk] Agent ${targetAgent.name} completion format invalid: ${validation.reason}`);
      const orchAgent = agents.get('orchestrator') || (storage.getAgent('orchestrator') as any);
      if (orchAgent && targetAgent.id !== 'orchestrator') {
        const feedbackMsg = buildFormatFeedbackPrompt(validation.reason || 'Báo cáo chưa đúng định dạng', targetAgent);
        deliverTalk(targetAgent, orchAgent, { to: targetAgent.id, message: feedbackMsg }).catch(err => {
          console.error(`[Feedback] Failed to deliver format feedback to ${targetAgent.name}:`, err.message);
        });
      }
    }

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
    processNextBackendUserQueue(targetAgent.id);
  } catch (e: any) {
    // Lỗi Abort: xóa khỏi Outbox NGAY, không retry (chống vòng lặp spam lỗi aborted)
    const isAborted = e.message?.toLowerCase().includes('abort') || e.message?.toLowerCase().includes('aborted');
    if (isAborted) {
      storage.markOutboxDelivered(reportId);
    } else {
      storage.markOutboxFailed(reportId, e.message);
      // Dùng getOutboxRecord để tìm bất kể trạng thái (record đã bị set 'failed')
      const rec = storage.getOutboxRecord?.(reportId) || storage.getPendingOutbox().find(r => r.id === reportId);
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

async function handleOrchestratorResponse(response: string, extraScanText = '', orchId = 'orchestrator'): Promise<string[]> {
  // FIX 2 — Clear dedup-spawn-set ở ĐẦU mỗi lần xử lý 1 response: dedup CHỈ trong phạm vi 1 response
  // (spawn lặp trong cùng 1 output), không chặn nhầm spawn hợp lệ ở turn/response khác.
  handledSpawnSigs.clear();
  const commandResults: string[] = [];
  let cmdResults: string[] = [];
  try {
    cmdResults = await parseAgentCommands(response, orchId);
  } catch (e: any) {
    console.error(`[OrchCmd] parseAgentCommands failed: ${e?.message || e}`);
  }
  commandResults.push(...cmdResults);

  // SPAWN scan: CHỈ scan trong RESPONSE THẬT (không scan thinking/extraScanText).
  // FIX 3 — chặn parse spawn trong thinking: `extraScanText=thinking` trước đây tái kích hoạt lệnh
  // spawn cũ nằm trong nội dung reasoning/model tự nói (gây SPAWN lặp / ROLE_LIMIT spam). Suy nghĩ
  // của model (thinking/reasoning) KHÔNG phải lệnh điều phối — bỏ qua hoàn toàn, không spawn, không lỗi.
  // extractBracketCommands (gọi bởi parseSpawnTags) skip tag nằm trong fenced/inline code/report/
  // quoted attrs qua getCodeSpanRanges + isInCodeSpan → dùng raw response an toàn, không cần sanitize.
  // Tag trong blockquote mô tả (target/role placeholder) sẽ lọt parse nhưng bị bỏ qua im lặng vì
  // cleanTargetIdentifier không tìm thấy agent / parseSpawnCommand trả null — không thành lệnh thật.
  const scanText = response; // FIX 3: không gộp extraScanText (thinking) vào scan spawn.
  const spawns = parseSpawnTags(scanText, orchId);

  // FIX 2 — DEDUP SPAWN theo signature (role+name+task normalized). Trong cùng 1 response, model
  // có thể emit nhiều <spawn> đồng signature (đặc biệt khi response lặp qua cả stream-dispatch lẫn
  // full-parse) → loại bỏ lệnh trùng để ngăn SPAWN_ROLE_LIMIT/ROLE_LIMIT spam. Set được clear ở đầu
  // hàm (mỗi response = 1 turn), nên chỉ dedup trong phạm vi response hiện tại, không chặn lệnh hợp lệ.
  const dedupedSpawns: typeof spawns = [];
  for (const spawn of spawns) {
    const ssig = spawnDispatchSig(spawn.role, spawn.name, spawn.task);
    if (handledSpawnSigs.has(ssig)) {
      console.log(`[SpawnDedup] Skip duplicate spawn (role=${spawn.role} name=${spawn.name}) — đã xử lý trong turn này.`);
      continue;
    }
    handledSpawnSigs.add(ssig);
    dedupedSpawns.push(spawn);
  }
  const effectiveSpawns = dedupedSpawns;
  
  // Nếu có chuỗi [SPAWN role=...] nhưng parse thất bại (thiếu name hoặc task), chỉ cảnh báo nhẹ console,
  // tuyệt đối KHÔNG bắn tin nhắn lỗi spam về Orchestrator nếu chỉ là câu văn tự sự/ví dụ.
  // Chỉ forward cảnh báo thật khi tag có attribute THỰC (role= + name=/task= không phải placeholder),
  // để parse lỗi không lặng thinh mà cũng không spam tín hiệu giả từ câu văn tự sự chứa "[SPAWN role=".
  if (spawns.length === 0 && /\[SPAWN\s+role=/i.test(scanText)) {
    console.warn('[SpawnParse] Phát hiện tag [SPAWN role=...] nhưng thiếu name hoặc task hợp lệ.');
    const spawnPlaceholders = new Set(['<role>', '<name>', '<task>', 'role', 'name', 'task', '...', 'none', 'undefined', 'null', 'your-name', '<your-name>']);
    const spawnTagMatch = scanText.match(/\[SPAWN\s*([^\]]*)\]/i);
    const spawnAttrs = spawnTagMatch ? spawnTagMatch[1].trim() : '';
    if (spawnAttrs) {
      const roleAttr = (spawnAttrs.match(/role\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i) || []).slice(1).find(v => v && !spawnPlaceholders.has(v.trim().toLowerCase()));
      const hasRealName = (spawnAttrs.match(/name\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i) || []).slice(1).some(v => v && !spawnPlaceholders.has(v.trim().toLowerCase()));
      const hasRealTask = (spawnAttrs.match(/task\s*=\s*(?:"([^"]+)"|'([^']+)'|[“]([^”]+)[”]|([^\s>]+))/i) || []).slice(1).some(v => v && !spawnPlaceholders.has(v.trim().toLowerCase()));
      if (roleAttr && (hasRealName || hasRealTask)) {
        const parseErrorContent = `[ERROR: SPAWN_PARSE_FAIL]
Lý do: Cú pháp lệnh <spawn> không hợp lệ hoặc thiếu thuộc tính bắt buộc (cần 'role', 'name', 'task'). Raw: ${spawnAttrs.slice(0, 120)}
Cú pháp đúng:
<spawn role="coder" name="coder-1" task="Mô tả nhiệm vụ cụ thể tại đây" />`;
        forwardToOrchestrator('SPAWN_PARSE_FAIL', parseErrorContent, orchId);
      }
    }
  }

  // TASK LENGTH WARNING + EMPTY TASK GUARDRAIL (chỉ trên spawns đã dedup)
  for (const spawn of effectiveSpawns) {
    if (!spawn.task || !spawn.task.trim()) {
      forwardToOrchestrator('SPAWN_EMPTY_TASK', `[ERROR] Agent "${spawn.name}" (role: ${spawn.role}) khong co task. Can cung cap task description.`, orchId);
      effectiveSpawns.splice(effectiveSpawns.indexOf(spawn), 1);
      continue;
    }
    const wordCount = spawn.task.trim().split(/\s+/).length;
    if (wordCount > 30) {
      forwardToOrchestrator('SPAWN_TASK_LONG', `[WARN] Task "${spawn.name}" co ${wordCount} tu (>30). Nen tom gon 30 tu.`, orchId);
    }
  }

  for (const spawn of effectiveSpawns) {
     const { role, name, task } = spawn;
     const existing = findAgentByName(name);
     if (existing) {
       if (existing.status === 'working') {
       commandResults.push(`[WARN] Agent ${name} (${existing.id}) is already working; reusing with new task may interrupt current work.`);
     }
        commandResults.push(`Reused ${name} (${existing.id})`);
        existing.status = 'working';
        existing.workingSince = Date.now();
        if (task && task.trim()) {
          const truncated = truncateTask(task.trim());
          existing.task = truncated;
          if (!existing.tasks) existing.tasks = [];
          const found = existing.tasks.find(t => t.task.toLowerCase() === truncated.toLowerCase());
          if (found) {
            if (found.status !== 'completed') {
              found.status = 'working';
            }
      } else {
        // Đếm task giao việc THẬT (loại trừ tin nhắn user thường, trần live Team Settings).
        // Full → đẩy completed cũ nhất (persist+broadcast sau push); hết completed mới báo lỗi
        // (không gửi tin, không enqueue, không broadcast tin mới).
        const existingTaskLimit = getEffectiveTaskLimit(existing.teamId);
        if (countRealTasks(existing.tasks) >= existingTaskLimit && !evictOldestCompletedTask(existing.tasks)) {
            const taskErr = `[ERROR: TASK_LIMIT_EXCEEDED]
Lý do: Agent '${existing.name}' (${existing.id}) đã đạt tối đa ${existingTaskLimit} task giao việc (không còn task completed để dọn).
Yêu cầu phân công bị từ chối: task="${truncated}"

Hành động bắt buộc:
1. Đánh giá hoàn thành các task hiện có:
   <task_update agent="${existing.id}" task="1" status="completed" /> (hoặc task="2", task="3"...)
2. Hoặc xóa bỏ task không còn cần thiết:
   <delete_task agent="${existing.id}" task="1" /> (hoặc [DELETE_TASK agent=${existing.id} task="task #1"])`;
            forwardToOrchestrator('TASK_LIMIT_EXCEEDED', taskErr, orchId, existing.teamId || 'default');
            commandResults.push(taskErr);
            continue;
        }

        existing.tasks.push({
          id: String(existing.tasks.length + 1),
          task: truncated,
          status: 'working',
          createdAt: Date.now()
        });
      }
        }
        storage.updateAgent(existing.id, { status: 'working', workingSince: existing.workingSince, task: existing.task, tasks: existing.tasks } as any);
        broadcast('agent:updated', { agent: existing });
      
      const reuseTaskMsg: ChatMsg = {
        id: uuidv4(),
        from: 'orchestrator',
        to: existing.id,
        content: `[TASK] New assignment for ${name}: ${task}`,
        timestamp: Date.now(),
        agentName: 'Orchestrator',
        agentRole: 'orchestrator',
        msgType: 'talk',
        teamId: existing.teamId || 'default'
      };
      chatHistory.push(reuseTaskMsg);
      storage.saveMessage(reuseTaskMsg);
      broadcast('chat:message', { msg: reuseTaskMsg });
      
      setTimeout(async () => {
        try {
          const tc = getClient(existing);
          const needReinject = tc.getNeedPromptReinject() || !existing.sessionId;
          if (needReinject) tc.setNeedPromptReinject(false);
          const spawnTeam = buildTeam(existing.id);
          const prompt = `[TASK] ${task}\n[TEAM]\n${spawnTeam}\n[/TEAM]\n\n=== INCOMING MESSAGE ===\nFROM: Orchestrator (ID: orchestrator)\nTO: ${existing.name} (ID: ${existing.id}, Role: ${existing.role})\n=== MESSAGE ===\n${task}\n\n${WORKER_REMINDER}`;
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
          await handleStandardizedAgentError(existing, e, {
            originOrchId: orchId,
            actionDescription: 'thực hiện task phân công lại'
          });
        }
      }, 100);
    } else {
      // 1. Kiểm tra bất thường: nếu vượt trần TEAM thì tự động xóa bớt (per-team)
      const spawnTeamId = agents.get(orchId)?.teamId || 'default';
      await autoPruneExcessAgents(role, spawnTeamId);

      // 1.0 Cổng check sống từ Team Settings live (đồng nhất với GET /api/teams/:teamId/settings/live-check)
      const spawnGate = checkLiveSpawnGate(spawnTeamId, role);
      if (!spawnGate.canSpawn) {
        const gateErrContent = `[ERROR: SPAWN_LIVE_GATE]
Vị trí: src/server.ts:handleOrchestratorResponse
Lý do: ${spawnGate.reason}
Yêu cầu khởi tạo bị từ chối: name="${name}", role="${role}", task="${(task || '').slice(0, 80)}"`;
        console.warn(`[Spawn Gate] ${gateErrContent}`);
        commandResults.push(gateErrContent);
        forwardToOrchestrator(spawnGate.code === 'OK' ? 'SPAWN_ROLE_LIMIT' : (spawnGate.code as any), gateErrContent, orchId, spawnTeamId);
        continue;
      }

      // 1.1 Kiểm tra giới hạn tổng số thành viên trong 1 team (trần live từ Team Settings)
      const effectiveTeamSizeLimit = getEffectiveTeamSizeLimit(spawnTeamId);
      const currentTeamAgents = getAgentsByTeam(spawnTeamId);
      if (currentTeamAgents.length >= effectiveTeamSizeLimit) {
        const teamMemberList = currentTeamAgents.map(a => `${a.name} (${a.role}, id: ${a.id}, status: ${a.status})`).join('\n  - ');
        const teamErrorContent = `[ERROR: SPAWN_TEAM_LIMIT]
Vị trí: src/server.ts:handleOrchestratorResponse
Lý do: Đã đạt giới hạn tối đa ${effectiveTeamSizeLimit} thành viên trong team '${spawnTeamId}' (hiện có ${currentTeamAgents.length}/${effectiveTeamSizeLimit} thành viên bao gồm cả Main Orchestrator).
Yêu cầu khởi tạo bị từ chối: name="${name}", role="${role}", task="${(task || '').slice(0, 80)}"

Danh sách thành viên hiện tại của team '${spawnTeamId}':
  - ${teamMemberList}

Hành động bắt buộc: Không được spawn thêm worker mới. Hãy tái sử dụng các thành viên hiện có bằng thẻ <talk target="...">...</talk> hoặc hoàn thành công việc với nhân lực hiện có.`;
        console.warn(`[Team Limit] ${teamErrorContent}`);
        commandResults.push(teamErrorContent);

        const limitErrMsg = forwardToOrchestrator('SPAWN_TEAM_LIMIT', teamErrorContent, orchId, spawnTeamId);
        const limitErrMsgUser: ChatMsg = {
          id: uuidv4(),
          from: orchId,
          to: 'user',
          content: `⚠️ Không thể tạo thêm agent "${name}" (role: ${role}): Team '${spawnTeamId}' đã đạt tối đa ${effectiveTeamSizeLimit} thành viên (bao gồm cả Main Orchestrator). Vui lòng tái sử dụng agent hiện có.`,
          timestamp: Date.now(),
          agentName: agents.get(orchId)?.name || 'Orchestrator',
          agentRole: 'orchestrator',
          teamId: spawnTeamId,
          msgType: 'error'
        };
        chatHistory.push(limitErrMsgUser); storage.saveMessage(limitErrMsgUser);
        broadcast('chat:message', { msg: limitErrMsgUser });
        continue;
      }

      // 2. Kiểm tra hạn mức role theo TEAM (trần live từ Team Settings: agentLimits override, fallback coder 4/researcher 2/khác 1)
      const roleLimit = getEffectiveRoleLimit(role, spawnTeamId);
      const activeRoleAgents = getAgentsByRole(role, spawnTeamId);

      if (activeRoleAgents.length >= roleLimit) {
        const idleAgents = activeRoleAgents.filter(a => a.status === 'idle');
        const workingAgents = activeRoleAgents.filter(a => a.status === 'working');
        const otherAgents = activeRoleAgents.filter(a => a.status !== 'idle' && a.status !== 'working');

        const formatAgentStatus = (a: Agent) => `${a.name} (id: ${a.id}, status: ${a.status}${a.task ? `, task: "${a.task.slice(0, 60)}"` : ''})`;
        const idleListStr = idleAgents.length > 0 ? idleAgents.map(formatAgentStatus).join('\n  - ') : '(không có)';
        const workingListStr = workingAgents.length > 0 ? workingAgents.map(formatAgentStatus).join('\n  - ') : '(không có)';
        const otherListStr = otherAgents.length > 0 ? otherAgents.map(formatAgentStatus).join('\n  - ') : '';

        const targetReuseAgent = idleAgents[0] || activeRoleAgents[0];
        const targetReuseId = targetReuseAgent?.id || 'agent-id';
        const targetReuseName = targetReuseAgent?.name || 'agent-name';

        const errorContent = `[ERROR: SPAWN_ROLE_LIMIT]
Vị trí: src/server.ts:handleOrchestratorResponse
Lý do: Đã đạt giới hạn tối đa cho vai trò '${role}' trong team '${spawnTeamId}' (hiện có ${activeRoleAgents.length}/${roleLimit} active).
Yêu cầu khởi tạo bị từ chối: name="${name}", role="${role}", task="${(task || '').slice(0, 80)}"

Trạng thái chi tiết các agent vai trò '${role}' hiện tại:
- Agent rảnh (IDLE) - Ưu tiên giao task mới:
  - ${idleListStr}
- Agent đang bận (WORKING):
  - ${workingListStr}${otherListStr ? `\n- Khác:\n  - ${otherListStr}` : ''}

Hành động bắt buộc: Tái sử dụng agent hiện có (ưu tiên agent đang idle) bằng thẻ <talk>:
<talk target="${targetReuseId}">
Nội dung phân công nhiệm vụ mới cho ${targetReuseName} tại đây
</talk>`;
        console.warn(`[Role Limit] ${errorContent}`);
        commandResults.push(errorContent);

        const limitErrMsg = forwardToOrchestrator('SPAWN_ROLE_LIMIT', errorContent, orchId, spawnTeamId);

        const limitErrMsgUser: ChatMsg = {
          id: uuidv4(),
          from: 'system',
          to: 'user',
          content: errorContent,
          timestamp: Date.now(),
          agentName: 'System',
          agentRole: 'system',
          teamId: agents.get(orchId)?.teamId || 'default'
        };
        chatHistory.push(limitErrMsgUser);
        storage.saveMessage(limitErrMsgUser);
        broadcast('chat:message', { msg: limitErrMsgUser });
        continue;
      }

      const spawnId = 'agent-' + uuidv4().slice(0, 8);
      const parentOrch = agents.get(orchId);
      // Tạm thời: dùng cwd làm projectDir cho mọi worker (sau này mới thêm tính năng prjDir)
      const cwdProjectDir = SERVER_PROJECT_ROOT;
      const na: Agent = {
        id: spawnId, name, role, type: 'worker', status: 'working',
        spawnedBy: orchId, task, teamId: parentOrch?.teamId || 'default', projectDir: cwdProjectDir, createdAt: Date.now(), workingSince: Date.now(),
        tasks: task ? [{ id: '1', task, status: 'working', createdAt: Date.now() }] : [],
        sessionTitle: task ? task.substring(0, 80) : undefined
      };
      agents.set(spawnId, na);
      storage.saveAgent(na);
      broadcast('agent:created', { agent: na });
      notifyTeamChanged(na.teamId || 'default'); // per-team
      
      const spawnTaskMsg: ChatMsg = {
        id: uuidv4(),
        from: orchId,
        to: spawnId,
        content: `[SPAWN] ${role} "${name}" assigned: ${task}`,
        timestamp: Date.now(),
        agentName: orchId === 'orchestrator' ? 'Orchestrator' : (agents.get(orchId)?.name || orchId),
        agentRole: 'orchestrator',
        msgType: 'talk',
        teamId: na.teamId || 'default'
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
          await handleStandardizedAgentError(na, e, {
            originOrchId: orchId,
            actionDescription: 'thực thi lượt spawn đầu tiên'
          });
        }
      }, 100);
    }
  }
  
  // parseOrchestratorCommands → extractBracketCommands skip tag trong fenced/inline code/report/
  // quoted attrs qua getCodeSpanRanges + isInCodeSpan → dùng raw response giữ nguyên path/code
  // backtick trong message talk (không blank). Tag trong blockquote có target placeholder lọt parse
  // nhưng cleanTargetIdentifier không tìm thấy agent → bỏ qua im lặng (L3008-3010).
  const talks = parseOrchestratorCommands(response, orchId);
  let finalTalkOccur = 0;
  for (const talk of talks) {
    const { agentId, message, task } = talk;
    const currentOccur = finalTalkOccur++;
    const ta = agents.get(agentId) || findAgentByName(agentId) || findAgentByIdNameOrRole(agentId, agents.get(orchId)?.teamId);
    if (!ta) {
      // Agent not found — likely a TALK example/placeholder in report text.
      // Skip silently to avoid error spam. Only log to console.
      console.warn(`[TALK] Skipped: agent "${agentId}" not found (likely example in report text)`);
      continue;
    }
    // EARLY DISPATCH DEDUP (orchestrator path): nếu talk này đã được dispatch SỚM trong luồng
    // stream (Orchestrator cũng stream qua broadcastOACEvent, scanStreamForDispatch bắt talk
    // hướng agent khác) → SKIP toàn bộ block tái-dispatch để tránh nhân đôi delivery.
    // CHỈ coi là duplicate khi signature trùng HOÀN TOÀN cả nội dung lẫn chỉ số xuất hiện hoặc trùng nội dung cụ thể
    const earlySigOrch = talkDispatchSig(orchId, ta.id, task, message, currentOccur);
    const earlySigOrchBase = talkDispatchSig(orchId, ta.id, task, message, 0);
    const hasDispatched =
      dispatchedCmdSigs.get(orchId)?.has(earlySigOrch) ||
      dispatchedCmdSigs.get('orchestrator')?.has(earlySigOrch) ||
      dispatchedCmdSigs.get(orchId)?.has(earlySigOrchBase) ||
      dispatchedCmdSigs.get('orchestrator')?.has(earlySigOrchBase) ||
      Array.from(dispatchedCmdSigs.get(orchId) || []).some(s => s.startsWith(`talk|${normCmdSigPart(orchId)}>${normCmdSigPart(ta.id)}|`) && s.includes(`|${normCmdSigPart(message)}|`)) ||
      Array.from(dispatchedCmdSigs.get('orchestrator') || []).some(s => s.startsWith(`talk|orchestrator>${normCmdSigPart(ta.id)}|`) && s.includes(`|${normCmdSigPart(message)}|`));

    if (hasDispatched) {
      console.log(`[StreamDispatch] Skip orchestrator final talk (already early-dispatched): -> ${ta.name} (#${currentOccur})`);
      continue;
    }
    ta.status = 'working';
    ta.workingSince = Date.now();
    // Update task if provided in TALK command
    if (task && task.trim()) {
      const truncated = truncateTask(task.trim());
      ta.task = truncated;
      if (!ta.tasks) ta.tasks = [];
      const found = ta.tasks.find(t => t.task.toLowerCase() === truncated.toLowerCase());
      if (found) {
        if (found.status !== 'completed') {
          found.status = 'working';
        }
      } else {
        // Đếm task giao việc THẬT (loại trừ tin nhắn user thường, trần live Team Settings).
        // Full → đẩy completed cũ nhất (persist+broadcast sau push); hết completed mới báo lỗi
        // (không gửi tin, không enqueue, không broadcast tin mới).
        const taTaskLimit = getEffectiveTaskLimit(ta.teamId);
        if (countRealTasks(ta.tasks) >= taTaskLimit && !evictOldestCompletedTask(ta.tasks)) {
            const taskErr = `[ERROR: TASK_LIMIT_EXCEEDED]
Lý do: Agent '${ta.name}' (${ta.id}) đã đạt tối đa ${taTaskLimit} task giao việc (không còn task completed để dọn).
Yêu cầu bị từ chối: task="${truncated}"

Hành động bắt buộc:
1. Đánh giá hoàn thành các task hiện có:
   <task_update agent="${ta.id}" task="1" status="completed" /> (hoặc task="2", task="3"...)
2. Hoặc xóa bỏ task không còn cần thiết:
   <delete_task agent="${ta.id}" task="1" /> (hoặc [DELETE_TASK agent=${ta.id} task="task #1"])`;
            forwardToOrchestrator('TASK_LIMIT_EXCEEDED', taskErr, orchId, ta.teamId || 'default');
            commandResults.push(taskErr);
            continue;
        }
        ta.tasks.push({
          id: String(ta.tasks.length + 1),
          task: truncated,
          status: 'working',
          createdAt: Date.now()
        });
      }
    }
    storage.updateAgent(ta.id, { status: 'working', workingSince: ta.workingSince, task: ta.task, tasks: ta.tasks } as any);
    broadcast('agent:updated', { agent: ta });

    const talkMsg: ChatMsg = {
      id: uuidv4(),
      from: orchId === 'orchestrator' ? 'orchestrator' : orchId,
      to: ta.id,
      content: message,
      task: task,
      timestamp: Date.now(),
      agentName: 'Orchestrator',
      agentRole: 'orchestrator',
      msgType: 'talk',
      showOnUI: true,
      teamId: ta.teamId || 'default'
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
        // Direct talk từ Orchestrator chính luôn là isFromOrch = true
        const talkPrompt = `[TEAM]\n${buildTeam(ta.id)}\n[/TEAM]\n\n${talkHeader}\n${message}\n\n${WORKER_REMINDER}`;
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
        await handleStandardizedAgentError(ta, e, {
          originOrchId: orchId,
          actionDescription: 'thực thi lệnh talk'
        });
      }
    }, 100);
  }
  
  return commandResults;
}

function getOrchClient(orchId: string = 'orchestrator'): ACPClient {
  let effectiveOrchId = orchId;
  let targetAgent = agents.get(orchId) || (storage.getAgent(orchId) as any);
  if (orchId !== 'orchestrator' && !targetAgent) {
    const existing = findExistingOrchestrator();
    if (existing && existing.id === orchId) {
      effectiveOrchId = existing.id;
      targetAgent = existing;
    }
  }
  const isMain = effectiveOrchId === 'orchestrator';
  if (targetAgent?.projectDir) {
    syncOpencodeAgents(targetAgent.projectDir);
  }
  const model = isMain ? resolveOrchestratorModel() : resolveModelForAgent(targetAgent || { id: effectiveOrchId, name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator', createdAt: Date.now() });
  if (!clients.has(effectiveOrchId)) {
    const c = new ACPClient({
      id: effectiveOrchId,
      name: targetAgent?.name || (isMain ? 'Orchestrator' : `Orchestrator-${effectiveOrchId.slice(-4)}`),
      role: 'orchestrator',
      type: 'orchestrator',
      projectDir: targetAgent?.projectDir,
      model
    });
    c.setOnEvent((ev: any) => broadcastOACEvent(effectiveOrchId, ev));
    c.setOnStatusChange((busy) => {
      let orch = agents.get(effectiveOrchId);
      if (!orch && isMain) {
        orch = { id: 'orchestrator', name: 'Orchestrator', role: 'orchestrator', type: 'orchestrator', status: 'idle', createdAt: Date.now(), teamId: 'default' };
        agents.set('orchestrator', orch);
      }
      if (!orch) {
        const found = findExistingOrchestrator();
        orch = (found && found.id === effectiveOrchId) ? found : { id: effectiveOrchId, name: `Orchestrator-${effectiveOrchId.slice(-4)}`, role: 'orchestrator', type: 'orchestrator', status: 'idle', createdAt: Date.now(), teamId: targetAgent?.teamId };
      }
      const actualId = orch.id;
      const newStatus = busy ? 'working' : 'idle';
      if (orch.status === newStatus) return; // Guard chống broadcast thừa
      orch.status = newStatus;
      orch.workingSince = busy ? (orch.workingSince || Date.now()) : undefined;
      storage.updateAgent(actualId, { status: orch.status, workingSince: orch.workingSince || null });
      broadcast('agent:updated', { agent: orch });
    });
    clients.set(effectiveOrchId, c);
  } else {
    const c = clients.get(effectiveOrchId)!;
    // Mỗi lượt gọi đều refresh model, kể cả undefined để fallback đúng hierarchy
    c.setModel(model);
  }
  const client = clients.get(effectiveOrchId)!;
  if (targetAgent && client.getSessionId() !== (targetAgent.sessionId || null)) {
    client.setSession(targetAgent.sessionId || null);
  }
  return client;
}

// ============ MODULAR API ROUTES ============
const SERVER_START_TIME = Date.now();
app.use('/api', createApiRouter({
  system: {
    appVersion: APP_VERSION,
    port: PORT,
    serverStartTime: SERVER_START_TIME,
    sseClients,
    wsClients,
    agents,
    storage,
    logBuffer
  },
  settings: {
    storage,
    broadcast,
    agents,
    clients,
    resolveModelForAgent
  },
  models: {
    getAvailableModels,
    getCachedModels: () => cachedModels
  },
  teams: {
    storage,
    broadcast,
    agents
  },
  // Pha 1 refactor: HTTP handlers /api/agents*, /api/history, /api/messages, /api/chat*,
  // /api/orchestrator* sống trong src/routes/* — inject shared refs + helpers qua deps.
  agents: {
    agents,
    storage,
    broadcast,
    clients,
    chatHistory,
    backendUserQueues,
    abortingAgents,
    projectRoot: SERVER_PROJECT_ROOT,
    stopAgent,
    resumeAgent,
    deleteAgent,
    resolveModelForAgent,
    truncateTask,
    autoPruneExcessAgents,
    checkLiveSpawnGate,
    getEffectiveTeamSizeLimit,
    getEffectiveRoleLimit,
    getAgentsByTeam,
    getAgentsByRole,
    forwardToOrchestrator,
    notifyTeamChanged
  },
  chat: {
    agents,
    storage,
    broadcast,
    clients,
    chatHistory,
    backendUserQueues,
    findAgentByIdNameOrRole,
    isOrchestratorLike,
    getOrchClient,
    getClient,
    normalizeQueueKey,
    drainDispatchState,
    updateOrchStateSafe,
    isRetriableError,
    getEffectiveTaskLimit,
    dispatchUserChat
  },
  orchestrator: {
    agents,
    clients,
    storage,
    broadcast,
    chatHistory
  }
}));

// Terminal viewer (GET /logs + /terminal) sống trong src/routes/terminal.ts.
app.use('/', createTerminalRouter({ storage, logBuffer, maxLogBuffer: LOG_BUFFER_MAX }));

// Pha 1: POST /api/agents sống trong src/routes/agents.ts
// Pha 1: POST /api/agents/:id/start|stop|resume sống trong src/routes/agents.ts
// Pha 1: POST /api/agents/:id/abort sống trong src/routes/agents.ts
// Pha 1: DELETE + PATCH /api/agents/:id sống trong src/routes/agents.ts

// Pha 1: DELETE + POST /api/agents/:id/tasks/:taskId/delete sống trong src/routes/agents.ts

// Pha 1: POST /api/agents/:id/model sống trong src/routes/agents.ts

// ============ CHAT ============
// ============ DISPATCH USER CHAT (dùng chung HTTP handler + retry queue) ============
async function dispatchUserChat(params: { targetAgentId: string; rawMsg: string; isSlashCommand: boolean; isRetry?: boolean }): Promise<{ response: string; sid: string | null; commands: string[] }> {
  const { targetAgentId, rawMsg, isSlashCommand, isRetry } = params;
  let resolvedTargetId = targetAgentId || '';
  let targetAgent: Agent | null = (resolvedTargetId && resolvedTargetId !== 'orchestrator') ? (agents.get(resolvedTargetId) || findAgentByIdNameOrRole(resolvedTargetId) || null) : null;
  const isOrchTarget = !targetAgent || isOrchestratorLike(targetAgent) || resolvedTargetId === 'orchestrator';
  let orchId = targetAgent ? targetAgent.id : (resolvedTargetId || 'orchestrator');
  if (isOrchTarget && !agents.has(orchId)) {
    const existingOrch = findExistingOrchestrator();
    if (existingOrch) {
      targetAgent = existingOrch;
      orchId = existingOrch.id;
    }
  }
  let agentName = targetAgent ? targetAgent.name : 'Orchestrator';
  let agentRole = targetAgent ? targetAgent.role : 'orchestrator';
  let prompt: string;
  let sid: string | null = null;
  const client = isOrchTarget ? getOrchClient(orchId) : getClient(targetAgent!);
  const commandResults: string[] = [];

  // ============ PRESERVE & AUTO-MERGE UNPROCESSED USER MESSAGES ============
  // Nếu lượt trước bị Stop / Abort mà còn tin nhắn chưa được xử lý,
  // tự động gộp toàn bộ tin cũ cùng tin mới vào lượt này để không bao giờ mất yêu cầu của người dùng.
  let effectiveMsg = rawMsg;
  const targetKey = isOrchTarget ? orchId : (targetAgent ? targetAgent.id : (resolvedTargetId || 'orchestrator'));
  // CHỈ tự động gộp tin cũ khi hệ thống đang chủ động Retry (isRetry === true)
  const storedOldMsgs = isRetry ? storage.getUnprocessedMessages(targetKey) : [];
  const clientOldPrompts = isRetry ? client.getUnprocessedPrompts() : [];
  const combinedOld = Array.from(new Set([...storedOldMsgs, ...clientOldPrompts])).filter(p => p && p.trim() && p.trim() !== rawMsg.trim());

  if (isRetry && combinedOld.length > 0 && !isSlashCommand) {
    const oldFormatted = combinedOld.map((m, idx) => `[Tin ${idx + 1} chưa xử lý trước đó]:\n${m}`).join('\n\n---\n\n');
    effectiveMsg = `${oldFormatted}\n\n---\n\n[Yêu cầu mới nhất]:\n${rawMsg}`;
    
    // Dọn sạch bộ đệm sau khi đã gộp thành công
    storage.clearUnprocessedMessages(targetKey);
    client.clearUnprocessedPrompts();

    const mergeNotice: ChatMsg = createChatMsg(targetKey, 'system',
      `🔄 Đã tự động gộp ${combinedOld.length} yêu cầu chưa được xử lý từ lượt trước vào lượt chat này để bảo toàn công việc.`,
      { agentName: 'System', agentRole: 'system' });
    chatHistory.push(mergeNotice);
    storage.saveMessage(mergeNotice);
    broadcast('chat:message', { msg: mergeNotice });
  } else if (!isRetry) {
    // Với lượt chat mới bình thường, dọn sạch bộ đệm cũ của targetKey để không bao giờ rò rỉ prompt cũ
    storage.clearUnprocessedMessages(targetKey);
    client.clearUnprocessedPrompts();
  }

  if (isSlashCommand) {
    client.setNeedPromptReinject(true);
  }
  const shouldReinject = (client.getNeedPromptReinject() || (targetAgent ? !targetAgent.sessionId : !client.getSessionId())) && !isSlashCommand;
  if (client.getNeedPromptReinject() && !isSlashCommand) {
    client.setNeedPromptReinject(false);
  }

  if (!isOrchTarget && targetAgent) {
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
          : `[TEAM]\n${team}\n[/TEAM]\n\n[FROM: user] [TO: ${targetAgent.id}] ${effectiveMsg}`;
      } else {
        prompt = `Your ID: ${targetAgent.id}\nYour name: ${targetAgent.name}\nYour role: ${targetAgent.role}\n\n[FROM: user] [TO: ${targetAgent.id}] ${effectiveMsg}`;
      }
    }
  } else {
    updateOrchStateSafe(orchId, 'working', 'Đang phân tích yêu cầu & phân rã bài toán');

    // Inject unread messages từ workers vào prompt (chỉ lấy tin thuộc đúng orchId hoặc team của orchId)
    const rawUnread = isRetry ? [] : consumeUnreadForOrchestrator(orchId);
    // Không bịa team-${slice}: orch lạ → orchTeam undefined → giữ tin (không lọc sai).
    const orchTeam: string | undefined = targetAgent?.teamId || (orchId === 'orchestrator' ? 'default' : agents.get(orchId)?.teamId);
    const unread = rawUnread.filter(m => {
      if (m.to && m.to === orchId) return true;
      if (orchId === 'orchestrator' && (m.to === 'orchestrator' || !m.to)) return true;
      if (m.teamId && orchTeam && m.teamId === orchTeam) return true;
      if (!m.teamId && !orchTeam) return true;
      return false;
    });
    let unreadBlock = '';
    if (unread.length > 0) {
      unreadBlock = '\n\n=== MESSAGES FROM AGENTS (you should respond to these) ===\n' +
        unread.map(m => `[FROM: ${m.agentName || m.from} (${m.from})]\n${m.content}`).join('\n\n') +
        '\n=== END MESSAGES ===\n';
    }

    const team = buildTeam(orchId);
    if (isSlashCommand) {
      prompt = effectiveMsg;
    } else {
      prompt = `[TEAM]\n${team}${unreadBlock}\n[/TEAM]\n\n[FROM: user] [TO: ${orchId}] ${effectiveMsg}`;
    }
  }

  let finalPrompt = '';
  if (isSlashCommand) {
    finalPrompt = rawMsg;
  } else if (!isOrchTarget && targetAgent) {
    finalPrompt = prompt + `\n\n${buildWorkerPrompt(targetAgent.role, targetAgent, !targetAgent.sessionId || shouldReinject)}`;
  } else {
    finalPrompt = prompt + ((client.getSessionId() && !shouldReinject) ? '' : `\n\n${ORCH_REMINDER}`);
  }

  // Luôn xếp hàng đợi và thực thi qua client.enqueue() để đảm bảo lượt tương tác
  // luôn sinh phản hồi, stream realtime và trả về kết quả đầy đủ cho User.
  const result = await client.enqueue(finalPrompt);
  sid = client.getSessionId();
  if (sid) {
    if (!isOrchTarget && targetAgent) {
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
      let orchAgent = agents.get(orchId);
      if (!orchAgent && orchId !== 'orchestrator') {
        const existing = targetAgent?.teamId ? findExistingOrchestrator(targetAgent.teamId) : undefined;
        orchAgent = (existing && existing.id === orchId) ? existing : ((targetAgent as Agent | null) || { id: orchId, name: agentName, role: 'orchestrator', type: 'orchestrator', status: 'working', createdAt: Date.now(), teamId: (targetAgent as Agent | null)?.teamId });
        if (!agents.has(orchId)) {
          agents.set(orchId, orchAgent);
        }
      }
      if (orchAgent) {
        const isNewSession = orchAgent.sessionId !== sid;
        orchAgent.sessionId = sid;
        if (result.tokenUsage) {
          orchAgent.tokenUsage = result.tokenUsage;
        }
        if (result.contextLength) orchAgent.contextLength = result.contextLength;
        storage.updateAgent(orchId, {
          sessionId: sid,
          tokenUsage: orchAgent.tokenUsage,
          contextLength: orchAgent.contextLength
        });
        if (isNewSession || !orchAgent.sessionTitle) {
          syncSessionTitle(orchAgent, client, 1, isNewSession).catch(() => {});
        }
      }
      ACPClient.registerSession(orchId, sid);
    }
  }

  const response = result.content;
  if (!isOrchTarget && targetAgent) {
    if (isSlashCommand) {
      let chatContent = response;
      let isInternal = false;
      const reply: ChatMsg = {
        id: uuidv4(),
        from: targetAgent.id,
        to: 'user',
        content: chatContent,
        msgType: isInternal ? 'orchestrator_internal' : undefined,
        showOnUI: !isInternal,
        timestamp: Date.now(),
        agentName: targetAgent.name,
        agentRole: targetAgent.role,
        teamId: targetAgent.teamId || 'default'
      };
      if (!isBroadcastDuplicate(broadcastDedupKey(reply))) {
        chatHistory.push(reply);
        storage.saveMessage(reply);
        broadcast('chat:message', { msg: reply });
      }
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
        let chatContent = response;
        let isInternal = false;
        const reply: ChatMsg = {
          id: uuidv4(),
          from: targetAgent.id,
          to: 'user',
          content: chatContent,
          msgType: isInternal ? 'orchestrator_internal' : undefined,
          showOnUI: !isInternal,
          timestamp: Date.now(),
          agentName: targetAgent.name,
          agentRole: targetAgent.role,
          teamId: targetAgent.teamId || 'default'
        };
        if (!isBroadcastDuplicate(broadcastDedupKey(reply))) {
          chatHistory.push(reply);
          storage.saveMessage(reply);
          broadcast('chat:message', { msg: reply });
        }

        // AUTO-WAKE ORCHESTRATOR: worker 1-1 vừa xong việc kèm báo cáo (mọi biến thể)
        // → đánh thức Orchestrator phân tích & tổng hợp trả lời cho user ngay lập tức.
        if (REPORT_BLOCK_RE.test(response) || TASK_COMPLETE_RE.test(response)) {
          const clean = extractCleanTaskReport(stripToolNoiseForOrchestrator(response));
          await triggerOrchestrator(targetAgent, clean);
        }
      }
      saveTranscript(result, targetAgent.id, targetAgent.name, targetAgent.role);
      const validation = validateWorkerCompletion(result.content, targetAgent);
      if (!validation.valid && !isEmptyAgentOutput(result.content)) {
        console.log(`[Chat] Agent ${targetAgent.name} completion format invalid: ${validation.reason}`);
        const orchAgent = agents.get('orchestrator') || (storage.getAgent('orchestrator') as any);
        if (orchAgent && targetAgent.id !== 'orchestrator') {
          const feedbackMsg = buildFormatFeedbackPrompt(validation.reason || 'Báo cáo chưa đúng định dạng', targetAgent);
          deliverTalk(targetAgent, orchAgent, { to: targetAgent.id, message: feedbackMsg }).catch(err => {
            console.error(`[Feedback] Failed to deliver format feedback to ${targetAgent.name}:`, err.message);
          });
        }
      }
      clearAgentRetry(targetAgent.id);
    }
    targetAgent.status = 'idle'; targetAgent.workingSince = undefined;
    storage.updateAgent(targetAgent.id, { status: 'idle', sessionId: targetAgent.sessionId, workingSince: null });
    broadcast('agent:updated', { agent: targetAgent });
    storage.clearUnprocessedMessages(targetKey);
    processNextBackendUserQueue(targetAgent.id);
  } else {
    if (isSlashCommand) {
      const stripped = stripCommandTags(response).trim();
      const isInternal = !stripped;
      const aMsg: ChatMsg = {
        id: uuidv4(),
        from: orchId,
        to: 'user',
        content: stripped,
        timestamp: Date.now(),
        agentName,
        agentRole,
        msgType: isInternal ? 'orchestrator_internal' : undefined,
        showOnUI: !isInternal,
        teamId: agents.get(orchId)?.teamId || 'default',
        ...(result.thinking ? { thinking: result.thinking } : {})
      };
      if (!isBroadcastDuplicate(broadcastDedupKey(aMsg))) {
        chatHistory.push(aMsg);
        storage.saveMessage(aMsg);
        broadcast('chat:message', { msg: aMsg });
      }
    } else {
      // SỬA THỨ TỰ HIỂN THỊ: bóc nội dung user-facing TRƯỚC rồi push/broadcast aMsg text→user
      // LÊN TRƯỚC, SAU ĐÓ mới chạy handleOrchestratorResponse (push spawn/talk msg → agent vào history).
      // Trước đây handleOrchestratorResponse chạy trước → UI hiện task-card (talk) trước text, ngược
      // logic. Giờ thứ tự persist: [text-user, talk-a, talk-b, ...] — text hiện lên trước.
      // stripped/toolCalls/thinking độc lập với kết quả của handleOrchestratorResponse nên an toàn.
      const stripped = stripCommandTags(response).trim();
      const isInternal = !stripped;
      const aMsg: ChatMsg = {
        id: uuidv4(), from: orchId, to: 'user', content: stripped,
        timestamp: Date.now(), agentName, agentRole,
        msgType: isInternal ? 'orchestrator_internal' : undefined,
        showOnUI: !isInternal,
        teamId: agents.get(orchId)?.teamId || 'default',
        ...(result.toolCalls && result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
        ...(result.thinking ? { thinking: result.thinking } : {})
      };
      if (!isBroadcastDuplicate(broadcastDedupKey(aMsg))) {
        chatHistory.push(aMsg); storage.saveMessage(aMsg);
        broadcast('chat:message', { msg: aMsg });
      }
      // Chạy sau khi đã persist/broadcast text-user để các spawn/talk msg đứng sau text.
      const commandResultsParse = await handleOrchestratorResponse(response, result.thinking || '', orchId);
      commandResults.push(...commandResultsParse);
    }
    // Drain buffer stream của orchestrator — turn đã kết thúc.
    drainDispatchState(orchId);
    updateOrchStateSafe(orchId, 'idle', 'Sẵn sàng');
    storage.clearUnprocessedMessages(targetKey);
    processNextBackendUserQueue('orchestrator');

    // Nếu có worker reports đang đợi trong pendingOrchTriggers, kích hoạt xử lý ngay lập tức
    if (pendingOrchTriggers.length > 0) {
      if (orchTriggerDebounceTimer) clearTimeout(orchTriggerDebounceTimer);
      orchTriggerDebounceTimer = null;
      setImmediate(processOrchestratorTriggerQueue);
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
      // Validate trước replay: bỏ qua item thiếu message/target (tránh replay mồ côi).
      if (!item.rawMsg || !item.rawMsg.trim() || !item.targetAgentId) {
        console.log(`[QueueGuard] Drop chat-retry ${item.id} (thiếu rawMsg/targetAgentId).`);
        storage.removeChatQueueItem(item.id);
        continue;
      }
      // Agent đích đã bị xóa → drop khỏi queue, báo lỗi user (tránh misroute sang Orchestrator)
      if (item.targetAgentId && item.targetAgentId !== 'orchestrator' && !agents.has(item.targetAgentId) && !findAgentByIdNameOrRole(item.targetAgentId)) {
        const errMsg: ChatMsg = createChatMsg('user', 'system',
          `❌ Không thể gửi lại tin nhắn: agent đích "${item.targetAgentId}" không còn tồn tại.\n"${item.rawMsg.slice(0, 100)}"`,
          { agentName: 'System', agentRole: 'system', msgType: 'error', teamId: agents.get(item.targetAgentId)?.teamId });
        chatHistory.push(errMsg); storage.saveMessage(errMsg);
        broadcast('chat:message', { msg: errMsg });
        storage.removeChatQueueItem(item.id);
        continue;
      }
      try {
        await dispatchUserChat({ targetAgentId: item.targetAgentId, rawMsg: item.rawMsg, isSlashCommand: item.isSlashCommand, isRetry: true });
        storage.removeChatQueueItem(item.id);
        const okMsg: ChatMsg = createChatMsg('user', 'system',
          `✅ Đã gửi lại tin nhắn thành công khi backend sẵn sàng: "${item.rawMsg.slice(0, 80)}${item.rawMsg.length > 80 ? '...' : ''}"`,
          { agentName: 'System', agentRole: 'system', teamId: agents.get(item.targetAgentId)?.teamId });
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
          const errMsg: ChatMsg = createChatMsg('user', 'system',
            `❌ Không thể gửi lại tin nhắn (lỗi vĩnh viễn): ${e?.message || e}\n"${item.rawMsg.slice(0, 100)}"`,
            { agentName: 'System', agentRole: 'system', msgType: 'error', teamId: agents.get(item.targetAgentId)?.teamId });
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

// ============ OUTBOX ACK-BASED RETRY QUEUE ============
// Vòng quét định kỳ nhặt các record outbox status='pending'/'failed' (tới hạn nextAttemptAt)
// hoặc 'in_flight' treo (quá timeout) để gửi lại. Không phụ thuộc restart server.
const OUTBOX_RETRY_INTERVAL = 15000; // 15s
let outboxRetryTimer: any = null;
let outboxRetryRunning = false;
// Anti-spam log: chỉ log lại khi bộ nhận dạng các record cần retry THAY ĐỔI so lần trước
// (tránh log "[Outbox] Retry queue: N..." lặp vô nghĩa mỗi 15s khi record kẹt vĩnh viễn).
let outboxLastLoggedSignature = '';

const DISABLE_OUTBOX_RETRY = true;

async function processOutboxRetryQueue() {
  if (DISABLE_OUTBOX_RETRY) return;
  if (outboxRetryRunning) return;
  outboxRetryRunning = true;
  try {
    const pending = storage.getOutboxForRetry?.() || storage.getPendingOutbox();
    if (!pending || pending.length === 0) return;
    // Signature = danh sách id + trạng thái: chỉ log khi thay đổi
    const sig = pending.map(r => `${r.id}:${r.status}:${r.attempts}`).join('|');
    if (sig !== outboxLastLoggedSignature) {
      console.log(`[Outbox] Retry queue: ${pending.length} pending/failed/in_flight record(s) to retry`);
      outboxLastLoggedSignature = sig;
    }
    try { await replayPendingReports(); } catch (e: any) { console.error(`[Outbox] retry failed: ${e.message}`); }
  } finally { outboxRetryRunning = false; }
}

function scheduleOutboxRetry() {
  if (DISABLE_OUTBOX_RETRY) {
    console.log('[Outbox] Retry system is TEMPORARILY DISABLED as requested');
    return;
  }
  if (outboxRetryTimer) return;
  outboxRetryTimer = setInterval(processOutboxRetryQueue, OUTBOX_RETRY_INTERVAL);
  outboxRetryTimer.unref?.();
}

// Pha 1: POST /api/chat sống trong src/routes/chat.ts

// Pha 1: POST /api/chat/force-send sống trong src/routes/chat.ts

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

// Pha 1: GET /api/history + /api/messages sống trong src/routes/chat.ts

// Pha 1: POST /api/orchestrator/model + /api/orchestrator/clear sống trong src/routes/orchestrator.ts

// Pha 1: POST /api/agents/:id/clear sống trong src/routes/agents.ts;
// POST /api/restart sống trong src/routes/system.ts

// Pha 1: GET /logs + /terminal sống trong src/routes/terminal.ts (mount tại app root,
// đặt TRƯỚC static serving để không bị nuốt bởi /v2).

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

// Mặc định mở React UI đầy đủ: redirect / → /v2 (user muốn mở mặc định thấy giao diện đầy đủ).
app.get('/', (_req, res) => {
  res.redirect(302, '/v2');
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

  const clientTeamId = req.query.teamId as string | undefined;
  if (clientTeamId) {
    (res as any).teamId = clientTeamId;
  }

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
  wsManager.stopHeartbeat();

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
// Auto Continue: sau khi replay outbox, quét các agent còn kẹt status='working' (đã giữ lại ở loadState
// nhờ autoContinue) rồi gửi dấu '.' qua deliverTalk để agent tiếp tục task dở — không cần user thao tác lại.
async function autoResumeWorkingAgents() {
  try {
    if (storage.getSetting('autoContinue', false) !== true) return;
    const orchAgent = agents.get('orchestrator') || (storage.getAgent('orchestrator') as any);
    if (!orchAgent) return;
    const now = Date.now();

    // 1. Resume Main Orchestrator if it was working
    if (orchAgent.status === 'working') {
      if (typeof orchAgent.workingSince === 'number' && now - orchAgent.workingSince > AUTO_RESUME_MAX_STALE_MS) {
        console.log(`[AutoContinue] Bỏ qua Orchestrator: workingSince quá lâu (${Math.round((now - orchAgent.workingSince) / 1000)}s) → reset idle.`);
        orchAgent.status = 'idle';
        orchAgent.workingSince = undefined;
        storage.updateAgent(orchAgent.id, { status: 'idle', workingSince: null } as any);
        broadcast('agent:updated', { agent: orchAgent });
      } else {
        console.log(`[AutoContinue] Resuming Main Orchestrator session...`);
        const orchClient = getOrchClient('orchestrator');
        const team = buildTeam('orchestrator');
        const prompt = `[TEAM]\n${team}\n[/TEAM]\n\n=== RESUME WORK ===\n.\n\n${ORCH_REMINDER}`;
        orchClient.enqueue(prompt).then(async (result) => {
          const sid = orchClient.getSessionId();
          if (sid) {
            orchAgent.sessionId = sid;
            ACPClient.registerSession('orchestrator', sid);
          }
          if (result.tokenUsage) orchAgent.tokenUsage = result.tokenUsage;
          if (result.contextLength) orchAgent.contextLength = result.contextLength;
          orchAgent.status = 'idle';
          orchAgent.workingSince = undefined;
          storage.updateAgent('orchestrator', {
            status: 'idle',
            workingSince: null,
            sessionId: orchAgent.sessionId,
            tokenUsage: orchAgent.tokenUsage,
            contextLength: orchAgent.contextLength
          });
          broadcast('agent:updated', { agent: orchAgent });
await handleOrchestratorResponse(result.content, (result as any).thinking || '');
        }).catch((err) => {
          console.error(`[AutoContinue] Failed to resume Orchestrator: ${err.message}`);
          orchAgent.status = 'idle';
          orchAgent.workingSince = undefined;
          storage.updateAgent('orchestrator', { status: 'idle', workingSince: null } as any);
          broadcast('agent:updated', { agent: orchAgent });
        });
      }
    }

    // 2. Resume Worker Agents
    const stuck: Agent[] = [];
    for (const a of agents.values()) {
      if (a.id === 'orchestrator') continue;
      if (a.status !== 'working' || !a.task || String(a.task).trim() === '') continue;
      // Fix 6.42: agent có workingSince quá lâu (>10 phút) khi restart → coi là kẹt do crash/restart
      // trước đó, reset về idle + bỏ task cũ, KHÔNG auto-resume (tránh ép chạy lại task vô nghĩa).
      if (typeof a.workingSince === 'number' && now - a.workingSince > AUTO_RESUME_MAX_STALE_MS) {
        console.log(`[AutoContinue] Bỏ qua ${a.name} (${a.id}): workingSince quá lâu (${Math.round((now - a.workingSince) / 1000)}s) → reset idle, không resume task cũ.`);
        a.status = 'idle';
        a.workingSince = undefined;
        a.task = undefined;
        storage.updateAgent(a.id, { status: 'idle', workingSince: null } as any);
        broadcast('agent:updated', { agent: a });
        continue;
      }
      stuck.push(a);
    }
    if (stuck.length === 0) {
      console.log('[AutoContinue] No stuck working worker agent to resume.');
      return;
    }
    console.log(`[AutoContinue] Resuming ${stuck.length} working agent(s): ${stuck.map(a => a.name).join(', ')}`);
    for (const a of stuck) {
      try {
        await deliverTalk(a, orchAgent, { to: a.id, message: '.', task: a.task });
        console.log(`[AutoContinue] Pinged ${a.name} (${a.id}) to continue task.`);
      } catch (e: any) {
        console.error(`[AutoContinue] Failed to ping ${a.name}: ${e.message}`);
      }
    }
  } catch (e: any) {
    console.error(`[AutoContinue] autoResumeWorkingAgents error: ${e.message}`);
  }
}

async function replayPendingReports() {
  if (DISABLE_OUTBOX_RETRY) return;
  // Sử dụng getOutboxForRetry() để bao gồm cả: pending (chưa gửi), failed (tới hạn retry),
  // và in_flight treo (quá timeout) — hỗ trợ vòng quét định kỳ scheduleOutboxRetry().
  const pending = storage.getOutboxForRetry?.() || storage.getPendingOutbox();
  if (pending.length === 0) return;
  // Idempotent Replay: loại bỏ các report đã được phát trong memory lifecycle hiện tại
  const unplayed = pending.filter(r => !deliveredReportIds.has(r.id));
  if (unplayed.length === 0) { storage.pruneDeliveredOutbox(); return; }

  // Dedup mới-nhất-per-target: Nếu có nhiều pending record gửi tới cùng 1 target, chỉ giữ lại bản ghi mới nhất đại diện cho trạng thái hiện tại
  const newestPerTarget = new Map<string, number>();
  for (const r of unplayed) {
    const cur = newestPerTarget.get(r.to) || 0;
    if (r.createdAt > cur) newestPerTarget.set(r.to, r.createdAt);
  }
  const superseded = unplayed.filter(r => r.to !== 'orchestrator' && r.createdAt < (newestPerTarget.get(r.to) || 0));
  for (const r of superseded) {
    console.log(`[Outbox] Bỏ qua ${r.id} (đã có tin mới hơn cho ${r.to}) → delivered.`);
    deliveredReportIds.add(r.id);
    storage.markOutboxDelivered(r.id);
  }
  const finalReplay = unplayed.filter(r => r.to === 'orchestrator' || r.createdAt === (newestPerTarget.get(r.to) || r.createdAt));
  if (finalReplay.length === 0) { storage.pruneDeliveredOutbox(); return; }
  console.log(`[Outbox] Replaying ${finalReplay.length} pending report(s) from DB...`);
  storage.resetOutboxAttempts(finalReplay.map(r => r.id));
  for (const r of finalReplay) {
    if (deliveredReportIds.has(r.id)) continue;
    // Validate trước replay: bỏ qua record thiếu message/target (tránh replay mồ côi).
    if (!r.message || !r.message.trim() || !r.to) {
      console.log(`[QueueGuard] Bỏ qua outbox ${r.id} (thiếu message/to) → delivered.`);
      deliveredReportIds.add(r.id);
      storage.markOutboxDelivered(r.id);
      continue;
    }
    // ACK-based: đánh dấu in_flight TRƯỚC khi bắt đầu giao tin. Delivered CHỈ đặt sau khi
    // enqueue thành công — do chính triggerOrchestrator (processOrchestratorTriggerQueue) /
    // deliverTalk xử lý (markOutboxDelivered sau ACK, markOutboxFailed khi lỗi). Việc mark
    // delivered sớm tại đây (deliveredReportIds.add) sẽ LÀM MẤT report nếu enqueue thất bại
    // giữa chừng → vòng quét định kỳ không nhặt lại được → log spam vô hạn.
    // deliveredReportIds.add(r.id) CHỈ gọi SAU KHI record đã thực sự 'delivered'.
    storage.markOutboxInFlight(r.id);

    const fromAgent = (agents.get(r.fromAgentId) || {
      id: r.fromAgentId, name: r.fromAgentName, role: r.fromAgentRole
    }) as Agent;
    try {
      if (r.to === 'orchestrator') {
        await triggerOrchestrator(fromAgent, r.message, r.id);
      } else {
        const target = agents.get(r.to) || findAgentByIdNameOrRole(r.to, r.teamId || fromAgent?.teamId);
        if (target) {
          await deliverTalk(target, fromAgent, { to: r.to, message: r.message }, r.id);
        } else {
          // Target không tồn tại → không thể giao → đánh dấu delivered để tránh kẹt vĩnh viễn
          console.log(`[Outbox] Target ${r.to} không tồn tại, đánh dấu delivered cho ${r.id}`);
          storage.markOutboxDelivered(r.id);
        }
      }
      // Chỉ thêm vào deliveredReportIds khi record đã thực sự 'delivered' (ACK thành công)
      const rec = storage.getOutboxRecord(r.id);
      if (rec && rec.status === 'delivered') {
        deliveredReportIds.add(r.id);
      }
    } catch (e: any) {
      // Giao thất bại → KHÔNG thêm deliveredReportIds → vòng quét retry lại được
      console.log(`[Outbox] Replay delivery failed for ${r.id}: ${e?.message || e}`);
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
      // Replay tin nhắn người dùng chưa xử lý được lưu trên đĩa (sống sót qua crash/restart)
      try {
        const unprocessedAll = storage.getAllUnprocessedMessages();
        for (const [targetKey, msgs] of Object.entries(unprocessedAll)) {
          if (Array.isArray(msgs) && msgs.length > 0) {
            if (!backendUserQueues[targetKey]) {
              backendUserQueues[targetKey] = [];
            }
            for (const m of msgs) {
              // Validate trước restore: bỏ qua entry thiếu nội dung/target (giữ auto-continue
              // cho mọi message hợp lệ: Restored → Auto-dispatching cho agent working).
              if (!m || !m.trim() || !targetKey) {
                console.log(`[QueueGuard] Bỏ qua restore entry rỗng cho target ${targetKey}.`);
                continue;
              }
              if (typeof m === 'string' && (m.trim().startsWith('[TEAM]') || m.includes('Your ID:'))) {
                console.log(`[BackendQueue] Bỏ qua remnant team table cũ cho target ${targetKey}`);
                continue;
              }
              // Tránh trùng lặp nếu đã có trong memory
              if (!backendUserQueues[targetKey].some(item => item.rawMsg === m)) {
                backendUserQueues[targetKey].push({
                  targetId: targetKey,
                  rawMsg: m,
                  isSlash: m.startsWith('/'),
                  timestamp: Date.now()
                });
              }
            }
            console.log(`[BackendQueue] Restored ${msgs.length} unprocessed messages from disk for target ${targetKey}.`);
            processNextBackendUserQueue(targetKey);
          }
        }
      } catch (e: any) {
        console.error(`[BackendQueue] Restore unprocessed messages failed: ${e.message}`);
      }

      replayPendingReports().catch(e => console.error(`[Outbox] Replay failed: ${e.message}`));
      autoResumeWorkingAgents().catch(e => console.error(`[AutoContinue] Resume failed: ${e.message}`));
      processChatRetryQueue().catch(e => console.error(`[ChatQueue] Replay failed: ${e.message}`));
      scheduleChatRetry();
      // ACK-based: vòng quét định kỳ retry các report failed/in_flight treo khi mạng khôi phục
      scheduleOutboxRetry();
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
    // Lỗi runtime toàn cục: không có team context → createChatMsg giữ teamId undefined trung thực.
    const errMsg: ChatMsg = createChatMsg('user', 'system',
      `❌ ${kind}: ${msg}${tail ? `\n↳ ${tail}` : ''}`,
      { agentName: 'System', agentRole: 'system', msgType: 'error' });
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

// Khởi động: dò port trống chủ động từ PORT (mặc định 4001) rồi mới bind;
// startServerWithPortFallback vẫn là lớp phòng thủ EADDRINUSE nếu port bị chiếm sau lúc dò.
findAvailablePort(PORT).then((freePort) => {
  if (freePort !== PORT) {
    console.warn(`[Server] Port ${PORT} bận → dùng port trống kế tiếp ${freePort}`);
  }
  startServerWithPortFallback(freePort);
});
