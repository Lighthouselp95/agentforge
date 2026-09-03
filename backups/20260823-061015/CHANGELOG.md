# Changelog

## [2026-08-23]
Vấn đề: Yêu cầu xây dựng ứng dụng máy tính Python cơ bản hỗ trợ cộng, trừ, nhân, chia và các bài test đi kèm.
Nguyên nhân: Khởi tạo mới ứng dụng máy tính và bộ test kiểm thử chất lượng code.
Giải pháp sửa đổi: 
- Tạo file calculator.py chứa các hàm add, subtract, multiply, và divide có kiểm tra kiểu dữ liệu đầu vào và xử lý chia cho 0.
- Tạo file test_calculator.py chứa 13 test case kiểm thử toàn bộ các hàm với các kiểu dữ liệu hợp lệ và không hợp lệ.

## [2026-08-23] - Hello World
Vấn đề: Tạo một ứng dụng Python Hello World đơn giản và viết một test case kiểm thử.
Nguyên nhân: Yêu cầu khởi tạo ứng dụng Hello World cơ bản và bộ test đi kèm.
Giải pháp sửa đổi:
- Xác minh sự tồn tại của hello.py để chắc chắn có hàm hello() in ra "Hello, World!".
- Tạo file test_hello.py để kiểm thử hàm hello() bằng cách mock sys.stdout và kiểm tra kết quả in ra.

## [v0.6.0] - 2026-08-23

### Vấn đề
- SPAWN regex không match (thiếu brackets `[` `]` trong response)
- Regex không xử lý `\r\n` Windows line endings
- Prompt quá dài bị shell escape phá vỡ
- Agents không follow format `[FROM: id] [TO: id]`
- Không lưu lịch sử vào DB — mất data khi restart

### Nguyên nhân
- Orchestrator output `SPAWN role=coder ...` thay vì `[SPAWN role=coder ...]`
- Regex dùng `$` (end of line) nhưng SPAWN tags có thể trên cùng 1 dòng
- Prompt chứa `"` và newlines phá vỡ shell command line
- Không có storage layer

### Giải pháp
- **Regex fix**: `[^\]\r\n]+?` thay vì `[^\]\n]+?` — xử lý Windows line endings
- **Non-line-based regex**: Bỏ `$` anchor, cho phép nhiều SPAWN trên 1 dòng
- **Temp file approach**: Ghi prompt vào temp file → `cat file | opencode run` — tránh shell escaping
- **MSG_FORMAT_INSTRUCTION**: Hướng dẫn rõ `[FROM: id] [TO: id]` format
- **SQLite storage**: `better-sqlite3` lưu agents + chat history — survive restart
- **Load state on startup**: Agents và messages được load từ DB

### Flow mới
```
1. User gõ task → Orchestrator nhận prompt với ORCH_PROMPT + TEAM + MSG_FORMAT
2. Orchestrator output [SPAWN role=coder name=alice task=...]
3. Server parse regex → spawn alice (coder) với system prompt từ .opencode/agents/coder.md
4. Alice chạy task → report [FROM: alice] [TO: orchestrator] === TASK REPORT ===
5. Bob chạy task → report [FROM: bob] [TO: orchestrator] === TASK REPORT ===
6. Tất cả lưu vào SQLite DB
7. Heartbeat kiểm tra mỗi 60s
```

### Files thay đổi
- `src/server.ts` — Regex fix, temp file, storage integration, MSG_FORMAT
- `src/agents/acp-client.ts` — Temp file approach cho prompts
- `src/storage.ts` — SQLite storage layer (NEW)

## [v0.7.0] - 2026-08-23

### Vấn đề
- Prompt hướng dẫn hệ thống chưa rõ ràng, thiếu rules và ví dụ
- Agents không follow format giao tiếp đúng [FROM/TO]
- Orchestrator không có ví dụ cụ thể về cách dùng SPAWN/TALK/STOP

### Nguyên nhân
- ORCH_PROMPT quá ngắn, không có ví dụ
- MSG_FORMAT_INSTRUCTION không có ví dụ cụ thể
- Agent files (.opencode/agents/*.md) thiếu rules chi tiết

### Giải pháp
- **ORCH_PROMPT mới**: ~1200 chars với 6 rules rõ ràng + 3 ví dụ SPAWN/TALK/STOP
- **MSG_FORMAT_INSTRUCTION mới**: ~800 chars với 3 ví dụ về [FROM/TO] format + TASK REPORT
- **Agent files mới**: Mỗi role có rules + 2 ví dụ về communication format
- **Coder**: Rules về reading code, handling edge cases, minimal changes
- **Tester**: Rules về running tests, edge cases, independent tests
- **Reviewer**: Rules về line-by-line review, security, performance
- **Docs**: Rules về writing for audience, code examples
- **Planner**: Rules về dependencies, risks, effort estimation

### Flow mới với ví dụ
```
User: "Build a Python calculator with tests"

Orchestrator output:
[SPAWN role=coder name=calc task=Create calculator.py with add(a,b), subtract(a,b), multiply(a,b), divide(a,b). Handle division by zero.]
[SPAWN role=tester name=test task=Create test_calculator.py with unit tests for all functions. Test edge cases.]

→ calc: [FROM: calc] [TO: orchestrator] === TASK REPORT === STATUS: completed === END REPORT ===
→ test: [FROM: test] [TO: orchestrator] === TASK REPORT === STATUS: completed === END REPORT ===

→ Orchestrator summarizes to user
```

### Files thay đổi
- `src/server.ts` — ORCH_PROMPT, MSG_FORMAT_INSTRUCTION với ví dụ
- `.opencode/agents/coder.md` — Rules + 2 ví dụ
- `.opencode/agents/tester.md` — Rules + 2 ví dụ
- `.opencode/agents/reviewer.md` — Rules + 1 ví dụ
- `.opencode/agents/docs.md` — Rules + 1 ví dụ
- `.opencode/agents/planner.md` — Rules + 1 ví dụ

## [v0.7.1] - 2026-08-23

### Vấn đề
- Spawn agent trùng tên tạo agents mới → nhầm lẫn, duplication
- Agent name không gắn cứng với agent ID và session ID

### Nguyên nhân
- SPAWN logic luôn tạo agent mới, không check tên trùng

### Giải pháp
- **findAgentByName()**: Tìm agent theo tên
- **Reuse logic**: Nếu SPAWN tên đã tồn tại → gửi task mới qua TALK (giữ nguyên ID + session)
- **Tạo mới chỉ khi tên chưa tồn tại**
- **ORCH_PROMPT updated**: Thêm rule "SPAWN trùng tên = REUSE agent cũ"

### Flow mới
```
Orchestrator: [SPAWN role=coder name=calc task=...]
→ Agent calc tạo (ID: agent-123, session: ses_xxx)

Orchestrator: [SPAWN role=coder name=calc task=new task]
→ REUSE calc (cùng ID: agent-123, cùng session: ses_xxx)
→ Gửi new task qua TALK
```

### Files thay đổi
- `src/server.ts` — findAgentByName(), SPAWN reuse logic, ORCH_PROMPT

## [v0.7.2] - 2026-08-23

### Vấn đề
- Bất kỳ agent nào cũng có thể SPAWN agents mới → không kiểm soát
- Worker agents có quyền SPAWN →乱用, tạo agents không mong muốn

### Nguyên nhân
- SPAWN parsing chạy cho tất cả responses, không phân biệt orchestrator hay worker

### Giải pháp
- **Chỉ orchestrator mới SPAWN được**: `const spawnRe = isOrchestrator ? ... : null`
- **Worker agents chỉ được**: TALK, STOP, RESUME, [FROM/TO] communication
- **ORCH_PROMPT**: Thêm rule "ONLY you can SPAWN"
- **Agent files**: Thêm rule "You CANNOT spawn new agents"

### Phân quyền
```
Orchestrator: SPAWN, TALK, STOP, RESUME
Worker agents: TALK, STOP, RESUME, [FROM/TO] communication
```

### Files thay đổi
- `src/server.ts` — isOrchestrator check cho SPAWN
- `.opencode/agents/*.md` — Thêm rule "CANNOT spawn"

## [v0.7.3] - 2026-08-23

### Vấn đề
- Agent name không gắn cứng với 1 agent ID
- Agent ID chưa xóa vẫn spawn agent mới với cùng tên → duplication

### Nguyên nhân
- Không có rule "1 tên = 1 ID"
- Không có DELETE command để xóa agents cũ

### Giải pháp
- **1 tên = 1 ID**: Nếu spawn tên đã tồn tại → REUSE (giữ nguyên ID + session)
- **DELETE command**: `[DELETE AGENT target-id=<id>]` — xóa vĩnh viễn agent
- **Flow đúng**: STOP → DELETE → SPAWN mới
- **ORCH_PROMPT**: Thêm DELETE command + ví dụ
- **parseAgentCommands**: Parse `[DELETE AGENT target-id=<id>]`

### Phân quyền mới
```
Orchestrator: SPAWN, TALK, STOP, RESUME, DELETE
Worker agents: TALK, STOP, RESUME, [FROM/TO]
```

### Files thay đổi
- `src/server.ts` — deleteAgent(), DELETE parsing, ORCH_PROMPT

## [v0.7.4] - 2026-08-23

### Vấn đề
- Agent không biết ai đang nói với mình khi nhận message
- `[FROM: orchestrator]` không nổi bật, agent dễ bỏ qua

### Nguyên nhân
- Message format quá đơn giản, thiếu header rõ ràng

### Giải pháp
- **Header mới**: `=== INCOMING MESSAGE === FROM: Orchestrator (ID: orchestrator) TO: agent-name (ID: agent-xxx, Role: coder) === MESSAGE === <content>`
- **Áp dụng cho**: Spawn, Reuse, TALK, User chat
- Agent biết rõ: Ai nói, ID gì, nói với ai, ID gì

### Message format mới
```
=== INCOMING MESSAGE ===
FROM: Orchestrator (ID: orchestrator)
TO: calc (ID: agent-123, Role: coder)
=== MESSAGE ===
Create calculator.py with add and subtract functions.
```

### Files thay đổi
- `src/server.ts` — senderHeader cho spawn, reuse, TALK

## [v0.7.5] - 2026-08-23

### Vấn đề
- Web chat không hiển thị lịch sử trò chuyện khi mở lại
- Messages lưu trong DB nhưng không load lên GUI

### Nguyên nhân
- HTML không có `loadHistory()` function
- Chỉ có WebSocket cho real-time, không fetch history từ API

### Giải pháp
- **loadHistory()**: Fetch `/api/history` → phân loại messages
- **Orchestrator chat**: Hiển thị user ↔ orchestrator messages
- **Agent chat**: Hiển thị user ↔ agent messages
- **Agent reports**: Hiển thị trong orchestrator chat với label tên agent
- **Init**: Gọi `loadHistory()` khi trang load

### Files thay đổi
- `dist/index.html` — loadHistory() function

## [v0.7.6] - 2026-08-23

### Vấn đề
- Agent prompts (.opencode/agents/*.md) quá sơ sài — chỉ role + format, thiếu personality, workflow awareness, proactive communication
- buildTeam() chỉ hiện status, không hiện task đang làm của từng agent
- Thiếu 4 roles mới: researcher, verifier, debugger, searcher
- DELETE agent không xóa OpenCode session đi kèm
- MSG_FORMAT_INSTRUCTION lặp lại mỗi lượt chat — lãng phí token

### Nguyên nhân
- Agent prompts viết lúc đầu chỉ focus vào format, không có behavioral context
- buildTeam() chỉ build status info, không có task context
- Chưa có role cho research, verification, debugging, search
- deleteAgent() chỉ xóa memory + DB, không gọi opencode session delete

### Giải pháp
- **Viết lại tất cả agent prompts** (coder, tester, reviewer, planner, docs):
  - Thêm Personality (tính cách đặc trưng)
  - Thêm Workflow Awareness (biết pipeline, upstream/downstream)
  - Thêm Proactive Behavior (khi nào chủ động talk, hỏi, đề xuất)
  - Thêm Quality Standards (tiêu chuẩn đầu ra)
  - Thêm Communication Protocol chi tiết (khi nào talk ai, format gì)
- **Thêm 4 agent roles mới**: researcher, verifier, debugger, searcher
- **buildTeam() update**: Thêm task info vào mỗi member — agent thấy ai đang làm task gì
- **DELETE session**: deleteAgent() gọi opencode session delete trước khi xóa agent
- **parseAgentCommands async**: Chuyển từ sync → async để hỗ trợ deleteSession
- **Backup**: Các file prompt cũ được backup vào `.opencode/agents/_backup_*`

### Agent Roles mới
- **Researcher**: Tìm thông tin, đọc docs, khám phá codebase. Luôn cite nguồn.
- **Verifier**: Xác nhận code đúng requirement. Systematic verification với checklist.
- **Debugger**: Tracing bugs, tìm root cause, fix. Reproduce trước khi fix.
- **Searcher**: Tìm file, code pattern, references. Exact paths + line numbers.

### Files thay đổi
- `.opencode/agents/coder.md` — Viết lại hoàn toàn
- `.opencode/agents/tester.md` — Viết lại hoàn toàn
- `.opencode/agents/reviewer.md` — Viết lại hoàn toàn
- `.opencode/agents/planner.md` — Viết lại hoàn toàn
- `.opencode/agents/docs.md` — Viết lại hoàn toàn
- `.opencode/agents/researcher.md` — Mới
- `.opencode/agents/verifier.md` — Mới
- `.opencode/agents/debugger.md` — Mới
- `.opencode/agents/searcher.md` — Mới
- `src/agents/acp-client.ts` — Thêm deleteSession(), role mapping mới
- `src/server.ts` — buildTeam() task info, deleteAgent() async + session delete, parseAgentCommands async, ORCH_PROMPT roles mới

## [v0.7.7] - 2026-08-23

### Vấn đề
- Orchestrator không thể tạo agent role mới theo nhu cầu — chỉ dùng được roles có sẵn
- Không có cách tạo custom agent với prompt riêng cho các task đặc thù
- Custom roles mất khi restart server

### Nguyên nhân
-角色 là hardcoded trong code, không có dynamic role creation
- Không có persistence layer cho custom roles

### Giải pháp
- **CREATE ROLE command**: `[CREATE ROLE name=<name> description=<desc> capabilities=<list> rules=<list>]`
- **Tự tạo file .md**: Server tự generate file `.opencode/agents/<role>.md` từ template khi orchestrator tạo role mới
- **Dynamic role mapping**: acp-client hỗ trợ custom roles — check role name trực tiếp thay vì static map
- **Persistence**: Custom roles lưu vào `data/custom-roles.json`, load lại khi server start
- **Template**: File .md được generate với Identity, Capabilities, Rules, Communication Format
- **ORCH_PROMPT updated**: Thêm CREATE ROLE command + example + rules về khi nào dùng

### Flow mới
```
Orchestrator: [CREATE ROLE name=security-auditor description=... capabilities=... rules=...]
→ Server tạo .opencode/agents/security-auditor.md
→ Server lưu vào data/custom-roles.json
→ Orchestrator: [SPAWN role=security-auditor name=sec-audit task=...]
→ Agent chạy với custom prompt
```

### Files thay đổi
- `src/server.ts` — createCustomRole(), loadCustomRoles(), saveCustomRolesConfig(), CREATE ROLE parsing, ORCH_PROMPT updated
- `src/agents/acp-client.ts` — Dynamic role resolution cho custom roles

## [v0.8.0] - 2026-08-23

### Vấn đề
- Orchestrator vẫn dùng OpenCode native subagent (task tool) thay vì [SPAWN] tags
- Click agent ở sidebar không thấy hội thoại riêng; agent messages không hiển thị
- Tin nhắn [TO: orchestrator] dính liền body trên 1 dòng
- CORS thiếu nên browser block /api/history, frontend trống
- Port 3001 serve UI cũ (vanilla) không có fix mới
- Agent im lặng khi làm lâu, user phải tự nhắc
- Tin nhắn hệ thống ([PING], [HEARTBEAT], [SYSTEM], [TEAM]) lẫn vào chat agents gây nhiễu
- Không resize được các panel

### Nguyên nhân
- Permission task chưa deny trong YAML frontmatter của agent .md, và YAML bị lỗi literal backslash-n khiến parse fail
- Frontend chỉ giữ messages local, không fetch history, sai WS event type
- Nội dung raw render nguyên khối không tách tag
- Express không set Access-Control-Allow-Origin
- server.ts chỉ serve dist/index.html legacy
- Chỉ có heartbeat 180s reset status, không chủ động ping
- loadHistory/render thêm tất cả message types

### Giải pháp sửa đổi
- Sửa YAML frontmatter đúng format cho 10 file .opencode/agents/*.md: permission task/plan_enter/plan_exit = deny, mode primary, orchestrator output [SPAWN] text thuần
- App.tsx viết lại: fetch /api/history + listen WS chat:message và agent events; filter theo selectedAgentId (click agent = xem hội thoại riêng); ChatPanel parse [TO: x] thành badge riêng 1 hàng + body xuống dòng nguyên văn pre-wrap monospace
- Thêm CORS middleware allow all cho Vite dev
- Dual UI: / = legacy tab kanban có patch hiện agent report realtime + right column; /v2 va 5173 = React moi; ca 2 them resizer keo ngang 220-600px
- Proactive prompts: 9 worker .md them section Proactive Communication (bao bat dau/block/xong, REQUEST, NEED CLARIFICATION, PROGRESS); orchestrator.md them Relay va Proactive Rules (forward TO:, tu PING tren 90s)
- Server heartbeat them auto-PING 90s gui SYSTEM PING yeu cau PROGRESS, luu msgType=ping
- Filter isSysMsg/isSystemMsg loai PING/HEARTBEAT/SYSTEM/TEAM khoi chat views ca 2 UI
- Fix nested script pha vo JS legacy UI sau khi chen resizer

### Kiem chung end-to-end
- Task phuc tap ~/agentforge-demo (Express Todo API + SQLite + frontend + Jest + README): orchestrator spawn song song backend/qa/docwriter, agents report TO:, PING 90s hoat dong, orchestrator synthesize
- Ket qua project day du (server.js 8KB, index.html, todos.test.js 21KB, README 10KB) — npx jest: 63/63 PASSED

## [v0.8.1] - 2026-08-23

### Vấn đề
- execAsync timeout 180s cứng cắt ngang agent đang làm task lớn
- Output opencode chỉ giữ text cuối, mọi tool call (đọc/ghi file, chạy lệnh) bị lược khỏi hội thoại
- PING 90s quá sớm so với task dài

### Nguyên nhân
- execAsync đặt timeout không phù hợp thiết kế để heartbeat/PING quyết định
- opencode run mặc định chỉ in text cuối + dòng progress tool bị filter regex
- Người dùng yêu cầu ping 150s

### Giải pháp sửa đổi
- Bỏ timeout cứng trong acp-client chat() (maxBuffer tăng 10MB) — heartbeat/PING/orchestrator là cơ chế dừng/tiếp tục duy nhất
- Dùng opencode run --format json (JSONL events: step_start/tool_use/text/step_finish/error) — parseJsonlEvents() gom:
  content = lời thoại model nguyên văn (không còn filter regex)
  transcript = TOÀN BỘ diễn biến 1 lượt: [TOOL tên] title/input/output (20 dòng đầu) + [ASSISTANT] text + [COST], header kèm sessionID
- sessionId lấy trực tiếp từ event JSONL (chính xác hơn so sánh danh sách session)
- server.ts thêm saveTranscript(): lưu transcript thành message riêng msgType=transcript, broadcast realtime, lưu DB — gọi ở SPAWN mới/reuse/TALK/heartbeat/PING
- Đổi PING 90s sang 150s (2 phút rưỡi) cả threshold và anti-loop
- Sửa pre-existing TS error trong return AgentMessage (thêm from/to, bỏ agentId/role)

### Lưu ý
- Nested opencode run từ shell trong phiên opencode khác sẽ lỗi Unexpected server error do env OPENCODE_PID — chỉ test qua server AgentForge spawn

## [v0.9.0] - 2026-08-23

### Vấn đề
- Không giới hạn số agent — có thể spawn vô hạn cùng role làm nghẽn/loạng nhánh
- Gửi tin nhắn tới agent đang working dẫn tới race/conflict session opencode
- Session opencode chết gây "Session not found", đứng im không tự phục hồi
- Tiêu đề khung chat của agent dùng tên agent, không dùng session opencode
- loadHistory bỏ mất msgType sau restart — realtime vs reload lệch
- Thêm cột mới vào schema bảng đã tồn tại không tự có hiệu lực

### Nguyên nhân
- Không đếm agents theo role trong parseAgentCommands
- chat() gọi thẳng song song không qua hàng đợi
- Không retry khi session bị xóa; self-heal match sai chỗ (err.message thiếu stdout/stderr)
- Không lấy title session; syncSessionTitle chỉ chạy khi session đổi
- loadState map row -> ChatMsg bỏ row.msg_type
- CREATE TABLE IF NOT EXISTS không ALTER bảng cũ

### Giải pháp sửa đổi
- Giới hạn 3 agent mỗi role: đếm agents Map theo role, >=3 thì push [ERROR] max 3 + list name(id)[status], continue (không spawn)
- Queue trong ACPClient: busy flag + pending[], enqueue() xếp khi bận, drain tuần tự khi xong; heartbeat/PING giữ chat() trực tiếp; /api/chat + spawn reuse/new + TALK dùng enqueue
- Self-heal: nếu err khớp "Session not found" trong message/stdout/stderr va this.sessionId, bỏ sessionId va retry chat() tao session moi
- sessionTitle: agent.sessionTitle, syncSessionTitle() lay title tu opencode session list, luu DB + broadcast; ap dung ca /api/chat direct targetAgent
- loadState them msgType: row.msg_type || 'chat'
- Migration ensureColumn() them cot session_title cho bang agents cu

### Test
- Chat thang vao agent (session cu chet) -> tu heal tao session moi, rep dung
- transcript (TURN TRANSCRIPT) luu va parse OK (msgType=transcript)
- Spawn coder thu 4 khi da co 3 coder -> [ERROR] max 3 agents per role "coder", list backend/coder-extra/coder3
- sessionTitle hien dung "Get project name from package.json"

## [Sự cố & khôi phục] - 2026-08-23

### Vấn đề
- src/server.ts của nhánh run bị ghi đè thành toàn bộ null bytes (0x00, 41513 bytes) — file hỏng, tsc báo Invalid character

### Nguyên nhân
- Một lệnh ghi file không theo format chuẩn đã ghi đè server.ts bằng buffer null thay vì nội dung (nghi do thuật nghịch ghi file/encoding lệch)

### Giải pháp sửa đổi
- Xác định chính xác chỉ duy nhất server.ts hỏng; acp-client.ts, types.ts, storage.ts nguyên vẹn (nulls=0)
- Kiểm tra các nguồn khôi phục: clone agentforge-serve là nhánh serve (OpenCodeServeClient, port 3002) KHÔNG dùng được làm base cho nhánh run
- Backup acp-client.ts, types.ts, storage.ts sang temp trước khi thao tác
- Tái tạo lại server.ts đầy đủ nhánh run (Express/WS/CORS, ORCH_PROMPT + role idea, Agent + model/sessionTitle, buildTeam, getClient fallback model, syncSessionTitle, saveTranscript, stop/resume/delete, heartbeat + ping 150s, /api/agents CRUD, /api/chat queue + giới hạn 3/role + idle set + spawn reuse/new + talk, /api/models, /api/orchestrator/model, /api/orchestrator/clear, GET / + /v2)
- tsc pass, server chạy lại bằng npm run dev:all (tsx), verify agents/history/models đều OK

### Bài học
- Không dùng lệnh ghi file không chuẩn đè lên file nguồn khi đã có lịch sử dài
- Sao lưu (backup) các file src quan trọng trước khi thực hiện chuỗi sửa đổi lớn
