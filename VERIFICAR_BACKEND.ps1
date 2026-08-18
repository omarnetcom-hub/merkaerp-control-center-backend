$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js no está disponible en PATH." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm no está disponible en PATH." }
if (-not (Test-Path node_modules)) { npm ci }
npm run check
Write-Host "Backend: sintaxis y pruebas de seguridad OK." -ForegroundColor Green
