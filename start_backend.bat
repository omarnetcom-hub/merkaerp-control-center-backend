@echo off
setlocal
cd /d %~dp0

if "%DATABASE_URL%"=="" (
  echo ERROR: DATABASE_URL no esta configurada.
  exit /b 1
)
if "%ADMIN_JWT_SECRET%"=="" (
  echo ERROR: ADMIN_JWT_SECRET no esta configurada.
  exit /b 1
)
if "%DB_CREDENTIAL_SECRET%"=="" (
  echo ERROR: DB_CREDENTIAL_SECRET no esta configurada.
  exit /b 1
)

node scripts\check-publisher-key.js
if errorlevel 1 (
  echo ERROR: La autoridad RS256 configurada no coincide con MerkaERP 1.2.1+5.
  exit /b 1
)

node src\server.js
