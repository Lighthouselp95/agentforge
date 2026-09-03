<#
.SYNOPSIS
    Doi ten hien thi (Display Name / FullName) va username Local an toan - Cap 1.

.DESCRIPTION
    Script an toan 100% - chi doi ten hien thi, KHONG doi thu muc C:\Users.
    Dung Get-LocalUser / Set-LocalUser / Rename-LocalUser.
    Tuong thich Windows 10/11 PowerShell 5.1+.

.PARAMETER OldName
    Ten dang nhap cu (Name hien tai). VD: "Hai Dang"

.PARAMETER NewName
    Ten dang nhap moi (neu muon doi ca username). De trong neu chi doi FullName.
    VD: "DangHai"

.PARAMETER FullName
    Ten hien thi day du (FullName). VD: "Hai Dang" hoac "Nguyen Hai Dang"

.EXAMPLE
    # Chi doi FullName (khuyen dung - an toan nhat)
    .\rename-displayname.ps1 -OldName "Hai Dang" -FullName "Hai Dang"

.EXAMPLE
    # Doi ca username + FullName
    .\rename-displayname.ps1 -OldName "Hai Dang" -NewName "DangHai" -FullName "Dang Hai"

.EXAMPLE
    # Chay voi quyen Admin (BAT BUOC)
    powershell -ExecutionPolicy Bypass -File .\rename-displayname.ps1 -OldName "Hai Dang" -NewName "DangHai" -FullName "Dang Hai"

.NOTES
    - BAT BUOC chay PowerShell voi "Run as Administrator".
    - Khong lam mat du lieu, khong can doi C:\Users.
    - Sau khi doi, restart may de ap dung.
    - Ho tro ten co dau cach (dat trong dau nhay kep).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true, HelpMessage = "Ten dang nhap hien tai")]
    [ValidateNotNullOrEmpty()]
    [string]$OldName = "Hai Dang",

    [Parameter(Mandatory = $false, HelpMessage = "Ten dang nhap moi - de trong neu chi doi FullName")]
    [AllowEmptyString()]
    [string]$NewName = "",

    [Parameter(Mandatory = $false, HelpMessage = "Ten hien thi day du")]
    [ValidateNotNullOrEmpty()]
    [string]$FullName = "Hai Dang"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Mau sac ---
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "[OK]   $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "[ERR]  $Msg" -ForegroundColor Red }

# --- Banner & Huong dan Admin ---
Write-Host "============================================================" -ForegroundColor White
Write-Host "  rename-displayname.ps1 - Doi ten hien thi an toan (Cap 1)" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor White
Write-Host ""
Write-Host " HUONG DAN CHAY ADMIN:" -ForegroundColor Yellow
Write-Host "  1. Chuot phai vao PowerShell -> Run as Administrator" -ForegroundColor Gray
Write-Host "  2. cd `"$PSScriptRoot`"" -ForegroundColor Gray
Write-Host "  3. powershell -ExecutionPolicy Bypass -File .\rename-displayname.ps1 -OldName `"Hai Dang`" -FullName `"Hai Dang`"" -ForegroundColor Gray
Write-Host "  Hoac: .\rename-displayname.ps1 -OldName `"Hai Dang`" -NewName `"DangHai`" -FullName `"Dang Hai`"" -ForegroundColor Gray
Write-Host ""

# --- 1. Kiem tra quyen Admin ---
Write-Step "Kiem tra quyen Administrator..."
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "Ban CHUA chay PowerShell voi quyen Administrator!"
    Write-Host "  -> Chuot phai PowerShell -> Run as Administrator roi chay lai." -ForegroundColor Yellow
    Write-Host "  -> Hoac chay: Start-Process powershell -Verb RunAs -ArgumentList `"-ExecutionPolicy Bypass -File `"$PSCommandPath`" -OldName `"$OldName`" -NewName `"$NewName`" -FullName `"$FullName`"`"" -ForegroundColor Gray
    exit 1
}
Write-Ok "Da chay voi quyen Administrator."

# --- 2. Kiem tra he dieu hanh & module ---
Write-Step "Kiem tra Microsoft.PowerShell.LocalAccounts..."
try {
    Import-Module Microsoft.PowerShell.LocalAccounts -ErrorAction Stop
    Write-Ok "Module LocalAccounts san sang."
} catch {
    Write-Err "Khong the load module LocalAccounts: $($_.Exception.Message)"
    Write-Host "  -> Chi ho tro Windows 10/11 Pro/Enterprise (khong ho tro Home Single Language cu)." -ForegroundColor Yellow
    exit 1
}

# --- 3. Tim user cu ---
Write-Step "Tim user OldName=`"$OldName`"..."
$user = $null
try {
    $user = Get-LocalUser -Name $OldName -ErrorAction Stop
} catch {
    Write-Err "Khong tim thay user `"$OldName`". Danh sach user hien co:"
    try {
        Get-LocalUser | Select-Object Name, FullName, Enabled, SID | Format-Table -AutoSize | Out-String | Write-Host -ForegroundColor Yellow
        Write-Host "  Goi y: Kiem tra lai ten, ten co the phan biet dau cach. Dung: Get-LocalUser | Select Name,FullName" -ForegroundColor Gray
    } catch {}
    Write-Host "  Loi chi tiet: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
Write-Ok "Tim thay user: Name=`"$($user.Name)`" FullName=`"$($user.FullName)`" SID=$($user.SID) Enabled=$($user.Enabled)"

# --- 4. Doi FullName (Set-LocalUser) ---
if ($PSBoundParameters.ContainsKey('FullName') -or $FullName -ne "") {
    # Chi doi neu khac gia tri hien tai
    if ($user.FullName -ne $FullName) {
        Write-Step "Doi FullName tu `"$($user.FullName)`" -> `"$FullName`"..."
        if ($PSCmdlet.ShouldProcess($OldName, "Set FullName to $FullName")) {
            try {
                Set-LocalUser -Name $OldName -FullName $FullName -ErrorAction Stop
                Write-Ok "Da doi FullName thanh `"$FullName`" (Set-LocalUser)."
            } catch {
                Write-Err "Set-LocalUser that bai: $($_.Exception.Message)"
                exit 1
            }
        }
    } else {
        Write-Warn "FullName da la `"$FullName`" -> bo qua Set-LocalUser."
    }
}

# --- 5. Doi username (Rename-LocalUser) neu co NewName ---
$trimmedNewName = $NewName.Trim()
if (-not [string]::IsNullOrWhiteSpace($trimmedNewName) -and $trimmedNewName -ne $OldName) {
    # Validate ten moi
    if ($trimmedNewName.Length -gt 20) { Write-Warn "Ten moi dai >20 ky tu co the bi cat ngan boi Windows." }
    if ($trimmedNewName -match '[\\/:*?"<>|]') {
        Write-Err "NewName `"$trimmedNewName`" chua ky tu khong hop le \ / : * ? `" < > |"
        exit 1
    }
    # Kiem tra trung ten
    $existing = $null
    try { $existing = Get-LocalUser -Name $trimmedNewName -ErrorAction SilentlyContinue } catch {}
    if ($null -ne $existing) {
        Write-Err "Ten moi `"$trimmedNewName`" da ton tai! Chon ten khac."
        exit 1
    }
    Write-Step "Doi username (Rename-LocalUser) `"$OldName`" -> `"$trimmedNewName`"..."
    if ($PSCmdlet.ShouldProcess("$OldName -> $trimmedNewName", "Rename-LocalUser")) {
        try {
            Rename-LocalUser -Name $OldName -NewName $trimmedNewName -ErrorAction Stop
            Write-Ok "Da doi username thanh `"$trimmedNewName`" (Rename-LocalUser)."
            # Cap nhat OldName de hien thi dung
            $OldName = $trimmedNewName
        } catch {
            Write-Err "Rename-LocalUser that bai: $($_.Exception.Message)"
            Write-Host "  -> Co the user dang dang nhap, hay dang xuat/khoi dong lai roi thu lai." -ForegroundColor Yellow
            exit 1
        }
    }
} elseif (-not [string]::IsNullOrWhiteSpace($trimmedNewName) -and $trimmedNewName -eq $OldName) {
    Write-Warn "NewName trung OldName -> bo qua Rename-LocalUser."
} else {
    Write-Step "Khong doi username (chi doi FullName) - an toan nhat."
}

# --- 6. Xac nhan ket qua ---
Write-Step "Xac nhan ket qua..."
try {
    $finalName = if (-not [string]::IsNullOrWhiteSpace($trimmedNewName) -and $trimmedNewName -ne "") { $trimmedNewName } else { $OldName }
    $finalUser = Get-LocalUser -Name $finalName -ErrorAction Stop
    Write-Ok "Ket qua: Name=`"$($finalUser.Name)`" FullName=`"$($finalUser.FullName)`" SID=$($finalUser.SID)"
} catch {
    Write-Warn "Khong the xac nhan lai user: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  HOAN TAT! Vui long RESTART may de ap dung ten moi." -ForegroundColor Green
Write-Host "  Kiem tra: netplwiz hoac Get-LocalUser | Select Name,FullName" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Green
