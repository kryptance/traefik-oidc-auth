#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Testing XHR Request Handling${NC}\n"

# Test 1: XHR request without session
echo "1. Testing XHR request without session (should return 401 JSON)..."
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" -H "X-Requested-With: XMLHttpRequest" http://localhost:9080)
http_code=$(echo "$response" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE:/d')

if [ "$http_code" = "401" ] && echo "$body" | grep -q "Unauthorized"; then
    echo -e "${GREEN}✓ XHR request returned 401 JSON response${NC}"
    echo "Response: $body"
else
    echo -e "${RED}✗ Expected 401 JSON response, got HTTP $http_code${NC}"
    echo "Response: $body"
fi

echo ""

# Test 2: Regular browser request without session
echo "2. Testing regular browser request without session (should redirect)..."
response=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" http://localhost:9080)
http_code=$(echo "$response" | cut -d' ' -f1)
redirect_url=$(echo "$response" | cut -d' ' -f2)

if [ "$http_code" = "302" ] && echo "$redirect_url" | grep -q "8000"; then
    echo -e "${GREEN}✓ Browser request redirected to Keycloak${NC}"
    echo "Redirect URL: $redirect_url"
else
    echo -e "${RED}✗ Expected redirect to Keycloak, got HTTP $http_code${NC}"
fi

echo ""

# Test 3: JSON Accept header
echo "3. Testing request with Accept: application/json (should return 401 JSON)..."
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" -H "Accept: application/json" http://localhost:9080)
http_code=$(echo "$response" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE:/d')

if [ "$http_code" = "401" ] && echo "$body" | grep -q "title"; then
    echo -e "${GREEN}✓ JSON Accept header returned 401 JSON response${NC}"
    echo "Response: $body"
else
    echo -e "${RED}✗ Expected 401 JSON response, got HTTP $http_code${NC}"
    echo "Response: $body"
fi

echo ""

# Test 4: Mixed Accept header (JSON + HTML)
echo "4. Testing request with mixed Accept header (should redirect)..."
response=$(curl -s -o /dev/null -w "%{http_code}" -H "Accept: application/json, text/html" http://localhost:9080)

if [ "$response" = "302" ]; then
    echo -e "${GREEN}✓ Mixed Accept header correctly redirected${NC}"
else
    echo -e "${RED}✗ Expected redirect, got HTTP $response${NC}"
fi

echo -e "\n${GREEN}XHR testing completed!${NC}"
echo ""
echo "To run full Playwright tests:"
echo "cd ../../ && npm test keycloak-xhr.spec.ts"