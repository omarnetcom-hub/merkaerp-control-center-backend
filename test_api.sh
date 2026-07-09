#!/bin/bash
# Quick Test Script for Odoo API Endpoints
# Usage: bash test_api.sh

BASE_URL="http://localhost:8787"
TOKEN="Bearer your_jwt_token_here"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}    Odoo 19.0 API Test Suite for Caja Simple${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}\n"

# Test 1: Health Check
echo -e "${YELLOW}[TEST 1] Health Check${NC}"
curl -s "$BASE_URL/health" | jq .
echo -e "\n"

# Test 2: API Docs
echo -e "${YELLOW}[TEST 2] API Documentation${NC}"
curl -s "$BASE_URL/api/docs" | jq .
echo -e "\n"

# Test 3: Create Company
echo -e "${YELLOW}[TEST 3] Create Company${NC}"
COMPANY=$(curl -s -X POST "$BASE_URL/api/companies" \
  -H "Content-Type: application/json" \
  -H "Authorization: $TOKEN" \
  -d '{
    "name": "Test Company",
    "email": "info@testcompany.com",
    "phone": "+1234567890",
    "city": "New York",
    "state": "NY",
    "country_id": 1,
    "currency_id": 1
  }')
echo "$COMPANY" | jq .
COMPANY_ID=$(echo "$COMPANY" | jq -r '.id // empty')
echo -e "\n"

# Test 4: Create User
echo -e "${YELLOW}[TEST 4] Create User${NC}"
USER=$(curl -s -X POST "$BASE_URL/api/users" \
  -H "Content-Type: application/json" \
  -H "Authorization: $TOKEN" \
  -d '{
    "name": "Test User",
    "email": "testuser@example.com",
    "login": "testuser",
    "password": "TestPassword123!",
    "company_id": '"${COMPANY_ID:-1}"'
  }')
echo "$USER" | jq .
USER_ID=$(echo "$USER" | jq -r '.id // empty')
echo -e "\n"

# Test 5: Create Partner
echo -e "${YELLOW}[TEST 5] Create Partner (Customer)${NC}"
PARTNER=$(curl -s -X POST "$BASE_URL/api/partners" \
  -H "Content-Type: application/json" \
  -H "Authorization: $TOKEN" \
  -d '{
    "name": "Customer Test",
    "email": "customer@example.com",
    "phone": "+1111111111",
    "city": "Boston",
    "partner_type": "customer",
    "country_id": 1
  }')
echo "$PARTNER" | jq .
PARTNER_ID=$(echo "$PARTNER" | jq -r '.id // empty')
echo -e "\n"

# Test 6: Create Product
echo -e "${YELLOW}[TEST 6] Create Product${NC}"
PRODUCT=$(curl -s -X POST "$BASE_URL/api/products" \
  -H "Content-Type: application/json" \
  -H "Authorization: $TOKEN" \
  -d '{
    "name": "Test Product",
    "code": "TEST001",
    "type": "product",
    "price": 99.99,
    "cost": 50.00,
    "description": "A test product for API demonstration"
  }')
echo "$PRODUCT" | jq .
PRODUCT_ID=$(echo "$PRODUCT" | jq -r '.id // empty')
echo -e "\n"

# Test 7: Create Sale Order
echo -e "${YELLOW}[TEST 7] Create Sale Order${NC}"
ORDER=$(curl -s -X POST "$BASE_URL/api/sale-orders" \
  -H "Content-Type: application/json" \
  -H "Authorization: $TOKEN" \
  -d '{
    "partner_id": '"${PARTNER_ID:-1}"',
    "company_id": '"${COMPANY_ID:-1}"',
    "order_date": "'"$(date +%Y-%m-%d)"'",
    "currency_id": 1,
    "user_id": '"${USER_ID:-1}"'
  }')
echo "$ORDER" | jq .
ORDER_ID=$(echo "$ORDER" | jq -r '.id // empty')
echo -e "\n"

# Test 8: Add Line to Sale Order
if [ ! -z "$ORDER_ID" ] && [ ! -z "$PRODUCT_ID" ]; then
  echo -e "${YELLOW}[TEST 8] Add Line to Sale Order${NC}"
  curl -s -X POST "$BASE_URL/api/sale-orders/$ORDER_ID/lines" \
    -H "Content-Type: application/json" \
    -H "Authorization: $TOKEN" \
    -d '{
      "product_id": '"$PRODUCT_ID"',
      "quantity": 5,
      "price_unit": 99.99
    }' | jq .
  echo -e "\n"
fi

# Test 9: Get Sale Order with Lines
if [ ! -z "$ORDER_ID" ]; then
  echo -e "${YELLOW}[TEST 9] Get Sale Order with Lines${NC}"
  curl -s "$BASE_URL/api/sale-orders/$ORDER_ID" \
    -H "Authorization: $TOKEN" | jq .
  curl -s "$BASE_URL/api/sale-orders/$ORDER_ID/lines" \
    -H "Authorization: $TOKEN" | jq .
  echo -e "\n"
fi

# Test 10: Create Invoice
echo -e "${YELLOW}[TEST 10] Create Invoice${NC}"
INVOICE=$(curl -s -X POST "$BASE_URL/api/invoices" \
  -H "Content-Type: application/json" \
  -H "Authorization: $TOKEN" \
  -d '{
    "partner_id": '"${PARTNER_ID:-1}"',
    "company_id": '"${COMPANY_ID:-1}"',
    "invoice_date": "'"$(date +%Y-%m-%d)"'",
    "invoice_type": "out_invoice",
    "currency_id": 1,
    "reference": "INV-2024-001"
  }')
echo "$INVOICE" | jq .
INVOICE_ID=$(echo "$INVOICE" | jq -r '.id // empty')
echo -e "\n"

# Test 11: Add Line to Invoice
if [ ! -z "$INVOICE_ID" ] && [ ! -z "$PRODUCT_ID" ]; then
  echo -e "${YELLOW}[TEST 11] Add Line to Invoice${NC}"
  curl -s -X POST "$BASE_URL/api/invoices/$INVOICE_ID/lines" \
    -H "Content-Type: application/json" \
    -H "Authorization: $TOKEN" \
    -d '{
      "product_id": '"$PRODUCT_ID"',
      "account_id": 1,
      "quantity": 3,
      "price_unit": 99.99
    }' | jq .
  echo -e "\n"
fi

# Test 12: List Companies
echo -e "${YELLOW}[TEST 12] List Companies${NC}"
curl -s "$BASE_URL/api/companies" \
  -H "Authorization: $TOKEN" | jq .
echo -e "\n"

# Test 13: Search Products
echo -e "${YELLOW}[TEST 13] Search Products${NC}"
curl -s "$BASE_URL/api/products/search/test" \
  -H "Authorization: $TOKEN" | jq .
echo -e "\n"

# Test 14: Get Customers
echo -e "${YELLOW}[TEST 14] Get Customers${NC}"
curl -s "$BASE_URL/api/partners/type/customers" \
  -H "Authorization: $TOKEN" | jq .
echo -e "\n"

echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}    ✓ Tests completed!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}\n"

echo -e "${BLUE}Summary:${NC}"
echo "Company ID:   $COMPANY_ID"
echo "User ID:      $USER_ID"
echo "Partner ID:   $PARTNER_ID"
echo "Product ID:   $PRODUCT_ID"
echo "Order ID:     $ORDER_ID"
echo "Invoice ID:   $INVOICE_ID"
echo -e "\n${YELLOW}Note: Replace 'your_jwt_token_here' with a valid JWT token${NC}"
