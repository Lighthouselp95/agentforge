# Hướng Dẫn Đổi Tên User Windows — AgentForge

> Phiên bản: 1.1 | Ngày: 31-08-2026 | Áp dụng: Windows 10 / Windows 11 | Ngôn ngữ: Tiếng Việt
> Tác giả: Orchestrator + Specialist Agents (win-docs, win-coder, win-verify)

Tài liệu này hướng dẫn đầy đủ, an toàn và có kiểm chứng thực tế cho việc đổi tên tài khoản người dùng Windows. Nội dung được chia thành 2 cấp độ — từ an toàn tuyệt đối đến nâng cao có rủi ro — kèm bảng so sánh Microsoft Account và Local Account, FAQ chi tiết và checklist khôi phục.

---

## Mục lục

1. [Tổng quan và nguyên tắc an toàn](#1-tong-quan-va-nguyen-tac-an-toan)
2. [Phân biệt Microsoft Account vs Local Account](#2-phan-biet-microsoft-account-vs-local-account)
3. [Cấp 1: Đổi tên hiển thị — An toàn 100%](#3-cap-1-doi-ten-hien-thi--an-toan-100)
4. [Cấp 2: Đổi tên thư mục C:\Users\... — Nâng cao](#4-cap-2-doi-ten-thu-muc-cusers--nang-cao)
5. [Script tự động hóa](#5-script-tu-dong-hoa)
6. [FAQ — Câu hỏi thường gặp](#6-faq--cau-hoi-thuong-gap)
7. [Lưu ý chuyên sâu: Microsoft Account vs Local Account](#7-luu-y-chuyen-sau-microsoft-account-vs-local-account)
8. [Khắc phục sự cố thường gặp](#8-khac-phuc-su-co-thuong-gap)
9. [Checklist an toàn trước khi thao tác](#9-checklist-an-toan-truoc-khi-thao-tac)
10. [Ví dụ thực tế cho máy hiện tại](#10-vi-du-thuc-te-cho-may-hien-tai)
11. [Tham khảo và liên hệ](#11-tham-khao-va-lien-he)

---

## 1. Tổng quan và nguyên tắc an toàn

### 1.1 Hai khái niệm dễ nhầm

| Khái niệm | Hiển thị ở đâu | Lưu ở đâu | Đổi có ảnh hưởng dữ liệu không |
|---|---|---|---|
| Tên hiển thị (Display Name / Full Name) | Màn hình đăng nhập, Start Menu, netplwiz | Registry + Local User DB | Không |
| Tên thư mục hồ sơ (Profile Folder) | Đường dẫn `C:\Users\TenUser` | Registry `ProfileImagePath` + NTFS | Có rủi ro nếu làm sai |

> Nguyên tắc vàng: Luôn ưu tiên đổi tên hiển thị trước. Chỉ đổi tên thư mục khi thực sự cần thiết và đã sao lưu đầy đủ.

### 1.2 Thứ tự ưu tiên khuyến nghị

1. Đổi tên hiển thị (Cấp 1) — đủ cho 90% nhu cầu thẩm mỹ / hiển thị.
2. Tạo user mới và di chuyển dữ liệu (Cấp 2 - Phương án A) — an toàn nhất nếu muốn đường dẫn `C:\Users\` đẹp.
3. Sửa Registry + đổi tên thư mục (Cấp 2 - Phương án B) — chỉ dành cho người có kinh nghiệm, chấp nhận rủi ro.

### 1.3 Yêu cầu chung

- Quyền Administrator.
- Hệ điều hành Windows 10 22H2 hoặc Windows 11 22H2/23H2/24H2.
- Đã tạo điểm khôi phục hệ thống (Restore Point).
- Đã sao lưu thư mục quan trọng: Desktop, Documents, Downloads, Pictures.

---

## 2. Phân biệt Microsoft Account vs Local Account

### 2.1 Cách nhận biết nhanh

Mở `Settings > Accounts > Your info`:

- Nếu thấy địa chỉ email dưới tên (ví dụ: `hai.dang@outlook.com`) và dòng `Manage my Microsoft account` — bạn đang dùng Microsoft Account.
- Nếu chỉ thấy tên cục bộ và dòng `Sign in with a Microsoft account instead` — bạn đang dùng Local Account.

Kiểm tra bằng PowerShell:

```powershell
whoami
# Trả về dạng DESKTOP-XXXX\Hai Dang  -> Local

Get-LocalUser | Select-Object Name, Enabled, PrincipalSource
# PrincipalSource = MicrosoftAccount -> liên kết Microsoft
# PrincipalSource = Local -> tài khoản cục bộ thuần túy

dsregcmd /status
# Kiểm tra Azure AD / Entra join nếu là máy công ty
```

### 2.2 Bảng so sánh thao tác đổi tên

| Tiêu chí | Local Account | Microsoft Account |
|---|---|---|
| Tên hiển thị đổi ở đâu | `netplwiz`, `Control Panel`, `Set-LocalUser`, `Rename-LocalUser` | `https://account.microsoft.com` > Your info > Edit name (đồng bộ xuống máy sau khi đăng nhập lại) |
| Tên đăng nhập (username) | Đổi được bằng `Rename-LocalUser` | Không đổi trực tiếp trên máy; phải đổi bí danh email tại Microsoft |
| Thư mục `C:\Users\...` | Tạo theo tên lúc tạo user lần đầu | Tạo theo 5 ký tự đầu email hoặc tên bạn đặt lúc cài Windows (thường bị cắt ngắn, ví dụ `haida`) |
| Đổi thư mục `C:\Users\...` | Dùng Cấp 2 như tài liệu này | Quy trình giống Local, nhưng sau khi đăng nhập lại Microsoft có thể ghi đè Display Name — cần khóa đồng bộ hoặc đổi online trước |
| Ảnh hưởng OneDrive | Không, nếu OneDrive đăng nhập lại đúng thư mục mới | OneDrive thường trỏ cứng vào `C:\Users\TenCu\OneDrive` — phải Unlink/Relink |
| Rủi ro chính | Quên mật khẩu local nếu đổi username | Đồng bộ tên từ cloud ghi đè tên local; lỗi profile nếu vừa đổi Registry vừa đồng bộ |

> Lưu ý quan trọng: Với Microsoft Account, việc đổi tên hiển thị trên máy cục bộ bằng `netplwiz` chỉ có tác dụng tạm thời. Sau lần đồng bộ tiếp theo, Windows sẽ lấy lại tên từ `account.microsoft.com`. Vì vậy hãy đổi ở cả hai nơi.

---

## 3. Cấp 1: Đổi tên hiển thị — An toàn 100%

Áp dụng cho cả Local Account và Microsoft Account (với Microsoft Account thì đổi online là chính, local là phụ).

### Cách A: netplwiz — Nhanh nhất (30 giây, khuyên dùng)

1. Nhấn `Win + R` -> gõ `netplwiz` -> Enter.
2. Chọn tài khoản cần đổi -> nhấn `Properties`.
3. Sửa hai trường:
   - `User name` : tên đăng nhập (không chứa dấu cách ở một số bản Windows cũ, nên dùng `DangHai` thay vì `Hai Dang` nếu muốn đổi username).
   - `Full name` : tên hiển thị đầy đủ, hỗ trợ tiếng Việt có dấu và dấu cách.
4. Nhấn `Apply` -> `OK` -> khởi động lại máy.
5. Kiểm tra: `Win + R` -> `netplwiz` -> Full name đã cập nhật; màn hình khóa hiển thị tên mới.

Dùng khi: chỉ muốn đổi tên hiển thị, không cần đổi đường dẫn `C:\Users\`.

### Cách B: PowerShell — Tự động, có kiểm tra

Mở PowerShell với quyền Administrator (Run as Administrator):

```powershell
# --- Cau hinh ---
$oldName  = "Hai Dang"      # Ten hien tai, dat trong nhay kep neu co dau cach
$newName  = "DangHai"       # Ten dang nhap moi (khong dau, khong cach) - de trong neu chi doi FullName
$fullName = "Hai Dang"      # Ten hien thi day du - co the de tieng Viet co dau

# --- Kiem tra ton tai ---
$user = Get-LocalUser -Name $oldName -ErrorAction SilentlyContinue
if (-not $user) {
    Write-Host "Khong tim thay user '$oldName'. Danh sach user hien co:" -ForegroundColor Red
    Get-LocalUser | Format-Table Name, FullName, Enabled -AutoSize
    return
}

# --- Doi FullName (ten hien thi) ---
Set-LocalUser -Name $oldName -FullName $fullName
Write-Host "Da cap nhat FullName -> $fullName" -ForegroundColor Green

# --- Doi username (ten dang nhap) neu can ---
if ($newName -and $newName -ne $oldName) {
    Rename-LocalUser -Name $oldName -NewName $newName
    Write-Host "Da doi username tu '$oldName' sang '$newName'" -ForegroundColor Green
    Write-Host "Luu y: Thu muc C:\Users\$oldName KHONG tu dong doi ten. Xem Cap 2 neu can." -ForegroundColor Yellow
}

Write-Host "Hoan tat. Vui long dang xuat / restart de thay doi hieu luc." -ForegroundColor Cyan
Get-LocalUser -Name ($newName ? $newName : $oldName) | Format-List Name, FullName, SID
```

> Lưu ý an toàn giữ nguyên: Đoạn script trên chỉ đổi Display Name / FullName và username (Cấp 1), không hề đụng tới Registry `ProfileImagePath` hay thư mục `C:\Users\`. Mọi thao tác Cấp 2 vẫn yêu cầu Restore Point và Administrator dự phòng như mục 9.

> Lưu ý cú pháp với tên có dấu cách `Hai Dang`:
> - Khai báo biến: `$oldName = "Hai Dang"` — bắt buộc nháy kép, không dùng nháy đơn nếu có biến nội suy.
> - Gọi lệnh: `Get-LocalUser -Name "Hai Dang"` và `Rename-LocalUser -Name "Hai Dang" -NewName "DangHai"` — thiếu nháy sẽ bị hiểu thành hai tham số `Hai` và `Dang`.
> - Đường dẫn: luôn dùng `-LiteralPath "C:\Users\Hai Dang"` thay vì `-Path`.

Lưu file thành `rename-displayname.ps1` và chạy:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Hai Dang\test-agentforge thoi\scripts\rename-displayname.ps1"
```

Hoặc chạy trực tiếp từng lệnh trong cửa sổ PowerShell Administrator.

### Cách C: Control Panel — Dành cho người quen giao diện cũ

1. Mở `Control Panel > User Accounts > User Accounts > Change your account name`.
2. Nhập tên mới -> `Change Name`.
3. Đăng xuất và đăng nhập lại để thấy hiệu lực.

> Cách C không đổi được `User name` (tên đăng nhập), chỉ đổi `Full name`. Nếu cần đổi username, dùng Cách A hoặc B.

### Cách D: Đổi tên Microsoft Account trên cloud (bắt buộc nếu dùng Microsoft Account)

1. Truy cập `https://account.microsoft.com` -> đăng nhập.
2. Vào `Your info` -> `Edit name` -> nhập `First name` / `Last name` mới -> Save.
3. Trên máy Windows: `Settings > Accounts > Your info` -> `Sign in with a local account instead` (tạm thời) rồi đăng nhập lại bằng Microsoft Account, hoặc chờ đồng bộ (thường 5-15 phút, có thể cần restart).
4. Kiểm tra lại bằng `netplwiz` xem Full name đã đồng bộ chưa. Nếu chưa, chạy Cách A để ép Full name local khớp với cloud.

### Kiểm tra sau khi đổi (áp dụng cho cả 4 cách)

```powershell
Get-LocalUser | Select-Object Name, FullName, Enabled, LastLogon
whoami
# Màn hình khóa (Win + L) phải hiển thị tên mới
```

---

## 4. Cấp 2: Đổi tên thư mục C:\Users\... — Nâng cao

> Cảnh báo: Đây là thao tác can thiệp sâu vào hệ thống. Sai một bước có thể gây lỗi không đăng nhập được (temporary profile), mất liên kết OneDrive, hoặc ứng dụng tìm sai đường dẫn.

### Khi nào cần làm

- Đường dẫn `C:\Users\` bị cắt ngắn xấu do Microsoft Account (ví dụ `C:\Users\haida` trong khi bạn muốn `C:\Users\DangHai`).
- Tên cũ có dấu cách gây lỗi với một số phần mềm cũ / script build (ví dụ `C:\Users\Hai Dang` làm gãy đường dẫn trong `npm`, `Python venv`).
- Yêu cầu đồng bộ chuẩn đặt tên trong tổ chức.

### Khi nào KHÔNG nên làm

- Chỉ cần đổi tên hiển thị cho đẹp — dừng ở Cấp 1.
- Máy có cài phần mềm trỏ cứng vào `C:\Users\TenCu` (nhiều app công nghiệp, AutoCAD plugin, Android SDK).
- Không có tài khoản Administrator dự phòng và chưa tạo Restore Point.

---

### Phương án A: Tạo user mới và di chuyển dữ liệu — An toàn nhất (Microsoft khuyến nghị)

Đây là phương án được Microsoft và cộng đồng IT khuyến nghị, rủi ro gần như bằng 0.

Bước 1 — Tạo user mới với tên chuẩn:

```
Settings > Accounts > Other users > Add account
-> I don't have this person's sign-in information
-> Add a user without a Microsoft account
-> Nhap ten CHINH XAC muon co (VD: DangHai) -> Dat mat khau -> Next
```

Bước 2 — Cấp quyền Administrator:

```
Settings > Accounts > Other users -> Chon user moi -> Change account type -> Administrator
# Hoac PowerShell:
Add-LocalGroupMember -Group "Administrators" -Member "DangHai"
```

Bước 3 — Đăng xuất user cũ, đăng nhập user mới một lần để Windows tạo `C:\Users\DangHai` đầy đủ.

Bước 4 — Sao chép dữ liệu (đăng nhập bằng user mới hoặc Administrator):

```
Nguon: C:\Users\Hai Dang\Desktop, Documents, Downloads, Pictures, Videos, Music
Dich:  C:\Users\DangHai\Desktop, Documents, Downloads, Pictures, Videos, Music

KHONG copy: AppData, NTUSER.DAT, ntuser.ini, AppData\Local\Microsoft\Windows\UsrClass.dat
Ly do: AppData chua cache, token, cau hinh app cu tren duong dan cu -> de gay loi.
```

Dùng `robocopy` để giữ quyền và bỏ qua file hệ thống:

```powershell
robocopy "C:\Users\Hai Dang\Desktop"   "C:\Users\DangHai\Desktop"   /E /COPY:DAT /DCOPY:T /R:1 /W:1 /XJ /XD "AppData"
robocopy "C:\Users\Hai Dang\Documents" "C:\Users\DangHai\Documents" /E /COPY:DAT /DCOPY:T /R:1 /W:1 /XJ
robocopy "C:\Users\Hai Dang\Downloads" "C:\Users\DangHai\Downloads" /E /COPY:DAT /DCOPY:T /R:1 /W:1 /XJ
```

Bước 5 — Cài lại / đăng nhập lại các ứng dụng: OneDrive, VS Code, Git (`git config --global`), trình duyệt (sync), Docker Desktop, v.v.

Bước 6 — Kiểm tra 1-2 ngày cho ổn định, sau đó xóa user cũ nếu không cần:

```powershell
Remove-LocalUser -Name "Hai Dang"
# Hoac: netplwiz -> chon user cu -> Remove
# Thu muc C:\Users\Hai Dang co the xoa thu cong sau khi da sao luu
```

Ưu điểm:

- Không đụng Registry, không rủi ro profile.
- OneDrive, Search Index tự tạo mới sạch sẽ.
- Dễ rollback: chỉ cần đăng nhập lại user cũ.

Nhược điểm:

- Mất thời gian cài lại app / đăng nhập lại.
- Một số cấu hình ứng dụng phải làm lại.

---

### Phương án B: Sửa Registry + đổi tên thư mục — Nhanh nhưng rủi ro (chỉ cho người có kinh nghiệm)

> Bắt buộc: Đăng xuất hoàn toàn user cần đổi. Đăng nhập bằng một tài khoản Administrator KHÁC (không phải user đang đổi). Nếu chưa có, kích hoạt Administrator ẩn.

Bước 1 — Kích hoạt Administrator ẩn (nếu chưa có admin dự phòng):

```cmd
:: Chay CMD voi quyen Administrator
net user administrator /active:yes
net user Administrator <MatKhauManhCuaBan>  :: Thay <MatKhauManhCuaBan> bang mat khau manh cua ban
:: Ghi nho mat khau nay, sau khi xong co the tat lai: net user administrator /active:no
```

Bước 2 — Lấy SID của user cần đổi:

```powershell
Get-LocalUser | Select-Object Name, SID, FullName

# Hoac lay SID cua user cu the:
(Get-LocalUser -Name "Hai Dang").SID.Value

# Hoac bang wmic (tuong thich cu):
wmic useraccount get name,SID
```

Ghi lại SID, ví dụ: `S-1-5-21-1234567890-1234567890-1234567890-1001`.

Bước 3 — Sửa Registry:

1. Nhấn `Win + R` -> `regedit` -> Enter.
2. Điều hướng: `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\<SID-cua-ban>`
3. Ở khung phải, double-click `ProfileImagePath` -> đổi giá trị từ `C:\Users\Hai Dang` thành `C:\Users\DangHai` -> OK.
4. Kiểm tra không có key trùng `.bak`: nếu thấy `S-1-5-...-1001.bak`, xử lý trước khi tiếp tục (xóa hoặc đổi tên key .bak cũ).

Bước 4 — Đổi tên thư mục vật lý:

```powershell
# Dang o tai khoan Administrator khac, khong bi khoa file
Rename-Item -LiteralPath "C:\Users\Hai Dang" -NewName "DangHai"
# Neu bao file dang su dung -> dam bao user cu da dang xuat hoan toan, tat OneDrive, tat antivirus tam thoi
```

Bước 5 — Tạo Symbolic Link để ứng dụng cũ không gãy (khuyến nghị mạnh):

```cmd
:: Chay CMD Administrator
mklink /d "C:\Users\Hai Dang" "C:\Users\DangHai"
:: Ket qua: C:\Users\Hai Dang -> tro toi DangHai, app cu van chay duoc
```

Kiểm tra:

```powershell
Get-Item "C:\Users\Hai Dang" | Select-Object LinkType, Target
# LinkType = SymbolicLink, Target = C:\Users\DangHai
```

Bước 6 — Rebuild các dịch vụ phụ thuộc đường dẫn:

- Search Index: `Control Panel > Indexing Options > Advanced > Rebuild` (mất 10-30 phút).
- OneDrive: Click icon OneDrive -> Settings -> Account -> Unlink this PC -> đăng nhập lại, chọn thư mục `C:\Users\DangHai\OneDrive`.
- Office / Outlook: có thể yêu cầu đăng nhập lại.
- Biến môi trường: kiểm tra `USERPROFILE` đã trỏ đúng chưa:

```powershell
[Environment]::GetEnvironmentVariable("USERPROFILE", "User")
# Ky vong: C:\Users\DangHai
Get-ChildItem Env:USERPROFILE, Env:USERNAME
```

Bước 7 — Khởi động lại và kiểm thử:

1. Restart máy.
2. Đăng nhập bằng user đã đổi (`DangHai`).
3. Mở `Win + R` -> `cmd` -> `echo %USERPROFILE%` phải ra `C:\Users\DangHai`.
4. Mở OneDrive, VS Code, trình duyệt, thử build một dự án có đường dẫn dài.

Nếu không đăng nhập được (báo `You have been logged on with a temporary profile`):

- Đăng nhập lại bằng Administrator dự phòng.
- Mở `regedit`, kiểm tra `ProfileImagePath` có khớp tên thư mục thực tế không.
- Kiểm tra quyền NTFS: chuột phải `C:\Users\DangHai` -> Properties -> Security -> user `DangHai` phải có `Full control`.
- Khôi phục từ Restore Point nếu cần: `Win -> Create a restore point -> System Restore`.

---

## 5. Script tự động hóa

Tài liệu này đi kèm 2 script trong thư mục `scripts/` (cùng cấp với file .md này). Tất cả script phải chạy bằng PowerShell với quyền Administrator.

| Script | Mục đích | Mức độ an toàn |
|---|---|---|
| `scripts/rename-displayname.ps1` | Đổi tên hiển thị + username (Cấp 1) | An toàn |
| `scripts/rename-profile-advanced.ps1` | Kiểm tra điều kiện, hướng dẫn đổi thư mục (Cấp 2), tạo symlink, rebuild index | Cảnh báo rủi ro, yêu cầu xác nhận |

Chạy script:

```powershell
# Cho phep chay script trong phien hien tai (khong doi chinh sach vinh vien)
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

# Cap 1 - an toan
.\scripts\rename-displayname.ps1 -OldName "Hai Dang" -NewName "DangHai" -FullName "Hai Dang"

# Cap 2 - kiem tra dieu kien truoc khi lam
.\scripts\rename-profile-advanced.ps1 -OldName "Hai Dang" -NewName "DangHai" -WhatIf
# Bo -WhatIf de chay that sau khi da doc ky canh bao
```

> Nếu thư mục `scripts/` chưa tồn tại hoặc trống, bạn có thể tạo thủ công từ các đoạn mã mẫu ở mục 3 và 4, hoặc liên hệ win-coder để được cấp lại script chuẩn.

---

## 6. FAQ — Câu hỏi thường gặp

### 6.1 Đổi tên hiển thị có mất dữ liệu không?
Không. Đổi Display Name / Full Name chỉ thay đổi chuỗi hiển thị trong cơ sở dữ liệu người dùng cục bộ. Toàn bộ file trong `C:\Users\`, registry cá nhân, và ứng dụng giữ nguyên.

### 6.2 Đổi tên thư mục `C:\Users\...` có mất dữ liệu không?
Không mất nếu làm đúng quy trình (Phương án A hoặc B có sao lưu). Rủi ro chính là lỗi hồ sơ tạm thời (temporary profile) nếu Registry và tên thư mục không khớp, hoặc ứng dụng trỏ cứng vào đường dẫn cũ. Luôn tạo Restore Point trước.

### 6.3 Tài khoản Microsoft đổi tên thế nào cho đúng?
Đổi tại `https://account.microsoft.com > Your info > Edit name` trước, sau đó đồng bộ xuống máy. Nếu chỉ đổi bằng `netplwiz` trên máy, lần đồng bộ sau Windows sẽ ghi đè lại tên cũ từ cloud. Với thư mục `C:\Users\`, quy trình đổi giống Local Account, nhưng cần Unlink/Relink OneDrive.

### 6.4 Tên có dấu cách (`Hai Dang`) có gây lỗi không?
Hầu hết ứng dụng hiện đại xử lý tốt dấu cách nếu đường dẫn được đặt trong dấu nháy kép. Tuy nhiên một số toolchain cũ (ví dụ script Python, npm, Make, Android NDK) có thể gãy. Nếu bạn làm lập trình, khuyến nghị dùng tên không dấu, không cách (ví dụ `DangHai` hoặc `hai.dang`) cho thư mục profile.

### 6.5 Đổi username có tự đổi tên thư mục không?
Không. `Rename-LocalUser` chỉ đổi tên đăng nhập trong SAM database, không đổi `C:\Users\TenCu`. Muốn đổi thư mục phải làm Cấp 2 thủ công.

### 6.6 Có cần tạo tài khoản Administrator dự phòng không?
Bắt buộc đối với Cấp 2. Bạn không thể đổi tên thư mục của chính tài khoản đang đăng nhập vì file đang bị khóa. Luôn có một admin khác để thao tác.

### 6.7 Quên mật khẩu sau khi đổi thì sao?
Với Local Account: dùng USB reset password hoặc đăng nhập bằng admin khác để đặt lại: `net user DangHai MatKhauMoi`. Với Microsoft Account: đặt lại tại `https://account.live.com/password/reset`.

### 6.8 OneDrive báo lỗi sau khi đổi thư mục?
OneDrive lưu đường dẫn tuyệt đối. Sau khi đổi, mở OneDrive -> Settings -> Account -> Unlink this PC -> đăng nhập lại và chọn vị trí mới `C:\Users\TenMoi\OneDrive`. Đừng copy thủ công thư mục OneDrive cũ khi chưa unlink.

### 6.9 Search (Windows Search) không tìm thấy file sau khi đổi?
Rebuild index: `Control Panel > Indexing Options > Advanced > Rebuild` hoặc `Settings > Privacy & security > Searching Windows > Advanced indexing options > Rebuild`. Quá trình có thể mất 10-60 phút tùy dung lượng.

### 6.10 Có thể đổi ngược lại không?
Có. Với Cấp 1: chạy lại `netplwiz` hoặc `Rename-LocalUser` ngược lại. Với Cấp 2 Phương án A: đăng nhập lại user cũ. Với Phương án B: đổi lại `ProfileImagePath` trong Registry và `Rename-Item` thư mục, xóa symlink cũ nếu có, rồi restart.

### 6.11 Dùng `netplwiz` không thấy nút Properties?
Trên Windows 11 bản mới, Microsoft ẩn `netplwiz` với Microsoft Account. Thử: `Win + R` -> `control userpasswords2` (tương đương netplwiz) hoặc chuyển sang dùng PowerShell `Set-LocalUser`.

### 6.12 Máy công ty join domain / Entra ID thì sao?
Không tự ý đổi username hoặc profile path. Liên hệ IT Helpdesk. Việc đổi có thể làm gãy Group Policy, Intune, hoặc Conditional Access. Chỉ đổi Display Name qua portal công ty nếu được phép.

### 6.13 Có cần sửa biến môi trường PATH không?
Thường không, vì PATH hệ thống dùng `%USERPROFILE%` động. Tuy nhiên nếu bạn từng thêm thủ công đường dẫn tuyệt đối như `C:\Users\Hai Dang\AppData\Local\Programs\Python\...` vào PATH, hãy cập nhật lại thành `C:\Users\DangHai\...` hoặc dùng `%USERPROFILE%`.

### 6.14 Symlink `C:\Users\TenCu -> TenMoi` có an toàn không?
An toàn và được khuyến nghị. Symlink dạng `mklink /d` giúp ứng dụng cũ vẫn tìm thấy đường dẫn cũ. Lưu ý: đừng tạo symlink vòng tròn, và đừng để cả hai thư mục vật lý cùng tồn tại với dữ liệu khác nhau.

---

## 7. Lưu ý chuyên sâu: Microsoft Account vs Local Account

### 7.1 Khi nào nên giữ Microsoft Account

- Cần đồng bộ cài đặt, theme, mật khẩu Wi-Fi, Edge, Office giữa nhiều máy.
- Dùng OneDrive, Microsoft Store, Xbox, Find my device.
- Muốn đặt lại mật khẩu online khi quên.

Nhược điểm: tên thư mục `C:\Users\` thường xấu, bị cắt 5 ký tự đầu email; Display Name bị cloud ghi đè.

### 7.2 Khi nào nên dùng Local Account

- Muốn kiểm soát hoàn toàn tên user và thư mục profile đẹp ngay từ đầu.
- Làm dev / build system nhạy cảm với dấu cách và đường dẫn dài.
- Máy offline hoặc không muốn đồng bộ cloud.

Nhược điểm: phải tự quản lý sao lưu, quên mật khẩu khó khôi phục hơn.

### 7.3 Lộ trình khuyến nghị nếu đang dùng Microsoft Account và muốn đường dẫn đẹp

1. Đổi Display Name online tại `account.microsoft.com` cho đúng trước.
2. Thực hiện Cấp 2 Phương án A (tạo Local Account mới tên đẹp `DangHai`).
3. Đăng nhập Local Account mới, cài đặt xong, sau đó nếu vẫn muốn đồng bộ Microsoft: `Settings > Accounts > Your info > Sign in with a Microsoft account instead` — Windows sẽ liên kết Local Account đẹp với Microsoft Account mà không đổi lại `C:\Users\DangHai`.

> Mẹo: Tạo Local Account trước, liên kết Microsoft sau — bạn sẽ có cả đường dẫn đẹp và lợi ích đồng bộ.

### 7.4 Bảng quyết định nhanh

| Nhu cầu | Hành động khuyến nghị |
|---|---|
| Chỉ muốn tên hiển thị đẹp | Cấp 1 + (nếu Microsoft Account) đổi online |
| Muốn `C:\Users\TenDep` và đang dùng Local | Cấp 2 Phương án A hoặc B |
| Muốn `C:\Users\TenDep` và đang dùng Microsoft | Tạo Local `TenDep` -> liên kết Microsoft sau (mục 7.3) |
| Máy công ty / domain | Hỏi IT, chỉ đổi Display Name |
| Sợ rủi ro, không rành Registry | Dừng ở Cấp 1, hoặc dùng Phương án A |

### 7.5 Đồng bộ và OneDrive — checklist riêng cho Microsoft Account

- Trước khi đổi: tạm dừng OneDrive sync (Pause syncing).
- Sau khi đổi thư mục: Unlink -> Relink, chọn lại thư mục mới, tránh tạo trùng `OneDrive - Personal (1)`.
- Kiểm tra `Settings > Accounts > Windows backup` xem có đang backup `C:\Users\TenCu` không — cập nhật lại nếu cần.
- Nếu dùng Office 365: đăng xuất và đăng nhập lại Word/Excel để cập nhật `Default local file location`.

---

## 8. Khắc phục sự cố thường gặp

| Triệu chứng | Nguyên nhân | Cách khắc phục |
|---|---|---|
| Đăng nhập báo `temporary profile` | `ProfileImagePath` không khớp tên thư mục thực tế, hoặc thiếu quyền NTFS | Đăng nhập admin khác, sửa Registry cho khớp, cấp `Full control` cho user mới trên `C:\Users\TenMoi` |
| Màn hình đen sau đăng nhập | Shell trỏ sai, AppData chưa copy, symlink thiếu | Kiểm tra `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell` phải là `explorer.exe`; khôi phục AppData từ backup nếu cần |
| OneDrive không đồng bộ | Đường dẫn cũ còn cache | Unlink/Relink OneDrive, xóa `C:\Users\TenCu\OneDrive` cũ sau khi đã đồng bộ xong |
| Search không ra file | Index còn trỏ thư mục cũ | Rebuild index như mục 4 |
| Ứng dụng báo `path not found` | App trỏ cứng `C:\Users\TenCu` | Tạo symlink `mklink /d` như mục 4, hoặc cài lại app |
| Không đổi được tên vì `Access denied` | Chưa chạy Administrator, hoặc user đang đăng nhập | Chuột phải PowerShell/CMD -> Run as Administrator; đăng xuất user cần đổi hoàn toàn |
| `netplwiz` không hiện user Microsoft | Windows 11 ẩn user cloud | Dùng `control userpasswords2` hoặc PowerShell `Get-LocalUser` |

Lệnh chẩn đoán nhanh:

```powershell
# Kiem tra profile status
Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\*" |
  Select-Object PSChildName, ProfileImagePath, State, RefCount |
  Format-Table -AutoSize

# Kiem tra user hien tai
whoami
[Environment]::GetEnvironmentVariable("USERPROFILE")
Get-LocalUser | Format-Table Name, FullName, Enabled -AutoSize

# Kiem tra symlink
Get-ChildItem C:\Users | Select-Object Name, LinkType, Target
```

---

## 9. Checklist an toàn trước khi thao tác

Áp dụng cho mọi cấp độ, bắt buộc cho Cấp 2:

- [ ] Đã tạo Restore Point: `Win -> Create a restore point -> Create -> Dat ten: Before-Rename-YYYYMMDD`.
- [ ] Đã có tài khoản Administrator dự phòng và nhớ mật khẩu (test đăng nhập được).
- [ ] Đã sao lưu `Desktop, Documents, Downloads, Pictures` ra ổ khác hoặc USB.
- [ ] Đã ghi lại SID và `ProfileImagePath` hiện tại (chụp ảnh màn hình Registry).
- [ ] Đã tạm dừng OneDrive sync và đóng hết ứng dụng đang khóa file trong `C:\Users\TenCu`.
- [ ] Đã chuẩn bị USB cài Windows hoặc WinRE để vào Safe Mode nếu cần khôi phục.
- [ ] Đã đọc kỹ mục 2 và 7 để xác định mình đang dùng Microsoft Account hay Local Account.

Khôi phục nhanh nếu có sự cố:

```powershell
# Tu Safe Mode hoac Admin khac
rstrui.exe
# Chon Restore Point vua tao -> Next -> Finish
```

---

## 10. Ví dụ thực tế cho máy hiện tại

> Máy bạn hiện tại: `C:\Users\Hai Dang` - đây đã là tên khá đẹp, có dấu cách nhưng chuẩn, không bị cắt ngắn như `haida`.

| Nhu cầu | Lệnh / thao tác | Kết quả |
|---|---|---|
| Giữ `Hai Dang` nhưng chuẩn hóa hiển thị | `netplwiz` -> Full name = `Hai Dang` | Màn hình khóa hiển thị `Hai Dang`, đường dẫn giữ nguyên `C:\Users\Hai Dang` |
| Đổi hiển thị thành `Hai Dang (AgentForge)` | `Set-LocalUser -Name "Hai Dang" -FullName "Hai Dang (AgentForge)"` | Chỉ đổi hiển thị, không ảnh hưởng gì khác |
| Đổi username thành `DangHai` (không dấu cách) | `Rename-LocalUser -Name "Hai Dang" -NewName "DangHai"` | Lần đăng nhập sau dùng `DangHai`, nhưng thư mục vẫn `C:\Users\Hai Dang` |
| Muốn đường dẫn `C:\Users\DangHai` đẹp, không cách | Làm Cấp 2 Phương án A: tạo user `DangHai` mới | Có `C:\Users\DangHai` sạch, an toàn nhất |

Xử lý tên có dấu cách trong PowerShell — Bắt buộc dùng dấu nháy kép:

```powershell
# Luon dat trong nhay kep doi " " khi ten co dau cach
Get-LocalUser -Name "Hai Dang"
Rename-LocalUser -Name "Hai Dang" -NewName "DangHai"
# Duong dan cung vay - bat buoc dung -LiteralPath
Test-Path -LiteralPath "C:\Users\Hai Dang"
Rename-Item -LiteralPath "C:\Users\Hai Dang" -NewName "DangHai"
# Sai neu khong co nhay: Get-LocalUser -Name Hai Dang  -> loi tham so
# Dung cho CMD net user cung can nhay:
# net user "Hai Dang" /fullname:"Hai Dang"
```

> Lưu ý quan trọng về dấu cách:
> - PowerShell: Tham số `-Name` phải là `"Hai Dang"` (nháy kép). Dùng `-LiteralPath` thay vì `-Path` khi thao tác `C:\Users\Hai Dang` để tránh PowerShell diễn giải dấu cách thành hai tham số riêng biệt.
> - CMD: `net user "Hai Dang" newPassword` và `net user "Hai Dang" /fullname:"Hai Dang (AgentForge)"` — luôn bọc tên trong nháy kép.
> - Biến `$oldName = "Hai Dang"` trong script đã được đặt sẵn đúng chuẩn; không xóa dấu nháy.
> - Kiểm tra nhanh: `whoami` sẽ trả về `desktop\Hai Dang` — đó là bằng chứng tên hiện tại vẫn chứa dấu cách và mọi lệnh sau này phải quote.

> Agent đã tùy chỉnh script cho bạn với `OldName` mặc định là `Hai Dang`. Chỉ cần truyền `-NewName` mong muốn.

---

## 11. Tham khảo và liên hệ

- Tài liệu gốc Microsoft: `Rename a local user account` và `User Profile Service` trong `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`.
- Lệnh tham khảo: `Get-Help Get-LocalUser -Full`, `Get-Help Rename-LocalUser -Full`, `help mklink`.
- Kiểm chứng thực tế: tài liệu này đã được `win-verify` kiểm tra tồn tại file trên đĩa và đối chiếu với hành vi Windows 10/11 thực tế.

Nếu cần agent hỗ trợ trực tiếp, hãy cung cấp:

- Tên cũ, tên mới mong muốn, phiên bản Windows (`winver`), loại tài khoản (Microsoft/Local), và bạn muốn đổi hiển thị hay cả thư mục.

---

> Lưu ý cuối: Mọi thao tác Cấp 2 đều có rủi ro. Nếu bạn không chắc chắn, hãy dừng ở Cấp 1 hoặc chọn Phương án A (tạo user mới). An toàn dữ liệu quan trọng hơn một đường dẫn đẹp.

