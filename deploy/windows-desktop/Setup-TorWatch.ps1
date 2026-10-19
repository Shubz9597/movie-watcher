<#
.SYNOPSIS
Sets up TorWatch on a new Windows computer in one go.

.DESCRIPTION
1. Installs (or updates) the TorWatch desktop app from this folder, silently.
2. Connects it to a TorWatch server, either:
   - an existing server (the default), for example your home server: the
     same library, watch progress and Continue Watching as your other
     devices. Nothing else is installed. If the server is only reachable
     over Tailscale, the script offers to install Tailscale and waits while
     you sign in.
   - a new server on this computer (-Local): installs Docker Desktop if it
     is missing (winget), starts it, and runs LocalServer\Start-TorWatchServer.ps1,
     which asks for your TMDb key. That server keeps its own library and
     watch progress.
3. Saves the server address where TorWatch reads it and starts TorWatch,
   ready to use (no setup screen).

Run it again at any time: it updates the app and re-checks the server.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-TorWatch.ps1
Asks for the server address (the one your phone uses).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-TorWatch.ps1 -Server http://homeserver.example.ts.net:8080

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-TorWatch.ps1 -Local
#>
[CmdletBinding()]
param(
    # The server's address with its port, as your other devices use it.
    [string]$Server = '',
    # Set up a new server on this computer with Docker Desktop instead.
    [switch]$Local,
    [ValidateRange(1024, 65535)][int]$LocalPort = 8080,
    # The installer to use (default: the newest "TorWatch Setup *.exe" here).
    [string]$Installer = '',
    [switch]$SkipInstall,
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$protocolVersion = 1 # the desktop app speaks server protocol 1

function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Note([string]$Text) { Write-Host "    $Text" }
function Ask-YesNo([string]$Question, [bool]$Default = $true) {
    $hint = '[y/N]'
    if ($Default) { $hint = '[Y/n]' }
    $answer = (Read-Host "    $Question $hint").Trim().ToLowerInvariant()
    if (-not $answer) { return $Default }
    return $answer -in @('y', 'yes')
}

# --- The installed app -------------------------------------------------------

function Get-InstalledTorWatch {
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $roots) {
        $entry = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like 'TorWatch*' -and $_.InstallLocation } |
            Select-Object -First 1
        if ($entry) {
            $exe = Join-Path $entry.InstallLocation 'TorWatch.exe'
            if (Test-Path -LiteralPath $exe) { return @{ Exe = $exe; Version = [string]$entry.DisplayVersion } }
        }
    }
    $default = Join-Path $env:LOCALAPPDATA 'Programs\TorWatch\TorWatch.exe'
    if (Test-Path -LiteralPath $default) { return @{ Exe = $default; Version = '' } }
    return $null
}

function Get-VersionOf([string]$Text) {
    $match = [regex]::Match([string]$Text, '\d+(\.\d+){1,3}')
    if ($match.Success) { return [version]$match.Value }
    return $null
}

function Stop-TorWatch {
    $running = Get-Process -Name 'TorWatch' -ErrorAction SilentlyContinue
    if (-not $running) { return }
    if (-not (Ask-YesNo 'TorWatch is open. Close it to continue?')) { throw 'Close TorWatch, then run this script again.' }
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

function Install-TorWatch {
    $installed = Get-InstalledTorWatch
    if ($SkipInstall) {
        if (-not $installed) { throw 'TorWatch is not installed. Run without -SkipInstall.' }
        Note "Using the installed TorWatch $($installed.Version)."
        return $installed
    }
    $setup = $Installer
    if (-not $setup) {
        $setup = Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'TorWatch Setup *.exe' -File -ErrorAction SilentlyContinue |
            Sort-Object { Get-VersionOf $_.Name } -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $setup -or -not (Test-Path -LiteralPath $setup)) {
        if ($installed) { Note "No installer beside this script; keeping TorWatch $($installed.Version)."; return $installed }
        throw "No 'TorWatch Setup *.exe' found beside this script. Extract the whole TorWatch Windows ZIP and run the script from it, or pass -Installer <path>."
    }
    $bundled = Get-VersionOf (Split-Path -Leaf $setup)
    $current = Get-VersionOf $installed.Version
    if ($installed -and $bundled -and $current -and $current -ge $bundled) {
        Note "TorWatch $current is already installed."
        return $installed
    }
    Stop-TorWatch
    Note "Installing $(Split-Path -Leaf $setup)..."
    $process = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "The installer stopped with code $($process.ExitCode)." }
    $installed = Get-InstalledTorWatch
    if (-not $installed) { throw 'The installer finished but TorWatch was not found. Run the installer by double-clicking it.' }
    Note "Installed TorWatch $($installed.Version)."
    return $installed
}

# --- Servers -----------------------------------------------------------------

function ConvertTo-Origin([string]$Address) {
    $text = $Address.Trim()
    if (-not $text) { throw 'Enter the server address.' }
    if ($text -notmatch '^[a-z]+://') { $text = "http://$text" }
    try { $uri = [Uri]$text } catch { throw "'$Address' is not a valid address." }
    if ($uri.Scheme -notin @('http', 'https')) { throw 'The address must start with http:// or https://.' }
    if ($uri.UserInfo -or $uri.Query -or $uri.Fragment -or ($uri.AbsolutePath -ne '/')) {
        throw 'Enter only the server address and port, without a path, for example http://192.168.1.20:8080.'
    }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

# Same checks as the app's "Test connection": ready, and a protocol it speaks.
function Test-TorWatchServer([string]$Origin) {
    try {
        $ready = Invoke-WebRequest -Uri "$Origin/readyz" -UseBasicParsing -TimeoutSec 10
        if ($ready.StatusCode -ne 200) { return "The server is not ready (HTTP $($ready.StatusCode))." }
        $version = Invoke-RestMethod -Uri "$Origin/v1/version" -TimeoutSec 10
    } catch {
        return 'The server could not be reached.'
    }
    $range = @($version.supportedProtocolRange)
    if ($range.Count -ne 2 -or $range[0] -gt $protocolVersion -or $range[1] -lt $protocolVersion) {
        return 'This server uses an incompatible protocol. Update the server or this app.'
    }
    Note "Connected to TorWatch server $($version.serverVersion) at $Origin."
    return $null
}

function Test-TailnetAddress([string]$Origin) {
    $hostName = ([Uri]$Origin).Host
    if ($hostName -like '*.ts.net') { return $true }
    $parts = $hostName.Split('.')
    return $parts.Count -eq 4 -and $parts[0] -eq '100' -and [int]$parts[1] -ge 64 -and [int]$parts[1] -le 127
}

function Get-TailscaleExe {
    $command = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $path = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $path) { return $path }
    return $null
}

function Install-WithWinget([string]$Id, [string]$Name) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "Install $Name from its website (winget is not available on this computer), then run this script again."
    }
    Note "Installing $Name with winget..."
    & winget install --exact --id $Id --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget could not install $Name (code $LASTEXITCODE). Install it yourself, then run this script again." }
}

function Wait-ForServer([string]$Origin, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-TorWatchServer $Origin)) { return $true }
        Start-Sleep -Seconds 5
    }
    return $false
}

function Connect-ExistingServer {
    $origin = ''
    if ($Server) {
        $origin = ConvertTo-Origin $Server
    } else {
        $saved = Read-SavedConnection
        if ($saved -and $saved.mode -eq 'remote' -and (Ask-YesNo "Keep using $($saved.origin)?")) {
            $origin = [string]$saved.origin
        } else {
            Note 'Enter the address your phone uses for TorWatch, with its port,'
            Note 'for example http://homeserver.your-tailnet.ts.net:8080 or http://192.168.1.20:8080.'
            $origin = ConvertTo-Origin (Read-Host '    Server address')
        }
    }

    $problem = Test-TorWatchServer $origin
    if (-not $problem) { return $origin }
    Note $problem

    if (Test-TailnetAddress $origin) {
        Note 'This address is on Tailscale: this computer has to be on the same tailnet.'
        $tailscale = Get-TailscaleExe
        if (-not $tailscale) {
            if (-not (Ask-YesNo 'Install Tailscale now?')) { throw 'Install Tailscale, sign in with the same account as your server, then run this script again.' }
            Install-WithWinget 'Tailscale.Tailscale' 'Tailscale'
            $tailscale = Get-TailscaleExe
        }
        if ($tailscale) {
            # Its own window: it shows (and opens) the sign-in link when needed.
            Note 'Sign in to Tailscale with the same account as your server (a browser window opens if needed).'
            Start-Process -FilePath $tailscale -ArgumentList 'up' -ErrorAction SilentlyContinue
        }
        Note 'Waiting for the server (up to 5 minutes)...'
        if (Wait-ForServer $origin 300) { return $origin }
        throw "Still cannot reach $origin. Check that Tailscale shows this computer as connected, then run this script again."
    }
    throw "Cannot use $origin. Check the address and port, that the server is running, and that this computer is on its network."
}

function Start-DockerDesktop {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Note 'Docker Desktop is needed to run a server on this computer.'
        if (-not (Ask-YesNo 'Install Docker Desktop now? (it may ask to restart Windows)')) {
            throw 'Install Docker Desktop with Linux containers, then run this script again with -Local.'
        }
        Install-WithWinget 'Docker.DockerDesktop' 'Docker Desktop'
        Note 'Docker Desktop is installed. If Windows asks to restart, restart, open Docker Desktop once to finish its setup,'
        Note 'then run this script again with -Local.'
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { exit 0 }
    }
    $engine = & docker info --format '{{.OSType}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $engine -eq 'linux') { return }
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path -LiteralPath $desktop) {
        Note 'Starting Docker Desktop...'
        Start-Process -FilePath $desktop
    }
    Note 'Waiting for the Docker engine (up to 4 minutes)...'
    $deadline = (Get-Date).AddMinutes(4)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        $engine = & docker info --format '{{.OSType}}' 2>$null
        if ($LASTEXITCODE -eq 0 -and $engine -eq 'linux') { return }
    }
    throw 'The Docker engine did not start. Open Docker Desktop, make sure it uses Linux containers and finishes starting, then run this script again.'
}

function Start-LocalServer {
    $starter = Join-Path $PSScriptRoot 'LocalServer\Start-TorWatchServer.ps1'
    if (-not (Test-Path -LiteralPath $starter)) { $starter = Join-Path $PSScriptRoot 'Start-TorWatchServer.ps1' }
    if (-not (Test-Path -LiteralPath $starter)) { throw 'LocalServer\Start-TorWatchServer.ps1 was not found. Extract the whole TorWatch Windows ZIP.' }
    Start-DockerDesktop
    Note 'Starting the TorWatch server (the first start builds it and can take several minutes)...'
    & $starter -Action Start -Port $LocalPort
    if (-not $?) { throw 'The local server did not start. Fix the problem shown above, then run this script again.' }
    $port = $LocalPort
    $settings = Join-Path $env:LOCALAPPDATA 'TorWatchLocalServer\server.json'
    if (Test-Path -LiteralPath $settings) {
        $saved = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json
        if ($saved.port) { $port = [int]$saved.port } # an earlier start may have chosen another port
    }
    $origin = "http://127.0.0.1:$port"
    if (-not (Wait-ForServer $origin 120)) { throw "The local server does not answer at $origin." }
    return $origin
}

# --- The app's saved server --------------------------------------------------

function Get-ConnectionPath { return Join-Path $env:APPDATA 'TorWatch\desktop-server.json' }

function Read-SavedConnection {
    $path = Get-ConnectionPath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $null }
}

# What the app's "Save and start TorWatch" writes. No byte-order mark: the
# app parses the file as plain JSON.
function Save-Connection([string]$Mode, [string]$Origin) {
    $path = Get-ConnectionPath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    $json = (@{ mode = $Mode; origin = $Origin } | ConvertTo-Json -Compress)
    [IO.File]::WriteAllText($path, "$json`n", (New-Object Text.UTF8Encoding($false)))
    $builtIn = Join-Path (Split-Path -Parent $path) 'desktop-builtin-services'
    Remove-Item -LiteralPath $builtIn -Force -ErrorAction SilentlyContinue
    Note "Saved: TorWatch uses $Origin."
}

# --- Run ---------------------------------------------------------------------

Write-Host 'TorWatch setup' -ForegroundColor White

Step '1/3  The TorWatch app'
$app = Install-TorWatch

if ($Local) {
    Step '2/3  A new TorWatch server on this computer'
    $origin = Start-LocalServer
    $mode = 'local'
} else {
    Step '2/3  Your TorWatch server'
    $origin = Connect-ExistingServer
    $mode = 'remote'
}

Step '3/3  Connecting the app'
Stop-TorWatch
Save-Connection $mode $origin
if ($mode -eq 'local') {
    Note 'This server keeps its own library and watch progress. It keeps running after TorWatch closes;'
    Note 'LocalServer\Start-TorWatchServer.ps1 -Action Status / Stop / Start manages it.'
} else {
    Note 'Library, watch progress and Continue Watching are shared with your other devices on this server.'
}

if (-not $NoLaunch) {
    Start-Process -FilePath $app.Exe
    Note 'TorWatch is starting.'
}
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
