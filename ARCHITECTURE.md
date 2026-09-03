# Kiến Trúc Hệ Thống AgentForge v7.0.0 (System Architecture)

Tài liệu này mô tả toàn diện mô hình kiến trúc phần mềm, cơ chế giao tiếp đa tác tử (Multi-Agent System), luồng dữ liệu 3 chiều (User ↔ Orchestrator ↔ Specialist Agents), mô hình tiến trình Pipe I/O và hệ thống lưu trữ phân tán hạt mịn trong **AgentForge v7.0.0**.

---

## 1. Tổng Quan Kiến Trúc Cấp Cao (High-Level Architecture)

AgentForge hoạt động theo mô hình điều phối phân tán có kiểm soát (Hierarchical Orchestrated Multi-Agent Architecture).

```
+-----------------------------------------------------------------------------+
|                               USER INTERFACE                                |
|  [Desktop App (Electron)]  <--->  [Web UI (React 18 + Vite + Tailwind)]     |
+-----------------------------------------------------------------------------+
                                       |
                   HTTP REST APIs / WebSocket Realtime (ws)
                                       v
+-----------------------------------------------------------------------------+
|                            BACKEND SERVER (Node.js)                         |
|                                                                             |
|  [src/server.ts] (Bootstrap & LifeCycle Entrypoint)                         |
|        |                                                                    |
|        +---> [src/routes/] (REST APIs: chat, agents, system, settings)      |
|        +---> [src/ws/]     (WebSocket Gateway & Event Broadcasting)         |
|        +---> [src/relay/]  (3-Way Message Router & Outbox Engine)           |
|        +---> [src/agents/] (ACP Client, Process Management, Pipe Stream)    |
|        +---> [src/storage/](Granular Domain Storage, Per-Team Chat DB)      |
|        +---> [src/parser/] (XML / Bracket Command Parsers, Sanitizer)       |
|        +---> [src/logger/] (Ring Buffer, Terminal Formatter, Console Hook)  |
|        +---> [src/prompts/](Prompt Loader, Dynamic Role System Prompts)     |
+-----------------------------------------------------------------------------+
                                       |
                   Stdio Pipe Stream (JSONL / Realtime In-Out)
                                       v
+-----------------------------------------------------------------------------+
|                   OPENCODE RUNTIME & AI MODEL ENGINES                       |
|   +-------------------+  +-------------------+  +-------------------+        |
|   |   Orchestrator    |  |  Coder / Tester   |  | Verifier / Audit  |        |
|   |  (gemini / claude)|  | (qwen / deepseek) |  |   (flash / sonnet)|        |
|   +-------------------+  +-------------------+  +-------------------+        |
+-----------------------------------------------------------------------------+
```

---

## 1.1 Cấu Trúc Thư Mục Toàn Dự Án (Project Directory Tree)

Cấu trúc mã nguồn chi tiết sau khi hoàn tất cuộc đại tái cấu trúc mô-đun hóa v7.0.0:

```text
test-agentforge thoi/
├── data/                                # Lưu trữ trạng thái bền vững trên ổ đĩa
│   ├── chats/                           # Lịch sử chat phân lập theo team (chat_<teamId>.json)
│   ├── agentforge-state.json            # Trạng thái tổng thể agent, outbox, settings
│   └── agentforge-state.json.bak        # File sao lưu tự động chống hỏng hóc
│
├── release/                             # Bản phát hành nhị phân thực thi độc lập (Single Executable)
│   ├── agentforge-web.exe               # SEA Node.js binary tích hợp sẵn Web & Backend v7.0.0
│   └── agentforge-web-v7.0.0.exe        # Phiên bản đóng dấu chính thức
│
├── src/                                 # Mã nguồn Backend máy chủ điều phối (TypeScript)
│   ├── server.ts                        # File entrypoint chính: khởi tạo Express, WebSocket & Watchdog
│   │
│   ├── agents/                          # Quản lý vòng đời agent và tiến trình OpenCode con
│   │   ├── acp-client.ts                # Điều khiển tiến trình OpenCode qua Stdio Pipe & Zero-Latency Stream
│   │   ├── agent-manager.ts             # Quản lý danh sách agent, trạng thái (idle/working), teamId
│   │   ├── role-limits.ts               # Rào chắn hạn ngạch số lượng agent theo từng vai trò
│   │   └── index.ts                     # Barrel export module agents
│   │
│   ├── core/                            # Tầng facade trung gian (backward compatibility)
│   │   ├── agent-manager.ts             # Delegate sang src/agents/agent-manager.ts
│   │   ├── command-parser.ts            # Delegate sang src/parser/command-parser.ts
│   │   ├── index.ts                     # Facade export
│   │   ├── logger.ts                    # Delegate sang src/logger/
│   │   ├── prompts.ts                   # Delegate sang src/prompts/
│   │   └── role-limits.ts               # Delegate sang src/agents/role-limits.ts
│   │
│   ├── logger/                          # Module ghi log terminal chuyên biệt
│   │   ├── console-override.ts          # Chặn stdout/stderr gốc để định tuyến log
│   │   ├── log-formatter.ts             # Định dạng màu sắc ANSI và thời gian
│   │   ├── ring-buffer.ts               # Hàng đợi vòng tròn lưu trữ log trong bộ nhớ
│   │   ├── terminal-logger.ts           # Logger ghi ra cửa sổ dòng lệnh
│   │   └── index.ts                     # Barrel export module logger
│   │
│   ├── parser/                          # Phân tích cú pháp lệnh điều phối
│   │   ├── bracket-parser.ts            # Xử lý cú pháp ngoặc vuông [SPAWN], [TALK]
│   │   ├── command-parser.ts            # Bộ phân giải hợp nhất XML và Bracket
│   │   ├── string-utils.ts              # Các tiện ích cắt chuỗi, unescape, strip quotes
│   │   ├── xml-parser.ts                # Xử lý cú pháp XML tag <spawn>, <talk>, <report>
│   │   └── index.ts                     # Barrel export module parser
│   │
│   ├── prompts/                         # Quản lý và đồng bộ System Prompts
│   │   ├── prompt-loader.ts             # Đọc các file prompt từ thư mục prompts/
│   │   ├── prompt-service.ts            # Tạo prompt giao việc (task dispatch prompt)
│   │   ├── prompt-sync.ts               # Đồng bộ hóa prompt chuẩn Single-Source-of-Truth
│   │   └── index.ts                     # Barrel export module prompts
│   │
│   ├── relay/                           # Động cơ điều phối và chuyển tiếp tin nhắn đa tác tử
│   │   ├── outbox-engine.ts             # Bộ xử lý hàng đợi outbox, retry cơ chế lũy thừa
│   │   ├── report-parser.ts             # Bóc tách cấu trúc báo cáo nghiệm thu <report>
│   │   ├── router.ts                    # Điều hướng tin nhắn 3 chiều (User <-> Orch <-> Worker)
│   │   ├── stream-scanner.ts            # Quét sớm lệnh điều phối trong luồng stream (Early Dispatch)
│   │   ├── team-router.ts               # Định tuyến tin nhắn theo phạm vi team/sub-team
│   │   └── index.ts                     # Barrel export module relay
│   │
│   ├── routes/                          # Các REST API endpoints (Express Routers)
│   │   ├── agents.ts                    # API danh sách agent, spawn, start, stop, resume
│   │   ├── chat.ts                      # API gửi nhận tin nhắn chat, history paging
│   │   ├── settings.ts                  # API cấu hình mô hình LLM, API keys, role prompts
│   │   ├── system.ts                    # API trạng thái hệ thống, logs, watchdog
│   │   └── index.ts                     # Barrel export routes
│   │
│   ├── storage/                         # Hệ thống lưu trữ bền vững phân tán hạt mịn
│   │   ├── agent-store.ts               # Lưu trữ dữ liệu cấu hình và trạng thái agent
│   │   ├── atomic-disk.ts               # Ghi đĩa nguyên tử an toàn (atomic write + rename)
│   │   ├── chat-store.ts                # Quản lý phân vùng tệp chat theo từng team
│   │   ├── engine.ts                    # Storage facade tích hợp hợp nhất
│   │   ├── file-utils.ts                # Tiện ích đọc ghi file JSON an toàn
│   │   ├── message-storage.ts           # Lưu và truy vấn lịch sử tin nhắn
│   │   ├── outbox-store.ts              # Lưu trữ hàng đợi tin nhắn gửi đi
│   │   ├── persistence-scheduler.ts     # Bộ đệm debounce ghi đĩa giảm tải I/O
│   │   ├── queue-storage.ts             # Hàng đợi outbox với recovery timeout 30s
│   │   ├── settings-store.ts            # Lưu trữ cấu hình hệ thống
│   │   └── index.ts                     # Barrel export storage
│   │
│   └── ws/                              # Hạ tầng WebSocket thời gian thực
│       ├── connection-pool.ts           # Quản lý danh sách các kết nối socket đang mở
│       ├── ws-events.ts                 # Định nghĩa các loại sự kiện chat:chunk, chat:message, etc.
│       ├── ws-service.ts                # Xử lý phát sóng (broadcast) và bắt tay WebSocket
│       └── index.ts                     # Barrel export module ws
│
├── web/                                 # Giao diện người dùng Web SPA (React 18 + Vite)
│   ├── src/
│   │   ├── components/
│   │   │   ├── ChatPanel.tsx            # Bảng chat chính, render bubble, toolcall, report card
│   │   │   ├── MarkdownRenderer.tsx     # Bộ render Markdown, highlight cú pháp code
│   │   │   ├── Sidebar.tsx              # Danh sách agent, trạng thái làm việc, thanh điều hướng
│   │   │   └── ...
│   │   ├── App.tsx                      # Component gốc: quản lý WebSocket, allMessages, bộ lọc Main
│   │   ├── main.tsx                     # React DOM entrypoint
│   │   └── index.css                    # Tailwind CSS và bảng màu công nghệ Slate/Midnight Blue
│   ├── vite.config.ts                   # Cấu hình đóng gói Vite
│   └── package.json
│
├── ARCHITECTURE.md                      # Tài liệu kiến trúc hệ thống chính (SSoT)
├── CHANGELOG.md                         # Nhật ký các phiên bản phát hành
└── package.json                         # Dependencies và kịch bản đóng gói backend
```

---

## 2. Mô Hình Luồng Dữ Liệu 3 Chiều (3-Way Relay Flow)

Hệ thống định tuyến thông điệp dựa trên ngữ cảnh Team (`teamId`) và các vai trò phân cấp:

```
                  +-----------------------+
                  |         USER          |
                  +-----------------------+
                    | ▲               ▲
       User Prompt  | | Synthesis     | Direct Log / Error
                    v |               |
           +--------------------+     |
           |  MAIN ORCHESTRATOR |     |
           +--------------------+     |
              | ▲          | ▲        |
    Directive | | Report   | | Direct |
    <spawn>   | | Clean    | | Comm   |
    <talk>    | | Text     | |        |
              v |          v |        |
         +----------+   +----------+  |
         |  CODER   |   | VERIFIER | -+
         +----------+   +----------+
              |              ▲
              +-- Verify ----+
```

1. **User ➔ Orchestrator**: Người dùng gửi yêu cầu cấp cao. Orchestrator phân rã bài toán thành các subtask độc lập chạy song song.
2. **Orchestrator ➔ Worker Agents**:
   - Sử dụng thẻ điều phối XML / Bracket: `<spawn role="..." task="...">` và `<talk target="..." task="...">`.
   - **Frontend Rendering**: Tin nhắn này tự động được bóc tách khỏi văn bản thường và render thành **Directive Card** (Thẻ Giao Việc) căn phải (`alignItems: 'flex-end'`), phân biệt với tin nhắn trò chuyện thông thường.
3. **Worker Agents ➔ Orchestrator**:
   - Worker chạy độc lập, thực thi lệnh qua OpenCode runtime.
   - **Lọc nhiễu Toolcall**: Backend tự động gỡ bỏ nhiễu tool call JSON (`stripToolNoiseForOrchestrator`) và chỉ chuyển tiếp báo cáo kết quả sạch (`<report>`) về context của Orchestrator.
   - **Bắn UI**: Dữ liệu tool call thô (`toolCalls`) được phát độc lập qua WebSocket `chat:message` và hiển thị trên UI dưới dạng thẻ thu gọn (`ToolCallBlock`).
4. **Coder ↔ Verifier Pairing**: Mọi thay đổi code đều được ghép cặp với Verifier chạy song song để kiểm chứng thực tế trên đĩa cứng (empirical validation) trước khi báo cáo hoàn tất.

---

## 3. Quản Lý Vòng Đời Tiến Trình (Process Lifecycle & Pipe I/O)

Nhằm chấm dứt tình trạng tiến trình mồ côi (Orphan Process) và rò rỉ tài nguyên, AgentForge v7.0.0 áp dụng chuẩn **Pipe I/O**:

```
+-------------------------------------------------------------+
|                      Node.js Host Server                    |
|                                                             |
|   spawn(powershell.exe / sh, cmdArgs, {                     |
|     stdio: ['pipe', 'pipe', 'pipe']                         |
|   })                                                        |
|     |                                                       |
|     |-- stdin  ---> Ghi prompt trực tiếp vào stream          |
|     |-- stdout <--- Đọc từng dòng JSONL realtime (StringDec) |
|     |-- stderr <--- Tích lũy lỗi runtime                    |
|     |                                                       |
|   proc.stdin.on('error') -> Tự động kích hoạt taskkill / T / F
+-------------------------------------------------------------+
```

- **Inlet Pipe Binding**: Nếu server Node.js bị tắt đột ngột (crash/tắt cửa sổ), đường ống `stdin` của PowerShell bị đứt, kích hoạt sự kiện broken pipe giúp child process tự kết thúc sạch sẽ.
- **Process Group Tracking**: Server lưu trữ `ACPClient.activeChildPids` để thực hiện dọn dẹp hàng loạt qua `taskkill /pid ${pid} /T /F` khi nhận tín hiệu kết thúc (`SIGINT`, `SIGTERM`, `exit`).

---

## 4. Hệ Thống Lưu Trữ Phân Tán Hạt Mịn (Granular Storage v7.0.0)

Hệ thống lưu trữ chia nhỏ theo nguyên tắc đơn nhiệm (Single Responsibility Principle) đặt tại `src/storage/`:

| Module | Tệp Mã Nguồn | Chức Năng Chính |
| :--- | :--- | :--- |
| **I/O Đĩa An Toàn** | `atomic-disk.ts`, `file-utils.ts` | Ghi đĩa an toàn bằng cách tạo file tạm `.tmp` rồi đổi tên nguyên tử (atomic rename), chống hỏng file khi mất điện. |
| **Lịch Sử Trò Chuyện** | `message-storage.ts`, `chat-store.ts` | Lưu trữ tin nhắn theo từng `teamId` (`data/chats/chat_${teamId}.json`), bảo đảm cách ly dữ liệu giữa các nhóm làm việc. |
| **Outbox & Phục Hồi** | `queue-storage.ts`, `outbox-store.ts` | Quản lý hàng đợi tin nhắn gửi ngoài. Tích hợp timeout tự phục hồi 30 giây (`OUTBOX_IN_FLIGHT_TIMEOUT_MS = 30000`) tự động trả các tin nhắn bị treo về `pending`. |
| **Agent & Cấu Hình** | `agent-store.ts`, `settings-store.ts` | Lưu trạng thái danh sách agent, session context, mô hình cấu hình hệ thống. |
| **Điều Phối Lưu Nền** | `persistence-scheduler.ts` | Gom các thao tác ghi đĩa bằng debouncing để giảm tải I/O ổ cứng. |

---

## 5. Cấu Trúc Thư Mục Dự Án Toàn Diện (Directory Tree Structure)

Cấu trúc cây thư mục chi tiết của AgentForge v7.0.0 sau khi hoàn tất tái cấu trúc mô-đun hóa hạt mịn:

```
agentforge/
├── src/                               # Toàn bộ mã nguồn Backend (Node.js/TypeScript)
│   ├── server.ts                      # Bootstrap entrypoint & lifecycle coordinator
│   ├── logger/                        # Hệ thống logging đa tầng & console interception
│   │   ├── log-formatter.ts           # Định dạng log, màu sắc ANSI, strip token rác
│   │   ├── ring-buffer.ts             # Bộ đệm xoay vòng lưu log in-memory
│   │   ├── console-override.ts        # Can thiệp bắt console.log/error toàn hệ thống
│   │   ├── terminal-logger.ts         # Logger hiển thị terminal theo thời gian thực
│   │   └── index.ts                   # Barrel export cho logger
│   ├── prompts/                       # Quản lý prompt hệ thống & Single Source of Truth
│   │   ├── prompt-loader.ts           # Đọc và render prompt từ template
│   │   ├── prompt-sync.ts             # Đồng bộ prompt markdown sang file cấu hình
│   │   ├── prompt-service.ts          # Cung cấp system prompt động theo từng agent role
│   │   └── index.ts                   # Barrel export cho prompts
│   ├── parser/                        # Phân tích cú pháp lệnh điều phối & thẻ XML
│   │   ├── string-utils.ts            # Tiện ích cắt tỉa quote, làm sạch chuỗi
│   │   ├── bracket-parser.ts          # Phân tích cú pháp bracket [SPAWN], [TALK]
│   │   ├── xml-parser.ts              # Phân tích cú pháp XML đa dòng <spawn>, <talk>
│   │   ├── command-parser.ts          # Bộ điều phối phân tích cú pháp hợp nhất
│   │   └── index.ts                   # Barrel export cho parser
│   ├── agents/                        # Quản lý vòng đời agent và tiến trình OpenCode
│   │   ├── acp-client.ts              # Quản lý tiến trình CLI qua Stdio Pipe & Zero-latency streaming
│   │   ├── agent-manager.ts           # Quản lý trạng thái, danh sách agent và phân vai trò
│   │   ├── role-limits.ts             # Kiểm soát hạn mức số lượng agent theo từng vai trò
│   │   └── index.ts                   # Barrel export cho agents
│   ├── storage/                       # Hệ thống lưu trữ bền vững phân tán hạt mịn
│   │   ├── atomic-disk.ts             # Ghi đĩa nguyên tử (safe atomic rename & fsync)
│   │   ├── file-utils.ts              # Tiện ích đọc ghi file JSON và backup an toàn
│   │   ├── message-storage.ts         # Quản lý lịch sử chat và phân tách theo từng team
│   │   ├── chat-store.ts              # Truy vấn và phân trang lịch sử tin nhắn
│   │   ├── queue-storage.ts           # Quản lý hàng đợi outbox với timeout phục hồi 30s
│   │   ├── outbox-store.ts            # Trạng thái outbox in-flight và retry counter
│   │   ├── agent-store.ts             # Lưu trữ danh sách agent, trạng thái và team context
│   │   ├── settings-store.ts          # Lưu trữ thiết lập môi trường và API keys
│   │   ├── persistence-scheduler.ts   # Bộ lập lịch ghi đĩa định kỳ chống nghẽn I/O
│   │   ├── engine.ts                  # Bộ facade tích hợp cho toàn bộ storage
│   │   └── index.ts                   # Barrel export cho storage
│   ├── relay/                         # Hệ thống relay & 3-way message router
│   │   ├── router.ts                  # Bộ định tuyến tin nhắn 3 chiều (User <-> Orch <-> Worker)
│   │   ├── team-router.ts             # Định tuyến tin nhắn theo team isolation
│   │   ├── outbox-engine.ts           # Động cơ quét outbox, chuyển tiếp tin nhắn định kỳ
│   │   ├── report-parser.ts           # Bóc tách và làm sạch thẻ báo cáo <report>
│   │   ├── stream-scanner.ts          # Quét luồng stream phát hiện lệnh sớm (Early Dispatch)
│   │   └── index.ts                   # Barrel export cho relay
│   ├── routes/                        # Tầng Express HTTP REST APIs
│   │   ├── chat.ts                    # API gửi nhận tin nhắn (/api/chat, /api/history)
│   │   ├── agents.ts                  # API quản lý agent (/api/agents, start, stop, spawn)
│   │   ├── system.ts                  # API hệ thống, healthcheck, token count
│   │   ├── settings.ts                # API cấu hình mô hình, API key
│   │   └── index.ts                   # Đăng ký tập trung toàn bộ Express router
│   ├── ws/                            # Tầng kết nối WebSocket thời gian thực
│   │   ├── ws-service.ts              # Quản lý kết nối client và broadcast sự kiện
│   │   └── index.ts                   # Barrel export cho websocket
│   └── core/                          # Facade tương thích ngược cho các module lõi
│       └── index.ts                   # Barrel export tập trung
├── web/                               # Giao diện người dùng Web (React 18 + Vite)
│   ├── src/
│   │   ├── App.tsx                    # Component gốc, bộ lọc tin nhắn Main/Agent view
│   │   ├── components/
│   │   │   ├── ChatPanel.tsx          # Khung chat realtime, render bubble, DirectiveCard, ToolCallBlock
│   │   │   ├── AgentSidebar.tsx       # Cột danh sách agent, trạng thái hoạt động
│   │   │   ├── MarkdownRenderer.tsx   # Render markdown với cú pháp codeblock, badge
│   │   │   └── SettingsModal.tsx      # Modal cấu hình hệ thống và model
│   │   ├── index.css                  # Thiết lập style toàn cục và theme Dark Slate
│   │   └── main.tsx                   # Điểm khởi chạy React app
│   ├── package.json                   # Cấu hình phụ thuộc frontend
│   └── vite.config.ts                 # Cấu hình Vite build
├── docs/                              # Tài liệu kỹ thuật chi tiết
│   ├── ARCHITECTURE.md                # Bản sao tài liệu kiến trúc dự án
│   └── USER_GUIDE.md                  # Hướng dẫn sử dụng cho người dùng
├── data/                              # Dữ liệu hoạt động hệ thống (lưu trên đĩa)
│   ├── agentforge-state.json          # Trạng thái tổng thể agent, outbox, settings
│   └── chats/                         # Thư mục lưu lịch sử chat riêng biệt theo từng team
├── release/                           # Thư mục chứa gói binary đã đóng gói
│   ├── agentforge-web.exe             # File thực thi SEA v7.0.0 (Standalone Executable)
│   └── agentforge-web-v7.0.0.exe      # Binary phát hành chính thức v7.0.0
├── ARCHITECTURE.md                    # Tài liệu kiến trúc cấp cao tổng quan
├── CHANGELOG.md                       # Nhật ký thay đổi phiên bản v7.0.0
└── package.json                       # Cấu hình phụ thuộc backend Node.js
```

---

## 6. Hệ Thống Relay Tin Nhắn (Relay & Messaging Engine)

Đặt tại `src/relay/`:
- **`router.ts` & `team-router.ts`**: Tiếp nhận và điều hướng tin nhắn đến đúng đích (User, Orchestrator hoặc Agent đích) dựa theo cấu trúc `from`, `to`, và `teamId`.
- **`outbox-engine.ts`**: Bộ quét hàng đợi với cơ chế Exponential Backoff, giới hạn `maxAttempts` và cập nhật cảnh báo khi vượt ngưỡng thử lại.
- **`report-parser.ts` & `stream-scanner.ts`**: Phân tách cấu trúc XML `<report>` và trích xuất dữ liệu sạch trước khi gửi về cho Orchestrator.

---

## 6. Giao Diện Người Dùng (Chat UI & Presentation Layer)

Đặt tại `web/src/components/ChatPanel.tsx`:
- **Phân loại tin nhắn**:
  - **Outgoing (Bên Phải)**: Tin nhắn User + Các Directive Card (Giao việc/Spawn) của Orchestrator gửi đến Worker agent.
  - **Incoming (Bên Trái)**: Tin nhắn giải thích của Orchestrator gửi cho User + Báo cáo kết quả từ Worker.
- **Độc lập hóa khối hiển thị**:
  - `ThinkingBlock`: Hiển thị suy luận của AI (có thể xen kẽ hoặc gập mở).
  - `ToolCallBlock`: Hiển thị lệnh công cụ (đọc file, grep, git diff, terminal ANSI) tách rời khỏi nội dung hội thoại text.
  - `ReportCard`: Hiển thị báo cáo nghiệm thu có cấu trúc của agent sau khi hoàn tất công việc.

---

*Tài liệu kiến trúc hệ thống AgentForge phiên bản 7.0.0 — Cập nhật ngày 03/09/2026.*
