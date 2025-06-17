# Makefile for traefik-oidc-auth

# Variables
BINARY_NAME := traefik-oidc-auth
STANDALONE_BINARY := standalone
GO := go
GOFLAGS := -v
GOTEST := $(GO) test
GOBUILD := $(GO) build
GOCLEAN := $(GO) clean
GOMOD := $(GO) mod
NPM := npm
DOCKER := docker
DOCKER_COMPOSE := docker-compose
PLAYWRIGHT := npx playwright

# Versioning
VERSION ?= dev
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS := -ldflags "-X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.date=$(DATE)"

# Directories
SRC_DIR := ./src
CMD_DIR := ./cmd
E2E_DIR := ./e2e
DIST_DIR := ./dist
VENDOR_DIR := ./vendor

# Default target
.DEFAULT_GOAL := help

# Phony targets
.PHONY: all build build-standalone test test-unit test-integration test-e2e test-e2e-keycloak \
        test-e2e-standalone test-e2e-tracing test-coverage lint fmt vet clean vendor \
        docker-build docker-push run-standalone help install-tools check-tools \
        test-all ci generate-mocks update-deps security-scan

## help: Show this help message
help:
	@echo "traefik-oidc-auth Makefile"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@sed -n 's/^##//p' ${MAKEFILE_LIST} | column -t -s ':' | sed -e 's/^/ /'

## all: Build everything
all: clean vendor lint test build

## build: Build the middleware library
build: vendor
	@echo "Building traefik-oidc-auth..."
	$(GOBUILD) $(GOFLAGS) $(SRC_DIR)/...

## build-standalone: Build the standalone binary
build-standalone: vendor
	@echo "Building standalone binary..."
	$(GOBUILD) $(GOFLAGS) $(LDFLAGS) -o $(DIST_DIR)/$(STANDALONE_BINARY) $(CMD_DIR)/standalone

## build-all: Build all binaries
build-all: build build-standalone

## test: Run all Go tests
test: test-unit

## test-unit: Run unit tests
test-unit:
	@echo "Running unit tests..."
	$(GOTEST) -v -short -race -coverprofile=coverage.out $(SRC_DIR)/...

## test-integration: Run integration tests
test-integration:
	@echo "Running integration tests..."
	$(GOTEST) -v -race -tags=integration $(SRC_DIR)/...

## test-coverage: Run tests with coverage report
test-coverage: test-unit
	@echo "Generating coverage report..."
	$(GO) tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

## test-e2e: Run all e2e tests
test-e2e: check-e2e-deps test-e2e-keycloak test-e2e-standalone test-e2e-tracing

## test-e2e-keycloak: Run Keycloak e2e tests
test-e2e-keycloak: check-e2e-deps
	@echo "Running Keycloak e2e tests..."
	cd $(E2E_DIR) && $(PLAYWRIGHT) test tests/keycloak/keycloak-login.spec.ts tests/keycloak/keycloak-advanced.spec.ts tests/keycloak/keycloak-xhr.spec.ts --reporter=list

## test-e2e-standalone: Run standalone e2e tests
test-e2e-standalone: check-e2e-deps build-standalone
	@echo "Running standalone e2e tests..."
	cd $(E2E_DIR) && $(PLAYWRIGHT) test tests/standalone/standalone.spec.ts --reporter=list

## test-e2e-tracing: Run tracing e2e tests
test-e2e-tracing: check-e2e-deps
	@echo "Running tracing e2e tests..."
	cd $(E2E_DIR) && $(PLAYWRIGHT) test tests/tracing/basic-tracing.spec.ts tests/tracing/simple-tracing.spec.ts --reporter=list

## test-e2e-tracing-full: Run full tracing e2e tests (requires Docker)
test-e2e-tracing-full: check-e2e-deps build-standalone
	@echo "Running full tracing e2e tests..."
	cd $(E2E_DIR) && $(PLAYWRIGHT) test tests/tracing/tracing.spec.ts tests/standalone/standalone-tracing.spec.ts --reporter=list

## test-all: Run all tests (unit, integration, and e2e)
test-all: test-unit test-integration test-e2e

## lint: Run linters
lint: check-tools
	@echo "Running linters..."
	golangci-lint run $(SRC_DIR)/...
	golangci-lint run $(CMD_DIR)/...

## fmt: Format Go code
fmt:
	@echo "Formatting Go code..."
	$(GO) fmt ./...

## vet: Run go vet
vet:
	@echo "Running go vet..."
	$(GO) vet ./...

## clean: Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	$(GOCLEAN)
	rm -rf $(DIST_DIR)
	rm -f coverage.out coverage.html
	find . -name "*.test" -type f -delete

## vendor: Update vendor directory
vendor:
	@echo "Updating vendor directory..."
	$(GOMOD) download
	$(GOMOD) vendor
	$(GOMOD) tidy

## update-deps: Update all dependencies
update-deps:
	@echo "Updating dependencies..."
	$(GOMOD) download
	$(GOMOD) tidy
	$(GO) get -u ./...
	$(GOMOD) tidy

## docker-build: Build Docker image
docker-build:
	@echo "Building Docker image..."
	$(DOCKER) build -t traefik-oidc-auth:$(VERSION) -t traefik-oidc-auth:latest .

## docker-push: Push Docker image to registry
docker-push: docker-build
	@echo "Pushing Docker image..."
	$(DOCKER) push traefik-oidc-auth:$(VERSION)
	$(DOCKER) push traefik-oidc-auth:latest

## run-standalone: Run standalone server with example config
run-standalone: build-standalone
	@echo "Running standalone server..."
	$(DIST_DIR)/$(STANDALONE_BINARY) \
		-config example-config-with-tracing.yml \
		-upstream http://localhost:3000 \
		-addr :8080 \
		-metrics-addr :9090

## install-tools: Install required development tools
install-tools:
	@echo "Installing development tools..."
	$(GO) install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	$(GO) install golang.org/x/tools/cmd/goimports@latest
	$(GO) install github.com/securego/gosec/v2/cmd/gosec@latest
	cd $(E2E_DIR) && $(NPM) install

## check-tools: Check if required tools are installed
check-tools:
	@echo "Checking required tools..."
	@which golangci-lint > /dev/null || (echo "golangci-lint not found. Run 'make install-tools'" && exit 1)
	@which $(DOCKER) > /dev/null || (echo "docker not found. Please install Docker" && exit 1)
	@which $(NPM) > /dev/null || (echo "npm not found. Please install Node.js" && exit 1)

## check-e2e-deps: Check e2e test dependencies
check-e2e-deps:
	@echo "Checking e2e test dependencies..."
	@test -d $(E2E_DIR)/node_modules || (cd $(E2E_DIR) && $(NPM) install)

## security-scan: Run security scan on Go dependencies
security-scan:
	@echo "Running security scan..."
	@which gosec > /dev/null || (echo "Installing gosec..." && go install github.com/securego/gosec/v2/cmd/gosec@latest)
	gosec -fmt=json -out=security-report.json ./... || true
	@echo "Security report generated: security-report.json"

## generate-mocks: Generate mock files for testing
generate-mocks:
	@echo "Generating mocks..."
	$(GO) generate ./...

## ci: Run CI pipeline locally
ci: clean vendor lint vet test-unit security-scan build-all
	@echo "CI pipeline completed successfully!"

# Development helpers

## dev-keycloak: Start Keycloak for development
dev-keycloak:
	@echo "Starting Keycloak for development..."
	cd workspaces/keycloak && $(DOCKER_COMPOSE) up -d

## dev-keycloak-stop: Stop development Keycloak
dev-keycloak-stop:
	@echo "Stopping Keycloak..."
	cd workspaces/keycloak && $(DOCKER_COMPOSE) down

## dev-logs: Show logs from development services
dev-logs:
	cd workspaces/keycloak && $(DOCKER_COMPOSE) logs -f

# E2E test helpers with Docker Compose

## e2e-keycloak-up: Start Keycloak e2e test environment
e2e-keycloak-up:
	@echo "Starting Keycloak e2e test environment..."
	cd $(E2E_DIR)/tests/keycloak && $(DOCKER_COMPOSE) up -d

## e2e-keycloak-down: Stop Keycloak e2e test environment
e2e-keycloak-down:
	@echo "Stopping Keycloak e2e test environment..."
	cd $(E2E_DIR)/tests/keycloak && $(DOCKER_COMPOSE) down -v

## e2e-keycloak-logs: Show Keycloak e2e test logs
e2e-keycloak-logs:
	cd $(E2E_DIR)/tests/keycloak && $(DOCKER_COMPOSE) logs -f

## e2e-standalone-up: Start standalone e2e test environment
e2e-standalone-up: build-standalone
	@echo "Starting standalone e2e test environment..."
	cd $(E2E_DIR)/tests/standalone && $(DOCKER_COMPOSE) up -d

## e2e-standalone-down: Stop standalone e2e test environment
e2e-standalone-down:
	@echo "Stopping standalone e2e test environment..."
	cd $(E2E_DIR)/tests/standalone && $(DOCKER_COMPOSE) down -v

## e2e-tracing-up: Start tracing e2e test environment
e2e-tracing-up:
	@echo "Starting tracing e2e test environment..."
	cd $(E2E_DIR)/tests/tracing && $(DOCKER_COMPOSE) up -d

## e2e-tracing-down: Stop tracing e2e test environment
e2e-tracing-down:
	@echo "Stopping tracing e2e test environment..."
	cd $(E2E_DIR)/tests/tracing && $(DOCKER_COMPOSE) down -v

# Release targets

## release-patch: Create a patch release
release-patch: test-all
	@echo "Creating patch release..."
	git tag -a v$$(git describe --tags --abbrev=0 | awk -F. '{print $$1"."$$2"."$$3+1}') -m "Patch release"

## release-minor: Create a minor release
release-minor: test-all
	@echo "Creating minor release..."
	git tag -a v$$(git describe --tags --abbrev=0 | awk -F. '{print $$1"."$$2+1".0"}') -m "Minor release"

## release-major: Create a major release
release-major: test-all
	@echo "Creating major release..."
	git tag -a v$$(git describe --tags --abbrev=0 | awk -F. '{print $$1+1".0.0"}') -m "Major release"

# Quick commands for common tasks

## quick-test: Run quick tests without vendor update
quick-test:
	$(GOTEST) -v -short $(SRC_DIR)/...

## quick-build: Quick build without vendor update
quick-build:
	$(GOBUILD) $(GOFLAGS) $(SRC_DIR)/...