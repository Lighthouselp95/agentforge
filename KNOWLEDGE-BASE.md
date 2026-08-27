# AgentForge — Knowledge Base & Troubleshooting Runbook

Tài liệu tổng hợp các phát hiện, lỗi đã sửa và lưu ý vận hành đáng quý xuyên suốt quá trình phát triển AgentForge. Mục tiêu: làm tài liệu tham chiếu nhanh (topical) thay vì nhật ký theo ngày (xem `CHANGELOG.md` để biết trình tự thay đổi).

## 1. OpenCode CLI — Hành vi cốt lõi (QUAN TRỌNG NHẤT)
- **Headless vs TUI**: Khi chạy `opencode run --auto --format json`, mọi chuỗi truyền qua STDIN/argv được xem là **User Prompt** gửi cho LLM, KHÔNG phải lệnh quản trị.
- **Slash command phải dùng cờ `--command`**: Để thực thi lệnh quản trị (ví dụ `/compact`), bắt buộc gọi:
  `opencode run --command "compact" --session "<sessionId>" --auto --format json`
  Nếu chỉ truyền `/compact` như prompt thường, LLM sẽ trả lời giải thích thay vì nén session.
- **Schema event JSONL**:
  + Event báo cáo token có `type: "step-finish"` (dấu gạch nối `-`), KHÔNG phải `step_finish`.
  + Object token nằm ở **root** của event: `ev.tokens.{total,input,output,reasoning,cache:{read,write}}` hoặc `ev.info.tokens`, KHÔNG nằm trong `ev.part.tokens`.
  + Trường `cost` nằm ở root `ev.cost`.

## 2. Chống nghẽn luồng truyền tin (Anti-Block Patterns)
- **Tuyệt đối không chặn tin nhắn vĩnh viễn**: Mọi bộ lọc deduplication (hash) PHẢI có TTL (3-5s). Nếu lưu hash vĩnh viễn, các báo cáo trùng format ở lượt sau sẽ bị `continue;` drop hoàn toàn (mất cả lưu chat, broadcast và trigger Orchestrator).
- **Hàng đợi trigger phải tự reschedule**: Khi Orchestrator đang bận (`client.isBusy()`), `processOrchestratorTriggerQueue` PHẢI `setTimeout(..., 1000)` thay vì `return` bỏ rơi `pendingOrchTriggers`.
- **Fallback tự động Worker → Orchestrator**: Mọi output kết thúc lượt của Specialist Worker (dù có hay không có thẻ `[TALK]`) đều phải tự động chuyển tiếp vào `triggerOrchestrator()`. Không để tin nhắn chỉ hiển thị trên UI mà không kích hoạt turn Orchestrator.

## 3. Quản lý Session & Cờ Busy
- **Giải phóng cờ `busy` trong `finally`**: Toàn bộ logic đặt `this.busy = true` trong `runQueued` PHẢI có khối `finally { this.busy = false; xả hàng đợi pending }`. Nếu thiếu, lệnh mất nhiều thời gian (như `/compact` 5-15s) sẽ kẹt cờ, chặn toàn bộ tin nhắn tiếp theo của agent.
- **Reset session chỉ khi thực sự hết hạn**: Chỉ reset `sessionId` khi OpenCode báo HTTP 404 hoặc `Session not found/expired`. KHÔNG reset khi output chứa chữ `error`/`failed` hay tool error thông thường — điều này gây mất ngữ cảnh liên tục.

## 4. Mã hóa UTF-8 (Windows)
- PowerShell 5.1 mặc định `$OutputEncoding` là ASCII → rụng dấu tiếng Việt khi pipe stdin vào OpenCode CLI.
- Khắc phục trong `acp-client.ts`: thiết lập `$OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.Encoding]::UTF8` và `chcp 65001 >nul` trong `start.bat`.

## 5. Parser an toàn
- Dùng **Balanced Bracket State Machine** (theo dõi depth, quotes, backticks) thay vì regex non-greedy để bóc tách thẻ lệnh `[TALK]`, `[SPAWN]`. Regex non-greedy dừng sớm ở ngoặc đầu tiên trong nội dung, gây rò rỉ đuôi lệnh ra UI.

## 6. Đóng gói Desktop (Electron)
- Xem chi tiết trong `electron/README.md`. Tóm tắt nhanh:
  + Bundle binary `opencode.exe` qua `extraResources`, gọi bằng `process.resourcesPath`.
  + Trỏ data JSON state sang `app.getPath('userData')` (portable giải nén vào `%TEMP%` mỗi lần).
  + `/restart` dùng `app.relaunch()` qua IPC, vô hiệu hóa `start.bat`.

## 7. Quy tắc ghi chép (Documentation)
- Orchestrator bị giới hạn quyền ghi → ủy quyền worker `docs`/`coder` thực hiện ghi file `.md`.
- Có file thì append/edit; chưa có thì tự tạo `.md` mới; tính năng/dự án mới thì tạo `README.md` hướng dẫn.
- Không dùng chữ in đậm trong markdown; ghi khoa học, có tiêu đề rõ ràng.

## 8. Chèn ngữ cảnh team ([TEAM UPDATE]) — chẩn đoán vòng lặp và giải pháp chuẩn

### Lý thuyết
Ngữ cảnh đội ngũ (team context) là khối văn bản hệ thống mô tả danh sách agent đang hoạt động kèm ID, tên, vai trò, trạng thái và nhiệm vụ. Orchestrator cần khối này để ra lệnh [TALK] hoặc [SPAWN] đúng định danh. Việc chèn ngữ cảnh vào prompt phải cân bằng hai nhu cầu trái ngược: Orchestrator luôn nhìn thấy thành phần team mới nhất, và lịch sử hội thoại CLI không bị phình to bởi một khối văn bản tĩnh lặp đi lặp lại ở mọi lượt. Vì OpenCode CLI giữ nguyên toàn bộ nội dung turn trước trong phiên, mỗi lần chèn thừa đều làm tăng token đầu vào vĩnh viễn cho phiên đó.

### Chuỗi sự kiện đã xác minh qua lịch sử dự án
- Ban đầu luồng dispatch chèn buildTeamContext vô điều kiện vào mọi turn chat routine, gây rác hệ thống ([TEAM UPDATE], Members, Your ID/role) trên cả giao diện người dùng lẫn prompt agent.
- Đã từng sửa bằng cách cắt bỏ toàn bộ khối này khỏi tin nhắn TALK và chat routine.
- Sau đó cơ chế được tái đưa trở lại dưới dạng có điều kiện: hàm shouldIncludeTeamContext dựa trên biến đếm globalTeamVersion tại khu vực handleOrchestratorResponse trong src/server.ts (khoảng dòng 2120 đến 2129).
- Điểm yếu của điều kiện hiện tại: biến đếm version tăng lên khi agent thay đổi bất kỳ trạng thái nào (working, idle, stopped), không phân biệt thay đổi thành viên thực sự. Mỗi lần một agent hoàn tất lượt chạy và rơi về idle là một lần version tăng, khiến khối ngữ cảnh được chèn trở lại ở lượt kế tiếp. Kết quả quan sát được: người dùng nhận khối [TEAM UPDATE] liên tục dù team không đổi thành viên.
- Yếu tố khuếch đại: bộ lọc chống trùng lặp đã bị gỡ bỏ hoàn toàn để chữa lỗi nghẽn tin nhắn worker sang Orchestrator, nên không còn cơ chế nào chặn việc phát lại khối ngữ cảnh.

### Giải pháp chuẩn khi vá src/server.ts
1. Tách biến đếm thành hai loại: membershipVersion chỉ tăng khi SPAWN hoặc DELETE agent hoặc gán nhiệm vụ mới; thay đổi trạng thái thông thường (idle, working, stopped, error) tuyệt đối không tăng biến này.
2. Bổ sung bản đồ lastTeamVersionDelivered theo từng phiên Orchestrator: chỉ chèn khối [TEAM UPDATE] khi membershipVersion lớn hơn mốc đã giao cho phiên đó; sau khi chèn thì cập nhật mốc bằng với version hiện tại.
3. Khối [TEAM UPDATE] chỉ được nối vào prompt gửi CLI, không được phát qua WebSocket như tin nhắn chat, không được lưu vào lịch sử chat hiển thị trên giao diện, và không được tính là hoạt động mới kích hoạt thêm lượt Orchestrator (tránh tự sinh vòng lặp tự tham chiếu).
4. Trường hợp phiên Orchestrator mới tạo hoặc vừa reset thì luôn chèn một lần bất kể version, để đảm bảo ngữ cảnh ban đầu đầy đủ.
5. Sau khi vá, kiểm chứng bằng test-buildteam.cjs và test-no-dedupe-filter.cjs cùng npm run build pass toàn bộ.

### Bài học tổng quát
Context injection dạng snapshot cho LLM phải bám theo sự kiện cấu trúc (thành viên thêm bớt, nhiệm vụ mới được gán) chứ không bám theo sự kiện trạng thái thoáng qua (chuyển busy hay idle). Nếu bám trạng thái, hệ thống sẽ spam ngữ cảnh và phình token đầu vào ở mọi lượt mà không mang lại thông tin mới.

## 9. Vòng đời Session của lệnh opencode run
- Mô hình one-shot: mỗi lượt chat spawn một tiến trình mới, nhận JSONL rồi thoát; session nằm trên đĩa thuộc quyền quản lý của opencode server nên sống độc lập với tiến trình AgentForge.
- Cờ --session quyết định tính liên tục: có --session ses_xxx thì lượt sau nhìn thấy toàn bộ lịch sử lượt trước (context tích lũy dần); thiếu cờ này thì mỗi lần chạy tạo session mới hoàn toàn độc lập.
- Chuỗi event trong một lượt: step_start, tool_use (kèm state.input/output), text, step_finish (reason là stop khi hết lượt hoặc tool-calls để tiếp vòng tool), error. Lượt chỉ kết thúc thật sự khi step_finish mang reason stop.
- Thao tác khả dụng: resume bất kỳ lúc nào bằng --session; ngắt giữa chừng bằng abort (an toàn vì session vẫn nằm trên đĩa); nén context bằng --command compact; fork và revert chỉ khả dụng khi chạy qua chế độ serve (REST).
- Ràng buộc đã kiểm chứng: không được gọi opencode run lồng nhau từ shell của một phiên opencode khác do biến môi trường OPENCODE_PID kế thừa gây lỗi; context dài cần định kỳ compact; chỉ reset sessionId khi lỗi HTTP 404 hoặc session not found/expired thật sự.

