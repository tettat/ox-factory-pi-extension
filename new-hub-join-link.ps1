$ErrorActionPreference = 'Stop'
$token = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '.pi\hub\token') -Raw).Trim()
$ip = ipconfig | Select-String 'IPv4.*?:\s*([0-9.]+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Where-Object { $_ -notlike '127.*' -and $_ -notlike '198.18.*' } | Select-Object -First 1
if (-not $ip) { throw '未找到局域网 IPv4 地址' }
$config = @{ url = "http://${ip}:8790"; token = $token } | ConvertTo-Json -Compress
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config)).TrimEnd('=').Replace('+','-').Replace('/','_')
Write-Output "http://127.0.0.1:8787/?hubJoin=$encoded"
