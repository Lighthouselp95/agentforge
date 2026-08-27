# ANSI STANDARDS GUIDE — AgentForge Terminal Rendering

Tài liệu chuẩn hóa cách hệ thống xử lý mã ANSI escape từ output terminal của opencode (tool `bash`, `read`, v.v.) và cách chúng được tô màu trên Web UI.

## 1. Cấu trúc mã ANSI Escape

Một sequence ANSI đầy đủ có dạng:

```
ESC [ params terminator
VD:  \x1b[32m  (ESC = \u001b, params = 32, terminator = m)
```

- `\u001b` (ESC) hoặc `\u009b` (CSI) là byte khởi đầu.
- Params: các số cách nhau bởi `;` (mã SGR).
- Terminator phổ biến: `m` (SGR - màu/định dạng). Các terminator khác (`A` `B` `H` `J` `K`...) điều khiển con trỏ/màn hình → là RÁC với UI chat.

## 2. Chính sách xử lý 2 phía

### Server (`src/server.ts` — hàm `stripAnsi`)
- **GỠ**: mọi CSI điều khiển KHÔNG phải màu (cursor move, clear screen...).
- **GIỮ**: toàn bộ SGR kết thúc bằng `m` (`[32m`, `[1m`, `[0m`...) để frontend render màu.
- Áp dụng tại: `broadcastOACEvent` khi bóc tách `output` của tool_use/tool_result.

### Frontend (`web/src/components/ChatPanel.tsx`)
- `stripAnsi`: strip TOÀN BỘ (dùng cho input của tool khi cần parse JSON diff).
- `AnsiRenderer({ text })`: parse SGR còn lại → render `<span>` tô màu. Dùng cho:
  - Output trong `ToolCallBlock` (bash/read...)
  - Body text thường qua chuỗi render fallback

## 3. Bảng mã SGR → CSS (chuẩn AnsiRenderer)

| Code | Ý nghĩa | CSS áp dụng |
|------|---------|-------------|
| `0` | Reset toàn bộ | xóa style tích lũy |
| `1` | Bold | `fontWeight: bold` |
| `2` | Dim/faint | `opacity: 0.6` |
| `22` | Normal (bỏ bold/dim) | xóa fontWeight + opacity |
| `30` / `90` | Đen / Xám sáng | `color: #94a3b8` |
| `31` / `91` | Đỏ | `color: #f87171` |
| `32` / `92` | Xanh lá | `color: #4ade80` |
| `33` / `93` | Vàng | `color: #facc15` |
| `34` / `94` | Xanh dương | `color: #60a5fa` |
| `35` / `95` | Tím | `color: #c084fc` |
| `36` / `96` | Cyan | `color: #38bdf8` |
| `37` | Trắng ngà | `color: #e2e8f0` |
| `39` | Màu mặc định | xóa color |

Quy tắc tích lũy: style cộng dồn qua từng token SGR cho đến khi gặp `0` (reset) hoặc `22/39` (reset cục bộ).

## 4. Vị trí áp dụng trong UI

| Khối | Component | Xử lý ANSI |
|------|-----------|------------|
| Tool bash/shell | `BashCommandViewer` | `$ command` cyan + output qua `AnsiRenderer` (giữ màu) |
| Tool read | `ReadFileViewer` | stripAnsi trước parse; code hiển thị sạch |
| Tool edit | Diff View (`DiffLine`) | không áp ANSI (nội dung đã sạch) |
| Tool khác | `ToolCallBlock` body | `AnsiRenderer` trên toàn khối content |

## 5. Lưu ý vận hành

- Output terminal Vite/tsc hay phát `[2m` `[32m` kèm ESC thật → sau server-strip chỉ còn `[2m` `[32m` trần; `AnsiRenderer` vẫn match được nhờ pattern chấp nhận `[` không cần ESC.
- Chuỗi JSON parse cho Diff View phải dùng bản đã full-strip (`safeInput`) — ESC làm `JSON.parse` fail.
- Khi thêm tool viewer mới: ưu tiên truyền raw output vào `AnsiRenderer`; chỉ dùng `stripAnsi` khi nội dung cần máy đọc (parse/so sánh).
