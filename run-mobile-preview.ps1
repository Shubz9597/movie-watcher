[CmdletBinding()]
param(
    [ValidateSet("Fixture", "Live")]
    [string]$Mode = "Fixture",

    [ValidateSet("ok", "unreachable", "incompatible", "provider-failure")]
    [string]$FixtureScenario = "ok",

    [string]$ServerOrigin = "http://localhost:4001",

    [ValidateRange(240, 2000)]
    [int]$Width = 390,

    [ValidateRange(320, 3000)]
    [int]$Height = 844,

    [ValidateRange(1, 65535)]
    [int]$Port = 5173
)

$ErrorActionPreference = "Stop"
$appDirectory = Join-Path $PSScriptRoot "electron-app"
$launcher = Join-Path $appDirectory "scripts\mobile-preview.mjs"
$packageFile = Join-Path $appDirectory "package.json"
$puppeteerPackage = Join-Path $appDirectory "node_modules\puppeteer\package.json"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required. Install Node.js 20 or newer, then run this script again."
}

if (-not (Test-Path -LiteralPath $packageFile)) {
    throw "Could not find electron-app\package.json relative to this script."
}

if (-not (Test-Path -LiteralPath $puppeteerPackage)) {
    # Review note (desktop-staging pass): the original ran `npm install`,
    # which can mutate the lockfile. The lockfile-driven `npm ci` is used
    # instead so preview setup never changes dependency resolution.
    Write-Host "Installing the electron-app dependencies from the lockfile (first run only)..." -ForegroundColor Cyan
    Push-Location $appDirectory
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

$launcherArguments = @(
    $launcher,
    "--port", $Port,
    "--width", $Width,
    "--height", $Height
)

if ($Mode -eq "Live") {
    $launcherArguments += @("--live", "--server", $ServerOrigin)
}
else {
    $launcherArguments += @("--fixture", $FixtureScenario)
}

Write-Host "Starting the TorWatch mobile preview. Close its browser window or press Ctrl+C here to stop." -ForegroundColor Green
& node $launcherArguments

if ($LASTEXITCODE -ne 0) {
    throw "The mobile preview exited with code $LASTEXITCODE."
}
