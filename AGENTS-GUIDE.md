# AgentForge — Hướng dẫn cho Orchestrator & Agents

## Tổng quan

AgentForge là hệ thống multi-agent với cấu trúc:

```
┌─────────────────────────────────────────────────────────┐
│                      USER                                │
│                   (Nhập task)                            │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              🧠 MAIN ORCHESTRATOR                        │
│  • Phân tích task                                        │
│  • Phân thành subtask                                    │
│  • Spawn agents với role cụ thể                         │
│  • Giao task cho agents                                  │
│  • Tổng hợp kết quả                                     │
└──────────┬──────────┬──────────┬────────────────────────┘
           │          │          │
           ▼          ▼          ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │ 🔨 Coder │ │ 🧪 Tester│ │ 📝 Docs  │
     │ Agent    │ │ Agent    │ │ Agent    │
     └──────────┘ └──────────┘ └──────────┘
```

---

## 1. MAIN ORCHESTRATOR — Vai trò và Cách spawn

### Vai trò

Orchestrator là **bộ não** điều phối:
- **Nhận task** từ user
- **Phân tích** và chia thành subtask
- **Spawn** agents với role phù hợp
- **Giao task** với context rõ ràng
- **Theo dõi** tiến độ
- **Tổng hợp** kết quả

### Cách Spawn Agent

Khi muốn spawn agent, output theo format:

```
[SPAWN role=<role> name="<tên>" task="<mô tả task>"]
```

**Ví dụ:**

```
User: "Xây REST API Express.js với tests và README"

Orchestrator output:
Tôi sẽ phân task và spawn 3 agents:

[SPAWN role=coder name="api-builder" task="Create Express.js REST API with CRUD endpoints for /users. Use SQLite for storage. Include error handling and validation."]

[SPAWN role=tester name="test-writer" task="Write unit tests for the Express.js API. Test all CRUD operations, error cases, and edge cases. Use Jest."]

[SPAWN role=docs name="doc-writer" task="Write README.md with API documentation, setup instructions, and usage examples."]
```

### Role có thể spawn

| Role | Khi nào spawn | Ví dụ task |
|------|--------------|------------|
| **coder** | Viết code, implement features, fix bugs | "Create auth module with JWT" |
| **reviewer** | Review code, tìm bugs, security | "Review payment module for security" |
| **tester** | Viết tests, chạy tests | "Write unit tests for user service" |
| **docs** | Viết docs, README, comments | "Write API documentation" |
| **planner** | Phân tích codebase, tạo plan | "Analyze architecture, create migration plan" |

### Cách giao task cho Agent

Mỗi task cần có:

```
[SPAWN role=coder name="auth-builder" task="
Build authentication module with:
- JWT token generation
- Login/register endpoints
- Password hashing with bcrypt
- Middleware for protected routes
Files to modify: src/auth/, src/middleware/
Coding style: Follow existing patterns in src/
"]
```

**Cấu trúc task tốt:**
1. **Mô tả cụ thể** — không chung chung
2. **Files liên quan** — agent cần biết ở đâu
3. **Constraints** — style, library, pattern
4. **Expected output** — kết quả mong đợi

---

## 2. WORKER AGENTS — Vai trò và Cách giao tiếp

### Vai trò từng Agent

#### 🔨 Coder Agent

```
ROLE: Coder
TASK: Viết code, implement features, fix bugs
TOOLS: Đọc, Ghi, Sửa file, Chạy shell
QUYỀN: Đọc + Ghi + Edit + Bash
```

**Khi nhận task:**
1. Đọc files liên quan
2. Hiểu architecture hiện tại
3. Viết code theo patterns có sẵn
4. Test code trước khi report
5. Report kết quả

**Format report:**
```
=== TASK REPORT ===
STATUS: completed
FILES CREATED: [src/auth/jwt.ts, src/auth/middleware.ts]
FILES MODIFIED: [src/routes/index.ts]
WHAT I DID: 
- Created JWT authentication module
- Added login/register endpoints
- Added auth middleware for protected routes
ISSUES: None
SUGGESTIONS: Consider adding refresh token support
=== END REPORT ===
```

#### 🧪 Tester Agent

```
ROLE: Tester
TASK: Viết tests, chạy tests, verify functionality
TOOLS: Đọc file, Chạy tests
QUYỀN: Đọc + Bash (cho test runner)
```

**Khi nhận task:**
1. Đọc source code cần test
2. Viết tests cho happy path + edge cases
3. Chạy tests
4. Report kết quả

**Format report:**
```
=== TASK REPORT ===
STATUS: completed
TESTS CREATED: [tests/auth.test.ts, tests/jwt.test.ts]
TESTS PASSED: 15/15
COVERAGE: 85%
WHAT I TESTED:
- Login với valid credentials
- Login với invalid password
- Register duplicate email
- JWT token expiration
ISSUES: 1 flaky test (timing-related)
=== END REPORT ===
```

#### 📝 Docs Agent

```
ROLE: Docs
TASK: Viết documentation, README, comments
TOOLS: Đọc, Ghi file
QUYỀN: Đọc + Ghi (docs only)
```

**Khi nhận task:**
1. Đọc source code
2. Viết docs mô tả chức năng
3. Thêm examples
4. Update README

**Format report:**
```
=== TASK REPORT ===
STATUS: completed
FILES CREATED: [docs/auth-api.md]
FILES MODIFIED: [README.md]
WHAT I DOCUMENTED:
- Auth API endpoints
- JWT token flow
- Setup instructions
=== END REPORT ===
```

#### 🔍 Reviewer Agent

```
ROLE: Reviewer
TASK: Review code, tìm bugs, suggest improvements
TOOLS: Đọc file
QUYỀN: Đọc only (KHÔNG ghi/sửa)
```

**Khi nhận task:**
1. Đọc code được chỉ định
2. Phân tích quality, security, performance
3. Gợi ý cải thiện
4. KHÔNG sửa code

**Format report:**
```
=== REVIEW REPORT ===
OVERALL: approve
ISSUES FOUND: 0
SUGGESTIONS:
- Consider adding rate limiting to auth endpoints
- Add input sanitization for email field
SECURITY: No critical issues found
=== END REPORT ===
```

#### 📋 Planner Agent

```
ROLE: Planner
TASK: Phân tích codebase, tạo implementation plan
TOOLS: Đọc file
QUYỀN: Đọc only
```

**Khi nhận task:**
1. Scan codebase
2. Hiểu architecture
3. Tạo step-by-step plan
4. Identify risks

**Format report:**
```
=== PLAN REPORT ===
ANALYSIS: Current auth uses session-based, need to migrate to JWT
SUBTASKS:
1. Create JWT utility module
2. Update login endpoint
3. Add token refresh
4. Update middleware
5. Migrate existing sessions
FILES TO MODIFY: [src/auth/*, src/middleware/*]
DEPENDENCIES: None (fresh module)
RISKS: Session migration may break existing users
EFFORT: ~4 hours
=== END REPORT ===
```

---

## 3. Communication Protocol

### Agent → Orchestrator

Mỗi agent report về orchestrator theo format:

```
=== TASK REPORT ===
STATUS: [completed/failed]
FILES CREATED: [list]
FILES MODIFIED: [list]
WHAT I DID: [summary]
ISSUES: [problems]
SUGGESTIONS: [next steps]
=== END REPORT ===
```

### Orchestrator → Agent

Orchestrator giao task:

```
=== AGENT BRIEFING ===
ROLE: <coder/tester/docs/reviewer/planner>
YOUR TASK: <cụ thể>
CONTEXT: <files, errors, previous work>
CONSTRAINTS: <style, library, rules>
COMMUNICATION: Report back with structured results
=== END BRIEFING ===
```

### Agent → Agent (qua Orchestrator)

Nếu agent cần info từ agent khác:

```
=== AGENT-TO-AGENT REQUEST ===
FROM: tester-agent
TO: coder-agent
REQUEST: "Cần biết parameter types cho auth middleware"
=== END REQUEST ===
```

Orchestrator sẽ route message và trả lời.

---

## 4. Workflow ví dụ

### Ví dụ 1: Xây REST API

```
User: "Xây REST API cho todo app với Express.js"

Orchestrator phân tích:
1. Viết API endpoints (coder)
2. Viết tests (tester)
3. Viết docs (docs)

→ Spawn 3 agents song song:

[SPAWN role=coder name="api-builder" task="Create Express.js REST API for todo app with CRUD endpoints: GET/POST/PUT/DELETE /todos. Use SQLite. Include validation and error handling."]

[SPAWN role=tester name="test-writer" task="Write unit tests for todo API. Test all CRUD operations, empty states, invalid input. Use Jest + supertest."]

[SPAWN role=docs name="doc-writer" task="Write README.md with API docs, setup instructions, and example requests using curl."]

→ Agents chạy song song
→ Kết quả tổng hợp
→ Report cho user
```

### Ví dụ 2: Fix bug

```
User: "API login bị lỗi 500 khi email chứa ký tự đặc biệt"

Orchestrator:
1. Spawn reviewer để phân tích root cause
2. Spawn coder để fix
3. Spawn tester để verify

→ Pipeline: reviewer → coder → tester
```

### Ví dụ 3: Refactor

```
User: "Refactor module auth từ session sang JWT"

Orchestrator:
1. Spawn planner để tạo migration plan
2. Spawn coder để implement
3. Spawn reviewer để review
4. Spawn tester để verify
5. Spawn docs để update documentation

→ Pipeline: planner → coder → reviewer → tester → docs
```

---

## 5. Rules quan trọng

### cho Orchestrator

1. **Luôn phân task** trước khi delegate
2. **Giao task cụ thể** — không chung chung
3. **Include context** — files, errors, patterns
4. **Chạy parallel** khi có thể
5. **Monitor progress** — check agents thường xuyên
6. **Handle failures** — reassign nếu agent fail
7. **Synthesize** — tổng hợp kết quả rõ ràng
8. **Proactive Inspection** — chủ động kiểm tra trạng thái agent; không chờ user nhắc nhở. Quá 3 phút (180s) không phản hồi → BẮT BUỘC [TALK] / PING hỏi status ngay.
9. **Non-blocking delegation** — khi agent đang `working`, KHÔNG giao thêm việc; chuyển task cho agent `idle` hoặc [SPAWN] mới để chạy song song 100%.
10. **Dangling job cleanup** — chủ động rà soát & dọn dẹp các job treo (dangling); không để task kẹt vĩnh viễn trong hàng đợi.

### cho Agents

1. **Hiểu role** — coder code, tester test, docs write
2. **Đọc context** — files, patterns, style
3. **Test trước khi report** — không submit code chưa test
4. **Report structured** — theo format chuẩn
5. **Không超越 role** — reviewer KHÔNG sửa code
6. **Ask if stuck** — không tự ý quyết định lớn

---

## 6. Session Tracking — Cách agents nhớ và tiếp tục cuộc nói chuyện

### Vấn đề

Mỗi `opencode run` tạo session mới. Nếu không lưu session ID, orchestrator không thể:
- Nói tiếp với agent đã spawn
- Agent nhớ context trước đó
- Agent biết cách report về

### Giải pháp

AgentForge tự động:

1. **Spawn**: Tạo agent → tạo OpenCode session → lưu session ID
2. **Chat**: Dùng session ID để tiếp tục (không tạo session mới)
3. **Report**: Agent report với agent ID + session ID
4. **Resume**: Orchestrator dùng `[TALK agent-id=xxx]` để nói tiếp

### Flow chi tiết

```
1. User: "Build auth module"

2. Orchestrator spawn:
   [SPAWN role=coder name="auth-builder" task="Create JWT auth"]
   
   → Server tạo agent:
     - agent.id = "agent-1787412345"
     - agent.sessionId = (từ opencode)
     - agent.spawnedBy = "orchestrator"
     - agent.task = "Create JWT auth"

3. Agent chạy task:
   opencode run "<full context with session>" --auto
   → Agent nhận task với:
     - Tên: auth-builder
     - ID: agent-1787412345
     - Session ID: ses_xxx
     - Team info: [list agents khác]
     - How to report: format chuẩn

4. Agent hoàn thành:
   → Output TASK REPORT với AGENT_ID
   → Server detect report → lưu vào chatHistory
   → Broadcast đến GUI

5. Orchestrator muốn nói tiếp:
   [TALK agent-id=agent-1787412345 message="Add error handling"]
   
   → Server tìm agent → dùng session ID → tiếp tục conversation
```

### Key Format

**Spawn:**
```
[SPAWN role=coder name="worker-1" task="Build REST API"]
```

**Talk to existing agent:**
```
[TALK agent-id=agent-1787412345 message="Can you add tests?"]
```

**Agent report back:**
```
=== TASK REPORT ===
AGENT_ID: agent-1787412345
AGENT_NAME: auth-builder
STATUS: completed
FILES CREATED: [src/auth/jwt.ts]
WHAT I DID: Created JWT module
=== END REPORT ===
```

**Agent request help:**
```
=== REQUEST FROM AGENT ===
FROM: agent-1787412345 (auth-builder)
TO: agent-1787412346 (test-writer)
REQUEST: Need auth middleware signature for writing tests
=== END REQUEST ===
```

### Lưu ý quan trọng

1. **Mỗi agent có 1 session** — được lưu trong `agent.sessionId`
2. **Session tiếp tục được** — dùng `opencode run --session <id>`
3. **Agent biết parent** — `agent.spawnedBy` = orchestrator ID
4. **Agent biết team** — inject team context vào prompt
5. **Agent biết cách report** — format chuẩn trong system prompt
6. **Orchestrator có thể talk tiếp** — dùng `[TALK agent-id=xxx]`

---

## 7. Heartbeat va PING — Khi nao ping, khi nao dung

### Chu ky hoat dong cua 1 agent working

1. Agent bat dau task: status = working, workingSince = thoi diem bat dau
2. Sau 150s (2 phut ruoi) im lang: server tu gui PING
   - Noi dung: [SYSTEM] PING: You have been working for Xs without update. Immediately reply with [TO: orchestrator] PROGRESS: ... or NEED CLARIFICATION: ...
   - Response agent duoc luu chatHistory voi msgType=ping, broadcast len GUI
   - Anti-loop: lastPingAt chan ping lap lai trong 150s
3. Sau 180s (HEARTBEAT_TIMEOUT): heartbeat chinh thuc thay the PING
   - Server force status = idle, roi chat lai voi agent
   - Neu response chua STATUS: completed → giu idle + goi checkAndSynthesize (tong hop ket qua)
   - Neu chua xong → status = working, workingSince = now (chu ky moi bat dau tu dau)
   - Neu loi → status = error

### PING dung khi nao

- Agent het trang thai working (idle/error/stopped) → loop bo qua, khong con PING
- Qua 180s → khong con PING, chuyen sang heartbeat
- Vua ping roi trong 150s → khong ping tiep
- Sau heartbeat neu van working → chu ky PING lap lai tu dau (workingSince da reset)

### Tham so cau hinh (src/server.ts)

- PING threshold: 150_000 ms (dong ~435)
- PING anti-loop: 150_000 ms (dong ~437)
- HEARTBEAT_TIMEOUT: 180_000 ms (dong 15)
- HEARTBEAT_INTERVAL: 60_000 ms — loop check moi phut (dong 14)

---

## 8. Cac phuong thuc giao tiep voi opencode (v1.18)

### Bang so sanh

| Phuong thuc | Co che | Diem manh / Yeu |
|---|---|---|
| opencode run (dang dung) | one-shot process, JSONL stdout voi --format json | Don gian, cach lap tot / moi luot 1 process, khong nhan giua chung |
| opencode serve | Headless HTTP server (REST + SSE) | 1 server cho moi agent, POST message vao session bat ky, stream events realtime qua SSE, queue noi bo, nhieu client xem cung luc — huong chat stream chinh thong |
| opencode attach <url> | TUI gan vao server dang chay | Xoi hoi thoai live ngay trong terminal (dung y "man hinh opencode tui") |
| opencode acp | ACP server JSON-RPC over stdio | 2 chieu chuan hoa (Zed protocol) |
| opencode web | Server + web UI co san | Khong can tu lam GUI |
| opencode export/import | Xuat/nhap session JSON | Luu tru/phan tich, khong phai chat |

### Danh gia cho AgentForge

- Hien tai: opencode run --auto --format json — moi luot spawn process moi, doc JSONL events (step_start/tool_use/text/step_finish/error), parse thanh content + transcript nguyen van
- Neu nang cap lon: chuyen sang opencode serve + SSE — giai quyet 2 van de: nhan duoc tin khi agent dang ban (server queue) va tee prompt/events len GUI realtime; kem opencode attach de doi truc tiep tu terminal
- Luu y: nested opencode run tu shell trong phien opencode khac se loi Unexpected server error do env OPENCODE_PID ke thua — chi test qua server AgentForge hoac unset OPENCODE_PID

### Cau truc JSONL event cua run --format json (tham khao)

- step_start: bat dau step (part.snapshot)
- tool_use: part.tool (bash/read/write/grep...), part.state.input/output/title/metadata, status completed
- text: part.text = loi thoai model
- step_finish: part.reason = stop (cuoi) | tool-calls (tiep), part.cost, part.tokens
- error: error.name, error.data.message

Moi dong 1 JSON, deu co sessionID (ses_XXX) va timestamp (ms).

---

## 9. Giai thich ky: opencode attach va opencode acp

### attach = man hinh thu 2 gan vao server dang chay

Kien truc opencode tach roi: SERVER (bo nao — quan ly session, goi LLM, chay tools) va CLIENT TUI (chi la man hinh hien thi). Khi mo opencode binh thuong, no khoi dong server ngam + 1 TUI de ban nhin.

- Lenh: opencode attach http://127.0.0.1:4096
- Mo them 1 TUI khac connect vao dung server do: KHONG tao server moi, KHONG tao session moi
- Vi du AgentForge: server serve chay ngam cho agents lam viec; mo terminal moi go attach; hien giao dien giong TUI thuong, thay tung tool call, tung dong text agent dang go, live
- Attach duoc nhieu man hinh cung luc — giong nhieu nguoi xem 1 livestream
- Options chinh: --session <id> (mo dung session can xem), -c continue last, --mini, -u/-p basic auth

### acp = bien opencode thanh thiet bi bi dieu khien theo giao thuc chuan

ACP = Agent Client Protocol (chuan cua Zed editor): HOST (app cua ban) va AGENT PROCESS (opencode) noi chuyen bang JSON-RPC qua stdin/stdout cua process.

- Lenh spawn: opencode acp --cwd <project> → process song lien ho (long-running)
- Host ghi JSON vao stdin: initialize → session/new → session/prompt (gui task)
- Agent tra JSON ra stdout: stream session/update (text delta, tool_call...) lien tuc den khi xong
- LUU Y QUAN TRONG: AI model KHONG thay ACP, khong phai "ep AI dung tool". ACP nam o tang ung dung bao ngoai model: host va opencode-process noi chuyen truc tiep voi nhau qua stdin/stdout (dung nhu 2 ben dang thoai); viec goi LLM ben trong la cong viec rieng cua opencode, host khong can biet
- Khac run: run la ban 1 phat roi thoat; acp la 1 duong dien thoai giu may — nhan duoc nhieu lan, nhan update realtime, khong spawn lai

### So sanh 3 cach noi chuyen voi agent

`
run    : spawn → nhan 1 tin → nhan ket qua → chet           (AgentForge dang dung)
acp    : spawn 1 lan ↔ noi chuyen lien tuc qua stdin/stdout (JSON-RPC)
serve  : server HTTP doc lap ← moi client (GUI/attach/web) noi chuyen qua network (REST+SSE)
`

---

## 10. opencode serve — kha nang chi tiet (docs chinh thuc)

### Tong quan

- opencode serve chay headless HTTP server, mac dinh 127.0.0.1:4096 (--port, --hostname, --cors, --mdns)
- OpenAPI 3.1 spec tai /doc — dung sinh client tu dong; SDK JS chinh thuc (@opencode-ai/sdk) cung sinh tu spec nay
- Auth basic: OPENCODE_SERVER_PASSWORD / OPENCODE_SERVER_USERNAME
- Kien truc: TUI chi la 1 client; server moi la lo. Nhieu client cung noi vao 1 server

### Nhóm API quan trong

| Nhom | Endpoint | Chuc nang |
|---|---|---|
| Sessions | POST /session | Tao session moi (body: parentID?, title?) |
| | GET /session/status | Trang thai cac session (biet session nao BUSY) |
| | POST /session/:id/abort | Ngat session dang chay |
| | POST /session/:id/fork | Nhanh session tai 1 message (thu nghiem an toan) |
| | POST /session/:id/revert + unrevert | Undo/phuc hoi tin nhan |
| | GET /session/:id/diff | Xem diff file cua session |
| Messages | POST /session/:id/message | Gui tin dong bo — cho ket qua tra ve |
| | POST /session/:id/prompt_async | Gui tin KHONG cho (204 ngay) |
| | POST /session/:id/command | Chay slash command |
| | POST /session/:id/shell | Chay shell qua agent |
| Events | GET /event | SSE stream realtime MOI event: tung text part, tool call, step... (co sessionID de phan biet) |
| Files | GET /find, /find/file, /file/content | Grep text, tim file, doc file qua HTTP |
| TUI control | POST /tui/append-prompt, /tui/submit-prompt | Dieu khien TUI tu xa (plugin IDE dung cach nay) |
| Permissions | POST /session/:id/permissions/:permissionID | Tu dong respond permission request |
| MCP | POST /mcp | Them MCP server runtime |

### Nhieu session trong 1 chuong trinh?

CO:
- 1 server quan ly VOI SO session: POST /session tao tung cai, moi session doc lap context/history; GET /session liet ke het
- /event SSE stream GOP event cua MOI session — moi event co sessionID de phan luong
- /session/status cho biet session nao dang busy/de roi
- Muon cach ly project khac nhau: chay nhieu instance server tren cac port khac nhau (moi instance gan 1 project dir)

### Ung dung vao AgentForge — giai quyet 3 van de

1. Tee 2 duong that su: giu GET /event SSE → day tung part (text + tool call) len GUI realtime khi agent dang lam, khong doi xong moi thay
2. Nhan tin khi agent dang ban: prompt_async + check /session/status; ngat bang abort; van nen co queue phia AgentForge
3. Doi live tu terminal: opencode attach http://127.0.0.1:4096

### Luu y thuc te

- Issue #13416 (GitHub): REST mode doi khi tra ca chuoi parts trong 1 response thay vi stream — can test ky endpoint message sync/async truoc khi chuyen
- Nested opencode run tu phien opencode khac loi OPENCODE_PID — khi migrate sang serve se khong con van de nay vi AgentForge noi chuyen qua HTTP thay vi spawn CLI

### Ket qua thuc chung Phase 1 (2026-08-23, v1.18.18 Windows)

- /global/health → { healthy: true, version: 1.18.18 } OK
- POST /session (body title) → tao session ses_xxx OK
- POST /session/:id/message (sync, body { parts:[{type:text,text:...}] }) → tra info + parts day du (step-start/reasoning/text), finish stop OK
- POST /session/:id/prompt_async → 204 ngay lap tuc OK
- GET /event SSE → 248 dong events realtime trong 20s gom: message.updated, message.part.updated (tu tung part: text/step-start/reasoning/tool), session.status (type busy), session.updated, session.diff — du dieu kien de tee len GUI theo thoi gian thuc va biet session ban ranh
- Ket luan: serve HOAT DONG TOT tren Windows v1.18.18, khong gap van de issue #13416 o cac endpoint da test → tien hanh Phase 2 viet ServeClient

## CONCURRENCY, QUEUE, SESSION AND STATE RULES (2026-08-25)

### 1. Non-Blocking Concurrency and Multi-Coder Load Balancing
- Khong giao them viec cho coder dang working. Orchestrator uu tien coder idle hoac spawn moi de chay song song.

### 2. Preemptive Interrupt Queue with 1s Debounce
- Tin moi den khi agent dang chay: sau debounce 1s, luot cu bi dung (tra [INTERRUPTED]) va luot moi chay ngay tren cung sessionId. Worker co the bi ngat giua tool — chap nhan va uu tien yeu cau moi nhat.

### 3. Persistent Sessions and Process-Authoritative Idle
- Session giu vinh vien suot vong doi server; khong co tu dong reset khi 404/format loi.
- status idle chi cap nhat khi process OS close that; spinner UI doc theo agent.status nen luon khop thuc te.

### 4. Team State Synchronization
- Moi lenh giao viec gan kem file path + dong cu the. Khi bao cao, neu ro file+dong da sua de verifier kiem tra nhanh.
