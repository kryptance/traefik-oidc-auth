# Keycloak E2E Tests

This directory contains end-to-end tests for the Traefik OIDC Auth middleware using Keycloak as the identity provider.

## Test Structure

### Basic Tests (`keycloak-login.spec.ts`)
- Authentication flow
- Role-based authorization
- Logout functionality
- Token claims verification

### Advanced Tests (`keycloak-advanced.spec.ts`)
- Department-based access control
- Location-based access control
- Multiple claim requirements (AND conditions)
- Email domain restrictions
- Combined role and attribute authorization (OR conditions)
- Bypass authentication rules
- Concurrent session management

## Test Users

The test realm includes the following users:

| Username | Password | Roles | Department | Location | Email |
|----------|----------|-------|------------|----------|--------|
| admin | admin123 | admin, user | IT | HQ | admin@example.com |
| alice | alice123 | user | Sales | Branch | alice@example.com |
| bob | bob123 | user | Engineering | HQ | bob@example.com |

## Running the Tests

### All Keycloak tests:
```bash
cd e2e
npm test keycloak/
```

### Specific test file:
```bash
npm test keycloak/keycloak-login.spec.ts
npm test keycloak/keycloak-advanced.spec.ts
```

### With UI mode:
```bash
npx playwright test keycloak/ --ui
```

## Docker Services

The tests spin up the following services:
- **Keycloak**: Identity provider on port 8000
- **Traefik**: Reverse proxy on port 9080
- **Whoami**: Test backend service

## Authorization Examples

### 1. Role-based Authorization
```yaml
Authorization:
  AssertClaims:
    - Name: realm_access.roles
      AnyOf: ["admin"]
```

### 2. Attribute-based Authorization
```yaml
Authorization:
  AssertClaims:
    - Name: department
      AnyOf: ["IT", "Engineering"]
```

### 3. Multiple Claims (AND)
```yaml
Authorization:
  AssertClaims:
    - Name: department
      AnyOf: ["IT"]
    - Name: location
      AnyOf: ["HQ"]
```

### 4. Email Domain Restriction
```yaml
Authorization:
  AssertClaims:
    - Name: email
      AnyOf: ["*@example.com"]
```

## Important Notes

### Plugin Limitations
Due to Traefik plugin runtime restrictions (Yaegi interpreter), some features may not work when running as a plugin:
- Complex nested claim paths (e.g., `realm_access.roles`)
- External dependencies that use CGO or unsafe packages

For full functionality, consider running the middleware as a standalone service.

### Manual Testing
You can manually test the Keycloak integration:

```bash
# Start the test environment
cd e2e/tests/keycloak
./test-keycloak.sh

# Access the protected resource
open http://localhost:9080

# Login with test users
# admin/admin123, alice/alice123, or bob/bob123

# Stop the environment
docker-compose down
```

## Troubleshooting

### Keycloak not starting
- Check if port 8000 is already in use
- Increase the wait time in `beforeAll` if Keycloak needs more time to start
- Keycloak requires more memory than other services; ensure Docker has sufficient resources

### Authentication failures
- Verify the realm import was successful
- Check Keycloak logs: `docker logs keycloak-container-name`
- Ensure the client secret matches between Keycloak and Traefik configuration

### Test timeouts
- Increase Playwright timeouts for slower environments
- Check network connectivity between containers
- Keycloak can take 15-30 seconds to fully start

### Realm Access Roles
If `realm_access.roles` claim assertion doesn't work in plugin mode, use alternative approaches:
- Map roles to a flat claim in Keycloak
- Use group membership instead of roles
- Run the middleware as a standalone service