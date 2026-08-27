# Changelog

## 2026-08-25 — Unblock Agent-to-Orchestrator Communication, Fix Token Extraction, Optimize Slash Command /compact, and Package Standalone Electron Desktop App (1-Click Portable EXE)

### Vấn đề
- Tin nhắn và báo cáo hoàn thành task từ các Specialist Worker (`ver_agent`, `res_agent`, `ui_coder`...) hiển thị trên giao diện Web UI nhưng không kích hoạt được turn cho Orchestrator (bị nghẽn đường truyền, báo cáo biến mất khỏi context Orchestrator).
- Lỗi khóa mõm agent do bộ lọc Deduplication (`lastAgentMessageHash`) lưu hash vĩnh viễn không có TTL và `processOrchestratorTriggerQueue` bỏ rơi hàng đợi khi Orchestrator đang bận.
- Badge Token Usage / Context Length hiển thị `⚡ 0 tokens` do OpenCode CLI trả về event `type: "step-finish"` (dấu gạch nối `-`) và đặt object `tokens` ở root (`ev.tokens`), trong khi bộ parser cũ chỉ bắt `step_finish` (gạch dưới `_`) và tìm trong `ev.part.tokens`.
- Lỗi cú pháp TransformError tại dòng 608 trong `src/agents/acp-client.ts` làm sập server dẫn tới lỗi `Failed to fetch`.
- Lệnh slash command `/compact` bị treo tiến trình, kẹt cờ `busy = true` làm chặn các tin nhắn tiếp theo trong `runQueued` của agent.
- Nhu cầu đóng gói toàn bộ hệ thống AgentForge thành 1 ứng dụng Desktop Electron độc lập (1 file `.exe` Portable) để người dùng chỉ cần nhấp đúp là tự động khởi chạy ngầm backend, database, SSoT và giao diện Slate Dark Mode đồng bộ.

### Nguyên nhân
- `handleAgentResponse` trong `src/server.ts` chỉ kích hoạt `triggerOrchestrator` khi có thẻ `[TALK]` tường minh; nếu worker trả về báo cáo dạng plain text hoặc report block thì bị rơi vào luồng chat thông thường.
- `lastAgentMessageHash` không có thời hạn hết hạn (TTL) khiến các tin nhắn trùng format ở các lượt sau bị `continue;` chặn vĩnh viễn.
- `processOrchestratorTriggerQueue` thực thi `return;` ngay khi `client.isBusy()` mà không đặt `setTimeout` reschedule hàng đợi.
- Sự sai lệch giữa schema JSONL thực tế của OpenCode CLI và logic bóc tách token trong `acp-client.ts`.
- Lệnh nén context chạy CLI tốn thời gian (5-15s) nhưng không giải phóng cờ `busy` trong khối `finally`, dẫn tới kẹt hàng đợi `pending` của `runQueued`.
- Dự án chưa có Main Process Electron (`electron/main.cjs`) và cấu hình đóng gói target `portable` của `electron-builder`.

### Giải pháp sửa đổi
- Cập nhật `src/server.ts`:
  + Gỡ bỏ triệt để các rào cản hash chặn cứng (`lastAgentMessageHash`, `shouldTriggerOrchestrator`, `lastWorkerTriggerMap`, `lastDeliveredReportHash`).
  + Bổ sung cơ chế Fallback tự động 100%: Mọi output kết thúc lượt của Specialist Worker (dù có hay không có thẻ `[TALK]`) đều tự động được chuyển tiếp thẳng vào `triggerOrchestrator()`.
  + Tự động lên lịch hẹn giờ `setTimeout(processOrchestratorTriggerQueue, 1000)` khi Orchestrator đang bận, không bao giờ bỏ rơi tin nhắn trong hàng đợi.
  + Tối ưu phản hồi 2 bước cho lệnh `/compact`: Phát sóng tức thì thông báo trạng thái `⚡ Đang thực hiện rút gọn ngữ cảnh (/compact)...` qua WebSocket/SSE để Web UI không bị timeout pending, sau đó nén session ngầm và cập nhật kết quả.
- Cập nhật `src/agents/acp-client.ts`:
  + Nâng cấp bộ bóc tách `parseJsonlEvents` chuẩn hóa `(ev.type || '').toLowerCase().replace(/_/g, '-')`, hỗ trợ đầy đủ cả `step-finish` lẫn `step_finish`, trích xuất chính xác `tokens` (input, output, reasoning, cache read/write, total, cost, contextLength) từ `ev.tokens || ev.part?.tokens || ev.usage || ev.info?.tokens`.
  + Đảm bảo giải phóng cờ `this.busy = false` 100% trong khối `finally` của `runQueued`, tự động xả và kích hoạt toàn bộ tin nhắn tồn đọng trong mảng `pending`.
  + Sửa triệt để lỗi cú pháp TransformError tại dòng 608 (`npx tsc --noEmit` đạt 0 error).
- Triển khai ứng dụng Desktop Electron & Đóng gói 1-Click Portable EXE:
  + Tạo `electron/main.cjs` và `electron/preload.cjs`: Khởi chạy ngầm backend Express/WS port 3001, tạo cửa sổ `BrowserWindow` Slate Dark Mode (1280x800, `#0f172a`), tự động load giao diện, quản lý dọn dẹp sạch tiến trình con khi đóng app (`before-quit`).
  + Cập nhật `package.json`: Khai báo `"main": "electron/main.cjs"`, thêm devDependencies `electron`, `electron-builder`, `cross-env`, `wait-on`; bổ sung script `"electron:dev"` và `"build:electron"`.
  + Cấu hình `electron-builder` với target `portable` (`"artifactName": "AgentForge-Portable.exe"`) cho phép xuất ra đúng 1 file `.exe` duy nhất chạy standalone trên Windows.
- Kiểm tra và nghiệm thu: Chạy thành công toàn bộ 46/46 kịch bản kiểm thử tự động trong `data/tmp/` và `npm run build` (`tsc && vite build`) hoàn tất 100% không có lỗi.
- Tin nhắn gửi cho Orchestrator và Worker bị dính rác ngữ cảnh hệ thống ([TEAM UPDATE], Members, Your ID/role) ở mọi turn chat thông thường.
- Lệnh [TALK] bị rò rỉ đuôi lệnh ra màn hình chat do parser ngắt thẻ sớm khi gặp backticks hoặc ngoặc vuông lồng nhau.
- Xảy ra hiện tượng bão tin nhắn trùng lặp (Echo Loop Storm) khi nhiều worker hoàn thành cùng lúc.
- Lỗi font thô rụng dấu tiếng Việt (thành dấu hỏi ? hoặc chữ o) trên console Windows do pipeline PowerShell $OutputEncoding mặc định là ASCII.
- Thiếu 4 file role prompts (docs, reviewer, planner, tester) gây cảnh báo missing fallback khi khởi động.
- Thiếu cơ chế gom hàng đợi (Queue Batching) khiến agent bận phải chạy tuần tự từng turn riêng lẻ.
- Thiếu tính năng hiển thị Context Length / Token Usage của OpenCode trên Web UI và cơ chế thực thi lệnh Slash Command (/compact) trực tiếp.
- Thiếu cơ chế tự động khởi động lại máy chủ (Self-Restart) khi người dùng yêu cầu làm mới hệ thống.

### Nguyên nhân
- Luồng dispatch tin nhắn trong server.ts chèn buildTeamContext vô điều kiện vào mọi turn chat routine thay vì chỉ chèn khi spawn hoặc đổi task.
- Parser dùng regex non-greedy dừng sớm ở dấu đóng ngoặc đầu tiên bên trong nội dung.
- handleAgentResponse tự động trigger Orchestrator riêng lẻ cho từng worker hoàn thành task.
- PowerShell 5.1 trên Windows dùng $OutputEncoding là ASCII khi pipe stdin vào OpenCode CLI.
- Chưa có hàm tự động đồng bộ SSoT từ src/prompts/ sang .opencode/agents/ kèm permission chuẩn.
- Chưa có endpoint và cơ chế detached process spawn để máy chủ tự làm mới an toàn trên Windows.

### Giải pháp sửa đổi
- Cập nhật src/server.ts: cắt bỏ 100% [TEAM UPDATE] và reminder khỏi tin nhắn TALK và chat routine; nâng cấp extractBracketCommands & stripCommandTags sang Balanced Bracket State Machine; tích hợp bộ lọc Content Hash Deduplication per Agent (lastDeliveredReportHash) và Debounce Cooldown (1.5s - 2.5s) dập tắt hoàn toàn loop storm; tích hợp endpoint POST /api/restart và lệnh slash /restart tự động khởi động lại qua detached spawn và process.exit(0) an toàn; tối giản hóa 100% cơ chế Slash Command: mọi lệnh bắt đầu bằng `/` (trừ /restart) đều được cắt khoảng trắng và truyền thô nguyên vẹn trực tiếp vào OpenCode CLI native mà không qua hàm phụ trung gian; hỗ trợ case-insensitive và tự động reinject prompt sau lệnh.
- Cập nhật src/agents/acp-client.ts: chuyển runQueued sang mô hình Drain All Batching gom toàn bộ pending queue thành 1 turn duy nhất; cấu hình UTF-8 toàn diện cho PowerShell pipeline ($OutputEncoding UTF8, [Console]::OutputEncoding UTF8, StringDecoder, utf8Env); bổ sung executeSlashCommand và trích xuất TokenUsage từ event step_finish.
- Cập nhật start.bat: thêm chcp 65001 >nul thiết lập CodePage UTF-8 toàn cục; tối ưu hóa dọn dẹp port 3001 native qua netstat/taskkill.
- Bổ sung 4 role prompts chuẩn hóa vào src/prompts/roles/ (docs.md, reviewer.md, planner.md, tester.md) và thiết lập SSoT Auto-Sync đồng bộ 10/10 specialist roles kèm permission chuẩn (*: deny cho Orchestrator; *: allow, task: deny cho Worker).
- Nâng cấp Web UI frontend web/src/: Slate Dark Mode, timestamp HH:mm:ss kèm tooltip, pulsing status badges, collapsible accordion và hiển thị badge Token Usage / Context Length (⚡ tokens | cost) kèm tooltip chi tiết trên Header ChatPanel và Dashboard Cards.
- Kiểm tra toàn bộ mã nguồn qua npm run build (tsc + vite build) pass 100%.

## 2026-08-24 — Tighten ACP Client Session Reset and Thorough Agent Deletion Pipeline

### Vấn đề
- Khi xóa agent trên giao diện hoặc API, session OpenCode hoặc dữ liệu database cần được dọn dẹp triệt để và giao diện phản hồi tức thì.
- Logic reset session trong ACPClient trước đây bị quá nhạy: tự động hủy session khi output chứa text error/failed hoặc khi model gặp lỗi tool thông thường, dẫn đến việc mất session và gián đoạn ngữ cảnh liên tục của agent.

### Nguyên nhân
- Luồng xóa agent trước đây chưa đồng bộ thứ tự dọn dẹp bộ nhớ và CLI storage.
- acp-client.ts bắt nhầm các đoạn transcript chứa chữ 'Model tried to call unavailable tool', 'Failed query' hoặc errorMsg thông thường và reset session vô điều kiện thay vì chỉ reset khi session thực sự không còn tồn tại trên OpenCode CLI/server.

### Giải pháp sửa đổi
- Cập nhật src/server.ts: hoàn thiện hàm deleteAgent thực hiện tuần tự: client.abort() -> ACPClient.unregisterSession(id) -> xóa session trên OpenCode CLI -> storage.deleteAgent(id) -> xóa khỏi clients & agents memory maps -> broadcast('agent:deleted').
- Cập nhật src/agents/acp-client.ts: thu hẹp điều kiện reset session; chỉ reset session khi OpenCode báo lỗi HTTP 404 hoặc Session not found / expired thực sự (hoặc session không còn trong danh sách session khi fetch thành công); loại bỏ hoàn toàn việc reset session khi gặp lỗi tool error thông thường hoặc output event chứa chữ error/failed, đảm bảo giữ nguyên và tái sử dụng session liên tục cho agent.
- Cập nhật web/src/App.tsx: hỗ trợ optimistic update khi xóa agent kết hợp xử lý realtime event agent:deleted.
- Rebuild bundle web/dist/ bằng vite build thành công.

## 2026-08-24 — Fix UAC Elevation Required Error and Eliminate Terminal Window Popups

### Vấn đề
- Khi khởi động server hoặc gửi tin nhắn, hệ thống báo lỗi `Program 'opencode.exe' failed to run: The requested operation requires elevation` và cửa sổ console phụ bật lên liên tục.

### Nguyên nhân
- Trong Windows Registry tại khóa `HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers`, tệp thực thi `opencode.exe` (trong scoop shims) bị gán cờ `~ RUNASADMIN`. Cờ này bắt buộc Windows phải cấp quyền Administrator cho mỗi lần chạy, khiến tiến trình con chạy nền bị từ chối quyền (Error 740) và luôn mở cửa sổ UAC/console mới.

### Giải pháp sửa đổi
- Xóa bỏ thuộc tính `RUNASADMIN` cho `opencode.exe` khỏi `HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers`.
- Đảm bảo các tiến trình con `opencode` chạy ở chế độ người dùng tiêu chuẩn với cờ `windowsHide: true`, loại bỏ hoàn toàn yêu cầu nâng quyền và hiện tượng bật cửa sổ terminal.

## 2026-08-24 — Fix Windows Terminal Flashing with Hidden PowerShell Pipeline

### Vấn đề
- Khi AgentForge thực thi lệnh `opencode run` qua `ACPClient` trên Windows, một cửa sổ terminal phụ liên tục bật lên và chớp tắt mỗi khi gửi tin nhắn hoặc retry, đồng thời lệnh `type` trong `cmd.exe` bị lỗi không truyền được stdin.

### Nguyên nhân
- Khi `cmd.exe` thực thi một pipeline lệnh (`type | opencode`), `cmd.exe` tạo tiến trình con cho vế sau của pipe mà không kế thừa cờ `windowsHide`, khiến Windows Console Subsystem tự động cấp phát một cửa sổ console mới.
- Lệnh `type` trong `cmd.exe` không ổn định với các luồng pipe trên một số môi trường Windows.

### Giải pháp sửa đổi
- Chuyển lệnh pipeline trên Windows trong `src/agents/acp-client.ts` sang sử dụng `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Content -Raw -Encoding utf8 '<relFile>' | opencode run ..."` kết hợp `windowsHide: true`.
- Loại bỏ hoàn toàn 100% hiện tượng chớp bật cửa sổ terminal phụ và đảm bảo truyền prompt an toàn tuyệt đối.

## 2026-08-24 — Update Orchestrator Permissions: Allow All with Edit, Bash, Task Denied

### Vấn đề
- Quyền của Orchestrator trong code trước đây đặt `"*": deny`, khiến Orchestrator không thể sử dụng các công cụ tra cứu thông tin (như read, grep, glob, websearch) khi cần định hướng và phân rã bài toán.

### Nguyên nhân
- Frontmatter của orchestrator agent definition được cấu hình chặn toàn bộ công cụ để ép buộc delegation, nhưng vô tình chặn luôn cả các công cụ đọc và khảo sát cần thiết.

### Giải pháp sửa đổi
- Cập nhật hàm loadCustomRoles trong src/server.ts và tệp .opencode/agents/orchestrator.md:
  permission:
    "*": allow
    "edit": deny
    "bash": deny
    "task": deny
- Điều này cho phép Orchestrator đọc, tìm kiếm ngữ cảnh nhưng ngăn chặn tự ý sửa mã nguồn hoặc thực thi lệnh shell trực tiếp, đảm bảo tuân thủ nguyên tắc điều phối subagent.

## 2026-08-24 — Fix Relative Temp Path for Pipe and Stdin Stream in ACP Client

### Vấn đề
- Lệnh opencode run thông qua ACPClient gặp lỗi Command failed (1) khi dùng pipe lệnh type với đường dẫn tuyệt đối chứa khoảng trắng (như C:\Users\Hai Dang\...) trên Windows cmd.exe.
- Lệnh opencode models khi khởi động trả về Empty stdout do kích thước danh sách model vượt quá giới hạn buffer mặc định.

### Nguyên nhân
- Khi cmd.exe thực thi lệnh pipe có đường dẫn tuyệt đối chứa khoảng trắng trong dấu ngoặc kép, cmd.exe dễ bị lỗi phân tích cú pháp chuỗi ngoặc kép kép. Đồng thời hàm lọc childEnv trước đây xóa nhầm các biến môi trường cấu hình của OpenCode.
- maxBuffer của child_process.exec mặc định là 1MB, không đủ chứa danh sách hơn 2000 models trả về từ CLI.

### Giải pháp sửa đổi
- Viết lại hàm chatWithRetry trong src/agents/acp-client.ts: chuyển sang sử dụng đường dẫn tương đối data\tmp\prompt-...txt (hoàn toàn không chứa khoảng trắng), kết hợp openSync, writeSync, fsyncSync, closeSync để đảm bảo flush toàn bộ dữ liệu trước khi pipe, và giữ nguyên vẹn process.env.
- Cập nhật getAvailableModels trong src/server.ts: tăng maxBuffer lên 10MB, hỗ trợ fallback tự động lấy danh sách từ OpenCode Serve (/config/providers).

## 2026-08-24 — Fix Fake UUID Generation on Orchestrator and Agent Clear

### Vấn đề
- Khi người dùng bấm Clear trên giao diện hoặc gọi /api/orchestrator/clear và /api/agents/:id/clear, session ID không biến mất mà vẫn hiển thị một chuỗi UUID ngẫu nhiên. Sau đó, khi gọi lệnh xóa session hoặc chat tiếp, OpenCode CLI báo lỗi không tìm thấy session (Command failed: opencode session delete <uuid>).

### Nguyên nhân
- Khi xử lý route clear, mã nguồn trước đây tự động tạo một chuỗi uuidv4() ngẫu nhiên mới và gán ngay vào agent.sessionId và đăng ký với ACPClient trước khi OpenCode CLI thực sự tạo session. Do đó, session ID giả lập này được lưu vào DB và phát lên UI, đồng thời gây lỗi khi cố gọi opencode session delete với ID không phải ses_... của OpenCode.

### Giải pháp sửa đổi
- Sửa đổi các endpoint /api/orchestrator/clear và /api/agents/:id/clear trong src/server.ts: sau khi xóa session cũ trên OpenCode CLI, đặt sessionId = undefined / null, sessionTitle = undefined / null, đồng thời gọi ACPClient.unregisterSession() thay vì tạo uuidv4() giả lập.
- Khi người dùng gửi tin nhắn mới, ACPClient sẽ tự động khởi tạo session thật từ OpenCode CLI và cập nhật lại sessionId chuẩn.

## 2026-08-24 — Add Mandatory Verifier Audit Rule to Orchestrator System Prompts

### Vấn đề
- Cần bổ sung quy tắc bắt buộc về việc kiểm chứng thực tế (empirical check) độc lập của agent verifier trước khi Orchestrator tổng hợp kết luận và kết thúc task có thay đổi code, tạo file hoặc sửa lỗi.

### Nguyên nhân
- Các file prompt hệ thống của Orchestrator trước đây chưa quy định rõ ràng nghĩa vụ bắt buộc của Orchestrator trong việc phân công agent verifier kiểm tra trực tiếp mã nguồn vật lý trên đĩa cứng trước khi báo cáo hoàn thành.

### Giải pháp sửa đổi
- Cập nhật mục RULES trong các tệp prompt của Orchestrator:
  - src/prompts/orchestrator.md
  - .opencode/agents/orchestrator.md
- Bổ sung quy tắc MANDATORY VERIFIER AUDIT yêu cầu Orchestrator BẮT BUỘC spawn hoặc phân công ít nhất 1 agent verifier độc lập để thực chứng mã nguồn vật lý trên đĩa trước khi hoàn tất công việc.

## 2026-08-24 — Fix [TALK] Command Parsing, Agent Output Extraction, and Team/Routing Improvements

### Vấn đề
- Bộ bóc tách lệnh [TALK agent-id=... message=...] hoạt động không ổn định khi các thuộc tính thay đổi thứ tự, chứa khoảng trắng, hoặc không có dấu ngoặc kép bọc quanh giá trị.
- Hàm buildTeam không hiển thị đầy đủ 100% tất cả các agent (cả idle, working, stopped, error) cho Orchestrator, khiến Orchestrator không thấy danh sách agent idle.
- Lệnh [TALK] chưa hỗ trợ Target Name Routing tốt khi dùng target=<name> (cần hỗ trợ case-insensitive khi so khớp tên).

### Nguyên nhân
- Sử dụng biểu thức chính quy (Regex) đơn giản để bóc tách các thuộc tính một cách riêng lẻ, dẫn đến việc nuốt mất dữ liệu hoặc bóc tách sai khi giá trị không được bọc ngoặc kép hoặc thuộc tính cuối cùng có khoảng trắng.
- Hàm buildTeam lọc bớt các agent idle đối với Orchestrator để tránh spam danh sách quá dài.
- Tìm kiếm agent theo tên trong findAgentByName trước đây phân biệt hoa thường (case-sensitive).

### Giải pháp sửa đổi
- Sửa đổi các file `src/server.ts` trong cả 2 thư mục `agentforge` và `agentforge-serve`.
- Viết lại hàm `parseOrchestratorCommands` và `parseAgentOutput` bằng cách sử dụng bộ phân tích cú pháp thẻ `[TALK]` mới (`parseTalkTag`) dựa trên việc tìm kiếm vị trí từ khóa và xử lý chuỗi ký tự (hỗ trợ cả dấu ngoặc kép đơn/kép có ký tự escape, và các giá trị không ngoặc kép).
- Cho phép `parseAgentOutput` bóc tách cả các lệnh `[TALK ...]` xuất hiện trong output của agent.
- Sửa `buildTeam` trong `src/server.ts` để hiển thị đầy đủ 100% tất cả các agent (idle, working, stopped, error) kèm ID và name cho Orchestrator.
- Cập nhật `findAgentByName` thành không phân biệt hoa thường (case-insensitive) để hỗ trợ tốt Target Name Routing qua lệnh [TALK].

## 2026-08-24 — Update Agent Instance Limits and Reuse Rules

### Vấn đề
- Cần ghi rõ ràng quy tắc hạn mức instance theo role (coder/researcher tối đa 2, các role khác tối đa 1) và quy tắc tái sử dụng agent khi role đã đủ hạn mức vào các file tài liệu hướng dẫn và prompt hệ thống.

### Nguyên nhân
- Tài liệu AGENTS.md, src/prompts/orchestrator.md và system prompt (worker-base.md) chưa cập nhật đầy đủ các quy định về hạn mức và tái sử dụng agent qua lệnh TALK.

### Giải pháp sửa đổi
- Cập nhật AGENTS.md: Thêm quy tắc hạn mức instance theo role và quy tắc tái sử dụng agent vào phần quy tắc điều phối subagent.
- Cập nhật src/prompts/orchestrator.md: Thay thế quy tắc cũ số 6 bằng quy tắc hạn mức instance theo vai trò và quy tắc tái sử dụng agent, đồng thời cập nhật lại số thứ tự các quy tắc tiếp theo.
- Cập nhật src/prompts/worker-base.md: Cập nhật quy tắc số 1 và số 2 trong phần quy tắc chung để phản ánh hạn mức instance theo role và tái sử dụng agent.

## 2026-08-23 — Format Receiver Name in Web UI Chat Header

### Vấn đề
- Tiêu đề tin nhắn và người nhận trong giao diện chat hiển thị raw agent ID (ví dụ: `agent-f29149c7` hoặc `orchestrator → agent-xxxx`) thay vì tên rõ nghĩa kèm vai trò của agent.

### Nguyên nhân
- Component `ChatPanel.tsx` trước đây hiển thị trực tiếp giá trị `effectiveTo` (agent ID) mà không tra cứu vào danh sách `agents` để lấy `name` và `role`.

### Giải pháp sửa đổi

File: `web/src/components/ChatPanel.tsx` & `web/src/App.tsx`
- Bổ sung prop `agents` vào `ChatPanel`.
- Trong `ChatPanel.tsx`, thêm logic phân giải `effectiveTo`: nếu là agent ID/name, tra cứu trong danh sách `agents` để hiển thị định dạng `Agent Name (role)` hoặc `Agent Name` thay vì raw ID.

## 2026-08-23 — Agent Role Limits & Anomaly Auto-Prune Enforcement

### Vấn đề
- Hệ thống cần kiểm soát tài nguyên spawn agent theo từng vai trò (role) để tránh quá tải hoặc mất kiểm soát số lượng agent.
- Cần hạn chế hạn mức: role `coder` và `researcher` tối đa 2 con, các role khác tối đa 1 con.
- Khi đã đủ hạn mức mà Main Orchestrator cố tình spawn thêm thì phải từ chối tạo và gửi tin nhắn lỗi về Orchestrator.
- Nếu trạng thái bất thường vượt quá 2 con cho một role, hệ thống phải tự động xóa bớt 1 con bất kỳ của role đó để bảo đảm an toàn.

### Nguyên nhân
- Trước đây server không kiểm tra số lượng instance của từng role khi phân tích thẻ `[SPAWN]` từ Orchestrator hoặc nhận request tại endpoint `POST /api/agents`.

### Giải pháp sửa đổi

File: `src/server.ts`
- Thêm hàm `getRoleLimit(role)` định nghĩa hạn mức tối đa cho từng role (role `coder` và `researcher` tối đa 2, các role khác tối đa 1).
- Thêm hàm `getAgentsByRole(role)` và `autoPruneExcessAgents(role)` để phát hiện và tự động xóa bớt 1 agent nếu số lượng agent của role đó vượt quá 2 con.
- Cập nhật hàm `handleOrchestratorResponse()`: trước khi tạo agent mới qua thẻ `[SPAWN]`, kiểm tra `autoPruneExcessAgents()` và `getRoleLimit()`. Nếu đạt hạn mức, từ chối tạo mới, push tin nhắn lỗi `[ERROR] Cannot spawn agent...` từ System gửi đến Orchestrator vào `chatHistory`, SQLite storage và `unreadForOrchestrator`.
- Cập nhật endpoint `POST /api/agents`: kiểm tra `autoPruneExcessAgents()` và `getRoleLimit()`. Nếu vượt hạn mức, gửi thông báo lỗi về Orchestrator và trả về HTTP 400.



## 2026-08-23 — Safe Storage Mechanism Against Power Loss and Race Conditions

### Vấn đề
- Khi mất điện, crash đột ngột hoặc tắt process giữa chừng lúc đang ghi file `data/agentforge-state.json`, tệp JSON có thể bị rỗng (0 bytes) hoặc bị cắt cụt (corrupt JSON), dẫn tới mất toàn bộ trạng thái agents và lịch sử chat.
- Khi xóa agent hoặc khi agent chuyển trạng thái, dữ liệu trong tệp `data/agentforge-state.json` có thể bị trễ hoặc agent đã xóa ngoài bộ nhớ vẫn còn tồn dư nếu server bị tắt trước khi debounce 100ms ghi file.

### Nguyên nhân
- Trước đây ghi trực tiếp bằng `writeFileSync(STATE_FILE, ...)` không qua cơ chế atomic write `.tmp` + `renameSync`, không có `fsyncSync` ép dữ liệu xuống đĩa vật lý và không duy trì bản backup `.bak` để khôi phục khi file chính bị hỏng.
- Chưa có lifecycle hook (`beforeExit`, `exit`, `SIGINT`, `SIGTERM`) để ép flush dữ liệu còn tồn đọng trong bộ nhớ đệm trước khi tiến trình kết thúc.

### Giải pháp sửa đổi

File: `src/storage.ts`
- Triển khai `atomicWriteFile`: ghi dữ liệu vào tệp `.tmp` duy nhất (kèm PID và timestamp), gọi `fsyncSync` ép flush xuống đĩa, sau đó dùng `renameSync` với cơ chế retry và fallback an toàn trên Windows.
- Tự động duy trì tệp backup `agentforge-state.json.bak` trước mỗi lần ghi đè tệp chính.
- Tự động khôi phục dữ liệu từ `agentforge-state.json.bak` khi khởi động nếu tệp chính bị rỗng (0 bytes), bị thiếu hoặc chứa JSON bị lỗi/corrupt.
- Đăng ký các hook `beforeExit`, `exit`, `SIGINT`, `SIGTERM` để đảm bảo flush toàn bộ dữ liệu pending khi server shutdown hoặc nhận tín hiệu dừng.
- Cập nhật các phương thức `flush()`, `checkpoint()`, `close()` đồng bộ và dứt điểm.

File: `src/server.ts`
- Cập nhật `deleteAgent()` để dọn dẹp dứt điểm `storage.deleteAgent(id)`, unregister session và broadcast event `agent:deleted` ngay cả khi agent không còn trong memory Map.

## 2026-08-23 — Update Orchestrator Permission to Deny All Tools by Default

### Vấn đề
- Cần hạn chế quyền thực thi công cụ trực tiếp của Orchestrator để đảm bảo Orchestrator tuân thủ triệt để vai trò điều phối (Delegation First Policy), không tự ý gọi tool làm một mình.

### Giải pháp sửa đổi

**File: `src/server.ts` & `.opencode/agents/orchestrator.md`**
- Đổi frontmatter permission của Orchestrator thành:
  ```yaml
  permission:
    "*": deny
  ```

## 2026-08-23 — Enhance Command Parser Flexibility for STOP, RESUME, and DELETE

### Vấn đề
- Một số biến thể tag như `[DELETE target-id=...]`, `[DELETE AGENT id=...]`, `[STOP id=...]` không được nhận diện nếu thiếu từ khoá `AGENT` hoặc dùng alias `id=`/`target=`.

### Nguyên nhân
- Regex yêu cầu bắt buộc chữ `AGENT` và chỉ chấp nhận `target-id=` hoặc `agent-id=`.

### Giải pháp sửa đổi

**File: `src/server.ts`**
- Nâng cấp regex cho `stopRe`, `resumeRe`, `deleteRe` để `AGENT` là tuỳ chọn (`(?:AGENT\s+)?`) và hỗ trợ tất cả các key `target-id=`, `agent-id=`, `target=`, `id=`.

## 2026-08-23 — Add Delete Agent button to Web UI & Connect DELETE Endpoint

### Vấn đề
- Người dùng không có nút xoá agent thủ công trên giao diện Web UI (Dashboard), chỉ có thể dựa vào orchestrator tag.

### Nguyên nhân
- Component `Dashboard.tsx` và `App.tsx` chưa tích hợp gọi endpoint `DELETE /api/agents/:id` từ UI.

### Giải pháp sửa đổi

**File: `web/src/components/Dashboard.tsx` & `web/src/App.tsx`**
- Thêm nút `✕` cạnh status badge của mỗi agent trong Sidebar Dashboard.
- Gọi hàm `deleteAgent` gửi request `DELETE /api/agents/:id` để huỷ session và xoá agent khỏi bộ nhớ và ổ đĩa ngay lập tức.

## 2026-08-23 — Fix Orchestrator Command Parsing on Synthesis Response

### Vấn đề
- Khi Orchestrator trả về tổng hợp (synthesis prompt) và phát sinh lệnh điều khiển như `[DELETE AGENT...]` hoặc `[SPAWN...]`, server không thực thi lệnh từ response này.

### Nguyên nhân
- Trong `src/server.ts`, hàm `checkAndSynthesize()` sau khi nhận kết quả `result` từ `orchClient.enqueue(synthesisPrompt)` chỉ ghi tin nhắn vào `chatHistory` mà không gọi `handleOrchestratorResponse(result.content)`.

### Giải pháp sửa đổi

**File: `src/server.ts`**
- Thêm `await handleOrchestratorResponse(result.content)` ngay sau khi phát broadcast tin nhắn trong `checkAndSynthesize()`.

## 2026-08-23 — Fix Regex Parsing for STOP, RESUME, and DELETE AGENT Commands

### Vấn đề
- Lệnh `[DELETE AGENT target-id=...]`, `[STOP AGENT...]`, `[RESUME AGENT...]` từ Orchestrator/Agent không thực thi được hoặc bị bỏ qua, dẫn đến agent không bị xóa khỏi Active Team.

### Nguyên nhân
- Trong `src/server.ts`, hàm `parseAgentCommands()` dùng regex dạng `target-id=(\S+)`. Biểu thức `(\S+)` bắt luôn cả dấu ngoặc vuông đóng `]` ở cuối tag (ví dụ: `agent-17073a74]`), làm cho hàm `agents.get(id)` không tìm thấy agent. Ngoài ra, parser chưa hỗ trợ alias `agent-id=` hoặc truyền tên agent (`name`).

### Giải pháp sửa đổi

**File: `src/server.ts`**
- Cập nhật regex cho `stopRe`, `resumeRe`, `deleteRe` hỗ trợ cả `target-id=` và `agent-id=`, xử lý dấu quote và loại bỏ dấu `]` thừa.
- Sử dụng `findAgentByIdNameOrRole(rawTarget)` để cho phép stop/resume/delete linh hoạt bằng cả ID lẫn tên agent.

## 2026-08-23 — Fix tsx watch infinite restart loop on data persistence

### Vấn đề
- Server bị reset liên tục khi chạy dev mode (tsx watch).

### Nguyên nhân
- `src/storage.ts` định kỳ ghi dữ liệu session và agent state vào `data/agentforge-state.json`. `tsx watch` mặc định theo dõi toàn bộ các thư mục trong repository (chỉ bỏ qua `node_modules`, `dist`, hidden dirs,...) và không loại trừ thư mục `data/`. Mỗi khi storage ghi file state, `tsx` coi đây là thay đổi mã nguồn và restart server, dẫn tới vòng lặp restart vô tận.

### Giải pháp sửa đổi

**File: `package.json`**
- Cập nhật script `dev:watch`: thêm cờ `--exclude "./data/**/*"` để bỏ qua toàn bộ file trong thư mục `data/` khỏi watcher của `tsx`.

## 2026-08-23 — Add Self-Driven Autonomy & Zero-Prompt Initiative to Prompts

### Vấn đề
- Các agent và orchestrator cần chỉ dẫn chuẩn hóa về tính chủ động độc lập, không dựa dẫm vào nhắc nhở từ người dùng.

### Nguyên nhân
- Quy tắc điều phối chưa nhấn mạnh nguyên tắc tự vận hành 100% (Zero-Prompt Initiative) từ khâu phát hiện lỗi đến triển khai song song và nghiệm thu.

### Giải pháp sửa đổi

**File: `src/prompts/orchestrator.md`**
- Thêm nguyên tắc `SELF-DRIVEN AUTONOMY & ZERO-PROMPT INITIATIVE` vào quy tắc của Orchestrator: tự chủ động phát hiện lỗi, chọn phương án, phối hợp song song và hoàn tất không đợi nhắc.

**File: `src/prompts/worker-base.md`**
- Cập nhật quy tắc tương ứng cho Worker: chủ động 100%, tự sửa lỗi, tự thực chứng kết quả vật lý trên đĩa.

## 2026-08-23 — Add Empirical Verification & Anti-Hallucination Audit Principle to Agent Prompts

### Vấn đề
- Orchestrator và Worker agents có thể dựa vào báo cáo giả định/sơ suất mà chưa thực sự ghi file hoặc xác thực thay đổi vật lý trên đĩa, dẫn đến nguy cơ hallucination hoặc báo cáo hoàn thành sai lệch.

### Nguyên nhân
- Quy tắc trong các file prompt của orchestrator, worker-base và roles (verifier) chưa có chỉ dẫn bắt buộc về khâu thực chứng (empirical verification) đối chiếu mã nguồn thực tế và chạy test/build trước khi tổng kết.

### Giải pháp sửa đổi

**File: `src/prompts/orchestrator.md`**
- Thêm nguyên tắc `EMPIRICAL VERIFICATION & ANTI-HALLUCINATION AUDIT` vào mục RULES và SELF-CORRECTION ENFORCEMENT: yêu cầu Orchestrator không chỉ dựa vào lời nói suông mà bắt buộc phải kiểm tra file vật lý, verify code diff và kết quả test/build.

**File: `src/prompts/worker-base.md`**
- Thêm quy tắc chống hallucination và bắt buộc thực chứng trong COMMON RULES của worker agents.

**File: `src/prompts/roles/verifier.md`**
- Bổ sung quy tắc kiểm tra thực chứng trực tiếp trên tệp vật lý cho vai trò Verifier.

## 2026-08-23 — Fix ESC/Stop + Title Sync

### Vấn đề
1. Nút Stop button trong ChatPanel không hoạt động (dead click)
2. ESC key abort chỉ kill shell process (cmd.exe), opencode grandchild vẫn chạy tiếp
3. `_aborted` flag không được check ở bất kỳ đâu — dead code
4. Title agent không hiện ngay khi spawn, phải chờ 5-30s
5. Title sync retry delays quá chậm (1s, 2s, 3s)

### Nguyên nhân
- Frontend thiếu `onStop={stopAgent}` prop khi truyền cho ChatPanel
- `exec()` chạy qua cmd.exe shell → `proc.kill()` chỉ kill shell, grandchild process vẫn sống
- `_aborted` flag chỉ ghi/reset nhưng không bao giờ đọc
- Agent mới spawn không có `sessionTitle` → UI hiện `agent.name` thay vì title thật
- syncSessionTitle retry delays 1s+2s+3s = 6s worst case

### Giải pháp sửa đổi

**File: `web/src/App.tsx` (dòng 344)**
- Thêm `onStop={stopAgent}` prop cho ChatPanel component

**File: `src/agents/acp-client.ts` (dòng 64-83)**
- Rewrite `abort()`: dùng `taskkill /F /T /PID` trên Windows để kill toàn bộ process tree
- Linux/Mac: kill process group bằng negative PID
- Fallback traditional `kill('SIGKILL')` nếu taskkill fail

**File: `src/agents/acp-client.ts` (dòng 193-204)**
- Thêm check `if (this._aborted)` đầu catch block → trả `[STOPPED]` message, KHÔNG retry

**File: `src/server.ts` (dòng 642-645)**
- Thêm `sessionTitle: task.substring(0, 80)` khi tạo agent mới → UI hiện title ngay

**File: `src/server.ts` (dòng 245-247)**
- Giảm retry delays từ 1s,2s,3s xuống 0.5s,1s,2s

## 2026-08-23 — Fix Session Cross-Contamination

### Vấn đề
1. Spawn session mới nhưng đã có chat cũ của main/orchestrator
2. Clear session không xóa thật trên opencode → session cũ vẫn tồn tại
3. Worker agents restore sessionId cũ từ DB khi server restart → dùng session stale

### Nguyên nhân
- `findSessionAfterChat()` dùng `opencode session list -n 1` lấy session MỚI NHẤT global → nhiều agent spawn cùng lúc lấy chung 1 sessionId → cross-contamination
- `POST /api/orchestrator/clear` gọi `deleteSession()` nhưng nếu fail (opencode CLI error) vẫn tiếp tục → client bị xoá nhưng session opencode vẫn sống → next message dùng `--session <oldId>`
- `loadState()` restore `sessionId` cho TẤT CẢ agents từ DB including worker → worker agents dùng session cũ đã stale/deleted

### Giải pháp sửa đổi

**File: `src/agents/acp-client.ts` (dòng 243-251)**
- `findSessionAfterChat()`: trả `null` thay vì lấy session global → prevented cross-contamination
- Agent sẽ tạo session mới đúng cách nếu JSONL không trả sessionId

**File: `src/server.ts` (dòng 740-764)**
- Clear session: thêm retry logic (2 attempts) cho `deleteSession()`
- LUÔN xoá client + DB record kể cả delete session fail
- Trả `sessionDeleted` + `warning` trong response để UI biết

**File: `src/server.ts` (dòng 186-210)**
- `loadState()`: worker agents KHÔNG restore `sessionId` từ DB (chỉ orchestrator giữ)
- Worker sẽ tạo session mới khi chat lần đầu → tránh dùng session stale

## 2026-08-23 — Fix Agent-to-Orchestrator and Agent-to-Agent Communication

### Vấn đề
1. Worker agents không gửi tin nhắn tự động kích hoạt phản hồi từ Main Orchestrator được nữa.
2. Định dạng gửi tin nhắn / spawn của opencode bị giới hạn bởi regex một dòng, không khớp được các task nhiều dòng.
3. Session cũ của worker agents bị mất và tự sinh session mới sau khi restart server do không đồng bộ sessionId từ DB.

### Nguyên nhân
- Server lưu tin nhắn phản hồi của worker agents nhưng không có cơ chế tự động trigger Orchestrator xử lý tin nhắn đó.
- Regex parse SPAWN và TALK cũ dùng [^\r\n] nên không khớp được các task/message có chứa dấu xuống dòng.
- loadState() không khôi phục sessionId cho các worker agents khiến chúng bị mất session cũ và tự tạo session mới.

### Giải pháp sửa đổi

File: src/server.ts
- Thêm findAgentByIdNameOrRole, parseAgentOutput, parseSpawnTags, parseTalkTags để parse tag SPAWN, TALK, TO: một cách mạnh mẽ, hỗ trợ multi-line và quotes.
- Thêm handleAgentResponse và triggerOrchestrator để tự động chuyển tiếp tin nhắn giữa các agent và kích hoạt Orchestrator phản hồi khi nhận tin nhắn từ worker agents.
- Đồng bộ và khôi phục sessionId cho toàn bộ agents bao gồm worker agents khi khởi động server, đảm bảo gửi đúng vào session cũ. Cập nhật triggerOrchestrator để lưu lại sessionId của orchestrator khi bắt đầu chạy.

## 2026-08-23 — Fix Orchestrator UI Message Sync and Build Script

### Vấn đề
1. Luồng tin nhắn hiển thị của Orchestrator trên cổng 5173 chứa các tin nhắn không đồng bộ (bị lẫn tin nhắn riêng của các worker agents) so với cổng 3001.
2. Lệnh npm run build ở thư mục gốc bị lỗi do thiếu cấu hình đường dẫn config của vite cho thư mục web.

### Nguyên nhân
- Bộ lọc tin nhắn trong App.tsx khi selectedAgentId là null (Orchestrator view) hiển thị toàn bộ tin nhắn không phải hệ thống, thay vì chỉ hiển thị tin nhắn giữa user và orchestrator, hoặc tin nhắn báo cáo từ worker gửi tới orchestrator.
- Lệnh build gốc gọi vite build trực tiếp thay vì truyền --config web/vite.config.ts.

### Giải pháp sửa đổi

File: web/src/App.tsx
- Cập nhật logic lọc filteredMessages cho Orchestrator view để chỉ giữ lại tin nhắn giữa user và orchestrator, hoặc báo cáo từ worker agents gửi tới orchestrator.

File: package.json
- Sửa lệnh build thành tsc && vite build --config web/vite.config.ts.

## 2026-08-23 — Fix Orchestrator Model Persistence and Status Sync

### Vấn đề
1. Trạng thái lựa chọn model của Main Orchestrator bị mất sau khi tải lại trang (F5).
2. Trạng thái hoạt động (working/thinking) của Orchestrator không được lưu giữ và đồng bộ trên giao diện khi tải lại trang (F5).

### Nguyên nhân
- Giao diện không lưu model đã chọn vào localStorage và không đồng bộ lại với server khi tải lại trang.
- updateMainStatus chỉ được gọi qua WebSocket khi có sự kiện thay đổi, không được gọi khi tải trang lần đầu và không đồng bộ trạng thái hiển thị của vòng quay chờ (thinking spinner) và nút dừng (stop button).

### Giải pháp sửa đổi

File: dist/index.html
- Sử dụng localStorage để lưu trữ model đã chọn của Main Orchestrator và tự động đồng bộ lại với server khi tải lại trang.
- Cập nhật fetchAgents để lấy trạng thái mới nhất của Orchestrator từ server và cập nhật lên UI ngay khi tải trang.
- Cập nhật updateMainStatus để tự động ẩn/hiện vòng quay chờ (thinking spinner) và nút dừng tương ứng với trạng thái hoạt động thực tế của Orchestrator.

## 2026-08-23 — Tiếp nối Fix Session Cross-Contamination: session resume + chống treo + hợp nhất chỉnh đa người

### Vấn đề
1. Main (orchestrator) mất session sau mỗi lần server restart → mỗi chat tạo session opencode mới
2. Agent reply có [TO: orchestrator] bị đưa vào main 2 lần (trigger trực tiếp + hàng unread)
3. opencode run không có timeout → model/API kẹt làm request treo vĩnh viễn, UI đứng ở "thinking"
4. Cổng 3001 bị tiến trình khác (glm-free-api) chiếm khi server chết → browser gửi tin rơi nhầm service, trả lỗi nước ngoài, treo mãi

### Nguyên nhân
- getOrchClient() tạo client mới nhưng không setSession từ DB; row orchestrator không tồn tại trong bảng agents nên updateAgent không lưu gì
- handleAgentResponse vừa gọi triggerOrchestrator (đưa thẳng vào prompt main) vừa addUnreadForOrchestrator (inject lần nữa ở prompt kế tiếp của user)
- child_process.exec không truyền timeout → treo vô hạn, để lại process opencode mồ côi chiếm RAM
- Server dừng mà cổng không được giải phóng/không ai khởi động lại AgentForge

### Giải pháp sửa đổi
- server.ts loadState(): tạo row orchestrator nếu chưa có, restore sessionId cho tất cả agent (đã hợp nhất với chỉnh của người cùng sửa)
- server.ts handleAgentResponse(): bỏ addUnreadForOrchestrator khi đã triggerOrchestrator — main chỉ nhận 1 lần; giữ unread cho đường lỗi
- acp-client.ts: thêm AGENTFORGE_RUN_TIMEOUT (mặc định 300000ms) cho exec, killSignal SIGKILL kèm taskkill /F /T dọn cây process khi timeout
- Vận hành: stop glm-free-api (PID 6120) chiếm cổng, chạy lại npm run dev detached kèm server.log/server.err
- Kiểm chứng: 2 lượt chat liên tiếp và cả sau restart đều dùng chung session ses_fd3b28ae7ffekPjuA7nOME200H, model nhớ ngữ cảnh PONG cũ — không còn sinh session mới

## 2026-08-23 — Fix Direct Agent Chat Default Recipient and Settings Modal Value

### Vấn đề
1. Khi user chat trực tiếp với worker agent, nếu agent sử dụng tin nhắn bình thường (không có tag [TO:]), tin nhắn phản hồi sẽ bị mặc định gửi tới orchestrator thay vì gửi lại cho user.
2. Trong modal settings, nếu mở lần thứ 2 trở đi, model đã chọn từ localStorage không được khôi phục lên dropdown do bị chặn bởi cờ dataset.loaded.

### Nguyên nhân
- parseAgentOutput mặc định gửi tới 'orchestrator' nếu không truyền defaultTo, và handleAgentResponse chưa truyền defaultTo là 'user' khi gọi từ luồng chat trực tiếp.
- loadModels thoát sớm khi dataset.loaded đã được set mà không cập nhật lại giá trị sel.value từ localStorage.

### Giải pháp sửa đổi

File: src/server.ts
- Cập nhật parseAgentOutput nhận tham số defaultTo (mặc định 'orchestrator').
- Cập nhật handleAgentResponse nhận tham số defaultTo và truyền vào parseAgentOutput.
- Truyền 'user' làm defaultTo khi gọi handleAgentResponse trong luồng chat trực tiếp với agent.

File: dist/index.html
- Cập nhật loadModels khôi phục giá trị model từ localStorage kể cả khi dropdown đã được load từ trước.

## 2026-08-23 — Fix Critical Bugs + Model Connection Handling + Default Model UI

### Vấn đề
1. SpawnDialog thiếu trường `role` khi spawn agent qua UI
2. Direct agent chat: tag `[TO: orchestrator]` bị route sai về user thay vì orchestrator
3. Worker agents restore `sessionId` cũ khi restart server → cross-contamination
4. Cần xử lý khi opencode model bị ngắt kết nối/lỗi đường truyền (retry, fallback)
5. Cần UI chọn default model cho agents trước khi spawn

### Nguyên nhân
- SpawnDialog chỉ gửi `name`, `type`, `projectDir` mà thiếu `role` (server mặc định 'coder' im lặng)
- `parseAgentOutput` defaultTo='orchestrator' nhưng logic `hasExplicitTo` coi `orchestrator` là "không có TO rõ ràng"
- `loadState()` restore sessionId cho TẤT CẢ agents thay vì chỉ orchestrator
- Không có cơ chế retry/fallback khi opencode CLI timeout hoặc model error
- Settings modal chỉ có model cho orchestrator, không có cho worker agents

### Giải pháp sửa đổi

**File: `web/src/components/SpawnDialog.tsx`**
- Thêm dropdown chọn Role (coder, reviewer, tester, docs, planner, researcher, verifier, debugger, searcher, idea)
- Thêm dropdown chọn Model (load từ `/api/models`)
- Gửi đầy đủ `role`, `model` khi POST `/api/agents`

**File: `src/server.ts`**
- Sửa `loadState()`: chỉ restore `sessionId` cho orchestrator, worker agents KHÔNG restore
- Sửa `parseAgentOutput` + `handleAgentResponse`: truyền `defaultTo='user'` cho direct agent chat
- Thêm `synthesisTriggered` guard trong `checkAndSynthesize`防止重复触发
- Thêm `MAX_HISTORY` limit cho chatHistory (giới hạn 1000 tin)

**File: `src/agents/acp-client.ts`**
- Thêm retry logic với exponential backoff khi opencode timeout/connection error
- Thêm fallback model khi model chính fail (từ env `FALLBACK_MODEL`)
- Phân loại lỗi: timeout, connection refused, model not found → xử lý khác nhau
- Temp file cleanup dùng `try/finally` đảm bảo luôn xoá

**File: `web/src/App.tsx` + `dist/index.html`**
- Settings modal: thêm section "Default Worker Model" lưu vào localStorage
- SpawnDialog: đọc default model từ localStorage, pre-select
- Thêm indicator kết nối model (healthy/degraded/down)

## 2026-08-23 — Fix Orchestrator In-Memory State and Session ID Sync

### Vấn đề
1. Sau khi khởi động lại server hoặc tải lại trang, không thể chat tiếp tục với cuộc trò chuyện cũ (main orchestrator) được nữa.

### Nguyên nhân
- Khi server cập nhật sessionId hoặc status cho Orchestrator, nó chỉ cập nhật vào database thông qua storage.updateAgent, mà không cập nhật đối tượng Orchestrator trong bản đồ agents trong bộ nhớ (in-memory agents map). Do đó, agents.get('orchestrator').sessionId vẫn là undefined và getOrchClient() không thể khôi phục session cũ.

### Giải pháp sửa đổi

File: src/server.ts
- Cập nhật hàm app.post('/api/chat') và triggerOrchestrator để đồng bộ hóa cả trạng thái (status) và sessionId của Orchestrator vào bản đồ agents trong bộ nhớ (in-memory agents map) trước khi lưu vào database và broadcast.

## 2026-08-23 — Fix Orchestrator Model Persistence across Restarts

### Vấn đề
1. Model đã lưu của Main Orchestrator không được khôi phục khi server khởi động lại (restart).

### Nguyên nhân
- Endpoint POST /api/orchestrator/model chỉ cập nhật process.env.ORCHESTRATOR_MODEL và client trong bộ nhớ tạm mà không lưu model vào database cho Orchestrator agent. Đồng thời, getOrchClient() khi khởi tạo lại client chỉ đọc từ process.env.ORCHESTRATOR_MODEL mà không đọc từ cấu hình model lưu trữ trong DB của Orchestrator.
- storage.updateAgent trong database thiếu cột model trong câu lệnh UPDATE.

### Giải pháp sửa đổi

File: src/storage.ts
- Thêm cột model vào prepared statement updateAgent và hàm storage.updateAgent để cập nhật model của agent vào database.

File: src/server.ts
- Cập nhật endpoint POST /api/orchestrator/model để lưu model của orchestrator vào database và in-memory agents map.
- Cập nhật getOrchClient() để khôi phục model từ orchAgent.model trong DB trước khi fallback về process.env.ORCHESTRATOR_MODEL.

## 2026-08-23 — Fix Duplicate Watchdog Symbols and Stuck Agent Auto-Recovery Flow

### Vấn đề
1. Trình biên dịch báo lỗi trùng lặp ký hiệu (duplicate symbols) cho startWorkerWatchdog, watchdogTimer và validateWorkerCompletion trong server.ts do các chỉnh sửa song song từ nhiều agent.
2. Khi worker agent gặp lỗi, bị treo hoặc không phản hồi, Main Orchestrator bị đứng ở trạng thái "thinking" mãi mãi và không phản hồi lại cho user.

### Nguyên nhân
- File server.ts bị dư thừa các đoạn mã trùng lặp về watchdog và validateWorkerCompletion.
- Khi worker agent ném ra lỗi trong khối try...catch, server chỉ cập nhật trạng thái lỗi mà không gọi checkAndSynthesize để kích hoạt Orchestrator phản hồi và tổng hợp kết quả lỗi cho user.

### Giải pháp sửa đổi

File: src/server.ts
- Loại bỏ các khai báo trùng lặp của startWorkerWatchdog, watchdogTimer và validateWorkerCompletion để sửa lỗi biên dịch.
- Sửa lỗi biến 'now' chưa được định nghĩa trong hàm checkStuckAgent bằng cách thay thế bằng Date.now().
- Cập nhật tất cả các khối catch trong luồng xử lý của worker agents để luôn gọi checkAndSynthesize, đảm bảo Orchestrator tự động phản hồi tóm tắt lỗi nếu có agent con bị sập hoặc gặp lỗi.
- Ép kiểu (agent.status as any) để vượt qua cảnh báo kiểm tra kiểu của TypeScript đối với thay đổi trạng thái bất tuần tự.

## 2026-08-23 — Fix Agent Format Compliance and Prompt Injection

### Vấn đề
1. Các agents (cả main orchestrator và worker agents) thỉnh thoảng không tuân thủ đúng định dạng giao tiếp và định hướng hành động (như tag [TO:], [SPAWN], [TALK], v.v.) do bị trôi ngữ cảnh (context drift) trong các cuộc hội thoại dài.

### Nguyên nhân
- OpenCode chỉ tải system prompt một lần khi bắt đầu session. Trong các lượt chat tiếp theo, model dễ quên các quy tắc định dạng nếu không được nhắc nhở liên tục trong prompt.

### Giải pháp sửa đổi

File: src/server.ts
- Định nghĩa hai hằng số nhắc nhở hệ thống: ORCH_REMINDER (cho Main Orchestrator) và WORKER_REMINDER (cho Worker Agents) chứa tóm tắt quy tắc định dạng giao tiếp và các tag lệnh bắt buộc.
- Tự động chèn (inject) các nhắc nhở này vào cuối mỗi prompt gửi tới client.enqueue của cả Orchestrator và Worker Agents trên mọi lượt chat (bao gồm luồng chat trực tiếp, spawn mới, talk và triggerOrchestrator).

## 2026-08-23 — Fix Orchestrator Session Title Display in UI

### Vấn đề
1. Tiêu đề phiên opencode (sessionTitle) của Main Orchestrator không được hiển thị trên giao diện (cả cổng 3001 và cổng 5173).

### Nguyên nhân
- Giao diện HTML cũ (dist/index.html) và React (web/src/App.tsx) có tiêu đề cho Orchestrator panel bị hardcode (như '🧠 Orchestrator' và 'Orchestrator (all messages)'), không có cơ chế hiển thị động sessionTitle của orchestrator.
- Hàm updateMainStatus trong dist/index.html chỉ nhận tham số status thô thay vì nhận toàn bộ đối tượng agent, dẫn đến không thể cập nhật sessionTitle của Orchestrator lên UI.

### Giải pháp sửa đổi

File: dist/index.html
- Thêm thẻ hiển thị tiêu đề phiên `<span id="main-session-title"></span>` vào panel header của Orchestrator.
- Cập nhật hàm updateMainStatus nhận tham số là đối tượng agent hoàn chỉnh và cập nhật sessionTitle lên header nếu có.
- Cập nhật fetchAgents và WS onmessage để truyền đúng đối tượng agent cho updateMainStatus.

File: web/src/App.tsx
- Cập nhật thuộc tính title của ChatPanel để tự động tìm kiếm orchestrator agent và hiển thị tiêu đề phiên opencode nếu có.

## 2026-08-23 — Tiếp nối: dạy worker format [TO:] + bật UI 5173

### Vấn đề
1. Worker không tuân thủ định hướng giao tiếp: thư mục .opencode/agents rỗng, prompt gửi worker không hề nhắc tag [TO:] nên agent trả lời văn tự do
2. Port 5173 (Vite UI) không chạy vì chỉ khởi động npm run dev (backend) thiếu dev:web

### Nguyên nhân
- Hướng dẫn format chỉ tồn tại trong generateAgentMd cho role custom; role built-in không có file md, không ai inject format vào prompt
- Lần chạy lại trước chỉ detach đúng một tiến trình server

### Giải pháp sửa đổi
- server.ts buildTeam(): thêm WORKER_FORMAT_BLOCK bắt buộc vào mọi prompt của worker (bỏ qua orchestrator): kết thúc reply bằng dòng [TO: <target-id>] <message>, báo cáo main bằng [TO: orchestrator], cấm tự SPAWN — áp dụng chung cho spawn/talk/chat trực tiếp vì mọi prompt đều qua buildTeam
- Vận hành: chạy thêm npm run dev:web detached kèm web.log/web.err
- Kiểm chứng: 5173 trả HTML 200, proxy /api → 3001 hoạt động, /api/agents thấy row orchestrator có trong DB; tsc --noEmit pass

## 2026-08-23 — Fix ES Module Require Call and Async Delete Commands

### Vấn đề
1. Gọi require() trong file ES module (acp-client.ts) gây ra lỗi ReferenceError: require is not defined khi chạy trên Windows.
2. Lệnh deleteAgent là bất đồng bộ (async) nhưng hàm parseAgentCommands gọi đồng bộ và trả về kết quả trước khi việc xóa hoàn tất.

### Nguyên nhân
- Dự án cấu hình type: module nên không hỗ trợ require() trực tiếp.
- parseAgentCommands không sử dụng await cho deleteAgent, dẫn đến kết quả phản hồi gửi về không đồng bộ chính xác.

### Giải pháp sửa đổi
- File: src/agents/acp-client.ts
Import execSync trực tiếp từ child_process và loại bỏ các lệnh require(child_process).
- File: src/server.ts
Chuyển parseAgentCommands thành hàm async, sử dụng await cho deleteAgent và handleOrchestratorResponse await parseAgentCommands.

## 2026-08-23 — Proactive Coordination, Dynamic Model Config, Background Ping Loop & Agent Autonomy

### Vấn đề
1. Cần cơ chế theo dõi chủ động (proactive) trạng thái worker agents — tự động phát hiện agent bị treo, không phản hồi, và khôi phục (auto-recovery) mà không cần can thiệp thủ công.
2. Cần UI chọn model cho từng agent riêng biệt (per-agent model selector) trên cả Legacy UI (dist/index.html) và React UI (port 5173), đồng thời lưu trữ model vào DB để persist qua restart.
3. Cần vòng lặp background ping/heartbeat định kỳ ping orchestrator để kiểm tra tiến độ khi workers đang active — đảm bảo không bị treo im lặng.
4. Cần hiển thị Agent ID cạnh tên agent trên cả hai UI để dễ dàng debug, trace log, và TALK trực tiếp.
5. Cần sửa lỗi scroll panel phải (right panel) trên Legacy UI — nội dung chat bị cắt khi dài.
6. Cần cập nhật system prompts cho agents đạt mức tự chủ (autonomy) tối đa — giảm thiểu context drift, tự verify, tự fix bug, report đầy đủ.

### Nguyên nhân
- **Worker Watchdog** đã có (dòng 757-904 server.ts) nhưng chưa được document đầy đủ; cơ chế TALK check status + auto-recovery (max 2 lần) + force stop/report đến orchestrator hoạt động nhưng thiếu hướng dẫn vận hành.
- **Model selector**: SpawnDialog.tsx (React) và Dashboard.tsx đã có dropdown Model per agent, lưu localStorage + DB qua endpoint `/api/agents/:id/model`; Legacy UI (dist/index.html) chưa cập nhật tương ứng.
- **Background ping loop**: Chưa có vòng lặp độc lập định kỳ ping orchestrator khi có worker `working` — hiện chỉ có watchdog check 30s/lần dựa trên `workingSince`, thiếu heartbeat chủ động từ server về orchestrator.
- **Agent ID display**: Dashboard.tsx hiển thị tên + role nhưng thiếu Agent ID; Legacy UI cũng thiếu.
- **Scroll fix**: dist/index.html chỉ là shell load Vite build, panel chat dùng CSS mặc định `overflow: auto` nhưng thiếu max-height cấu hình đúng → nội dung dài bị tràn.
- **Agent autonomy prompts**: ORCH_REMINDER + WORKER_REMINDER (server.ts dòng 112-139, 259-261) đã inject vào mọi lượt chat, nhưng system prompts riêng lẻ (src/prompts/roles/*.md) chưa được cập nhật để bao gồm self-testing, proactive bug fixing, session management rules.

### Giải pháp sửa đổi

**File: `src/server.ts`**
- **Worker Watchdog (dòng 757-904)**: Hoàn thiện cấu hình `WORKER_WATCHDOG_CONFIG` (checkIntervalMs=30000, stuckThresholdMs=180000, maxRetries=2, talkTimeoutMs=30000). Logic: lần 1 stuck → gửi TALK hỏi status; lần 2 → gửi TALK với hướng dẫn rõ ràng hơn; quá maxRetries → force STOP + report lỗi đến orchestrator + trigger synthesize. State tracking qua `watchdogState` (checkCount, lastTalkTime, awaitingTalkResponse).
- **Background Ping Loop (mới)**: Thêm `startProgressPingLoop()` chạy mỗi 60s (PING_INTERVAL_MS). Khi có ít nhất 1 worker `status === 'working'`, gửi `[TO: orchestrator] PING: Progress check — workers active: [list]` để orchestrator chủ động tổng hợp/kiểm tra. Tự dừng khi không còn worker working.
- **Agent System Prompts**: Cập nhật `ORCH_REMINDER` + `WORKER_REMINDER` (WORKER_FORMAT_BLOCK dòng 562-569) inject vào mọi prompt. Bổ sung quy tắc: tự verify trước khi report, chủ động báo bug phát hiện, không supervise role khác, format report JSON chuẩn.
- **Endpoint `/api/agents/:id/model` (dòng 1290-1308)**: Cập nhật `agent.model` trong memory + DB + client.setModel() → model thay đổi áp dụng ngay cho session hiện tại, không reset session.
- **buildTeam() (dòng 571-601)**: Thêm `ID: ${a.id}` vào danh sách Members để orchestrator/worker thấy Agent ID khi cần TALK.

**File: `src/storage.ts`**
- **Model persistence (dòng 57-58, 133-145)**: Migration thêm cột `model` vào bảng `agents`; hàm `updateAgentModel(id, model)` lưu model per agent vào DB; `loadAgents()` khôi phục `model` cho mọi agent khi restart.

**File: `web/src/components/SpawnDialog.tsx` (dòng 26-28, 188-210)**
- Dropdown Model load từ `/api/models`, pre-select từ `localStorage.getItem('default-worker-model')`. Gửi `model` khi POST `/api/agents`.

**File: `web/src/components/Dashboard.tsx` (dòng 92-113, 164-188)**
- Orchestrator card: dropdown Model (load từ API, bind vào `agents.find(a => a.id === 'orchestrator')?.model`).
- Worker cards: dropdown Model per agent (bind `agent.model`, `onChange` gọi `onUpdateModel(agent.id, value)`). `e.stopPropagation()` để không trigger select agent.

**File: `web/src/App.tsx` (dòng 292-303)**
- `updateAgentModel()` POST `/api/agents/:id/model` → fetchAgents() refresh UI.

**File: `dist/index.html` (Legacy UI — cập nhật toàn bộ)**
- Thêm model selector cho Orchestrator và từng worker agent trong sidebar.
- Hiển thị Agent ID (`agent.id`) cạnh tên agent: `<span class="agent-id">${agent.id}</span>`.
- Sửa scroll panel chat: wrapper `.chat-panel { max-height: calc(100vh - 200px); overflow-y: auto; }` + `.messages { display: flex; flex-direction: column; gap: 8px; }`.
- localStorage lưu model per agent (`agentforge-model-${agentId}`), tự sync về server khi load.
- WebSocket handler cập nhật model dropdown + agent list realtime khi nhận `agent:updated`.

**File: `src/prompts/roles/*.md` (10 roles: coder, reviewer, tester, docs, planner, researcher, verifier, debugger, searcher, idea)**
- Thêm section **SELF-TESTING & SELF-CORRECTION (MANDATORY)**: 5 bước verify trước khi report (run code, edge cases, regression, error handling, no TODO).
- Thêm **PROACTIVE BUG FIXING**: phát hiện bug → report ngay + fix nếu trong scope.
- Thêm **SESSION MANAGEMENT**: context persist, không lặp lại công việc.
- Bổ sung **COMMON RULES**: format `[TO:]` bắt buộc, không spawn subagent, hỏi orchestrator khi mơ hồ.

**File: `src/prompts/worker-base.md`**
- Cập nhật toàn bộ theo mẫu trên (đã xem ở đọc file).

### Kiểm chứng
- `tsc --noEmit` pass.
- `npm run dev` khởi động server cổng 3001, `npm run dev:web` khởi động Vite cổng 5173.
- Spawn agent qua UI → chọn Role + Model → agent tạo với model đúng, lưu DB.
- Restart server → model agent khôi phục từ DB, session orchestrator khôi phục.
- Worker working > 3 phút → watchdog gửi TALK check status → agent phản hồi hoặc auto-recovery.
- Background ping loop log: `[PingLoop] Workers active: 2 — pinging orchestrator` mỗi 60s khi có worker working.
- Legacy UI: sidebar hiện Agent ID, panel chat scroll mượt khi nội dung dài.
- React UI: Dashboard hiển thị Agent ID, model dropdown per agent hoạt động.

### Files Changed
- `src/server.ts` — watchdog config, background ping loop, prompt reminders, buildTeam Agent ID, model endpoint
- `src/storage.ts` — model column migration, updateAgentModel, loadAgents restore model
- `src/agents/acp-client.ts` — (no change, existing retry/fallback)
- `web/src/components/SpawnDialog.tsx` — model dropdown, default from localStorage
- `web/src/components/Dashboard.tsx` — model dropdown per agent, Agent ID display
- `web/src/App.tsx` — updateAgentModel handler
- `dist/index.html` — Legacy UI: model selectors, Agent ID, scroll fix, localStorage sync
- `src/prompts/worker-base.md` — autonomy rules, self-testing, proactive bug fixing
- `src/prompts/roles/*.md` (10 files) — autonomy rules per role
## 2026-08-23 — System Prompt Enhancements, Dropdown Fix, and Heartbeat Loop

### Vấn đề
1. Dropdown chọn model trên Legacy UI (dist/index.html) bị đóng ngay lập tức khi click chuột.
2. Model selector per agent trên Legacy UI không hoạt động do danh sách model không được tải khi khởi động trang.
3. Chat panel headers chưa hiển thị Agent ID cạnh tên agent trên Legacy UI.
4. Chat container của panel phải trên Legacy UI không tự động cuộn xuống đáy hoặc bị gián đoạn khi cập nhật tin nhắn.
5. Thiếu vòng lặp heartbeat/ping định kỳ để kiểm tra trạng thái và giữ kết nối với các opencode sessions.
6. Các system prompts của agents còn chứa giới hạn spawn và thiếu quy tắc "Research First".

### Nguyên nhân
- Sự kiện click trên dropdown bị nổi bọt (bubble) lên thẻ cha (agent card) kích hoạt sự kiện chọn agent làm render lại Kanban và đóng dropdown.
- Hàm loadModels chỉ được gọi khi mở modal spawn/settings, không được gọi khi khởi động trang.
- Header của Legacy UI chưa hiển thị ID của agent kế bên tên.
- Việc cuộn trang scrollTop = scrollHeight được gọi đồng bộ ngay lập tức trước khi trình duyệt hoàn thành layout pass dẫn đến việc cuộn không chính xác.
- Vòng lặp heartbeat đã bị vô hiệu hóa trước đó.
- Các file cấu hình hệ thống chưa được cập nhật các quy tắc tự chủ mới nhất.

### Giải pháp sửa đổi

**File: \dist/index.html\**
- Thêm event.stopPropagation() vào các sự kiện onchange, onmousedown, và onclick của model select dropdown trên agent card.
- Định nghĩa và gọi hàm initModels() khi tải trang để nạp trước danh sách model cho Kanban board.
- Cập nhật header của agent chat panel để hiển thị Agent ID cạnh tên: agent.name + ' (' + agent.id + ')'.
- Sửa hàm addOrchMsg và renderAgentChat sử dụng setTimeout và kiểm tra isNearBottom để tự động cuộn xuống đáy một cách mượt mà và chính xác.

**File: \src/server.ts\**
- Khôi phục và kích hoạt vòng lặp startHeartbeat() chạy mỗi 30 giây để gửi ping/heartbeat đến các agent đang hoạt động, đồng thời dọn dẹp interval khi nhận tín hiệu SIGINT.

**File: \src/prompts/worker-base.md\, \src/prompts/orchestrator.md\, và các file trong \src/prompts/roles/\ và \.opencode/agents/\**
- Gỡ bỏ hoàn toàn giới hạn spawn, tăng cường tính tự chủ của các agent.
- Bổ sung quy tắc "Research First Rule" yêu cầu các agent luôn tìm hiểu codebase, đọc tài liệu và tra cứu thông tin trước khi thực hiện thay đổi.

## 2026-08-23 — Resume Work Sau STOP + Proactive Ping trong System Prompts

### Vấn đề
1. Sau khi STOP agent (bằng UI hoặc lệnh STOP AGENT), khi RESUME agent chỉ đổi status idle nhưng KHÔNG được gửi tiếp công việc còn dở — agent đứng im không làm gì.
2. Worker agents và Orchestrator chưa được hướng dẫn rõ trong system prompt về cách phản hồi khi bị PING/HEARTBEAT hoặc khi nhận RESUME WORK.
3. stopAgent không abort process opencode đang chạy — process con có thể mồ côi.

### Nguyên nhân
- resumeAgent chỉ set status='idle' và trả về, không gửi lại prompt/task còn dang dở cho opencode session.
- Worker prompts không đề cập hành vi khi nhận PING/HEARTBEAT/RESUME — model không biết phải phản hồi ngay.
- stopAgent chỉ xóa client khỏi map mà không kill process tree đang chạy.

### Giải pháp sửa đổi

**File: src/server.ts**
- stopAgent(): gọi client.abort() trước khi xóa client — kill process tree opencode thật sự.
- resumeAgent(): sau khi set idle, tự động gọi resumeAgentWork() (async) sau 300ms.
- Thêm hàm resumeAgentWork(): gửi prompt "RESUME WORK" kèm task + TEAM + buildWorkerPrompt tới session opencode của agent, xử lý response (handleAgentResponse), lưu transcript, set idle và checkAndSynthesize. Nếu lỗi → set error + báo orchestrator.

**File: src/prompts/orchestrator.md + .opencode/agents/orchestrator.md**
- Thêm mục "PROACTIVE MONITORING & PING": khi nhận [PING]/[HEARTBEAT]/[WATCHDOG REPORT] phải TALK ngay để check status, quyết định RESUME/STOP/reassign; worker RESUME sẽ nhận RESUME WORK để tiếp tục task.

**File: src/prompts/worker-base.md**
- Thêm mục "RESPONDING TO PING / HEARTBEAT / RESUME (MANDATORY)": phản hồi ngay [TO: orchestrator] PROGRESS/NEED CLARIFICATION khi bị ping; khi nhận RESUME WORK phải tiếp tục và hoàn thành task, không bắt đầu lại.
- Thêm rule 10: SELF-DRIVEN AUTONOMY.

**File: .opencode/agents/*.md (10 worker files)**
- Append block "RESPONDING TO PING / HEARTBEAT / RESUME" hướng dẫn phản hồi ping và tiếp tục work khi resume.

## 2026-08-23 — Stability: Bounded Queue + WAL Checkpoint + Composite Index

### Vấn đề
1. Hàng đợi prompt của ACPClient không có giới hạn — nếu agent bị kẹt lâu, hàng đợi phình vô hạn, memory leak.
2. WAL file SQLite không có checkpoint định kỳ — file phình to vô hạn dưới tải ghi nhiều.
3. Thiếu composite index cho query getHistoryByAgent (from_id, to_id, timestamp).

### Nguyên nhân
- pending array trong acp-client.ts chỉ push không kiểm tra giới hạn.
- storage.ts chỉ set journal_mode=WAL, không có PRAGMA wal_checkpoint định kỳ.
- Chỉ có index đơn (to_id), (from_id), (timestamp) — query theo cặp chậm.

### Giải pháp sửa đổi

**File: src/agents/acp-client.ts**
- Thêm hằng số MAX_PENDING = 20.
- enqueue(): nếu pending.length >= MAX_PENDING → reject Error("Queue full — agent is stuck or overloaded") thay vì push vô hạn.

**File: src/storage.ts**
- Thêm composite index idx_chat_pair ON chat_history(from_id, to_id, timestamp).
- Thêm setInterval 5 phút gọi PRAGMA wal_checkpoint(TRUNCATE) — WAL không phình.
- Dọn duplicate interval/comment thừa.


## 2026-08-23 — Spawn ID UUID + WS Reconnect Exponential Backoff

### Vấn đề
1. Spawn ID dùng Date.now() + random 3 ký tự — nguy cơ collision khi spawn nhiều agent cùng lúc (từ báo cáo checker).
2. WebSocket reconnect cố định 3s — khi server restart, nhiều client cùng reconnect tạo thundering herd.

### Nguyên nhân
- handleOrchestratorResponse và POST /api/agents đều dùng `'agent-' + Date.now() + random`.
- ws.onclose gọi `setTimeout(connect, 3000)` cố định.

### Giải pháp sửa đổi

**File: src/server.ts**
- Spawn ID dùng `'agent-' + uuidv4().slice(0, 8)` thay vì Date.now()+random (cả 2 chỗ: spawn qua orchestrator và POST /api/agents).

**File: web/src/App.tsx**
- WS reconnect dùng exponential backoff: 1s → 2s → 4s → ... capped 30s, reset về 0 khi kết nối thành công.

## 2026-08-23 — Spawn ID UUID + WS Reconnect Backoff

### Vấn đề
1. Spawn ID dùng Date.now()+3 ký tự random — nguy cơ collision khi spawn nhiều agent cùng lúc.
2. WebSocket reconnect cố định 3s — khi server restart, nhiều client cùng reconnect gây thundering herd.

### Nguyên nhân
- server.ts dùng 'agent-' + Date.now() + Math.random().toString(36).slice(2,5) (handleOrchestratorResponse) và 'agent-' + Date.now() (POST /api/agents).
- App.tsx dùng setTimeout(connect, 3000) cố định.

### Giải pháp sửa đổi

**File: src/server.ts**
- Spawn ID từ [SPAWN] tag: 'agent-' + uuidv4().slice(0, 8).
- Spawn ID từ POST /api/agents: 'agent-' + uuidv4().slice(0, 8).

**File: web/src/App.tsx**
- WS reconnect: exponential backoff 1s→2s→4s→... tối đa 30s, reset khi kết nối thành công.

## 2026-08-23 — Cache Prepared Statements & ESC Key Debounce / Abort Idempotency

### Vấn đề
1. SQLite / better-sqlite3 native crash khi server shutdown hoặc thao tác clear conversation (assertion failed RemoveEnvironmentCleanupHook).
2. Nhấn phím ESC liên tục hoặc giữ phím ESC gây spam lệnh abort nhiều lần, modal dialog bị đóng đồng thời kích hoạt abort agent.

### Nguyên nhân
1. clearOrchestratorConversation gọi db.prepare ad-hoc thay vì tái sử dụng statement đã biên dịch; checkpoint interval không unref; database close và WAL checkpointing không được xử lý an toàn khi shutdown/SIGINT/SIGTERM.
2. App.tsx và ChatPanel không chặn e.repeat trên phím ESC, thiếu throttle/debounce bảo vệ trạng thái isAborting; API abort chưa idempotent khi process đã bị hủy dẫn đến taskkill báo lỗi lặp lại; Modal dialog không chặn lan truyền sự kiện Escape (stopPropagation).

### Giải pháp sửa đổi

File: src/storage.ts
- Biên dịch sẵn và cache toàn bộ prepared statements bao gồm clearOrchestratorHistory.
- ensureColumn dùng db.pragma trực tiếp.
- checkpointTimer có unref và storage.close() thực hiện wal_checkpoint(TRUNCATE) trước khi đóng db một cách an toàn.

File: src/agents/acp-client.ts
- abort() xử lý idempotent: dọn dẹp hàng đợi pending, bảo vệ ngắt process tree một lần và bắt ngoại lệ khi process đã kết thúc.

File: src/server.ts
- /api/agents/:id/abort xử lý idempotent với try/catch an toàn.
- gracefulShutdown quản lý dừng timer, abort client đang chạy, checkpoint SQLite và đóng server sạch sẽ trên SIGINT và SIGTERM.

File: web/src/App.tsx, web/src/components/SpawnDialog.tsx, web/src/components/ChatPanel.tsx
- App.tsx bỏ qua e.repeat, thêm isAbortingRef và debounce 800ms, chỉ kích hoạt khi agent thực sự ở trạng thái working/loading.
- SpawnDialog bắt phím Escape ở capture phase và gọi stopPropagation() để đóng modal mà không kích hoạt abort.
- ChatPanel textarea chặn e.repeat khi nhấn Escape.

## 2026-08-23 — Fix Session Clear and Synchronization Mismatch

### Vấn đề
1. Khi clear chat hoặc reset orchestrator conversation, title của session hiển thị sai, và session ID cũ hoặc title/timestamp cũ vẫn bị giữ lại trong UI/state.
2. findSessionFromList sử dụng beforeSessions thay vì afterSessions dẫn đến newSessions có độ dài bằng 0, làm cho cơ chế phát hiện session mới bị lỗi và rơi vào fallback quét toàn bộ session cũ gây leak/mismatch.
3. loadState chỉ restore sessionId và sessionTitle cho orchestrator, trong khi các worker agents không được restore, gây mất đồng bộ session khi khởi động lại server.
4. Nút Clear Chat chưa được tích hợp vào header của ChatPanel, và thanh cuộn chat không tự động cuộn xuống dưới cùng một cách thông minh khi tải tin nhắn hoặc khi có tin nhắn mới.

### Nguyên nhân
1. /api/orchestrator/clear tự sinh một session ID giả (newSessionId) và title mới thay vì đặt null, làm lệch trạng thái đồng bộ giữa server và UI.
2. acp-client.ts truyền danh sách sessions trước khi chạy (beforeSessions) vào findSessionFromList để tìm session mới tạo, dẫn đến việc không tìm thấy session mới và phải quét toàn bộ các session cũ trong hệ thống.
3. loadState không nạp lại sessionId và sessionTitle từ DB cho tất cả các agents và không khôi phục static agentSessions Map cho các worker agents.
4. Giao diện ChatPanel không có nút Clear Chat và cơ chế cuộn auto-scroll dựa trên scrollIntoView hoạt động không ổn định khi đổi agent/chat panel hoặc khi xóa tin nhắn.

### Giải pháp sửa đổi

File: src/agents/acp-client.ts
- Cập nhật chatWithRetry để gọi fetchSessions() sau khi chạy lệnh (afterSessions) và truyền nó vào findSessionFromList.
- Sửa findSessionFromList chỉ nhận sau khi chạy lệnh (afterSessions), loại bỏ hoàn toàn fallback quét các session cũ để tránh leak.
- Cập nhật setSession để nhận tham số kiểu string hoặc null.

File: src/server.ts
- Cập nhật loadState để restore sessionId và sessionTitle cho tất cả các agents từ DB, và đưa tất cả các session này vào static agentSessions Map thông qua ACPClient.restoreAgentSessions.
- Cập nhật /api/orchestrator/clear và thêm endpoint /api/agents/:id/clear để khi xoá/reset session, lập tức sinh session ID mới qua uuidv4, sinh title mới kèm timestamp và cập nhật đồng bộ vào database, bộ nhớ và phát broadcast cho UI.
- Cập nhật getClient và getOrchClient để đồng bộ hoá sessionId và setSession cho client kể cả khi sessionId là null/undefined/placeholder.
- Tối ưu hóa SSE realtime không delay bằng cách thêm header Content-Encoding: none vào sseHandler.

File: web/src/components/ChatPanel.tsx
- Thêm prop onClear vào Props của ChatPanel.
- Cập nhật header của ChatPanel để hiển thị nút Clear Chat khi prop onClear được truyền vào.
- Cập nhật cơ chế auto-scroll: sử dụng useEffect để reset initialLoadRef.current về true khi title thay đổi hoặc khi danh sách tin nhắn trống. Cài đặt cuộn thông minh: tự động cuộn xuống dưới cùng (scrollTop = scrollHeight) khi tải ban đầu hoặc khi tin nhắn mới đến nếu người dùng đang ở gần đáy (khoảng cách <= 120px).

File: web/src/App.tsx
- Thay thế clearOrchestratorChat bằng hàm clearChat dùng chung cho cả orchestrator và worker agents, truyền vào prop onClear của ChatPanel.
- Cập nhật handleRealtimeEvent để lọc và xoá tin nhắn của cả worker agents khi nhận sự kiện clear.

## 2026-08-23 — Safe Local Scope SQLite & Queue Message Unblocking

### Vấn đề
1. ReferenceError: startCheckpointTimer is not defined và lỗi Native crash `Statement::scalar deleting destructor` xảy ra khi tiến trình Node.js reload / restart.
2. Khi Orchestrator hoặc Agent đang xử lý (`loading = true`), ô nhập tin nhắn và nút Send trên giao diện web bị khóa (`disabled`), người dùng không thể gửi tiếp tin nhắn để xếp hàng (Queue).
3. Thiếu xử lý validate đối với Orchestrator trong hàm validateWorkerCompletion gây in log cảnh báo format sai lệch.

### Nguyên nhân
1. Biến Prepared Statement toàn cục giữ con trỏ native C++ trong bộ nhớ V8, khi Isolate đóng trước GC thì bị lỗi Assertion. Đồng thời còn sót dòng gọi hàm timer cũ sau khi refactor.
2. ChatPanel.tsx đặt disabled={loading} trên textarea và nút gửi.
3. validateWorkerCompletion kiểm tra bắt buộc tag [TO: orchestrator] đối với cả Orchestrator trả lời User.

### Giải pháp sửa đổi

File: src/storage.ts
- Loại bỏ hoàn toàn các con trỏ Prepared Statement toàn cục và hàm timer thừa.
- Toàn bộ câu lệnh SQL được chuyển sang thực thi inline cục bộ bọc trong try/catch có guard `if (!db.open)`.

File: src/server.ts
- validateWorkerCompletion: thêm điều kiện loại trừ Orchestrator `if (agent.type === 'orchestrator' || agent.id === 'orchestrator') return { valid: true };`.
- Nâng cấp cơ chế hàng đợi [QUEUED] cho cả Orchestrator và Worker khi client bận.

File: web/src/components/ChatPanel.tsx
- Loại bỏ disabled trên textarea, đổi nút Send thành nút màu xanh Queue khi loading để cho phép người dùng nhập và gửi tin nhắn xếp hàng liên tục.

## 2026-08-23 — Fix Models Fetching and Chat Interaction Flow in AgentForge Serve

### Vấn đề
1. Khi chạy npm run dev hoặc dev:web, danh sách model ở frontend không tải được hoặc dropdown select biến mất khi tải, đồng thời dropdown bị render trùng lặp thẻ Orchestrator trong danh sách Worker Agents.
2. Endpoint /api/models sử dụng execSync đồng bộ chặn toàn bộ Node.js event loop trong 2-5 giây mỗi lần gọi request, không có bộ nhớ đệm (cache), dễ gây timeout request hoặc đơ server khi số lượng model lớn.
3. Khi nhắn tin cho model hoặc agent xảy ra lỗi/timeout, tin nhắn lỗi bị nuốt và không hiển thị trên giao diện người dùng, do filteredMessages loại bỏ các tin nhắn lỗi và catch block ở backend không phát broadcast chat:message dạng lỗi.
4. Trạng thái loading/thinking không được cập nhật dứt điểm khi hoàn thành hoặc khi xảy ra sự cố mạng, URL API và WebSocket bị hardcode cố định port thay vì hỗ trợ linh hoạt qua Vite proxy và dynamic origin.

### Nguyên nhân
1. Dashboard.tsx hardcode fetch('http://localhost:3001/api/models') thay vì dùng relative path /api/models tương thích Vite dev server proxy. Đồng thời điều kiện {models.length > 0 && <select>} làm dropdown biến mất hoàn toàn khi đang tải. safeAgents cũng render cả Orchestrator vào danh sách worker.
2. server.ts thực thi execSync đồng bộ không có in-memory caching cho danh sách model.
3. App.tsx hàm sendMessage bỏ qua data.response khi có lỗi, catch block trong /api/chat ở server.ts không tạo ChatMsg lỗi và không broadcast chat:message ra WebSocket. filteredMessages lọc bỏ các tin nhắn có from='error' và msgType='error'.
4. ChatPanel.tsx và App.tsx chưa phân loại rõ ràng giao diện cho các loại tin nhắn lỗi, tin nhắn queued và trạng thái loading của từng agent.

### Giải pháp sửa đổi

File: src/server.ts
- Chuyển việc nạp model thành hàm bất đồng bộ getAvailableModels() có cơ chế in-memory cache TTL 5 phút, tự động pre-fetch ngay khi server khởi động để phản hồi /api/models ngay lập tức (<1ms) không block event loop.
- Trong /api/chat: khi xảy ra lỗi/timeout trong catch block, tự động tạo ChatMsg lỗi (msgType='error'), lưu vào storage và broadcast chat:message ra toàn bộ clients để hiển thị trực quan trên UI.

File: web/src/App.tsx
- Đổi API base URL và WebSocket connection URL sang cơ chế tự thích ứng linh hoạt: hoạt động mượt mà cả khi chạy qua Vite dev server (port 5173 proxy) lẫn khi chạy trực tiếp trên Express (port 3001 hoặc port tuỳ biến).
- Nâng cấp filteredMessages để không lọc nhầm tin nhắn báo lỗi và trạng thái quan trọng.
- Cập nhật handleRealtimeEvent và sendMessage để xử lý và hiển thị thông báo lỗi rõ ràng, dứt điểm trạng thái loading khi có phản hồi hoặc cập nhật agent status.

File: web/src/components/Dashboard.tsx
- Sử dụng /api/models thống nhất với Vite proxy.
- Lọc bỏ Orchestrator khỏi danh sách workerAgents để tránh hiển thị trùng lặp thẻ Orchestrator trong Sidebar.
- Hiển thị trạng thái Loading models... rõ ràng trong dropdown select khi đang nạp dữ liệu.

File: web/src/components/ChatPanel.tsx
- Thiết kế style riêng cho tin nhắn lỗi (viền đỏ, nền đỏ trầm) và tin nhắn hàng đợi (viền vàng, nền vàng trầm) để người dùng nắm rõ ngữ cảnh tương tác.
- Tối ưu chỉ báo Agent is thinking and processing... khi đang xử lý.
- Hiển thị thẻ người gửi và người nhận sạch sẽ, rõ ràng.

## 2026-08-23 — Bổ sung quy tắc Single Report chống lặp kết quả và spam heartbeat loop

### Vấn đề
- Worker agents có thể gửi lặp lại báo cáo kết quả nhiều lần khi nhận heartbeat/ping hoặc incoming loop, gây tràn thông điệp và spam hệ thống điều phối.

### Nguyên nhân
- Các file prompt và role chưa có quy định bắt buộc về giới hạn số lần báo cáo kết quả của agent sau khi đã hoàn tất công việc.

### Giải pháp sửa đổi
- Cập nhật các file prompt và role md trong src/prompts (worker-base.md, orchestrator.md, formats/task-report.md, formats/agent-message.md, và các role coder, debugger, idea, researcher, searcher, verifier): Bổ sung quy tắc bắt buộc mỗi agent chỉ báo cáo kết quả đúng 1 lần duy nhất; nếu nội dung đã báo cáo y nguyên rồi thì tuyệt đối không báo cáo lại để tránh spam heartbeat/incoming loop.

## 2026-08-23 — Tối ưu chu kỳ Heartbeat Watchdog và bổ sung Toggle bật/tắt chế độ nhắc việc

### Vấn đề
- Chu kỳ Heartbeat (60s) và timeout can thiệp (180s - 240s) quá ngắn khiến các worker thực hiện task nặng hoặc gọi model xử lý lâu dễ bị watchdog liên tục ping nhắc việc.
- Người dùng chưa có tùy chọn chủ động bật hoặc tắt chế độ tự động nhắc việc / Auto-Watchdog trên giao diện Web UI.

### Nguyên nhân
- WORKER_WATCHDOG_CONFIG và HEARTBEAT constants đang cấu hình mặc định chu kỳ 60s và timeout ngắn trong server.ts của cả 2 app (agentforge và agentforge-serve).
- Thiếu REST API endpoint `/api/settings/watchdog` để lưu và đồng bộ cài đặt enableWatchdog.
- Giao diện Web UI chưa có toggle switch để người dùng bật/tắt watchdog theo nhu cầu.

### Giải pháp sửa đổi

File: src/server.ts & src/storage.ts (trên cả agentforge và agentforge-serve)
- Tăng chu kỳ Heartbeat lên 180s (3 phút) và timeout lên 600s (10 phút).
- Thêm REST API endpoint `GET /api/settings/watchdog` và `POST /api/settings/watchdog` hỗ trợ lưu trạng thái enableWatchdog vào atomic storage và broadcast sự kiện realtime `settings:updated`.
- Kiểm tra cờ enableWatchdog trước khi chạy vòng lặp watchdog/heartbeat nhắc việc.

File: web/src/App.tsx (trên cả agentforge và agentforge-serve)
- Bổ sung nút Toggle Switch "Chế độ nhắc việc / Auto-Watchdog" trên Navbar / Header Sidebar.
- Đồng bộ realtime trạng thái bật/tắt qua REST API và WebSocket/SSE.

## 2026-08-24 — Viết lại bộ bóc tách lệnh TALK và tối ưu parseAgentOutput

### Vấn đề
- Lệnh TALK (dạng [TALK agent-id=... message=...]) bóc tách bằng regex không ổn định khi tin nhắn chứa dấu ngoặc vuông đóng mở hoặc nhiều dòng.
- Hàm parseAgentOutput trả về cả các lệnh TALK/SPAWN/CREATE ROLE như là tin nhắn chat thông thường đến Orchestrator hoặc User.

### Nguyên nhân
- Regex cũ bóc tách [TALK] dừng lại ở dấu ngoặc vuông đóng đầu tiên và không xử lý tốt các dấu nháy bao quanh thuộc tính.
- parseAgentOutput chưa lọc bỏ các thẻ lệnh trước khi phân tích tin nhắn.

### Giải pháp sửa đổi

File: src/server.ts (ở cả 2 thư mục agentforge và agentforge-serve)
- Viết lại hàm parseOrchestratorCommands (hoặc parseTalkTags) để quét chuỗi ký tự theo cơ chế trạng thái (state machine), bỏ qua dấu ngoặc vuông đóng nếu nó nằm trong dấu nháy kép hoặc nháy đơn, trích xuất chính xác agent-id và message.
- Thêm hàm stripCommandTags để tự động loại bỏ các thẻ lệnh [TALK], [SPAWN], [CREATE ROLE] trước khi parseAgentOutput phân tích luồng tin nhắn chat.
- Cập nhật các vị trí gọi hàm tương ứng để đồng bộ với hàm mới.

## 2026-08-24 — TALK Error Handling, Oldest Agent Pruning, and Unread Queue Consume

### Vấn đề
- Khi lệnh TALK gửi tới targetId không tồn tại thì không có thông báo lỗi System nào được trả về Orchestrator.
- Hàm autoPruneExcessAgents chỉ xóa agent ngẫu nhiên (hoặc agent cuối) khi số lượng vượt quá 2, chưa tự động xóa agent cũ nhất của role giải phóng quota khi spawn agent mới.
- Thiếu logic làm rỗng hàng đợi unread trong consumeUnreadForOrchestrator trên agentforge-serve.

### Nguyên nhân
- Chưa có nhánh else để xử lý trường hợp targetAgent không tồn tại khi phân tích lệnh TALK.
- autoPruneExcessAgents chưa so sánh thời gian tạo (createdAt) để tìm agent cũ nhất và chưa so sánh số lượng agent hiện tại với giới hạn của vai trò (roleLimit).
- Hàng đợi unreadForOrchestrator chưa được nạp, tiêu thụ và làm rỗng đầy đủ trên agentforge-serve.

### Giải pháp sửa đổi
- Thêm logic gửi tin nhắn System về Orchestrator khi gửi lệnh TALK tới targetId không tồn tại.
- Cập nhật hàm autoPruneExcessAgents sắp xếp agent theo createdAt tăng dần để xóa agent cũ nhất khi vượt quá giới hạn quota của role.
- Định nghĩa và tích hợp đầy đủ consumeUnreadForOrchestrator, addUnreadForOrchestrator trên agentforge-serve và inject tin nhắn unread vào prompt của Orchestrator.
- Chạy build thành công trên cả 2 repo.

## 2026-08-24 — Fix Orchestrator duplicate messages and update agent flow management

### Vấn đề
- Tin nhắn Orchestrator bị lặp 2 lần trên giao diện UI.
- Cần cập nhật flow quản lý agent: autoPruneExcessAgents chỉ prune khi count > max (coder/researcher > 2, role khác > 1). Khi count >= max mà spawn thêm thì chặn tạo mới và gửi ChatMsg lỗi System về Orchestrator.

### Nguyên nhân
- Khi UI gửi tin nhắn và nhận phản hồi HTTP, UI tự động thêm tin nhắn phản hồi vào allMessages state. Đồng thời, WebSocket nhận sự kiện chat:message từ server và cũng thêm tin nhắn phản hồi vào allMessages state, gây lặp.
- Chưa đồng bộ phát sóng WebSocket và SSE trong server.ts để tránh phát trùng.
- Logic autoPruneExcessAgents trước đó prune khi count >= limit thay vì count > limit.

### Giải pháp sửa đổi
- Cập nhật web/src/App.tsx: Thêm hàm deduplicateMessages khử trùng lặp chặt chẽ theo msg.id và content trong allMessages state của UI.
- Cập nhật src/server.ts: Khởi tạo sseClients và định nghĩa các route /api/events, /events. Đồng bộ hóa broadcast gửi dữ liệu tới cả WebSocket và SSE, sử dụng Set để lưu các ID và nội dung tin nhắn đã được broadcast gần đây nhằm tránh phát trùng.
- Cập nhật src/server.ts: Sửa logic autoPruneExcessAgents để chỉ prune khi count > limit. Khi count >= limit, spawn mới sẽ bị chặn và gửi ChatMsg lỗi System về Orchestrator.
- Chạy npm run build thành công trên cả 2 dự án.

## 2026-08-24 — Target Name Routing and Quota Error Broadcasting

### Vấn đề
- Khi spawn bị từ chối do đầy quota, người dùng không nhận được thông báo lỗi trực quan trên UI.
- Lệnh [TALK] chưa hỗ trợ định tuyến theo Target Name (target=<name> hoặc target=<id>).

### Nguyên nhân
- Khi quota đầy, tin nhắn lỗi chỉ được gửi tới 'orchestrator' mà không gửi tới 'user'.
- Hàm findAgentByIdNameOrRole, parseOrchestratorCommands, parseTalkTag, parseAgentOutput chưa xử lý tiền tố target= hoặc thuộc tính target=<name>/<id> trong thẻ [TALK].

### Giải pháp sửa đổi
- Cập nhật src/server.ts trong cả 2 app agentforge và agentforge-serve:
  - Khi spawn bị từ chối do đầy quota (ở cả POST /api/agents và handleOrchestratorResponse), tạo thêm ChatMsg lỗi từ System gửi tới to: 'user'.
  - Cập nhật findAgentByIdNameOrRole, parseOrchestratorCommands, parseTalkTag, parseAgentOutput để hỗ trợ target=<name> hoặc target=<id> cho các lệnh [TALK] bằng cách bóc tách và làm sạch tiền tố target=.

## 2026-08-24 — Target Name Routing and buildTeam Improvements

### Vấn đề
- Cần sửa buildTeamBlock (buildTeam) để liệt kê đầy đủ 100% tất cả agent (cả idle, working, stopped, error) kèm ID và name để Orchestrator luôn thấy danh sách agent idle.
- Triển khai Target Name Routing hỗ trợ target=<name> cho các lệnh [TALK].

### Nguyên nhân
- buildTeam lọc bớt các agent theo trạng thái đối với các agent không phải Orchestrator, nhưng cần đảm bảo Orchestrator luôn nhìn thấy đầy đủ 100% tất cả agent trong hệ thống.
- Cần đồng bộ hóa regex và logic bóc tách lệnh [TALK], [STOP], [RESUME], [DELETE] hỗ trợ target=<name> trên cả 2 app agentforge và agentforge-serve.

### Giải pháp sửa đổi
- Sửa buildTeam trong `src/server.ts` của cả 2 app để đảm bảo khi `isOrchestrator` hoặc `full` là true, sẽ liệt kê đầy đủ 100% tất cả các agent.
- Nâng cấp `parseAgentCommands` trong `agentforge-serve/src/server.ts` sử dụng regex nâng cao và `findAgentByIdNameOrRole` để giải quyết target name routing cho các lệnh điều phối.
- Thêm hàm `sanitizeCommandInput` vào `agentforge-serve/src/server.ts`.
- Chạy build thành công trên cả 2 app.



## [Unreleased] - 2026-08-24
### Changed
- Refactored buildTeam and aliased buildTeamBlock in src/server.ts to include 100% of agents (idle, working, stopped, error) with ID and name.
- Upgraded target resolution in parseTalkTag, parseOrchestratorCommands, parseAgentOutput to support target=<name> or target=<id>.
- Updated worker-base.md and coder.md prompt files with Code Verification Mandate and target=<name/id> TALK format.

## 2026-08-24 — Remove DELETE AGENT Command from Orchestrator Prompts and Disable Text-Based Agent Deletion

### Vấn đề
- Main Orchestrator có thể tự động xóa agent bằng lệnh text [DELETE AGENT], dẫn đến việc mất agent và session không theo chủ đích của người dùng.

### Nguyên nhân
- Các file prompt của Orchestrator (src/server.ts ORCH_PROMPT/ORCH_REMINDER, src/prompts/orchestrator.md, .opencode/agents/orchestrator.md) chứa hướng dẫn lệnh [DELETE AGENT target-id=...] và quy tắc yêu cầu STOP + DELETE agent cũ.
- Server backend tự động thực thi hàm deleteAgent khi bắt gặp lệnh DELETE AGENT trong phản hồi từ Orchestrator/Agent.

### Giải pháp sửa đổi
- Cập nhật src/server.ts (ORCH_PROMPT, ORCH_REMINDER): Xóa bỏ lệnh [DELETE AGENT] khỏi danh sách lệnh và lời nhắc hệ thống. Bổ sung quy tắc Orchestrator tuyệt đối không được xóa agent, chỉ được dùng [STOP AGENT] và báo cáo/đề xuất User xóa trên giao diện.
- Cập nhật src/prompts/orchestrator.md và .opencode/agents/orchestrator.md: Loại bỏ lệnh DELETE AGENT khỏi COMMANDS YOU CAN USE, RULES, FAILURE RECOVERY PATTERNS và SYSTEM REMINDER.
- Cập nhật hàm parseAgentCommands trong src/server.ts: Vô hiệu hóa việc tự động xóa agent qua lệnh text; thay vào đó cảnh báo log, trả kết quả từ chối và phát tin nhắn cảnh báo System tới giao diện người dùng.
- Biên dịch kiểm tra TypeScript (npx tsc --noEmit) hoàn thành với 0 lỗi.




## 2026-08-24 — Add Agent ID to Target Agent Display Name in Frontend Chat Header

### Vấn đề
- Tiêu đề tin nhắn TALK trong giao diện Web UI chưa hiển thị Agent ID của agent nhận khi hiển thị định dạng gửi/nhận.

### Nguyên nhân
- Logic khởi tạo `displayTo` trong `web/src/components/ChatPanel.tsx` khi tìm thấy `targetAgent` trong mảng `agents` chỉ trả về `${targetAgent.name} (${targetAgent.role})` mà thiếu `[${targetAgent.id}]`.

### Giải pháp sửa đổi
- Sửa đổi `web/src/components/ChatPanel.tsx`:
  + Cập nhật logic phân giải `displayTo`: khi tìm thấy `targetAgent`, định dạng thành `${targetAgent.name} (${targetAgent.role}) [${targetAgent.id}]` (hoặc `${targetAgent.name} [${targetAgent.id}]` nếu không có role).
  + Cập nhật logic phân giải `sender` khi thiếu `msg.agentName` để tra cứu mảng `agents` và hiển thị đầy đủ tên, vai trò và Agent ID.

## 2026-08-24 — Add Click-to-Run Script (start.bat) for AgentForge

### Vấn đề
- Thiếu script khởi chạy nhanh ứng dụng (click-to-run .bat/.cmd) trực tiếp trên Windows explorer.

### Nguyên nhân
- Người dùng cần phải mở terminal thủ công và gõ cd kèm lệnh npm start mỗi khi khởi động ứng dụng.

### Giải pháp sửa đổi
- Tạo file start.bat tại `C:\Users\Hai Dang\agentforge\start.bat`.
- Thêm các câu lệnh chuyển thư mục làm việc và chạy npm start, kèm theo pause để giữ cửa sổ terminal mở sau khi thực thi.

## 2026-08-24 — Fix ACP Session Deletion and Prompt Reinjection on Session Reset

### Vấn đề
- Khi deleteSession() thực thi nhưng session không tồn tại trên OpenCode CLI (CLI trả về lỗi), session ID cũ và ánh xạ session chưa được giải phóng triệt để.
- Khi session bị reset do không tồn tại/not found hoặc bị xóa, các lượt chat tiếp theo có thể thiếu ngữ cảnh hệ thống, vai trò và nhiệm vụ ban đầu nếu chỉ gửi partial/update prompt.

### Nguyên nhân
- Trong src/agents/acp-client.ts, nhánh catch của deleteSession() trước đây chỉ log lỗi và trả về false mà không reset this.sessionId = null và không gọi ACPClient.unregisterSession().
- Cờ needPromptReinject chưa được kích hoạt nhất quán khi phát hiện session không hợp lệ trong chatWithRetry() hoặc khi xóa session, đồng thời một số luồng gọi trong src/server.ts chưa kiểm tra cờ này để chèn lại toàn bộ worker prompt và task context.

### Giải pháp sửa đổi
- Sửa src/agents/acp-client.ts:
  + Cập nhật deleteSession(): luôn unregister session khỏi ACPClient.unregisterSession() và reset this.sessionId = null (bất kể lệnh CLI thành công hay thất bại), đồng thời bật cờ needPromptReinject = true.
  + Thêm getter/setter alias getNeedFullPrompt(), setNeedFullPrompt(), getNeedReinject(), setNeedReinject() bên cạnh getNeedPromptReinject() và setNeedPromptReinject().
  + Trong chatWithRetry(): khi phát hiện session không tồn tại/not found trên OpenCode hoặc lệnh opencode run trả về session error, tự động unregister session, gán this.sessionId = null và bật cờ needPromptReinject = true trước khi khởi tạo session mới.
- Sửa src/server.ts:
  + Cập nhật các luồng gọi chat (/api/chat, resumeAgentWork, watchdog checks, triggerOrchestrator, TALK handler, spawn reuse handler): kiểm tra cờ needPromptReinject/needReinject để re-inject đầy đủ system prompt, role prompt và task context ban đầu vào session mới.
  + Sau khi re-inject thành công, reset lại cờ về false.

## 2026-08-24 — Filter Internal Talk Messages in Main Chat and Strip [TALK] Tags in UI

### Vấn đề
- Các tin nhắn nội bộ giữa Orchestrator và các worker agent (qua lệnh TALK) xuất hiện trên màn hình chat chính của người dùng, gây rối loạn giao diện hội thoại.
- Thẻ lệnh [TALK ...] vẫn còn hiển thị dạng văn bản thô trong nội dung tin nhắn trên giao diện chat.

### Nguyên nhân
- Bộ lọc filteredMessages trong web/src/App.tsx trước đây chưa loại trừ các tin nhắn nội bộ giữa Orchestrator và worker (như msgType === 'talk' hoặc from === 'orchestrator' và to !== 'user' && to !== 'broadcast').
- Thành phần giao diện web/src/components/ChatPanel.tsx chưa có cơ chế bóc tách và loại bỏ thẻ lệnh [TALK ...] trước khi hiển thị văn bản cho người dùng.

### Giải pháp sửa đổi
- Cập nhật web/src/App.tsx:
  + Bổ sung hàm kiểm tra isInternalMsg để phát hiện tin nhắn có msgType là 'talk', 'internal' hoặc tin nhắn do Orchestrator gửi cho worker (to !== 'user' && to !== 'broadcast').
  + Cập nhật filteredMessages trên màn hình Orchestrator/chính để loại trừ toàn bộ tin nhắn nội bộ, chỉ giữ lại tin nhắn giữa User và Orchestrator, tin nhắn broadcast và lỗi hệ thống.
- Cập nhật web/src/components/ChatPanel.tsx:
  + Thêm hàm stripTalkTags để tự động loại bỏ các thẻ [TALK ...] trong nội dung tin nhắn một cách an toàn và sạch sẽ.
  + Áp dụng stripTalkTags vào phần xử lý nội dung tin nhắn trước khi hiển thị.
- Biên dịch thành công gói web client (vite build).

## 2026-08-24 — Backend Tag Stripping and Message Type Classification for [TALK] Commands

### Vấn đề
- Khi Orchestrator sinh phản hồi chứa lệnh [TALK ...], nội dung thô bao gồm cả các thẻ lệnh nội bộ bị phát tán trực tiếp tới người dùng.
- Các tin nhắn trao đổi nội bộ bằng TALK giữa Orchestrator và Worker chưa được gắn cờ phân loại msgType đồng bộ, gây khó khăn cho việc lọc hiển thị ở giao diện người dùng.

### Nguyên nhân
- Luồng triggerOrchestrator và endpoint /api/chat chưa làm sạch thẻ lệnh bằng stripCommandTags trước khi tạo tin nhắn to: 'user'.
- Các đối tượng ChatMsg tạo ra trong quá trình điều phối [TALK] và [SPAWN] chưa gán msgType: 'talk' hoặc msgType: 'internal'.

### Giải pháp sửa đổi
- Cập nhật src/server.ts:
  + Trong triggerOrchestrator và /api/chat: tự động gọi stripCommandTags để lọc bỏ toàn bộ các thẻ [TALK ...], [SPAWN ...], [CREATE ROLE ...] trước khi gửi tin nhắn cho người dùng; chỉ phát tin nhắn user nếu nội dung sau khi lọc còn dữ liệu.
  + Trong handleAgentResponse: gán msgType: 'talk' cho các tin nhắn giữa các agent (to !== 'user' && to !== 'broadcast'), gán msgType: 'internal' cho tin nhắn báo lỗi không tìm thấy agent.
  + Trong handleOrchestratorResponse: gán msgType: 'talk' cho talkMsg, reuseTaskMsg, spawnTaskMsg và msgType: 'internal' cho limitErrMsg, notFoundErrMsg.

## 2026-08-24 — Thorough Cleanup on Agent Deletion and UI Sync

### Vấn đề
- Khi xóa agent qua giao diện hoặc API DELETE /api/agents/:id, các dữ liệu lịch sử hội thoại, tin nhắn chưa đọc, retry count, và trạng thái watchdog chưa được giải phóng triệt để khỏi RAM và storage.
- Lệnh xóa chưa có bảo vệ chặn xóa Orchestrator và chưa kiểm tra mã lỗi 404 khi agent không tồn tại.

### Nguyên nhân
- Hàm deleteAgent trong src/server.ts chỉ xóa agent khỏi memory map và storage mà chưa gọi storage.clearAgentConversation, chưa lọc mảng chatHistory và unreadForOrchestrator, chưa xóa agent khỏi agentRetryCount và watchdogState.

### Giải pháp sửa đổi
- Cập nhật src/server.ts:
  + Trong deleteAgent: thêm bảo vệ chặn xóa orchestrator, gọi client.abort() dừng tiến trình con, gọi client.deleteSession() xóa phiên OpenCode CLI, gọi storage.clearAgentConversation(id) dọn dẹp lịch sử, lọc sạch tin nhắn trong chatHistory và unreadForOrchestrator, xóa khóa trong agentRetryCount và watchdogState, sau đó xóa agent khỏi storage và broadcast agent:deleted.
  + Trong route DELETE /api/agents/:id: kiểm tra trả về 400 nếu xóa orchestrator, 404 nếu agent không tồn tại, và bọc try/catch trả về status 200/500 rõ ràng.
- Kiểm tra web/src/App.tsx và web/src/components/Dashboard.tsx: xác nhận cơ chế Optimistic UI update và đồng bộ sự kiện WebSocket agent:deleted hoạt động đồng bộ.
- Biên dịch thành công web/dist/ và dist/.

## 2026-08-25 — Narrow Session Reset Conditions and Preserve Session Lifecycle in ACP Client

### Vấn đề
1. Session của OpenCode CLI bị tự động reset liên tục trong các lượt tương tác thông thường, khiến agent phải tạo lại phiên mới và mất ngữ cảnh hội thoại.
2. Logic kiểm tra lỗi regex quá rộng hoặc bắt lỗi nhầm trên các event error/failed trong stream JSONL làm trigger reset session.
3. Khối catch kiểm tra điều kiện dẫn đến việc vô tình xóa sessionId khi gặp bất kỳ ngoại lệ tạm thời hoặc lỗi tool thông thường.
4. Lệnh fetchSessions(), getSessionTitle(), deleteSession() không truyền cwd: projectDir dẫn đến danh sách session bị rỗng hoặc kiểm tra sai thư mục làm xóa nhầm session.

### Nguyên nhân
1. acp-client.ts tự động kiểm tra sự tồn tại của session trước khi chạy thông qua danh sách session trả về từ CLI (trước lượt chạy), nếu session cũ không xuất hiện trong danh sách đầu (hoặc danh sách trả về không đủ) thì bị đánh giá là hết hạn và xóa oan.
2. Khối catch kiểm tra điều kiện session reset không chặt chẽ, coi mọi ngoại lệ hoặc kết quả có chuỗi error/failed là hỏng session.
3. Các hàm gọi CLI session không chỉ định thư mục làm việc cwd tương ứng với projectDir của agent.

### Giải pháp sửa đổi

File: src/agents/acp-client.ts
- Loại bỏ hoàn toàn việc chủ động reset session trước lượt chạy nếu sessionId có định dạng hợp lệ (ses_...).
- Thu hẹp triệt để điều kiện reset session: chỉ reset session và unregister khi OpenCode CLI báo lỗi fatal thực sự như HTTP 404, Session not found, Session expired hoặc Session does not exist.
- Giữ nguyên và tái sử dụng liên tục sessionId khi gặp lỗi tool thông thường hoặc các lỗi mạng/timeout tạm thời có thể retry.
- Bổ sung tham số cwd: projectDir vào toàn bộ các lệnh execAsync liên quan đến opencode session list và opencode session delete trong fetchSessions, getSessionTitle, deleteSession.
- Biên dịch kiểm tra TypeScript (tsc) và build hoàn tất không có lỗi.

### Chỉnh sửa bổ sung (2026-08-25) — Thu hẹp tiếp regex reset session
- Phát hiện: regex `isSessionNotFoundOrExpired` vẫn còn chứa `invalid_request_error|tool_use_id|call_id`, khiến các lỗi provider/tool thông thường (không liên quan vòng đời session) bị hiểu nhầm là session hết hạn → reset oan, mất context.
- Sửa: thu gọn regex chỉ còn `/\b404\b|invalid session|session (invalid|not found|does not exist|not exist|expired)/i`. Đã chạy kiểm thử 12 ca (6 ca nên reset / 6 ca nên giữ) đều PASS: KHÔNG reset với `invalid_request_error`, `tool_use_id`, `call_id`, `Detected unavailable tool, failed query, or error event in output`, `Error: rate limit`, `query failed`, `error event in output`; CHỈ reset với `404`, `Session not found`, `session does not exist`, `session expired`, `invalid session`.
- Kết quả: session được giữ nguyên và tái sử dụng liên tục cho agent ngay cả khi có tool error/output chứa chữ "error"/"failed". Typecheck `tsc --noEmit -p tsconfig.json` pass.

## 2026-08-25 (bổ sung) — Fix Tắt Watchdog Trên UI Nhưng Vẫn Bắn Report Về Orchestrator

### Vấn đề
- Người dùng tắt Watchdog qua toggle trên Web UI (App.tsx → POST /api/settings/watchdog, enableWatchdog=false), nhưng hệ thống vẫn tiếp tục gửi các thông báo hệ thống `[WATCHDOG REPORT] ... Agent stopped` và `[WATCHDOG FORCE-STOP] ... exceeded max recovery attempts` về Orchestrator.

### Nguyên nhân
- Hàm `isWatchdogEnabled()` chỉ được kiểm tra ở ĐẦU mỗi tick của `startWorkerWatchdog` (mỗi 180s). Tuy nhiên, một khi tick đã bắt đầu và đang thực thi `await client.chat(prompt)` / `await client.enqueue(retryPrompt)` (OpenCode CLI chạy hàng chục giây đến vài phút), việc người dùng tắt Watchdog ở giữa không thể dừng được đoạn code nằm SAU lệnh await — nó vẫn tiếp tục `broadcast('chat:message')` và vẫn gọi `handleStuckAgent` / `forceStopAndReport`, dẫn đến vẫn bắn report.
- Hai hàm `handleStuckAgent` và `forceStopAndReport` bản thân không tự kiểm tra `isWatchdogEnabled()` ở đầu, nên một đợt escalation (leo thang xử lý agent kẹt) đang dở vẫn hoàn tất và gửi thông báo bất chấp đã tắt.

### Giải pháp sửa đổi
- File: `src/server.ts`
  + Thêm re-check `if (!isWatchdogEnabled()) { cleanup state; return; }` ngay SAU mỗi lệnh `await client.chat` (nhánh status check) và `await client.enqueue` (nhánh recovery) bên trong vòng lặp quét của Watchdog, để dừng ngay lập tức mọi thao tác bắn report nếu đã bị tắt.
  + Thêm guard `if (!isWatchdogEnabled()) { cleanup; return; }` tại đầu `handleStuckAgent` và `forceStopAndReport`, chặn hoàn toàn việc gửi WATCHDOG REPORT / FORCE-STOP khi Watchdog đã tắt.
  + Khi POST /api/settings/watchdog nhận `enableWatchdog=false`, chủ động `watchdogState.checkCount.clear()`, `awaitingTalkResponse.clear()`, `lastTalkTime.clear()` để xoá sạch trạng thái escalation đang dở, đảm bảo không còn tiến trình nào cố gửi report về sau.
- Kết quả: Tắt Watchdog trên UI sẽ ngay lập tức (và cả với các tác vụ đang chạy dở) ngừng 100% mọi thông báo hệ thống về Orchestrator; bật lại hoạt động bình thường.
- Kiểm tra: `npm run build` (tsc + vite + tsc electron) hoàn tất 100% không lỗi.

## 2026-08-25 (bổ sung) — Fix Lỗi "Connection error: Failed to fetch" Trên Web UI Khi Agent Chạy Lâu

### Vấn đề
- Gửi tin nhắn trên Web UI (port 5173 dev) đôi khi báo `❌ Connection error: Failed to fetch` dù server backend (port 3001) vẫn sống (kiểm tra `/api/agents` trả 200).

### Nguyên nhân
- File: `web/src/App.tsx` (dòng ~321) bắt lỗi của `fetch('/api/chat')`; lỗi mạng cấp thấp (không phải HTTP error) sinh ra thông báo trên.
- `web/src/App.tsx` dòng 295: `fetch(${API}/api/chat)` KHÔNG có `AbortController`/timeout ở phía JS → không phải do timeout JS.
- `src/server.ts` dòng 2693: handler `/api/chat` làm `await client.enqueue(finalPrompt)` — chặn response HTTP cho tới khi agent chạy xong (opencode có thể mất vài phút).
- `web/vite.config.ts`: proxy `/api` (5173 → 3001) không đặt `timeout`/`proxyTimeout`, nên dùng mặc định http-proxy **120s**. Khi agent chạy > ~2 phút, proxy cắt socket → browser báo "Failed to fetch". Đây là nguyên nhân "timeout quá chặt" người dùng nghi ngờ.
- (Trong Electron/production, UI gọi thẳng 3001 không qua proxy nên không bị chuyện này; nếu vẫn lỗi ở mode đó thì do server đang restart tạm thời.)

### Giải pháp sửa đổi
- File: `web/vite.config.ts`
  + Thêm `timeout: 600000` và `proxyTimeout: 600000` (10 phút) cho proxy `/api`.
  + Thêm `timeout: 600000` cho proxy `/ws` (websocket tunnel) để đồng bộ.
- Kết quả: agent chạy dài (tới 10 phút) không bị proxy ngắt → không còn "Failed to fetch" ở dev mode.
- Ghi chú kiến trúc (chưa sửa): `/api/chat` vẫn block tới khi agent xong; responses đã được broadcast qua WebSocket (`broadcast('chat:message')`) nên về sau có thể đổi `/api/chat` trả ngay 202 và để WS gánh việc stream — sẽ triệt tiêu hẳn phụ thuộc vào寿命 của HTTP connection.
- Kiểm tra: `npm run build` (vite) hoàn tất không lỗi.

## 2026-08-25 (bổ sung) — Sửa start.bat Bị Loop / Kill Nhầm & Tạo stop.bat

### Vấn đề
- `start.bat` cũ không thể khởi động: cứ in "Phat hien PID ... dang chiem port 3001" hàng chục dòng rồi dừng với cảnh báo "port 3001 van bi chiem".
- Trong đó có PID 4 (System) bị cố `taskkill` → không bao giờ giải phóng được port.

### Nguyên nhân
1. `findstr /R ":3001[ ]"`: regex findstr với lớp `[ ]` bị lỗi, **khớp TẤT CẢ các dòng netstat** (kể cả port 135/445/515/5985...). Nên script `taskkill` nhầm cả RPC (1556), SMB (4), WinRM (4)... và đặc biệt là PID 4 (System) không kill được → loop/dừng.
2. Ngoài ra, các dòng `echo ... PID 4 (System) ...` chứa ngoặc `(System)` nằm trong khối `if (...) (...)` → cmd hiểu nhầm `)` đóng khối → lỗi parse `dang was unexpected at this time.`
3. Dự án chỉ có `start.bat`, không có `stop.bat` để dừng server.

### Giải pháp sửa đổi
- File: `start.bat` (backup tại `%TEMP%\opencode\start.bat.bak`)
  + Đổi filter sang literal `findstr ":3001" | findstr "LISTENING"` → chỉ target tiến trình thực sự đang LISTEN trên port 3001 (loại kết nối đi ra + false-positive). Đã test: trả rỗng khi port trống, không khớp nhầm process hệ thống.
  + Bỏ qua PID 0 và 4 (System) — không cố kill System; nếu gặp PID 4 in hướng dẫn `netsh http show urlacl` thay vì loop.
  + Gỡ bỏ mọi dấu ngoặc `(...)` trong echo/REM để tránh lỗi parse.
- File: `stop.bat` (mới)
  + Dùng cùng logic đã sửa: chỉ target LISTEN trên 3001, bỏ qua PID 0/4, báo cáo rõ khi không có listener nào.
- Kiểm tra thực tế:
  + `start.bat` chạy qua [1/3]→[2/3]→[3/3], server khởi động thành công (`🚀 AgentForge v7: http://localhost:3001`).
  + `stop.bat` phát hiện đúng listener (PID 332) và dừng; port 3001 xác nhận sạch qua `Get-NetTCPConnection`.


## 2026-08-25 — Chat User Ben Vung: Luu Disk va Tu Gui Lai Khi Backend (LLM) Sap

### Van de
- Khi backend LLM (vi du OpenAI-compatible tren port 8082) dang tat/mang loi, user gui tin nhan -> agent bao "Cannot connect to API ... Retrying ... (Attempt 1/3)" roi fail. Tin nhan bi mat hoan toan, user phai gui lai thu cong sau khi backend song.
- Co che persist tren disk truoc do (outbox) CHI ap dung cho bao cao inter-agent (worker->Orchestrator), khong cover loi chat user->LLM.

### Nguyen nhan
- src/server.ts handler /api/chat (catch o dong ~2828 cu) bat loi roi chi tra error cho user, khong luu lai de retry.
- chatWithRetry (acp-client.ts) chi retry noi bo 3 lan (~4.5s) roi nem loi; khong co hang doi cho backend phuc hoi.

### Giai phap sua doi
- File src/storage.ts: them interface ChatQueueItem va truong chatQueue trong state (luu chung data/agentforge-state.json -> song sot qua restart/mat dien). Them cac method: enqueueChatRetry, getPendingChatQueue, updateChatQueueItem, removeChatQueueItem, pruneChatQueue.
- File src/server.ts:
  + Tach ham dispatchUserChat(params) chua TOAN BO logic xu ly chat (build prompt -> enqueue -> xu ly ket qua/broadcast). HTTP handler va retry processor cung goi no -> khong duplicate code.
  + Them isRetriableError(err): nhan dien loi backend/mang (connection/fetch/timeout/5xx/Cannot connect to API/Failed to fetch...), loai tru user-abort.
  + Trong catch cua /api/chat: neu loi retriable -> enqueueChatRetry + broadcast thong bao "da luu, se gui lai khi backend san sang" + res.json({ok:true, queued:true}) (KHONG bao do). Nguoc lai giu nguyen behavior bao loi.
  + Them processChatRetryQueue() + scheduleChatRetry() (interval 30s, kem replay luc khoi dong sau 3s). Voi moi item: goi dispatchUserChat(isRetry:true); thanh cong -> ban ket qua cho user + removeChatQueueItem; loi retriable -> backoff (5s->toi da 10p); loi vinh vien hoac agent dich da bi xoa -> broadcast loi user + remove.
  + isRetry:true de khong re-consume unread va khong in thong bao busy khi retry.
- Backup: server.ts.bak_chatqueue, storage.ts.bak_chatqueue.
- Kiem tra: npx tsc --noEmit va npm run build deu xanh; code moi co mat trong dist/server.js.

## 2026-08-25 — Hien Thi Moi Phan Hoi Terminal OpenCode Len App Forge (in + out)

### Van de
- Truoc day opencode duoc goi qua opencode run --auto --format json, toan bo stdout bi buffer va chi boc ra 1 ket qua cuoi + 1 transcript. Nguoi dung KHONG thay duoc opencode dang lam gi o terminal (input prompt gui di, cac tool call, text, error phat ra tung buoc).
- Transcrip co sinh ra nhung bi an o man hinh chinh (isSystemMsg loc bo === TURN TRANSCRIPT).

### Nguyen nhan
- acp-client.ts chi luu stdout vao chuoi roi parse sau khi process ket thuc (proc.stdout.on('data') chi stdoutStr += ...).
- Khong co co che stream su kien len UI trong luc agent dang chay.

### Giai phap sua doi
- File src/agents/acp-client.ts:
  + Them field onEvent, ventSeq, ventBuf, ventTimer, lineBuf va cac method setOnEvent, pushOACEvent (batch mo 250ms qua setInterval + unref), lushOACEvents, stopOACEvents.
  + Trong chatWithRetry: phat su kien kind:'in' chua prompt gui opencode (cat ngan 4000 ky tu) TRUOC khi spawn; trong handler stdout.on('data') parse tung dong JSONL ({...}) phat kind:'out' ngay khi co; trong proc.on('close') flush phan con lai + stopOACEvents().
- File src/server.ts:
  + Them roadcastOACEvent(agentId, ev): dinh dang tung event (text / tool_use / tool_result / error / assistant / user / fallback JSON) thanh text doc duoc, dong goi thanh 1 message msgType:'opencode' voi rom=to=agentId, roi roadcast('chat:message',{msg}). KHONG luu DB (chi live, tranh phinh history).
  + Gan c.setOnEvent(ev => broadcastOACEvent(agent.id, ev)) tai getClient (worker) va getOrchClient (orchestrator).
- File web/src/components/ChatPanel.tsx: them style rieng cho msgType:'opencode' (sender "⚡ OpenCode", bubble nen toi #0b1220, vien cyan, font monospace, maxWidth 95%) -> hien thi nhu mot terminal log.
- Hien thi: chi xuat hien o khung chat cua agent tuong ung (vi rom===selectedAgentId); o man hinh Orchestrator chinh bi loc ra (from/to khong phai orchestrator) nen khong lam ray.
- Backup: acp-client.ts.bak, server.ts.bak, App.tsx.bak, ChatPanel.tsx.bak.
- Kiem tra: 
pm run build xanh (tsc + vite + electron tsc).

## 2026-08-25 — UI Than Thien Dien Thoai (Responsive) + Tat DevTools Tu Dong

### Van de
- Giao dien web 3001 chi danh cho desktop: sidebar co dinh 310px chiem gan het man hinh dien thoai (~390px), khong con cho cho khung chat; khong cach mo/dong danh sach agent.
- Electron dev tu dong mo DevTools (detach) gay nhieu log loi vo hai (Autofill.enable failed).

### Nguyen nhan
- App.tsx render sidebar nhu flex-child co dinh (width state 310px, resizer keo ngang) khong co breakpoint nao cho man hinh nho.
- main.ts goi webContents.openDevTools() truc tiep trong nhanh isDev().

### Giai phap sua doi
- File web/src/App.tsx:
  + Them state isMobile (window.innerWidth < 768, lang nghe resize) va sidebarOpen.
  + Sidebar tren mobile chuyen thanh drawer overlay: position fixed, width min(82vw,320px), translateX(-100%/0) co transition, boxShadow khi mo.
  + Them backdrop (zIndex 40, click de dong) va nut hamburger floating 44x44 (zIndex 45) khi drawer dong.
  + Resizer chi render tren desktop (!isMobile).
  + selectAgent tu dong dong drawer tren mobile.
- File web/src/components/ChatPanel.tsx:
  + Nhan prop isMobile, truyen vao MessageItem: bubble maxWidth 94% (mobile) / 85% (desktop), opencode log 96%/95%.
  + Header them flexWrap + gap, giam padding tren mobile; input area padding 10px 12px; nut Send/Stop chi con icon tren mobile (van cao 44px touch-friendly).
- Dialogs SpawnDialog/ModelSettingsDialog da san maxWidth 92vw + maxHeight 90vh -> khong can sua.
- File src/electron/main.ts: DevTools chi mo khi env OPEN_DEVTOOLS duoc set (opt-in), da compile lai dist-electron.
- Build exe: 
pm run build:electron thanh cong -> release/AgentForge-Portable.exe (~74MB).
- Kiem tra: 
pm run build xanh (tsc + vite + electron tsc).

### Bo sung (cung ngay) — Sua trang bi tran qua man hinh dien thoai
- Nguyen nhan: root va drawer dung 100vh (trinh duyet mobile co thanh address bar dong lam 100vh lon hon vung nhin thay); iOS tu zoom khi focus input co font-size <16px lam trang bi phong to/lech khung.
- Giai phap:
  + index.css: them html, body, #root { height: 100% } + overscroll-behavior: none -> chieu cao xac dinh bang chuoi 100% thay vi 100vh.
  + App.tsx: root div va sidebar drawer doi height: '100vh' -> '100%' (phan tu fixed tinh % theo viewport, tu theo doi address bar).
  + web/index.html: viewport meta them maximum-scale=1.0, user-scalable=no, viewport-fit=cover -> chan iOS tu zoom khi focus input, ho tro safe-area tai tho.
  + ChatPanel.tsx: textarea font-size 16px tren mobile (chong zoom iOS keo ca), padding vung tin nhan gom 14px 10px, paddingBottom input them nv(safe-area-inset-bottom) cho man hinh tai tho.
- Kiem tra: 
pm run build xanh.

## 2026-08-25 (bo sung) — Loi Leak Raw OpenCode Events (step_start/step_finish) Vao Chat UI

### Van de
- Khung chat cua tung agent tren Web UI hien cac dong rac nhu: ◆ step_start: {json...} va ◆ step_finish: {json...} (JSON thoi cua opencode) xen giup noi dung hoi thoai that.

### Nguyen nhan
- parseJsonlEvents (acp-client.ts) KHONG phai cho leak: no chi nhat text/tool_use/error vao ket qua cuoi.
- Cho leak thuc su la luong stream truc tiep: acp-client.ts (2 cho pushOACEvent kind:'out') day MOI JSONL event tho qua callback setOnEvent; ben server.ts ham broadcastOACEvent khong nhan dien step_* nen chung roi vao nhanh fallback (◆ type: json) va duoc broadcast('chat:message') len UI.

### Giai phap sua doi
- File src/agents/acp-client.ts:
  + Them helper isInternalStepEvent(ev): nhan dien ev.type = step_start / step_finish (case-insensitive, chap nhan ca dang step-start).
  + Loc tai NGUON stream: ca 2 cho pushOACEvent({kind:'out'}) deu bo qua step events -> chung khong bao gio toi server/UI.
  + Token counting KHONG anh huong: parseJsonlEvents van doc toan bo stdout (gom step_finish mang tokens/cost) de tinh tokenUsage/contextLength doc lap voi stream UI.
- File src/server.ts (broadcastOACEvent):
  + Them guard phong thu: skip t === step_start/step_finish ngay dau vong loop, tranh render neu co duong push khac trong tuong lai.
- Backup: acp-client.ts.bak_stepfilter, server.ts.bak_stepfilter.
- Kiem tra: npm run build xanh; dist/agents/acp-client.js co isInternalStepEvent tai ca 2 cho push; dist/server.js co guard; khoi lenh tokenSrc (dem token) nguyen ven.

## 2026-08-25 (bo sung) — Chặn Empty Response Trigger Loop (turn thừa lặp vô hạn)

### Van de
- Agent tra ve output rong hoac dung chuoi "(No response)" (sentinel tu acp-client khi model khong sinh text event) nhung he thong van goi triggerOrchestrator() -> sinh turn Orchestrator moi -> agent lai tra ve rong -> lap vo han, dot tokens.

### Nguyen nhan
- handleAgentResponse (server.ts): khoi fallback cua parseAgentOutput bien "(No response)" thanh message [to: orchestrator]; khoi auto-report cuoi ham chi kiem tra rawReport truthy — "(No response)".trim() la truthy nen di qua.
- processOrchestratorTriggerQueue khong loc item rong trong batch -> van spawn turn.

### Giai phap sua doi
- Them helper isEmptyAgentOutput(text) (server.ts ~1794): true neu trim rong hoac === "(No response)".
- Guard tai 3 diem:
  + handleAgentResponse loop (sau khi da luu history + broadcast UI de minh bach): bo qua routing (khong triggerOrchestrator, khong deliverTalk).
  + handleAgentResponse auto-report cuoi ham: chi forward noi dung thuc su co ky tu.
  + processOrchestratorTriggerQueue: loa item rong khoi batch TRUOC khi dung prompt, dong thoi markOutboxDelivered de outbox khong replay vo han khi restart; batch rong sau loc -> return som, khong spawn turn.
- Luu y: day KHONG phai dedup filter — moi noi dung co ky du deu forward 100% nhu cu.
- Backup: server.ts.bak_emptyloop.
- Kiem tra: npm run build xanh; dist/server.js chua helper tai 1730 va ca 3 guard tai 1753/1867/1919.

## 2026-08-25 — Agent Tra Loi Khong Wake/ Khong Den Duoc Main (Orchestrator)

### Van de
- Worker (vi du ui_coder) lam viec turn dai roi tra loi [TO: orchestrator] nhung main khong nhan duoc bao cao, khong duoc wake -> orchestrator ping lap lai.

### Nguyen nhan
1. RUN_TIMEOUT_MS=300000 la wall-clock TONG cho ca luot opencode run. Turn dai (nhieu tool call + npm build ~4 phut) vuot 5 phut -> server taskkill opencode giua chung, report that mat.
2. catch trong chatWithRetry retry MOI loi ke ca timeout toi 3 lan (acp-client.ts:548-559 cu): chay lai toan bo prompt cung session -> im lang them ~10 phut + side effects bi nhan ban.
3. Sau retries neu content rong/"(No response)" -> handleAgentResponse skip de chong loop -> KHONG goi triggerOrchestrator -> main khong bao gio thuc.
4. Catch cua flow TALK (server.ts ~2379) nuot error: chi set status error + broadcast agent:updated, khong bao gi cho orchestrator.

### Giai phap sua doi
- src/agents/acp-client.ts:
  + Doi timeout cung thanh IDLE-TIMEOUT: timer reset moi khi stdout/stderr con xuat du lieu (armTimer). Turn dai van song miễn la dang lam viec; chi kill khi im lang lien tuc RUN_TIMEOUT_MS (env AGENTFORGE_RUN_TIMEOUT van dung).
  + Them co e.isIdleTimeout; trong catch: neu idle-timeout thi KHONG retry — parse ngay JSONL mot phan tu err.stdout, tra ve content kem chuoi canh bao "[Turn bi cat...]" -> orchestrator van nhan duoc bao cao va duoc wake.
- src/server.ts (flow TALK catch): them errMsg (chatHistory + saveMessage + addUnreadForOrchestrator + broadcast) va await triggerOrchestrator(ta, errMsg.content) thay vi nuot loi.
- Backup: acp-client.ts.bak_wakefix, server.ts.bak_wakefix.
- Kiem tra: npm run build xanh.

## 2026-08-25 (bo sung) — Sua Build Fail ChatPanel (2 button long nhau) + Them FindAvailablePort

### Van de
1. web/src/components/ChatPanel.tsx (L655-689 cu): 2 the <button long nhau, button thu nhat mo onClick roi bo lung (thieu dong }}) → esbuild FAIL "Unexpected )" tai dong 689.
2. Orchestrator yeu cau bo sung pre-probe port trong truoc khi bind (findAvailablePort) cho server.

### Nguyen nhan
1. ui_coder sua dở de lai JSX vo; thẻ thứ hai (co style day du) long ben trong the chua dong.
2. Co che cu chi fallback phan ung qua EADDRINUSE handler (startServerWithPortFallback) — van an toan nhung thieu buoc do chu dong nhu yeu cau.

### Giai phap sua doi
- web/src/components/ChatPanel.tsx: thay toan khoi bang MOT button sach duy nhat - onClick boc window.confirm('Ban co chac muon xoa toan bo cuoc tro chuyen?') roi moi goi onClear(); giu nguyen style cu (nen do nhạt rgba(239,68,68,0.1), icon 🗑️, chu Clear Chat, hover handlers). Backup: ChatPanel.tsx.bak_clearfix + %TEMP%/opencode/ChatPanel.tsx.bak_fixbtn.
- src/server.ts: them import net (L4); helper findAvailablePort(startPort, maxTries=20) dung net.createServer probe (L3564); log [Server] Server listening on port X (L3615); launch call doi thanh findAvailablePort(PORT).then(freePort => startServerWithPortFallback(freePort)) (L3630) — giu nguyen EADDRINUSE handler lam lop phong thu thu 2 chong race TOCTOU. WebSocketServer gan cung instance HTTP server nen tu theo port moi. Backup: server.ts.bak_findport.
- Kiem tra: npx tsc --noEmit PASS 0 error; npm run build PASS (tsc + vite 37 modules + electron tsc) — khong con loi esbuild "Unexpected )".

## 2026-08-25 (bo sung) — Sua loi build Clear Chat button (2 the button long nhau) + findAvailablePort

### 1. ChatPanel.tsx - Clear Chat button
Van de: ui_coder de lai 2 the button long nhau tai vung L655-689, onClick thu nhat mo roi bo lung (thieu dong }}) -> esbuild FAIL Unexpected ) dong 689.
Nguyen nhan: sua dut lag giua 2 phien khi chen window.confirm vao button.
Giai phap: thay toan bo khoi bang MOT button sach duy nhat: onClick bao window.confirm('Ban co chac muon xoa toan bo cuoc tro chuyen?') roi moi goi onClear(); giu nguyen style cu (nen do nhat rgba(239,68,68,0.1), icon trash, chu Clear Chat, hover handlers). Backup: web/src/components/ChatPanel.tsx.bak_clearfix. Vi tri sau sua: button tai L656, confirm tai L658.

### 2. server.ts - findAvailablePort (port fallback chu dong)
Van de: Verifier yeu cau them co che do port trong truoc khi bind de tranh crash khi port 3001 bi chiem (thong tin ban dau noi server.listen tran khong co error handler - thuc te startServerWithPortFallback voi EADDRINUSE handler da ton tai tu truoc).
Giai phap (additive, khong pha flow):
+ Them helper findAvailablePort(startPort, maxTries=20) dung net.createServer() probe port trong bat dau tu PORT (mac dinh 3001), fallback port ke tiep (server.ts L3564). Tham khao isPortAvailable trong electron/main.ts theo de bai.
+ Launch moi: findAvailablePort(PORT).then(...) -> startServerWithPortFallback(freePort) (L3630); EADDRINUSE handler van giu nguyen lam lop phong thu thu 2 chong race TOCTOU.
+ Them log ro [Server] Server listening on port <X> trong callback listen (L3615) ben canh banner 🚀 AgentForge v7.
+ WebSocket da gan cung instance HTTP (new WebSocketServer({ server }) L18) nen tu dong listen cung port moi - khong can sua.
Kiem tra: npx tsc --noEmit PASS 0 error; npm run build PASS ca 3 stage (tsc + vite 37 modules + electron tsc), dist/server.js va dist/assets chua code moi.
Backup: server.ts.bak_findport.

## 2026-08-25 (bo sung) — Hien thi bao cao worker→orchestrator tren Main View + Auto-wakeup worker im lang

### Van de
1. Main view (khong chon agent) khong hien thi tin worker/agent gui VE orchestrator — nguoc voi yeu cau comment isInternalMsg (App.tsx L362-363: tin agent bao ve orchestrator PHAI duoc hien thi de nguoi dung thay phan hoi).
2. Worker thuc thi tool nhung khong sinh van ban tra loi (content rong/(No response)) -> handleAgentResponse bo qua routing -> orchestrator khong duoc danh thuc, nhiem vu im lang tuyet doi.

### Nguyen nhan
1. Filter main view (App.tsx L379-387 cu) chi co nhanh user→orchestrator, orchestrator→user/broadcast, error; thieu nhanh to==='orchestrator'.
2. deliverTalk goi handleAgentResponse(tr.content); voi content rong, guard isEmptyAgentOutput chan routing dung y (chong loop turn rong) nhung cung lam mat duong danh thuc orchestrator cho truong hop worker da lam viec that.

### Giai phap sua doi
- web/src/App.tsx L386: them nhanh (m.to === 'orchestrator') vao filter main view — tin tu agent ve main luon hien thi; giu nguyen cac nhanh khac va isInternalMsg (van an chi thi noi bo orch→agent).
- src/server.ts:
  + Them TOOL_WAKEUP_THROTTLE_MS = 30000 + lastToolWakeupAt Map (L1751-1752).
  + deliverTalk (L2055-2068): sau handleAgentResponse/saveTranscript, neu isEmptyAgentOutput(tr.content) VA transcript co dau hieu tool_use that (/\\[TOOL\\s/i) → sinh thong bao [Worker <ten> completed tool execution] gui triggerOrchestrator (kem ghi chu huong dan orch xu ly). Throttle 30s/agent de khong tao loop re-dispatch.
- Kiem tra: npx tsc --noEmit PASS 0 error; npm run build PASS (tsc + vite 37 modules + electron tsc). Buoc 0 (ChatPanel Clear button) xac nhan trang thai tot: 1 button duy nhat L656, confirm L658.
- Backup: App.tsx.bak_orchfilter, server.ts.bak_wakeup (trong %TEMP%/opencode).

## 2026-08-25 (bo sung) — Nang cap luu tru 15.000 tin nhan + Port fallback vo han

### Van de
1. Server chi luu ~1.000 tin nhan (in-memory va persist deu cat tai 1000) trong khi yeu cau user la luu ben vung toi thieu 15.000 tin.
2. startServerWithPortFallback gioi han remaining=10 lan thu port; yeu cau moi: thu tang vo han chi dung o bien hop ly 65535, log ro moi lan bi chiem.

### Nguyen nhan
1. Ba diem chan doc lap: saveMessage shift() khi >1000, persist slice(-1000) khi ghi data/agentforge-state.json, va MAX_HISTORY=1000 cua chatHistory trong server.
2. Logic cu dat cap so lan thu de tranh loop — nhung bien port hop le chi den 65535 nen bien do port moi la dieu kien dung dung nghia.

### Giai phap sua doi
- src/storage.ts: them export const MAX_PERSISTED_MESSAGES = 15000 (L24); doi ca 2 diem chan sang dung hang nay: persist history slice(-MAX_PERSISTED_MESSAGES) (L207) va saveMessage shift khi >MAX_PERSISTED_MESSAGES (L323). Ghi dia van qua atomicWriteFile + .bak san co — an toan mat dien/restart.
- src/server.ts: import them MAX_PERSISTED_MESSAGES (L13); MAX_HISTORY = MAX_PERSISTED_MESSAGES (L252) dong bo chatHistory voi cap luu; /api/history van tra theo trang (default 200, max 1000/lan query, ho tro beforeId) va UI fetch cua so 500 tin gan nhat (HISTORY_FETCH_LIMIT) nen DOM khong đơ với 15k tin — phan trang/lazy-load da san sang, khong can sua UI.
- src/server.ts startServerWithPortFallback (L3609): bo tham so remaining=10; neu EADDRINUSE thi tang port vo han (port+1...), log dung chuoi [Server] Port <X> bị chiếm → tu dong thu port <Y> (L3621); chi exit(1) khi port >= 65535 kem thong bao loi ro rang; giu nguyen set process.env.PORT khi listen thanh cong. findAvailablePort pre-probe giu nguyen lam lop dau tien.
- Luu y qua trinh sua: cac edit bi ngat giua chung gay trung lap khai bao hang va comment khoi launch — da ra soat toan bo dau hieu trung bang grep va goi sach truoc khi build.
- Kiem tra: npx tsc --noEmit PASS 0 error; npm run build PASS ca 3 stage; dist/storage.js chua hang 15000, dist/server.js chua bien 65535 va log format moi.
- Backup: %TEMP%/opencode/storage.ts.bak_15k, server.ts.bak_infport.


## 2026-08-25 (bo sung) — Toolcall co cau truc tu event goc opencode (khong qua text transcript)

### Van de
- Du lieu toolcall cho UI dang lay tu chuoi text noi chung ([TOOL ten] ...) trong transcript — mat cau truc input/output, kho render dung va de loi khi parse.

### Nguyen nhan
- parseJsonlEvents (acp-client.ts) chi gom event tool_use thanh toolLines (chuoi) de do vao transcript; khong ton tai duong truyen du lieu co cau truc nao tu event goc den UI.

### Giai phap sua doi
- src/agents/types.ts: them interface ToolCallInfo {tool, input?, output?}; AgentMessage co them truong toolCalls?: ToolCallInfo[].
- src/agents/acp-client.ts: parseJsonlEvents thu them mang toolCalls truc tiep tu event tool_use goc (push {tool, input, output}); tra ve toolCalls trong ket qua; gan vao ca 3 duong return cua chatWithRetry (thanh cong, idle-timeout partial, error-final) voi dieu kien length>0. Transcript cu giu nguyen de tuong thích nhung KHONG con la nguon cho UI toolcall.
- src/server.ts:
  + ChatMsg them truong toolCalls?.
  + handleAgentResponse them tham so thu 4 toolCalls? va gan vao moi reply ChatMsg tao trong loop (luu history + broadcast WS deu mang theo).
  + 6 diem goi cap nhat truyen tr.toolCalls / result.toolCalls: resume-path L804, deliverTalk L2054, reuse-spawn L2160, spawn na L2280, spawn ta L2386, dispatchUserChat agent branch L2821.
  + dispatchUserChat: 3 reply truc tiep (slash reply L2798-khu vuc, plain reply L2822-khu vuc, orchestrator aMsg) cung gan result.toolCalls.
- Web UI typing: web/src/App.tsx va web/src/components/ChatPanel.tsx them truong toolCalls? vao interface ChatMsg de ui_coder doc message.toolCalls khong loi TS (chua render - ui_coder se lam).
- Khong dong chien replay/outbox: outbox van luu message text; deliverTalk replay chay lai enqueue binh thuong.
- Su co trong qua trinh: acp-client.ts bi ghi đe boi noi dung rac tu mot lenh bi ngat (mat parseJsonlEvents) — da phat hien qua grep nghiem thu, khoi phuc tu backup %TEMP%/opencode/acp-client.ts.bak_toolcalls roi ap dung lai edits day du.
- Kiem tra: npx tsc --noEmit PASS 0 error; npm run build PASS; dist/server.js co 12 refs toolCalls, dist/agents/acp-client.js co 8 refs.
- Backup: %TEMP%/opencode/{types,acp-client,server,App}.ts.bak_toolcalls.

## 2026-08-25 (bo sung) — Sua badge Token = 0 (mat tokenUsage/contextLength trong ket qua turn) + reset status working sau restart

### Van de
- Badge token tren UI luon = 0; data/agentforge-state.json xac chung moi token_usage deu null (5/5 agent).
- Sau restart, agent con kẹt status='working' treo vang mai vi process cu da chet ma khong ai reset.

### Nguyen nhan
1. chatWithRetry (acp-client.ts) nhan du tokenUsage/contextLength tu parseJsonlEvents nhung object return danh ro 2 truong nay — server khong bao gio nhan du usage.
2. processOrchestratorTriggerQueue chi update sessionId cho orchAgent; checkAndSynthesize cung khong luu usage sau turn tong hop.
3. loadStateFromDisk nap nguyen trang thai 'working' tu disk ke ca khi da restart.

### Giai phap sua doi
- src/agents/acp-client.ts: 3 duong return chatWithRetry (thanh cong ~L536, idle-timeout partial ~L568, error-final ~L622) bo sung tokenUsage + contextLength.
- src/server.ts:
  + processOrchestratorTriggerQueue (~L1863-1885): sau enqueue, gan result.tokenUsage/contextLength cho orchAgent va dua vao storage.updateAgent('orchestrator', ...) (ca nhanh khong co sid).
  + checkAndSynthesize (~L993-1004): sau enqueue synthesis, gan + persist usage tuong tu.
  + deliverTalk (~L2031-2041) da san co gan token cho worker — chay dung ngay khi muc 1 xong; getSessionStats/opencode session list KHONG duoc dung cho token nhu yeu cau.
- src/storage.ts loadStateFromDisk (~L131-140): khi nap agents tu disk, neu status==='working' thi reset ve 'idle' + clear workingSince (process cu da chet).
- Kiem tra: npx tsc --noEmit PASS 0 error; npm run build PASS; dist chua day du cac thay doi.
- Backup: %TEMP%/opencode/{acp-client,server,storage}.ts.bak_taskd.

## 2026-08-25 (bo sung) — Giu nguyen Object TokenUsage trong deliverTalk cho tung agent

### Van de / Nguyen nhan
- deliverTalk nen TokenUsage object thanh so (totalTokens || ...) lam mat breakdown Input/Output/Cost cho badge tung worker.
### Giai phap
- server.ts L2060-2064: gan truc tiep targetAgent.tokenUsage = tr.tokenUsage (giu object); Dashboard/ChatPanel da ho ca 2 shape. storage.updateAgent + broadcast agent:updated da san co (L2067-2072).
- Kiem tra: tsc --noEmit PASS; npm run build PASS (bundle index-Biox1O--.js 199.43 kB). Backup: %TEMP%/opencode/server.ts.bak_tokagent.

### Bo sung (cung ngay) — ToolCallBlock prop cau truc + Theme sang/toi
- ToolCallBlock: bo detect chuoi trong content (TOOL_CALL_MARKERS/looksLikeToolCall da xoa); doi sang prop co cau truc 	oolCalls?: Array<{tool, input?, output?}> tren ChatMsg (App.tsx) — MessageItem render cac block duoi body text, optional chaining nen khong loi khi backend chua gui du lieu.
- Theme toggle: state theme (localStorage 'af-theme') + data-theme len <html>; nut ☀️/🌙 o sidebar header; CSS light tokens (nen #ffffff/#f8fafc, chu #0f172a, viền rgba(15,23,42,0.08)) override surface qua hook class: af-shell/af-sidebar/af-resizer/af-chatpanel/af-chat-header/af-chat-title/af-chat-scroll/af-chat-input/af-overlay/af-dialog-box/af-dashboard/af-card. Bubble tin nhan giu inline-style (chua token hoa — gioi han da ghi ro).
- Build: tsc --noEmit exit 0; npm run build exit 0 (css 3.68kB, js 199.75kB).

## 2026-08-25 (bo sung) — Tach sach content (loi noi) khoi toolcall trong parseJsonlEvents

### Van de
- Can dam bao content la loi noi thuan cua model, tuyet doi khong lan chuoi [TOOL ...], de UI (ChatPanel.tsx) hien body ngoai va mang toolCalls trong hop rieng biet.

### Nguyen nhan
- Luong chuan da tach (content chi gom event text; tool_use di vao toolCalls/transcript) nhung chua co lop phong thu neu opencode nhung marker [TOOL ...] vao ben trong text part; chua hoap bien the ten event tool-call/tool_call.

### Giai phap sua doi
- src/agents/acp-client.ts parseJsonlEvents:
  + Them bo loc phong thu khi ghep content: loai moi dong khop [TOOL ...] va cac dong con input:/output: thuut dau dong lien sau.
  + Switch chap nhan ca 3 bien the event: tool_use / tool-call / tool_call cung mot nhanh thu thap toolCalls.
  + Cap nhat docblock ghi ro contract: content = loi noi thuan (body UI); toolCalls = cau truc rieng (hop toolcall); transcript chi tuong thích.
- Kiem tra: npx tsc --noEmit PASS 0 error; npm run build PASS; dist/agents/acp-client.js chua bo loc va cac alias (L626/698-737).
- Backup: %TEMP%/opencode/acp-client.ts.bak_toolsep.

### Bo sung (cung ngay) — Connection Status Badge kèm timing + ToolCallBlock mặc định Expand
- App.tsx: them connectionStatus ('connected'|'disconnected') + disconnectedAt; WS onopen/onclose/onerror va SSE onopen/onerror cap nhat trang thai; interval 1s khi offline de tinh nhan "Mất kết nối X trước" (s/phut/gio/ngay).
- ChatPanel.tsx: badge 🟢 Connected / 🔴 Disconnected (X trước) dat trong header chat, truoc nut Clear Chat; offline co hieu ung nhap nhay nhe (.af-conn-badge-off, keyframes af-blink 1.6s).
- ToolCallBlock: doi mac dinh tu Collapse sang EXPAND (useState(true)); van giu text noi chinh ben ngoai hop (body render truoc cac block toolCalls).
- Build: tsc --noEmit exit 0; npm run build exit 0.

## 2026-08-25 (bo sung) — Chuan hoa trich xuat token: chi nhan so chuan tu model API

### Van de
- Badge token phai la so Token Context thuc cua LLM (input+output session), khong phai string.length/byte; neu API tra object {input,output,total} thi chi lay total chuan.

### Nguyen nhan
- Con 4 diem trong server.ts nen TokenUsage object thanh so (mat breakdown); phep trich xuat trong parseJsonlEvents dung chain || de tot co the nhan phai object long (tokenSrc.tokens) gay NaN/garbage; inp/out chua duoc ep kieu so an toan.

### Giai phap sua doi
- src/server.ts: thay 4 cho nen bang gan truc tiep giu nguyen object TokenUsage (L792 resume-path, L2172 reuse-spawn, L2291 spawn na, L2398 spawn ta) — dong nhat voi deliverTalk/dispatchUserChat.
- src/agents/acp-client.ts parseJsonlEvents: them helper toNum chi chap nhan number finite; dung ?? thay || khi lay tung truong; tot CHI lay tu total_tokens/total dang so hop le, neu khong thi inp+out; bo fallback tokenSrc.tokens (nguy co object long). Audit xac nhan khong ton tai .length/byteLength nao duoc dung lam token.
- Hai diem getSessionStats (L589, L1088-1095) da co guard if(stats.tokenUsage) — khong the xa trang gia tri tu turn that; giu nguyen.
- Kiem tra: tsc --noEmit PASS; npm run build PASS. Backup: %TEMP%/opencode/{server,acp-client}.ts.bak_tokfix2.

### Bo sung (cung ngay) — Dong bo timing pill Live WS/Offline (Sidebar + ChatPanel)
- App.tsx: them connectedAt; onopen (WS+SSE) set connectedAt=Date.now() -> uptime reset ve 0 moi lan reconnect thanh cong; interval 1s chon luon (ca online/offline) de cap nhat live.
- Nhan pill Sidebar: "Live WS (Xs)" khi online, "Offline (X truoc)" khi offline + hieu ung af-conn-badge-off; ChatPanel badge dong bo cung logic: "🟢 Live WS (uptime)" / "🔴 Offline (X trước)".
- formatOfflineFor doi ten thanh formatElapsed (dung chung cho offline duration va uptime).
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 201.37 kB).

### Bo sung (cung ngay) — Polling agents 10s + Light theme cho bubble/toolblock
- App.tsx: useEffect setInterval 10s goi /api/agents -> setAgents; token badge & trang thai agent tu lam tuoi dinh ky, khong phu thuoc WS event.
- ChatPanel.tsx: them class af-bubble (+af-bubble-user) vao bubble, af-toolblock/-head/-body vao ToolCallBlock.
- index.css: light theme override bubble ve nen trang #fff + chu #0f172a + viền mảnh (bubble user giu gradient xanh accent); ToolCallBlock light: nen #f8fafc, head #eef2f7, chu body #334155.
- Timing reset khi server ket noi lai: da co san tu phien truoc (connectedAt = Date.now() trong ws.onopen/es.onopen -> uptime reset 0).
- Build: tsc --noEmit exit 0; npm run build exit 0 (css 4.43 kB, js 201.76 kB).

## 2026-08-25 (bo sung) — Clamp token rac >200k khi nap state + Broadcast cap nhat UI + start.bat chuyen non-watch

### Van de
- data/agentforge-state.json chua du lieu token rac cong don cu: ui_coder 2.605.395, session_fixer 2.323.856, ver_agent 999.259, res_agent 916.888, Orchestrator context 297.254 (>200k) lam badge sai.
- start.bat dang goi npm run dev:watch (tsx watch) -> server tu restart lien tuc ke ca khi build/code loi tam thoi.

### Nguyen nhan
- Truoc khi sua parseJsonlEvents, token duoc cong don sai qua tung turn; gia tri cu da luu san trong state file.
- Watch mode khong phan biet code loi tam thoi va code that.

### Giai phap sua doi
- src/storage.ts:
  + Them TOKEN_DATA_CAP = 200000, helper sanitizeAgentTokenData(row) ho tro ca snake_case (token_usage/context_length tren dia) lan camelCase, number lan object {totalTokens,inputTokens,outputTokens,contextLength}; chi clamp truong vuot nguong (bao ton gia tri nho nhu outputTokens).
  + loadStateFromDisk goi sanitize cho moi agent row khi nap; ghi nhan id vao danh sach sanitizedTokenAgentIds.
- src/server.ts: sau khi server listen (cung khoi delay 3s voi replay outbox), doc getSanitizedTokenAgentIds() -> storage.updateAgent + broadcast('agent:updated') cho tung agent de UI cap nhat badge ngay khong can reload; roi clearSanitizedTokenAgentIds().
- data/agentforge-state.json: da xac minh sau clamp TAT CA agent <=200k (ui_coder=200000, session_fixer=200000, ver_agent=200000, res_agent=200000 kem outputTokens 1576, Orchestrator obj totalTokens/inputTokens/contextLength deu 200000, outputTokens 623 duoc bao toan). Server cu van dang giu gia tri cu trong bo nho - can restart app de nhan code moi + clamp ap dung.
- start.bat: doi call npm run dev:watch -> call npm run start (tsx non-watch); echo [3/3] cap nhat "Non-Watch". Backup: %TEMP%/opencode/start.bat.bak_nonwatch.
- Su co da xu ly trong phien: cac lenh tool bi ngat van thuc thi ngam gay trung khai bao sanitize block trong storage.ts nhieu lan + mot lan splice lam mat than file; da khoi phuc tu backup %TEMP%/opencode/storage.ts.bak_prededup_final va splice dung bien (giu L1-79, bo L80-132 ban trung), grep xac minh dung 1 khai bao moi identifier, StorageSchema/validateSchema/inMemory* nguyen ven.
- Kiem tra: npx tsc --noEmit PASS 0 error (chay lai 2 lan deu xanh); npm run build PASS (vite bundle index-BeU_qj8r.js 201.76 kB).

## 2026-08-25 (bo sung) — Clamp token rac >200k khi nap state + bat non-watch

### Van de
1. Badge token hien so rac: token_usage/context_length trong state file bi cong don den hang trieu (ui_coder 2.6M, session_fixer 2.3M, ver_agent 999k, res_agent 917k) do bug trich xuat cu.
2. start.bat chay npm run dev:watch (tsx watch) - server tu restart lien tuc ke ca khi code dang loi giua buoc build.

### Nguyen nhan
1. Truoc khi fix parseJsonlEvents, token duoc cong don sai qua moi turn va luu vao agentforge-state.json; khong co co che lam sach khi nap lai.
2. Watch mode phu hop cho dev nhanh nhung gay server chet/restart vo dinh khi build chua dat.

### Giai phap sua doi
- src/storage.ts: them TOKEN_DATA_CAP=200000 + ham sanitizeAgentTokenData(row) ho ca snake_case/camelCase va number/object; goi trong loadStateFromDisk - row vuot cap duoc clamp ve 200000 (Math.min); ghi nhan id vao sanitizedTokenAgentIds.
- src/server.ts: import getter; trong callback listen sau 3s, voi moi id da clamp thi storage.updateAgent (persist gia tri da sua ve disk) + broadcast('agent:updated') de UI cap nhat badge ngay khong can reload.
- data/agentforge-state.json: da duoc clamp thuc te (xac minh bang doc lai JSON): moi agent <=200000, breakdown con lai duoc bao toan (vi du outputTokens 623/1576).
- start.bat: doi call npm run dev:watch thanh call npm run start (= tsx src/server.ts, NON-WATCH) - server khong con tu restart khi sua code/build loi.
- Su co trong qua trinh: cac lenh bi ngat giua chung da thuc thi ngam gay trung khai bao khoi sanitize (2 ban) va mot lan splice lam mat phan than file - da khoi phuc tu backup %TEMP%/opencode/storage.ts.bak_prededup_final va splice dung bien (giu L1-79 + L133+), xac minh moi khai bao dung 1 lan truoc khi build.
- Kiem tra: npx tsc --noEmit PASS 0 error; npm run build PASS (vite ✓37 modules).
- Backup: %TEMP%/opencode/{storage.ts.bak_tokclean|bak_dupfix|bak_dedup_tokcap|bak_prededup_final}, start.bat.bak_nonwatch, agentforge-state.json.pre_clamp.

## 2026-08-25 (bo sung) — Bo clamp token, doi sang semantics snapshot cuoi cung + goi bo phu thuoc bi xoa

### Van de
1. Y kien nguoi dung: "Phai sanit tuc la dang lay sai truong" va "Khong can tinh toan cong tru gi ca" - usage trong event opencode la SNAPSHOT cua lan goi gan nhat, cong don vao se phong so (2.6M).
2. Sau khi revert storage ve bak_tokclean (go bo sanitize), server.ts van import getSanitizedTokenAgentIds/clearSanitizedTokenAgentIds -> start.bat crash SyntaxError khong mo duoc app.

### Nguyen nhan
1. parseJsonlEvents dung += (cong don) cho inputTokens/outputTokens/totalTokens/cost tren nhieu event cung mot luot.
2. Chinh sua storage va server khong dong boa -> import treo.

### Giai phap sua doi
- src/agents/acp-client.ts: doi toan bo += thanh gan truc tiep (snapshot cuoi cung thang); bo fallback contextLength || totalTokens (chi nhan contextLength ro rang tu provider); cost chi cap nhat khi >0.
- src/server.ts: go import 2 ham da xoa + go khoi broadcast sweep phu thuoc (L3676-3689 cu).
- Kiem tra: grep xac nhan 0 tham chieu sot; npx tsc --noEmit PASS; npm run build PASS. Nguoi dung chay lai start.bat de mo app.

- Kiem tra: npx tsc --noEmit PASS; npm run build PASS. Luu y: gia tri 200k hien tai trong state file se tu thay bang so that sau turn dau tien cua tung agent (updateAgent ghi de).

### Bo sung (cung ngay) — Fetch token ngay khi mo trang + cache agents localStorage
- Van de: mo trang lan dau, token badge trong (0) cho den khi WS bat tay xong moi fetch agents.
- App.tsx: them useEffect mount goi fetchAgents() NGAY (khong cho WS/SSE); khoi tao state agents tu cache localStorage 'af-agents-cache' -> F5 thay token tuc thi khong giut ve 0; helper applyAgents() ghi cache sau moi fetch thanh cong (fetchAgents + polling 10s dung chung).
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 202.00 kB).

## 2026-08-25 (bo sung) — API /api/agents tra du token ca 2 dang ten truong

### Van de / Yeu cau
- GET /api/agents truoc chi tra Agent camelCase (tokenUsage/contextLength); thieu snake_case mirror va truong hop memory chua co gia tri ma storage da luu.

### Giai phap
- src/server.ts endpoint GET /api/agents: voi moi agent, merge gia tri moi nhat tu storage.getAgent(id) (row token_usage/context_length) khi memory undefined; luon kem cap mirror token_usage/context_length de client cu/moi deu doc duoc.
- Kiem tra: tsc --noEmit PASS; npm run build PASS. Backup: %TEMP%/opencode/server.ts.bak_apiagents.

### Bo sung (cung ngay) — Ws realtime nhan them message:new / message
- App.tsx handleRealtimeEvent: mo rong dieu kien chap nhan type 'chat:message' | 'message:new' | 'message', payload linh hoat msg.msg || msg.message; giu nguyen dedup theo id, thay the tin user tam, cap MAX_DISPLAY, setLoading.
- Auto-reconnect: da co san (ws.onclose -> SSE fallback + backoff 1s..30s qua reconnectAttempts, reset attempts khi onopen) — khong thay doi de tranh regression.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 202.07 kB).

### Bo sung (cung ngay) — chat:chunk/chat:tool_call realtime + dong bo serverStartTime
- App.tsx: streamRef + upsertStreamMsg; bat 'chat:chunk' (noi textDelta vao tin stream dang chay, tu tao placeholder neu chua co) va 'chat:tool_call' (push vao toolCalls -> ToolCallBlock hien ngay); khi nhan chat:message cuoi cung tu cung agent -> go bo ban stream tam de khong trung noi dung.
- Dong bo timing: them GET /api/server-info (server.ts: SERVER_START_TIME) ; frontend state serverStartTime, fetch o mount + moi lan onopen (WS+SSE), onopen con setDisconnectedAt(null) xoa timing offline cu. Uptime pill/badge uu tien tu serverStartTime (that voi thoi gian server chay), fallback rong neu fetch loi.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 203.01 kB).

### Bo sung (cung ngay) — Dong bo loading spinner voi agent status
- Van de: spinner tat som vi 1 tin trung gian (moi tin to user deu clear loading) -> khong khop tien chinh that.
- App.tsx: (1) chat:message chi con error moi setLoading(false); (2) agent:updated sync 2 chieu cho agent dang mo: working -> bat spinner, idle/error/stopped -> tat; (3) them effect nguon chan ly: loading = (agents.find(target).status==='working') phu thuoc [agents, selectedAgentId] -> bao phu ca polling 10s, cache init va WS event bi loi.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 203.09 kB).

### Bo sung (cung ngay) — ThinkingBlock hien thi suy luan cua model
- ChatPanel.tsx: component ThinkingBlock (prop thinking:string) — header "💭 Thinking" + toggle [▼]Expand/[▲]Collapse, mac dinh thu gon; noi dung #94a3b8 italic 12px, maxHeight 250px overflowY auto, viền mong nen mo hon bubble; dat o DAU MessageItem tren body text; class af-thinking de light theme override (#f8fafc).
- App.tsx: ChatMsg them thinking?: string + passthrough 2 nhanh handleRealtimeEvent; optional guard nen khong loi khi backend chua gui du lieu.
- Build: tsc --noEmit exit 0; npm run build exit 0 (css 4.53kB, js 204.37 kB).

### Bo sung (cung ngay) — Chong spam lap loi Abort trong OrchTrigger
- server.ts (processOrchestratorTriggerQueue): report chua "Agent operation aborted by user" hoac "turn failed" -> markOutboxDelivered NGAY, khong bao gio phat lai/retry; them dedup 2s: noi dung giong het nhau trong vong 2000ms bi bo qua (delivered) qua recentReportHashes Map + prune khi >500 entry.
- Backup: server.ts.bak_dedup. Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — Chan loop Abort trong catch + tach toolCalls cau truc + sach bao cao ve Orchestrator
- server.ts processOrchestratorTriggerQueue catch: loi chua 'abort'/'aborted' -> markOutboxDelivered ngay (khong retry, het vong lap 6 lan); deliverTalk catch xu ly tuong tu.
- server.ts broadcastOACEvent: nhanh tool_result/tool cung dua vao mang toolCalls cau truc (truoc do chi tool_use); khong con noi chuoi '● [TOOL ...]' vao content.
- server.ts handleAgentResponse: helper stripToolNoiseForOrchestrator (loc dong '● [TOOL', '[TOOL RESULT', '🔧'); kenh Orchestrator nhan ban sach: KHONG dinh toolCalls/thinking; auto-report cung duoc loc. Chi tiet toolcall chi phat tren kenh noi bo worker (to=agentId).
- Frontend: App truyen showToolBlocks=Boolean(selectedAgentId); ChatPanel/MessageItem chi render ToolCallBlock khi showToolBlocks -> Tab Main bao cao sach, tab Agent xem day du de debug.
- Fix phu (file session_fixer): acp-client.ts 2 cho return dung bien chua khai bao thinkingParts -> thay bang thinking da destructure tu parseJsonlEvents (dung y do).
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 204.44 kB). Backup: server.ts.bak_dedup.

## 2026-08-25 (bo sung) — Tach toolCalls trong broadcastOACEvent + them truong Thinking

### Van de / Yeu cau
1. broadcastOACEvent van noi chuoi [TOOL ...] vao content — can dua vao mang toolCalls cau truc trong msg.
2. Can bat event reasoning/thinking/thought luu vao truong thinking? rieng, khong tron vao content.

### Giai phap
- src/server.ts broadcastOACEvent: event tool_use/tool-call/tool_call -> push {tool,input,output} vao oacToolCalls (bo lines.push ● [TOOL...]); msg kem toolCalls khi co. Event reasoning/thinking/thought -> push text vao content nhu loi noi binh thuong (live stream).
- src/agents/acp-client.ts parseJsonlEvents: them case reasoning/thinking/thought gom thinkingParts; return thinking; 3 return cua chatWithRetry (success/partial/error-final) destructure + gan thinking qua.
- src/agents/types.ts: AgentMessage.thinking?. server ChatMsg them thinking?; handleAgentResponse nhan tham so thu 5 thinking va gan vao reply; cac caller truyen tr.thinking/result.thinking.
- Web types: App.tsx + ChatPanel.tsx ChatMsg them thinking?.
- Kiem tra: tsc --noEmit PASS; npm run build PASS. Backup: %TEMP%/opencode/{server,App}.ts.bak_oactool|wsfix.

### Bo sung (cung ngay) — Tach roi loi thoi va toolcall trong broadcastOACEvent
- server.ts: viet lai broadcastOACEvent theo spec — textLines chi nhan event 'text' (va INPUT/ERROR/fallback text), tool_use/tool-call/tool_call/tool_result/tool deu dua vao mang toolCalls {tool, input?, output?} (input/output chuan hoa string qua asText, doc ca part.* va state.*); TUYET DOI khong noi '● [TOOL ...]' vao content; msg gui WS co content = textLines.join va toolCalls=undefined khi rong.
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — Git-style diff cho tool edit trong ToolCallBlock
- ChatPanel.tsx: them parseToolInputObject() (input la chuoi JSON hoac object) + DiffLine (dang '- ' do / '+ ' xanh theo git: bg rgba(239,68,68,.12)/rgba(34,197,94,.12), borderLeft 3px #ef4444/#22c55e); ToolCallBlock nhan dien tool==='edit' hoac input co oldString/newString -> render 📁 filePath + cac dong -/+ + ket qua output '✓ ...' o duoi; tool khac (read/bash...) giu nguyen input/output thuong.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 205.88 kB).

### 2026-08-25 — Dai tu giao dien Modern Minimalist (Cursor/Linear/OpenCode style)
- index.css: he thong token moi cho ca 2 theme qua [data-theme]: --bg-main/--bg-panel/--bg-inset/--bg-input/--bg-card(-active)/--af-border(-strong)/--text-*/--accent(-strong,-soft)/--shadow-panel/--shadow-pop/--radius-lg,md; giu legacy alias (--bg-primary...) de tuong thich; scrollbar sieu mon 4px + firefox thin; utilities .af-elevate/.af-pop + transition .18s cho cac surface af-*.
- ChatPanel.tsx: token hoa panel/header/input/textarea/bubble (tat ca variant role ve nen trung tinh var(--bg-panel), user giu accent gradient, opencode var(--bg-inset)); ToolCallBlock/ThinkingBlock dung token; input radius var(--radius-lg) focus ring accent-soft; nut gui icon '↑' vuong 44px.
- Dashboard.tsx: card orchestrator/agent + select model token hoa (bg-card/bg-card-active/accent/radius 12).
- App.tsx: shell/sidebar/resizer/watchdog box/nut model config/nut theme chuyen sang token; sua bug className="af-resizer" bi trung khai bao.
- Gioi han da biet: dialog con mot so mau inline cu (da co af-dialog-box override cho light); chip trang tri nho giu mau accent cu.
- Build: tsc --noEmit exit 0; npm run build exit 0 (css 5.90kB, js 205.99 kB).

### Bo sung (cung ngay) — Dao thu tu Thinking->Tool->Body + chot max height cac khoi + collapse mac dinh
- ChatPanel.tsx MessageItem: thu tu hien thi chuan 1.ThinkingBlock 2.ToolCallBlocks 3.Body; Report Block khi mo rong chot maxHeight 350 overflowY auto width 100%.
- ToolCallBlock: mac dinh COLLAPSE (useState(false)); root display block/width 100%/boxSizing border-box; body maxHeight 280 width 100%; Git Diff View boc rieng maxHeight 300 scroll.
- ThinkingBlock: full width, noi dung giam maxHeight 250 -> 220.
- index.css: Dark bg-main #090d16 (Deep Obsidian), Light bg-main #f8fafc (Off-White); them keyframes af-working-pulse + .af-card.af-working (sidebar pulse nhe khi agent working).
- Dashboard.tsx: card agent gan class af-working theo status==='working'.
- Build: tsc --noEmit exit 0; npm run build exit 0 (css 6.15kB, js 206.38 kB).

### Bo sung (cung ngay) — Boc tach Task Report sach khi gui ve Orchestrator
- server.ts: them extractCleanTaskReport(content) — neu co marker '=== TASK REPORT ===' thi chi giu tu (dong 'Task complete.' lien truoc, neu co) den '=== END REPORT ==='; khong co marker tra nguyen van.
- handleAgentResponse: kenh Orchestrator (to==='orchestrator') luu/broadcast ban cleanContent = extract(stripToolNoise(...)); auto-report cung qua cung pipeline. Tu su day du + thinking/toolCalls chi con tren kenh noi bo worker (to=agentId).
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — Bo maxHeight cho Structured Task Report
- ChatPanel.tsx: xoa wrapper maxHeight 350 + overflowY auto cua Report Block khi mo rong -> hien thi FULL HEIGHT tu nhien, khong scroll long; giu nguyen nut Collapse/Expand tren header report. ToolCallBlock (280/300) va ThinkingBlock (220) giu nguyen hanh.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 206.19 kB).

### Bo sung (cung ngay) — Strip ma ANSI escape khoi output toolcall
- Them helper stripAnsi (regex ESC/CSI chuan) o ca 2 phia:
  + server.ts broadcastOACEvent: output cua tool_use/tool_result duoc lam sach truoc khi day vao mang toolCalls.
  + ChatPanel.tsx ToolCallBlock: safeInput/safeOutput lam sach truoc khi dung content, parse JSON diff va render dong '✓ output' -> het ky tu [2m/[32m/o vuong.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 206.34 kB).

### Bo sung (cung ngay) — Khoa session vinh vien + AnsiRenderer mau sac + bubble full width cho toolcall
- acp-client.ts (PERSISTENT-SESSION POLICY): vo hieu hoa 3 diem tu-reset session (format khong hop le, 404/session-expired o luoi giua va luoi cuoi) — khong con `this.sessionId = null`/unregister trong vong doi chat; chi log warning va retry tiep tren cung session. Endpoint xoa session thu cong cua user + xoa khi delete agent van giu nguyen (chu dong, co chu dich).
- ANSI: server.ts stripAnsi doi nghia — chi go CSI dieu khien, GIU ma mau SGR (...m); ChatPanel them AnsiRenderer (split SGR, map 31/32/33/34/35/36/90-96 -> mau, 1 bold, 2 dim .6, 0/22/39 reset) ap dung vao output cua ToolCallBlock (ca nhanh diff ✓ va body thuong).
- Bubble full width: MessageItem tinh forceFullWidth = isOpenCode || co toolCalls -> bubble maxWidth/width 100% + boxSizing border-box, alignItems stretch; ToolCallBlock da co width 100% tu truoc.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 207.67 kB).

### Bo sung (cung ngay) — Tach Thinking/ToolCallBlocks ra khoi bubble text
- ChatPanel.tsx MessageItem: ThinkingBlock va cac ToolCallBlock duoc dua RA NGOAI the .af-bubble, render thanh 2 khoi doc lap TREN bubble text (wrapper rieng: width 100%, maxWidth 85%/94% canh theo huong bubble, gap 4px); bubble chi con chua body/report (bao gom report header + body full height). Bo forceFullWidth tren bubble vi tool khong con nam trong.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 207.87 kB).

### Bo sung (cung ngay) — Process-Authoritative Idle
- acp-client.ts: isBusy() doi tu `this.busy` sang `this.proc !== null` — chi tra false khi proc.on('close')/'error' da gan proc=null; flag busy noi bo van dung cho hang doi runQueued.
- server.ts: go 2 cho Watchdog timer TU Y gan agent.status='idle' (status-check response va recovery-attempt response) — watchdog van gui TALK/report/binh thuong nhung khong con de status; idle chi den tu cac luong enqueue that ket thuc (sau await, tuc post proc-close). Rà soát toan bo diem gan idle khac: deu nam sau await enqueue hoac la hanh dong nguoi dung (stop/resume/delete) — hop le.
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — Bo dong "✓ Edit applied successfully" khoi Git Diff View
- ChatPanel.tsx ToolCallBlock: xoa the render ket qua output ("✓ ...") trong nhanh diff view cua tool edit; Diff chi con 📁 filePath + cac dong -/+ ; output van giu o che do hien thi thuong cho tool khac.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 207.70 kB).

### Bo sung (cung ngay) — ReadFileViewer cho tool read
- ChatPanel.tsx: them component ReadFileViewer({input, output}) — parse filePath tu <path>/input/JSON {filePath|path}; boc code trong <content>...</content>; bat ghi chu "(Showing lines ...)". Render: header 📁 filePath mono + khung code nen toi #0d1117 scroll maxHeight 300 width 100% + dong tom tat mau mo chan khung. Da stripAnsi truoc khi parse.
- ToolCallBlock: khi tool==='read' hoac output co <content> -> render ReadFileViewer thay text tran (uu tien sau nhanh diff edit).
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 209.25 kB).

### Bo sung (cung ngay) — BashCommandViewer + Diff bo dau +/-
- ChatPanel.tsx: them BashCommandViewer({input, output}) cho tool bash/shell — parse command tu JSON {"command"} hoac chuoi tran; dong prompt "$ command" cyan bold mono; output qua AnsiRenderer giu mau ANSI, scroll maxHeight 280 width 100%.
- DiffLine: bo tien to "+ "/"- " — chi phan biet nen do/xanh (0.14) + vien trai 3px; mau moi: remove #fca5a5 / add #86efac; giu nguyen thut le goc cua code.
- Thu tu render ToolCallBlock: edit diff -> read viewer -> bash viewer -> AnsiRenderer thuong.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 209.94 kB).

### Bo sung (cung ngay) — Agent nhay Working ngay khi nhan viec + ANSI-STANDARDS-GUIDE.md
- server.ts deliverTalk: chen khoi set working (status/workingSince + storage.updateAgent + broadcast agent:updated) NGAY TRUOC tc.enqueue — badge UI cap nhat tuc thi, cover ca duong replay outbox ma caller khong set. dispatchUserChat da co san khoi tuong tu (dòng 2821-2823 / 2840-2844) — khong sua.
- Tao ANSI-STANDARDS-GUIDE.md (goc du an): cau truc escape, chinh sach strip 2 phia (server giu SGR / frontend render mau), bang ma SGR -> CSS cua AnsiRenderer, vi tri ap dung trong UI, luu y van hanh.
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — SearchCommandViewer GitHub-style cho glob/grep/searcher
- ChatPanel.tsx: them SearchCommandViewer({tool,input,output}) — parse pattern/path/include tu input JSON; header cyan "🔍 TOOL pattern: \"...\" in path"; danh sach ket qua nen toi #0d1117 scroll 280px: ho tro grep -n (file:line:text -> 📄 file + so dong xam + noi dung), "Line 580:"/"580:" (so dong rieng), duong dan tran (📄/📁); stripAnsi tung dong.
- ToolCallBlock: them nhanh isSearchView = glob|grep|searcher, thu tu: edit diff -> read viewer -> bash viewer -> search viewer -> AnsiRenderer.
- Working-fix va ANSI-STANDARDS-GUIDE.md: da hoan thanh phien truoc (xac minh con nguyen).
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 212.37 kB).

### Bo sung (cung ngay) — Kiem tra & gia co hien thi ToolCallBlock
- Kiem dinh server: broadcastOACEvent giu nguyen mang toolCalls tren kenh noi bo (from=to=agentId, line 537); handleAgentResponse chi strip toolCalls tren kenh Orchestrator (line 2038) — khong thay doi.
- ChatPanel.tsx: them class ToolBlockSafe (boundary per-block, fallback hop "loi dinh dang" mono dim); MessageItem chuan hoa tung entry toolCalls (coerce String/guard null) truoc khi render — entry loi khong lam sap panel.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 213.25 kB).

### Bo sung (cung ngay) — ToolCalls luon di kem moi tin nhan + luon render
- server.ts handleAgentResponse: bo guard !isToOrchestrator — toolCalls LUON duoc attach vao reply (moi kenh, ke ca Orchestrator/main); ket hop voi extractCleanTaskReport thi main se co bao cao sach text + day du hop tool ben duoi.
- App.tsx: showToolBlocks={true} co dinh — hop ToolCallBlock render o moi tab, khong phu thuoc selectedAgentId.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 213.25 kB).

### 2026-08-25 — Cai tom tuong phan Light theme (diet chu trang nen trang)
- Van de: Ten agent/timestamp/badge dung mau hardcode sang (#f8fafc/#cbd5e1/#94a3b8) tren nen trang -> khong doc duoc.
- index.css: cap nhat token light theo spec (--text-primary #0f172a, --text-secondary #334155, --text-muted #64748b, --bg-panel #fff, --bg-card #f1f5f9, --af-border #e2e8f0); them token --report-label (#fde047 dark / #b45309 light).
- Dashboard.tsx: thay toan bo color chu hardcode sang token (replaceAll '#94a3b8'/'#cbd5e1'/'#e2e8f0'/'#f8fafc' -> var); card/select/label deu token hoa.
- ChatPanel.tsx: roleBadge chip (rgba(255,255,255,.08)+#cbd5e1 -> accent-soft+text-secondary); report header (border token, label var(--report-label), nut collapse inset+secondary); replaceAll '#64748b'/'#94a3b8' -> var(--text-muted) toan file (displayTo, timestamp, thinking header, diff label, empty state...). Vung nen toi co dinh (code block #0d1117, search rows) giu mau rieng.
- App.tsx: da sach token tu phien truoc (grep khong con mau cu).
- Build: tsc --noEmit exit 0; npm run build exit 0 (css 6.19kB, js 213.51 kB).

### Bo sung (cung ngay) — Tu dong danh thuc Orchestrator khi worker 1-1 bao cao + bo hardcode path SpawnDialog
- server.ts dispatchUserChat: trong nhanh KHONG co [TO:] tuong minh (reply thang ve user), neu response chua '=== TASK REPORT ==='/'=== END REPORT ===' -> extractCleanTaskReport(stripToolNoise) roi await triggerOrchestrator(targetAgent, clean) -> Orchestrator thuc ngay de tong hop tra loi user. Nhanh co [TO:] khong doi (da qua handleAgentResponse, tranh trigger trung).
- SpawnDialog.tsx: bo default projectDir 'C:/Users/Hai Dang' -> chuoi rong (server fallback cwd khi rong).
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — Toan tuyen du lieu thinking + wake Orchestrator theo report trong message route
- server.ts dispatchUserChat: nhanh hasExplicitTo them vong quet messages — neu co msg.to==='orchestrator' hoac chua '=== TASK REPORT ===' -> triggerOrchestrator (break 1 lan, extractClean+stripNoise); handleAgentResponse truyen them result.thinking.
- server.ts: 3 cho ChatMsg tao truc tiep (slash reply/user reply/orch reply) them spread thinking; 6 caller handleAgentResponse (stop-flow, deliverTalk, existing-task, spawn-first-turn, talk-loop) truyen tr.thinking/result.thinking; handleAgentResponse bo guard !isToOrchestrator cho thinking -> toan tuyen.
- server.ts broadcastOACEvent: event 'thinking' gom vao evThinking gan msg.thinking (khong tron textLines); dieu kien early-return tinh ca evThinking.
- Frontend ThinkingBlock da dung spec tu truoc (xam mo italic 12px, [▼]/[▲], max 220) — chi xac minh.
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — SpawnDialog default '.' + ThinkingBlock chuan #94a3b8
- SpawnDialog.tsx: default projectDir '.' ; placeholder './path/to/project'.
- ChatPanel.tsx ThinkingBlock: header + content tra ve mau #94a3b8 dung spec (truoc do replaceAll bien thanh token muted); giu italic 12px, toggle [▼]/[▲], max 220.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 213.47 kB).
- Luu y: Message 2 cua Orchestrator bi cat cut ('[SPAWN name=coder2...') — da yeu cau gui lai.

## 2026-08-25 (bo sung) — TASK REPORT auto-wake + thinking truyen day du cac luong tao message

### Van de / Yeu cau
1. Worker nop bao cao chua === TASK REPORT === trong chat 1-1 nhung khong co [TO:] -> chi tra user, Orchestrator khong duoc danh thuc.
2. Truong thinking phai duoc gan day du tai moi diem tao tin nhan.

### Giai phap
- dispatchUserChat: sau clearAgentRetry, neu response khop /=== TASK REPORT ===|=== END REPORT ===/ -> extractCleanTaskReport(stripToolNoiseForOrchestrator(response)) roi await triggerOrchestrator (khoi da ton tai tu phan viec song song - xac minh toan ven).
- handleAgentResponse: 6 caller deu truyen tham so thu 5 thinking (resume L827, deliverTalk L2171, reuse-spawn L2283/2403/2509, dispatchUserChat L2975); reply gan ...(thinking ? {thinking} : {}).
- dispatchUserChat: 3 reply truc tiep gan result.thinking (go 1 ban trung lap bi chen).
- broadcastOACEvent: bo sung bien the reasoning/thought vao nhanh gom evThinking (thinking/reasoning/thought).
- Kiem tra: tsc --noEmit PASS; npm run build PASS (bundle index-Bti6aYH0.js 213.47 kB). Backup: %TEMP%/opencode/server.ts.bak_thinkwake.

## 2026-08-25 (bo sung) — Sua crash UI 'Cannot read properties of null (reading totalTokens)'

### Van de
- UI crash runtime: Cannot read properties of null (reading 'totalTokens').

### Nguyen nhan
- Dashboard.tsx dung 	ypeof tokenUsage === 'object' de chon nhanh — nhung typeof null === 'object' nen khi /api/agents tra tokenUsage:null (sau khi reset state + merge tu storage row null), code doc .totalTokens tren null -> crash.
- Thu con lai: ChatPanel L538 da an toan (gan tu = null roi dung tu?.); server /api/agents gan out.tokenUsage = stored.token_usage khong loai null.

### Giai phap
- web/src/components/Dashboard.tsx L122 & L292: them guard truthy — 	okenUsage && typeof tokenUsage === 'object' truoc khi truy cap totalTokens/total.
- src/server.ts /api/agents: bo qua gia tri null khi bu tu storage (chi merge khi !== undefined && !== null).
- Kiem tra: tsc --noEmit PASS; npm run build PASS (bundle index-BWw4-ieD.js 213.49 kB).

### Bo sung (cung ngay) — Interruptible Queue voi debounce 1s
- acp-client.ts: enqueue khi proc dang song -> armInterruptDebounce(1000ms); het debounce neu van con pending va proc song -> superseded=true + abort() kill process hien tai; close firing -> runQueued finally tu drain pending, gom batch (combineBatchPrompts) va chay LAI NGAY cung sessionId (persistent-session). Luot bi ngat tra "[INTERRUPTED] ... thaythe" thay "[STOPPED]" de phan biet; runQueued reset supersed/_aborted dau moi luot; clear debounce khi khong con proc.
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — Cap nhat tai lieu quy tac van hanh
- src/prompts/orchestrator.md + AGENTS-GUIDE.md: append muc "Operating Rules / Concurrency, Queue, Session and State Rules (2026-08-25)" gom 4 quy tac: Non-Blocking Concurrency & Multi-Coder Load Balancing; Preemptive Interrupt Queue with 1s Debounce; Persistent Sessions & Process-Authoritative Idle; Team State Synchronization (file path + dong chinh xac khi giao viec). Append-only, khong in dam.
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — Siet loc tab Main: an toan bo tu su va stream tool trung gian
- App.tsx filteredMessages (selectedAgentId===null): (1) an 100% msgType==='opencode'; (2) tin tu worker (from khong phai user/orchestrator/system/error) CHI hien khi to==='orchestrator' VA content chua '=== TASK REPORT ===' hoac 'Task complete.'; (3) cac nhanh user/orchestrator/error giu nguyen. Tab rieng agent khong doi — van full 100% de debug.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 213.65 kB).

### Bo sung (cung ngay) — Mo rong parser bao cao toan dien (moi bien the REPORT)
- server.ts: them REPORT_BLOCK_RE (TASK|RESEARCH|VERIFICATION|ERROR) + TASK_COMPLETE_RE.
- validateWorkerCompletion: thieu [TO: orchestrator] nhung CO report block -> VALID + auto-route (het loi "Missing [TO]"); chap nhan block moi hoac "Task complete."/STATUS completed thay doi chi doi TASK; message reason cap nhat.
- extractCleanTaskReport: start marker nhan moi bien the; end marker dong bo "=== END <loai> REPORT ===".
- dispatchUserChat: ca 2 diem wake (else-branch va wake-loop hasExplicitTo) dung regex moi.
- parseAgentOutput: da tu route defaultTo='orchestrator' khi khong co tag (kiem dinh, khong sua).
- Build: tsc --noEmit exit 0; npm run build exit 0.

### Bo sung (cung ngay) — Launcher web doc lap (ta biet Electron)
- server.ts: ho tro co `--open` / env OPEN_BROWSER=1 — khi listen thanh cong tu mo tab trinh duyet http://localhost:port/ (win: start, mac: open, linux: xdg-open). Electron spawn server khong kem co nen khong bao gio tu mo trinh duyet.
- start-web.bat (moi): nhap dup chay server nen (start /min) uu tien node dist\server.js --open, fallback npm run dev -- --open; OPEN_BROWSER=1; PORT=3001. Server tu mo browser sau khi listen.
- Build: tsc --noEmit exit 0; npm run build exit 0.

### 2026-08-25 — REVERT Interruptible Queue ve logic queue an toan cu
- Van de: co che interrupt (debounce 1s + kill process khi co tin moi) gay vong lap kill tien trinh lien hoan, tin mat va reply bien mat.
- Nguyen nhan: abort() trong che do superseded giu pending nhung kick-off poll chay song song voi finally-drain cua runQueued -> race giua 2 duong kick; ket hop server auto-wake tao chu ky kill/goi lien tuc.
- Giai phap: REVERT TOAN BO co che interrupt ve logic cu da on dinh — enqueue chi push pending; abort() reject pending nhu cu (STOP thu cong); runQueued drain sau khi chat resolve (proc close); xoa fields interruptTimer/superseded, armInterruptDebounce/clearInterruptDebounce, nhanh [INTERRUPTED]. isBusy proc-based va persistent session GIU NGUYEN (2 yeu cau rieng da nghiem thu).
- Kiem tra: grep con sot 0 match; tsc --noEmit exit 0; npm run build exit 0.

## 2026-08-25 (bo sung) — Auto mo trinh duyet khi khoi dong standalone + replay outbox sau 1s

### Van de / Yeu cau
- Job 1: sau khi server listen thanh cong can (1) tu dong mo trinh duyet tren Windows, (2) replayPendingReports chay sau 1s de tiep cac task dang du thay vi 3s.

### Giai phap
- src/server.ts startServerWithPortFallback: thay khoi LAUNCHER cu (chi mo khi co co --open) bang AUTO-OPEN mac dinh tren win32 qua exec(start \"\" url); co che tat: --no-open / OPEN_BROWSER=0 / phat hien Electron (ELECTRON_RUN_AS_NODE|ELECTRON) de Electron van tu quan ly cua so rieng.
- Delay replay doi 3000ms -> 1000ms (kem processChatRetryQueue + scheduleChatRetry nhu cu); cap nhat comment.
- Kiem tra: tsc --noEmit PASS; npm run build PASS (bundle index-CfED6Hnp.js 213.65 kB). Backup: %TEMP%/opencode/server.ts.bak_autoopen.

## 2026-08-25 (bo sung) — Todo Checklist Viewer cho tool todowrite/todoread

### Van de / Yeu cau
- Output cua tool todowrite/todoread in mang JSON tho, kho doc.

### Giai phap
- web/src/components/ChatPanel.tsx:
  + Them parseTodosFrom(raw): JSON.parse truc tiep; neu that bai thi trich doan JSON dau tien trong text; chap nhan mang truc tiep, {todos:[...]}, hoac object co mang o field dau tien.
  + Them component TodoListViewer({input,output}): parse tu output (hoac input khi output rong); header "📋 Task Checklist (N tasks)"; moi item icon trang thai (in_progress 🟡 / completed ✅ / pending ⬜), content ro net (completed gach ngan), badge priority high do/medium vang/low xam; nen toi #0d1117, bo goc 10, maxHeight 280 scroll ngang, width 100%.
  + ToolCallBlock: early-return TodoListViewer khi ten tool chua 'todo'.
- Kiem tra: tsc --noEmit PASS; npm run build PASS (bundle index-jmNAlAzY.js 216.23 kB, co chuoi 'Task Checklist'). Backup: %TEMP%/opencode/ChatPanel.tsx.bak_todo.

### Bo sung (cung ngay) — Single-file EXE bang Node SEA (pivot tu @yao-pkg/pkg)
- Ly do pivot: @yao-pkg/pkg tren Windows thuieu tien ich `patch` khi fetch base binary -> build-from-source fail (spawnSync patch ENOENT), khong co Git usr/bin de cuu.
- Gia phap SEA (Node 24 built-in): scripts/build-sea-bundle.mjs (esbuild bundle dist/server.js -> dist/sea-server.cjs, define import.meta.url tranh ERR_INVALID_URL); scripts/gen-sea-assets.mjs sinh sea-config.json nhung 4 assets (dist/index.html + toan bo web/dist); node --experimental-sea-config + copy node.exe + postject inject.
- server.ts static layer SEA-aware: readFileStatic() thu SEA getAsset -> cwd -> __dirname; /assets them GET fallback doc blob voi MIME map; / va /v2 dung readFileStatic. createRequire(import.meta.url) load node:sea trong ESM.
- package.json: script build:exe (chuoi day du); them bin; xoa pkg block; devDeps postject.
- start-web.bat uu tien release\agentforge-web.exe.
- SMOKE TEST PASS: exe 90.3MB chay PORT=3019 OPEN_BROWSER=0 -> API/ROOT/ASSET deu 200, log "Running as SEA single executable".

## 2026-08-26 — [TALK] nhan tham so task=: cap nhat task dong cho agent

### Van de
- Khi Orchestrator giao viec moi qua [TALK agent-id=... message=...], agent van giu nguyen task cu: tieu de Task tren Header chat va Sidebar khong doi, team state inject vao prompt lan sau van chua nhiem vu cu.

### Nguyen nhan
- parseTalkTag chi boc tach agentId + message (truoc day "task" chi la alias cua message), khong ton tai duong dan nao cap nhat Agent.task khi Orchestrator talk viec moi cho agent dang ton tai.

### Giai phap
- src/server.ts - parseTalkTag: viet lai bo quet tham so key=value (message/msg/content/task); gia tri moi key ket thuc tai key ke tiep, match nam trong chuoi quote bi bo qua; ho ca hai thu tu (task truoc/sau message) deu dung; backward-compat: lenh chi co task= khong message= thi task lam noi dung tin nhan.
- src/server.ts - handleOrchestratorResponse (vong xu ly TALK): neu co tham so task -> ta.task = task.trim().normalize('NFC'); persist storage.updateAgent(ta.id, {..., task: ta.task} as any); broadcast('agent:updated', { agent }) → UI Header/Sidebar tu dong hien nhiem vu moi ngay sau khi Orchestrator talk.
- Kiem tra: npm run build PASS (tsc + vite bundle 216.23 kB + electron tsc).

### Bo sung (cung ngay) — Context-Aware Git Diff (LCS theo dong)
- ChatPanel.tsx: them computeDiffRows() (LCS DP O(n*m), guard 640k o -> fallback cu) + ContextLine (chu xam #94a3b8, vien trong suot 3px de thang hang); ToolCallBlock diff view render theo row: ctx giong nhau = xam khong nen, del/add giu DiffLine do/xanh — chi to dong thuc su thay doi nhu GitHub.
- Build: tsc --noEmit exit 0; npm run build exit 0 (js 217.16 kB).

## 2026-08-25 (bo sung) — Co lap lenh abort theo PID rieng tung agent

### Van de
- Khi ngat 1 agent, ver_agent cung bao 'aborted by user' — nghi giết chéo tien trinh.

### Nguyen nhan
- abort() co vong busy-wat dong bo 2 giay (phong toa event loop -> cac agent khac dung hinh/timeout) va dung execSync; ban than kill da theo PID nhung khoi dong bo kha nang phong toa event loop.

### Giai phap
- src/agents/acp-client.ts abort(): thay ca khoi isWin bang mot lenh exec bat dong bo dung cu phap yeu cau: exec(\	askkill /pid \11352 /T /F\) — chi tac dong vao cay PID cua instance do; fallback van theo dung PID. Bo busy-wait 2s -> event loop khong bi phong toa, agent khac khong bi anh huong.
- Audit: khong ton tai bat ky lenh kill theo ten (opencode.exe / IM) trong toan bo src.
- Kiem tra: tsc --noEmit PASS; npm run build PASS. Backup: %TEMP%/opencode/acp-client.ts.bak_abortpid.

## 2026-08-25 (bo sung) — Sua crash UI 'Cannot read properties of undefined (reading toLowerCase)'

### Van de
- UI Error Encountered khi Orchestrator gui tin nhan dai (chua TASK/TEAM/TALK blocks): Cannot read properties of undefined (reading 'toLowerCase').

### Nguyen nhan
- ChatPanel.tsx L955: agents.find(a => a.name.toLowerCase() === effectiveTo.toLowerCase()) — neu bat ky agent nao trong danh sach thieu name (undefined) thi a.name.toLowerCase() crash; cung khong an toan khi effectiveTo khong phai string.

### Giai phap
- ChatPanel.tsx L955: guard 2 ve — (a.name || '').toLowerCase() === String(effectiveTo).toLowerCase().
- Audit toan web/src: khong con cho nao goi .toLowerCase tren truong co the undefined khac (Dashboard getRoleIcon da guard role||''; TodoListViewer dung String(); ToolCallBlock tool duoc chuan hoa thanh chuoi truoc).
- Kiem tra: tsc --noEmit PASS; npm run build PASS (bundle index-DMHzbBK7.js 217.17 kB).

## 2026-08-26 - Fix SEA prompt warnings + rebuild EXE v2 URL
- Van de: release/agentforge-web.exe chay tu release/ -> PROMPTS_DIR=release/src/prompts khong ton tai -> spam 12 dong [Prompt] Not found, dung fallback; browser mo http://localhost:3001/ thieu /v2 do EXE cu chua duoc rebuild sau fix.
- Nguyen nhan: PROMPTS_DIR chi thu process.cwd()/src/prompts, khong ho tro SEA single executable; sea-config.json chi nhung web/dist chua nhung prompts; build:exe bi EBUSY do exe dang chay.
- Giai phap:
  + src/server.ts: thay PROMPTS_DIR bang PROMPTS_CANDIDATE_DIRS (cwd, dirname(process.execPath), dirname(process.execPath)/.., __dirname/../src/prompts, __dirname/prompts) va loadPrompt duyet tim file dau tien ton tai; rolesDir tim thu muc roles dau tien ton tai.
  + npm run build PASS; kill PID 2624 dang giu release/agentforge-web.exe -> copyFileSync node.exe -> postject NODE_SEA_BLOB dist/sea-prep.blob PASS (94.6 MB, 2026-08-26 15:12).
  + Kiem chung: SEA chay lai khong con warning Prompt, Loaded 6 agents/500 msgs, listening 3001, sea-server.cjs chua url /v2; web build index-Dvgrtupw.js 217.27 kB (safeTool fix toLowerCase).

## 2026-08-26 - Fix SEA white screen khi chay tu release folder
- Van de: Khoi dong agentforge-web.exe tu folder release -> giao dien den/trang, spawn khong hien; log [Storage] Loaded 1 agents / 0 messages thay vi 6 agents / 500 msgs nhu chay tu goc project.
- Nguyen nhan: storage.ts DATA_DIR = join(process.cwd(),'data') va server.ts OPENCODE_AGENTS_DIR = join(process.cwd(),'.opencode/agents') — khi cwd=release/ thi doc release/data/agentforge-state.json rong (392B) thay vi data chinh 5.8MB; PROMPTS_CANDIDATE truoc do uu tien cwd nen lay nham release.
- Giai phap:
  + storage.ts: them __dirname_storage + resolveProjectRootForStorage() uu tien package.json truoc, fallback chon state file lon nhat (nhieu du lieu nhat).
  + server.ts: them statSync import, doi resolveServerProjectRoot() cung logic 2 vong (package.json truoc, sau do chon state lon nhat), sua OPENCODE_AGENTS_DIR/AGENTS_DIR/CUSTOM_ROLES_PATH dung SERVER_PROJECT_ROOT.
  + Rebuild: tsc+vite PASS, build-sea-bundle/gen-sea-assets PASS, copyFileSync + postject PASS (94.6MB), test SEA tu release/ gio Loaded 6 agents / 500 msgs dung nhu chay tu goc; da xoa release/data stale.

## 2026-08-26 - Fix copy 1 file exe sang thu muc khac: nhung src/prompts + CWD sinh .opencode
- Van de: Copy rieng agentforge-web.exe sang thu muc khac (C:\test-agentforge thoi) -> spam 13 dong [Prompt] Not found (src/prompts khong ton tai tai CWD moi), fallback rong lam mat chuc nang prompt goc; yeu cau: CWD moi phai tu sinh .opencode de opencode dung, dong thoi src prompt goc van hoat dong dung.
- Nguyen nhan:
  + gen-sea-assets.mjs walk() bi bug lam phang thu muc con: src/prompts/roles/coder.md bi nhung thanh src/prompts/coder.md nen SEA getAsset(key=src/prompts/roles/coder.md) tra ve null.
  + server.ts loadPrompt chi thu filesystem, chua thu SEA embedded truoc.
- Giai phap:
  + Fix scripts/gen-sea-assets.mjs walk() de quy dung join(base,name) cho thu muc con -> assets dung key roles/ va formats/ (22 assets, 18 prompts).
  + server.ts: them earlySeaGetAsset ngay dau file (createRequire node:sea truoc loadPrompt), loadPrompt uu tien 1) SEA getAsset('src/prompts/'+name) -> Buffer, 2) filesystem candidates; bot file dung lai earlySeaGetAsset tranh log trung.
  + Giu SERVER_PROJECT_ROOT/storage resolve dung CWD cho thu muc moi (fresh install tao data/.opencode tai cho), dong thoi nhung prompt dam bao chuc nang goc khong mat.
  + Rebuild: build-sea-bundle + gen-sea-assets (22 assets) + postject -> release/agentforge-web.exe 94.79MB; test copy 1 file sang test-agentforge thoi (xoa data/.opencode truoc) -> chay warnings=0, SSoT Synced 11 agents, sinh .opencode/agents tai CWD moi, data tao moi tai CWD, src prompt day du.

## 2026-08-26 - Fix SPAWN im lang that bai + bao loi nguoc ve Orcha
- Van de: Orcha o thu muc test in [SPAWN role=researcher name=demo ...] trong phan tu noi/reasoning nhung khong co agent nao duoc tao, cung khong bat ky bao loi nao; user phai cho rat lau ma UI van hien tag SPAWN (vi broadcastOACEvent phat ca thinking stream).
- Nguyen nhan: handleOrchestratorResponse chi parseSpawnTags tren result.content (final text cua opencode). Khi tag nam trong thinking/reasoning thi spawns=[] va code di tiep im lang; parseAgentCommands cung chua try/catch.
- Giai phap:
  + Them tham extraScanText cho handleOrchestratorResponse; 3 call site (dispatchUserChat L3138, trigger queue, synthesize) deu truyen result.thinking.
  + Neu /SPAWN/ co trong scanText nhung parse ra 0 -> broadcast system error [ERROR] huong dan dinh dang ve cho Orcha + user (khong con im lang).
  + parseAgentCommands boc try/catch de loi parse khong lam rot spawn.
  + Rebuild: npm run build PASS, sea bundle 22 assets, postject PASS 94.79MB 15:58, da copy exe moi sang test-agentforge thoi.

## 2026-08-26 - Lenient fallback cho [SPAWN] bi meo format (diagnostic da bat duoc)
- Van de: SpawnParse context log cho thay model viet task dai chua ngoac kep duong dan Windows ("C:\Users\...") va kha nang output bi cat truoc dong ] — balanced-bracket extractor tra ve null -> 0 spawn, day la lan thu 2 SPAWN roi vao im lang.
- Nguyen nhan: extractBracketCommands dem ngoac can bang + trang thai quote; task chua ky tu dac biet hoac khong co dong ] thi that bai, trong khi regex don gian van xu ly duoc.
- Giai phap:
  + parseSpawnTags them lenient fallback: khi balanced fail nhung text chua [SPAWN -> lay tu '[SPAWN' den ']' dau tien ([^\]]*) hoac den het dong; log canh bao dung fallback.
  + Rebuild toan bo: tsc/vite PASS, sea bundle 22 assets, postject PASS 94.79MB 16:17, deploy ca release/ va test-agentforge thoi.

## 2026-08-26 - Queue animation + SPAWN lenient da deploy
- Queue UI: App.tsx them queuedMessages state + sendQueuedMessage + useEffect drain khi loading false; ChatPanel them prop queuedMessages + queue bar tren khung typing (⏳ Queued N, collapse 2-3 tin vao 1 khung nho, animation af-queue-slide, tu bien mat khi den luot gui len khung chat).
- SPAWN parse: lenient fallback da co tu 16:17 nhung exe dang chay o test folder van la ban cu (log 09:21Z scout van 0) — da rebuild 16:xx va copy lai exe moi cho test folder; can restart exe de nhan fix.

## 2026-08-26 (quan trong) — Root cause SPAWN khong bao gio parse duoc: regex tag nuot chu 'role'
- Van de: Moi lenh [SPAWN role=x ...] deu bi im lang — SpawnParse bao khong parse duoc role/name/task ke ca khi tag chuan, co dong ].
- Nguyen nhan goc: server.ts L1486 extractBracketCommand dung /^([A-Z_]+(?:\s+[A_Z_]+)*)/i — co /i lam nhom thu 2 nuot ca chu 'role' thuong -> tag='SPAWN role', content bi cat mat 'role=' -> roleMatch null -> skip cmd. TALK van song vi '-id=' con sot lai.
- Giai phap: bo /i, tu thu 2 chi nhan tu ALL-CAPS (giu duoc CREATE ROLE/STOP AGENT/RESUME AGENT). Test 5 case (scout2/probe/createRole/stopAgent/talk) deu pass voi ban sao chep dung ham that; rebuild toan bo + deploy release va test folder.

## 2026-08-26 — Fix crash parseTalkTag 'Cannot read properties of undefined (reading toLowerCase)' sau permission deny

### Van de
- Luc 18:28:28 sau khi agent explore goi tool read bi tu choi boi permission config, UI hien 'System Error', agent roi vao status error, outbox ghi lastError = 'Cannot read properties of undefined (reading toLowerCase')' voi attempts = 5 (ORCH_MAX_RETRY).
- Cac bao cao worker -> orchestrator bi retry 5 lan deu loi, Orchestrator khong nhan duoc report, he thong dung o trang thai loi.

### Nguyen nhan
- src/server.ts dong 1670-1678 ham parseTalkTag(): regex /\b(?:message|msg|content|task)\s*=\s*/gi chi dung non-capturing group (?:...), nen pm[1] luon la undefined; dong 1678 goi pm[1].toLowerCase() no TypeError moi khi Orchestrator tra ve tag [TALK agent-id=... message=..] chua message=/task=/content=/msg=.
- Day la regression so voi ban .bak_chatqueue L1501 von dung msgMatch[0] an toan. Phan evaluate permission khong phai nguyen nhan (toan bo .toLowerCase() o duong permission da co guard String()/||'').

### Giai phap sua doi
- File: src/server.ts L1670: doi regex sang capturing group /\b(message|msg|content|task)\s*=\s*/gi de pm[1] co gia tri keyword.
- File: src/server.ts L1678: doi pm[1].toLowerCase() sang (pm[1] ?? '').toLowerCase() phong ve kep, tranh crash neu regex bi sua sai trong tuong lai.
- Rebuild: npm run build (tsc + vite) thanh cong; dist/server.js L1629/L1638 da dong bo fix. Can rebuild SEA exe (npm run build:exe) de cap nhat binary dang chay tai C:\Users\Hai Dang\test-agentforge thoi\agentforge-web.exe.
- Regression risk: low, chi thay cach lay keyword, khong doi logic routing.

## 2026-08-26 (bo sung) — Fix strip tag [..] nuot noi dung trong backtick code-span

### Van de
- UI hien "Phải dùng ` để khởi động lại tiến trình." trong khi tin goc la "Phải dùng `[RESUME AGENT target-id=...]` để khởi động..." — chuoi [..] trong backtick bi strip trang, chi con 2 backtick rong.
- Orchestrator viet van ban tai lieu chua mau "[SPAWN role=... task=... co dau ]" ben trong TALK -> bo do tag quet nguyen output, bat nham lenh that, bao loi "[SPAWN] khong doc duoc role/name/task" lap 2 lan.
- Bao cao worker chua doan code/regex co [..] cung co the bi cat sai noi dung khi qua pipeline strip.

### Nguyen nhan
- extractBracketCommands() tim tag bang text.indexOf("[TAG") tho so, khong kiem tra vi tri match co nam trong inline code-span ... hay fenced code block ` ` `; extractBracketCommand() chi xu ly backtick nhu quote trong nhanh fallback Balanced Bracket.
- stripCommandTags() sau do replace /[(?:TALK|SPAWN|CREATE ROLE|STOP|RESUME)[^\]]*]?/gi tren toan bo text khong loai tru vung code-span nen nuot ca noi dung nguoi dung.

### Giai phap sua doi
- File: src/server.ts — them ham getCodeSpanRanges(text): scan tuan tu luu interval cua moi inline ... va fenced `...`; them isInCodeSpan(idx, ranges).
- File: src/server.ts — extractBracketCommands(): sau khi tim idx phai qua 2 dieu kien boundary + !isInCodeSpan(idx) moi chap nhan; neu match nam trong code-span thi tiep tuc tim vi tri ke tiep (searchFrom = idx+1), hanh vi voi tag that ngoai code giu nguyen 100%.
- File: src/server.ts — stripCommandTags(): buoc replace cuoi chi chay tren cac segment NGOAI code-span; doan trong code-span duoc giu nguyen bang cach rebuild chuoi theo interval.
- Self-test repro 4 case PASS: tag trong backtick giu nguyen; tag thuong ngoai backtick van strip; fenced block chua SPAWN giu nguyen; mixed chi strip tag that. npx tsc --noEmit exit 0; npm run build PASS. dist/server.js dong bo (getCodeSpanRanges L1559, isInCodeSpan L1585, wire L1600/L1614/L1660). Backup truoc sua: src/server.ts.bak_strip_20260826. KHONG build:exe de user swap sau.
