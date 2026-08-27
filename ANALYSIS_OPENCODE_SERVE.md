# Phân tích chuyển AgentForge sang hệ opencode serve + ACP

## 1) Tổng quan hiện trạng

AgentForge hiện vận hành theo mô hình **server tự viết** bằng Node.js + Express + WebSocket:

- Backend: `src/server.ts` (~4100 dòng)
- UI: React + Vite (`web/`)
- Transport: JSON API + SSE + WS
- Agent runtime: mỗi agent là 1 instance `ACPClient` gọi CLI `opencode run --format json`
- Orchestrator: prompt-only (LLM), tự sinh lệnh `[SPAWN]`, `[TALK]`, `[STOP]`, `[RESUME]` rồi server parse và thực thi
- State: `data/agentforge-state.json` + `storage.ts`
- Packaging: SEA exe / Electron

## 2) opencode serve là gì

`opencode serve` chạy 1 HTTP server headless cung cấp OpenAPI 3.1, SSE, session/message management, file tools, permissions, logging...

Có thể dùng làm backbone cho multi-agent orchestration **mà không cần tự viết lại orchestration core**.

## 3) So sánh endpoint có sẵn

Hiện AgentForge tự cài ~25 endpoint quan trọng. opencode serve đã có sẵn các nhóm:

| Chức năng | AgentForge hiện | opencode serve có sẵn | Ghi chú |
|---|---|---|---|
| Health/status | `/api/server-info` | `/global/health` | Tương đương |
| Agent list | `/api/agents` | `/agent` | opencode serve có danh sách agent đã định nghĩa trong config |
| Session | quản lý trong memory + outbox DB | `/session`, `/session/:id/*` | Có đủ CRUD, fork, summarize, abort, permissions |
| Message send | `/api/chat` | `/session/:id/message`, `/session/:id/prompt_async` | Sync + async đều có |
| Slash command | `/compact` | `/session/:id/command` | Tương đương |
| File ops | tự parse tool result | `/find`, `/file/*` | Có search file + content |
| Tool use | parse từ JSONL opencode run | `/experimental/tool*` | Có tool schema, permission events |
| Events stream | `/api/events` + WS | `/global/event` SSE | SSE đủ cho UI real-time |
| Logging | console + chatHistory | `/log` | Mức log chuẩn hóa |
| MCP/LSP | thông qua agent tool | `/mcp`, `/lsp` | Có status + dynamic add MCP |

Nhóm AgentForge tự viết không có trong serve:
- Orchestrator routing: `parseOrchestratorCommands`, `parseAgentOutput`, `stripCommandTags`, `replayPendingReports`, outbox + retry + debounce queue
- Agent lifecycle: SPAWN/STOP/RESUME/DELETE AGENT, role limit, session reuse theo name
- Permission merge + permission deny handling
- Chat panel + toolcall badge rendering
- SEA / Electron packaging

## 4) Ưu điểm nếu dùng opencode serve

- Giảm ~2500-3000 dòng server code: không cần tự parse CLI JSONL, tự quản lý session/prompt queue
- Session/event chuẩn hóa: OpenAPI + SSE, nhiều client có thể connect
- Tool/LSP/MCP có sẵn, permission flow có sẵn
- Tách biệt: UI chỉ cần consume REST/SSE, không cần WebSocket custom
- Scale: có thể chạy nhiều instance serve đằng sau proxy, session tách biệt rõ ràng

## 5) Nhược điểm / rủi ro khi chuyển

- Orchestrator prompt hiện tại sinh lệnh `[SPAWN role=...]`, `[TALK agent-id=...]` là protocol riêng. opencode serve không hiểu trực tiếp → phải giữ 1 layer orchestration wrapper hoặc thay bằng MCP/tool-call
- AgentForge đang tái sử dụng session cố định theo `agentId` (`agents.get(id)` + persistent session). opencode serve mặc định session là tài nguyền; cần bind session theo agent cố định
- Packaging SEA/Electron hiện tại bundle cả server. Nếu chuyển sang `opencode serve` cần đảm bảo binary vẫn chạy được offline
- Permission merge hiện custom theo rule format riêng; serve có permission model nhưng khác format
- Chat panel hiện render trực tiếp transcript + tool badge. Cần map lại từ `/session/:id/message` parts

## 6) Hướng tối ưu, scale nhất

Khuyến nghị theo 2 giai đoạn:

### Giai đoạn 1: Thin orchestrator wrapper
- Backend chỉ còn 1 file Orchestrator Service nhỏ (~500-800 dòng) thay vì 4100 dòng server hiện tại
- Mọi request agent đều đổ vào `/session/:id/message` hoặc `/session/:id/prompt_async`
- Orchestrator không còn spawn process mới mỗi lượt, chỉ điều khiển session + routing
- UI vẫn giữ React, chỉ đổi từ WebSocket/JSON API sang REST + SSE
- Lợi: giữ nguyên orchestration prompt `[SPAWN]/[TALK]`, chỉ thay transport

### Giai đoạn 2: nâng cấp lên MCP-first
- Orchestrator được huấn luyện/tùy chỉnh gọi tool `agent.spawn`, `agent.talk`, `session.send` thay vì tag string
- opencode serve expose MCP server → AgentForge orchestration dùng MCP protocol
- Tách hoàn toàn: frontend ↔ AgentForge orchestration ↔ opencode serve
- Lợi: chuẩn protocol, dễ scale, dễ thay LLM, dễ audit

## 7) Kết luận

Endpoint nào dễ làm trước: `/global/health`, `/agent`, `/session`, `/session/:id/message`, `/session/:id/command`, `/find`, `/file/*`, `/event`, `/log`.

Việc chuyển đổi nên bắt đầu từ **Giai đoạn 1**, giữ nguyên orchestrator prompt hiện tại, thay backend bằng HTTP client gọi `opencode serve`, giữ lại web UI hiện tại. Đây là cách an toàn, ít thay đổi lớn nhất đồng thời giảm rất nhiều code tự viết.
