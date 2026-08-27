# AgentForge — Hướng dẫn: Proactive Coordination, Dynamic Model Config, Background Ping Loop & Agent Autonomy

> Tài liệu này mô tả các tính năng mới được triển khai trong AgentForge v7: Worker Watchdog (theo dõi chủ động), Per-Agent Model Selector (cấu hình model động), Background Ping Loop (vòng lặp ping nền), Agent ID Display, Scroll Fix, và Agent Autonomy Prompts.

---

## 1. Proactive Coordination — Worker Watchdog & Auto-Recovery

### 1.1 Tổng quan

Worker Watchdog là cơ chế **theo dõi chủ động (proactive monitoring)** tự động phát hiện worker agents bị treo (stuck), không phản hồi, và thực hiện **auto-recovery** (khôi phục tự động) theo quy trình chuẩn của Orchestrator rule #8.

### 1.2 Kiến trúc

```
┌─────────────────────────────────────────────────────────────┐
│                    WORKER WATCHDOG                          │
│  (Interval: 30s — WORKER_WATCHDOG_CONFIG.checkIntervalMs)   │
├─────────────────────────────────────────────────────────────┤
│  Quét tất cả agents:                                        │
│  IF agent.type == 'worker' AND agent.status == 'working'    │
│     AND (now - agent.workingSince) >= stuckThresholdMs      │
│        (180s = 3 phút)                                       │
│                                                             │
│  THEN: Kích hoạt quy trình recovery theo checkCount         │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 Cấu hình (src/server.ts — WORKER_WATCHDOG_CONFIG)

| Tham số | Giá trị mặc định | Mô tả |
|---------|-----------------|-------|
| `checkIntervalMs` | 30,000 ms (30s) | Khoảng thời gian quét trạng thái agents |
| `stuckThresholdMs` | 180,000 ms (3 phút) | Ngưỡng coi agent bị stuck (theo rule #8) |
| `maxRetries` | 2 | Số lần auto-recovery tối đa trước khi force stop |
| `talkTimeoutMs` | 30,000 ms (30s) | Thời gian chờ phản hồi từ TALK check status |

### 1.4 Quy trình Recovery (State Machine)

```
Agent Working (workingSince set)
         │
         ▼
┌────────────────────────┐
│ stuckThreshold crossed? │── NO ──▶ Tiếp tục monitor
└───────────┬────────────┘
            │ YES
            ▼
    ┌───────────────┐
    │ checkCount = 0? │── YES ──▶ Lần 1: Gửi TALK check status
    └───────┬───────┘            "Bạn đã làm việc X giây. Progress?"
            │ NO
            ▼
    ┌───────────────┐
    │ checkCount <  │── YES ──▶ Lần 2..N: Gửi TALK với hướng dẫn
    │ maxRetries?   │           rõ ràng hơn (recovery attempt)
    └───────┬───────┘
            │ NO
            ▼
    ┌─────────────────────┐
    │ Force STOP + Report │──▶ Orchestrator decide: respawn/reassign/fail
    │ to Orchestrator     │
    └─────────────────────┘
```

### 1.5 Chi tiết từng bước

#### Bước 1: Phát hiện Stuck (checkCount = 0)
- Watchdog gửi TALK tới agent qua ACPClient:
  ```
  === SYSTEM CHECK ===
  The orchestrator has detected you've been working for 185 seconds
  without reporting progress.
  Please respond with your current status:
  - If working normally: "Still working on [brief description]"
  - If stuck: "STUCK: [reason]"
  - If done: "Task complete" with your report

  Respond using: [TO: orchestrator] <your status>
  ```

#### Bước 2: Xử lý phản hồi
| Phản hồi agent | Hành động Watchdog |
|----------------|-------------------|
| Chứa "stuck" | Gọi `handleStuckAgent()` → STOP agent, report lỗi, trigger orchestrator |
| Chứa "task complete" hoặc "=== TASK REPORT ===" | Xóa watchdog state, agent hoàn thành bình thường |
| "Still working on..." | Reset `awaitingTalkResponse`, tiếp tục monitor |

#### Bước 3: Recovery Attempts (checkCount > 0)
- Gửi TALK với prompt `RECOVERY ATTEMPT ${checkCount + 1}/${maxRetries}`
- Yêu cầu agent: complete task / report blocking / say cannot complete
- Nếu agent vẫn stuck sau `maxRetries` → Force STOP + báo cáo orchestrator

#### Bước 4: Force Stop & Report
- `stopAgent(agentId)` — cập nhật status = 'stopped', xóa client
- Tạo error message `[WATCHDOG FORCE-STOP]` gửi tới orchestrator
- Gọi `triggerOrchestrator()` để orchestrator quyết định bước tiếp theo

### 1.6 State Tracking (watchdogState)

```typescript
interface WatchdogState {
  checkCount: Map<string, number>;        // agentId → số lần flagged stuck
  lastTalkTime: Map<string, number>;      // agentId → timestamp last TALK
  awaitingTalkResponse: Set<string>;      // agentIds đang chờ phản hồi TALK
}
```

- Tự động dọn dẹp state khi agent chuyển sang `idle` hoặc `error`

### 1.7 Vận hành & Debug

**Log đặc trưng:**
```
[Watchdog] Agent coder-1 (agent-178745...) stuck for 185s — sending TALK to check status
[Watchdog] Agent coder-1 reports still working
[Watchdog] Agent coder-1 still stuck after 1 recovery attempt(s) — sending TALK with clearer instructions
[Watchdog] Agent coder-1 exceeded max retries (2) — forcing STOP and reporting to orchestrator
```

**API kiểm tra:**
- `GET /api/agents` — xem `status`, `workingSince` của từng agent
- WebSocket `agent:updated` — realtime status changes

---

## 2. Dynamic Model Configurations — Per-Agent Model Selector

### 2.1 Tổng quan

Mỗi agent (Orchestrator + Workers) giờ có thể chọn **model riêng biệt** thông qua UI. Model được lưu:
- **In-memory** (`agent.model`) — áp dụng ngay cho session hiện tại
- **Database** (`agents.model` column) — persist qua restart server
- **localStorage** (Legacy UI) — sync nhanh khi load trang

### 2.2 Luồng dữ liệu Model

```
┌──────────────┐     POST /api/agents/:id/model      ┌──────────────┐
│   UI (React   │ ──────────────────────────────────▶ │   Server     │
│  / Legacy)   │  { model: "gpt-4o" }                │  (server.ts) │
└──────────────┘                                     └──────┬───────┘
                                                             │
                    ┌────────────────────────────────────────┘
                    ▼
           ┌────────────────┐    ┌──────────────┐    ┌──────────────┐
           │ agent.model    │    │ storage.DB   │    │ ACPClient    │
           │ (in-memory)    │    │ (agents.model)│    │ .setModel()  │
           └────────────────┘    └──────────────┘    └──────────────┘
                    ▲                                        │
                    │         Restart Server                 │
                    └──────────── loadAgents() ─────────────┘
```

### 2.3 Cài đặt Model

#### React UI (Port 5173) — Dashboard.tsx

**Orchestrator Model Selector:**
```tsx
// Dòng 92-113: Dropdown cho Orchestrator
<select
  value={agents.find(a => a.id === 'orchestrator')?.model || ''}
  onChange={(e) => handleModelChange('orchestrator', e.target.value)}
>
  <option value="">— Default (inherit main)</option>
  {models.map(m => <option key={m} value={m}>{m}</option>)}
</select>
```

**Worker Model Selector (per agent):**
```tsx
// Dòng 164-188: Dropdown cho từng worker
<select
  value={agent.model || ''}
  onChange={(e) => {
    e.stopPropagation(); // Không trigger agent selection
    handleModelChange(agent.id, e.target.value);
  }}
>
  <option value="">— Default (inherit main)</option>
  {models.map(m => <option key={m} value={m}>{m}</option>)}
</select>
```

#### Legacy UI (Port 3001) — dist/index.html

- Sidebar: Mỗi agent card có `<select class="model-select">` bind `agent.model`
- Orchestrator card: Dropdown model riêng
- localStorage key: `agentforge-model-${agentId}`
- On load: `fetch('/api/agents')` → populate dropdowns từ `agent.model`
- On change: `POST /api/agents/${agentId}/model` → update server + localStorage

#### SpawnDialog.tsx — Model khi Spawn Agent Mới

```tsx
// Dòng 26-28: Load default từ localStorage
const [model, setModel] = useState('');
useEffect(() => {
  const saved = localStorage.getItem('default-worker-model');
  if (saved) setModel(saved);
}, []);
```

### 2.4 Endpoint API

**Cập nhật model agent:**
```
POST /api/agents/:id/model
Content-Type: application/json
{ "model": "gpt-4o" }  // hoặc null để dùng default
```

**Response:**
```json
{ "ok": true, "model": "gpt-4o" }
```

**Lấy danh sách model khả dụng:**
```
GET /api/models
Response: { "models": ["gpt-4o", "claude-3.5-sonnet", "gemini-1.5-pro", ...] }
```

### 2.5 Persistence & Restart Behavior

| Scenario | Model được dùng |
|----------|-----------------|
| Agent mới spawn (có chọn model) | Model đã chọn |
| Agent mới spawn (không chọn) | `default-worker-model` (localStorage) → `ORCHESTRATOR_MODEL` (env) |
| Server restart | Khôi phục từ `agents.model` column DB |
| Orchestrator restart | Khôi phục từ `orchAgent.model` DB → `process.env.ORCHESTRATOR_MODEL` |

### 2.6 Model Fallback (acp-client.ts)

Khi model chính fail (timeout, connection error, model not found):
1. Retry lên tới 3 lần với exponential backoff (1s, 2s, 4s)
2. Nếu có `FALLBACK_MODEL` env → dùng fallback model
3. Error classification: timeout / network / model_not_found → xử lý khác nhau

---

## 3. Background Ping Loop — Heartbeat Nền

### 3.1 Mục đích

Worker Watchdog chỉ check **từ server nhìn agent** (passive). Background Ping Loop thêm **heartbeat chủ động từ server → orchestrator** để:
- Orchestrator nhận biết workers đang active
- Orchestrator chủ động tổng hợp/kích hoạt check nếu cần
- Phát hiện deadlock: workers working nhưng orchestrator idle quá lâu

### 3.2 Cách thức hoạt động

```typescript
// src/server.ts — Background Ping Loop
const PING_INTERVAL_MS = 60000; // 60 giây

function startProgressPingLoop() {
  setInterval(() => {
    const workingWorkers = Array.from(agents.values())
      .filter(a => a.type === 'worker' && a.status === 'working');
    
    if (workingWorkers.length === 0) return; // Không worker working → skip
    
    const workerList = workingWorkers
      .map(a => `${a.name}(${a.role})`)
      .join(', ');
    
    const pingMsg = `[TO: orchestrator] PING: Progress check — workers active: ${workerList}`;
    
    // Gửi vào hàng đợi orchestrator (enqueue)
    getOrchClient().enqueue(pingMsg).catch(console.error);
    
    console.log(`[PingLoop] Workers active: ${workingWorkers.length} — pinging orchestrator`);
  }, PING_INTERVAL_MS);
}
```

### 3.3 Luồng Ping

```
Timer 60s tick
      │
      ▼
┌──────────────────┐
│ Có worker working? │── NO ──▶ Return (không ping)
└────────┬─────────┘
         │ YES
         ▼
┌─────────────────────┐
│ Build worker list   │
│ "coder-1(coder),    │
│  tester-1(tester)"  │
└────────┬────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Enqueue to Orchestrator:             │
│ [TO: orchestrator] PING: Progress    │
│ check — workers active: [...]        │
└──────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│ Orchestrator nhận PING trong prompt  │
│ → Có thể quyết định:                 │
│   - Tổng hợp progress (synthesize)   │
│   - Gửi TALK check status            │
│   - Chỉ log và tiếp tục              │
└──────────────────────────────────────┘
```

### 3.4 Cấu hình

| Biến môi trường | Mặc định | Mô tả |
|----------------|----------|-------|
| `PING_INTERVAL_MS` | 60000 | Khoảng ping (ms) |
| `AGENTFORGE_WORK_TIMEOUT` | 180000 | Watchdog stuck threshold (ms) |

### 3.5 Log đặc trưng

```
[PingLoop] Workers active: 2 — pinging orchestrator
[PingLoop] Workers active: 1 — pinging orchestrator
[PingLoop] No workers active — skipping ping
```

### 3.6 Tích hợp với Orchestrator Prompt

Orchestrator nhận PING như một message bình thường trong prompt. System prompt `ORCH_REMINDER` nhắc:
> "Monitor progress — if an agent works > 3 minutes, use TALK to ask for status"

Khi nhận PING, Orchestrator có thể:
- Gọi `[TALK agent-id=xxx message="Status check"]` cho worker cụ thể
- Tổng hợp progress từ các workers đang working
- Chỉ acknowledge và tiếp tục

---

## 4. Agent ID Display — UI Enhancements

### 4.1 Mục đích

Hiển thị **Agent ID** (`agent.id` dạng `agent-1787454750409`) cạnh tên agent trên cả hai UI để:
- Dễ dàng copy ID cho `[TALK agent-id=...]`
- Debug/trace log: map UI agent ↔ server log
- Phân biệt agents cùng role/tên

### 4.2 React UI (Dashboard.tsx)

```tsx
// Dòng 143-146: Thêm Agent ID vào header
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
  <div>
    <div style={{ fontWeight: 600, fontSize: 15 }}>{agent.name}</div>
    <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
      {agent.role} · <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{agent.id}</span>
    </div>
  </div>
```

### 4.3 Legacy UI (dist/index.html)

```html
<!-- Agent card template -->
<div class="agent-card" data-agent-id="${agent.id}">
  <div class="agent-header">
    <span class="agent-name">${agent.name}</span>
    <span class="agent-id">${agent.id}</span>
    <span class="agent-role">${agent.role}</span>
  </div>
  <select class="model-select" data-agent-id="${agent.id}">
    <option value="">— Default</option>
    <!-- models options -->
  </select>
</div>

<style>
.agent-id {
  font-family: monospace;
  font-size: 10px;
  color: #666;
  background: #222;
  padding: 1px 4px;
  border-radius: 3px;
  margin-left: 8px;
}
</style>
```

### 4.4 Copy-to-Clipboard (Legacy UI)

```javascript
// Click vào agent-id → copy to clipboard
document.querySelectorAll('.agent-id').forEach(el => {
  el.addEventListener('click', () => {
    navigator.clipboard.writeText(el.textContent);
    showToast(`Copied: ${el.textContent}`);
  });
  el.title = 'Click to copy Agent ID';
});
```

---

## 5. Scroll Fix — Legacy UI Right Panel

### 5.1 Vấn đề

Legacy UI (`dist/index.html`) panel chat bên phải:
- Không có `max-height` cố định → mở rộng không giới hạn
- Khi tin nhắn nhiều, panel tràn ra khỏi viewport
- Scrollbar không xuất hiện hoặc scroll không mượt

### 5.2 Giải pháp CSS

```css
/* dist/index.html — Style block */
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 200px); /* Trừ header + input */
  overflow: hidden;
}

.messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  /* Custom scrollbar */
  scrollbar-width: thin;
  scrollbar-color: #444 transparent;
}

.messages::-webkit-scrollbar {
  width: 8px;
}
.messages::-webkit-scrollbar-track {
  background: transparent;
}
.messages::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 4px;
}
.messages::-webkit-scrollbar-thumb:hover {
  background: #666;
}
```

### 5.3 HTML Structure

```html
<div class="chat-panel">
  <div class="panel-header">
    <span id="chat-title">Agent Name</span>
    <span id="agent-id-badge" class="agent-id-badge"></span>
    <select class="model-select"></select>
  </div>
  <div class="messages" id="messages">
    <!-- Tin nhắn render ở đây -->
  </div>
  <div class="input-area">
    <textarea id="msg-input"></textarea>
    <button id="send-btn">Send</button>
    <button id="stop-btn">Stop</button>
  </div>
</div>
```

### 5.4 Auto-scroll Behavior

```javascript
// Chỉ auto-scroll khi user đang ở gần bottom (tránh giật khi đọc tin cũ)
const messagesEl = document.getElementById('messages');
let shouldAutoScroll = true;

messagesEl.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = messagesEl;
  shouldAutoScroll = scrollHeight - scrollTop - clientHeight < 50;
});

// Khi append message mới
function appendMessage(msg) {
  messagesEl.appendChild(msg.element);
  if (shouldAutoScroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}
```

---

## 6. Agent Autonomy Prompts — Maximum Autonomy

### 6.1 Triết lý

Mục tiêu: **Agent tự chủ tối đa** — giảm thiểu can thiệp của Orchestrator, agent tự:
- Verify code trước khi report
- Phát hiện & báo bug (proactive)
- Quản lý session/context
- Tuân thủ format giao tiếp chuẩn

### 6.2 Cập nhật System Prompts

#### Worker Base Prompt (src/prompts/worker-base.md)

**Các section mới/bổ sung:**

```markdown
## SELF-TESTING & SELF-CORRECTION (MANDATORY)
Before reporting task completion, you MUST:
1. **Self-verify your work**: Run the code, execute tests, validate behavior matches requirements
2. **Check edge cases**: Test with null, empty, overflow, boundary values, wrong types
3. **Run regression checks**: Ensure existing functionality still works (run existing test suite if available)
4. **Verify error handling**: Confirm try/catch, validation, guard clauses work as intended
5. **No TODO/placeholder code**: All functions must be complete and production-ready

If you cannot self-verify (missing test framework, no way to run code), you MUST report this as a BLOCKER, not as completion.

### Self-Correction Loop
DO: Write/fix code
→ SELF-TEST: Run tests, check edge cases, verify behavior
→ IF FAILS: Fix immediately, re-test
→ IF PASSES: Report completion with test evidence

## PROACTIVE BUG FIXING
- If you discover a bug while working (even in unrelated code), report it immediately via `[TO: orchestrator]`
- If you can fix a discovered bug within your task scope, do so and include in your report
- If bug is outside scope, document it clearly: file, line, root cause, suggested fix
- Never silently leave known bugs — report them so they're tracked

## SESSION MANAGEMENT
- Your session persists across retries — context is preserved
- If STOP+RESUME occurs, your previous work context remains
- Don't repeat work — check what's already done

## COMMON RULES (All Workers)
1. You CANNOT spawn new agents — only the Orchestrator can
2. You CAN talk to any agent using `[TO: <target-id>] <message>`
3. You MUST report completion — never just stop silently
4. You MUST read before you write — understand the codebase first
5. You MUST NOT modify files outside your task scope
6. You MUST preserve existing functionality — no regressions
7. You MUST use the `[TO:]` format for ALL communication
8. If requirements are vague — ASK the Orchestrator before coding
```

#### Role-Specific Prompts (src/prompts/roles/*.md)

Mỗi role (coder, reviewer, tester, docs, planner, researcher, verifier, debugger, searcher, idea) có thêm:

```markdown
## ROLE-SPECIFIC AUTONOMY RULES

### For [ROLE]:
- [Quy tắc tự verify đặc thù role]
- [Format report JSON bắt buộc với fields riêng role]
- [Proactive actions đặc thù role]

### Self-Testing Checklist for [ROLE]:
- [ ] [Checklist items cụ thể role]

### Proactive Actions for [ROLE]:
- [Hành động chủ động đặc thù role]
```

**Ví dụ Coder:**
```markdown
### Self-Testing Checklist for Coder:
- [ ] Code compiles/lints without errors
- [ ] Unit tests pass (run `npm test` or equivalent)
- [ ] Edge cases handled: null, empty, boundary, wrong types
- [ ] No console.log/debugger left in production code
- [ ] Follows existing code style (check .eslintrc, prettier)

### Proactive Actions for Coder:
- If you see duplicate code → extract to shared utility
- If you see missing error handling → add it
- If you see potential security issue → report + fix
- If you see performance anti-pattern → optimize
```

**Ví dụ Tester:**
```markdown
### Self-Testing Checklist for Tester:
- [ ] All new tests pass
- [ ] Existing test suite still passes (regression)
- [ ] Coverage meets threshold (>= 80%)
- [ ] Tests are independent (no order dependency)
- [ ] Test names descriptive (what + expected)

### Proactive Actions for Tester:
- If you find untested code paths → add tests
- If you find flaky tests → report root cause
- If you see missing edge cases in source → add tests for them
```

### 6.3 Prompt Injection (Server-side)

Server tự động inject reminders vào **mọi lượt chat**:

```typescript
// src/server.ts — ORCH_REMINDER (dòng 112-120)
const ORCH_REMINDER = `\n\n=== SYSTEM REMINDER ===
You are the Orchestrator. You MUST communicate with workers using:
[SPAWN role=<role> name=<name> task=<task>]
[TALK agent-id=<agent-id> message=<message>]
[STOP AGENT target-id=<agent-id>]
[RESUME AGENT target-id=<agent-id>]
[DELETE AGENT target-id=<agent-id>]

Always decompose tasks before spawning. Do NOT do the work yourself.
Respond to the user in a clear, concise way.`;

// WORKER_REMINDER / WORKER_FORMAT_BLOCK (dòng 562-569)
const WORKER_FORMAT_BLOCK = `
=== RESPONSE FORMAT (MANDATORY) ===
End your reply with one or more routing lines, each on its own line:
[TO: <target-id>] <message for that target>
- To report your result to the Main Orchestrator, you MUST end with: [TO: orchestrator] <concise report>
- To message another agent, use its exact ID from the Members list.
- NEVER spawn subagents. Only the Orchestrator spawns.
====================================`;
```

**Được inject vào:**
- Orchestrator: mọi lượt chat (chat trực tiếp, triggerOrchestrator, synthesize)
- Workers: spawn task, talk, direct chat, resume

### 6.4 Kết quả mong đợi

| Trước khi cập nhật | Sau khi cập nhật |
|-------------------|------------------|
| Agent quên format `[TO:]` sau vài lượt | Mọi reply đều có `[TO: orchestrator]` |
| Agent report "done" chưa test | Agent bắt buộc self-test → evidence trong report |
| Agent im lặng khi gặp bug ngoài scope | Agent report bug ngay với file/line/root cause |
| Agent lặp lại work sau resume | Agent check context → tiếp tục từ chỗ dừng |
| Orchestrator phải nhắc nhở format | Agent tự tuân thủ nhờ reminder mỗi lượt |

---

## 7. Quick Reference — Commands & Configs

### 7.1 Environment Variables

```bash
# Server
PORT=3001
ORCHESTRATOR_MODEL=gpt-4o              # Default model cho Orchestrator
FALLBACK_MODEL=gpt-4o-mini             # Fallback khi model chính fail
AGENTFORGE_RUN_TIMEOUT=300000          # opencode run timeout (ms)
AGENTFORGE_WORK_TIMEOUT=180000         # Watchdog stuck threshold (ms)
PING_INTERVAL_MS=60000                 # Background ping interval (ms)
```

### 7.2 Key Endpoints

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/agents` | List tất cả agents (kèm model, status, sessionTitle) |
| POST | `/api/agents` | Spawn agent mới (body: name, role, type, projectDir, task, model) |
| POST | `/api/agents/:id/model` | Cập nhật model cho agent |
| POST | `/api/agents/:id/abort` | Abort agent đang chạy |
| DELETE | `/api/agents/:id` | Xóa agent + session |
| GET | `/api/models` | List models từ `opencode models` |
| POST | `/api/chat` | Gửi tin nhắn (orchestrator hoặc agent) |
| GET | `/api/history` | Lịch sử chat |

### 7.3 WebSocket Events

| Event | Payload | Mô tả |
|-------|---------|-------|
| `agent:created` | `{ agent }` | Agent mới được spawn |
| `agent:updated` | `{ agent }` | Agent status/model/sessionTitle thay đổi |
| `agent:deleted` | `{ id }` | Agent bị xóa |
| `chat:message` | `{ msg }` \| `{ action: 'clear' }` | Tin nhắn mới hoặc clear conversation |

### 7.4 Orchestrator Commands (Tags)

```text
[SPAWN role=coder name="api-builder" task="Create REST API with JWT auth"]
[TALK agent-id=agent-1787454750409 message="Add rate limiting to /login"]
[STOP AGENT target-id=agent-1787454750409]
[RESUME AGENT target-id=agent-1787454750409]
[DELETE AGENT target-id=agent-1787454750409]
[CREATE ROLE name=security-auditor description="Audit code for security" capabilities="security-review,threat-modeling" rules="Check OWASP Top 10|Verify auth flows|No code changes"]
```

### 7.5 Worker Report Format (JSON Preferred)

```json
{
  "agent_id": "agent-1787454750409",
  "role": "coder",
  "task_id": "task-123",
  "status": "completed",
  "summary": "Created JWT auth middleware with token refresh",
  "files_changed": ["src/auth/middleware.ts", "src/auth/jwt.ts"],
  "details": "Implemented HS256 signing, 15min access + 7d refresh tokens",
  "issues": [],
  "next_steps": ["Add rate limiting", "Write integration tests"],
  "artifacts": { "test_results": "15/15 passed", "coverage": "87%" }
}
```

---

## 8. Troubleshooting

### 8.1 Watchdog không kích hoạt

**Kiểm tra:**
- `WORKER_WATCHDOG_CONFIG.stuckThresholdMs` có đúng 180000 không?
- Agent có `status === 'working'` và `workingSince` được set không?
- Watchdog timer có chạy không? (log `[Watchdog] Agent monitoring started`)

### 8.2 Model không persist sau restart

**Kiểm tra:**
- DB migration đã chạy? (log `[Storage] Migrated: added model to agents`)
- `storage.updateAgentModel()` được gọi khi đổi model?
- `loadAgents()` có khôi phục `row.model` không?

### 8.3 Background ping không gửi

**Kiểm tra:**
- Có worker `status === 'working'` không?
- `startProgressPingLoop()` được gọi ở startup? (dòng 1571 server.ts)
- Orchestrator client có sẵn không? (`getOrchClient()`)

### 8.4 Legacy UI scroll không hoạt động

**Kiểm tra:**
- `.chat-panel` có `max-height: calc(100vh - 200px)` không?
- `.messages` có `overflow-y: auto` không?
- Không có CSS xung đột `overflow: hidden` trên parent?

### 8.5 Agent ID không hiển thị

**Kiểm tra:**
- `buildTeam()` có thêm `ID: ${a.id}` không? (dòng 598 server.ts)
- Dashboard.tsx render `agent.id` không?
- dist/index.html template có `.agent-id` không?

---

## 9. Migration Checklist (Từ version cũ)

- [ ] Chạy `npm install` cập nhật dependencies
- [ ] Chạy `npm run build` build React UI
- [ ] Khởi động server: `npm run dev` (cổng 3001)
- [ ] Khởi động web: `npm run dev:web` (cổng 5173)
- [ ] Mở http://localhost:3001 (Legacy) và http://localhost:5173 (React)
- [ ] Spawn agent test: chọn Role + Model → verify model lưu DB
- [ ] Restart server → verify model khôi phục
- [ ] Test watchdog: tạo agent, làm task > 3 phút không report → quan sát log TALK
- [ ] Test ping loop: có worker working → quan sát log `[PingLoop]` mỗi 60s
- [ ] Verify Agent ID hiển thị trên cả hai UI
- [ ] Verify scroll panel chat Legacy UI

---

## 10. Files Modified Summary

| File | Changes |
|------|---------|
| `src/server.ts` | Watchdog config, background ping loop, prompt reminders, buildTeam Agent ID, model endpoint |
| `src/storage.ts` | Model column migration, `updateAgentModel()`, `loadAgents()` restore model |
| `web/src/components/SpawnDialog.tsx` | Model dropdown, default from localStorage |
| `web/src/components/Dashboard.tsx` | Model dropdown per agent, Agent ID display |
| `web/src/App.tsx` | `updateAgentModel()` handler |
| `dist/index.html` | Legacy UI: model selectors, Agent ID, scroll fix, localStorage sync |
| `src/prompts/worker-base.md` | Autonomy rules, self-testing, proactive bug fixing |
| `src/prompts/roles/*.md` (10 files) | Autonomy rules per role |

---

*Document version: 2026-08-23 — AgentForge v7*