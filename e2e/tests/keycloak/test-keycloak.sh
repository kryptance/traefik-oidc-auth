#!/bin/bash
set -e

echo "Starting Keycloak integration test..."

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Create test configuration
cat > ../../.http.yml << EOF
http:
  services:
    whoami:
      loadBalancer:
        servers:
          - url: http://whoami:80

  middlewares:
    oidc-auth:
      plugin:
        traefik-oidc-auth:
          LogLevel: DEBUG
          Provider:
            Url: "\${PROVIDER_URL}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
          Scopes:
            - openid
            - profile
            - email

  routers:
    whoami:
      entryPoints: ["web"]
      rule: PathPrefix("/")
      service: whoami
      middlewares: ["oidc-auth@file"]
EOF

# Start services
echo "Starting services..."
docker-compose up -d

# Wait for Keycloak to be ready
echo "Waiting for Keycloak to be ready..."
for i in {1..30}; do
  if curl -s http://localhost:8000/health/ready | grep -q "UP"; then
    echo -e "${GREEN}✓ Keycloak is ready${NC}"
    break
  fi
  echo -n "."
  sleep 2
done

# Wait a bit more for realm import
sleep 5

# Check if Traefik is running
echo "Checking Traefik..."
if curl -s http://localhost:9080 > /dev/null; then
    echo -e "${GREEN}✓ Traefik is running${NC}"
else
    echo -e "${RED}✗ Traefik is not running${NC}"
    docker-compose logs traefik
    exit 1
fi

# Test authentication redirect
echo "Testing authentication redirect..."
response=$(curl -s -o /dev/null -w "%{http_code}" -L http://localhost:9080)
if [ "$response" = "200" ]; then
    echo -e "${RED}✗ Expected redirect to Keycloak but got HTTP 200${NC}"
else
    echo -e "${GREEN}✓ Authentication redirect working${NC}"
fi

# Check Keycloak realm
echo "Checking Keycloak test realm..."
if curl -s http://localhost:8000/realms/test | grep -q "test"; then
    echo -e "${GREEN}✓ Test realm is available${NC}"
else
    echo -e "${RED}✗ Test realm not found${NC}"
fi

# Test OIDC discovery
echo "Testing OIDC discovery endpoint..."
if curl -s http://localhost:8000/realms/test/.well-known/openid-configuration | grep -q "authorization_endpoint"; then
    echo -e "${GREEN}✓ OIDC discovery working${NC}"
else
    echo -e "${RED}✗ OIDC discovery failed${NC}"
fi

echo -e "\n${GREEN}Keycloak integration test completed!${NC}"
echo "You can now:"
echo "1. Access http://localhost:9080 to test authentication"
echo "2. Login with: admin/admin123, alice/alice123, or bob/bob123"
echo "3. Check Keycloak admin at http://localhost:8000 (admin/admin)"
echo ""
echo "To stop services: docker-compose down"
