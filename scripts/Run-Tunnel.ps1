param([switch]$Doctor)
$ErrorActionPreference = 'Stop'
# Load modules matching this Windows PowerShell runtime, not inherited PS7 modules.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$privateDir = Join-Path $env:LOCALAPPDATA 'X14-Plus-Project-Bridge'
$projectDir = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content -LiteralPath (Join-Path $privateDir 'config.json') -Raw | ConvertFrom-Json
$info = Get-Content -LiteralPath (Join-Path $privateDir 'tunnel.json') -Raw | ConvertFrom-Json
$encryptedKey = (Get-Content -LiteralPath (Join-Path $privateDir 'runtime-key.dpapi') -Raw).Trim()
$secure = ConvertTo-SecureString -String $encryptedKey
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $env:X14_BRIDGE_AUTH = 'Bearer ' + $cfg.http_token
    $argsList = @('--profile','x14-plus','--profile-dir',(Join-Path $privateDir 'profiles'), '--mcp.extra-headers','Authorization: env:X14_BRIDGE_AUTH','--mcp.discovery-extra-headers','Authorization: env:X14_BRIDGE_AUTH')
    if ($info.proxy) { $argsList += @('--control-plane.http-proxy', $info.proxy) }
    $exe = Join-Path $projectDir 'bin\tunnel-client\tunnel-client.exe'
    if ($Doctor) { & $exe doctor @argsList --explain } else { & $exe run @argsList }
    if ($LASTEXITCODE -ne 0) { throw "Tunnel client exited with code $LASTEXITCODE" }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:X14_BRIDGE_AUTH -ErrorAction SilentlyContinue
}
