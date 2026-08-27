// ACP Client — OpenCode CLI async with safe local temp file for long prompts
import { exec, spawn, execSync } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { openSync, writeSync, fsyncSync, closeSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';
import type { AgentConfig, AgentMessage, TokenUsage, ToolCallInfo } from './types.js';
import { storage } from '../storage.js';

const execAsync = promisify(exec);
const isWin = process.platform === 'win32';
// Giới hạn hàng đợi tin nhắn chờ xử lý cho 1 agent — chống phình bộ nhớ
const MAX_PENDING = 20;

export class ACPClient {
  // Shared map across all instances: agentId → sessionId
  // Prevents session cross-contamination when multiple agents spawn simultaneously
  private static agentSessions = new Map<string, string>();
  // Active child process PIDs across all ACP instances for clean termination on exit/crash
  public static activeChildPids = new Set<number>();

  /** Kill all active child processes and subtrees (Windows taskkill / Linux SIGKILL) */
  static killAllChildProcesses() {
    if (ACPClient.activeChildPids.size === 0) return;
    const pids = Array.from(ACPClient.activeChildPids);
    for (const pid of pids) {
      try {
        if (isWin) {
          execSync(`taskkill /pid ${pid} /T /F`, { timeout: 3000, stdio: 'ignore' });
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch {}
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      } catch {}
    }
    ACPClient.activeChildPids.clear();
  }

  private config: AgentConfig;
  private sessionId: string | null = null;
  private proc: ReturnType<typeof spawn> | null = null;
  private busy = false;
  private pending: Array<{ prompt: string; resolve: (m: AgentMessage) => void; reject: (e: any) => void }> = [];
  private aborting = false; // Idempotency guard for abort()
  private needPromptReinject = false;
  private unprocessedPrompts: string[] = [];

  // Streaming terminal I/O của opencode lên UI (input prompt + từng dòng JSONL output)
  private onEvent?: (ev: any) => void;
  private eventSeq = 0;
  private eventBuf: any[] = [];
  private eventTimer: any = null;
  private lineBuf = '';

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /** Gắn callback để nhận từng sự kiện terminal (input + output JSONL) của opencode */
  setOnEvent(cb: (ev: any) => void) {
    this.onEvent = cb;
  }

  setNeedPromptReinject(val: boolean = true) {
    this.needPromptReinject = val;
  }

  addUnprocessedPrompt(prompt: string) {
    if (!prompt || !prompt.trim()) return;
    const clean = prompt.trim();
    if (!this.unprocessedPrompts.includes(clean)) {
      this.unprocessedPrompts.push(clean);
    }
  }

  getUnprocessedPrompts(): string[] {
    return this.unprocessedPrompts.slice();
  }

  clearUnprocessedPrompts() {
    this.unprocessedPrompts = [];
  }

  private pushOACEvent(ev: any) {
    if (!this.onEvent) return;
    this.eventBuf.push(ev);
    if (!this.eventTimer) {
      this.eventTimer = setInterval(() => this.flushOACEvents(), 250);
      if (typeof this.eventTimer.unref === 'function') this.eventTimer.unref();
    }
  }

  /**
   * Event nội bộ của opencode (step lifecycle): step_start / step_finish.
   * Chúng VẪN được parseJsonlEvents dùng để đếm token/cost/context (từ stdout đầy đủ),
   * nhưng KHÔNG được stream lên UI (chat) vì chỉ là metadata kỹ thuật.
   */
  private isInternalStepEvent(ev: any): boolean {
    const t = String(ev?.type ?? ev?.evt ?? '').toLowerCase().replace(/-/g, '_');
    return t === 'step_start' || t === 'step_finish';
  }

  private flushOACEvents() {
    if (this.eventBuf.length === 0) {
      if (this.eventTimer) { clearInterval(this.eventTimer); this.eventTimer = null; }
      return;
    }
    const batch = this.eventBuf;
    this.eventBuf = [];
    try { this.onEvent?.({ kind: 'batch', seq: ++this.eventSeq, events: batch }); } catch {}
  }

  private stopOACEvents() {
    if (this.eventTimer) { clearInterval(this.eventTimer); this.eventTimer = null; }
    this.flushOACEvents();
  }

  getNeedPromptReinject(): boolean {
    return this.needPromptReinject;
  }

  setNeedFullPrompt(val: boolean = true) {
    this.needPromptReinject = val;
  }

  getNeedFullPrompt(): boolean {
    return this.needPromptReinject;
  }

  setNeedReinject(val: boolean = true) {
    this.needPromptReinject = val;
  }

  getNeedReinject(): boolean {
    return this.needPromptReinject;
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

  // PROCESS-AUTHORITATIVE: busy ⇔ tiến trình opencode còn sống.
  // this.proc chỉ được gán null BÊN TRONG handler proc.on('close')/'error'
  // nên isBusy()===false đảm bảo close đã kích hoạt xong.
  isBusy(): boolean { return this.proc !== null; }
  queueLength(): number { return this.pending.length; }

  /** Cập nhật model cho client đang tồn tại — KHÔNG reset session, đổi model áp dụng cho session này */
  setModel(model?: string) { this.config.model = model; }

  /** Hủy process opencode đang chạy (dùng khi chat bị treo) — idempotent */
  abort(): boolean {
    // Idempotency guard: if already aborting, return true without re-executing
    if (this.aborting) return true;
    this.aborting = true;

    // BẢO TOÀN TIN NHẮN: Lưu lại toàn bộ các prompt trong hàng đợi chờ xử lý
    // vào bộ đệm unprocessedPrompts và Disk Storage để gộp vào lượt kế tiếp (tránh mất tin khi Stop).
    const pendingItems = this.pending.splice(0, this.pending.length);
    for (const p of pendingItems) {
      if (p && p.prompt && p.prompt.trim()) {
        this.addUnprocessedPrompt(p.prompt);
        try {
          storage.saveUnprocessedMessage(this.config.id, p.prompt);
        } catch {}
      }
      try { p.reject(new Error('Agent operation aborted by user.')); } catch {}
    }
    
    if (this._aborted) {
      this.aborting = false;
      return true;
    }
    this._aborted = true;

    if (this.proc && !this.proc.killed) {
      const procToKill = this.proc;
      const pid = procToKill.pid;
      this.proc = null;

      if (pid) {
        ACPClient.activeChildPids.delete(pid);
        try {
          if (isWin) {
            // CO LAP PID: chi kill dung cay tien trinh cua instance nay
            // (taskkill /T /F theo pid) — TUYET DOI khong kill theo ten
            // opencode.exe de tranh giet nham cac agent dang chay song song.
            try {
              execSync(`taskkill /pid ${pid} /T /F`, { timeout: 3000, stdio: 'ignore' });
            } catch {
              // Fallback cuoi cung van theo dung PID nay
              try { process.kill(pid, 0); } catch {}
              try { procToKill.kill(); } catch {}
            }
          } else {
            // Linux/Mac: SIGTERM then SIGKILL
            try {
              process.kill(-pid, 'SIGTERM');
            } catch {
              process.kill(pid, 'SIGTERM');
            }
            setTimeout(() => {
              try { process.kill(-pid, 'SIGKILL'); } catch {}
              try { process.kill(pid, 'SIGKILL'); } catch {}
            }, 2000);
          }
        } catch {
          // Fallback: traditional kill
          try { procToKill.kill('SIGKILL'); } catch {}
        }
      }
      this.aborting = false;
      return true;
    }
    this.aborting = false;
    return false;
  }
  private _aborted = false;

  /**
   * Fire-and-Forget Injection Instance:
   * Khi luồng chính đang bận (this.busy === true), spawn ngay một tiến trình opencode riêng
   * để nạp prompt mới thẳng vào session SQLite database của OpenCode và tự thoát trong im lặng (0 UI interruption).
   */
  async injectPromptAsync(prompt: string): Promise<{ success: boolean; pid?: number }> {
    if (!this.sessionId) {
      return { success: false };
    }

    try {
      const projectDir = this.config.projectDir || process.cwd();
      const relFile = join('data', 'tmp', `inject-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      const tmpFile = join(projectDir, relFile);
      mkdirSync(join(projectDir, 'data', 'tmp'), { recursive: true });
      writeFileSync(tmpFile, prompt.normalize('NFC'), { encoding: 'utf-8' });

      const roleToAgent: Record<string, string> = {
        coder: 'coder', reviewer: 'reviewer', tester: 'tester',
        docs: 'docs', planner: 'planner', orchestrator: 'orchestrator',
        researcher: 'researcher', verifier: 'verifier', debugger: 'debugger', searcher: 'searcher',
        idea: 'idea'
      };
      const agentName = roleToAgent[this.config.role] || this.config.role || (this.config.type === 'orchestrator' ? 'orchestrator' : 'coder');
      let agentFlag = ` --agent ${agentName} --session "${this.sessionId}" --auto --format json`;
      if (this.config.model) {
        agentFlag += ` --model "${this.config.model}"`;
      }

      const isSlash = prompt.trim().startsWith('/');
      let cmdArgs: string[] = [];

      if (isSlash) {
        const slashParts = prompt.trim().replace(/^\//, '').trim().split(/\s+/);
        const cleanCmd = slashParts[0] || '';
        const cmdArgsRest = slashParts.slice(1).join(' ').trim();
        const messageArg = cmdArgsRest ? ` "${cmdArgsRest.replace(/"/g, '`"')}"` : '';
        const modelFlag = this.config.model ? ` --model "${this.config.model}"` : '';
        const fullCmd = `opencode run${messageArg} --command "${cleanCmd}" --session "${this.sessionId}"${modelFlag} --auto --format json`;
        cmdArgs = isWin
          ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ${fullCmd}`]
          : ['-c', fullCmd];
      } else {
        cmdArgs = isWin
          ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8; Get-Content -Raw -Encoding utf8 '${relFile}' | opencode run${agentFlag}`]
          : ['-c', `cat "${relFile}" | opencode run${agentFlag}`];
      }

      const utf8Env = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8'
      };

      const injectProc = spawn(
        isWin ? 'powershell.exe' : 'sh',
        cmdArgs,
        {
          cwd: projectDir,
          env: utf8Env,
          windowsHide: true,
          stdio: 'ignore' // Hoàn toàn im lặng, không bắt pipe gây treo
        }
      );

      const pid = injectProc.pid;
      if (pid) {
        ACPClient.activeChildPids.add(pid);
      }

      injectProc.on('close', () => {
        if (pid) ACPClient.activeChildPids.delete(pid);
        try { unlinkSync(tmpFile); } catch {}
      });

      injectProc.on('error', () => {
        if (pid) ACPClient.activeChildPids.delete(pid);
        try { unlinkSync(tmpFile); } catch {}
      });

      return { success: true, pid };
    } catch {
      return { success: false };
    }
  }

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

  /**
   * Cấu trúc hóa việc gộp nhiều prompt trong hàng đợi:
   * - Giữ nguyên khung ngữ cảnh ngoài ([TASK], [TEAM]) từ tin nhắn đầu tiên.
   * - Gom toàn bộ các phần === MESSAGE === thành các khối [Message 1], [Message 2]... phân cách bằng '---' bên trong 1 khối === INCOMING MESSAGE === duy nhất.
   */
  private combineBatchPrompts(prompts: string[]): string {
    if (prompts.length === 0) return '';
    if (prompts.length === 1) return prompts[0];

    const first = prompts[0];
    const incIdx = first.indexOf('=== INCOMING MESSAGE ===');
    if (incIdx === -1) {
      return prompts.map((p, idx) => `[Message ${idx + 1}]:\n${p}`).join('\n\n---\n\n');
    }

    const contextPrefix = first.substring(0, incIdx).trim();
    const afterInc = first.substring(incIdx);
    const msgMarkerIdx = afterInc.indexOf('=== MESSAGE ===');
    let header = '=== INCOMING MESSAGE ===';
    if (msgMarkerIdx !== -1) {
      header = afterInc.substring(0, msgMarkerIdx + '=== MESSAGE ==='.length).trim();
    } else {
      header = '=== INCOMING MESSAGE ===\n=== MESSAGE ===';
    }

    const messages: string[] = [];
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      let msgBody = p;
      const markerIdx = p.indexOf('=== MESSAGE ===');
      if (markerIdx !== -1) {
        msgBody = p.substring(markerIdx + '=== MESSAGE ==='.length);
      } else {
        const fromIdx = p.indexOf('=== INCOMING MESSAGE ===');
        if (fromIdx !== -1) {
          msgBody = p.substring(fromIdx + '=== INCOMING MESSAGE ==='.length);
        }
      }

      // Loại bỏ reminder thừa ở từng message con
      const remIdx = msgBody.indexOf('=== SYSTEM REMINDER ===');
      if (remIdx !== -1) {
        msgBody = msgBody.substring(0, remIdx);
      }
      
      const cleanBody = msgBody.trim();
      if (cleanBody) {
        messages.push(`[Message ${i + 1}]:\n${cleanBody}`);
      }
    }

    const reminder = `\n\n=== SYSTEM REMINDER ===\nUse [TO: <target-id>] <message> for communications.\nFinish with [TO: orchestrator] Task complete. === TASK REPORT ===`;
    const combinedBody = messages.join('\n\n---\n\n');
    return `${contextPrefix ? contextPrefix + '\n\n' : ''}${header}\n${combinedBody}${reminder}`;
  }

  private async runQueued(prompt: string): Promise<AgentMessage> {
    this.busy = true;
    try {
      return await this.chat(prompt);
    } finally {
      this.busy = false;
      if (this.pending.length > 0) {
        // Dồn và xử lý gom nhóm tất cả tin nhắn TALK/prompt tồn đọng trong lúc bận
        const batch = this.pending.splice(0, this.pending.length);
        if (batch.length === 1) {
          const item = batch[0];
          this.runQueued(item.prompt).then(item.resolve).catch(item.reject);
        } else if (batch.length > 1) {
          const combinedPrompt = this.combineBatchPrompts(batch.map(b => b.prompt));
          this.runQueued(combinedPrompt).then(res => {
            batch.forEach(b => b.resolve(res));
          }).catch(err => {
            batch.forEach(b => b.reject(err));
          });
        }
      }
    }
  }

  async chat(prompt: string): Promise<AgentMessage> {
    return this.chatWithRetry(prompt, 0);
  }

  private async chatWithRetry(prompt: string, attempt: number): Promise<AgentMessage> {
    const projectDir = this.config.projectDir || process.cwd();

    // TỐI ƯU HÓA: Chỉ fetch sessions nếu agent CHƯA CÓ sessionId (để tìm fallback session).
    // Nếu agent đã có session rồi, bỏ qua 100% việc gọi subprocess 'opencode session list'.
    let beforeCount = 0;
    if (!this.sessionId) {
      const beforeSessions = await this.fetchSessions();
      beforeCount = beforeSessions.length;
    }

    // SESSION KHÓA VĨNH VIỄN: không reset/xóa session tự động vì lý do format.
    // Session cũ được tái sử dụng liên tục đến khi server chết (yêu cầu kiến trúc).
    if (this.sessionId && !this.sessionId.startsWith('ses_')) {
      console.log(`[ACP] WARNING: Session ${this.sessionId} format unusual — KEEPING it (persistent-session policy)`);
    }

    // Write prompt to safe local temp file with UTF-8 encoding (NFC normalized)
    const relFile = join('data', 'tmp', `prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const tmpFile = join(projectDir, relFile);
    mkdirSync(join(projectDir, 'data', 'tmp'), { recursive: true });
    writeFileSync(tmpFile, prompt.normalize('NFC'), { encoding: 'utf-8' });

    // Build command — use stdin pipe via cat/type instead of inline args
    const roleToAgent: Record<string, string> = {
      coder: 'coder', reviewer: 'reviewer', tester: 'tester',
      docs: 'docs', planner: 'planner', orchestrator: 'orchestrator',
      researcher: 'researcher', verifier: 'verifier', debugger: 'debugger', searcher: 'searcher',
      idea: 'idea'
    };
    // Custom roles: check if .opencode/agents/<role>.md exists, use role name directly
    const agentName = roleToAgent[this.config.role] || this.config.role || (this.config.type === 'orchestrator' ? 'orchestrator' : 'coder');
    let agentFlag = ` --agent ${agentName}`;
    if (this.sessionId) {
      agentFlag += ` --session "${this.sessionId}"`;
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

    const utf8Env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      NODE_OPTIONS: '--enable-source-maps',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8'
    };

    const isSlash = prompt.trim().startsWith('/');
    const slashParts = isSlash ? prompt.trim().replace(/^\//, '').trim().split(/\s+/) : [];
    const cleanCmd = slashParts[0] || '';
    const cmdArgsRest = slashParts.slice(1).join(' ').trim();

    if (isSlash && cleanCmd.toLowerCase() === 'compact') {
      this.needPromptReinject = true;
      if (!this.sessionId) {
        return {
          id: uuidv4(),
          from: this.config.id,
          to: 'orchestrator',
          content: '⚠️ Agent chưa có session nào đang hoạt động để rút gọn (compact).',
          timestamp: Date.now()
        };
      }
    }

    let cmdArgs: string[] = [];
    if (isSlash) {
      const sessionFlag = this.sessionId ? ` --session "${this.sessionId}"` : '';
      const modelFlag = modelToUse ? ` --model "${modelToUse}"` : '';
      const messageArg = cmdArgsRest ? ` "${cmdArgsRest.replace(/"/g, '`"')}"` : '';
      const fullCmd = `opencode run${messageArg} --command "${cleanCmd}"${sessionFlag}${modelFlag} --auto --format json`;
      cmdArgs = isWin 
        ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8; ${fullCmd}`]
        : ['-c', fullCmd];
    } else {
      cmdArgs = isWin
        ? ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8; Get-Content -Raw -Encoding utf8 '${relFile}' | opencode run --auto --format json${agentFlag}`]
        : ['-c', `cat "${relFile}" | opencode run --auto --format json${agentFlag}`];
    }

    try {
      // Reset buffer & phát sự kiện INPUT (prompt gửi cho opencode) lên UI
      this.lineBuf = '';
      this.pushOACEvent({ kind: 'in', prompt: prompt.length > 4000 ? prompt.slice(0, 4000) + '\n…(truncated)' : prompt });

      const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn(
          isWin ? 'powershell.exe' : 'sh',
          cmdArgs,
          {
            cwd: projectDir,
            env: utf8Env,
            windowsHide: true
          }
        );
        this.proc = proc as any;
        if (proc.pid) {
          ACPClient.activeChildPids.add(proc.pid);
        }

        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        let stdoutStr = '';
        let stderrStr = '';

        proc.stdout?.on('data', (chunk: Buffer) => {
          const piece = stdoutDecoder.write(chunk);
          stdoutStr += piece;
          // Stream từng dòng JSONL output của opencode lên UI
          this.lineBuf += piece;
          let nlIdx: number;
          while ((nlIdx = this.lineBuf.indexOf('\n')) !== -1) {
            const line = this.lineBuf.slice(0, nlIdx);
            this.lineBuf = this.lineBuf.slice(nlIdx + 1);
            const trimmed = line.trim();
            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (!this.isInternalStepEvent(parsed)) {
                  this.pushOACEvent({ kind: 'out', event: parsed });
                }
              } catch {}
            }
          }
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderrStr += stderrDecoder.write(chunk);
        });

        proc.on('error', (err) => {
          if (proc.pid) ACPClient.activeChildPids.delete(proc.pid);
          this.proc = null;
          reject(err);
        });

        proc.on('close', (code) => {
          if (proc.pid) ACPClient.activeChildPids.delete(proc.pid);
          this.proc = null;
          stdoutStr += stdoutDecoder.end();
          stderrStr += stderrDecoder.end();

          // Flush phần còn lại của dòng JSONL chưa kết thúc + dừng stream event
          if (this.lineBuf.trim()) {
            const trimmed = this.lineBuf.trim();
            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (!this.isInternalStepEvent(parsed)) {
                  this.pushOACEvent({ kind: 'out', event: JSON.parse(trimmed) });
                }
              } catch {}
            }
            this.lineBuf = '';
          }
          this.stopOACEvents();

          if (code !== 0 && code !== null) {
            const errDetails = stderrStr.trim() || stdoutStr.trim();
            const e: any = new Error(`Command failed (${code}): ${errDetails || 'Process exited with error'}`);
            e.stdout = stdoutStr; e.stderr = stderrStr; e.code = code;
            reject(e);
          } else {
            resolve(stdoutStr);
          }
        });
      });
      this._aborted = false;

      const { content, transcript, sessionId, errorMsg, toolCalls, tokenUsage, contextLength, thinking } = this.parseJsonlEvents(stdout);

      // Session từ event chính xác hơn so sánh danh sách
      if (!this.sessionId && sessionId) {
        this.sessionId = sessionId;
        ACPClient.registerSession(this.config.id, sessionId);
        console.log(`[ACP] New session: ${sessionId} (agent: ${this.config.role})`);
      } else if (!this.sessionId) {
        const afterSessions = await this.fetchSessions();
        this.sessionId = this.findSessionFromList(afterSessions, beforeCount);
        if (this.sessionId) {
          ACPClient.registerSession(this.config.id, this.sessionId);
          console.log(`[ACP] New session (fallback): ${this.sessionId} (agent: ${this.config.role})`);
        }
      }

      let finalContent = content || '(No response)';
      if (isSlash && cleanCmd.toLowerCase() === 'compact' && (!content || content === '(No response)')) {
        finalContent = '⚡ Session compacted successfully. Context history optimized.';
      }

      return {
        id: uuidv4(),
        from: this.config.id,
        to: 'orchestrator',
        content: finalContent,
        timestamp: Date.now(),
        transcript: transcript || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        thinking,
        // Fix badge token = 0: không đánh rơi usage của lượt
        tokenUsage,
        contextLength
      };
    } catch (err: any) {
      // Nếu bị abort → trả message stopped, KHÔNG retry
      if (this._aborted) {
        this._aborted = false;
        return {
          id: uuidv4(),
          from: this.config.id,
          to: 'orchestrator',
          content: '[STOPPED] Agent was stopped by user.',
          timestamp: Date.now(),
        };
      }

      const errText = `${err.message || ''} ${err.stdout?.toString() || ''} ${err.stderr?.toString() || ''}`;
      const isSessionNotFoundOrExpired = /\b404\b|invalid session|session (invalid|not found|does not exist|not exist|expired)/i.test(errText);

      // SESSION KHÓA VĨNH VIỄN: kể cả 404/session-expired cũng KHÔNG reset —
      // giữ nguyên sessionId cũ, retry tiếp tục trên session đó (chính sách persistent-session).
      if (isSessionNotFoundOrExpired) {
        console.log(`[ACP] Session ${this.sessionId || '(unregistered)'} not found/expired — KEEPING session (persistent-session policy), retrying without reset`);
      }

      // Trường hợp lỗi tạm thời khác (mạng, timeout, API busy, v.v.):
      // Retry lên tới 3 lần (attempt < 2) với exponential backoff MÀ KHÔNG reset session
      if (attempt < 2) {
        const delay = Math.pow(2, attempt) * 1500;
        console.log(`[ACP] Error detected (${err.message}). Retrying in ${delay}ms... (Attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, delay));
        return this.chatWithRetry(prompt, attempt + 1);
      }

      // Lượt cuối sau khi hết retry: trích xuất output nếu có từ JSONL
      const raw = err.stdout?.toString() || '';
      const { content, transcript, sessionId, errorMsg, toolCalls, tokenUsage, contextLength, thinking } = this.parseJsonlEvents(raw);

      // Nếu có sessionId mới trong event mà agent chưa có session thì cập nhật
      if (!this.sessionId && sessionId) {
        this.sessionId = sessionId;
        ACPClient.registerSession(this.config.id, sessionId);
        console.log(`[ACP] New session (error path): ${sessionId}`);
      }

      // SESSION KHÓA VĨNH VIỄN: không reset ở lượt cuối — giữ sessionId cũ vĩnh viễn
      if (isSessionNotFoundOrExpired) {
        console.log(`[ACP] Persistent-session policy: session ${this.sessionId || '(unregistered)'} retained despite: ${err.message}`);
      }

      return {
        id: uuidv4(),
        from: this.config.id,
        to: 'orchestrator',
        content: content || errorMsg || `Error: ${err.message}`,
        timestamp: Date.now(),
        transcript: transcript || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        tokenUsage,
        contextLength,
        thinking
      };
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Parse opencode --format json JSONL events thành:
   * - content: lời thoại model THUẦN (ghép các text part, đã lọc sạch mọi marker
   *   [TOOL ...] lẫn vào) — UI hiển thị phần body ngoài.
   * - toolCalls: mảng cấu trúc {tool, input?, output?} lấy từ event tool_use/tool-call
   *   GỐC — UI render hộp toolcall riêng biệt, KHÔNG parse từ text.
   * - transcript: toàn bộ diễn biến lượt (tool_use + text + cost) nguyên văn — chỉ giữ
   *   để tương thích (saveTranscript/log), KHÔNG dùng làm nguồn cho UI toolcall.
   * - sessionId: sessionID từ event bất kỳ (chính xác nhất)
   */
  private parseJsonlEvents(stdout: string): {
    content: string; transcript: string; sessionId: string | null; errorMsg?: string;
    toolCalls: ToolCallInfo[];
    thinking?: string;
    tokenUsage?: TokenUsage; contextLength?: number;
  } {
    const lines = stdout.split(/\r?\n/).filter(l => l.trim());
    const texts: string[] = [];
    const toolLines: string[] = [];
    // Suy nghĩ nội bộ của model (reasoning/thinking) — tách khỏi content
    const thinkingParts: string[] = [];
    // Nguồn chuẩn cho UI toolcall: mảng cấu trúc thu thập từ event tool_use GỐC,
    // tách khỏi chuỗi transcript nối chung (toolLines chỉ giữ để tương thích).
    const toolCalls: ToolCallInfo[] = [];
    let sessionId: string | null = null;
    let errorMsg: string | undefined;
    let totalCost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let contextLength: number | undefined;

    for (const line of lines) {
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.sessionID && !sessionId) sessionId = ev.sessionID;
      if (ev.sessionId && !sessionId) sessionId = ev.sessionId;

      if (typeof ev.contextLength === 'number') contextLength = ev.contextLength;
      if (typeof ev.context_length === 'number') contextLength = ev.context_length;
      if (typeof ev.part?.contextLength === 'number') contextLength = ev.part.contextLength;
      if (typeof ev.part?.context_limit === 'number') contextLength = ev.part.context_limit;

      // Extract cost from any event level
      const stepCost = typeof ev.cost === 'number' ? ev.cost : (typeof ev.part?.cost === 'number' ? ev.part.cost : (typeof ev.usage?.cost === 'number' ? ev.usage.cost : (typeof ev.tokens?.cost === 'number' ? ev.tokens.cost : 0)));
      if (stepCost > 0) totalCost = stepCost;

      // Trích xuất usage CHUẨN của LLM: chỉ nhận số thật (input+output của session),
      // tuyệt đối KHÔNG dùng độ dài chuỗi ký tự/byte hay object lồng nhau làm token.
      const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const tokenSrc = ev.part?.tokens || ev.part?.usage || ev.tokens || ev.usage || ev.info?.usage || ev.data?.usage;
      if (tokenSrc) {
        if (typeof tokenSrc === 'number') {
          if (Number.isFinite(tokenSrc)) totalTokens = tokenSrc;
        } else if (typeof tokenSrc === 'object') {
          const inp = toNum(tokenSrc.input_tokens ?? tokenSrc.prompt_tokens ?? tokenSrc.input ?? tokenSrc.prompt);
          const out = toNum(tokenSrc.output_tokens ?? tokenSrc.completion_tokens ?? tokenSrc.output ?? tokenSrc.completion);
          const rea = toNum(tokenSrc.reasoning_tokens ?? tokenSrc.thought_tokens ?? tokenSrc.reasoning ?? tokenSrc.thought ?? tokenSrc.completion_tokens_details?.reasoning_tokens);
          const cr = toNum(tokenSrc.cache_read_input_tokens ?? tokenSrc.cached_tokens ?? tokenSrc.cache?.read ?? tokenSrc.cache_read ?? tokenSrc.prompt_tokens_details?.cached_tokens);
          const cw = toNum(tokenSrc.cache_write_input_tokens ?? tokenSrc.cache?.write ?? tokenSrc.cache_write);
          // Chỉ lấy total CHUẨN dạng số do model API trả về; thiếu/không hợp lệ → inp + out
          let tot = toNum(tokenSrc.total_tokens ?? tokenSrc.total);
          if (tot <= 0) tot = inp + out;
          inputTokens = inp;
          outputTokens = out;
          reasoningTokens = rea;
          cacheReadTokens = cr;
          cacheWriteTokens = cw;
          totalTokens = tot;
        }
      }

      switch (ev.type) {
        case 'text':
          if (ev.part?.text) texts.push(ev.part.text);
          break;
        // Suy nghĩ nội bộ của model (reasoning/thinking/thought): gom riêng,
        // KHÔNG trộn vào content — trả về trường thinking cho UI hiển thị hộp riêng.
        case 'reasoning':
        case 'thinking':
        case 'thought': {
          const rt = ev.part?.text || ev.text || ev.part?.thinking || ev.thinking;
          if (typeof rt === 'string' && rt.trim()) thinkingParts.push(rt);
          break;
        }
        // Hỗ trợ cả biến thể tên event: tool_use / tool-call / tool_call
        case 'tool_use':
        case 'tool-call':
        case 'tool_call': {
          const p = ev.part || {};
          const tool = p.tool || 'unknown';
          const title = p.state?.title || '';
          const input = p.state?.input ? JSON.stringify(p.state.input) : '';
          const output = p.state?.output || '';
          // Đẩy object cấu trúc gốc (nguồn cho UI), tách khỏi text transcript
          toolCalls.push({
            tool,
            input: input || undefined,
            output: output || undefined
          });
          toolLines.push(
            `[TOOL ${tool}] ${title}` +
            (input ? `\n  input: ${input}` : '') +
            (output ? `\n  output: ${output.split(/\r?\n/).slice(0, 20).join('\n  ')}` : '')
          );
          break;
        }
        case 'error':
          errorMsg = ev.error?.data?.message || ev.error?.name || 'Unknown error';
          break;
      }
    }

    // ĐẢM BẢO content là lời nói thuần: loại mọi dòng marker [TOOL ...] (và các dòng con
    // "input:"/"output:" thụt đầu dòng liền sau) có thể lẫn vào text event của opencode.
    // UI dựa vào contract này: body hiển thị ngoài, mảng toolCalls render hộp riêng.
    const cleanTexts: string[] = [];
    for (const rawText of texts) {
      const keptLines: string[] = [];
      let skippingToolBlock = false;
      for (const ln of rawText.split(/\r?\n/)) {
        if (/^\s*\[TOOL\s+[^\]]+\]/.test(ln)) { skippingToolBlock = true; continue; }
        if (skippingToolBlock && /^\s+(input|output):/.test(ln)) continue;
        skippingToolBlock = false;
        keptLines.push(ln);
      }
      const cleaned = keptLines.join('\n').trim();
      if (cleaned) cleanTexts.push(cleaned);
    }
    const content = cleanTexts.join('\n').trim().normalize('NFC');
    const header = sessionId ? `=== TURN TRANSCRIPT (session ${sessionId}) ===` : '=== TURN TRANSCRIPT ===';
    const parts: string[] = [header];
    for (const t of toolLines) parts.push(t);
    if (content) parts.push(`[ASSISTANT]\n${content}`);
    if (totalCost > 0) parts.push(`[COST] $${totalCost.toFixed(4)}`);
    if (totalTokens > 0) parts.push(`[TOKENS] ${totalTokens}`);
    parts.push('=== END TURN TRANSCRIPT ===');

    const tokenUsageObj: TokenUsage | undefined = (totalTokens > 0 || inputTokens > 0 || outputTokens > 0)
      ? {
          inputTokens,
          outputTokens,
          reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
          cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
          cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
          totalTokens: totalTokens > 0 ? totalTokens : (inputTokens + outputTokens),
          cost: totalCost > 0 ? totalCost : undefined,
          contextLength: contextLength
        }
      : undefined;

    return {
      content,
      transcript: parts.join('\n').normalize('NFC'),
      sessionId,
      errorMsg: errorMsg?.normalize('NFC'),
      tokenUsage: tokenUsageObj,
      contextLength: contextLength || undefined,
      toolCalls,
      thinking: thinkingParts.length ? thinkingParts.join('\n').trim().normalize('NFC') : undefined
    };
  }

  /** Lấy title, token usage và context length của một session opencode */
  async getSessionStats(sessionId?: string): Promise<{ title: string | null; tokenUsage?: TokenUsage; contextLength?: number } | null> {
    const sid = sessionId || this.sessionId;
    if (!sid) return null;
    try {
      const projectDir = this.config.projectDir || process.cwd();
      const { stdout } = await execAsync('opencode session list --format json', {
        cwd: projectDir, encoding: 'utf-8', timeout: 5000
      });
      const sessions = JSON.parse(stdout) as any[];
      const found = sessions.find((s: any) => s.id === sid);
      if (!found) return null;
      const title = found.title || found.slug || null;
      let tokenUsage: TokenUsage | undefined;
      const rawCost = typeof found.cost === 'number' ? found.cost : (typeof found.tokens?.cost === 'number' ? found.tokens.cost : (typeof found.usage?.cost === 'number' ? found.usage.cost : undefined));
      const rawLimit = found.context_length || found.contextLength || found.tokens?.limit || found.usage?.contextLimit || found.context_limit;

      const tokenSrc = found.tokens || found.usage || found.info?.usage || found.data?.usage;
      if (tokenSrc && typeof tokenSrc === 'object') {
        const inp = tokenSrc.input_tokens || tokenSrc.prompt_tokens || tokenSrc.input || tokenSrc.prompt || 0;
        const out = tokenSrc.output_tokens || tokenSrc.completion_tokens || tokenSrc.output || tokenSrc.completion || 0;
        const rea = tokenSrc.reasoning_tokens || tokenSrc.thought_tokens || tokenSrc.reasoning || tokenSrc.thought || tokenSrc.completion_tokens_details?.reasoning_tokens;
        const cr = tokenSrc.cache_read_input_tokens || tokenSrc.cached_tokens || tokenSrc.cache?.read || tokenSrc.cache_read || tokenSrc.prompt_tokens_details?.cached_tokens;
        const cw = tokenSrc.cache_write_input_tokens || tokenSrc.cache?.write || tokenSrc.cache_write;
        const tot = tokenSrc.total_tokens || tokenSrc.total || tokenSrc.tokens || (inp + out);
        tokenUsage = {
          inputTokens: inp,
          outputTokens: out,
          reasoningTokens: rea,
          cacheReadTokens: cr,
          cacheWriteTokens: cw,
          totalTokens: tot,
          cost: rawCost,
          contextLength: rawLimit || tot
        };
      } else if (typeof tokenSrc === 'number') {
        tokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: tokenSrc,
          cost: rawCost,
          contextLength: rawLimit || tokenSrc
        };
      }
      const contextLength = rawLimit || tokenUsage?.totalTokens || undefined;
      return { title, tokenUsage, contextLength };
    } catch { return null; }
  }

  /** Fetch all sessions once — used by chat() to avoid redundant exec calls */
  private async fetchSessions(): Promise<any[]> {
    try {
      const projectDir = this.config.projectDir || process.cwd();
      const { stdout } = await execAsync('opencode session list --format json', {
        cwd: projectDir, encoding: 'utf-8', timeout: 5000
      });
      return JSON.parse(stdout) as any[];
    } catch { return []; }
  }

  private findSessionFromList(afterSessions: any[], beforeCount: number): string | null {
    if (afterSessions.length === 0) return null;

    // Sessions are ordered newest-first. New sessions = those beyond beforeCount.
    const newSessions = afterSessions.slice(0, Math.max(0, afterSessions.length - beforeCount));
    if (newSessions.length === 0) return null;

    // Exclude sessions already claimed by OTHER agents to prevent cross-contamination
    const otherSessions = ACPClient.getOtherAgentSessions(this.config.id);

    // 1st priority: new session NOT claimed by any other agent
    const unclaimed = newSessions.find((s: any) => !otherSessions.has(s.id));
    if (unclaimed) return unclaimed.id;

    return null;
  }

  /** Lấy title (hoặc slug fallback) của một session opencode — dùng làm tiêu đề khung chat */
  async getSessionTitle(sessionId?: string): Promise<string | null> {
    const sid = sessionId || this.sessionId;
    if (!sid) return null;
    try {
      const projectDir = this.config.projectDir || process.cwd();
      const { stdout } = await execAsync('opencode session list --format json', {
        cwd: projectDir, encoding: 'utf-8', timeout: 5000
      });
      const sessions = JSON.parse(stdout) as any[];
      const found = sessions.find((s: any) => s.id === sid);
      return found?.title || found?.slug || null;
    } catch { return null; }
  }

  async deleteSession(sessionId?: string): Promise<boolean> {
    const sid = sessionId || this.sessionId;
    let ok = false;
    if (this.proc && !this.proc.killed) {
      try { this.abort(); } catch {}
    }
    if (sid) {
      try {
        const projectDir = this.config.projectDir || process.cwd();
        await execAsync(`opencode session delete ${sid}`, {
          cwd: projectDir, encoding: 'utf-8', timeout: 10000
        });
        console.log(`[ACP] Deleted session: ${sid}`);
        ok = true;
      } catch (e: any) {
        console.log(`[ACP] Failed to delete session ${sid}: ${e.message}`);
        ok = false;
      }
    }
    if (!sessionId || sid === this.sessionId) {
      this.sessionId = null;
    }
    this.needPromptReinject = true;
    ACPClient.unregisterSession(this.config.id);
    return ok;
  }

  setSession(id: string | null) { this.sessionId = id; }
  getSessionId(): string | null { return this.sessionId; }
  isRunning() { return false; }
  stop() {}
}
