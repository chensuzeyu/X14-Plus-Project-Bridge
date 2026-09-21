param(
    [ValidateSet('Configure','RotateKey','Start','StartStandalone','Stop','Status','Doctor','StartProxy','EnableLoginStart','DisableLoginStart')]
    [string]$Action = 'Status'
)
$ErrorActionPreference = 'Stop'
# Windows OpenSSH exits 255 without diagnostics when ProgramData is absent.
# Recover it when this launcher is called from a filtered job environment.
if (-not $env:ProgramData) {
    $env:ProgramData = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders' -Name 'Common AppData'
}
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
}
$projectDir = Split-Path -Parent $PSScriptRoot
$privateDir = Join-Path $env:LOCALAPPDATA 'X14-Plus-Project-Bridge'
$configFile = Join-Path $privateDir 'config.json'
$tunnelExe = Join-Path $projectDir 'bin\tunnel-client\tunnel-client.exe'
$runtimeFile = Join-Path $privateDir 'runtime.json'
$tunnelInfoFile = Join-Path $privateDir 'tunnel.json'
$profileDir = Join-Path $privateDir 'profiles'
$nodeExe = (Get-Command node.exe).Source
if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Output 'First-time setup: creating your local Bridge configuration...'
    $previousConfigOverride = $env:X14_BRIDGE_CONFIG
    try {
        $env:X14_BRIDGE_CONFIG = $configFile
        & $nodeExe (Join-Path $PSScriptRoot 'setup.mjs')
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $configFile)) {
            throw 'Local setup failed. Keep this window open and share the error text (not API keys).'
        }
    } finally {
        if ($null -eq $previousConfigOverride) {
            Remove-Item Env:X14_BRIDGE_CONFIG -ErrorAction SilentlyContinue
        } else {
            $env:X14_BRIDGE_CONFIG = $previousConfigOverride
        }
    }
}
$cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json

function Get-OwnedProcess($record) {
    if ($null -eq $record) { return $null }
    $proc = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($null -ne $proc -and $proc.StartTime.ToUniversalTime().ToString('o') -eq $record.started) {
        return $proc
    }
    return $null
}
function Read-Runtime {
    if (Test-Path -LiteralPath $runtimeFile) { return Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json }
    return [pscustomobject]@{ bridge = $null; tunnel = $null; proxy = $null }
}
function Process-Record($proc) {
    return @{ pid = $proc.Id; started = $proc.StartTime.ToUniversalTime().ToString('o') }
}
function Save-Runtime($value) { $value | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $runtimeFile -Encoding UTF8 }
function Test-LocalBridge {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.port)/healthz" -Headers @{ Authorization = "Bearer $($cfg.http_token)" } -TimeoutSec 3
        return $r.ok -and $r.machine_id -eq $cfg.machine_id
    } catch { return $false }
}

switch ($Action) {
    { $_ -in @('Configure','RotateKey') } {
        $rotating = $Action -eq 'RotateKey'
        if ($rotating -and -not (Test-Path -LiteralPath $tunnelInfoFile)) {
            throw 'Complete Configure-ChatGPT first. RotateKey preserves an existing tunnel configuration.'
        }
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $form = New-Object Windows.Forms.Form
        $form.Text = 'X14-Plus - Connect ChatGPT'
        $form.Size = New-Object Drawing.Size(670,350)
        $form.StartPosition = 'CenterScreen'
        $labels = @('Tunnel ID (tunnel_...)', 'Runtime API key (stored encrypted for your Windows account)', 'Outbound proxy (blank = direct connection)')
        $boxes = @()
        for ($i=0; $i -lt 3; $i++) {
            $label = New-Object Windows.Forms.Label
            $label.Text = $labels[$i]; $label.Location = New-Object Drawing.Point(20,(20+$i*70)); $label.Size = New-Object Drawing.Size(620,22)
            $box = New-Object Windows.Forms.TextBox
            $box.Location = New-Object Drawing.Point(20,(44+$i*70)); $box.Size = New-Object Drawing.Size(610,25)
            $form.Controls.Add($label); $form.Controls.Add($box); $boxes += $box
        }
        $boxes[1].UseSystemPasswordChar = $true
        $boxes[2].Text = 'http://127.0.0.1:7897'
        if (Test-Path -LiteralPath $tunnelInfoFile) {
            $existing = Get-Content -LiteralPath $tunnelInfoFile -Raw | ConvertFrom-Json
            $boxes[0].Text = $existing.tunnel_id
            $boxes[2].Text = $existing.proxy
        }
        if ($rotating) {
            $form.Text = 'X14-Plus - Replace runtime API key'
            $boxes[0].ReadOnly = $true
            $boxes[2].ReadOnly = $true
        }
        $button = New-Object Windows.Forms.Button
        $button.Text = 'Save locally'; $button.Location = New-Object Drawing.Point(490,260); $button.Size = New-Object Drawing.Size(140,32)
        $button.Add_Click({
            if ($boxes[0].Text -notmatch '^tunnel_[A-Za-z0-9_-]+$' -or [string]::IsNullOrWhiteSpace($boxes[1].Text)) {
                [Windows.Forms.MessageBox]::Show('Enter the Tunnel ID and runtime API key.'); return
            }
            $form.DialogResult = [Windows.Forms.DialogResult]::OK
            $form.Close()
        })
        $form.Controls.Add($button)
        if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
        $secure = ConvertTo-SecureString -String $boxes[1].Text -AsPlainText -Force
        $keyFile = Join-Path $privateDir 'runtime-key.dpapi'
        $tempKey = Join-Path $privateDir ('key-' + [guid]::NewGuid().ToString() + '.tmp')
        try {
            $secure | ConvertFrom-SecureString | Set-Content -LiteralPath $tempKey -Encoding ASCII
            if (Test-Path -LiteralPath $keyFile) {
                [IO.File]::Replace($tempKey, $keyFile, (Join-Path $privateDir 'runtime-key.previous.dpapi'))
            } else {
                [IO.File]::Move($tempKey, $keyFile)
            }
        } finally {
            if (Test-Path -LiteralPath $tempKey) { Remove-Item -LiteralPath $tempKey }
            $boxes[1].Clear()
        }
        if ($rotating) {
            $runtime = Read-Runtime
            $proc = Get-OwnedProcess $runtime.tunnel
            if ($null -ne $proc) {
                & taskkill.exe /PID $proc.Id /T /F | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Key saved, but the old tunnel process could not be stopped. Check status before continuing.' }
            }
            $runtime.tunnel = $null
            Save-Runtime $runtime
            & $PSCommandPath -Action Start
            Write-Output 'New key saved; tunnel restart requested. Run Check-Tunnel and test ChatGPT before revoking the old key. Readiness is not yet verified.'
            return
        }
        @{ tunnel_id = $boxes[0].Text.Trim(); proxy = $boxes[2].Text.Trim() } | ConvertTo-Json | Set-Content -LiteralPath $tunnelInfoFile -Encoding UTF8
        New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
        & $tunnelExe init --sample sample_mcp_remote_no_auth --profile x14-plus --profile-dir $profileDir --tunnel-id $boxes[0].Text.Trim() --mcp-server-url "http://127.0.0.1:$($cfg.port)/mcp" --health-listen-addr '127.0.0.1:18742' --force
        if ($LASTEXITCODE -ne 0) { throw 'Tunnel profile creation failed.' }
        $boxes[1].Clear()
        Write-Output 'Saved locally. Next: Start, then Doctor. No key is printed.'
    }
    'Start' {
        $runtime = Read-Runtime
        if (-not (Test-LocalBridge)) {
            if ($null -ne (Get-OwnedProcess $runtime.bridge)) { throw 'Bridge process exists but is unhealthy. Check logs before restarting.' }
            $proc = Start-Process -FilePath $nodeExe -ArgumentList @(('"' + (Join-Path $projectDir 'src\server.mjs') + '"')) -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $privateDir 'bridge.stdout.log') -RedirectStandardError (Join-Path $privateDir 'bridge.stderr.log')
            $runtime.bridge = Process-Record $proc
            Save-Runtime $runtime
            for ($attempt = 0; $attempt -lt 20; $attempt++) {
                if (Test-LocalBridge) { break }
                $proc.Refresh()
                if ($proc.HasExited) { break }
                Start-Sleep -Milliseconds 500
            }
            if (-not (Test-LocalBridge)) { throw 'Bridge did not become healthy. Check bridge.stderr.log.' }
        }
        if (Test-Path -LiteralPath $tunnelInfoFile) {
            if ($null -eq (Get-OwnedProcess $runtime.tunnel)) {
                $script = Join-Path $PSScriptRoot 'Run-Tunnel.ps1'
                $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $script + '"')) -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $privateDir 'tunnel.stdout.log') -RedirectStandardError (Join-Path $privateDir 'tunnel.stderr.log')
                $runtime.tunnel = Process-Record $proc
                Save-Runtime $runtime
            }
            Write-Output 'Local bridge healthy. Tunnel launched; use Status/Doctor to verify cloud readiness.'
        } else {
            Write-Output 'Local bridge healthy. ChatGPT tunnel is not configured yet. Run Configure after obtaining your Tunnel ID and runtime API key.'
        }
    }
    'Stop' {
        $runtime = Read-Runtime
        foreach ($name in @('tunnel','bridge','proxy')) {
            $proc = Get-OwnedProcess $runtime.$name
            if ($null -ne $proc) { & taskkill.exe /PID $proc.Id /T /F | Out-Null }
            $runtime.$name = $null
        }
        Save-Runtime $runtime
        Write-Output 'Bridge-owned connection processes stopped. Existing project jobs retain their own lifecycle.'
    }
    'Status' {
        $taskStatusFile = Join-Path $projectDir 'runtime-status.json'
        if (Test-Path -LiteralPath $taskStatusFile) {
            try {
                $taskStatus = Get-Content -LiteralPath $taskStatusFile -Raw | ConvertFrom-Json
                if (([DateTime]::UtcNow - [DateTime]::Parse($taskStatus.at).ToUniversalTime()).TotalSeconds -lt 15) {
                    Write-Output ('Local bridge healthy: ' + $taskStatus.bridge)
                    Write-Output ('Tunnel ready: ' + $taskStatus.tunnel)
                    Write-Output ('Windows task worker PID: ' + $taskStatus.worker_pid)
                    if ($taskStatus.proxy) {
                        Write-Output ('Remote proxy HTTPS: ' + $taskStatus.proxy.internet)
                        Write-Output ('SSH forwarding owner: ' + $taskStatus.proxy.owner)
                        Write-Output ('Proxy last checked (UTC): ' + $taskStatus.proxy.checked_at)
                        Write-Output $taskStatus.proxy.message
                    }
                    return
                }
            } catch {}
        }
        $runtime = Read-Runtime
        Write-Output ("Local bridge healthy: " + (Test-LocalBridge))
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18742/readyz' -TimeoutSec 3
            Write-Output ("Tunnel readiness HTTP: " + $r.StatusCode)
        } catch { Write-Output 'Tunnel is not ready or not running.' }
        Write-Output ("Bridge-owned SSH proxy running: " + ($null -ne (Get-OwnedProcess $runtime.proxy)))
        Write-Output ("Private configuration: " + $configFile)
        Write-Output 'Tunnel dashboard (when running): http://127.0.0.1:18742/ui'
    }
    'Doctor' {
        if (-not (Test-Path -LiteralPath $tunnelInfoFile)) { throw 'Configure the Tunnel ID and runtime API key first.' }
        $runtime = Read-Runtime
        if ($null -ne (Get-OwnedProcess $runtime.tunnel)) {
            if (-not (Test-LocalBridge)) { throw 'Local Bridge health check failed.' }
            $ready = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18742/readyz' -TimeoutSec 5
            Write-Output ('Running tunnel readiness: HTTP ' + $ready.StatusCode + ' ' + $ready.Content.Trim())
            Write-Output 'Live health checked without starting a second client. Next verify tool discovery from ChatGPT.'
            return
        }
        & (Join-Path $PSScriptRoot 'Run-Tunnel.ps1') -Doctor
    }
    'StartProxy' {
        $runtime = Read-Runtime
        if ($null -ne (Get-OwnedProcess $runtime.proxy)) { Write-Output 'Bridge-owned SSH proxy session already running.'; return }
        # Existing RemoteForward remains in the SSH Host configuration. No new supervisor or port mapping is added.
        $proc = Start-Process -FilePath $cfg.ssh -ArgumentList @('-N','-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=12','volcengine-cszy_1-L20') -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $privateDir 'ssh-proxy.stderr.log')
        Start-Sleep -Seconds 2
        $proc.Refresh()
        if ($proc.HasExited) {
            Write-Output 'SSH forwarding did not start. A pre-existing 19081 listener may own the port. No other process was stopped. See ssh-proxy.stderr.log.'
            return
        }
        $runtime.proxy = Process-Record $proc
        Save-Runtime $runtime
        Write-Output 'Bridge-owned SSH session started using the existing Host RemoteForward. Verify a proxy-enabled job separately.'
    }
    'StartStandalone' {
        & $PSCommandPath -Action Start
        & $PSCommandPath -Action StartProxy
        & $PSCommandPath -Action Status
    }
    'EnableLoginStart' {
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
        $script = Join-Path $PSScriptRoot 'Manage-Bridge.ps1'
        $value = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '" -Action StartStandalone'
        New-ItemProperty -Path $key -Name 'X14PlusProjectBridge' -PropertyType String -Value $value -Force | Out-Null
        Write-Output 'Enabled current-user login startup. Reboot/login behavior still requires verification.'
    }
    'DisableLoginStart' {
        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'X14PlusProjectBridge' -ErrorAction SilentlyContinue
        Write-Output 'Disabled login startup.'
    }
}
