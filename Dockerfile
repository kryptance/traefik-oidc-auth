# Build stage
FROM golang:1.23-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# Set working directory
WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the standalone binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo \
    -ldflags="-w -s -X main.version=$(git describe --tags --always) -X main.commit=$(git rev-parse --short HEAD) -X main.date=$(date -u '+%Y-%m-%d_%H:%M:%S')" \
    -o traefik-oidc-auth ./cmd/standalone

# Runtime stage
FROM alpine:3.19

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates

# Create non-root user
RUN addgroup -g 1000 -S oidc && \
    adduser -u 1000 -S oidc -G oidc

# Copy binary from builder
COPY --from=builder /app/traefik-oidc-auth /usr/local/bin/traefik-oidc-auth

# Copy example config
COPY --from=builder /app/cmd/standalone/config.example.json /etc/traefik-oidc-auth/config.example.json

# Create directory for custom configs
RUN mkdir -p /config && chown -R oidc:oidc /config

# Switch to non-root user
USER oidc

# Expose ports
EXPOSE 8080 9090

# Set default environment variables
ENV CONFIG_FILE=/config/config.json \
    LISTEN_ADDR=:8080 \
    METRICS_ADDR=:9090 \
    UPSTREAM_URL=http://localhost:8081

# Entry point
ENTRYPOINT ["/usr/local/bin/traefik-oidc-auth"]

# Default command
CMD sh -c "env && echo ARGS: \"$@\" && /usr/local/bin/traefik-oidc-auth -config \"$CONFIG_FILE\" -addr \"$LISTEN_ADDR\" -metrics-addr \"$METRICS_ADDR\" -upstream \"$UPSTREAM_URL\""