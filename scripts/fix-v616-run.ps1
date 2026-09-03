# fix-v616-run.ps1 - Fix v6.16 chay 1 luc roi thoat sau khi doi Dang->Hai Dang
# Chay voi quyen Administrator: Right-click PowerShell -> Run as Administrator
# Giai quyet: USERPROFILE=C:\Users\Dang lech voi C:\Users\Hai Dang, duong dan co dau cach, EPERM

param(
    [switch]$MoveWorkspace,
    [string]$NewWorkspace = "C:\agentforge-workspace"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Write-Host "=== FIX v6.16 CHAY 1 LUC ROI THOAT ===" -ForegroundColor Cyan
Write-Host "USERPROFILE=$env:USERPROFILE USERNAME=$env:USERNAME HOMEDIR=$(node -e `"console.log(require('os').homedir())`" 2>$null)"
Write-Host "Registry ProfileImagePath:" -ForegroundColor Yellow
Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\*" | Where-Object { $_.ProfileImagePath -like "*Dang*" } | Format-Table PSChildName,ProfileImagePath -AutoSize

# PHUONG AN 1: Chay voi Admin + tuong thich duong dan co dau cach
Write-Host "`n[PHUONG AN 1] Chay v6.16 voi Admin va kiem tra quyen data/tmp" -ForegroundColor Green
Write-Host "  Dang chay voi Admin? $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
try {
    $testFile = "C:\Users\Hai Dang\test-agentforge thoi\data\tmp\fix-perm-test.txt"
    "ok" | Out-File -LiteralPath $testFile -ErrorAction Stop
    Remove-Item -LiteralPath $testFile -Force
    Write-Host "  -> Ghi data/tmp: OK (khong EPERM)" -ForegroundColor Green
} catch {
    Write-Host "  -> Ghi data/tmp: FAIL EPERM $_" -ForegroundColor Red
    Write-Host "  -> FIX: icacls grant" -ForegroundColor Yellow
    icacls "C:\Users\Hai Dang\test-agentforge thoi\data" /grant "Hai Dang:(OI)(CI)F" /T 2>&1 | Select-Object -First 5
    icacls "C:\Users\Hai Dang\test-agentforge thoi\data\tmp" /grant "Hai Dang:(OI)(CI)F" /T 2>&1 | Select-Object -First 5
}

# PHUONG AN 2: Tao symlink de app cu van chay neu hardcode C:\Users\Dang
Write-Host "`n[PHUONG AN 2] Tao symlink/mklink neu can (C:\Users\Dang -> Hai Dang)" -ForegroundColor Green
if (Test-Path "C:\Users\Dang") {
    Write-Host "  C:\Users\Dang ton tai (profile goc) - khong can symlink" -ForegroundColor Gray
    Write-Host "  Luu y: USERPROFILE van tro ve Dang, app dung os.homedir() se ve Dang/AppData" -ForegroundColor Yellow
} else {
    Write-Host "  Tao junction: mklink /J C:\Users\Dang C:\Users\Hai Dang" -ForegroundColor Yellow
    cmd /c "mklink /J `"C:\Users\Dang`" `"C:\Users\Hai Dang`"" 2>&1
}

# PHUONG AN 3: Doi workspace tranh dau cach (KHUYEN NGHI neu van loi)
Write-Host "`n[PHUONG AN 3] Doi workspace tranh dau cach (an toan dai han)" -ForegroundColor Green
Write-Host "  Hien tai: C:\Users\Hai Dang\test-agentforge thoi (co dau cach)"
Write-Host "  De xuat:  $NewWorkspace (khong dau cach, khong EPERM)"
if ($MoveWorkspace) {
    if (-not (Test-Path $NewWorkspace)) { New-Item -ItemType Directory -Path $NewWorkspace -Force | Out-Null }
    Write-Host "  Dang copy workspace..." -ForegroundColor Yellow
    robocopy "C:\Users\Hai Dang\test-agentforge thoi" $NewWorkspace /E /XD ".opencode\node_modules" ".stfolder" /XF "*.log" /NFL /NDL /NJH /NJS
    Write-Host "  -> Da copy sang $NewWorkspace" -ForegroundColor Green
    Write-Host "  Chay thu: $NewWorkspace\agentforge-web-build-v6.16.exe" -ForegroundColor Cyan
} else {
    Write-Host "  (Chua copy) Chay voi -MoveWorkspace de thuc hien:" -ForegroundColor Gray
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\fix-v616-run.ps1 -MoveWorkspace" -ForegroundColor Gray
    Write-Host "  Hoac thu cong: robocopy `"C:\Users\Hai Dang\test-agentforge thoi`" `"C:\agentforge-workspace`" /E /XD node_modules"
}

Write-Host "`n=== HUONG DAN CHAY v6.16 ON DINH ===" -ForegroundColor Cyan
Write-Host "1. Luon chay bang Run as Administrator (fix EPERM data/tmp)"
Write-Host "2. Dung Shortcut da sua: Target = `"C:\Users\Hai Dang\test-agentforge thoi\agentforge-web-build-v6.16.exe`" Start in = `"C:\Users\Hai Dang\test-agentforge thoi`""
Write-Host "3. Neu van thoat: doi workspace sang C:\agentforge-workspace (khong dau cach)"
Write-Host "4. State json hien tai: Hai Dang 3.1MB (233 history) vs Dang 30MB (5556 history) - khong dong bo, dung Hai Dang"

# Kill stale processes option
Write-Host "`n=== PROCESS HIEN TAI ===" -ForegroundColor Yellow
Get-Process | Where-Object { $_.ProcessName -like "*agentforge*" } | Format-Table Id,ProcessName,StartTime,WorkingSet -AutoSize
Write-Host "De kill va chay lai: Stop-Process -Name agentforge-web-build-v6.16 -Force; Start-Process `"C:\Users\Hai Dang\test-agentforge thoi\agentforge-web-build-v6.16.exe`" -WorkingDirectory `"C:\Users\Hai Dang\test-agentforge thoi`" -Verb RunAs"
