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

# Copy default config with environment variable placeholders
COPY --from=builder /app/cmd/standalone/config.default.json /config/config.json

# Set ownership
RUN chown -R oidc:oidc /config

# Switch to non-root user
USER oidc

# Expose ports
EXPOSE 8080 9090

# Set default environment variables for standalone mode
ENV TRAEFIK_AUTH_CONFIG_FILE=/config/config.json \
    TRAEFIK_AUTH_LISTEN_ADDR=:8080 \
    TRAEFIK_AUTH_METRICS_ADDR=:9090 \
    TRAEFIK_AUTH_UPSTREAM_URL=http://localhost:8081

# Set default OIDC configuration environment variables
ENV LOG_LEVEL=info \
    OIDC_SECRET=change-me-please-use-32-characters \
    OIDC_PROVIDER_URL=https://accounts.google.com \
    OIDC_CLIENT_ID=your-client-id \
    OIDC_CLIENT_SECRET=your-client-secret \
    OIDC_USE_PKCE=false \
    OIDC_INSECURE_SKIP_VERIFY=false \
    OIDC_TOKEN_VALIDATION=AccessToken \
    OIDC_VALIDATE_ISSUER=true \
    OIDC_VALIDATE_AUDIENCE=true \
    OIDC_VALID_ISSUER="" \
    OIDC_VALID_AUDIENCE="" \
    OIDC_CALLBACK_URI=/oauth2/callback \
    OIDC_LOGIN_URI=/oauth2/login \
    OIDC_LOGOUT_URI=/oauth2/logout \
    OIDC_POST_LOGIN_REDIRECT_URI=/ \
    OIDC_POST_LOGOUT_REDIRECT_URI=/ \
    OIDC_COOKIE_NAME_PREFIX=TraefikOidcAuth \
    OIDC_SESSION_COOKIE_PATH=/ \
    OIDC_SESSION_COOKIE_DOMAIN="" \
    OIDC_SESSION_COOKIE_SAME_SITE=default \
    OIDC_METRICS_PREFIX=oidc_auth \
    OIDC_METRICS_PATH=/metrics

# Entry point
ENTRYPOINT ["/usr/local/bin/traefik-oidc-auth"]

# Default command (no arguments needed as we use environment variables)
CMD ["/usr/local/bin/traefik-oidc-auth"]