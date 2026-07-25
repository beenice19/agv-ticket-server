$ErrorActionPreference = "Stop"

Set-Location "C:\Users\bee19\Documents\stro-chievery-server"

Write-Host "=== AGV UNIVERSITY PAL AI PROVIDER ===" -ForegroundColor Cyan

if (-not $env:AGV_UP_AI_API_KEY) {
  Write-Host ""
  Write-Host "AGV_UP_AI_API_KEY is not set in this PowerShell session." -ForegroundColor Yellow
  Write-Host "The server will start in unconfigured mode so /health can be tested."
  Write-Host "Do not place API keys in client files or commit them to Git."
  Write-Host ""
}

node ".\agv-university-pal-ai-provider-server.cjs"