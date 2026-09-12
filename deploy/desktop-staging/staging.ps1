# torWatch Windows desktop staging harness (temporary Radxa/homeserver substitute).
#
# Commands:
#   staging.ps1 Start  [-NoTailscale] [-ValidationStub] [-WithProwlarr]
#                                                         start the staging stack
#   staging.ps1 Status                                    report stack health
#   staging.ps1 Stop                                      stop stack, remove only
#                                                         harness resources
#   staging.ps1 RestartBackend                            restart the Go backend
#                                                         (persistence check)
#   staging.ps1 Verify                                    run the complete local/
#                                                         tailnet staging checks
#   staging.ps1 VerifyAfterRestart                        restart backend, then
#                                                         prove persistence
#   staging.ps1 Reset [-Force]                            WIPE staging data
#                                                         (explicit, never
#                                                         automatic)
#
# Safety contract:
# - Backends and PostgreSQL listen on 127.0.0.1 only. Nothing binds 0.0.0.0.
# - Private tailnet exposure uses Tailscale Serve only; Funnel is never
#   invoked; the installed CLI syntax is verified before use.
# - Stop removes only the process IDs and Serve mappings this harness
#   recorded (state.json). No broad taskkill patterns.
# - Secrets load from deploy/desktop-staging/.env (gitignored) or the process
#   environment. Missing required credentials fail clearly; none are
#   fabricated or echoed.
# - The explicit Reset command is the only operation that deletes staging
#   data.
param(
    [Parameter(Position = 0)]
    [ValidateSet("Start", "Status", "Stop", "StopLeftovers", "RestartBackend", "Verify", "VerifyAfterRestart", "VerifySource", "VerifyPlayback", "Make-PlaybackFixtures", "Reset")]
    [string]$Command = "Status",

    [switch]$NoTailscale,
    [switch]$ValidationStub,
    [switch]$WithProwlarr,
    [switch]$TailnetHttp,
    # Allowlist the exact Capacitor web origins (iOS capacitor://localhost,
    # Android https://localhost) so the native shell can reach this backend.
    [switch]$WithCapacitorOrigins,
    # LAN mode: the backend additionally listens on all interfaces so a phone
    # on the SAME trusted Wi-Fi can reach it without Tailscale. Private,
    # trusted networks only — the API has no authentication.
    [switch]$LanMode,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$stagingDirectory = $PSScriptRoot
$repositoryRoot = (Resolve-Path (Join-Path $stagingDirectory "..\..")).Path
$electronDirectory = Join-Path $repositoryRoot "electron-app"
$composeFile = Join-Path $stagingDirectory "compose.yaml"
$envFile = Join-Path $stagingDirectory ".env"
$stateFile = Join-Path $stagingDirectory "state.json"
$buildDirectory = Join-Path $stagingDirectory "build"
$logsDirectory = Join-Path $stagingDirectory "logs"
$backendBinary = Join-Path $buildDirectory "torwatch-staging.exe"

function Write-Stage([string]$message) { Write-Host "[staging] $message" -ForegroundColor Cyan }
function Write-Fail([string]$message) { Write-Host "[staging] ERROR: $message" -ForegroundColor Red }

function Read-StagingEnvironment {
    $values = @{}
    # Process environment first (operator may export overrides), then the
    # gitignored .env file. Never echo secret values.
    foreach ($name in @(
        "STAGING_PG_PASSWORD", "STAGING_PG_PORT", "BACKEND_PORT", "FRONTEND_PORT",
        "TMDB_API_KEY", "TAILNET_FRONTEND_SERVE_PORT", "TAILNET_BACKEND_SERVE_PORT",
        "TAILNET_ORIGIN"
    )) {
        $processValue = [Environment]::GetEnvironmentVariable($name)
        if ($processValue) { $values[$name] = $processValue }
    }
    if (Test-Path -LiteralPath $envFile) {
        foreach ($line in Get-Content -LiteralPath $envFile) {
            $trimmed = $line.Trim()
            if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
            $separator = $trimmed.IndexOf("=")
            if ($separator -lt 1) { continue }
            $key = $trimmed.Substring(0, $separator).Trim()
            $value = $trimmed.Substring($separator + 1).Trim()
            if (-not $values.ContainsKey($key)) { $values[$key] = $value }
        }
    }
    if (-not $values["STAGING_PG_PASSWORD"]) {
        throw "STAGING_PG_PASSWORD is missing. Copy deploy/desktop-staging/.env.example to deploy/desktop-staging/.env and set a throwaway staging password. Required credentials are never fabricated."
    }
    # Defaults (documented in .env.example).
    if (-not $values["STAGING_PG_PORT"]) { $values["STAGING_PG_PORT"] = "5433" }
    if (-not $values["BACKEND_PORT"]) { $values["BACKEND_PORT"] = "4001" }
    if (-not $values["FRONTEND_PORT"]) { $values["FRONTEND_PORT"] = "4174" }
    if (-not $values["TAILNET_FRONTEND_SERVE_PORT"]) { $values["TAILNET_FRONTEND_SERVE_PORT"] = "443" }
    if (-not $values["TAILNET_BACKEND_SERVE_PORT"]) { $values["TAILNET_BACKEND_SERVE_PORT"] = "8443" }
    return $values
}

function Test-TailscaleUsable {
    $cli = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cli) { return @{ exe = $cli.Source } }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"),
        (Join-Path $env:LOCALAPPDATA "Tailscale\tailscale.exe")
    )) {
        if (Test-Path -LiteralPath $candidate) { return @{ exe = $candidate } }
    }
    return $null
}

function Test-TailscaleServeSyntax([string]$tailscaleExe) {
    # Requirement: verify the INSTALLED CLI syntax instead of assuming an old
    # command format. The harness needs `serve` with background mode and an
    # explicit HTTPS port mapping (Tailscale 1.50+ style).
    # Tailscale writes normal help text to stderr on Windows. Temporarily use
    # Continue so PowerShell 7 does not turn that successful native output
    # into a terminating NativeCommandError under this script's Stop policy.
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $help = (& $tailscaleExe serve --help 2>&1) | Out-String
        $helpExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($helpExitCode -ne 0) { throw "tailscale serve --help failed (exit $helpExitCode). Tailscale may be too old or misconfigured." }
    $supportsBg = $help -match "--bg"
    $supportsHttps = $help -match "--https"
    if (-not ($supportsBg -and $supportsHttps)) {
        $excerpt = ($help -replace "\s+", " ")
        if ($excerpt.Length -gt 300) { $excerpt = $excerpt.Substring(0, 300) }
        throw "Installed Tailscale Serve does not advertise the required syntax (--bg, --https). Upgrade Tailscale (1.50+) or run staging with -NoTailscale. Help excerpt: $excerpt"
    }
}

function Get-TailnetDnsName([string]$tailscaleExe) {
    $statusJson = (& $tailscaleExe status --json 2>&1) | Out-String
    if ($LASTEXITCODE -ne 0) { throw "tailscale status failed (exit $LASTEXITCODE). Log in with 'tailscale up' first, or run staging with -NoTailscale." }
    $status = $statusJson | ConvertFrom-Json
    $dnsName = $null
    if ($status.Self -and $status.Self.DNSName) { $dnsName = $status.Self.DNSName }
    if (-not $dnsName -and $status.Self -and $status.Self.HostName) { $dnsName = $status.Self.HostName }
    if (-not $dnsName) { throw "Tailscale is connected but Self.DNSName is empty. Enable MagicDNS or set TAILNET_ORIGIN in deploy/desktop-staging/.env." }
    return @{
        dns = ($dnsName.TrimEnd("."))
        running = ($status.BackendState -eq "Running")
        # Node-stable identifier used to build the Serve-enablement URL when
        # the CLI cannot print one itself (it can hang without ever erroring).
        nodeId = if ($status.Self -and $status.Self.ID) { $status.Self.ID } else { $null }
    }
}
function New-TailscaleServeMapping([string]$tailscaleExe, [int]$servedPort, [int]$localPort, [string]$scheme, [string]$nodeId) {
    # Private tailnet exposure only: this is `serve`, NEVER `funnel`.
    # scheme is "https" (default) or "http"; the URL scheme MUST match the
    # listener Tailscale actually creates (--https vs --http) â€” mismatching
    # them produces TLS "packet length too long" failures on the phone.
    $flag = if ($scheme -eq "http") { "--http=$servedPort" } else { "--https=$servedPort" }
    # OBSERVED BEHAVIOR (1.102.4, Serve feature not enabled): `serve --bg`
    # HANGS forever instead of printing the enablement error. Run it as a
    # bounded process and treat a timeout as exactly that condition.
    $stdoutFile = Join-Path $env:TEMP "staging-serve-$servedPort-out.txt"
    $stderrFile = Join-Path $env:TEMP "staging-serve-$servedPort-err.txt"
    $process = Start-Process -FilePath $tailscaleExe `
        -ArgumentList @("serve", "--bg", $flag, "http://127.0.0.1:$localPort") `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutFile `
        -RedirectStandardError $stderrFile
    $exited = $process.WaitForExit(25000)
    if (-not $exited) {
        Stop-RecordedProcess $process.Id
        throw [TailscaleServePendingException]::new(
            $(if ($nodeId) { "https://login.tailscale.com/f/serve?node=$nodeId" } else { "" }),
            "tailscale serve --bg $flag did not exit within 25s (observed when the Serve feature is not enabled on the tailnet).")
    }
    $outContent = Get-Content -LiteralPath $stdoutFile -Raw -ErrorAction SilentlyContinue
    $errContent = Get-Content -LiteralPath $stderrFile -Raw -ErrorAction SilentlyContinue
    $output = "$outContent $errContent"
    $combined = $output.Trim()
    if ($combined -match "Serve is not enabled") {
        $urlMatch = [regex]::Match($combined, "https://login\.tailscale\.com/\S+")
        throw [TailscaleServePendingException]::new(
            $(if ($urlMatch.Success) { $urlMatch.Value.Trim() } elseif ($nodeId) { "https://login.tailscale.com/f/serve?node=$nodeId" } else { "" }),
            "Tailscale Serve is not enabled on this tailnet.")
    }
    # Repair: `tailscale serve --bg` reports SUCCESS on stderr with an EMPTY
    # exit code on some versions (observed 1.102.4 with Serve enabled), so the
    # exit code is not authoritative. Verify the mapping via `serve status`:
    # the mapping exists iff the status output names the local port.
    $statusOut = ""
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $statusOut = (& $tailscaleExe serve status 2>&1) | Out-String
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    $mappingExpected = "127.0.0.1:$localPort"
    if ($statusOut -notlike "*$mappingExpected*") {
        throw "tailscale serve --bg $flag did not produce a mapping (serve status does not mention $mappingExpected). Output: $combined"
    }
}

# Thrown when Tailscale Serve exists but the tailnet has not enabled the
# feature. The harness falls back to local-only staging instead of hanging.
class TailscaleServePendingException : System.Exception {
    [string] $EnableUrl
    TailscaleServePendingException([string]$enableUrl, [string]$message) : base($message) {
        $this.EnableUrl = $enableUrl
    }
}

function Remove-TailscaleServeMapping([string]$tailscaleExe, [int]$servedPort) {
    # Remove ONLY the mappings this harness owns (exact served port). The HTTP
    # cleanup also removes mappings produced by staging harness versions that
    # incorrectly advertised an HTTPS URL for a plain HTTP listener.
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $tailscaleExe serve "--http=$servedPort" off 2>&1 | Out-Null
        & $tailscaleExe serve "--https=$servedPort" off 2>&1 | Out-Null
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
}

function Write-State($state) {
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

function Test-ProcessAlive($pidValue) {
    if (-not $pidValue) { return $false }
    return [bool](Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}

# Returns the PIDs holding the harness's well-known ports whose command lines
# PROVE they belong to this staging harness (interrupted startup before
# state.json was written). Anything else is reported, never killed.
# Port overrides in .env are not visible here; the well-known defaults cover
# the standard staging layout.
function Get-StagingOwnedPortProcesses {
    $artifacts = @(
        "desktop-staging",
        "serve-browser.mjs",
        "provider-stub.mjs",
        "torwatch-staging.exe"
    )
    $owned = @()
    foreach ($port in @(4001, 4174, 4499)) {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($connection in $connections) {
            $processId = $connection.OwningProcess
            if (-not $processId -or $owned -contains $processId) { continue }
            $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue).CommandLine
            if (-not $commandLine) { continue }
            foreach ($artifact in $artifacts) {
                if ($commandLine -like "*$artifact*") {
                    $owned += $processId
                    break
                }
            }
        }
    }
    return $owned
}

# Refuses to start over an untracked listener (NOT proven to be ours) so a
# health check can never silently pass against someone else's process.
function Assert-PortsFreeForStaging {
    foreach ($port in @(4001, 4174, 4499)) {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($connection in $connections) {
            $processId = $connection.OwningProcess
            $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
            $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue).CommandLine
            $isOurs = $false
            if ($commandLine) {
                foreach ($artifact in @("desktop-staging", "serve-browser.mjs", "provider-stub.mjs", "torwatch-staging.exe")) {
                    if ($commandLine -like "*$artifact*") { $isOurs = $true; break }
                }
            }
            if (-not $isOurs) {
                throw "Port $port is held by an unrelated process (pid $processId '$($process.ProcessName)'). Stop it or change the staging ports in .env; the harness will not kill processes it cannot prove are its own."
            }
        }
    }
}

function Stop-RecordedProcess($pidValue) {
    if (-not $pidValue) { return }
    if (Test-ProcessAlive $pidValue) {
        # Exact PID only - never a broad taskkill pattern.
        cmd /c "taskkill /pid $pidValue /t /f" 2>&1 | Out-Null
    }
}

function Invoke-Compose([string[]]$composeArgs) {
    & docker compose -f $composeFile --project-directory $stagingDirectory @composeArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($composeArgs -join ' ') failed (exit $LASTEXITCODE)." }
}

function Wait-PostgresHealthy {
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        $health = docker inspect --format "{{.State.Health.Status}}" torwatch-staging-postgres 2>$null
        if ($health -eq "healthy") { return }
        Start-Sleep -Seconds 2
    }
    throw "Staging PostgreSQL did not become healthy within 90 seconds."
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

function Get-ProwlarrConnection {
    $configPath = Join-Path $repositoryRoot "data\prowlarr\config.xml"
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "Prowlarr configuration is missing at data\prowlarr\config.xml. Start the repository Prowlarr service once before using -WithProwlarr."
    }
    $xml = Get-Content -LiteralPath $configPath -Raw
    $match = [regex]::Match($xml, "<ApiKey>([^<]+)</ApiKey>", "IgnoreCase")
    if (-not $match.Success -or -not $match.Groups[1].Value.Trim()) {
        throw "Prowlarr API key is missing from its saved configuration."
    }
    return @{ url = "http://127.0.0.1:9696"; apiKey = $match.Groups[1].Value.Trim() }
}

function Assert-ProwlarrReady($connection) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 `
            -Uri "$($connection.url)/api/v1/system/status" `
            -Headers @{ "X-Api-Key" = $connection.apiKey }
        if ($response.StatusCode -eq 200) { return }
    } catch { }
    throw "Prowlarr is not ready on 127.0.0.1:9696. Run 'docker compose up -d flaresolverr prowlarr' from the repository root, then retry."
}

function Start-ProviderStub {
    $stdout = Join-Path $logsDirectory "provider-stub-stdout.log"
    $stderr = Join-Path $logsDirectory "provider-stub-stderr.log"
    $process = Start-Process -FilePath "node" `
        -ArgumentList (Join-Path $stagingDirectory "provider-stub.mjs"), "--port", "4499" `
        -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr
    try {
        Wait-HttpReady "http://127.0.0.1:4499/healthz" 10
    } catch {
        Stop-RecordedProcess $process.Id
        $detail = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue).Trim() } else { "" }
        throw "Provider stub did not become ready. $detail"
    }
    return $process
}

function New-TailnetOrigin([string]$dnsName, [int]$port, [string]$scheme) {
    # The URL scheme always matches the actual Serve listener type. A plain
    # HTTP listener is never advertised as HTTPS (and vice versa).
    if ($scheme -eq "http") {
        if ($port -eq 80) { return "http://$dnsName" }
        return "http://${dnsName}:$port"
    }
    if ($port -eq 443) { return "https://$dnsName" }
    return "https://${dnsName}:$port"
}

function Get-OriginPlan($envValues, [bool]$useTailscale, [string]$scheme) {
    $backPort = [int]$envValues["BACKEND_PORT"]
    $frontPort = [int]$envValues["FRONTEND_PORT"]
    $localPlan = @{
        backendOrigin = "http://127.0.0.1:$backPort"
        frontendOrigin = "http://127.0.0.1:$frontPort"
    }
    if (-not $useTailscale) {
        return @{
            useTailscale = $false
            scheme = $scheme
            backendOrigin = $localPlan.backendOrigin
            frontendOrigin = $localPlan.frontendOrigin
            localOrigins = $localPlan
        }
    }
    $tailscale = Test-TailscaleUsable
    if (-not $tailscale) {
        throw "Tailscale was requested but no tailscale CLI was found. Install Tailscale, log in, or run with -NoTailscale."
    }
    Test-TailscaleServeSyntax $tailscale.exe
    $tailnet = Get-TailnetDnsName $tailscale.exe
    $originOverride = $envValues["TAILNET_ORIGIN"]
    if ($originOverride) {
        # The override already carries its scheme; the port comes from env.
        $backendOrigin = "$($originOverride.TrimEnd('/')):$($envValues["TAILNET_BACKEND_SERVE_PORT"])"
        $frontendOrigin = "$($originOverride.TrimEnd('/')):$($envValues["TAILNET_FRONTEND_SERVE_PORT"])"
    } else {
        $backendOrigin = New-TailnetOrigin $tailnet.dns ([int]$envValues["TAILNET_BACKEND_SERVE_PORT"]) $scheme
        $frontendOrigin = New-TailnetOrigin $tailnet.dns ([int]$envValues["TAILNET_FRONTEND_SERVE_PORT"]) $scheme
    }
    return @{
        useTailscale = $true
        scheme = $scheme
        tailscaleExe = $tailscale.exe
        tailnetDns = $tailnet.dns
        tailnetDnsNode = $tailnet.nodeId
        frontendServePort = [int]$envValues["TAILNET_FRONTEND_SERVE_PORT"]
        backendServePort = [int]$envValues["TAILNET_BACKEND_SERVE_PORT"]
        backendOrigin = $backendOrigin
        frontendOrigin = $frontendOrigin
        localOrigins = $localPlan
    }
}

function New-BackendEnvironment($envValues, $origins, [bool]$withStub, [bool]$withProwlarr, [bool]$lanMode) {
    $prowlarr = if ($withProwlarr) { Get-ProwlarrConnection } else { $null }
    $backendEnv = @{
        PG_DSN = "postgres://torwatch:$($envValues["STAGING_PG_PASSWORD"])@127.0.0.1:$($envValues["STAGING_PG_PORT"])/torwatch?sslmode=disable"
        LISTEN = if ($lanMode) { "0.0.0.0:$($envValues["BACKEND_PORT"])" } else { "127.0.0.1:$($envValues["BACKEND_PORT"])" }
        TORWATCH_ALLOWED_CLIENT_ORIGINS = if ($WithCapacitorOrigins) { "$($origins.frontendOrigin),capacitor://localhost,https://localhost" } else { "$($origins.frontendOrigin)" }
        # Default staging stays deterministic/degraded. -WithProwlarr reads
        # the real key from the existing gitignored config without echoing or
        # copying it into state.json.
        PROWLARR_URL = if ($prowlarr) { $prowlarr.url } else { "http://127.0.0.1:9696" }
        PROWLARR_API_KEY = if ($prowlarr) { $prowlarr.apiKey } else { "staging-degraded-no-prowlarr" }
        TORRENT_DATA_ROOT = (Join-Path $stagingDirectory "data\torrents")
        SUB_CACHE_DIR = (Join-Path $stagingDirectory "data\subcache")
        LOG_FILE = (Join-Path $logsDirectory "backend.log")
        ERROR_LOG_FILE = (Join-Path $logsDirectory "backend-errors.log")
        TORWATCH_APP_VERSION = "desktop-staging"
    }
    # Playback service tools + validation fixture root flow through from the
    # operator environment/.env when provided; unset keeps the capability off.
    foreach ($playbackKey in @("FFMPEG_PATH", "FFPROBE_PATH", "TORWATCH_PLAYBACK_FIXTURE_ROOT", "PLAYBACK_DATA_ROOT", "PLAYBACK_MAX_TRANSCODES", "PLAYBACK_SESSION_TTL", "PLAYBACK_PROBE_TIMEOUT", "PLAYBACK_MAX_TRANSCODE_HEIGHT")) {
        if ($envValues[$playbackKey]) { $backendEnv[$playbackKey] = $envValues[$playbackKey] }
    }
    if ($envValues["TMDB_API_KEY"]) {
        $backendEnv["TMDB_API_KEY"] = $envValues["TMDB_API_KEY"]
    } elseif ($withStub) {
        # The deterministic stub ignores the key; a placeholder is required
        # so the TMDb provider (candidates, metadata) is wired at all.
        $backendEnv["TMDB_API_KEY"] = "validation-stub-key"
    }
    if ($withStub) { $backendEnv["TORWATCH_TMDB_BASE_URL"] = "http://127.0.0.1:4499" }
    return $backendEnv
}

function Start-Staging {
    $envValues = Read-StagingEnvironment
    $useTailscale = -not $NoTailscale
    $tailnetScheme = if ($TailnetHttp) { "http" } else { "https" }

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker is required for the staging PostgreSQL. Start Docker Desktop first." }
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw "Go is required to build the staging backend from the working tree." }
    if (-not (Test-Path -LiteralPath (Join-Path $electronDirectory "node_modules"))) {
        throw "electron-app\node_modules is missing. Run 'npm ci' in electron-app once; the staging harness never runs npm install implicitly."
    }

    # Idempotency: refuse to double-start while ANY harness process recorded
    # in state.json is still alive. A live frontend/stub beside a dead backend
    # must be stopped first: re-starting over it would fail on the occupied
    # port while health checks silently pass against the OLD process.
    $existing = Read-State
    if ($existing) {
        $alive = @()
        foreach ($role in @("backendPid", "frontendPid", "stubPid")) {
            if ($existing.$role -and (Test-ProcessAlive $existing.$role)) { $alive += "$role $($existing.$role)" }
        }
        if ($alive.Count -gt 0) {
            throw "Staging is already running ($($alive -join ', ')). Run 'staging.ps1 Stop' first."
        }
    }

    # Interrupted-startup recovery: a previous Start that died before writing
    # state.json (e.g. Ctrl-C during builds/Tailscale) can leave verified
    # staging-owned processes on our ports. Stop exactly those; refuse if an
    # unrelated process holds a port.
    $leftovers = Get-StagingOwnedPortProcesses
    foreach ($leftoverPid in $leftovers) {
        Write-Stage "Stopping staging-owned leftover process pid $leftoverPid (previous startup was interrupted before state.json was written)."
        Stop-RecordedProcess $leftoverPid
    }
    Assert-PortsFreeForStaging

    $originPlan = Get-OriginPlan $envValues $useTailscale $tailnetScheme
    if ($WithProwlarr) {
        $prowlarr = Get-ProwlarrConnection
        Assert-ProwlarrReady $prowlarr
        Write-Stage "Live Prowlarr source discovery enabled (saved key loaded privately from data\prowlarr\config.xml)."
    }

    # 1. Private tailnet exposure FIRST (fail fast, before any local process
    #    spawns): Tailscale Serve (never Funnel). If the tailnet has not
    #    enabled the Serve feature, degrade to local-only and surface exactly
    #    one user action instead of hanging or failing the whole start.
    $tailnetPendingUrl = $null
    $served = @()
    if ($originPlan.useTailscale) {
        try {
            New-TailscaleServeMapping $originPlan.tailscaleExe $originPlan.frontendServePort $envValues["FRONTEND_PORT"] $tailnetScheme $originPlan.tailnetDnsNode
            New-TailscaleServeMapping $originPlan.tailscaleExe $originPlan.backendServePort $envValues["BACKEND_PORT"] $tailnetScheme $originPlan.tailnetDnsNode
            $served = @($originPlan.frontendServePort, $originPlan.backendServePort)
            Write-Stage ("Tailnet Serve mappings active: " + ($served -join ", ") + " ($tailnetScheme; Funnel is never used)")
        } catch [TailscaleServePendingException] {
            $tailnetPendingUrl = $_.Exception.EnableUrl
            $originPlan.useTailscale = $false
            $originPlan.backendOrigin = $originPlan.localOrigins.backendOrigin
            $originPlan.frontendOrigin = $originPlan.localOrigins.frontendOrigin
            Write-Stage "Tailscale Serve is NOT enabled on this tailnet - continuing LOCAL-ONLY. Tailnet exposure is pending one user action (printed below)."
        }
    }
    Write-Stage ("Mode: " + $(if ($originPlan.useTailscale) { "Tailscale Serve (private tailnet; Funnel is never used)" } else { "local-only (-NoTailscale or Serve pending)" }))

    # 1. Staging PostgreSQL (isolated project namespace; data persists).
    Write-Stage "Starting staging PostgreSQL (project torwatch-staging; data persists across stop/start)..."
    Invoke-Compose @("up", "-d")
    Wait-PostgresHealthy

    # 2. Backend from the working tree.
    Write-Stage "Building the Go backend from the working tree..."
    New-Item -ItemType Directory -Force -Path $buildDirectory, $logsDirectory | Out-Null
    Push-Location (Join-Path $repositoryRoot "torrent-streamer")
    try {
        & go build -o $backendBinary ./cmd/vod
        if ($LASTEXITCODE -ne 0) { throw "go build failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }

    # 3. Production browser build with the EXACT backend origin baked into its
    #    CSP/connect-src. In tailscale mode that is the tailnet backend origin,
    #    so a phone reaches the backend through the same private HTTPS.
    Write-Stage "Building the production browser bundle (exact backend origin baked into CSP)..."
    Push-Location $electronDirectory
    try {
        $env:VITE_TORWATCH_BACKEND_URL = $originPlan.backendOrigin
        # Production browser/mobile staging is BFF-only. Without this flag
        # the shared Title page falls back to renderer-side provider calls
        # and incorrectly asks the browser for a TMDb credential.
        $env:VITE_CATALOG_SOURCE = "bff"
        # Invoke the project-local Vite entry directly. This avoids relying on
        # the user's global npm/npx shims (which can be stale or broken after
        # a Node upgrade) while still using the lockfile-installed toolchain.
        $viteEntry = Join-Path $electronDirectory "node_modules\vite\bin\vite.js"
        & node $viteEntry build --config vite.config.browser.mts
        if ($LASTEXITCODE -ne 0) { throw "build:browser failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }

    # 4. Validation-stub mode: deterministic upstream provider (validation
    #    only, clearly labelled). Never used when a real TMDB_API_KEY exists.
    $stubPid = $null
    $providerMode = "live provider credentials from environment (TMDB_API_KEY)"
    $withStub = $false
    if ($ValidationStub) {
        if ($envValues["TMDB_API_KEY"]) {
            Write-Stage "TMDB_API_KEY is set - the live provider is used and -ValidationStub is ignored."
        } else {
            $withStub = $true
            $providerMode = "DETERMINISTIC PROVIDER STUB on 127.0.0.1:4499 (validation only; stub-backed evidence)"
        }
    }
    $backendEnv = New-BackendEnvironment $envValues $originPlan $withStub $WithProwlarr ([bool]$LanMode)
    New-Item -ItemType Directory -Force -Path $backendEnv["TORRENT_DATA_ROOT"], $backendEnv["SUB_CACHE_DIR"] | Out-Null

    # 5. Start the backend and the production browser server (localhost only).
    # PowerShell 5.1 Start-Process cannot take an env block: export the
    # backend environment into THIS process so the child inherits it.
    foreach ($key in $backendEnv.Keys) { Set-Item -Path "env:$key" -Value $backendEnv[$key] }
    $startedPids = @()
    $startupComplete = $false
    try {
        if ($withStub) {
            $stubProc = Start-ProviderStub
            $stubPid = $stubProc.Id
            $startedPids += $stubPid
        }
        $backendProc = Start-Process -FilePath $backendBinary -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logsDirectory "backend-stdout.log") `
            -RedirectStandardError (Join-Path $logsDirectory "backend-stderr.log")
        $backendPid = $backendProc.Id
        $startedPids += $backendPid
        $frontendProc = Start-Process -FilePath "node" `
            -ArgumentList (Join-Path $stagingDirectory "serve-browser.mjs"), "--port", "$($envValues["FRONTEND_PORT"])" `
            -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $logsDirectory "frontend-stdout.log") `
            -RedirectStandardError (Join-Path $logsDirectory "frontend-stderr.log")
        $frontendPid = $frontendProc.Id
        $startedPids += $frontendPid

        Wait-HttpReady "http://127.0.0.1:$($envValues["BACKEND_PORT"])/readyz" 30
        Wait-HttpReady "http://127.0.0.1:$($envValues["FRONTEND_PORT"])/browser.html" 20
    } catch {
        # Failed-startup cleanup: kill ONLY the processes this start created.
        foreach ($recorded in $startedPids) { Stop-RecordedProcess $recorded }
        throw "Staging startup failed: $($_.Exception.Message)"
    }

    Write-State @{
        backendPid = $backendPid
        frontendPid = $frontendPid
        stubPid = $stubPid
        startedAt = (Get-Date).ToString("o")
        providerMode = $providerMode
        prowlarrEnabled = [bool]$WithProwlarr
        lanMode = [bool]$LanMode
        origins = @{
            frontend = $originPlan.frontendOrigin
            backend = $originPlan.backendOrigin
            localFrontend = $originPlan.localOrigins.frontendOrigin
            localBackend = $originPlan.localOrigins.backendOrigin
        }
        tailscale = @{
            enabled = $originPlan.useTailscale
            scheme = $tailnetScheme
            servedPorts = $served
            pendingEnableUrl = $tailnetPendingUrl
        }
        env = @{ backendPort = $envValues["BACKEND_PORT"]; frontendPort = $envValues["FRONTEND_PORT"] }
    }
    $startupComplete = $true

    Write-Host ""
    Write-Host "Staging is running." -ForegroundColor Green
    Write-Host ("  Provider mode : " + $providerMode)
    Write-Host ("  Torrent search: " + $(if ($WithProwlarr) { "live Prowlarr" } else { "degraded (use -WithProwlarr to enable)" }))
    Write-Host ("  Local UI      : http://127.0.0.1:$($envValues["FRONTEND_PORT"])/browser.html")
    Write-Host ("  Local backend : http://127.0.0.1:$($envValues["BACKEND_PORT"])/readyz")
    if ($LanMode) {
        $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254*" -and $_.InterfaceAlias -notmatch "Loopback|vEthernet|Tailscale" } | Select-Object -First 1).IPAddress
        if ($lanIp) {
            Write-Host ("  LAN API       : http://" + $lanIp + ":" + $($envValues["BACKEND_PORT"]) + "   (SAME trusted Wi-Fi only; no authentication — enter this in the mobile app)")
            Write-Host "                  NOTE: -WithCapacitorOrigins is required for the app to talk to it."
        } else {
            Write-Host "  LAN API       : no LAN IPv4 address found - check the network"
        }
    }
    if ($originPlan.useTailscale) {
        Write-Host ("  Tailnet UI    : $($originPlan.frontendOrigin)/browser.html   (private tailnet; Funnel is never used)")
        Write-Host ("  Tailnet API   : $($originPlan.backendOrigin)/readyz")
    }
    if ($tailnetPendingUrl) {
        Write-Host ""
        Write-Host "  ACTION REQUIRED (one step): enable Tailscale Serve for this tailnet by opening" -ForegroundColor Yellow
        Write-Host ("  " + $tailnetPendingUrl) -ForegroundColor Yellow
        Write-Host "  then run 'staging.ps1 Stop' and 'staging.ps1 Start' again. Staging runs LOCAL-ONLY until then." -ForegroundColor Yellow
    }
    Write-Host "  Stop          : deploy\desktop-staging\staging.ps1 Stop"
    Write-Host "  Status        : deploy\desktop-staging\staging.ps1 Status"
    Write-Host "  Data persists across Stop/Start. 'Reset' wipes it (explicit only)."
}

function Invoke-StagingStatus {
    $state = Read-State
    if (-not $state) { Write-Stage "Not started (no state file)."; return }
    Write-Stage ("Started at: " + $state.startedAt)
    Write-Stage ("Provider mode: " + $state.providerMode)
    Write-Stage ("Torrent search: " + $(if ($state.prowlarrEnabled) { "live Prowlarr" } else { "degraded" }))
    Write-Stage ("Backend pid $($state.backendPid): " + $(if (Test-ProcessAlive $state.backendPid) { "running" } else { "NOT RUNNING" }))
    Write-Stage ("Frontend pid $($state.frontendPid): " + $(if (Test-ProcessAlive $state.frontendPid) { "running" } else { "NOT RUNNING" }))
    if ($state.stubPid) {
        Write-Stage ("Provider stub pid $($state.stubPid): " + $(if (Test-ProcessAlive $state.stubPid) { "running" } else { "NOT RUNNING" }))
    }
    & docker ps --filter "name=torwatch-staging-postgres" --format "{{.Names}} {{.Status}}"
    if ($state.tailscale.enabled -and $state.tailscale.servedPorts) {
        Write-Stage ("Tailscale Serve ports recorded: " + ($state.tailscale.servedPorts -join ", "))
        $tailscale = Test-TailscaleUsable
        if ($tailscale) { (& $tailscale.exe serve status 2>&1) | Out-String | Write-Host }
    } elseif ($state.tailscale.pendingEnableUrl) {
        Write-Stage "Tailscale Serve PENDING user enablement (staging is LOCAL-ONLY):"
        Write-Stage ("  Open " + $state.tailscale.pendingEnableUrl)
        Write-Stage "  Then: staging.ps1 Stop; staging.ps1 Start (same switches)."
    }
    try {
        $ready = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$($state.env.backendPort)/readyz"
        Write-Stage ("Backend /readyz: " + $ready.Content)
    } catch { Write-Fail "Backend /readyz unreachable." }
    try {
        $version = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$($state.env.backendPort)/v1/version"
        Write-Stage ("Backend /v1/version: " + $version.Content)
    } catch { Write-Fail "Backend /v1/version unreachable." }
}

function Stop-Staging {
    $state = Read-State
    if (-not $state) { Write-Stage "Nothing to stop (no state file)."; return }
    Stop-RecordedProcess $state.backendPid
    Stop-RecordedProcess $state.frontendPid
    if ($state.stubPid) { Stop-RecordedProcess $state.stubPid }
    if ($state.tailscale.enabled -and $state.tailscale.servedPorts) {
        $tailscale = Test-TailscaleUsable
        if ($tailscale) {
            foreach ($port in $state.tailscale.servedPorts) {
                Remove-TailscaleServeMapping $tailscale.exe $port
            }
        }
    }
    Invoke-Compose @("stop")
    Remove-Item -LiteralPath $stateFile -Force
    Write-Stage "Stopped. Staging data (PostgreSQL volume) is preserved; 'Reset' wipes it explicitly."
}

# Stop after an INTERRUPTED startup (no/lost state.json): stops only processes
# whose command lines prove they belong to this staging harness, then leaves
# the PostgreSQL container running untouched if compose was not the owner.
function Stop-StagingLeftovers {
    $state = Read-State
    if ($state) {
        Stop-Staging
        return
    }
    $owned = Get-StagingOwnedPortProcesses
    if ($owned.Count -eq 0) {
        Write-Stage "No staging-owned processes found on the harness ports; nothing to stop."
    } else {
        foreach ($ownedPid in $owned) {
            Write-Stage "Stopping verified staging-owned leftover pid $ownedPid."
            Stop-RecordedProcess $ownedPid
        }
        Write-Stage "Leftovers stopped (verified staging ownership only). PostgreSQL/data untouched."
    }
    # Best-effort removal of harness Serve mappings (exact harness ports only;
    # tolerant if none exist). Funnel is never touched.
    $tailscale = Test-TailscaleUsable
    if ($tailscale) {
        foreach ($port in @(443, 8443, 8080, 8081)) {
            Remove-TailscaleServeMapping $tailscale.exe $port
        }
    }
}

function Restart-StagingBackend {
    $state = Read-State
    if (-not $state) { throw "Staging is not running. Run Start first." }
    if (Test-ProcessAlive $state.backendPid) {
        Stop-RecordedProcess $state.backendPid
        Start-Sleep -Seconds 1
    } else {
        Write-Stage "Recorded backend pid $($state.backendPid) is not running; recovering it in place."
    }
    $envValues = Read-StagingEnvironment
    $withStub = ($state.providerMode -match "STUB")
    $withLiveProwlarr = [bool]$state.prowlarrEnabled
    if ($withLiveProwlarr) { Assert-ProwlarrReady (Get-ProwlarrConnection) }
    $backendEnv = New-BackendEnvironment $envValues @{ frontendOrigin = $state.origins.frontend } $withStub $withLiveProwlarr ([bool]$state.lanMode)
    foreach ($key in $backendEnv.Keys) { Set-Item -Path "env:$key" -Value $backendEnv[$key] }
    if ($withStub) {
        if (-not (Test-ProcessAlive $state.stubPid)) {
            $stubProc = Start-ProviderStub
            $state.stubPid = $stubProc.Id
        } else {
            Wait-HttpReady "http://127.0.0.1:4499/healthz" 10
        }
    }
    $backendProc = Start-Process -FilePath $backendBinary -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logsDirectory "backend-stdout.log") `
        -RedirectStandardError (Join-Path $logsDirectory "backend-stderr.log")
    Wait-HttpReady "http://127.0.0.1:$($envValues["BACKEND_PORT"])/readyz" 30
    $state.backendPid = $backendProc.Id
    Write-State $state
    Write-Stage "Backend restarted (staged data intact)."
}

function Invoke-StagingVerification([bool]$afterRestart) {
    $state = Read-State
    if (-not $state) { throw "Staging is not running. Run Start first." }
    if (-not (Test-ProcessAlive $state.backendPid)) { throw "Backend pid $($state.backendPid) is not running. Run RestartBackend first." }
    if (-not (Test-ProcessAlive $state.frontendPid)) { throw "Frontend pid $($state.frontendPid) is not running. Stop and Start staging again." }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required to run staging verification." }

    $verifyScript = Join-Path $stagingDirectory "verify-staging.mjs"
    $arguments = @($verifyScript, $state.origins.frontend, $state.origins.backend)
    if ($afterRestart) { $arguments += "--afterRestart" }
    Write-Stage ("Running " + $(if ($afterRestart) { "post-restart persistence verification" } else { "complete staging verification" }) + "...")
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw "Staging verification failed (exit $LASTEXITCODE). See the FAIL line above." }
}

function New-PlaybackFixtures {
    $envValues = Read-StagingEnvironment
    $ffmpeg = $envValues["FFMPEG_PATH"]
    $ffprobe = $envValues["FFPROBE_PATH"]
    if (-not $ffmpeg -or -not $ffprobe) {
        Write-Stage "SKIP: FFMPEG_PATH/FFPROBE_PATH are not configured in the staging environment (.env or process env)."
        Write-Stage "  The playback capability stays OFF and VerifyPlayback stays a truthful SKIP."
        return
    }
    if (-not (Test-Path -LiteralPath $ffmpeg)) { throw "FFMPEG_PATH does not exist: the configured tool path is invalid (value not echoed)." }
    if (-not (Test-Path -LiteralPath $ffprobe)) { throw "FFPROBE_PATH does not exist: the configured tool path is invalid (value not echoed)." }
    $fixtureRoot = $envValues["TORWATCH_PLAYBACK_FIXTURE_ROOT"]
    if (-not $fixtureRoot) { $fixtureRoot = Join-Path $stagingDirectory "data\playback-fixtures" }
    New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
    $direct = Join-Path $fixtureRoot "1111111111111111111111111111111111111111.mp4"
    $remux = Join-Path $fixtureRoot "2222222222222222222222222222222222222222.mkv"
    $transcode = Join-Path $fixtureRoot "3333333333333333333333333333333333333333.mp4"
    $srt = Join-Path $fixtureRoot "2222222222222222222222222222222222222222.srt"
    $vtt = Join-Path $fixtureRoot "4444444444444444444444444444444444444444.vtt"
    $ass = Join-Path $fixtureRoot "2222222222222222222222222222222222222222_styled.ass"
    Write-Stage "Generating deterministic playback fixtures under the ignored staging data location..."
    & $ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc=duration=3:size=320x240:rate=10" -f lavfi -i "sine=frequency=440:duration=3" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $direct
    if ($LASTEXITCODE -ne 0) { throw "direct MP4 fixture failed" }
    & $ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc=duration=3:size=320x240:rate=10" -f lavfi -i "sine=frequency=440:duration=3" -c:v libx264 -pix_fmt yuv420p -c:a aac $remux
    if ($LASTEXITCODE -ne 0) { throw "MKV remux fixture failed" }
    & $ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc=duration=3:size=320x240:rate=10" -f lavfi -i "sine=frequency=440:duration=3" -c:v mpeg4 -c:a aac -shortest $transcode
    if ($LASTEXITCODE -ne 0) { throw "transcode fixture failed" }
    & $ffmpeg -nostdin -loglevel error -y -f lavfi -i "testsrc=duration=3:size=320x240:rate=10" -f lavfi -i "sine=frequency=440:duration=3" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $directVttMedia
    if ($LASTEXITCODE -ne 0) { throw "VTT direct fixture failed" }
    $srtText = "1" + [Environment]::NewLine + "00:00:00,500 --> 00:00:02,000" + [Environment]::NewLine + "Fixture subtitle (English)" + [Environment]::NewLine
    Set-Content -LiteralPath $srt -Value $srtText -Encoding UTF8
    $vttText = "WEBVTT" + [Environment]::NewLine + [Environment]::NewLine + "00:00:00.500 --> 00:00:02.000" + [Environment]::NewLine + "Fixture subtitle (WebVTT)" + [Environment]::NewLine
    Set-Content -LiteralPath $vtt -Value $vttText -Encoding UTF8
    $assText = "[Script Info]" + [Environment]::NewLine + "ScriptType: v4.00+" + [Environment]::NewLine + [Environment]::NewLine + "[V4+ Styles]" + [Environment]::NewLine + "Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding" + [Environment]::NewLine + "Style: Default,Arial,20,&H00FFFFFF,&H00000000,0,0,1,1,0,2,10,10,10,1" + [Environment]::NewLine + [Environment]::NewLine + "[Events]" + [Environment]::NewLine + "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text" + [Environment]::NewLine + "Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,Fixture styled subtitle (ASS; styling is intentionally dropped by the VTT conversion)" + [Environment]::NewLine
    Set-Content -LiteralPath $ass -Value $assText -Encoding UTF8
    Write-Stage ("Fixtures ready: " + $fixtureRoot)
    Write-Stage "Set TORWATCH_PLAYBACK_FIXTURE_ROOT there (or add it to .env) and restart staging to plan against them."
}
function Invoke-PlaybackVerification {
    $state = Read-State
    if (-not $state) { throw "Staging is not running. Run Start first." }
    if (-not (Test-ProcessAlive $state.backendPid)) { throw "Backend pid $($state.backendPid) is not running." }
    $script = Join-Path $stagingDirectory "verify-playback-service.mjs"
    # Deterministic service checks run against the LOCAL backend origin.
    & node $script $state.origins.localBackend
    if ($LASTEXITCODE -ne 0) { throw "Playback-service verification failed (exit $LASTEXITCODE)." }
}

function Invoke-SourceVerification {
    $state = Read-State
    if (-not $state) { throw "Staging is not running. Run Start -WithProwlarr first." }
    if (-not $state.prowlarrEnabled) { throw "This staging instance was started without -WithProwlarr. Stop it and start again with that switch." }
    if (-not (Test-ProcessAlive $state.backendPid)) { throw "Backend pid $($state.backendPid) is not running." }
    $script = Join-Path $stagingDirectory "verify-playback-source.mjs"
    # The source probe is server-side: the LOCAL backend origin is used so the
    # check never depends on tailnet Serve availability.
    & node $script $state.origins.localBackend
    if ($LASTEXITCODE -ne 0) { throw "Focused source/playback verification failed (exit $LASTEXITCODE)." }
}

function Reset-StagingData {
    if (-not $Force) {
        $answer = Read-Host "This WIPES the staging PostgreSQL volume (torwatch-staging_pgdata). Type 'WIPE' to continue"
        if ($answer -ne "WIPE") { Write-Stage "Reset aborted."; return }
    }
    $state = Read-State
    if ($state -and (Test-ProcessAlive $state.backendPid)) { throw "Stop staging before resetting." }
    Invoke-Compose @("down", "-v")
    if ($state) { Remove-Item -LiteralPath $stateFile -Force }
    Write-Stage "Staging data wiped (project-scoped volume removed). Next Start recreates an empty database."
}

try {
    switch ($Command) {
        "Start" { Start-Staging }
        "Status" { Invoke-StagingStatus }
        "Stop" { Stop-Staging }
        "StopLeftovers" { Stop-StagingLeftovers }
        "RestartBackend" { Restart-StagingBackend }
        "Verify" { Invoke-StagingVerification $false }
        "VerifyAfterRestart" {
            Restart-StagingBackend
            Invoke-StagingVerification $true
        }
        "VerifySource" { Invoke-SourceVerification }
        "Make-PlaybackFixtures" { New-PlaybackFixtures }
        "VerifyPlayback" { Invoke-PlaybackVerification }
        "Reset" { Reset-StagingData }
    }
} catch {
    Write-Fail $_.Exception.Message
    exit 1
}
