[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
    [string]$ConfigurationDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TorWatchLocalServer'),
    [string]$DataDirectory = '',
    [ValidateRange(1024, 65535)][int]$Port = 8080,
    [ValidateRange(1024, 65535)][int]$AdminPort = 19696,
    [ValidatePattern('^[a-z0-9][a-z0-9_-]*$')][string]$ProjectName = 'torwatch-local',
    [switch]$NonInteractive,
    [switch]$AllowDegradedCatalog,
    [switch]$Rebuild
)
$ErrorActionPreference = 'Stop'
$serverVersion = '2.0.1'
$image = "torwatch-server:windows-$serverVersion"
$configurationPath = [IO.Path]::GetFullPath($ConfigurationDirectory)
$envFile = Join-Path $configurationPath '.env'
$settingsFile = Join-Path $configurationPath 'server.json'
$packaged = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'backend/go.mod')
if ($packaged) {
    $backend = Join-Path $PSScriptRoot 'backend'
    $serverFiles = $PSScriptRoot
} else {
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $backend = Join-Path $repository 'torrent-streamer'
    $serverFiles = Join-Path $PSScriptRoot '../torwatch-server'
}
$compose = Join-Path $serverFiles 'compose.yaml'

function Invoke-Docker([string[]]$DockerArguments) {
    & docker @DockerArguments
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed. Check Docker Desktop and retry. No other Docker projects were changed." }
}
function Read-PrivateValue([string]$Prompt) {
    $secret = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
function New-Password {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop with Linux containers, then run this starter again.' }
$dockerOS = & docker info --format '{{.OSType}}' 2>$null
if ($LASTEXITCODE -ne 0 -or $dockerOS -ne 'linux') { throw 'Start Docker Desktop with Linux containers, wait until its engine is running, then retry.' }

if ($Action -eq 'Start' -and -not (Test-Path -LiteralPath $envFile)) {
    if ($Port -eq $AdminPort) { throw 'The gateway and Prowlarr admin ports must be different.' }
    if ([string]::IsNullOrWhiteSpace($DataDirectory)) { $DataDirectory = Join-Path $configurationPath 'data' }
    $dataPath = [IO.Path]::GetFullPath($DataDirectory).Replace('\', '/')
    if ($dataPath -match '[\r\n"''$#]') { throw 'Choose a data folder without quotes, dollar signs, hashes or line breaks.' }
    $tmdbKey = [string]$env:TORWATCH_LOCAL_TMDB_API_KEY
    if (-not $tmdbKey -and -not $NonInteractive) { $tmdbKey = Read-PrivateValue 'Your TMDb API key (hidden)' }
    if ($tmdbKey -and $tmdbKey -notmatch '^[0-9a-fA-F]{32}$') { throw 'Enter a TMDb v3 API key (32 hexadecimal characters). The configuration was not saved.' }
    if (-not $tmdbKey -and -not $AllowDegradedCatalog) { throw 'A TMDb API key is needed for browsing. Set TORWATCH_LOCAL_TMDB_API_KEY or run interactively.' }
    $openSubKey = ''
    if (-not $NonInteractive) { $openSubKey = Read-PrivateValue 'Optional OpenSubtitles API key (Enter to skip)' }
    if ($openSubKey -match '[\r\n"''$#]') { throw 'The OpenSubtitles key contains unsupported characters.' }
    New-Item -ItemType Directory -Force -Path $configurationPath, $dataPath | Out-Null
    $settings = @{ port = $Port; adminPort = $AdminPort; projectName = $ProjectName; version = $serverVersion }
    $settings | ConvertTo-Json | Set-Content -LiteralPath $settingsFile -Encoding UTF8
    $password = New-Password
    $lines = @(
        "TORWATCH_DATA_DIR=$dataPath", "TORWATCH_IMAGE=$image", "TORWATCH_VERSION=$serverVersion",
        "POSTGRES_PASSWORD=$password", "TMDB_API_KEY=$tmdbKey", "OPENSUB_API_KEY=$openSubKey",
        "GATEWAY_PORT=127.0.0.1:$Port", "PROWLARR_ADMIN_PORT=$AdminPort",
        'TORWATCH_ALLOWED_CLIENT_ORIGINS=null,http://localhost:5173,capacitor://localhost,https://localhost'
    )
    [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
    $password = $null; $tmdbKey = $null; $openSubKey = $null
    Write-Host "Local server configuration created in $configurationPath. Keep this folder private."
} elseif (-not (Test-Path -LiteralPath $envFile)) {
    throw 'This starter has no saved server configuration. Run it with -Action Start first.'
}
if (-not (Test-Path -LiteralPath $settingsFile)) { throw "Missing server.json beside the saved .env. Restore the matching server settings before continuing." }
$saved = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
$ProjectName = [string]$saved.projectName
if ($ProjectName -notmatch '^[a-z0-9][a-z0-9_-]*$') { throw 'The saved Docker project name is invalid.' }
$Port = [int]$saved.port
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'The saved gateway port is invalid.' }
$composeArguments = @('compose', '--project-name', $ProjectName, '--env-file', $envFile, '-f', $compose)
if ($Action -eq 'Status') { Invoke-Docker ($composeArguments + @('ps')); exit 0 }
if ($Action -eq 'Stop') { Invoke-Docker ($composeArguments + @('stop')); Write-Host 'Local TorWatch server stopped. Data is preserved.'; exit 0 }

Invoke-Docker ($composeArguments + @('config', '--quiet'))
$localImageId = & docker image ls --quiet --filter "reference=$image"
if ($LASTEXITCODE -ne 0) { throw 'Docker could not inspect the local image list.' }
if (-not $localImageId -or $Rebuild) {
    Write-Host 'Building the local TorWatch server image. The first build downloads its dependencies.'
    Invoke-Docker -DockerArguments @('build', '-f', (Join-Path $serverFiles 'Dockerfile'), '-t', $image, '--build-arg', "TORWATCH_VERSION=$serverVersion", $backend)
}
Write-Host 'Starting TorWatch: database, backend, Prowlarr, FlareSolverr and gateway...'
Invoke-Docker ($composeArguments + @('up', '--detach', '--wait', '--wait-timeout', '240'))
$origin = "http://127.0.0.1:$Port"
$ready = Invoke-RestMethod -Uri "$origin/readyz" -TimeoutSec 15
$version = Invoke-RestMethod -Uri "$origin/v1/version" -TimeoutSec 15
Write-Host "Server ready: $origin (version $($version.serverVersion))"
Write-Host 'In the Windows app choose Server on this PC, enter this URL, test and save.'
Write-Host 'This server has its own database. To resume your phone history, use its homeserver and link its existing viewing profile in the desktop app.'
