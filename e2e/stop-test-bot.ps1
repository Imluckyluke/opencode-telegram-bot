# Stops the test bot and the OpenCode server it started.
#
# Deliberately narrow: it only touches processes that provably belong to the
# test setup.
#   - OpenCode: whatever listens on the port from e2e/.env (OPENCODE_API_URL).
#     Your working OpenCode on another port is never touched.
#   - Bot: node processes whose pid appears in a log file name inside
#     .tmp/e2e/home/logs. A production bot started from the same dist/ writes to
#     a different home, so it is not matched.
#   - Fault proxy: the node process named in .tmp/e2e/fault-proxy/proxy.pid,
#     only if its command line runs fault-proxy.mjs.
#
# Usage:
#   .\e2e\stop-test-bot.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$testHome = Join-Path $projectRoot ".tmp\e2e\home"
$logsDir = Join-Path $testHome "logs"
$sourceEnv = Join-Path $PSScriptRoot ".env"
$proxyPidFile = Join-Path $projectRoot ".tmp\e2e\fault-proxy\proxy.pid"

# --- OpenCode -------------------------------------------------------------

$port = 4096
if (Test-Path $sourceEnv) {
    $apiUrl = (Get-Content $sourceEnv | Where-Object { $_ -match '^\s*OPENCODE_API_URL\s*=' } | Select-Object -Last 1)
    if ($apiUrl -and $apiUrl -match ':(\d+)') {
        $port = [int]$Matches[1]
    }
}

Write-Host "OpenCode port from config: $port"

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
    $ocPid = $listener.OwningProcess
    $ocProc = Get-Process -Id $ocPid -ErrorAction SilentlyContinue
    Write-Host "  stopping OpenCode: PID $ocPid ($($ocProc.ProcessName))"
    try {
        Stop-Process -Id $ocPid -Force -ErrorAction Stop
        Write-Host "  stopped"
    } catch {
        Write-Warning "  failed to stop PID ${ocPid}: $($_.Exception.Message)"
    }
} else {
    Write-Host "  nothing listening on $port"
}

# --- Test bot -------------------------------------------------------------

$loggedPids = @()
if (Test-Path $logsDir) {
    $loggedPids = Get-ChildItem $logsDir -Filter "bot-*.log" -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_.Name -match '_(\d+)\.log$') { [int]$Matches[1] } } |
        Select-Object -Unique
}

Write-Host "Test bot pids seen in $logsDir : $($loggedPids.Count)"

$stopped = 0
foreach ($botPid in $loggedPids) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$botPid" -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.Name -ne "node.exe") { continue }
    if ($proc.CommandLine -notlike "*dist\index.js*") { continue }

    Write-Host "  stopping bot: PID $botPid"
    try {
        Stop-Process -Id $botPid -Force -ErrorAction Stop
        $stopped++
        Write-Host "  stopped"
    } catch {
        Write-Warning "  failed to stop PID ${botPid}: $($_.Exception.Message)"
    }
}

if ($stopped -eq 0) {
    Write-Host "  no running test bot found"
}

# --- Fault proxy ----------------------------------------------------------

$proxyStopped = $false
if (Test-Path $proxyPidFile) {
    $proxyPid = [int](Get-Content $proxyPidFile -Raw).Trim()
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$proxyPid" -ErrorAction SilentlyContinue
    if ($proc -and $proc.Name -eq "node.exe" -and $proc.CommandLine -like "*fault-proxy.mjs*") {
        Write-Host "  stopping fault proxy: PID $proxyPid"
        try {
            Stop-Process -Id $proxyPid -Force -ErrorAction Stop
            $proxyStopped = $true
            Write-Host "  stopped"
        } catch {
            Write-Warning "  failed to stop PID ${proxyPid}: $($_.Exception.Message)"
        }
    }
    Remove-Item $proxyPidFile -Force -ErrorAction SilentlyContinue
}

if (-not $proxyStopped) {
    Write-Host "  no fault proxy running"
}

# --- Result ---------------------------------------------------------------

Start-Sleep -Milliseconds 500
$still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
Write-Host ""
if ($still) {
    Write-Warning "Port $port is still in use."
} else {
    Write-Host "Port $port is free."
}
