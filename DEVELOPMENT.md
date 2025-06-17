# Development Guide

This guide provides instructions for developing and testing the traefik-oidc-auth middleware.

## Prerequisites

- Go 1.23 or later
- Docker and Docker Compose
- Node.js 16+ and npm (for e2e tests)
- Make

## Quick Start

```bash
# Install development tools
make install-tools

# Build everything
make all

# Run tests
make test-all
```

## Makefile Targets

The project includes a comprehensive Makefile with the following targets:

### Building

- `make build` - Build the middleware library
- `make build-standalone` - Build the standalone binary
- `make build-all` - Build all binaries
- `make docker-build` - Build Docker image

### Testing

- `make test` - Run unit tests
- `make test-unit` - Run unit tests with race detection
- `make test-integration` - Run integration tests
- `make test-coverage` - Generate coverage report
- `make test-e2e` - Run all e2e tests
- `make test-e2e-keycloak` - Run Keycloak e2e tests
- `make test-e2e-standalone` - Run standalone e2e tests
- `make test-e2e-tracing` - Run OpenTelemetry tracing tests
- `make test-all` - Run all tests

### Code Quality

- `make lint` - Run linters (golangci-lint)
- `make fmt` - Format Go code
- `make vet` - Run go vet
- `make security-scan` - Run security scan with gosec

### Development

- `make vendor` - Update vendor directory
- `make update-deps` - Update all dependencies
- `make clean` - Clean build artifacts
- `make dev-keycloak` - Start Keycloak for development
- `make dev-keycloak-stop` - Stop development Keycloak
- `make run-standalone` - Run standalone server with example config

### E2E Test Helpers

- `make e2e-keycloak-up` - Start Keycloak e2e environment
- `make e2e-keycloak-down` - Stop Keycloak e2e environment
- `make e2e-keycloak-logs` - Show Keycloak logs
- `make e2e-standalone-up` - Start standalone e2e environment
- `make e2e-standalone-down` - Stop standalone e2e environment
- `make e2e-tracing-up` - Start tracing e2e environment
- `make e2e-tracing-down` - Stop tracing e2e environment

### CI/CD

- `make ci` - Run full CI pipeline locally
- `make docker-push` - Push Docker image to registry

## Development Workflow

### 1. Setting Up Development Environment

```bash
# Clone the repository
git clone https://github.com/sevensolutions/traefik-oidc-auth.git
cd traefik-oidc-auth

# Install tools
make install-tools

# Start development Keycloak
make dev-keycloak
```

### 2. Making Changes

```bash
# Format code
make fmt

# Run linters
make lint

# Run unit tests
make test-unit

# Run specific test
go test -v -run TestFunctionName ./src/...
```

### 3. Testing with Traefik

Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  traefik:
    image: traefik:v3.0
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--entrypoints.web.address=:80"
      - "--experimental.localPlugins.traefik-oidc-auth.modulename=github.com/sevensolutions/traefik-oidc-auth"
    ports:
      - "80:80"
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - .:/plugins-local/src/github.com/sevensolutions/traefik-oidc-auth

  whoami:
    image: traefik/whoami
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.whoami.rule=Host(`localhost`)"
      - "traefik.http.routers.whoami.middlewares=oidc-auth"
      - "traefik.http.middlewares.oidc-auth.plugin.traefik-oidc-auth.provider.url=http://keycloak:8080/realms/myrealm"
      - "traefik.http.middlewares.oidc-auth.plugin.traefik-oidc-auth.provider.client_id=my-client"
      - "traefik.http.middlewares.oidc-auth.plugin.traefik-oidc-auth.provider.client_secret=my-secret"
```

### 4. Running E2E Tests

```bash
# Run all e2e tests
make test-e2e

# Run specific e2e test suite
make test-e2e-keycloak

# Run e2e tests with UI (for debugging)
cd e2e
npx playwright test --ui

# Run e2e tests with trace viewer
cd e2e
npx playwright test --trace on
npx playwright show-trace
```

### 5. Testing Standalone Mode

```bash
# Build standalone binary
make build-standalone

# Run with example config
make run-standalone

# Or run manually
./dist/standalone \
  -config example-config.yml \
  -upstream http://localhost:3000 \
  -addr :8080
```

## Testing Guidelines

### Unit Tests

- Place tests in the same package as the code being tested
- Use table-driven tests where appropriate
- Mock external dependencies
- Aim for >80% code coverage

Example:

```go
func TestIsXHRRequest(t *testing.T) {
    tests := []struct {
        name     string
        headers  map[string]string
        expected bool
    }{
        {
            name: "XMLHttpRequest header",
            headers: map[string]string{
                "X-Requested-With": "XMLHttpRequest",
            },
            expected: true,
        },
        // More test cases...
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            req := httptest.NewRequest("GET", "/", nil)
            for k, v := range tt.headers {
                req.Header.Set(k, v)
            }
            
            result := IsXHRRequest(req)
            if result != tt.expected {
                t.Errorf("expected %v, got %v", tt.expected, result)
            }
        })
    }
}
```

### E2E Tests

- Use Playwright for browser automation
- Test complete user flows
- Verify both success and error scenarios
- Check metrics and traces where applicable

## Debugging

### Enable Debug Logging

Set `log_level: DEBUG` in your configuration:

```yaml
log_level: DEBUG
provider:
  url: "https://example.com/realms/myrealm"
  # ...
```

### View Traefik Logs

```bash
docker-compose logs -f traefik
```

### Inspect Metrics

```bash
# Prometheus format
curl http://localhost:9090/metrics

# JSON format
curl http://localhost:9090/metrics.json
```

### View OpenTelemetry Traces

When using Jaeger:

```bash
# Start Jaeger
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# View traces at http://localhost:16686
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`make test-all`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

### Pre-commit Checklist

- [ ] Code is formatted (`make fmt`)
- [ ] Tests pass (`make test`)
- [ ] Linter passes (`make lint`)
- [ ] E2E tests pass (`make test-e2e`)
- [ ] Documentation is updated
- [ ] CHANGELOG.md is updated

## Release Process

1. Update version in relevant files
2. Update CHANGELOG.md
3. Create release tag:

```bash
# Patch release (0.0.x)
make release-patch

# Minor release (0.x.0)
make release-minor

# Major release (x.0.0)
make release-major
```

4. Push tags: `git push --tags`
5. Create GitHub release with changelog

## Troubleshooting

### Common Issues

1. **Port conflicts**: Check if ports 8080, 8000, 9090, 4318 are available
2. **Docker permissions**: Ensure Docker daemon is running and you have permissions
3. **Go module issues**: Run `go mod download` and `go mod tidy`
4. **E2E test failures**: Check Docker Compose logs with `make e2e-keycloak-logs`

### Getting Help

- Check existing issues on GitHub
- Enable debug logging for more information
- Run specific tests in isolation to identify problems
- Use Playwright's UI mode for debugging e2e tests