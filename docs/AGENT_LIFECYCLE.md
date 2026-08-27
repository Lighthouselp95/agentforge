# Kiến trúc Vòng đời Agent (Agent Lifecycle & Injection Protocol)

Tài liệu này mô tả chi tiết cơ chế quản lý vòng đời của worker agent, luồng ngắt tiến trình (Stop / Abort), bản chất của tin nhắn hệ thống `[STOPPED]` và cơ chế đồng bộ trạng thái trong AgentForge.

---

## 1. Lý thuyết & Bản chất của Tin nhắn `[STOPPED]`

### Bản chất kỹ thuật
- Tin nhắn `[STOPPED] Agent was stopped by user / orchestrator` **KHÔNG PHẢI** là nội dung do mô hình AI (LLM) tự sinh ra trong hội thoại.
- Đây là một **System Injection Message (Synthetic Sentinel Message)** được sinh ra trực tiếp bởi lớp điều khiển backend (`acp-client.ts` và `server.ts`) khi tiến trình con của worker agent bị hủy ngang (`abort` / `taskkill`).

### Luồng phát sinh
1. Khi User nhấn nút dừng trên giao diện hoặc Orchestrator phát lệnh `[STOP AGENT target-id=<id>]`.
2. Hệ thống gọi phương thức `client.abort()`, gửi tín hiệu hủy (`AbortController`) và lập tức kết liễu cây tiến trình con (`taskkill /pid <PID> /T /F` trên Windows hoặc `SIGKILL` trên Unix).
3. Khối `try ... catch` trong `chatWithRetry` của `acp-client.ts` bắt được trạng thái `this._aborted === true`.
4. Hệ thống chặn đứng toàn bộ cơ chế retry/backoff, ngay lập tức đóng gói và trả về payload giả lập:
   ```json
   {
     "id": "<uuid>",
     "from": "<agent-id>",
     "to": "orchestrator",
     "content": "[STOPPED] Agent was stopped by user.",
     "timestamp": 1724734800000
   }
   ```

---

## 2. Vị trí Mã nguồn Thực thi trong Codebase

Toàn bộ logic vận hành vòng đời và xử lý ngắt tiến trình tập trung tại 2 file chính:

### `src/server.ts`
- **Hàm `stopAgent(id: string): boolean`** (dòng ~804):
  + Kiểm tra agent trong bộ nhớ; nếu tồn tại và chưa ở trạng thái `stopped`, lấy `client` tương ứng trong `clients` map.
  + Kích hoạt `client.abort()` để hủy tiến trình thực thi.
  + Đổi trạng thái `a.status = 'stopped'`, reset `a.workingSince = undefined`.
  + Xóa client khỏi bộ nhớ (`clients.delete(a.id)`) và cập nhật xuống SQLite (`storage.updateAgent`).
  + Phát sóng WebSocket event `broadcast('agent:updated', { agent: a })` để cập nhật trạng thái UI sang màu xám/dừng.
- **Xử lý lệnh điều khiển Orchestrator** (dòng ~1100):
  + Bóc tách cú pháp `[STOP AGENT target-id=<agent-id>]` từ phản hồi của Orchestrator và gọi `stopAgent()`.
- **API Endpoint** (dòng ~2628):
  + Tuyến `POST /api/agents/:id/stop` phục vụ thao tác bấm nút dừng từ Web UI.

### `src/agents/acp-client.ts`
- **Phương thức `abort()`**:
  + Thiết lập cờ `this._aborted = true`.
  + Hủy `AbortController` (`this.abortController.abort()`).
  + Gọi `taskkill` triệt để theo PID tiến trình con đã lưu trong `activeChildPids`.
- **Xử lý ngắt trong `chatWithRetry()`** (dòng ~531):
  + Kiểm tra cờ `if (this._aborted)` và trả về cấu trúc tin nhắn `[STOPPED]`.

---

## 3. Mục đích Thiết kế Hệ thống

1. **Ngắt vòng chờ của Orchestrator (Unblock Orchestrator)**:
   - Khi một agent đang làm việc mà bị dừng, Orchestrator không bị treo trong hàng đợi chờ đợi kết quả (`pendingOrchTriggers`).
   - Tin nhắn `[STOPPED]` đóng vai trò là một sự kiện hoàn tất ngoại lệ, giúp Orchestrator nhận thức được agent đã dừng để chuyển giao nhiệm vụ hoặc phân công agent khác.

2. **Dọn dẹp triệt để tài nguyên HĐH (Resource Cleanup & Anti-Orphan)**:
   - Đảm bảo khi ngắt tác vụ, cây tiến trình con (`opencode.exe`, `node.exe`, CLI child processes) bị hủy sạch sẽ 100%, không chiếm dụng RAM, CPU hoặc giữ khóa file trên ổ đĩa.

3. **Đồng bộ hóa giao diện thời gian thực (Real-time GUI Sync)**:
   - Bắn event `agent:updated` qua WebSocket giúp Dashboard UI chuyển ngay badge trạng thái sang `stopped`, ngắt hiệu ứng quay vòng (spinner) và hiển thị thông báo rõ ràng trong khung chat.
