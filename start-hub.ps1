$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$serviceDir = Join-Path $root '.pi\service'
$hubDir = Join-Path $root '.pi\hub'
$processFile = Join-Path $serviceDir 'hub-processes.json'
New-Item -ItemType Directory -Force $serviceDir, $hubDir | Out-Null

if (Test-Path -LiteralPath $processFile) {
  $saved = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
  if ($saved.hub) {
    $running = Get-Process -Id $saved.hub.pid -ErrorAction SilentlyContinue
    if ($running -and $running.StartTime.ToUniversalTime().Ticks -eq ([datetime]$saved.hub.startedAt).ToUniversalTime().Ticks) {
      Write-Output "Hub is already running (PID $($running.Id))"
      exit 0
    }
  }
}

$node = (Get-Command node -ErrorAction Stop).Source
$process = Start-Process $node `
  -ArgumentList @((Join-Path $root 'hub\hub-server.mjs'), '--host', '0.0.0.0', '--port', '8790') `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $serviceDir 'hub.stdout.log') `
  -RedirectStandardError (Join-Path $serviceDir 'hub.stderr.log') `
  -PassThru

@{
  hub = @{
    pid = $process.Id
    startedAt = $process.StartTime.ToUniversalTime().ToString('o')
  }
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $processFile

$ip = ipconfig |
  Select-String 'IPv4.*?:\s*([0-9.]+)' |
  ForEach-Object { $_.Matches[0].Groups[1].Value } |
  Where-Object { $_ -notlike '127.*' -and $_ -notlike '198.18.*' } |
  Select-Object -First 1

Write-Output 'Hub backend: http://127.0.0.1:8790'
if ($ip) { Write-Output "LAN API: http://${ip}:8790" }
Write-Output 'Join link: .\new-hub-join-link.ps1'
Write-Output "Token: $hubDir\token"
