param([switch]$Worker)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
$manager = Join-Path $PSScriptRoot 'Manage-Bridge.ps1'
$privateDir = Join-Path $env:LOCALAPPDATA 'X14-Plus-Project-Bridge'
$taskName = 'X14-Plus-Project-Bridge-Runtime'
$statusFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime-status.json'
if ($Worker) {
    Start-Transcript -Path (Join-Path $privateDir 'independent-start.log') -Append | Out-Null
    try {
        Write-Output ('Runtime config directory: ' + $privateDir)
        Write-Output ('Runtime override present: ' + [bool]$env:X14_BRIDGE_CONFIG)
        $env:X14_BRIDGE_CONFIG = Join-Path $privateDir 'config.json'
        & $manager -Action Start
        & $manager -Action Status
        & (Get-Command node.exe).Source (Join-Path $PSScriptRoot 'verify-running.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Authenticated MCP verification failed.' }
        $proxyStatus = & (Join-Path $PSScriptRoot 'Ensure-Proxy.ps1')
        $lastProxyCheck = [DateTime]::UtcNow
        Write-Output $proxyStatus.message
        # Keep the task alive while its owned processes run; do not restart stopped processes.
        while ($true) {
            Start-Sleep -Seconds 5
            $state = Get-Content (Join-Path $privateDir 'runtime.json') -Raw | ConvertFrom-Json
            $alive = $false
            foreach ($record in @($state.bridge, $state.tunnel)) {
                if ($null -eq $record) { continue }
                $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
                if ($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $record.started) { $alive = $true }
            }
            if (-not $alive) { break }
            # Check once a minute; replace a missing forward without touching external SSH sessions.
            if (([DateTime]::UtcNow - $lastProxyCheck).TotalSeconds -ge 60) {
                $proxyStatus = & (Join-Path $PSScriptRoot 'Ensure-Proxy.ps1')
                $lastProxyCheck = [DateTime]::UtcNow
            }
            $cfg = Get-Content (Join-Path $privateDir 'config.json') -Raw | ConvertFrom-Json
            $bridgeHealthy = $false
            $tunnelReady = $false
            try {
                $health = Invoke-RestMethod "http://127.0.0.1:$($cfg.port)/healthz" -Headers @{Authorization=('Bearer ' + $cfg.http_token)} -TimeoutSec 2
                $bridgeHealthy = $health.ok -and $health.machine_id -eq $cfg.machine_id
                $response = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:18742/readyz' -TimeoutSec 2
                $tunnelReady = $response.StatusCode -eq 200
            } catch {}
            @{at=[DateTime]::UtcNow.ToString('o'); bridge=$bridgeHealthy; tunnel=$tunnelReady; worker_pid=$PID; mcp_verified=$true; version=2; proxy=$proxyStatus} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statusFile -Encoding UTF8
        }
    } finally { Stop-Transcript | Out-Null }
    exit
}
Import-Module ScheduledTasks -ErrorAction Stop
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $action = New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Worker') -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'On-demand Bridge and Tunnel runtime. No login trigger; no SSH forwarding changes.' | Out-Null
}
Start-ScheduledTask -TaskName $taskName
$ready = $false
for ($attempt=0; $attempt -lt 60; $attempt++) {
    try {
        $status = Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json
        if (([DateTime]::UtcNow - [DateTime]::Parse($status.at).ToUniversalTime()).TotalSeconds -lt 15 -and $status.version -eq 2 -and $status.bridge -and $status.tunnel -and $status.mcp_verified) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}
if (-not $ready) { throw "Tunnel not ready. See $privateDir\independent-start.log and tunnel.stderr.log" }
Write-Output 'Local bridge healthy: True'
Write-Output 'Tunnel readiness HTTP: 200'
Write-Output 'Authenticated HTTP MCP verification: PASS'
Write-Output ('Local Clash proxy: ' + $status.proxy.local_proxy)
Write-Output ('Remote proxy HTTPS: ' + $status.proxy.internet)
Write-Output ('SSH forwarding owner: ' + $status.proxy.owner)
Write-Output $status.proxy.message
if ($status.proxy.owner -eq 'external') { Write-Output 'Reusing existing forwarding (possibly Codex). If it disappears, the worker will attempt its own connection on the next check.' }
Write-Output 'Bridge/Tunnel started by Windows Task Scheduler. This launcher can be closed.'
