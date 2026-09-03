// SQLite Storage — persist agents + chat history
import Database from 'better-sqlite3';
import { join } from 'path';

const DB_PATH = join(process.cwd(), 'data', 'agentforge.db');

// Ensure data dir exists
import { mkdirSync } from 'fs';
mkdirSync(join(process.cwd(), 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safe for crashes
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'coder',
    type TEXT NOT NULL DEFAULT 'worker',
    status TEXT NOT NULL DEFAULT 'idle',
    spawned_by TEXT,
    project_dir TEXT,
    session_id TEXT,
    session_title TEXT,
    model TEXT,
    task TEXT,
    created_at INTEGER NOT NULL,
    working_since INTEGER
  );

  CREATE TABLE IF NOT EXISTS chat_history (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    agent_name TEXT,
    agent_role TEXT,
    msg_type TEXT DEFAULT 'chat'
  );

  CREATE INDEX IF NOT EXISTS idx_chat_to ON chat_history(to_id);
  CREATE INDEX IF NOT EXISTS idx_chat_from ON chat_history(from_id);
  CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat_history(timestamp);
  CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_history(from_id, to_id, timestamp);
`);

// WAL checkpoint định kỳ — tránh WAL file phình to vô hạn
setInterval(() => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
}, 5 * 60 * 1000); // mỗi 5 phút

// Migration: thêm cột mới cho bảng đã tồn tại (CREATE TABLE IF NOT EXISTS không tự thêm cột)
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[Storage] Migrated: added ${column} to ${table}`);
  }
}
ensureColumn('agents', 'session_title', 'session_title TEXT');
ensureColumn('agents', 'model', 'model TEXT');

// Prepared statements
const insertAgent = db.prepare(`
  INSERT OR REPLACE INTO agents (id, name, role, type, status, spawned_by, project_dir, session_id, session_title, model, task, created_at, working_since)
  VALUES (@id, @name, @role, @type, @status, @spawnedBy, @projectDir, @sessionId, @sessionTitle, @model, @task, @createdAt, @workingSince)
`);

const updateAgent = db.prepare(`
  UPDATE agents SET status = @status, session_id = @sessionId, session_title = @sessionTitle, model = @model, working_since = @workingSince WHERE id = @id
`);

const deleteAgent = db.prepare(`DELETE FROM agents WHERE id = ?`);
const getAllAgents = db.prepare(`SELECT * FROM agents ORDER BY created_at ASC`);
const getAgent = db.prepare(`SELECT * FROM agents WHERE id = ?`);

const insertMessage = db.prepare(`
  INSERT INTO chat_history (id, from_id, to_id, content, timestamp, agent_name, agent_role, msg_type)
  VALUES (@id, @fromId, @toId, @content, @timestamp, @agentName, @agentRole, @msgType)
`);

const getHistory = db.prepare(`SELECT * FROM chat_history ORDER BY timestamp ASC LIMIT ?`);
const getHistoryByAgent = db.prepare(`
  SELECT * FROM chat_history WHERE from_id = ? OR to_id = ? ORDER BY timestamp ASC LIMIT ?
`);

// Public API
export const storage = {
  // Agent CRUD
  saveAgent(agent: any) {
    insertAgent.run({
      id: agent.id, name: agent.name, role: agent.role, type: agent.type,
      status: agent.status, spawnedBy: agent.spawnedBy || null,
      projectDir: agent.projectDir || null, sessionId: agent.sessionId || null,
      sessionTitle: agent.sessionTitle || null, model: agent.model || null,
      task: agent.task || null, createdAt: agent.createdAt, workingSince: agent.workingSince || null
    });
  },

  updateAgent(id: string, updates: { status?: string; sessionId?: string; sessionTitle?: string; model?: string | null; workingSince?: number | null }) {
    const agent = getAgent.get(id) as any;
    if (!agent) return;
    updateAgent.run({
      id,
      status: updates.status ?? agent.status,
      sessionId: updates.sessionId ?? agent.session_id,
      sessionTitle: updates.sessionTitle ?? agent.session_title,
      model: updates.model !== undefined ? updates.model : agent.model,
      workingSince: updates.workingSince !== undefined ? updates.workingSince : agent.working_since
    });
  },

  deleteAgent(id: string) { deleteAgent.run(id); },
  getAllAgents() { return getAllAgents.all(); },
  getAgent(id: string) { return getAgent.get(id); },

  // Chat history
  saveMessage(msg: any) {
    insertMessage.run({
      id: msg.id, fromId: msg.from, toId: msg.to, content: msg.content,
      timestamp: msg.timestamp, agentName: msg.agentName || null,
      agentRole: msg.agentRole || null, msgType: msg.msgType || 'chat'
    });
  },

  getHistory(limit = 200) { return getHistory.all(limit); },
  getHistoryByAgent(agentId: string, limit = 100) { return getHistoryByAgent.all(agentId, agentId, limit); },

  // Xoá hội thoại MAIN view: mọi msg có liên quan tới orchestrator (from/to).
  // Giữ hội thoại riêng của agents (user↔agent, agent→user, agent↔agent) để không mất lịch sử làm việc.
  clearOrchestratorConversation() {
    db.prepare(`DELETE FROM chat_history WHERE to_id = 'orchestrator' OR from_id = 'orchestrator'`).run();
  },

  // Update agent model
  updateAgentModel(id: string, model: string | null) {
    const agent = getAgent.get(id) as any;
    if (!agent) return false;
    updateAgent.run({
      id,
      status: agent.status,
      sessionId: agent.session_id,
      sessionTitle: agent.session_title,
      model: model,
      workingSince: agent.working_since
    });
    return true;
  },

  // Load state on startup
  loadAgents(): any[] { return getAllAgents.all(); },
  loadHistory(limit = 200): any[] { return getHistory.all(limit); },

  close() { db.close(); }
};
