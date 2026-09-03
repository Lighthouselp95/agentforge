# AgentForge v7.0.0 — Kiến Trúc Hệ Thống & Mô Hình Vận Hành (System Architecture)

> Tài liệu mô tả chi tiết mô hình kiến trúc phân tầng, cơ chế điều phối đa agent, luồng truyền thông điệp 3 chiều (User ↔ Orchestrator ↔ Members), cơ chế Process Pipe và hệ thống lưu trữ phân tán của **AgentForge v7.0.0**.

---

## 1. Tổng Quan Kiến Trúc (High-Level Overview)

AgentForge vận hành theo mô hình **Hierarchical Multi-Agent Orchestration** (Hệ thống điều phối đa tác tử phân tầng):
- **User Interface (Desktop Electron / Web SPA)**: Giao diện trực quan hóa tương tác theo thời gian thực (realtime).
- **Core Orchestrator (Nhạc trưởng)**: Tiếp nhận yêu cầu người dùng, phân tích, phân rã công việc (Task Decomposition), điều phối và giám sát các tác tử chuyên biệt.
- **Specialist Worker Agents**: Các agent chuyên trách (`coder`, `tester`, `verifier`, `researcher`, `reviewer`, `debugger`, `docs`, `planner`, `searcher`, `idea`).
- **ACP Engine (Agent Client Protocol)**: Tầng giao tiếp giữa hệ thống điều phối và nhân thực thi mô hình ngôn ngữ lớn (OpenCode / ACP Process).

```
 ┌─────────────────────────────────────────────────────────────┐
 │                USER INTERFACE (Desktop / Web)               │
 │           ChatPanel (Directives/Tasks, Tool Calls)          │
 └──────────────────────────────┬──────────────────────────────┘
                                │ WebSocket & REST API
 ┌──────────────────────────────▼──────────────────────────────┐
 │                      EXPRESS & WS SERVER                    │
 │               src/server.ts  &  src/routes/*                │
 └──────────────┬──────────────────────────────┬───────────────┘
                │                              │
 ┌──────────────▼──────────────┐┌──────────────▼───────────────┐
 │   STORAGE LAYER (Modular)   ││   RELAY & DISPATCH BUS       │
 │ - message-storage.ts (Team) ││ - router.ts & team-router.ts │
 │ - queue-storage.ts (Outbox) ││ - outbox-engine.ts (30s TMO) │
 │ - atomic-disk.ts (I/O Safe) ││ - dedup.ts & broadcast-bus   │
 └──────────────┬──────────────┘└──────────────┬───────────────┘
                │                              │
 ┌──────────────▼──────────────────────────────▼───────────────┐
 │                  AGENT LIFECYCLE & RUNTIME                  │
 │                      src/agents/                            │
 │ ┌──────────────────┐  ┌───────────────────────────────────┐ │
 │ │ MainOrchestrator │  │ Specialist Agents                 │ │
 │ │ (Decision / Plan)│  │ (coder, verifier, tester, etc.)   │ │
 │ └────────┬─────────┘  └─────────────────▲─────────────────┘ │
 └──────────┼──────────────────────────────┼───────────────────┘
            │ Pipe Stdio (JSONL Stream)    │
 ┌──────────▼──────────────────────────────▼───────────────────┐
 │                   ACP PROCESS EXECUTION                     │
 │          powershell.exe / sh -> opencode CLI                │
 │       stdio: ['pipe', 'pipe', 'pipe'] (No Orphan)           │
 └─────────────────────────────────────────────────────────────┘
```

---

## 1.1 Cấu Trúc Thư Mục Hệ Thống (System Directory Structure)

Mô hình cấu trúc tệp tin và thư mục thực tế sau khi phân tách hạt mịn:

```text
test-agentforge thoi/
├── data/                                # Lưu trữ bền vững trên đĩa (Atomic Persistence)
│   ├── chats/                           # Phân vùng chat riêng theo từng team: chat_<teamId>.json
│   ├── agentforge-state.json            # Trạng thái tổng hợp agent, outbox queue và settings
│   └── agentforge-state.json.bak        # File snapshot dự phòng chống rủi ro nguồn điện
│
├── release/                             # Gói binary thực thi độc lập (Single Executable SEA)
│   ├── agentforge-web.exe               # File chạy duy nhất không cần cài Node.js v7.0.0
│   └── agentforge-web-v7.0.0.exe        # Binary phát hành chính thức
│
├── src/                                 # Backend máy chủ Node.js & TypeScript
│   ├── server.ts                        # Điểm khởi chạy chính (Bootstrap, Express & WebSocket init)
│   │
│   ├── agents/                          # Quản trị vòng đời agent & tiến trình con OpenCode
│   │   ├── acp-client.ts                # Điều khiển OpenCode CLI qua Stdio Pipe & Zero-Latency Stream
│   │   ├── agent-manager.ts             # Quản lý danh sách agent, trạng thái (idle/working), teamId
│   │   ├── role-limits.ts               # Rào chắn hạn ngạch số lượng agent theo từng vai trò
│   │   └── index.ts                     # Barrel export module agents
│   │
│   ├── core/                            # Tầng facade trung gian (backward compatibility)
│   │   ├── agent-manager.ts             # Chuyển tiếp sang src/agents/agent-manager.ts
│   │   ├── command-parser.ts            # Chuyển tiếp sang src/parser/command-parser.ts
│   │   ├── index.ts                     # Facade export tập trung
│   │   ├── logger.ts                    # Chuyển tiếp sang src/logger/
│   │   ├── prompts.ts                   # Chuyển tiếp sang src/prompts/
│   │   └── role-limits.ts               # Chuyển tiếp sang src/agents/role-limits.ts
│   │
│   ├── logger/                          # Module ghi log chuyên biệt
│   │   ├── console-override.ts          # Chặn stdout/stderr gốc để định tuyến log
│   │   ├── log-formatter.ts             # Định dạng màu sắc ANSI và thời gian
│   │   ├── ring-buffer.ts               # Hàng đợi xoay vòng lưu trữ log trong bộ nhớ
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

## 1.1 Cấu Trúc Thư Mục Hệ Thống (Project Directory Tree)

Cấu trúc cây thư mục chi tiết của AgentForge v7.0.0 sau khi hoàn tất tái cấu trúc mô-đun hóa:

```text
test-agentforge thoi/
├── data/                                # Dữ liệu lưu trữ trạng thái bền vững
│   ├── chats/                           # Lịch sử chat theo từng team (chat_<teamId>.json)
│   ├── agentforge-state.json            # Snapshot trạng thái agent, outbox, settings
│   └── agentforge-state.json.bak        # File backup an toàn tự động
│
├── release/                             # Bản nhị phân thực thi độc lập đóng gói SEA
│   ├── agentforge-web.exe               # Executable Node.js SEA v7.0.0
│   └── agentforge-web-v7.0.0.exe        # Binary phát hành chính thức
│
├── src/                                 # Mã nguồn Backend máy chủ điều phối (TypeScript)
│   ├── server.ts                        # Server entrypoint chính, khởi tạo HTTP & WebSocket
│   ├── agents/                          # Quản lý vòng đời agent và tiến trình OpenCode con
│   │   ├── acp-client.ts                # Điều khiển OpenCode qua Stdio Pipe & Zero-Latency Stream
│   │   ├── agent-manager.ts             # Quản lý danh sách agent, trạng thái (idle/working), teamId
│   │   ├── role-limits.ts               # Rào chắn hạn ngạch số lượng agent theo từng vai trò
│   │   └── index.ts                     # Barrel export module agents
│   ├── core/                            # Tầng facade trung gian (backward compatibility)
│   ├── logger/                          # Module ghi log terminal chuyên biệt
│   │   ├── console-override.ts          # Chặn stdout/stderr gốc để định tuyến log
│   │   ├── log-formatter.ts             # Định dạng màu sắc ANSI và thời gian
│   │   ├── ring-buffer.ts               # Hàng đợi xoay vòng lưu trữ log trong RAM
│   │   ├── terminal-logger.ts           # Logger ghi ra console/terminal
│   │   └── index.ts                     # Barrel export module logger
│   ├── parser/                          # Phân tích cú pháp lệnh điều phối
│   │   ├── bracket-parser.ts            # Xử lý cú pháp ngoặc vuông [SPAWN], [TALK]
│   │   ├── command-parser.ts            # Bộ phân giải hợp nhất XML và Bracket
│   │   ├── string-utils.ts              # Các tiện ích cắt chuỗi, unescape, strip quotes
│   │   ├── xml-parser.ts                # Xử lý cú pháp XML tag <spawn>, <talk>, <report>
│   │   └── index.ts                     # Barrel export module parser
│   ├── prompts/                         # Quản lý và đồng bộ System Prompts
│   │   ├── prompt-loader.ts             # Đọc các file prompt từ thư mục prompts/
│   │   ├── prompt-service.ts            # Tạo prompt giao việc (task dispatch prompt)
│   │   ├── prompt-sync.ts               # Đồng bộ hóa prompt chuẩn Single-Source-of-Truth
│   │   └── index.ts                     # Barrel export module prompts
│   ├── relay/                           # Động cơ điều phối và chuyển tiếp tin nhắn đa tác tử
│   │   ├── outbox-engine.ts             # Bộ xử lý hàng đợi outbox, retry cơ chế lũy thừa
│   │   ├── report-parser.ts             # Bóc tách cấu trúc báo cáo nghiệm thu <report>
│   │   ├── router.ts                    # Điều hướng tin nhắn 3 chiều (User <-> Orch <-> Worker)
│   │   ├── stream-scanner.ts            # Quét sớm lệnh điều phối trong luồng stream (Early Dispatch)
│   │   ├── team-router.ts               # Định tuyến tin nhắn theo phạm vi team/sub-team
│   │   └── index.ts                     # Barrel export module relay
│   ├── routes/                          # Các REST API endpoints (Express Routers)
│   │   ├── agents.ts                    # API danh sách agent, spawn, start, stop, resume
│   │   ├── chat.ts                      # API gửi nhận tin nhắn chat, history paging
│   │   ├── settings.ts                  # API cấu hình mô hình LLM, API keys, role prompts
│   │   ├── system.ts                    # API trạng thái hệ thống, logs, watchdog
│   │   └── index.ts                     # Barrel export routes
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

## 2. Mô Hình Điều Phối & Giao Thức Thông Điệp (Relay & Messaging Protocol)

Hệ thống hỗ trợ định tuyến thông điệp **3 chiều** (`User ↔ Orchestrator ↔ Members`) đảm bảo tính cách ly tuyệt đối theo ngữ cảnh Team (`teamId`):

### 2.1. Định Tuyến & Relay Bus (`src/relay/`)
- **`router.ts` & `team-router.ts`**: Tiếp nhận và điều hướng tin nhắn đến đúng thực thể:
  - User ➔ Orchestrator: Tiếp nhận yêu cầu, đưa vào hàng đợi suy luận.
  - Orchestrator ➔ Specialist Agents: Chuyển đổi các chỉ thị `<talk target="..." task="...">` hoặc `<spawn ...>` thành message giao việc.
  - Specialist Agents ➔ Orchestrator: Chuyển báo cáo nghiệm thu (`<report>`) hoặc kết quả thực hiện công việc.
- **`outbox-engine.ts` & `queue-storage.ts` (High Availability Queue)**:
  - Lưu trữ tin nhắn outbox ngoại tuyến khi worker bận hoặc ngắt kết nối.
  - Tích hợp **Timeout 30s (`OUTBOX_IN_FLIGHT_TIMEOUT_MS = 30000`)**: Khi một tin nhắn ở trạng thái `in_flight` quá 30 giây mà không có xác nhận ACK, hệ thống tự động giải phóng và thu hồi về trạng thái `pending` để thử lại (retry backoff), ngăn chặn thất thoát dữ liệu.
- **`dedup.ts`**: Cơ chế chống trùng lặp thông điệp dựa trên cặp khóa nội dung và dấu thời gian (fingerprint hashing).

### 2.2. Lọc Nhiễu Công Cụ (Tool Noise Isolation)
- Khi Worker Agent thực hiện toolcall (đọc file, sửa code, chạy lệnh shell):
  - **Với UI**: Server trích xuất mảng `toolCalls` cấu trúc gửi qua WebSocket để UI render thành các thẻ mở rộng độc lập (`ToolCallBlock`), xem git-diff, terminal ANSI.
  - **Với Orchestrator Context**: Server áp dụng bộ lọc `stripToolNoiseForOrchestrator` và `extractCleanTaskReport` loại bỏ 100% rác toolcall và mã nguồn thô, chỉ giữ lại báo cáo kết quả sạch (`<report>`), giúp tiết kiệm ngữ cảnh (token) và tránh làm rối loạn suy luận của Orchestrator.

---

## 3. Kiến Trúc Tiến Trình Con (Process Pipe & Anti-Orphan Management)

Toàn bộ các tác tử AI được chạy trên tiến trình dòng lệnh độc lập thông qua `src/agents/acp-client.ts`:

### 3.1. Luồng Giao Tiếp Pipe Chuẩn (`stdio: ['pipe', 'pipe', 'pipe']`)
- Không dùng tệp trung gian hay cơ chế `inherit` làm lộ console.
- Input (Prompt/Task) được truyền qua `proc.stdin`.
- Output (Stream JSONL) được bóc tách theo dòng qua `proc.stdout` bằng bộ giải mã `StringDecoder('utf8')`.

### 3.2. Cơ Chế Chống Tiến Trình Mồ Côi (Anti-Orphan Self-Healing)
1. **Broken Pipe Handling**: Bắt sự kiện `proc.stdin.on('error')`. Khi tiến trình cha (Node.js) bị ngắt kết nối bất thường, child process tự động kích hoạt hủy bỏ.
2. **Global PID Registry**: Duy trì `ACPClient.activeChildPids`.
3. **Shutdown Cleanup**: Khi ứng dụng nhận tín hiệu đóng (`exit`, `SIGINT`, `SIGTERM`), hệ thống tự động duyệt cây tiến trình và gọi:
   - Windows: `taskkill /pid <pid> /T /F` (tiêu diệt triệt để cả tiến trình cha lẫn tiến trình con nhánh).
   - Linux/macOS: `proc.kill('SIGKILL')`.

---

## 4. Tầng Dữ Liệu Hạt Mịn (Modular Storage Layer v7.0.0)

Mã nguồn lưu trữ tại `src/storage/` được phân rã thành các module trách nhiệm đơn (Single Responsibility):

| Module | Chức năng chính |
| :--- | :--- |
| **`atomic-disk.ts`** | Đảm bảo an toàn I/O bằng cách ghi vào file tạm `.tmp` trước khi rename thay thế (Atomic Write), chống corrupt file khi mất điện. |
| **`message-storage.ts` & `chat-store.ts`** | Quản lý hội thoại phân vùng theo `teamId`, hỗ trợ định tuyến 3 chiều và tải phân trang. |
| **`queue-storage.ts` & `outbox-store.ts`** | Quản lý hàng đợi Outbox với chu kỳ retry, exponential backoff và cơ chế giải cứu timeout 30s cho tin nhắn `in_flight`. |
| **`agent-store.ts`** | Lưu trữ cấu hình và trạng thái của các tác tử (`idle`, `working`, `stopped`). |
| **`logs-store.ts` & `settings-store.ts`** | Lưu trữ nhật ký hệ thống và cấu hình runtime (Model, API keys, Environment). |
| **`persistence-scheduler.ts`** | Lên lịch đồng bộ dữ liệu từ RAM xuống ổ đĩa định kỳ theo cơ chế non-blocking debounced. |

---

## 5. Kiến Trúc Giao Diện Người Dùng (Modern High-Tech Chat UI)

Frontend (`web/src/components/ChatPanel.tsx`) được xây dựng theo phong cách giao diện Flat Cyberpunk/Dark UI:

### 5.1. Bóc Tách & Render Khối Lệnh Điều Phối
- Không hiển thị thẻ lệnh thô (`<spawn>`, `<talk>`, `[SPAWN]`, `[TALK]`).
- **Thẻ Khởi Tạo (SPAWN AGENT)**:
  - Header với biểu tượng 🚀 **SPAWN AGENT**, nhãn vai trò (`Role Badge`), tên Agent.
  - Body hiển thị khung tóm tắt mô tả nhiệm vụ trên nền gradient tím-indigo.
- **Thẻ Giao Việc (DIRECTIVE / GIAO VIỆC)**:
  - Header với biểu tượng 🎯 **CHỈ THỊ / GIAO VIỆC**, mũi tên điều phối trực quan `👑 Orchestrator ➔ 🤖 Target Agent` kèm Role Badge.
  - Tiêu đề ghim nhiệm vụ `📌 Task Title` và phần hướng dẫn Markdown dễ theo dõi.

### 5.2. Căn Lề Trực Quan Theo Luồng Tin Nhắn
- **Căn lề phải (`flex-end`, `row-reverse`)**: Dành riêng cho tin nhắn gửi đi của User và các thẻ Directive / Giao việc do Orchestrator phát ra.
- **Căn lề trái (`flex-start`, `row`)**: Dành cho các phản hồi, kết quả, và báo cáo nghiệm thu từ Worker Agents gửi về.

### 5.3. Nhận Diện Danh Tính Thực Tế (Dynamic Identity)
- Xóa bỏ nhãn tĩnh "⚡ OpenCode".
- Tự động phân giải danh tính thực tế: `👑 Orchestrator [main]` hoặc tên Agent cụ thể (`coder-core`, `coder-server`, `verifier-audit`...) kèm Role Badge thực tế.

---

## 6. Quy Trình Vận Hành Một Vòng Đời Tác Vụ (Workflow Lifecycle)

```
[1. User gửi yêu cầu]
         │
         ▼
[2. Orchestrator phân tích & phân rã bài toán]
         │
         ├───────────────────────────────────┐
         ▼                                   ▼
[3a. Spawn/Talk Coder (Song song)]  [3b. Spawn/Talk Verifier (Song song)]
         │                                   │
         ▼                                   ▼
[4a. Coder thực thi code qua Pipe]  [4b. Verifier theo sát tiến độ]
         │                                   │
         └─────────────────┬─────────────────┘
                           ▼
[5. Verifier nghiệm thu thực tế trên đĩa cứng (Empirical Check)]
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
      [ĐẠT (PASS)]                [CHƯA ĐẠT (FAIL)]
             │                           │
             ▼                           ▼
[6. Gửi báo cáo hoàn thành]       [Yêu cầu Coder sửa lỗi]
             │
             ▼
[7. Orchestrator tổng hợp & phản hồi User]
```

---
*Tài liệu phát hành chính thức cùng AgentForge v7.0.0 — Cập nhật ngày 03/09/2026.*
