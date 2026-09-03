# CHANGELOG - Team Isolation & Orchestrator UI Normalization

## Cải tổ Kiến trúc Độc lập Đa Team & Chuẩn hóa Giao diện (2026-09-03)

### 1. Phía Frontend (`web/src/components/ChatPanel.tsx` & `web/src/App.tsx`)
- **Phổ quát hóa nhận diện Orchestrator (`isOrchestrator`):**
  - Loại bỏ hoàn toàn việc hardcode `msg.from === 'orchestrator'`.
  - Giờ đây kiểm tra toàn diện qua `msg.from === 'orchestrator' || agents.some(a => a.id === msg.from && (a.role === 'orchestrator' || a.type === 'orchestrator')) || msg.agentRole === 'orchestrator'`.
  - Mọi Orchestrator (Team 1, Team 2, Team N) đều được kế thừa 100% style cao cấp: màu senderColor `#a5b4fc`, badge `main`, vương miện 👑, và khối hiển thị Task Card riêng biệt.
- **Chuẩn hóa màn hình Main cho từng Team (`App.tsx`):**
  - Nhánh `isSubOrch` được nâng cấp đồng bộ với Main View: lọc chặt chẽ theo `orchTeamId`, hiển thị các khối lệnh điều phối Task riêng biệt, ẩn tin nội bộ system và snapshot opencode của worker khác team.

### 2. Phía Backend (`src/server.ts`)
- **Cô lập Hàng đợi Tin chưa đọc (`unreadForOrchestrator`):**
  - Chuyển đổi từ mảng toàn cục `ChatMsg[]` sang cấu trúc `Map<string, ChatMsg[]>` theo từng Orchestrator/Team ID.
  - Bổ sung hàm `resolveOrchIdForMsg` tự động tìm Orchestrator chủ quản thông qua `msg.to`, `spawnedBy`, hoặc `teamId`.
  - Ngăn chặn hoàn toàn việc Main Orchestrator nuốt mất tin của Sub-Orchestrator hoặc Sub-Orchestrator bị rò rỉ tin của Main.
- **Định tuyến động các thông báo lỗi & forward tin hệ thống (`forwardToOrchestrator`):**
  - Hỗ trợ truyền `targetOrchId` và `teamId`, đảm bảo các tin nhắn lỗi turn đầu (dòng 1547, 3671, 3794, 3916...) và lỗi hạn mức role chỉ gửi về đúng Orchestrator phụ trách team đó.

### 3. Kết quả Kiểm thử & Nghiệm thu
- Frontend: `npm run build` trong thư mục `web` đạt kết quả thành công 100%, sạch lỗi TypeScript.
- Backend: Cú pháp và luồng định tuyến được kiểm tra đối chiếu trực tiếp trên đĩa cứng.
