# torWatch M0.2 desktop smoke orchestrator (Windows).
#
# Starts a DEDICATED M0.2 backend instance (port 4002) + a dedicated provider
# stub (port 4498) against the STAGING PostgreSQL (persistent data preserved;
# this script never resets or wipes anything), builds the renderer pointed at
# that backend, runs the real-Electron smoke, and then stops ONLY the
# processes this script itself started (recorded PIDs; no broad taskkill).
#
# The staging harness (ports 4001/4174/4499, state.json) is untouched.
#
# Usage: powershell -ExecutionPolicy Bypass -File m02-smoke.ps1 [-SkipBuild]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$stagingDirectory = $PSScriptRoot
$repositoryRoot = (Resolve-Path (Join-Path $stagingDirectory "..\..")).Path
$electronDirectory = Join-Path $repositoryRoot "electron-app"
$backendBinary = Join-Path $stagingDirectory "build\torwatch-staging.exe"
$logsDirectory = Join-Path $stagingDirectory "logs"
$m02DataRoot = Join-Path $stagingDirectory "data-m02"

function Write-Stage([string]$message) { Write-Host "[m02] $message" -ForegroundColor Cyan }
function Write-Fail([string]$message) { Write-Host "[m02] ERROR: $message" -ForegroundColor Red }

function Read-StagingPgPassword {
    # Same loading rule as staging.ps1: process env first, then the gitignored
    # .env. The value is never echoed.
    $value = [Environment]::GetEnvironmentVariable("STAGING_PG_PASSWORD")
    if ($value) { return $value }
    $envFile = Join-Path $stagingDirectory ".env"
    if (Test-Path -LiteralPath $envFile) {
        foreach ($line in Get-Content -LiteralPath $envFile) {
            $trimmed = $line.Trim()
            if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
            $separator = $trimmed.IndexOf("=")
            if ($separator -lt 1) { continue }
            if ($trimmed.Substring(0, $separator).Trim() -eq "STAGING_PG_PASSWORD") {
                return $trimmed.Substring($separator + 1).Trim()
            }
        }
    }
    throw "STAGING_PG_PASSWORD is missing (process env or deploy/desktop-staging/.env)."
}

function Wait-HttpReady([string]$url, [int]$timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $url
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw "Timed out waiting for $url"
}

function Stop-RecordedProcess($pidValue) {
    if (-not $pidValue) { return }
    if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
        cmd /c "taskkill /pid $pidValue /t /f" 2>&1 | Out-Null
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker is required (staging PostgreSQL). Start Docker Desktop first." }
if (-not (Test-Path -LiteralPath $backendBinary)) { throw "Staging backend binary missing ($backendBinary). Run 'staging.ps1 Start' once to build it." }

$pgPassword = Read-StagingPgPassword
$startedPids = @()
$exitCode = 0
try {
    # Staging PostgreSQL must be up (docker compose project torwatch-staging).
    $health = docker inspect --format "{{.State.Health.Status}}" torwatch-staging-postgres 2>$null
    if ($health -ne "healthy") {
        Write-Stage "Staging PostgreSQL is not healthy; bringing the torwatch-staging compose project up..."
        & docker compose -f (Join-Path $stagingDirectory "compose.yaml") --project-directory $stagingDirectory up -d
        if ($LASTEXITCODE -ne 0) { throw "docker compose up failed (exit $LASTEXITCODE)." }
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline) {
            $health = docker inspect --format "{{.State.Health.Status}}" torwatch-staging-postgres 2>$null
            if ($health -eq "healthy") { break }
            Start-Sleep -Seconds 2
        }
        if ($health -ne "healthy") { throw "Staging PostgreSQL did not become healthy." }
    }
    Write-Stage "Staging PostgreSQL healthy (persistent data preserved)."

    # 1. Dedicated M0.2 provider stub (port 4498) so the M0.2 backend never
    #    depends on the staging stub lifecycle.
    New-Item -ItemType Directory -Force -Path $logsDirectory, $m02DataRoot, (Join-Path $m02DataRoot "torrents"), (Join-Path $m02DataRoot "subcache") | Out-Null
    $stubProc = Start-Process -FilePath "node" `
        -ArgumentList (Join-Path $stagingDirectory "provider-stub.mjs"), "--port", "4498" `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logsDirectory "m02-stub-stdout.log") `
        -RedirectStandardError (Join-Path $logsDirectory "m02-stub-stderr.log")
    $startedPids += $stubProc.Id
    Wait-HttpReady "http://127.0.0.1:4498/healthz" 10
    Write-Stage "Provider stub (M0.2) ready on 127.0.0.1:4498 (deterministic; stub-backed evidence)."

    # 2. Dedicated M0.2 backend on 4002 sharing the staging database.
    #    Allowlist: the packaged-style file:// renderer (Origin: null) and the
    #    dev server origin. The staging instance on 4001 stays untouched.
    $backendEnv = @{
        PG_DSN                           = "postgres://torwatch:$pgPassword@127.0.0.1:5433/torwatch?sslmode=disable"
        LISTEN                           = "127.0.0.1:4002"
        TORWATCH_ALLOWED_CLIENT_ORIGINS  = "null,http://localhost:5173"
        TORWATCH_TMDB_BASE_URL           = "http://127.0.0.1:4498"
        TMDB_API_KEY                     = "validation-stub-key"
        PROWLARR_URL                     = "http://127.0.0.1:9696"
        PROWLARR_API_KEY                 = "staging-degraded-no-prowlarr"
        TORRENT_DATA_ROOT                = (Join-Path $m02DataRoot "torrents")
        SUB_CACHE_DIR                    = (Join-Path $m02DataRoot "subcache")
        LOG_FILE                         = (Join-Path $logsDirectory "m02-backend.log")
        ERROR_LOG_FILE                   = (Join-Path $logsDirectory "m02-backend-errors.log")
        TORWATCH_APP_VERSION             = "m02-desktop-smoke"
    }
    foreach ($key in $backendEnv.Keys) { Set-Item -Path "env:$key" -Value $backendEnv[$key] }
    $backendProc = Start-Process -FilePath $backendBinary -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logsDirectory "m02-backend-stdout.log") `
        -RedirectStandardError (Join-Path $logsDirectory "m02-backend-stderr.log")
    $startedPids += $backendProc.Id
    Wait-HttpReady "http://127.0.0.1:4002/readyz" 30
    Write-Stage "M0.2 backend ready on 127.0.0.1:4002 (library.household.v1 expected)."

    # 3. Renderer build pointed at the M0.2 backend (BFF-only).
    if (-not $SkipBuild) {
        Write-Stage "Building the renderer bundle for M0.2 (VITE_TORWATCH_BACKEND_URL=http://127.0.0.1:4002, VITE_CATALOG_SOURCE=bff)..."
        Push-Location $electronDirectory
        try {
            $env:VITE_TORWATCH_BACKEND_URL = "http://127.0.0.1:4002"
            $env:VITE_CATALOG_SOURCE = "bff"
            & npm.cmd run build:renderer
            if ($LASTEXITCODE -ne 0) { throw "build:renderer failed (exit $LASTEXITCODE)." }
        } finally { Pop-Location }
    }

    # 4. Real Electron smoke. npx.cmd can swallow the child exit code, so the
    #    verdict comes from the smoke's own summary output as well.
    Write-Stage "Launching the real Electron desktop smoke..."
    $smokeOutput = Join-Path $logsDirectory "m02-smoke-output.log"
    Push-Location $electronDirectory
    try {
        # Native stderr (e.g. Electron deprecation notices) must not become a
        # terminating PowerShell error while the smoke output is captured.
        $ErrorActionPreference = "Continue"
        & npx.cmd electron scripts/m02-desktop-smoke.cjs 2>&1 | Tee-Object -FilePath $smokeOutput
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = "Stop"
    } finally { Pop-Location; $ErrorActionPreference = "Stop" }
    $log = (Get-Content -LiteralPath $smokeOutput -Raw -ErrorAction SilentlyContinue)
    $failedChecks = ([regex]::Matches($log, "(?m)^\s+FAIL:")).Count
    $crashed = $log -match "M02_SMOKE_ERROR="
    if ($exitCode -ne 0 -or $failedChecks -gt 0 -or $crashed) {
        throw "M0.2 desktop smoke FAILED (exit $exitCode, failed checks: $failedChecks, crashed: $crashed). Full output: $smokeOutput"
    }
    Write-Stage "M0.2 desktop smoke PASSED. Screenshots: electron-app\release\m02\"
} catch {
    $exitCode = 1
    Write-Fail $_.Exception.Message
} finally {
    foreach ($recorded in $startedPids) { Stop-RecordedProcess $recorded }
    Write-Stage "M0.2 stub and backend stopped (only the processes this script started)."
}
exit $exitCode
