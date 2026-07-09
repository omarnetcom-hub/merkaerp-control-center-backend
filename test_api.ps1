# Quick Test Script for Odoo API Endpoints (Windows PowerShell)
# Usage: powershell -ExecutionPolicy Bypass -File test_api.ps1

$BaseUrl = "http://localhost:8787"
$Token = "Bearer your_jwt_token_here"

Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Blue
Write-Host "    Odoo 19.0 API Test Suite for Caja Simple" -ForegroundColor Blue
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Blue
Write-Host ""

# Test 1: Health Check
Write-Host "[TEST 1] Health Check" -ForegroundColor Yellow
try {
  $response = Invoke-WebRequest -Uri "$BaseUrl/health" -Method Get
  $response.Content | ConvertFrom-Json | ConvertTo-Json
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
}
Write-Host ""

# Test 2: API Docs
Write-Host "[TEST 2] API Documentation" -ForegroundColor Yellow
try {
  $response = Invoke-WebRequest -Uri "$BaseUrl/api/docs" -Method Get
  $response.Content | ConvertFrom-Json | ConvertTo-Json
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
}
Write-Host ""

# Test 3: Create Company
Write-Host "[TEST 3] Create Company" -ForegroundColor Yellow
try {
  $body = @{
    name = "Test Company"
    email = "info@testcompany.com"
    phone = "+1234567890"
    city = "New York"
    state = "NY"
    country_id = 1
    currency_id = 1
  } | ConvertTo-Json

  $response = Invoke-WebRequest -Uri "$BaseUrl/api/companies" `
    -Method Post `
    -Headers @{"Authorization" = $Token; "Content-Type" = "application/json"} `
    -Body $body
  
  $company = $response.Content | ConvertFrom-Json
  $company | ConvertTo-Json
  $global:CompanyId = $company.id
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
}
Write-Host ""

# Test 4: Create User
Write-Host "[TEST 4] Create User" -ForegroundColor Yellow
try {
  $body = @{
    name = "Test User"
    email = "testuser@example.com"
    login = "testuser"
    password = "TestPassword123!"
    company_id = $global:CompanyId ?? 1
  } | ConvertTo-Json

  $response = Invoke-WebRequest -Uri "$BaseUrl/api/users" `
    -Method Post `
    -Headers @{"Authorization" = $Token; "Content-Type" = "application/json"} `
    -Body $body
  
  $user = $response.Content | ConvertFrom-Json
  $user | ConvertTo-Json
  $global:UserId = $user.id
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
}
Write-Host ""

# Test 5: Create Partner
Write-Host "[TEST 5] Create Partner (Customer)" -ForegroundColor Yellow
try {
  $body = @{
    name = "Customer Test"
    email = "customer@example.com"
    phone = "+1111111111"
    city = "Boston"
    partner_type = "customer"
    country_id = 1
  } | ConvertTo-Json

  $response = Invoke-WebRequest -Uri "$BaseUrl/api/partners" `
    -Method Post `
    -Headers @{"Authorization" = $Token; "Content-Type" = "application/json"} `
    -Body $body
  
  $partner = $response.Content | ConvertFrom-Json
  $partner | ConvertTo-Json
  $global:PartnerId = $partner.id
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
}
Write-Host ""

# Test 6: Create Product
Write-Host "[TEST 6] Create Product" -ForegroundColor Yellow
try {
  $body = @{
    name = "Test Product"
    code = "TEST001"
    type = "product"
    price = 99.99
    cost = 50.00
    description = "A test product for API demonstration"
  } | ConvertTo-Json

  $response = Invoke-WebRequest -Uri "$BaseUrl/api/products" `
    -Method Post `
    -Headers @{"Authorization" = $Token; "Content-Type" = "application/json"} `
    -Body $body
  
  $product = $response.Content | ConvertFrom-Json
  $product | ConvertTo-Json
  $global:ProductId = $product.id
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
}
Write-Host ""

# Test 7: Create Sale Order
Write-Host "[TEST 7] Create Sale Order" -ForegroundColor Yellow
try {
  $body = @{
    partner_id = $global:PartnerId ?? 1
    company_id = $global:CompanyId ?? 1
    order_date = (Get-Date -Format "yyyy-MM-dd")
    currency_id = 1
    user_id = $global:UserId ?? 1
  } | ConvertTo-Json

  $response = Invoke-WebRequest -Uri "$BaseUrl/api/sale-orders" `
    -Method Post `
    -Headers @{"Authorization" = $Token; "Content-Type" = "application/json"} `
    -Body $body
  
  $order = $response.Content | ConvertFrom-Json
  $order | ConvertTo-Json
  $global:OrderId = $order.id
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
}
Write-Host ""

# Test 8: Add Line to Sale Order
if ($global:OrderId -and $global:ProductId) {
  Write-Host "[TEST 8] Add Line to Sale Order" -ForegroundColor Yellow
  try {
    $body = @{
      product_id = $global:ProductId
      quantity = 5
      price_unit = 99.99
    } | ConvertTo-Json

    $response = Invoke-WebRequest -Uri "$BaseUrl/api/sale-orders/$($global:OrderId)/lines" `
      -Method Post `
      -Headers @{"Authorization" = $Token; "Content-Type" = "application/json"} `
      -Body $body
    
    $response.Content | ConvertFrom-Json | ConvertTo-Json
  } catch {
    Write-Host "Error: $_" -ForegroundColor Red
  }
  Write-Host ""
}

# Test 9: Get Sale Order
if ($global:OrderId) {
  Write-Host "[TEST 9] Get Sale Order" -ForegroundColor Yellow
  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/sale-orders/$($global:OrderId)" `
      -Method Get `
      -Headers @{"Authorization" = $Token}
    $response.Content | ConvertFrom-Json | ConvertTo-Json
  } catch {
    Write-Host "Error: $_" -ForegroundColor Red
  }
  Write-Host ""
}

# Test 10: List Companies
Write-Host "[TEST 10] List Companies" -ForegroundColor Yellow
try {
  $response = Invoke-WebRequest -Uri "$BaseUrl/api/companies" `
    -Method Get `
    -Headers @{"Authorization" = $Token}
  $response.Content | ConvertFrom-Json | ConvertTo-Json
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
}
Write-Host ""

Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "    ✓ Tests completed!" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""

Write-Host "Summary:" -ForegroundColor Blue
Write-Host "Company ID:   $($global:CompanyId)"
Write-Host "User ID:      $($global:UserId)"
Write-Host "Partner ID:   $($global:PartnerId)"
Write-Host "Product ID:   $($global:ProductId)"
Write-Host "Order ID:     $($global:OrderId)"
Write-Host ""
Write-Host "Note: Replace 'your_jwt_token_here' with a valid JWT token" -ForegroundColor Yellow
