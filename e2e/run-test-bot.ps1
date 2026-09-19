# Starts the bot against an isolated home directory so e2e runs never touch
# the real .env / settings.json / logs of the working copy.
#
# Usage:
#   .\e2e\run-test-bot.ps1
#   .\e2e\run-test-bot.ps1 -SkipBuild
#   .\e2e\run-test-bot.ps1 -FaultProxy    # route Bot API calls through e2e/fault-proxy.mjs

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$FaultProxy
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$testHome = Join-Path $projectRoot ".tmp\e2e\home"
$sourceEnv = Join-Path $PSScriptRoot ".env"
$runtimeEnv = Join-Path $testHome ".env"
$proxyDir = Join-Path $projectRoot ".tmp\e2e\fault-proxy"
$proxyPidFile = Join-Path $proxyDir "proxy.pid"
$proxyPort = 8765
$proxyRoot = "http://127.0.0.1:$proxyPort"

function Get-TestEnvValue([string]$name) {
    $line = Get-Content $sourceEnv | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
    if (-not $line) { return "" }
    return ($line -replace "^\s*$name\s*=\s*", "").Trim().Trim('"').Trim("'")
}

function Stop-LeftoverFaultProxy {
    if (-not (Test-Path $proxyPidFile)) { return }
    $proxyPid = [int](Get-Content $proxyPidFile -Raw).Trim()
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$proxyPid" -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -eq "node.exe" -and $proc.CommandLine -like "*fault-proxy.mjs*") {
        Write-Host "Stopping fault proxy left from a previous launch: PID $proxyPid"
        Stop-Process -Id $proxyPid -Force
    }
    Remove-Item $proxyPidFile -Force
}

if (-not (Test-Path $testHome)) {
    New-Item -ItemType Directory -Force -Path $testHome | Out-Null
    Write-Host "Created test home: $testHome"
}

if (-not (Test-Path $sourceEnv)) {
    Copy-Item (Join-Path $PSScriptRoot ".env.example") $sourceEnv
    Write-Host "Created $sourceEnv from e2e/.env.example."
    Write-Host "Fill in TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID, then run again."
    exit 1
}

# e2e/.env is the single source of truth. The test home holds runtime state
# only (settings.json, logs), so the config is re-synced on every launch.
Copy-Item $sourceEnv $runtimeEnv -Force

# dotenv does not override variables that already exist in the environment, so
# anything inherited from the parent process would silently win over the test
# config. Clear every key the test .env defines.
Get-Content $runtimeEnv | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
        Remove-Item "env:$($Matches[1])" -ErrorAction SilentlyContinue
    }
}

if ($FaultProxy) {
    # The bot rejects TELEGRAM_PROXY_URL together with TELEGRAM_API_ROOT, and the
    # fault proxy cannot tunnel through a SOCKS/HTTP proxy itself.
    if (Get-TestEnvValue "TELEGRAM_PROXY_URL") {
        Write-Error "-FaultProxy cannot be used while e2e/.env sets TELEGRAM_PROXY_URL."
        exit 1
    }
}

if (-not $SkipBuild) {
    Write-Host "Building..."
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Build failed."
        exit $LASTEXITCODE
    }
}

$env:OPENCODE_TELEGRAM_HOME = $testHome

if ($FaultProxy) {
    Stop-LeftoverFaultProxy
    New-Item -ItemType Directory -Force -Path $proxyDir | Out-Null

    # A stand that reaches Telegram through its own reverse proxy keeps doing so:
    # that root becomes the fault proxy's upstream.
    $upstream = Get-TestEnvValue "TELEGRAM_API_ROOT"
    if (-not $upstream) { $upstream = "https://api.telegram.org" }

    # No output redirection: with it the proxy inherits this shell's handles and
    # keeps a caller's pipe open for as long as it runs.
    $proxyScript = Join-Path $PSScriptRoot "fault-proxy.mjs"
    Start-Process node -ArgumentList @("`"$proxyScript`"", "--port", $proxyPort, "--upstream", "`"$upstream`"") `
        -WindowStyle Hidden

    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            Invoke-RestMethod "$proxyRoot/__fault/state" -TimeoutSec 1 | Out-Null
            $ready = $true
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $ready) {
        Write-Error "Fault proxy did not come up on port $proxyPort. Run 'node e2e/fault-proxy.mjs' in the foreground to see why."
        exit 1
    }
}

Write-Host ""
Write-Host "Test home : $testHome"
Write-Host "Logs      : $(Join-Path $testHome 'logs')"
Write-Host "Settings  : $(Join-Path $testHome 'settings.json')"
if ($FaultProxy) {
    Write-Host "Proxy     : $proxyRoot -> $upstream (control: $proxyRoot/__fault/state)"
    Write-Host "Call log  : $proxyDir"
}
Write-Host ""

# This script runs in the caller's session, so TELEGRAM_API_ROOT is pointed at the
# proxy for the bot launch only and restored even on Ctrl+C. Otherwise the next
# launch without -FaultProxy would silently go through the proxy.
$previousApiRoot = $env:TELEGRAM_API_ROOT
if ($FaultProxy) { $env:TELEGRAM_API_ROOT = $proxyRoot }
try {
    node (Join-Path $projectRoot "dist\index.js")
} finally {
    if ($FaultProxy) {
        if ($null -eq $previousApiRoot) {
            Remove-Item env:TELEGRAM_API_ROOT -ErrorAction SilentlyContinue
        } else {
            $env:TELEGRAM_API_ROOT = $previousApiRoot
        }
    }
}
