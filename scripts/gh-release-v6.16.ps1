<#
.SYNOPSIS
    Release v6.16 khong server - gh release create, upload exe, tao source zip, check gh auth.

.DESCRIPTION
    Script tao GitHub Release v6.16 hoan toan local (khong server):
      - Kiem tra gh CLI da cai va da auth (khong hardcode token - dung gh auth login)
      - Kiem tra file exe v6.16 ton tai
      - Tao source zip (Compress-Archive) loai tru exe/node_modules/.git/.stfolder/.opencode/node_modules
      - Tao GitHub Release bang `gh release create` va upload exe + zip
    Tuong thich PowerShell 5.1+, chay o bat ky thu muc nao trong repo.

.PARAMETER Tag
    Tag release, mac dinh v6.16

.PARAMETER Title
    Tieu de release, mac dinh "AgentForge v6.16"

.PARAMETER Repo
    Repo dang owner/repo, de trong se tu lay tu git remote origin (neu co).

.PARAMETER ExePath
    Duong dan exe chinh, mac dinh agentforge-web-build-v6.16.exe o thu muc goc repo.

.PARAMETER ServeExePath
    Duong dan exe serve, mac dinh agentforge-web-build-v6.16-serve.exe o goc repo.

.PARAMETER Notes
    Ghi chu release, neu khong truyen se dung noi dung mac dinh.

.PARAMETER NotesFile
    File chua release notes (uu tien hon Notes).

.PARAMETER Draft
    Tao release dang draft.

.PARAMETER Prerelease
    Danh dau prerelease.

.PARAMETER SkipSourceZip
    Bo qua tao source zip.

.PARAMETER SourceZipPath
    Duong dan file zip dich, mac dinh agentforge-v6.16-source.zip o goc repo.

.PARAMETER GenerateNotes
    Them --generate-notes vao gh release create.

.PARAMETER DryRun
    Chi in lenh se chay, khong thuc thi gh.

.EXAMPLE
    # Chuan bi + tao release (can da gh auth login truoc)
    .\scripts\gh-release-v6.16.ps1

.EXAMPLE
    # Xem truoc khong thuc thi
    .\scripts\gh-release-v6.16.ps1 -DryRun -Verbose

.EXAMPLE
    # Chi tao source zip khong release
    .\scripts\gh-release-v6.16.ps1 -DryRun -SkipSourceZip:$false  # hoac tach logic zip

.EXAMPLE
    # Chi dinh repo
    .\scripts\gh-release-v6.16.ps1 -Repo "myorg/agentforge"

.NOTES
    - KHONG hardcode token: xac thuc qua `gh auth login` va `gh auth status`.
    - Khong yeu cau server: chay hoan toan local, chi can gh CLI.
    - Can cai gh CLI: https://cli.github.com/  (winget install --id GitHub.cli)
    - Dang nhap: gh auth login  -> chon GitHub.com -> HTTPS -> Yes -> Paste token hoac browser flow
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$Tag = "v6.16",

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string]$Title = "AgentForge v6.16",

    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string]$Repo = "",

    [Parameter(Mandatory = $false)]
    [string]$ExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$ServeExePath = "",

    [Parameter(Mandatory = $false)]
    [string]$Notes = "",

    [Parameter(Mandatory = $false)]
    [string]$NotesFile = "",

    [switch]$Draft,

    [switch]$Prerelease,

    [switch]$SkipSourceZip,

    [Parameter(Mandatory = $false)]
    [string]$SourceZipPath = "",

    [switch]$GenerateNotes,

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Helpers ---
function Write-Step { param([string]$Msg) Write-Host "[STEP] $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "[OK]   $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "[ERR]  $Msg" -ForegroundColor Red }
function Write-Info { param([string]$Msg) Write-Host "       $Msg" -ForegroundColor Gray }

# --- Resolve repo root (thu muc chua scripts/) ---
$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ScriptDir)) { $ScriptDir = Split-Path -Parent $PSCommandPath }
$RepoRoot = Split-Path -Parent $ScriptDir
# Fallback neu chay tu goc repo
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "scripts"))) {
    # co the RepoRoot chinh la current dir
    $RepoRoot = (Get-Location).Path
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "scripts"))) {
        # cuoi cung dung ScriptDir's parent
        $RepoRoot = Split-Path -Parent $ScriptDir
    }
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
Write-Info "RepoRoot: $RepoRoot"
Write-Info "Tag: $Tag | Title: $Title | DryRun: $DryRun"

# --- Mac dinh duong dan ---
if ([string]::IsNullOrWhiteSpace($ExePath)) {
    $ExePath = Join-Path $RepoRoot "agentforge-web-build-v6.16.exe"
}
if ([string]::IsNullOrWhiteSpace($ServeExePath)) {
    $ServeExePath = Join-Path $RepoRoot "agentforge-web-build-v6.16-serve.exe"
}
if ([string]::IsNullOrWhiteSpace($SourceZipPath)) {
    $SourceZipPath = Join-Path $RepoRoot "agentforge-v6.16-source.zip"
}
if ([string]::IsNullOrWhiteSpace($Notes) -and [string]::IsNullOrWhiteSpace($NotesFile)) {
    $Notes = @"
## AgentForge v6.16

- Build: agentforge-web-build-v6.16.exe + agentforge-web-build-v6.16-serve.exe
- Khong server: chay local, khong phu thuoc server ngoai
- Source zip dinh kem de kiem chung

### Cai dat
1. Tai file exe phien ban tuong ung
2. Chay truc tiep (khong can cai dat)

### Xac minh
````powershell
Get-FileHash .\agentforge-web-build-v6.16.exe -Algorithm SHA256
Get-FileHash .\agentforge-web-build-v6.16-serve.exe -Algorithm SHA256
````
"@
}

# --- Banner ---
Write-Host "======================================================================" -ForegroundColor White
Write-Host "  gh-release v6.16 - Khong server (gh CLI)" -ForegroundColor White
Write-Host "======================================================================" -ForegroundColor White
Write-Host "  Tag: $Tag | Title: $Title" -ForegroundColor Gray
if ($Repo) { Write-Host "  Repo: $Repo" -ForegroundColor Gray } else { Write-Host "  Repo: (auto tu git remote)" -ForegroundColor Gray }
Write-Host "  Exe: $ExePath" -ForegroundColor Gray
Write-Host "  ServeExe: $ServeExePath" -ForegroundColor Gray
Write-Host "  SourceZip: $SourceZipPath" -ForegroundColor Gray
if ($DryRun) { Write-Host "  CHE DO: DryRun (chi in lenh, khong tao release)" -ForegroundColor Magenta }
Write-Host "======================================================================" -ForegroundColor White
Write-Host ""

# --- 1. Kiem tra gh CLI ---
Write-Step "1/6 Kiem tra gh CLI..."
$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
$ghAvailable = $null -ne $ghCmd
if (-not $ghAvailable) {
    if ($DryRun) {
        Write-Warn "Khong tim thay 'gh' CLI trong PATH - DryRun: tiep tuc mo phong (se bao loi khi chay that)."
        Write-Info "Cai dat: winget install --id GitHub.cli  hoac https://cli.github.com/"
    } else {
        Write-Err "Khong tim thay 'gh' CLI trong PATH!"
        Write-Info "Cai dat: winget install --id GitHub.cli  hoac https://cli.github.com/"
        Write-Info "Kiem tra: gh --version"
        exit 1
    }
} else {
    try {
        $ghVer = & gh --version 2>&1 | Out-String
        Write-Ok "gh CLI: $($ghVer.Trim().Split("`n")[0])"
        Write-Info "Path: $($ghCmd.Source)"
    } catch {
        if ($DryRun) { Write-Warn "Loi chay gh --version (DryRun bo qua): $($_.Exception.Message)" }
        else { Write-Err "Loi chay gh --version: $($_.Exception.Message)"; exit 1 }
    }
}

# --- 2. Kiem tra gh auth (KHONG hardcode token) ---
Write-Step "2/6 Kiem tra gh auth (khong hardcode token)..."
# Tuyen bo ro: khong doc token tu code/env hardcode
$hasHardcodedToken = $false
# (chi kiem tra bien moi truong co GITHUB_TOKEN thi canh bao dung hardcode trong script)
if ($env:GITHUB_TOKEN -or $env:GH_TOKEN) {
    Write-Warn "Phat hien env GITHUB_TOKEN/GH_TOKEN dang set - gh CLI se tu dung, khong can hardcode trong script."
    Write-Info "Neu muon dung token rieng, hay dung: gh auth login  (khuyen dung browser flow)"
}
if (-not $ghAvailable) {
    if ($DryRun) {
        Write-Warn "[DryRun] Bo qua gh auth status vi gh CLI chua cai (khi chay that se kiem tra)."
    } else {
        Write-Err "Khong the kiem tra gh auth vi gh CLI chua cai!"
        exit 1
    }
} else {
    try {
        $authOut = & gh auth status 2>&1 | Out-String
        $authExit = $LASTEXITCODE
        Write-Host $authOut -ForegroundColor Gray
        if ($authExit -ne 0) {
            if ($DryRun) {
                Write-Warn "[DryRun] gh chua dang nhap (exit $authExit) - khi chay that can: gh auth login"
            } else {
                Write-Err "gh chua dang nhap (gh auth status exit $authExit)!"
                Write-Info "Dang nhap ngay:"
                Write-Info "  gh auth login  # chon GitHub.com -> HTTPS -> Yes -> Authenticate via browser hoac paste token"
                Write-Info "  gh auth status # kiem tra lai"
                Write-Info "Tuyet doi KHONG hardcode token trong script - chi dung gh auth."
                exit 1
            }
        } else {
            Write-Ok "gh da xac thuc (gh auth status OK)."
        }
    } catch {
        if ($DryRun) { Write-Warn "[DryRun] Loi kiem tra gh auth status (bo qua): $($_.Exception.Message)" }
        else { Write-Err "Loi kiem tra gh auth status: $($_.Exception.Message)"; Write-Info "Chay: gh auth login"; exit 1 }
    }
}

# --- 2b. Xac dinh Repo neu chua truyen ---
if ([string]::IsNullOrWhiteSpace($Repo)) {
    Write-Info "Thu lay repo tu git remote origin..."
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($null -ne $gitCmd) {
        try {
            $remoteUrl = & git -C $RepoRoot remote get-url origin 2>&1 | Out-String
            $remoteUrl = $remoteUrl.Trim()
            if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($remoteUrl)) {
                Write-Info "git remote origin: $remoteUrl"
                # Parse owner/repo tu URL dang https://github.com/owner/repo.git hoac git@github.com:owner/repo.git
                if ($remoteUrl -match 'github\.com[:/]([^/]+)/([^/]+?)(\.git)?\s*$') {
                    $Repo = "$($Matches[1])/$($Matches[2])"
                    Write-Ok "Repo tu dong: $Repo"
                } else {
                    Write-Warn "Khong parse duoc owner/repo tu remote URL, se dung repo hien tai cua gh (can chay trong repo git)."
                }
            } else {
                Write-Warn "Khong lay duoc git remote origin (co the chua init git). Se de gh tu suy repo."
            }
        } catch {
            Write-Warn "Loi lay git remote: $($_.Exception.Message) - bo qua, de gh tu suy repo."
        }
    } else {
        Write-Warn "Khong tim thay git trong PATH - bo qua auto-detect repo, gh se dung repo hien tai neu chay trong thu muc git."
    }
}
$repoArgs = @()
if (-not [string]::IsNullOrWhiteSpace($Repo)) { $repoArgs = @("--repo", $Repo) }

# --- 3. Kiem tra file exe ---
Write-Step "3/6 Kiem tra file exe v6.16..."
$filesToUpload = @()
foreach ($p in @($ExePath, $ServeExePath)) {
    if ([string]::IsNullOrWhiteSpace($p)) { continue }
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Err "Khong tim thay file: $p"
        Write-Info "Kiem tra lai ten file trong thu muc goc:"
        try { Get-ChildItem -LiteralPath $RepoRoot -Filter "agentforge-web-build-v6.16*" | ForEach-Object { Write-Info "  $($_.Name) ($([math]::Round($_.Length/1MB,2)) MB)" } } catch {}
        exit 1
    }
    $fi = Get-Item -LiteralPath $p
    $hash = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
    Write-Ok "Tim thay: $($fi.Name) ($([math]::Round($fi.Length/1MB,2)) MB) SHA256=$hash"
    $filesToUpload += $p
}
if ($filesToUpload.Count -eq 0) {
    Write-Err "Khong co file exe nao de upload!"
    exit 1
}

# --- 4. Tao source zip ---
Write-Step "4/6 Tao source zip (loai tru exe/node_modules/.git/.stfolder)..."
if ($SkipSourceZip) {
    Write-Warn "Bo qua tao source zip theo yeu cau (-SkipSourceZip)."
} else {
    # Xoa zip cu neu co (de ghi de sach)
    if (Test-Path -LiteralPath $SourceZipPath) {
        Write-Warn "Xoa zip cu: $SourceZipPath"
        if (-not $DryRun) { Remove-Item -LiteralPath $SourceZipPath -Force -ErrorAction SilentlyContinue }
    }

    # Dinh nghia exclude patterns
    $excludeDirs = @(".git", ".stfolder", "node_modules", ".opencode\node_modules", "__pycache__", ".venv", "dist", "build", ".next", "out")
    $excludeFiles = @("*.exe", "*.lnk", "*.zip", "*.tmp", "*.bak", ".DS_Store", "Thumbs.db")
    # Staging dir tam
    $stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("agentforge-v6.16-stage-" + [Guid]::NewGuid().ToString("N").Substring(0,8))
    $stageDir = Join-Path $stagingRoot "agentforge-v6.16"
    try {
        if ($DryRun) {
            Write-Info "[DryRun] Se tao staging: $stageDir"
            Write-Info "[DryRun] Se copy tu $RepoRoot loai tru: $($excludeDirs -join ', ') + $($excludeFiles -join ', ')"
            Write-Info "[DryRun] Se nen: $stageDir -> $SourceZipPath"
        } else {
            New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
            Write-Info "Staging: $stageDir"

            # Copy co loc - dung robocopy neu co, fallback sang Copy-Item filter
            $hasRobocopy = $null -ne (Get-Command robocopy -ErrorAction SilentlyContinue)
            if ($hasRobocopy) {
                # robocopy exclude dirs/files
                $xdArgs = @()
                foreach ($d in $excludeDirs) { $xdArgs += "/XD"; $xdArgs += $d }
                # robocopy /XF cho file pattern - can truyen rieng
                $xfArgs = @()
                foreach ($f in $excludeFiles) { $xfArgs += "/XF"; $xfArgs += $f }
                # /E copy subdirs inc empty, /NFL /NDL giam log, /NJH /NJS
                $rcArgs = @($RepoRoot, $stageDir, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/R:1", "/W:1") + $xdArgs + $xfArgs
                # Loai tru them .opencode/node_modules rieng (robocopy XD chi match ten thu muc)
                # Da cover bang node_modules, nhung van them
                Write-Info "Copy bang robocopy (loai tru)..."
                $rcOut = & robocopy @rcArgs 2>&1 | Out-String
                $rcExit = $LASTEXITCODE
                # robocopy exit 0-7 la thanh cong, >=8 la loi
                if ($rcExit -ge 8) {
                    Write-Err "robocopy that bai exit=$rcExit : $rcOut"
                    throw "robocopy failed"
                }
            } else {
                Write-Info "Copy bang PowerShell (fallback, co the cham)..."
                Get-ChildItem -LiteralPath $RepoRoot -Force | ForEach-Object {
                    $name = $_.Name
                    if ($excludeDirs -contains $name) { Write-Info "  Skip dir: $name"; return }
                    if ($excludeFiles | Where-Object { $name -like $_ }) { Write-Info "  Skip file: $name"; return }
                    $dest = Join-Path $stageDir $name
                    try {
                        if ($_.PSIsContainer) {
                            Copy-Item -LiteralPath $_.FullName -Destination $dest -Recurse -Force -Exclude $excludeFiles -ErrorAction SilentlyContinue
                        } else {
                            Copy-Item -LiteralPath $_.FullName -Destination $dest -Force -ErrorAction SilentlyContinue
                        }
                    } catch { Write-Warn "Skip $($_.FullName): $($_.Exception.Message)" }
                }
                # Xoa them node_modules sau copy neu lot
                Get-ChildItem -LiteralPath $stageDir -Recurse -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "node_modules" -or $_.Name -eq ".git" -or $_.Name -eq ".stfolder" } | ForEach-Object {
                    Write-Info "  Remove lotted: $($_.FullName)"
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
            }

            # Dam bao staging khong rong
            $count = (Get-ChildItem -LiteralPath $stageDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
            if ($count -eq 0) { throw "Staging rong - khong co file de zip (kiem tra exclude)!" }
            Write-Ok "Staging co $count file."

            # Nen zip - dung Compress-Archive
            Write-Info "Nen zip: $stageDir -> $SourceZipPath"
            # Dam bao thu muc dich ton tai
            $zipDir = Split-Path -Parent $SourceZipPath
            if (-not (Test-Path -LiteralPath $zipDir)) { New-Item -ItemType Directory -Path $zipDir -Force | Out-Null }
            Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $SourceZipPath -Force
            $zipInfo = Get-Item -LiteralPath $SourceZipPath
            $zipHash = (Get-FileHash -LiteralPath $SourceZipPath -Algorithm SHA256).Hash
            Write-Ok "Da tao source zip: $($zipInfo.Name) ($([math]::Round($zipInfo.Length/1MB,2)) MB) SHA256=$zipHash"
            $filesToUpload += $SourceZipPath
        }
        if ($DryRun) {
            # DryRun van them zip vao danh sach upload de hien thi lenh
            $filesToUpload += $SourceZipPath
        }
    } catch {
        Write-Err "Tao source zip that bai: $($_.Exception.Message)"
        Write-Info "Thu tao thu cong:"
        Write-Info "  Compress-Archive -Path .\scripts,.\windows-rename-guide.md -DestinationPath .\agentforge-v6.16-source.zip -Force"
        exit 1
    } finally {
        if (-not $DryRun -and (Test-Path -LiteralPath $stagingRoot)) {
            Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if ($DryRun -and $SkipSourceZip -eq $false) {
        Write-Info "[DryRun] Se upload them source zip sau khi tao."
    }
}

# --- 5. Kiem tra release da ton tai chua ---
Write-Step "5/6 Kiem tra release tag da ton tai..."
$releaseExists = $false
if (-not $ghAvailable) {
    Write-Warn "[DryRun] Bo qua kiem tra release view vi gh CLI chua cai - gia dinh chua ton tai."
} else {
    try {
        $viewArgs = @("release", "view", $Tag) + $repoArgs
        $viewOut = & gh @viewArgs 2>&1 | Out-String
        $viewExit = $LASTEXITCODE
        if ($viewExit -eq 0) {
            $releaseExists = $true
            Write-Warn "Release $Tag da ton tai!"
            Write-Info $viewOut
            Write-Info "Se dung 'gh release upload --clobber' de cap nhat file."
        } else {
            Write-Ok "Release $Tag chua ton tai -> se tao moi."
            if ($DryRun) { Write-Info "[DryRun] Chi tiet view: $($viewOut.Trim())" }
        }
    } catch {
        Write-Warn "Khong the kiem tra release view: $($_.Exception.Message) - se thu tao moi."
    }
}

# --- 6. Tao release / upload ---
Write-Step "6/6 Tao release va upload file..."
# Build args
$createArgs = @("release", "create", $Tag) + $repoArgs
$createArgs += @("--title", $Title)
if (-not [string]::IsNullOrWhiteSpace($NotesFile) -and (Test-Path -LiteralPath $NotesFile)) {
    $createArgs += @("--notes-file", $NotesFile)
} elseif (-not [string]::IsNullOrWhiteSpace($Notes)) {
    $createArgs += @("--notes", $Notes)
}
if ($Draft) { $createArgs += "--draft" }
if ($Prerelease) { $createArgs += "--prerelease" }
if ($GenerateNotes) { $createArgs += "--generate-notes" }
# Them file upload vao create neu chua ton tai
# Neu DryRun hoac ShouldProcess thi in ra

function Invoke-Gh {
    param([string[]]$GhArgs, [string]$Desc)
    $cmdStr = "gh " + (($GhArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join " ")
    Write-Host "  > $cmdStr" -ForegroundColor White
    Write-Info $Desc
    if ($DryRun) {
        Write-Warn "[DryRun] Bo qua thuc thi."
        return 0
    }
    if ($PSCmdlet.ShouldProcess($cmdStr, "Thuc thi gh")) {
        & gh @GhArgs
        $ec = $LASTEXITCODE
        if ($ec -ne 0) { throw "gh exit $ec" }
        return $ec
    }
    return 0
}

try {
    if (-not $releaseExists) {
        # Tao moi kem upload file
        $allCreateArgs = $createArgs + $filesToUpload
        Write-Info "Tao release moi $Tag voi $($filesToUpload.Count) file..."
        $null = Invoke-Gh -GhArgs $allCreateArgs -Desc "Tao release $Tag"
        Write-Ok "Da tao release $Tag thanh cong!"
    } else {
        # Da ton tai -> upload --clobber tung file
        if ($DryRun) {
            Write-Info "[DryRun] Se upload --clobber $($filesToUpload.Count) file vao release $Tag"
            foreach ($f in $filesToUpload) {
                $upArgs = @("release", "upload", $Tag) + $repoArgs + @($f, "--clobber")
                $null = Invoke-Gh -GhArgs $upArgs -Desc "Upload $f"
            }
        } else {
            foreach ($f in $filesToUpload) {
                if (-not (Test-Path -LiteralPath $f)) {
                    Write-Warn "Bo qua file khong ton tai (DryRun zip): $f"
                    continue
                }
                $upArgs = @("release", "upload", $Tag) + $repoArgs + @($f, "--clobber")
                Write-Info "Upload $f ..."
                $null = Invoke-Gh -GhArgs $upArgs -Desc "Upload $f vao $Tag"
                Write-Ok "Da upload $f"
            }
            Write-Ok "Da cap nhat release $Tag voi $($filesToUpload.Count) file!"
        }
    }

    # Hien thi view sau khi xong (neu khong DryRun)
    if (-not $DryRun) {
        Write-Info "Kiem tra lai release:"
        $viewArgs2 = @("release", "view", $Tag) + $repoArgs
        & gh @viewArgs2 | Out-String | Write-Host -ForegroundColor Gray
    } else {
        Write-Warn "[DryRun] Ket thuc dry-run, chua tao release thuc te."
        Write-Info "De tao that, chay lai khong co -DryRun:"
        Write-Info "  .\scripts\gh-release-v6.16.ps1 -Tag $Tag"
    }

} catch {
    Write-Err "Tao/upload release that bai: $($_.Exception.Message)"
    Write-Info "Kiem tra:"
    Write-Info "  gh auth status"
    Write-Info "  gh release view $Tag --repo <owner/repo>  # neu co repo"
    Write-Info "  gh release create $Tag --title `"$Title`" --notes `"...`" $($filesToUpload -join ' ')"
    Write-Info "Thu chay manual hoac them -Verbose -DryRun de debug."
    exit 1
}

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "  HOAN TAT gh-release v6.16" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
if (-not $DryRun -and -not $releaseExists) {
    $repoSuffix = if ($Repo) { " --repo $Repo" } else { "" }
    Write-Host "  Xem release: gh release view $Tag$repoSuffix" -ForegroundColor Gray
    Write-Host "  URL: https://github.com/<owner>/<repo>/releases/tag/$Tag" -ForegroundColor Gray
}
Write-Host "  File da upload:" -ForegroundColor Gray
foreach ($f in $filesToUpload) { Write-Host "    - $f" -ForegroundColor Gray }
Write-Host "  Khong hardcode token: dung gh auth login" -ForegroundColor Gray
Write-Host "======================================================================" -ForegroundColor Green
