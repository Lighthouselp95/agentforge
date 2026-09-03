# CHANGELOG - Startup Manager

## Phiên bản nâng cấp: Windows Task Scheduler & CRUD Parameter Safety (2026-09-03)

### 1. Nâng cấp toàn diện Module Windows Task Scheduler (`ScheduleDialog` & `TaskSchedulerManager`)
- **Hỗ trợ 5 loại Triggers:**
  - `logon`: Khởi chạy khi người dùng đăng nhập Windows (`<LogonTrigger>`).
  - `boot`: Khởi chạy khi máy tính khởi động (`<BootTrigger>`).
  - `daily`: Khởi chạy theo giờ cố định hàng ngày (`<CalendarTrigger>` + Daily interval).
  - `weekly`: Khởi chạy định kỳ theo các ngày trong tuần (`<CalendarTrigger>` + DaysOfWeek chuẩn XML Schema: `<Monday/>`, `<Tuesday/>`, `<Wednesday/>`, `<Thursday/>`, `<Friday/>`, `<Saturday/>`, `<Sunday/>`).
  - `idle`: Khởi chạy khi máy tính ở trạng thái rảnh rỗi (`<IdleTrigger>` + `<IdleSettings>` + `<RunOnlyIfIdle>true</RunOnlyIfIdle>`).
- **Chế độ Chỉnh sửa Task Scheduler (Edit Task):**
  - Bổ sung `TaskSchedulerManager.get_task_info(name)` phân tích cú pháp XML và `schtasks` để nạp ngược lại các thông số cũ của Task (chương trình, đối số, loại trigger, thời gian delay, giờ chạy, quyền Admin) vào `ScheduleDialog` khi người dùng nhấn Sửa.
  - Bổ sung hàm `_parse_iso_duration` chuyển đổi định dạng chuẩn ISO (PT30S, PT5M, PT1H...) thành số giây trực quan trên giao diện.
- **Quyền Quản trị Cao nhất (Run As Highest Privileges):**
  - Thiết lập thẻ XML `<RunLevel>HighestAvailable</RunLevel>` cho phép chạy ứng dụng với quyền Admin tự động qua Task Scheduler mà không bị chặn UAC popup.
- **Phím tắt tiện ích:**
  - Bổ sung `TaskSchedulerManager.open_taskschd()` cho phép mở nhanh trình quản lý gốc Windows Task Scheduler (`taskschd.msc`).

### 2. Chuẩn hóa Tham số & Chống xung đột (Validation & Atomic Transactions)
- **Validation tên mục (`validate_item_name`):** Lọc bỏ ký tự cấm của Windows (`\ / * ? " < > | :`), chặn dấu chấm/khoảng trắng cuối tên và danh sách tên thiết bị bảo lưu DOS (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
- **Chuẩn hóa Command (`split_command`, `normalize_command`):** Tự động bọc nháy kép (`"..."`) cho đường dẫn có khoảng trắng, tách bạch giữa đường dẫn tệp thực thi và tham số đối số.
- **Atomic Edit:** Luồng chỉnh sửa ghi mới thành công vào hệ thống trước, chỉ xóa mục cũ khi mục mới đã ghi hợp lệ; nếu có lỗi xảy ra sẽ tự động rollback bảo toàn nguyên vẹn mục cũ.
- **Atomic JSON Save (`atomic_save_json`):** Sử dụng file `.tmp`, `flush()`, `os.fsync()` và `os.replace()` để lưu `startup_config.json` và tệp export an toàn, chống hỏng tệp khi mất điện hoặc tắt ứng dụng đột ngột.

### 3. Kết quả Kiểm thử & Nghiệm thu Thực tế
- `python -m py_compile`: Hoàn toàn sạch lỗi cú pháp (Exit code 0).
- Thực nghiệm tạo/xóa task thực tế trên Windows (`StartupManager\TestIdleTask`): Thành công 100%.
- Suite 16/16 Unit Tests tự động trên đĩa: PASSED 100%.

## Nâng cấp Trải nghiệm Tạo Mới Schedule & Điều hướng Toàn diện (Add New Schedule Feature) (2026-09-04)

### 1. Độc lập hóa & Bổ sung Chức năng "Thêm Lịch Trình Mới" (Add New Schedule)
- **Nút bấm Toolbar:** Bổ sung nút `➕ Thêm Lịch Trình` trực quan ngay cạnh nút `➕ Thêm`, cho phép mở thẳng form tạo Task Scheduler độc lập mà không yêu cầu chọn dòng nào trước.
- **Menu Bar (`Sửa` & `Xem`):** Bổ sung mục `Thêm Lịch Trình Mới (Ctrl+Shift+N)` trong menu `Sửa` và `➕ Thêm Lịch Trình Task Scheduler...` trong menu `Xem`.
- **Context Menu (Chuột phải):** Luôn hiển thị lựa chọn `➕ Thêm Lịch Trình Mới (Task Scheduler)...` ngay cả khi click chuột phải vào vùng trống (chưa chọn mục).
- **Phím tắt toàn cục:** Bổ sung tổ hợp phím `Ctrl+Shift+N` và `Ctrl+Shift+T` để mở nhanh hộp thoại tạo mới lịch trình.
- **Cơ chế Fallback thông minh (`schedule_item`):** Khi người dùng nhấn nút `📅 Lịch trình` hoặc phím `Ctrl+T` mà chưa chọn bất kỳ dòng nào, thay vì chặn cảnh báo, chương trình tự động chuyển sang chế độ tạo mới (`item=None`).

### 2. Nâng cấp `ScheduleDialog` ở chế độ Tạo Mới (`item=None`)
- Khởi tạo form trống, tiêu đề rõ ràng: `Tạo Lịch Trình Task Scheduler Mới`.
- Cho phép nhập tên tác vụ, duyệt chọn file thực thi (`.exe`, `.bat`, `.cmd`, `.ps1`, `.vbs`...) với tính năng tự động gợi ý tên tác vụ từ tên tệp.
- Hỗ trợ truyền tham số khởi tạo `initial_name` và `initial_command` từ các dialog khác chuyển sang mà không mất dữ liệu đã nhập.
- Khung xem trước cấu hình (Live Preview Panel) tự động hiển thị trạng thái chuẩn xác khi chưa chọn file chương trình.

### 3. Cầu nối Thông minh trong `AddEditDialog` (Switch to ScheduleDialog)
- Khi người dùng chọn radio button `Task Scheduler (Lên lịch)` trong `AddEditDialog`, giao diện tự động kích hoạt khung hướng dẫn màu nổi bật với nút bấm: `📅 Chuyển sang Cấu hình Lịch Trình (Schedule Dialog) ➔`.
- Khi bấm nút chuyển đổi, toàn bộ thông tin `Tên` và `Lệnh/Đường dẫn` đã nhập sẽ được chuyển tiếp trọn vẹn sang `ScheduleDialog`.
- Khi người dùng nhấn `Lưu` trực tiếp khi đang chọn Task Scheduler, hệ thống sẽ mở hộp thoại hỏi người dùng có muốn mở cấu hình chi tiết nâng cao hay lưu nhanh với cấu hình đăng nhập mặc định.

### 4. Kiểm thử & Đảm bảo Chất lượng
- Kiểm tra biên dịch mã nguồn `python -m py_compile`: Exit code 0 (thành công tuyệt đối).
- Bộ test tự động kiểm chứng 4 ca kiểm thử: Khởi tạo chế độ Add (`item=None`), nạp tham số ban đầu, chuyển đổi từ `AddEditDialog` và xác thực toàn vẹn các phương thức GUI.
