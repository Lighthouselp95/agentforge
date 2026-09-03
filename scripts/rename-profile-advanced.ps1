<#
.SYNOPSIS
    Kiem tra dieu kien + huong dan doi thu muc C:\Users\TenCu -> C:\Users\TenMoi (Cap 2 - Nang cao).

.DESCRIPTION
    Script KHONG tu dong doi Registry/thu muc neu chua xac nhan.
    Chuc nang:
      - Canh bao rui ro nghiem trong
      - Kiem tra quyen Admin, kiem tra ton tai admin khac
      - Lay SID cua user can doi
      - Tao Restore Point (Checkpoint-Computer)
      - Huong dan chi tiet sua Registry ProfileImagePath
      - Huong dan rename thu muc + tao mklink /d symbolic link
      - Ho tro che do -WhatIf va -Execute de thuc thi (mac dinh DryRun)
    PHOI HOP: Dung kem windows-rename-guide.md va rename-displayname.ps1

.PARAMETER OldName
    Ten user can doi thu muc. VD: "Hai Dang"

.PARAMETER NewName
    Ten thu muc moi mong muon. VD: "DangHai" (KHONG chua dau cach tot nhat, khong chua \/:*?"<>|)

.PARAMETER Execute
    Neu khong co switch nay, script chi kiem tra + huong dan (DryRun).
    Khi co -Execute, script se tu dong tao Restore Point + hien lenh can chay thu cong.

.PARAMETER SkipRestorePoint
    Bo qua tao Restore Point (khong khuyen nghi).

.EXAMPLE
    # Kiem tra dieu kien (khuyen dung truoc)
    .\rename-profile-advanced.ps1 -OldName "Hai Dang" -NewName "DangHai"

.EXAMPLE
    # Thuc thi co tao Restore Point
    .\rename-profile-advanced.ps1 -OldName "Hai Dang" -NewName "DangHai" -Execute

.NOTES
    BAT BUOC:
      - Chay bang tai khoan Administrator KHAC (khong phai user dang doi)!
      - Dang xuat user can doi truoc khi doi thu muc.
      - Sao luu du lieu quan trong.
    Tham khao: Microsoft khuyen nghi tao user moi thay vi doi Registry.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OldName = "Hai Dang",

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$NewName = "DangHai",

    [switch]$Execute,

    [switch]$SkipRestorePoint
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "[OK]   $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "[ERR]  $Msg" -ForegroundColor Red }
function Write-Info { param([string]$Msg) Write-Host "       $Msg" -ForegroundColor Gray }

# --- Banner ---
Write-Host "======================================================================" -ForegroundColor Red
Write-Host "  rename-profile-advanced.ps1 - DOI THU MUC C:\Users (CAP 2 - RUI RO)" -ForegroundColor Red
Write-Host "======================================================================" -ForegroundColor Red
Write-Host ""
Write-Host "  CANH BAO RUI RO NGHIEM TRONG:" -ForegroundColor Red
Write-Host "  - Sai Registry/ProfileImagePath co the lam MAT PROFILE, khong dang nhap duoc!" -ForegroundColor Yellow
Write-Host "  - Mot so app (OneDrive, Outlook, VS Code, Node, Python venv) luu duong dan cu." -ForegroundColor Yellow
Write-Host "  - Microsoft KHUYEN NGHI: Tao user moi thay vi sua Registry (an toan 100%)." -ForegroundColor Yellow
Write-Host "  - BAT BUOC: Tao Restore Point + co admin khac + sao luu du lieu truoc!" -ForegroundColor Yellow
Write-Host ""
Write-Host "  PHUONG AN AN TOAN NHAT (thay the):" -ForegroundColor Cyan
Write-Host "    Settings > Accounts > Other users > Add account > Add a user without Microsoft account" -ForegroundColor Gray
Write-Host "    -> Dat ten chinh xac `"$NewName`" -> Change account type -> Administrator" -ForegroundColor Gray
Write-Host "    -> Copy Desktop/Documents/Downloads (KHONG copy AppData/NTUSER.DAT)" -ForegroundColor Gray
Write-Host ""
if (-not $Execute) {
    Write-Host "  CHE DO HIEN TAI: DryRun (chi kiem tra + huong dan). Them -Execute de thuc thi." -ForegroundColor Magenta
} else {
    Write-Host "  CHE DO: -Execute (se tao Restore Point va hien lenh thuc thi)" -ForegroundColor Magenta
}
Write-Host "======================================================================" -ForegroundColor Red
Write-Host ""

# --- Validate input ---
if ($OldName -eq $NewName) {
    Write-Err "OldName va NewName trung nhau (`"$OldName`") -> khong can doi."
    exit 1
}
if ($NewName -match '[\\/:*?"<>|]') {
    Write-Err "NewName `"$NewName`" chua ky tu cam \ / : * ? `" < > |"
    exit 1
}
if ($NewName.Contains(" ")) {
    Write-Warn "NewName `"$NewName`" chua dau cach - van duoc nhung khuyen dung DangHai (lien nhau) de tranh loi app cu."
}
$oldPath = "C:\Users\$OldName"
$newPath = "C:\Users\$NewName"
Write-Step "Muc tieu: `"$oldPath`" -> `"$newPath`""

# --- 1. Kiem tra Admin ---
Write-Step "1/7 Kiem tra quyen Administrator..."
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "CHUA chay voi quyen Administrator!"
    Write-Info "Chuot phai PowerShell -> Run as Administrator. Len h goi y:"
    Write-Info "  Start-Process powershell -Verb RunAs -ArgumentList `"-ExecutionPolicy Bypass -File `"$PSCommandPath`" -OldName `"$OldName`" -NewName `"$NewName`"`""
    exit 1
}
Write-Ok "Da chay voi quyen Administrator."

# --- 2. Kiem tra dang nhap bang admin khac ---
Write-Step "2/7 Kiem tra tai khoan dang thuc thi vs user can doi..."
$currentUser = $env:USERNAME
Write-Info "Dang chay duoi tai khoan: `"$currentUser`" | User can doi: `"$OldName`""
if ($currentUser -eq $OldName) {
    Write-Err "Ban dang dang nhap bang CHINH user can doi (`"$OldName`")!"
    Write-Err "BAT BUOC dang xuat, dang nhap bang Administrator KHAC roi chay lai."
    Write-Info "Neu chua co admin khac, tao tam (THAY <MatKhauManhCuaBan> bang mat khau manh cua ban):"
    Write-Info '  net user administrator /active:yes'
    Write-Info '  net user Administrator <MatKhauManhCuaBan>  # VD: net user Administrator MyStr0ng!Pass2026'
    Write-Info "  hoac: net user TempAdmin <MatKhauManhCuaBan> /add ; net localgroup administrators TempAdmin /add"
    if (-not $Execute) { Write-Warn "DryRun: tiep tuc kiem tra (nhung khi Execute that se bi chan)." }
    else { exit 1 }
} else {
    Write-Ok "Dang chay bang admin khac (`"$currentUser`") -> hop le."
}

# --- 3. Kiem tra ton tai admin khac ---
Write-Step "3/7 Kiem tra ton tai tai khoan Administrator khac (de cuu ho)..."
try {
    Import-Module Microsoft.PowerShell.LocalAccounts -ErrorAction SilentlyContinue | Out-Null
    $allUsers = Get-LocalUser -ErrorAction Stop
    $adminGroup = Get-LocalGroupMember -Group "Administrators" -ErrorAction Stop
    Write-Info "Thanh vien nhom Administrators:"
    $adminGroup | ForEach-Object { Write-Info "  - $($_.Name) ($($_.ObjectClass))" }
    # Dem so admin enabled khac OldName
    $otherAdmins = @()
    foreach ($m in $adminGroup) {
        # m.Name dang "COMPUTER\Username"
        $memberName = ($m.Name -split '\\')[-1]
        if ($memberName -ne $OldName) {
            try {
                $u = Get-LocalUser -Name $memberName -ErrorAction SilentlyContinue
                if ($null -ne $u -and $u.Enabled) { $otherAdmins += $memberName }
                elseif ($memberName -eq "Administrator") { $otherAdmins += $memberName }
            } catch {}
        }
    }
    if ($otherAdmins.Count -eq 0) {
        Write-Err "KHONG tim thay Administrator khac dang Enabled!"
        Write-Info "Tao ngay 1 admin du phong truoc khi lam (THAY <MatKhauManhCuaBan> bang mat khau manh):"
        Write-Info "  net user TempAdmin <MatKhauManhCuaBan> /add  # VD: net user TempAdmin MyStr0ng!Pass2026 /add"
        Write-Info "  net localgroup administrators TempAdmin /add"
        if ($Execute) { exit 1 }
    } else {
        Write-Ok "Co admin khac Enabled: $($otherAdmins -join ', ') -> an toan de cuu ho."
    }
} catch {
    Write-Warn "Khong the liet ke admin group tu dong: $($_.Exception.Message)"
    Write-Info "Kiem tra thu cong: net localgroup administrators  hoac  Get-LocalGroupMember -Group Administrators"
}

# --- 4. Lay SID va kiem tra ProfileList ---
Write-Step "4/7 Lay SID va kiem tra Registry ProfileImagePath..."
$targetUser = $null
$sid = $null
try {
    $targetUser = Get-LocalUser -Name $OldName -ErrorAction Stop
    $sid = $targetUser.SID.Value
    Write-Ok "Tim thay user `"$OldName`" SID=$sid Enabled=$($targetUser.Enabled) FullName=`"$($targetUser.FullName)`""
} catch {
    Write-Err "Khong tim thay user `"$OldName`": $($_.Exception.Message)"
    Write-Info "Danh sach user:"
    try { Get-LocalUser | Select Name,SID,Enabled | Format-Table -AutoSize | Out-String | Write-Host -ForegroundColor Yellow } catch {}
    exit 1
}

$regPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
$profileImagePath = $null
try {
    if (Test-Path $regPath) {
        $profileImagePath = (Get-ItemProperty -Path $regPath -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath
        Write-Ok "Registry: $regPath"
        Write-Ok "ProfileImagePath hien tai: `"$profileImagePath`""
        if ($profileImagePath -ne $oldPath) {
            Write-Warn "ProfileImagePath (`"$profileImagePath`") khac du kien (`"$oldPath`") - co the user da doi truoc hoac dang dung OneDrive/Profile di dong."
        }
        if ($profileImagePath -eq $newPath) {
            Write-Warn "ProfileImagePath da la `"$newPath`" -> co the da doi truoc."
        }
    } else {
        Write-Err "Khong tim thay key Registry $regPath - user chua tung dang nhap hoac la tai khoan dac biet."
        exit 1
    }
} catch {
    Write-Err "Loi doc Registry: $($_.Exception.Message)"
    exit 1
}

# Lay them SID bang wmic de doi chieu (phong truong hop)
try {
    Write-Info "Doi chieu SID bang wmic (neu co):"
    $wmicOut = & wmic useraccount where "name='$OldName'" get SID 2>$null | Select-String "S-1-5"
    if ($wmicOut) { Write-Info "  wmic SID: $($wmicOut.ToString().Trim())" }
} catch {}

# --- 5. Kiem tra thu muc ---
Write-Step "5/7 Kiem tra thu muc C:\Users..."
$oldExists = Test-Path -LiteralPath $oldPath
$newExists = Test-Path -LiteralPath $newPath
Write-Info "  $oldPath exists = $oldExists"
Write-Info "  $newPath exists = $newExists"
if (-not $oldExists) {
    Write-Err "Thu muc nguon `"$oldPath`" KHONG ton tai!"
    exit 1
}
if ($newExists) {
    Write-Err "Thu muc dich `"$newPath`" DA ton tai -> chon NewName khac hoac xoa/doi thu muc dich truoc."
    exit 1
}
# Kiem tra user dang lock file
Write-Info "Kiem tra user `"$OldName`" con process dang chay khong (can dang xuat het):"
try {
    $procs = Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$OldName" } | Select-Object -First 5
    if ($procs) {
        Write-Warn "Van con process cua `"$OldName`" dang chay:"
        $procs | ForEach-Object { Write-Info "  PID $($_.Id) $($_.ProcessName) $($_.UserName)" }
        Write-Info "Hay dang xuat user `"$OldName`" hoac reboot roi dang nhap bang admin khac."
        if ($Execute) { Write-Err "Dung lai de tranh khoa file."; exit 1 }
    } else {
        Write-Ok "Khong thay process cua `"$OldName`" (co the da dang xuat) -> tot."
    }
} catch {
    Write-Warn "Khong the kiem tra process theo user (can quyen cao hon): $($_.Exception.Message)"
    Write-Info "Thu cong: Task Manager -> Users -> dang xuat `"$OldName`", hoac: query user / logoff"
}

# --- 6. Tao Restore Point ---
Write-Step "6/7 Tao Restore Point (Checkpoint-Computer)..."
if ($SkipRestorePoint) {
    Write-Warn "Bo qua tao Restore Point theo yeu cau - RUI RO CAO!"
} else {
    if (-not $Execute) {
        Write-Warn "DryRun: se tao Restore Point khi chay voi -Execute. Len h du kien:"
        Write-Info '  Enable-ComputerRestore -Drive "C:\"  # neu chua bat'
        Write-Info '  Checkpoint-Computer -Description "Before Rename C:\Users\Hai Dang -> DangHai" -RestorePointType MODIFY_SETTINGS'
    } else {
        try {
            # Bat System Restore neu chua bat
            try {
                $null = Get-ComputerRestorePoint -ErrorAction SilentlyContinue
                Enable-ComputerRestore -Drive "C:\" -ErrorAction SilentlyContinue | Out-Null
            } catch {}
            Write-Info "Dang tao Restore Point (co the mat 30-60s)..."
            Checkpoint-Computer -Description "Before Rename $OldName->$NewName" -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
            Write-Ok "Da tao Restore Point: Before Rename $OldName->$NewName"
        } catch {
            Write-Warn "Khong the tao Restore Point tu dong: $($_.Exception.Message)"
            Write-Info "Tao thu cong: Win -> Create a restore point -> Create -> Dat ten -> Create"
            Write-Info "Tiep tuc nhung BAN PHAI tao thu cong truoc khi sua Registry!"
            # Khong exit - de user tu tao thu cong
        }
    }
}

# --- 7. Huong dan thuc thi (va thuc thi neu -Execute) ---
Write-Step "7/7 Huong dan thuc thi doi Registry + rename + mklink..."
Write-Host ""
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  CAC LENH CAN CHAY (theo thu tu) - Chay bang Administrator KHAC" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host " # 1. Sua Registry ProfileImagePath (QUAN TRONG NHAT):" -ForegroundColor Yellow
Write-Host '   regedit -> HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid -ForegroundColor Gray
Write-Host "   -> Double-click ProfileImagePath -> doi tu `"$oldPath`" -> `"$newPath`" -> OK" -ForegroundColor Gray
Write-Host ""
Write-Host "   Hoac chay PowerShell (Admin khac):" -ForegroundColor Gray
Write-Host "   Set-ItemProperty -Path `"$regPath`" -Name ProfileImagePath -Value `"$newPath`"" -ForegroundColor White
Write-Host ""
Write-Host " # 2. Rename thu muc (khi user da dang xuat):" -ForegroundColor Yellow
Write-Host "   Rename-Item -LiteralPath `"$oldPath`" -NewName `"$NewName`" -Force" -ForegroundColor White
Write-Host '   # hoac cmd: ren "C:\Users\Hai Dang" "DangHai"' -ForegroundColor Gray
Write-Host ""
Write-Host " # 3. Tao Symbolic Link (tranh loi app cu van tro toi duong dan cu):" -ForegroundColor Yellow
Write-Host '   cmd /c mklink /d "C:\Users\Hai Dang" "C:\Users\DangHai"' -ForegroundColor White
Write-Host "   # Kiem tra: dir C:\Users | findstr DangHai" -ForegroundColor Gray
Write-Host ""
Write-Host " # 4. Rebuild Index & OneDrive (sau khi dang nhap lai bang $NewName):" -ForegroundColor Yellow
Write-Host "   Control Panel > Indexing Options > Advanced > Rebuild" -ForegroundColor Gray
Write-Host "   OneDrive > Settings > Unlink this PC -> Link lai chon $newPath\OneDrive" -ForegroundColor Gray
Write-Host ""
Write-Host " # 5. Kiem tra sau reboot:" -ForegroundColor Yellow
Write-Host "   Get-LocalUser -Name `"$NewName`" | Select Name,SID" -ForegroundColor Gray
Write-Host "   Get-ItemProperty -Path `"$regPath`" -Name ProfileImagePath" -ForegroundColor Gray
Write-Host "   dir `"$newPath`" ; dir `"$oldPath`"  # thu 2 la symlink" -ForegroundColor Gray
Write-Host ""
Write-Host " # ROLLBACK neu khong dang nhap duoc:" -ForegroundColor Red
Write-Host "   - Dang nhap Administrator khac -> sua lai Registry ProfileImagePath -> `"$oldPath`"" -ForegroundColor Gray
Write-Host "   - Rename thu muc nguoc lai: Rename-Item `"$newPath`" -NewName `"$OldName`"" -ForegroundColor Gray
Write-Host "   - Xoa symlink neu can: cmd /c rmdir `"$oldPath`"  (chi xoa link, khong xoa du lieu)" -ForegroundColor Gray
Write-Host "   - Hoac System Restore: Win -> Recovery -> Open System Restore -> chon point vua tao" -ForegroundColor Gray
Write-Host "======================================================================" -ForegroundColor Cyan

if ($Execute) {
    Write-Host ""
    $confirm = Read-Host "Ban da HIEU RO rui ro va muon tu dong SUA REGISTRY + RENAME ngay bay gio? (go YES de dong y)"
    if ($confirm -ne "YES") {
        Write-Warn "Da huy thao tac tu dong. Hay lam thu cong theo huong dan tren."
        Write-Info "Neu muon lam thu cong tung buoc, chay lai KHONG co -Execute de xem huong dan."
        exit 0
    }
    # Thuc thi sua Registry
    Write-Step "Thuc thi Set-ItemProperty Registry..."
    if ($PSCmdlet.ShouldProcess($regPath, "Set ProfileImagePath to $newPath")) {
        try {
            Set-ItemProperty -Path $regPath -Name ProfileImagePath -Value $newPath -ErrorAction Stop
            Write-Ok "Da sua Registry: ProfileImagePath = `"$newPath`""
        } catch {
            Write-Err "Sua Registry that bai: $($_.Exception.Message)"
            exit 1
        }
    }
    Write-Step "Thuc thi Rename-Item thu muc..."
    try {
        Rename-Item -LiteralPath $oldPath -NewName $NewName -Force -ErrorAction Stop
        Write-Ok "Da rename thu muc `"$oldPath`" -> `"$newPath`""
    } catch {
        Write-Err "Rename thu muc that bai: $($_.Exception.Message)"
        Write-Info "Khoi phuc Registry lai de tranh lech:"
        try { Set-ItemProperty -Path $regPath -Name ProfileImagePath -Value $oldPath -ErrorAction SilentlyContinue } catch {}
        exit 1
    }
    Write-Step "Tao symlink mklink /d..."
    try {
        $cmd = "mklink /d `"$oldPath`" `"$newPath`""
        $out = cmd /c $cmd 2>&1
        Write-Info $out
        if (Test-Path -LiteralPath $oldPath) { Write-Ok "Da tao symlink: $oldPath -> $newPath" }
        else { Write-Warn "Lenh mklink khong bao loi nhung chua thay symlink. Chay thu cong: $cmd" }
    } catch {
        Write-Warn "Tao symlink that bai (khong nghiem trong): $($_.Exception.Message)"
        Write-Info "Chay thu cong: cmd /c mklink /d `"$oldPath`" `"$newPath`""
    }
    Write-Host ""
    Write-Host "======================================================================" -ForegroundColor Green
    Write-Host "  HOAN TAT THUC THI! Hay RESTART va dang nhap bang `"$NewName`" de test." -ForegroundColor Green
    Write-Host "  Neu loi -> dang nhap Administrator khac va rollback theo huong dan tren." -ForegroundColor Yellow
    Write-Host "======================================================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host " >> De thuc thi tu dong (sau khi da tao Restore Point + dang xuat $OldName):" -ForegroundColor Magenta
    Write-Host "    .\rename-profile-advanced.ps1 -OldName `"$OldName`" -NewName `"$NewName`" -Execute" -ForegroundColor White
    Write-Host " >> An toan hon: lam thu cong tung lenh o tren." -ForegroundColor Gray
}

# --- Kiem tra cuoi ---
Write-Host ""
Write-Step "Kiem tra cuoi (Get-LocalUser | Select Name,SID):"
try { Get-LocalUser | Select-Object Name, FullName, SID | Format-Table -AutoSize | Out-String | Write-Host -ForegroundColor Gray } catch {}

