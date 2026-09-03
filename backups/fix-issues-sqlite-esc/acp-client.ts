// ACP Client — OpenCode CLI async with temp file for long prompts
import { exec, spawn, execSync } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentConfig, AgentMessage } from './types.js';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
// Timeout mỗi lượt opencode run (ms) — tránh treo vô hạn khi model/API kẹt
const RUN_TIMEOUT_MS = parseInt(process.env.AGENTFORGE_RUN_TIMEOUT || '300000', 10);
// Giới hạn hàng đợi tin nhắn chờ xử lý cho 1 agent — chống phình bộ nhớ
const MAX_PENDING = 20;

export class ACPClient {
  // Shared map across all instances: agentId → sessionId
  // Prevents session cross-contamination when multiple agents spawn simultaneously
  private static agentSessions = new Map<string, string>();

  private config: AgentConfig;
  private sessionId: string | null = null;
  private proc: ReturnType<typeof spawn> | null = null;
  private busy = false;
  private pending: Array<{ prompt: string; resolve: (m: AgentMessage) => void; reject: (e: any) => void }> = [];

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** Register an agent→session mapping (shared across all ACPClient instances) */
  static registerSession(agentId: string, sessionId: string) {
    ACPClient.agentSessions.set(agentId, sessionId);
  }

  /** Unregister an agent's session (e.g. on delete) */
  static unregisterSession(agentId: string) {
    ACPClient.agentSessions.delete(agentId);
  }

  /** Restore the shared agentSessions map from saved DB data */
  static restoreAgentSessions(entries: Array<{ agentId: string; sessionId: string }>) {
    ACPClient.agentSessions.clear();
    for (const e of entries) {
      if (e.agentId && e.sessionId) {
        ACPClient.agentSessions.set(e.agentId, e.sessionId);
      }
    }
  }

  /** Get all session IDs claimed by OTHER agents (used for filtering) */
  private static getOtherAgentSessions(currentAgentId: string): Set<string> {
    const other = new Set<string>();
    for (const [agentId, sid] of ACPClient.agentSessions) {
      if (agentId !== currentAgentId && sid) other.add(sid);
    }
    return other;
  }

  isBusy(): boolean { return this.busy; }
  queueLength(): number { return this.pending.length; }

  /** Cập nhật model cho client đang tồn tại — KHÔNG reset session, đổi model áp dụng cho session này */
  setModel(model?: string) { this.config.model = model; }

  /** Hủy process opencode đang chạy (dùng khi chat bị treo) */
  abort(): boolean {
    if (this.proc && !this.proc.killed) {
      try {
        if (isWin) {
          // Windows: kill toàn bộ process tree (cmd.exe + grandchild opencode)
          execSync(`taskkill /F /T /PID ${this.proc.pid}`, { timeout: 5000, stdio: 'ignore' });
        } else {
          // Linux/Mac: kill整个 process group (negative PID)
          process.kill(-this.proc.pid!, 'SIGTERM');
        }
      } catch {
        // Fallback: traditional kill nếu taskkill fail
        try { this.proc.kill('SIGKILL'); } catch {}
      }
      this._aborted = true;
      return true;
    }
    return false;
  }
  private _aborted = false;

  /**
   * Gửi prompt qua hàng đợi: nếu agent đang bận, tin được xếp lại
   * và tự động gửi ngay khi lượt hiện tại (và các tin trước đó) hoàn tất.
   * Giới hạn queue để tránh memory leak khi agent bị kẹt.
   */
  async enqueue(prompt: string): Promise<AgentMessage> {
    if (!this.busy && this.pending.length === 0) {
      return this.runQueued(prompt);
    }
    // Queue tối đa 20 tin — nếu vượt, từ chối tin mới (tránh phình vô hạn)
    if (this.pending.length >= MAX_PENDING) {
      return Promise.reject(new Error('Queue full — agent is stuck or overloaded. Try again later.'));
    }
    return new Promise<AgentMessage>((resolve, reject) => {
      this.pending.push({ prompt, resolve, reject });
    });
  }

  private async runQueued(prompt: string): Promise<AgentMessage> {
    this.busy = true;
    try {
      return await this.chat(prompt);
    } finally {
      this.busy = false;
      const next = this.pending.shift();
      if (next) {
        this.runQueued(next.prompt).then(next.resolve).catch(next.reject);
      }
    }
  }

  async chat(prompt: string): Promise<AgentMessage> {
    return this.chatWithRetry(prompt, 0);
  }

  private async chatWithRetry(prompt: string, attempt: number): Promise<AgentMessage> {
    const projectDir = this.config.projectDir || process.cwd();

    // Fetch sessions ONCE — reused for count + fallback session detection
    const beforeSessions = await this.fetchSessions();
    const beforeCount = beforeSessions.length;

    // Write prompt to temp file to avoid shell escaping issues
    const tmpFile = join(tmpdir(), `agentforge-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(tmpFile, prompt, 'utf-8');

    // Build command — use stdin pipe via cat instead of inline args
    let agentFlag = '';
    if (!this.sessionId) {
      const roleToAgent: Record<string, string> = {
        coder: 'coder', reviewer: 'reviewer', tester: 'tester',
        docs: 'docs', planner: 'planner', orchestrator: 'orchestrator',
        researcher: 'researcher', verifier: 'verifier', debugger: 'debugger', searcher: 'searcher',
        idea: 'idea'
      };
      // Custom roles: check if .opencode/agents/<role>.md exists, use role name directly
      const agentName = roleToAgent[this.config.role] || this.config.role;
      agentFlag = ` --agent ${agentName}`;
    } else {
      agentFlag = ` --session "${this.sessionId}"`;
    }

    // Model override hoặc fallback model
    let modelToUse = this.config.model;
    if (attempt > 0 && process.env.FALLBACK_MODEL) {
      console.log(`[ACP] Attempt ${attempt}: Using fallback model: ${process.env.FALLBACK_MODEL}`);
      modelToUse = process.env.FALLBACK_MODEL;
    }
    if (modelToUse) {
      agentFlag += ` --model "${modelToUse}"`;
    }

    // Use type (Windows) or cat (Linux/Mac) to pipe file content
    const readCmd = isWin ? 'type' : 'cat';

    try {
      // exec xử lý shell đúng trên Windows (cmd) với pipe, tránh lỗi lồng dấu ngoặc khi spawn cmd /c
      const cmd = `${readCmd} "${tmpFile}" | opencode run --auto --format json${agentFlag}`;
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      Object.keys(childEnv).forEach(k => { if (/^OPENCODE_?/i.test(k)) delete childEnv[k]; });
      const stdout = await new Promise<string>((resolve, reject) => {
        const proc = exec(cmd, { cwd: projectDir, maxBuffer: 10 * 1024 * 1024, env: childEnv, encoding: 'utf-8', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
          this.proc = null;
          if (error) {
            // Timeout: cmd.exe bị kill nhưng con cháu (opencode.exe) có thể còn sống → dọn cả cây
            if ((error as any).killed || (error as any).signal === 'SIGKILL') {
              try {
                if (isWin && proc.pid) {
                  execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000, stdio: 'ignore' });
                }
              } catch {}
            }
            const e: any = new Error(`Command failed (${error.code ?? 1}): ${stderr?.toString().trim() || stdout?.toString().trim() || error.message}`);
            e.stdout = stdout; e.stderr = stderr; e.code = error.code;
            reject(e);
          } else {
            resolve(stdout);
          }
        });
        this.proc = proc;
      });
      this._aborted = false;

      const { content, transcript, sessionId } = this.parseJsonlEvents(stdout);

      // Session từ event chính xác hơn so sánh danh sách
      if (!this.sessionId && sessionId) {
        this.sessionId = sessionId;
        ACPClient.registerSession(this.config.id, sessionId);
        console.log(`[ACP] New session: ${sessionId} (agent: ${this.config.role})`);
      } else if (!this.sessionId) {
        this.sessionId = this.findSessionFromList(beforeSessions, beforeCount);
        if (this.sessionId) {
          ACPClient.registerSession(this.config.id, this.sessionId);
          console.log(`[ACP] New session (fallback): ${this.sessionId} (agent: ${this.config.role})`);
        }
      }

      return {
        id: uuidv4(),
        from: this.config.id,
        to: 'orchestrator',
        content: content || '(No response)',
        timestamp: Date.now(),
        transcript: transcript || undefined
      };
    } catch (err: any) {
      // Nếu bị abort → trả message stopped, KHÔNG retry
      if (this._aborted) {
        return {
          id: uuidv4(),
          from: this.config.id,
          to: 'orchestrator',
          content: '[STOPPED] Agent was stopped by user.',
          timestamp: Date.now(),
        };
      }

      // Self-heal: session cũ đã bị xóa/chết trên opencode → bỏ sessionId, retry tạo mới
      const errText = `${err.message || ''} ${err.stdout?.toString() || ''} ${err.stderr?.toString() || ''}`;
      if (/Session not found/i.test(errText) && this.sessionId) {
        console.log(`[ACP] Session ${this.sessionId} not found — resetting, retrying with new session`);
        ACPClient.unregisterSession(this.config.id);
        this.sessionId = null;
        return this.chatWithRetry(prompt, attempt);
      }

      // Lường trường hợp model bị ngắt/lỗi đường truyền/timeout:
      // Retry lên tới 3 lần (attempt < 2) với exponential backoff
      const isNetworkOrTimeout = /timeout|network|fetch|connect|econnrefused|disconnected/i.test(errText);
      if (isNetworkOrTimeout && attempt < 2) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[ACP] Connection/timeout error detected. Retrying in ${delay}ms... (Attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, delay));
        return this.chatWithRetry(prompt, attempt + 1);
      }

      // JSONL vẫn trả output khi exit != 0 (vd event type=error)
      const raw = err.stdout?.toString() || '';
      const { content, transcript, sessionId, errorMsg } = this.parseJsonlEvents(raw);
      if (!this.sessionId && sessionId) {
        this.sessionId = sessionId;
        ACPClient.registerSession(this.config.id, sessionId);
        console.log(`[ACP] New session (error path): ${sessionId}`);
      }

      return {
        id: uuidv4(),
        from: this.config.id,
        to: 'orchestrator',
        content: content || errorMsg || `Error: ${err.message}`,
        timestamp: Date.now(),
        transcript: transcript || undefined
      };
    } finally {
      // Đảm bảo luôn dọn dẹp file tạm
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Parse opencode --format json JSONL events thành:
   * - content: lời thoại model (nguyên văn, ghép các text part)
   * - transcript: toàn bộ diễn biến lượt (tool_use + text + cost) nguyên văn
   * - sessionId: sessionID từ event bất kỳ (chính xác nhất)
   */
  private parseJsonlEvents(stdout: string): {
    content: string; transcript: string; sessionId: string | null; errorMsg?: string;
  } {
    const lines = stdout.split(/\r?\n/).filter(l => l.trim());
    const texts: string[] = [];
    const toolLines: string[] = [];
    let sessionId: string | null = null;
    let errorMsg: string | undefined;
    let totalCost = 0;

    for (const line of lines) {
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.sessionID && !sessionId) sessionId = ev.sessionID;

      switch (ev.type) {
        case 'text':
          if (ev.part?.text) texts.push(ev.part.text);
          break;
        case 'tool_use': {
          const p = ev.part || {};
          const tool = p.tool || 'unknown';
          const title = p.state?.title || '';
          const input = p.state?.input ? JSON.stringify(p.state.input) : '';
          const output = p.state?.output || '';
          toolLines.push(
            `[TOOL ${tool}] ${title}` +
            (input ? `\n  input: ${input}` : '') +
            (output ? `\n  output: ${output.split(/\r?\n/).slice(0, 20).join('\n  ')}` : '')
          );
          break;
        }
        case 'step_finish':
          totalCost += typeof ev.part?.cost === 'number' ? ev.part.cost : 0;
          break;
        case 'error':
          errorMsg = ev.error?.data?.message || ev.error?.name || 'Unknown error';
          break;
      }
    }

    const content = texts.join('\n').trim();
    const header = sessionId ? `=== TURN TRANSCRIPT (session ${sessionId}) ===` : '=== TURN TRANSCRIPT ===';
    const parts: string[] = [header];
    for (const t of toolLines) parts.push(t);
    if (content) parts.push(`[ASSISTANT]\n${content}`);
    if (totalCost > 0) parts.push(`[COST] $${totalCost.toFixed(4)}`);
    parts.push('=== END TURN TRANSCRIPT ===');

    return { content, transcript: parts.join('\n'), sessionId, errorMsg };
  }

  /** Fetch all sessions once — used by chat() to avoid redundant exec calls */
  private async fetchSessions(): Promise<any[]> {
    try {
      const { stdout } = await execAsync('opencode session list --format json', {
        encoding: 'utf-8', timeout: 5000
      });
      return JSON.parse(stdout) as any[];
    } catch { return []; }
  }

  private findSessionFromList(sessions: any[], beforeCount: number): string | null {
    if (sessions.length === 0) return null;

    // Sessions are ordered newest-first. New sessions = those beyond beforeCount.
    const newSessions = sessions.slice(0, Math.max(0, sessions.length - beforeCount));
    if (newSessions.length === 0) return null;

    // Exclude sessions already claimed by OTHER agents to prevent cross-contamination
    const otherSessions = ACPClient.getOtherAgentSessions(this.config.id);

    // 1st priority: new session NOT claimed by any other agent
    const unclaimed = newSessions.find((s: any) => !otherSessions.has(s.id));
    if (unclaimed) return unclaimed.id;

    // Fallback: all new sessions are claimed — pick any unclaimed session
    for (const s of sessions) {
      if (!otherSessions.has(s.id)) return s.id;
    }
    return null;
  }

  /** Lấy title (hoặc slug fallback) của một session opencode — dùng làm tiêu đề khung chat */
  async getSessionTitle(sessionId?: string): Promise<string | null> {
    const sid = sessionId || this.sessionId;
    if (!sid) return null;
    try {
      const { stdout } = await execAsync('opencode session list --format json', {
        encoding: 'utf-8', timeout: 5000
      });
      const sessions = JSON.parse(stdout) as any[];
      const found = sessions.find((s: any) => s.id === sid);
      return found?.title || found?.slug || null;
    } catch { return null; }
  }

  async deleteSession(sessionId?: string): Promise<boolean> {
    const sid = sessionId || this.sessionId;
    if (!sid) return false;
    try {
      await execAsync(`opencode session delete ${sid}`, {
        encoding: 'utf-8', timeout: 10000
      });
      console.log(`[ACP] Deleted session: ${sid}`);
      if (sid === this.sessionId) this.sessionId = null;
      ACPClient.unregisterSession(this.config.id);
      return true;
    } catch (e: any) {
      console.log(`[ACP] Failed to delete session ${sid}: ${e.message}`);
      return false;
    }
  }

  setSession(id: string) { this.sessionId = id; }
  getSessionId(): string | null { return this.sessionId; }
  isRunning() { return false; }
  stop() {}
}
