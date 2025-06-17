# Tracing Tests Status

## Test Files Overview

### 1. `basic-tracing.spec.ts` ✅
- **Status**: Working
- **Tests**: 6/6 passing
- **Description**: Tests basic OTLP collector functionality
- **Features tested**:
  - OTLP collector health check
  - Sending traces to OTLP endpoint
  - Trace context propagation
  - Span attributes recording
  - Error recording in spans
  - Span duration calculation

### 2. `simple-tracing.spec.ts` ✅
- **Status**: Working
- **Tests**: 5/5 passing (1 skipped by design)
- **Description**: Lightweight tests that don't require Docker
- **Features tested**:
  - Tracing configuration validation
  - W3C traceparent header generation
  - OTLP response parsing
  - Span attribute validation
  - Duration calculation with BigInt

### 3. `tracing.spec.ts` 🐳
- **Status**: Requires full Docker environment
- **Tests**: Comprehensive integration tests
- **Description**: Full e2e tests with Traefik, Keycloak, and OTLP collector
- **Features tested**:
  - Complete authentication flow tracing
  - IDP request instrumentation
  - Token validation tracing
  - Session management spans
  - Auto-enable mode
  - Performance overhead measurement

## Supporting Files

### `otlp-collector-mock.js` ✅
- Simple HTTP server that accepts OTLP traces
- Can be run standalone: `node otlp-collector-mock.js`
- Endpoints:
  - `POST /v1/traces` - Accept OTLP traces
  - `GET /health` - Health check
  - `GET /traces` - View collected traces

### `docker-compose.yml` ✅
- Sets up full test environment:
  - Keycloak (port 8000)
  - Traefik with OIDC middleware (port 8080)
  - Whoami service (backend)
  - OTLP collector configuration

### `run-tests.sh` ✅
- Automated test runner for full integration tests
- Handles service startup/shutdown
- Waits for services to be ready

## Running the Tests

### Quick Tests (No Docker Required)
```bash
# From project root
make test-e2e-tracing

# Or directly
cd e2e
npm test -- tests/tracing/basic-tracing.spec.ts tests/tracing/simple-tracing.spec.ts
```

### Full Integration Tests (Requires Docker)
```bash
# From project root
make test-e2e-tracing-full

# Or using the script
cd e2e/tests/tracing
./run-tests.sh
```

### Individual Test Files
```bash
cd e2e

# Basic collector tests
npm test -- tests/tracing/basic-tracing.spec.ts

# Simple validation tests
npm test -- tests/tracing/simple-tracing.spec.ts

# Full integration (requires Docker running)
npm test -- tests/tracing/tracing.spec.ts
```

## Test Coverage

- ✅ OTLP protocol implementation
- ✅ Trace context propagation
- ✅ Span attribute validation
- ✅ Error recording
- ✅ Duration calculations
- ✅ Configuration validation
- ✅ W3C traceparent format
- 🐳 Full authentication flow tracing (requires Docker)
- 🐳 IDP request tracing (requires Docker)
- 🐳 Performance overhead measurement (requires Docker)

## Notes

- The basic and simple tests run without any external dependencies
- The full integration tests require Docker and take longer to run
- All tests are designed to be run in CI/CD pipelines
- The OTLP collector mock can be used for local development and testing