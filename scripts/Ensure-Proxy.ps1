param()
$ErrorActionPreference = 'Stop'
$privateDir = Join-Path $env:LOCALAPPDATA 'X14-Plus-Project-Bridge'
$cfg = Get-Content (Join-Path $privateDir 'config.json') -Raw | ConvertFrom-Json
$runtimeFile = Join-Path $privateDir 'runtime.json'
$result = [ordered]@{ checked_at=[DateTime]::UtcNow.ToString('o'); local_proxy=$false; remote_listener=$false; internet=$false; owner='none'; message='' }
function Probe-Remote {
    # A separate inspection connection must never allocate the configured RemoteForward.
    $code = @'
import socket,urllib.request
s=socket.socket(); s.settimeout(3)
listening=s.connect_ex(("127.0.0.1",19081))==0; s.close()
print("LISTENER="+str(int(listening)),flush=True)
if listening:
 try:
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({"https":"http://127.0.0.1:19081"}))
  r=opener.open("https://www.python.org",timeout=12)
  print("HTTP="+str(r.status))
 except Exception as e: print("PROXY_ERROR="+str(e))
'@
    $lines = $code | & $cfg.ssh -T -o ClearAllForwardings=yes -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 volcengine-cszy_1-L20 'python3 -' 2>(Join-Path $privateDir 'proxy-check.stderr.log')
    return @{ listener=($lines -contains 'LISTENER=1'); internet=($LASTEXITCODE -eq 0 -and $lines -contains 'HTTP=200') }
}
try {
    $tcp = New-Object Net.Sockets.TcpClient
    try {
        $pending = $tcp.ConnectAsync('127.0.0.1',7897)
        if ($pending.Wait(2000)) { $result.local_proxy = $tcp.Connected }
    } finally { $tcp.Dispose() }
    if (-not $result.local_proxy) { throw 'Local Clash proxy 127.0.0.1:7897 is unavailable. Start Clash first.' }
    $runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
    $owned = $null
    if ($runtime.proxy) {
        $candidate = Get-Process -Id $runtime.proxy.pid -ErrorAction SilentlyContinue
        if ($candidate -and $candidate.StartTime.ToUniversalTime().ToString('o') -eq $runtime.proxy.started) { $owned = $candidate }
    }
    $probe = Probe-Remote
    if (-not $probe.listener -and -not $owned) {
        # Reuse the user's existing Host configuration; do not change ports or other SSH sessions.
        $owned = Start-Process -FilePath $cfg.ssh -ArgumentList @('-N','-T','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','volcengine-cszy_1-L20') -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $privateDir 'ssh-proxy.stderr.log')
        $record = @{pid=$owned.Id; started=$owned.StartTime.ToUniversalTime().ToString('o')}
        Start-Sleep -Seconds 2
        $owned.Refresh()
        if ($owned.HasExited) { $owned = $null } else {
            # Reload so another manager action's changes are not overwritten by the probe snapshot.
            $runtime = Get-Content $runtimeFile -Raw | ConvertFrom-Json
            $runtime.proxy = $record
            $runtime | ConvertTo-Json -Depth 5 | Set-Content $runtimeFile -Encoding UTF8
        }
        $probe = Probe-Remote
    }
    $result.remote_listener = $probe.listener
    $result.internet = $probe.internet
    if ($owned) { $result.owner = 'bridge' } elseif ($probe.listener) { $result.owner = 'external' }
    if ($probe.internet) {
        $result.message = 'Remote proxy HTTPS verified: HTTP 200.'
    } elseif ($probe.listener) {
        $result.message = 'Remote port exists but proxy HTTPS failed; existing connections were preserved. See proxy-check.stderr.log.'
    } else { $result.message = 'Remote forwarding unavailable. See ssh-proxy.stderr.log and proxy-check.stderr.log.' }
} catch { $result.message = $_.Exception.Message }
[pscustomobject]$result
