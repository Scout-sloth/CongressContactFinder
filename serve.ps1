# Tiny static server for CongressContactFinder (default http://127.0.0.1:8765/)
param(
  [int]$Port = 8765
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "Serving $root at http://127.0.0.1:$Port/"
Write-Host "Open http://127.0.0.1:$Port/dummy.html"
Write-Host "Or try the embed host: http://127.0.0.1:$Port/embed.html?name=Bernie%20Sanders"
Write-Host "Ctrl+C to stop."

python -m http.server $Port --bind 127.0.0.1
