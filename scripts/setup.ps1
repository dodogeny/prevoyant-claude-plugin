# setup.ps1 — Prevoyant one-shot prerequisite installer (Windows)
#
# Installs: uvx (Jira MCP), Node.js (budget tracking), pandoc (PDF reports)
# Also:     prompts for Jira credentials → writes .env, registers marketplace in settings.json
#
# Safe to re-run — skips anything already present.
# Run from the project root: .\scripts\setup.ps1
# If blocked by execution policy: Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
#
# QUICK INSTALL (single command — clone + setup):
#   git clone https://github.com/dodogeny/prevoyant-claude-plugin.git `
#     "$env:USERPROFILE\.claude\plugins\marketplaces\dodogeny"
#   & "$env:USERPROFILE\.claude\plugins\marketplaces\dodogeny\scripts\setup.ps1"

#Requires -Version 5.1

$SCRIPT_DIR   = Split-Path -Parent $MyInvocation.MyCommand.Path
$PROJECT_ROOT = Split-Path -Parent $SCRIPT_DIR
$ERRORS = 0

# ── helpers ───────────────────────────────────────────────────────────────────
function ok     { param($m) Write-Host "  OK   $m" -ForegroundColor Green }
function warn   { param($m) Write-Host "  WARN $m" -ForegroundColor Yellow }
function err    { param($m) Write-Host "  ERR  $m" -ForegroundColor Red; $script:ERRORS++ }
function step   { param($m) Write-Host "`n-- $m" -ForegroundColor Cyan }
function info   { param($m) Write-Host "       $m" }
function impact { param($m) Write-Host "       Impact: $m" -ForegroundColor Yellow }

function cmd_exists { param($c) return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

function refresh_path {
    $env:PATH = ($env:PATH + ";" +
        [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
        [System.Environment]::GetEnvironmentVariable("PATH", "User")) -replace ';;+', ';'
}

# ── header ────────────────────────────────────────────────────────────────────
Write-Host "`nPrevoyant -- Setup" -ForegroundColor White
Write-Host "Platform : Windows ($([System.Environment]::OSVersion.Version))"
Write-Host "Repo     : $PROJECT_ROOT"
Write-Host "======================================"

# ── 1. uvx (Jira MCP) ─────────────────────────────────────────────────────────
step "1/11  uvx  (Jira MCP server)  [required]"

if (cmd_exists 'uvx') {
    ok "uvx already installed"
} else {
    info "Installing uv / uvx via PowerShell installer..."
    try {
        $null = powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex" 2>&1
        refresh_path
        if (cmd_exists 'uvx') {
            ok "uvx installed ($((Get-Command uvx).Source))"
            info "Add to your profile: `$env:PATH += `";`$env:USERPROFILE\.local\bin`""
        } else {
            err "uvx installed but not found in PATH — restart PowerShell or open a new terminal"
            impact "Jira MCP server may not start until PATH is updated"
        }
    } catch {
        err "uvx installation failed: $_"
        impact "Jira MCP server disabled — ticket fetching and Jira integration will not work"
        info "Install manually: https://docs.astral.sh/uv/getting-started/installation/"
    }
}

# ── 2. Node.js (codeburn) ─────────────────────────────────────────────────────
step "2/11  Node.js  (budget tracking + Prevoyant Server)  [required]"

if (cmd_exists 'node') {
    ok "Node.js already installed ($(node --version 2>$null))"
} else {
    info "Node.js not found — installing..."
    $NODE_OK = $false

    if (-not $NODE_OK -and (cmd_exists 'winget')) {
        info "--> winget"
        try {
            winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements 2>&1 |
                Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'node') { $NODE_OK = $true }
        } catch { info "winget attempt failed: $_" }
    }

    if (-not $NODE_OK -and (cmd_exists 'choco')) {
        info "--> Chocolatey"
        try {
            choco install nodejs-lts -y 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'node') { $NODE_OK = $true }
        } catch { info "Chocolatey attempt failed: $_" }
    }

    if (-not $NODE_OK -and (cmd_exists 'scoop')) {
        info "--> Scoop"
        try {
            scoop install nodejs-lts 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'node') { $NODE_OK = $true }
        } catch { info "Scoop attempt failed: $_" }
    }

    if (cmd_exists 'node') {
        ok "Node.js installed ($(node --version 2>$null))"
    } else {
        err "Node.js installation failed. Install from https://nodejs.org then re-run setup."
        impact "Token budget tracking and Prevoyant Server unavailable until Node.js is installed"
    }
}

# ── 3. pandoc (PDF generation) ────────────────────────────────────────────────
step "3/11  pandoc  (PDF reports)  [optional — Chrome headless or HTML fallback]"

if (cmd_exists 'pandoc') {
    ok "pandoc already installed ($(pandoc --version 2>$null | Select-Object -First 1))"
} else {
    info "Installing pandoc..."
    $PANDOC_OK = $false

    if (-not $PANDOC_OK -and (cmd_exists 'winget')) {
        info "--> winget"
        try {
            winget install --id JohnMacFarlane.Pandoc --silent --accept-package-agreements --accept-source-agreements 2>&1 |
                Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'pandoc') { $PANDOC_OK = $true }
        } catch { info "winget attempt failed: $_" }
    }

    if (-not $PANDOC_OK -and (cmd_exists 'choco')) {
        info "--> Chocolatey"
        try {
            choco install pandoc -y 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'pandoc') { $PANDOC_OK = $true }
        } catch { info "Chocolatey attempt failed: $_" }
    }

    if (-not $PANDOC_OK -and (cmd_exists 'scoop')) {
        info "--> Scoop"
        try {
            scoop install pandoc 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'pandoc') { $PANDOC_OK = $true }
        } catch { info "Scoop attempt failed: $_" }
    }

    if (cmd_exists 'pandoc') {
        ok "pandoc installed"
    } else {
        warn "pandoc not installed — PDF reports will fall back to Chrome headless or HTML."
        impact "Reports still generated — quality may be lower without pandoc"
        info "Install manually: winget install JohnMacFarlane.Pandoc"
        info "Or download from: https://pandoc.org/installing.html"
    }
}

# ── 4. qpdf (PDF encryption for WhatsApp delivery) ───────────────────────────
step "4/11  qpdf  (PDF encryption)  [optional — needed for PRX_WASENDER_PDF_PASSWORD]"

if (cmd_exists 'qpdf') {
    ok "qpdf already installed ($((qpdf --version 2>$null | Select-Object -First 1) -replace '.*qpdf version ','qpdf '))"
} else {
    info "Installing qpdf..."
    $QPDF_OK = $false

    if (-not $QPDF_OK -and (cmd_exists 'winget')) {
        info "--> winget"
        try {
            winget install --id qpdf.qpdf --silent --accept-package-agreements --accept-source-agreements 2>&1 |
                Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'qpdf') { $QPDF_OK = $true }
        } catch { info "winget attempt failed: $_" }
    }

    if (-not $QPDF_OK -and (cmd_exists 'choco')) {
        info "--> Chocolatey"
        try {
            choco install qpdf -y 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'qpdf') { $QPDF_OK = $true }
        } catch { info "Chocolatey attempt failed: $_" }
    }

    if (-not $QPDF_OK -and (cmd_exists 'scoop')) {
        info "--> Scoop"
        try {
            scoop install qpdf 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'qpdf') { $QPDF_OK = $true }
        } catch { info "Scoop attempt failed: $_" }
    }

    if (cmd_exists 'qpdf') {
        ok "qpdf installed"
    } else {
        warn "qpdf not installed — PDF encryption for WhatsApp delivery will be skipped."
        impact "Reports will be sent unencrypted until qpdf is installed"
        info "Install manually: winget install qpdf.qpdf  (or choco install qpdf)"
        info "Or download from: https://github.com/qpdf/qpdf/releases"
    }
}

# ── 5. basic-memory (per-agent personal memory MCP) ──────────────────────────
step "5/11  basic-memory  (per-agent MCP)  [downloads & configures]"

if (cmd_exists 'uvx') {
    info "Pre-fetching basic-memory package (priming uvx cache)..."
    try {
        $bmVersion = (& uvx --quiet basic-memory --version 2>&1 | Select-Object -Last 1)
        if ($LASTEXITCODE -eq 0 -and $bmVersion) {
            ok "basic-memory ready — $bmVersion"
            info "Seven per-agent MCP projects auto-provisioned when PRX_BASIC_MEMORY_ENABLED=Y"
        } else {
            warn "Could not pre-fetch basic-memory — it will download on first MCP startup"
            impact "First plugin run with PRX_BASIC_MEMORY_ENABLED=Y may take longer"
            info "Try manually: uvx basic-memory --version"
        }
    } catch {
        warn "basic-memory pre-fetch failed: $($_.Exception.Message)"
        impact "First plugin run with PRX_BASIC_MEMORY_ENABLED=Y may take longer"
    }
} else {
    warn "uvx not found — basic-memory requires uvx (step 1/10 must succeed first)"
    impact "Personal agent memory MCP will not start until uvx is installed"
}

# ── 6. graphify (codebase knowledge graph) ───────────────────────────────────
step "6/11  graphify  (codebase knowledge graph)  [augments grep/ast-grep]"

# graphify produces graph.json + GRAPH_REPORT.md at the repo root, used by
# SKILL.md Step 5 (Pass 0 structural search) and the KB integrity sweep at
# Step 0a (auto-heal stale file:line refs against the live symbol graph).
# CLI is installed here; the initial graph extraction runs at the end of
# step 11 once .env has been written and PRX_REPO_DIR is known.

if (cmd_exists 'graphify') {
    $gfVersion = (& graphify --version 2>$null | Select-Object -First 1)
    ok "graphify already installed ($gfVersion)"
} else {
    $GRAPHIFY_OK = $false

    # uv tool installs to %USERPROFILE%\.local\bin on Windows. Add to session PATH
    # before probing post-install so cmd_exists 'graphify' resolves correctly.
    $localBin = Join-Path $env:USERPROFILE ".local\bin"
    if (Test-Path $localBin) {
        if ($env:PATH -notlike "*$localBin*") { $env:PATH = "$localBin;$env:PATH" }
    }

    if (cmd_exists 'uv') {
        info "Installing graphify via uv tool..."
        try {
            & uv tool install graphifyy 2>&1 | Select-Object -Last 3 | ForEach-Object { info $_ }
            # Persist ~/.local/bin to user PATH so future PowerShell / CMD sessions
            # see graphify without re-running setup. No-op if already present.
            & uv tool update-shell 2>&1 | Out-Null
            refresh_path
            if (-not (Test-Path $localBin)) { $localBin = Join-Path $env:USERPROFILE ".local\bin" }
            if ((Test-Path $localBin) -and ($env:PATH -notlike "*$localBin*")) {
                $env:PATH = "$localBin;$env:PATH"
            }
            if (cmd_exists 'graphify') { $GRAPHIFY_OK = $true }
        } catch { info "uv tool install attempt failed: $_" }
    }
    if (-not $GRAPHIFY_OK -and (cmd_exists 'pipx')) {
        info "--> pipx fallback"
        try {
            & pipx install graphifyy 2>&1 | Select-Object -Last 3 | ForEach-Object { info $_ }
            & pipx ensurepath 2>&1 | Out-Null
            refresh_path
            if (cmd_exists 'graphify') { $GRAPHIFY_OK = $true }
        } catch { info "pipx install attempt failed: $_" }
    }

    # Final safety net: explicitly persist %USERPROFILE%\.local\bin to user PATH on
    # Windows if uv/pipx didn't (e.g. uv versions older than tool update-shell).
    if ($GRAPHIFY_OK) {
        try {
            $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
            if ($userPath -notlike "*$localBin*") {
                $newPath = if ($userPath) { "$localBin;$userPath" } else { $localBin }
                [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")
                info "Persisted $localBin to user PATH for future sessions"
            }
        } catch { info "Could not persist user PATH: $_" }
    }

    if ($GRAPHIFY_OK) {
        $gfVersion = (& graphify --version 2>$null | Select-Object -First 1)
        ok "graphify installed ($gfVersion)"
    } else {
        warn "graphify install failed — skill will fall back to grep/ast-grep only"
        impact "Structural Pass 0 search and graph-based KB stale-ref detection disabled"
        info "Install manually: uv tool install graphifyy  (or pipx install graphifyy)"
    }
}

# ── 7. Server npm dependencies ───────────────────────────────────────────────
step "7/11  Server npm dependencies  (libp2p, lmdb, express, …)  [required]"

$ServerDir = Join-Path $PROJECT_ROOT "server"
$ServerPkg = Join-Path $ServerDir "package.json"
$ServerMods = Join-Path $ServerDir "node_modules\.bin"

# ── 7a. Native build-tool probe (needed if lmdb prebuilts are absent) ────────
# lmdb ships prebuilt binaries for Windows x64.  If no matching prebuilt is
# found, npm falls back to compiling from source via node-gyp and will fail
# unless Visual Studio Build Tools are installed.  We detect this here so the
# error message is actionable rather than a raw gyp stack trace.
$BuildToolsOk = $true
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsBuild = $false
if (Test-Path $vsWhere) {
    $vsInfo = & $vsWhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    $hasMsBuild = ($vsInfo -ne $null -and $vsInfo.Trim() -ne '')
}
# Also accept if node-gyp can find its own toolchain (npm config msvs_version set)
if (-not $hasMsBuild) {
    $ngypCfg = (npm config get msvs_version 2>$null)
    if ($ngypCfg -and $ngypCfg -ne 'undefined' -and $ngypCfg.Trim() -ne '') {
        $hasMsBuild = $true
    }
}
if (-not $hasMsBuild) {
    warn "Visual Studio C++ Build Tools not detected"
    info "lmdb ships prebuilt binaries for Windows x64 so compilation is usually NOT needed."
    info "If npm install fails with 'gyp ERR', install build tools with one of:"
    info "  winget install Microsoft.VisualStudio.2022.BuildTools"
    info "  npm install --global windows-build-tools  (older approach, Node 16 era)"
    info "  Or install VS 2019/2022 with 'Desktop development with C++'"
    $BuildToolsOk = $false
}

# ── 7b. P2P port + mDNS note (Windows-specific) ──────────────────────────────
$EnvNow = Join-Path $PROJECT_ROOT ".env"
$P2pEnabled = $false
if (Test-Path $EnvNow) {
    $P2pEnabled = (Get-Content $EnvNow -Raw) -match '(?m)^PRX_P2P_ENABLED\s*=\s*Y'
}
if ($P2pEnabled) {
    $P2pPortMatch = [regex]::Match((Get-Content $EnvNow -Raw -ErrorAction SilentlyContinue), '(?m)^PRX_P2P_PORT\s*=\s*(\d+)')
    $P2pPort = if ($P2pPortMatch.Success) { $P2pPortMatch.Groups[1].Value } else { '7001' }
    info "P2P enabled — Windows Firewall steps for peer connectivity:"
    info "  New-NetFirewallRule -DisplayName 'Prevoyant P2P' -Direction Inbound -Protocol TCP -LocalPort $P2pPort -Action Allow"
    info "mDNS (LAN discovery) requires network profile = Private, not Public:"
    info "  Set-NetConnectionProfile -InterfaceAlias (Get-NetAdapter | Where-Object Status -eq Up).Name -NetworkCategory Private"
    info "  Or: Settings → Network → Properties → set to 'Private network'"
}

if (-not (Test-Path $ServerPkg)) {
    warn "server/package.json not found — skipping server npm install"
} elseif (-not (cmd_exists 'npm')) {
    warn "npm not found — skipping server npm install (install Node.js first)"
} elseif (Test-Path $ServerMods) {
    ok "server/node_modules already present — skipping npm install"
} else {
    info "Running npm install in server/ (libp2p, lmdb, express, …)..."

    # Capture full output to a temp file AND stream to terminal.
    # $LASTEXITCODE after npm is checked; Select-Object -Last 5 would lose it.
    $NpmLog = Join-Path $env:TEMP "prx-npm-$([System.IO.Path]::GetRandomFileName()).log"
    Push-Location $ServerDir
    npm install --loglevel=warn 2>&1 | Tee-Object -FilePath $NpmLog
    $NpmExit = $LASTEXITCODE
    Pop-Location

    if ($NpmExit -eq 0 -and (Test-Path $ServerMods)) {
        ok "server npm dependencies installed"
        Remove-Item $NpmLog -ErrorAction SilentlyContinue
    } else {
        # Diagnose the failure
        $NpmOutput = if (Test-Path $NpmLog) { Get-Content $NpmLog -Raw } else { '' }
        $IsGypErr  = $NpmOutput -match 'gyp ERR|node-pre-gyp|node-gyp|MSBUILD : error|cl\.exe|Cannot find module.*node-gyp|ELIFECYCLE'

        if ($IsGypErr) {
            err "npm install failed — lmdb native module could not compile"
            info ""
            info "  lmdb ships prebuilt binaries for Windows x64 but none matched this"
            info "  Node.js version, so npm tried to compile from source and failed."
            info ""
            info "  Fix — install Visual Studio C++ Build Tools, then retry:"
            info "    winget install Microsoft.VisualStudio.2022.BuildTools"
            info "    # Select 'Desktop development with C++' when prompted"
            info "    Push-Location server ; npm install --loglevel=warn ; Pop-Location"
            info ""
            info "  Or check https://github.com/kriszyp/lmdb-js/releases for a newer"
            info "  lmdb prebuilt matching your Node.js version."
        } else {
            err "npm install in server/ failed (exit $NpmExit)"
            info "Check output above. To retry with verbose logging:"
            info "  Push-Location '$ServerDir' ; npm install --loglevel=verbose ; Pop-Location"
        }

        impact "Prevoyant Server will not start until 'npm install' in server/ succeeds"
        Remove-Item $NpmLog -ErrorAction SilentlyContinue
    }
}

# ── 8. .env ───────────────────────────────────────────────────────────────────
step "8/11  .env  (environment file)  [required]"

$EnvFile       = Join-Path $PROJECT_ROOT ".env"
$EnvExample    = Join-Path $PROJECT_ROOT ".env.example"
$EnvConfigured = $false

if (Test-Path $EnvFile) {
    Copy-Item $EnvFile "$EnvFile.bak" -Force
    ok ".env already exists — skipping (backed up to .env.bak)"
    $EnvConfigured = $true
} else {
    if (Test-Path $EnvExample) {
        Copy-Item $EnvExample $EnvFile
        ok ".env created from .env.example"

        # Interactive credential setup when running in an interactive console
        if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
            Write-Host ""
            info "Enter your Jira credentials (press Enter to skip any field and edit .env manually later)."
            info "Get your API token: https://id.atlassian.com/manage-profile/security/api-tokens"
            Write-Host ""

            Write-Host -NoNewline "       Jira URL  (e.g. https://yourcompany.atlassian.net): "
            $InputJiraUrl = Read-Host

            Write-Host -NoNewline "       Jira email: "
            $InputJiraUser = Read-Host

            $secToken      = Read-Host -Prompt "       Jira API token" -AsSecureString
            $InputJiraToken = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
                              [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secToken))

            Write-Host -NoNewline "       Path to your code repository: "
            $InputRepoDir = Read-Host

            $anyInput = $InputJiraUrl -or $InputJiraUser -or $InputJiraToken -or $InputRepoDir
            if ($anyInput) {
                $content = Get-Content $EnvFile -Raw
                if ($InputJiraUrl)   { $content = $content -replace '(?m)^JIRA_URL=.*',     "JIRA_URL=$InputJiraUrl" }
                if ($InputJiraUser)  { $content = $content -replace '(?m)^JIRA_USERNAME=.*', "JIRA_USERNAME=$InputJiraUser" }
                if ($InputJiraToken) { $content = $content -replace '(?m)^JIRA_API_TOKEN=.*',"JIRA_API_TOKEN=$InputJiraToken" }
                if ($InputRepoDir)   { $content = $content -replace '(?m)^PRX_REPO_DIR=.*',  "PRX_REPO_DIR=$InputRepoDir" }
                [System.IO.File]::WriteAllText($EnvFile, $content, [System.Text.Encoding]::UTF8)
                ok ".env configured with your credentials"
                $EnvConfigured = $true
            } else {
                warn "No credentials entered — edit .env manually before using the plugin"
                info "Required: PRX_REPO_DIR, JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN"
            }
        } else {
            warn "Non-interactive mode — edit .env: set PRX_REPO_DIR, JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN"
        }
    } else {
        err ".env.example not found — create .env manually (see README)"
        impact "Plugin cannot load credentials — Jira and email features disabled"
    }
}

# ── 9. Claude Code settings.json (marketplace registration) ───────────────────
step "9/11  Claude Code marketplace registration  [required]"

$SettingsFile = Join-Path $env:USERPROFILE ".claude\settings.json"
$SettingsDir  = Split-Path -Parent $SettingsFile
if (-not (Test-Path $SettingsDir)) {
    New-Item -ItemType Directory -Path $SettingsDir -Force | Out-Null
}

try {
    $settings = [PSCustomObject]@{}
    if (Test-Path $SettingsFile) {
        try { $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json } catch {}
    }

    # Ensure extraKnownMarketplaces exists
    if (-not $settings.PSObject.Properties['extraKnownMarketplaces']) {
        $settings | Add-Member -NotePropertyName 'extraKnownMarketplaces' -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    $markets = $settings.extraKnownMarketplaces

    $existingProp = $markets.PSObject.Properties['dodogeny']
    if ($existingProp -and $existingProp.Value.source.path -eq $PROJECT_ROOT) {
        info "already registered at correct path"
    } else {
        $entry = [PSCustomObject]@{
            source = [PSCustomObject]@{ source = 'directory'; path = $PROJECT_ROOT }
        }
        $markets | Add-Member -NotePropertyName 'dodogeny' -NotePropertyValue $entry -Force
        $settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8
        info "registered dodogeny -> $PROJECT_ROOT"
    }
    ok "~/.claude/settings.json updated"
} catch {
    err "Could not update settings.json: $_"
    impact "Prevoyant plugin will not load in Claude Code until the marketplace is registered"
    info "Add the marketplace manually (see README)"
}

# ── 10. .claude/settings.local.json (permissions) ────────────────────────────
# SessionStart hooks (load-env + check-budget) live in the committed
# .claude/settings.json and work without this file.  This file only adds
# pre-approved permissions so common commands don't trigger prompts.
step "10/11  settings.local.json  (permission allowlist)  [optional]"

$LocalSettings = Join-Path $PROJECT_ROOT ".claude\settings.local.json"
$LocalDir = Split-Path -Parent $LocalSettings
if (-not (Test-Path $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir -Force | Out-Null }

if (Test-Path $LocalSettings) {
    ok "settings.local.json already exists — skipping"
    info "To regenerate, delete it and re-run setup."
} else {
    try {
        $config = [PSCustomObject]@{
            permissions = [PSCustomObject]@{
                allow = @(
                    "Bash(npx --yes codeburn@latest *)",
                    "Bash(codeburn *)",
                    "Bash(bash scripts/check-budget.sh)",
                    "Bash(bash .claude/load-env.sh)"
                )
            }
        }
        $config | ConvertTo-Json -Depth 10 | Set-Content $LocalSettings -Encoding UTF8
        ok "settings.local.json created (permission allowlist)"
    } catch {
        warn "Could not create settings.local.json: $_ — hooks still work via settings.json; you may see extra permission prompts"
    }
}

# ── 11. Plugin install + enable ───────────────────────────────────────────────
step "11/11  plugin install + enable  [required]"

$PLUGIN_OK = $false
if (cmd_exists 'claude') {
    info "Checking plugin status..."
    $pluginList = & claude plugin list 2>$null
    if ($pluginList -match 'prevoyant@dodogeny') {
        ok "prevoyant@dodogeny already installed"
        & claude plugin enable prevoyant@dodogeny 2>$null | Out-Null
        $PLUGIN_OK = $true
    } else {
        info "Installing Prevoyant plugin..."
        try {
            & claude plugin marketplace update dodogeny 2>&1 | Select-Object -Last 3 | ForEach-Object { info $_ }
            & claude plugin install prevoyant@dodogeny 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            & claude plugin enable  prevoyant@dodogeny 2>&1 | Select-Object -Last 3 | ForEach-Object { info $_ }
            $pluginList2 = & claude plugin list 2>$null
            if ($pluginList2 -match 'prevoyant@dodogeny') {
                ok "prevoyant@dodogeny installed and enabled"
                $PLUGIN_OK = $true
            } else {
                warn "Plugin install did not complete — run manually after setup:"
                info "  claude plugin install prevoyant@dodogeny && claude plugin enable prevoyant@dodogeny"
                impact "Prevoyant /prevoyant:dev skill unavailable until the plugin is installed and enabled"
            }
        } catch {
            warn "Plugin install failed: $_ — run manually:"
            info "  claude plugin install prevoyant@dodogeny && claude plugin enable prevoyant@dodogeny"
            impact "Prevoyant /prevoyant:dev skill unavailable until the plugin is installed and enabled"
        }
    }
} else {
    warn "claude CLI not found in PATH — plugin will not be auto-installed"
    impact "After Claude Code is installed, run:"
    info "  claude plugin install prevoyant@dodogeny && claude plugin enable prevoyant@dodogeny"
}

# ── 11b. Initial graphify extraction (depends on .env from step 8) ──────────
# Builds graph.json + GRAPH_REPORT.md at PRX_REPO_DIR so SKILL.md Pass 0 and
# the KB integrity sweep can use the graph from session 1. Skipped if PRX_REPO_DIR
# is unset (the skill will retry lazily on first use).

if ((cmd_exists 'graphify') -and (Test-Path $EnvFile)) {
    $repoDirFromEnv = $null
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match '^PRX_REPO_DIR=(.*)$') {
            $repoDirFromEnv = $Matches[1].Trim().Trim('"').Trim("'")
            if ($repoDirFromEnv.StartsWith('~')) {
                $repoDirFromEnv = $repoDirFromEnv -replace '^~', $HOME
            }
            break
        }
    }
    if ($repoDirFromEnv -and (Test-Path (Join-Path $repoDirFromEnv ".git"))) {
        $graphPath = Join-Path $repoDirFromEnv "graph.json"
        if (Test-Path $graphPath) {
            ok "graph.json already exists at $repoDirFromEnv — skipping extraction"
        } else {
            info "Building initial codebase graph at $repoDirFromEnv (one-time, may take a few minutes)..."
            try {
                Push-Location $repoDirFromEnv
                & graphify . 2>&1 | Select-Object -Last 3 | ForEach-Object { info $_ }
                Pop-Location
                if (Test-Path $graphPath) {
                    ok "Initial graph extracted — graph.json, GRAPH_REPORT.md ready"
                } else {
                    warn "graphify extraction did not produce graph.json — skill will retry on first use"
                    impact "Pass 0 search degrades to grep/ast-grep until graph.json exists"
                }
            } catch {
                warn "graphify extraction failed: $_ — skill will retry on first use"
                impact "Pass 0 search degrades to grep/ast-grep until graph.json exists"
            }
        }
    } else {
        info "PRX_REPO_DIR not set or not a git repo — graph will build on first skill use"
    }
}

# ── summary ───────────────────────────────────────────────────────────────────
Write-Host "`n======================================"
if ($ERRORS -eq 0) {
    Write-Host "Setup complete!" -ForegroundColor Green
} else {
    Write-Host "Setup finished with $ERRORS issue(s)." -ForegroundColor Yellow

    # Surface actionable fix commands for the most common hard errors.
    if (-not (Test-Path $ServerMods) -and (cmd_exists 'npm')) {
        Write-Host "`nFix required — server/node_modules not installed:" -ForegroundColor Yellow
        Write-Host "  winget install Microsoft.VisualStudio.2022.BuildTools   # if you see 'gyp ERR'"
        Write-Host "  Push-Location '$ServerDir' ; npm install --loglevel=warn ; Pop-Location"
    }
}

Write-Host "`nNext steps:"
if (-not $EnvConfigured) {
    Write-Host "  1. Edit .env — set PRX_REPO_DIR, JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN"
    Write-Host "     Get your Jira API token: https://id.atlassian.com/manage-profile/security/api-tokens"
    if ($PLUGIN_OK) {
        Write-Host "  2. Open Claude Code and try: /prevoyant:dev PROJ-1234"
    } else {
        Write-Host "  2. Run: claude plugin install prevoyant@dodogeny"
        Write-Host "  3. Open Claude Code and try: /prevoyant:dev PROJ-1234"
    }
} else {
    if ($PLUGIN_OK) {
        Write-Host "  Open Claude Code and try: /prevoyant:dev PROJ-1234"
    } else {
        Write-Host "  1. Run: claude plugin install prevoyant@dodogeny"
        Write-Host "  2. Open Claude Code and try: /prevoyant:dev PROJ-1234"
    }
}
Write-Host ""
