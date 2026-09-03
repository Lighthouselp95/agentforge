// ACP Client — OpenCode CLI async with temp file for long prompts
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentConfig, AgentMessage } from './types.js';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';

export class ACPClient {
  private config: AgentConfig;
  private sessionId: string | null = null;
  private proc: ReturnType<typeof spawn> | null = null;
  private busy = false;
  private pending: Array<{ prompt: string; resolve: (m: AgentMessage) => void; reject: (e: any) => void }> = [];

  constructor(config: AgentConfig) {
    this.config = config;
  }

  isBusy(): boolean { return this.busy; }
  queueLength(): number { return this.pending.length; }

  /** Hủy process opencode đang chạy (dùng khi chat bị treo) */
  abort(): boolean {
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill(); } catch {}
      // Expose helper để resolve promise đang chờ
      this._aborted = true;
      return true;
    }
    return false;
  }
  private _aborted = false;

  /**
   * Gửi prompt qua hàng đợi: nếu agent đang bận, tin được xếp lại
   * và tự động gửi ngay khi lượt hiện tại (và các tin trước đó) hoàn tất.
   */
  async enqueue(prompt: string): Promise<AgentMessage> {
    if (!this.busy && this.pending.length === 0) {
      return this.runQueued(prompt);
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
    const projectDir = this.config.projectDir || process.cwd();

    // Get session count before (fallback nếu JSONL không có sessionID)
    const beforeSessions = await this.getSessionCount();

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
    // Model override nếu được cấu hình (định dạng provider/model)
    if (this.config.model) {
      agentFlag += ` --model "${this.config.model}"`;
    }

    // Use type (Windows) or cat (Linux/Mac) to pipe file content
    const readCmd = isWin ? 'type' : 'cat';

    try {
      // Spawn command qua cmd.exe (Windows) / sh (Unix) để giữ handle process → abort được
      const shell = isWin ? 'cmd.exe' : 'sh';
      const shellCmd = `${readCmd} "${tmpFile}" | opencode run --auto --format json${agentFlag}`;
      // Xóa các biến OPENCODE* khỏi env con — tránh opencode run nested attach vào server cha (OPENCODE_PID)
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      Object.keys(childEnv).forEach(k => { if (/^OPENCODE_?/i.test(k)) delete childEnv[k]; });
      const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn(shell, ['/c', shellCmd], { cwd: projectDir, env: childEnv, windowsHide: true });
        this.proc = proc;
        let out = ''; let err = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());
        proc.on('error', (e) => { if (this._aborted) reject(new Error('Aborted')); else reject(e); });
        proc.on('close', (code) => {
          this.proc = null;
          if (this._aborted && code === null) { reject(new Error('Aborted')); }
          else if (code !== 0) {
            const e: any = new Error(`Command failed (${code}): ${err.trim() || out.trim() || shellCmd}`);
            e.stdout = out; e.stderr = err; e.code = code;
            reject(e);
          } else { resolve(out); }
        });
        // Cleanup nếu abort gọi kill
        if (this._aborted) { try { proc.kill(); } catch {} }
      });
      this._aborted = false;

      // Cleanup
      try { unlinkSync(tmpFile); } catch {}

      const { content, transcript, sessionId } = this.parseJsonlEvents(stdout);

      // Session từ event chính xác hơn so sánh danh sách
      if (!this.sessionId && sessionId) {
        this.sessionId = sessionId;
        console.log(`[ACP] New session: ${sessionId} (agent: ${this.config.role})`);
      } else if (!this.sessionId) {
        this.sessionId = await this.findSessionAfterChat(beforeSessions);
        if (this.sessionId) {
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
      // Cleanup on error too
      try { unlinkSync(tmpFile); } catch {}

      // Self-heal: session cũ đã bị xóa/chết trên opencode → bỏ sessionId, retry tạo mới
      const errText = `${err.message || ''} ${err.stdout?.toString() || ''} ${err.stderr?.toString() || ''}`;
      if (/Session not found/i.test(errText) && this.sessionId) {
        console.log(`[ACP] Session ${this.sessionId} not found — resetting, retrying with new session`);
        this.sessionId = null;
        return this.chat(prompt);
      }

      // JSONL vẫn trả output khi exit != 0 (vd event type=error)
      const raw = err.stdout?.toString() || '';
      const { content, transcript, sessionId, errorMsg } = this.parseJsonlEvents(raw);
      if (!this.sessionId && sessionId) {
        this.sessionId = sessionId;
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

  private async getSessionCount(): Promise<number> {
    try {
      const { stdout } = await execAsync('opencode session list --format json', {
        encoding: 'utf-8', timeout: 5000
      });
      return JSON.parse(stdout).length;
    } catch { return 0; }
  }

  private async findSessionAfterChat(beforeCount: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync('opencode session list -n 1 --format json', {
        encoding: 'utf-8', timeout: 5000
      });
      const sessions = JSON.parse(stdout);
      if (sessions.length > 0) return sessions[0].id;
    } catch {}
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
