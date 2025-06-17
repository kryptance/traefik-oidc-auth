# OpenTelemetry Tracing E2E Tests

This directory contains end-to-end tests for the OpenTelemetry tracing functionality of the traefik-oidc-auth middleware.

## Overview

The tests verify that:
- Traces are properly generated for all OIDC operations
- Trace context is propagated to IDP requests
- Span attributes contain the expected information
- Error conditions are properly recorded
- Auto-enable mode works correctly
- Performance overhead is minimal

## Test Architecture

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  Playwright │────▶│   Traefik   │────▶│   Keycloak   │
│    Tests    │     │  + OIDC MW  │     │     IDP      │
└─────────────┘     └──────┬──────┘     └──────────────┘
                           │
                           │ OTLP/HTTP
                           ▼
                    ┌──────────────┐
                    │ OTLP Collector│
                    │     Mock      │
                    └──────────────┘
```

## Running the Tests

### Prerequisites

- Docker and Docker Compose
- Node.js 16+ and npm
- Playwright installed (`npm install -D @playwright/test`)

### Quick Start

```bash
# Run all tracing tests
./run-tests.sh

# Or run manually
docker-compose up -d
npm test -- e2e/tests/tracing/tracing.spec.ts
docker-compose down
```

### Running Individual Tests

```bash
# Run a specific test
npx playwright test e2e/tests/tracing/tracing.spec.ts -g "should create traces for login flow"

# Run with UI mode for debugging
npx playwright test e2e/tests/tracing/tracing.spec.ts --ui

# Run with trace viewer
npx playwright test e2e/tests/tracing/tracing.spec.ts --trace on
```

## Test Coverage

### Basic Tracing Tests
- **Unauthenticated requests**: Verifies traces are created with proper auth result
- **Trace context propagation**: Tests W3C traceparent header handling
- **Login flow**: Complete authentication flow with all expected spans
- **Authenticated requests**: Session validation spans
- **XHR requests**: JavaScript request detection in traces
- **Logout flow**: Logout operation tracing

### Advanced Tracing Tests
- **Token introspection**: Traces for introspection-based validation
- **JWKS refresh**: Traces for JWKS reload operations
- **Auto-enable mode**: Tracing only when trace headers present
- **Error handling**: Proper error recording in spans
- **Latency measurement**: Span duration accuracy

### Performance Tests
- **Overhead measurement**: Compares response times with/without tracing

## Configuration

The tests use environment variables to configure tracing:

```bash
# Enable/disable tracing (true, false, auto)
TRACING_ENABLED=true

# OTLP endpoint (uses host.docker.internal for Docker)
TRACING_OTLP_ENDPOINT=host.docker.internal:4318

# Service name for traces
TRACING_SERVICE_NAME=traefik-oidc-auth-test

# Include detailed user/claim info in spans
TRACING_DETAILED_SPANS=true
```

## OTLP Collector Mock

The tests include a lightweight OTLP collector mock that:
- Accepts traces via OTLP/HTTP protocol
- Stores traces in memory for verification
- Provides helper methods to find and analyze spans
- No external dependencies required

### Using the Mock Standalone

```bash
# Start the mock collector
node otlp-collector-mock.js

# Check health
curl http://localhost:4318/health

# View collected traces
curl http://localhost:4318/traces
```

## Trace Structure

Expected trace structure for a typical authentication flow:

```
oidc.serve_http (root span)
├── oidc.discovery
├── oidc.provider_redirect
└── oidc.handle_callback
    ├── oidc.token_exchange
    └── oidc.token_validation
        └── oidc.jwks_fetch
```

## Debugging Tips

1. **View Docker logs**: 
   ```bash
   docker-compose logs -f traefik
   ```

2. **Check OTLP collector**:
   ```bash
   curl http://localhost:4318/health
   ```

3. **Enable Playwright trace viewer**:
   ```bash
   npx playwright test --trace on
   npx playwright show-trace
   ```

4. **Inspect collected traces**:
   ```bash
   curl http://localhost:4318/traces | jq .
   ```

## Common Issues

### Services not starting
- Check port conflicts (8080, 8000, 4318)
- Verify Docker daemon is running
- Check Docker Compose logs

### No traces collected
- Verify OTLP endpoint is reachable from Docker
- Check tracing is enabled in configuration
- Ensure trace headers are being sent (for auto mode)

### Test timeouts
- Increase wait timeouts in tests
- Check service health endpoints
- Verify network connectivity between services