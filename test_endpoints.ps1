$ErrorActionPreference = 'Stop'
$base = if ($env:MERKA_CC_BASE_URL) { $env:MERKA_CC_BASE_URL.TrimEnd('/') } else { 'http://localhost:8787' }
if (-not $env:MERKA_CC_ADMIN_USER -or -not $env:MERKA_CC_ADMIN_PASSWORD) {
  throw 'Configure MERKA_CC_ADMIN_USER and MERKA_CC_ADMIN_PASSWORD before running this smoke test.'
}

Write-Host 'Health check...'
Invoke-RestMethod -Uri "$base/health" | ConvertTo-Json -Depth 4

Write-Host 'Admin login...'
$loginBody = @{ username=$env:MERKA_CC_ADMIN_USER; password=$env:MERKA_CC_ADMIN_PASSWORD }
if ($env:MERKA_CC_ADMIN_OTP) { $loginBody.otp = $env:MERKA_CC_ADMIN_OTP }
$login = Invoke-RestMethod -Uri "$base/api/v1/auth/login" -Method Post -Body ($loginBody | ConvertTo-Json) -ContentType 'application/json'
if ($login.requires_2fa) { throw 'This account requires MERKA_CC_ADMIN_OTP.' }
$headers = @{ Authorization = "Bearer $($login.token)" }

Write-Host 'Authenticated profile...'
Invoke-RestMethod -Uri "$base/api/v1/auth/me" -Headers $headers | ConvertTo-Json -Depth 4

Write-Host 'System statistics...'
Invoke-RestMethod -Uri "$base/api/v1/admin/stats" -Headers $headers | ConvertTo-Json -Depth 4

Write-Host 'Smoke test OK.'
