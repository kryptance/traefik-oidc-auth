# Docker Environment Variable Configuration

The traefik-oidc-auth Docker image includes a default configuration file with environment variable placeholders, allowing you to configure the middleware entirely through environment variables without mounting a config file.

## Quick Start

```bash
docker run -d \
  -p 8080:8080 \
  -e TRAEFIK_AUTH_UPSTREAM_URL=http://your-backend:8080 \
  -e OIDC_PROVIDER_URL=https://your-idp.com \
  -e OIDC_CLIENT_ID=your-client-id \
  -e OIDC_CLIENT_SECRET=your-client-secret \
  -e OIDC_SECRET=your-32-character-secret-string!! \
  traefik-oidc-auth:latest
```

## Environment Variables

### Standalone Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TRAEFIK_AUTH_CONFIG_FILE` | Path to config file | `/config/config.json` |
| `TRAEFIK_AUTH_LISTEN_ADDR` | Listen address | `:8080` |
| `TRAEFIK_AUTH_METRICS_ADDR` | Metrics server address | `:9090` |
| `TRAEFIK_AUTH_UPSTREAM_URL` | Upstream service URL | `http://localhost:8081` |

### OIDC Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level (debug, info, warn, error) | `info` |
| `OIDC_SECRET` | 32-character encryption secret | `change-me-please-use-32-characters` |
| `OIDC_PROVIDER_URL` | OIDC provider base URL | `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | OAuth2 client ID | `your-client-id` |
| `OIDC_CLIENT_SECRET` | OAuth2 client secret | `your-client-secret` |
| `OIDC_USE_PKCE` | Enable PKCE | `false` |
| `OIDC_INSECURE_SKIP_VERIFY` | Skip TLS verification | `false` |
| `OIDC_TOKEN_VALIDATION` | Token to validate (AccessToken, IdToken, Introspection) | `AccessToken` |
| `OIDC_VALIDATE_ISSUER` | Validate token issuer | `true` |
| `OIDC_VALIDATE_AUDIENCE` | Validate token audience | `true` |
| `OIDC_VALID_ISSUER` | Override expected issuer | (empty) |
| `OIDC_VALID_AUDIENCE` | Override expected audience | (empty) |
| `OIDC_CALLBACK_URI` | OAuth2 callback path | `/oauth2/callback` |
| `OIDC_LOGIN_URI` | Login initiation path | `/oauth2/login` |
| `OIDC_LOGOUT_URI` | Logout path | `/oauth2/logout` |
| `OIDC_POST_LOGIN_REDIRECT_URI` | Redirect after login | `/` |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | Redirect after logout | `/` |
| `OIDC_COOKIE_NAME_PREFIX` | Cookie name prefix | `TraefikOidcAuth` |
| `OIDC_SESSION_COOKIE_PATH` | Session cookie path | `/` |
| `OIDC_SESSION_COOKIE_DOMAIN` | Session cookie domain | (empty) |
| `OIDC_SESSION_COOKIE_SAME_SITE` | SameSite cookie attribute | `default` |
| `OIDC_METRICS_PREFIX` | Prometheus metrics prefix | `oidc_auth` |
| `OIDC_METRICS_PATH` | Metrics endpoint path | `/metrics` |

## Examples

### Basic Setup with Google

```bash
docker run -d \
  -p 8080:8080 \
  -e TRAEFIK_AUTH_UPSTREAM_URL=http://my-api:3000 \
  -e OIDC_PROVIDER_URL=https://accounts.google.com \
  -e OIDC_CLIENT_ID=123456789-abc.apps.googleusercontent.com \
  -e OIDC_CLIENT_SECRET=your-google-secret \
  -e OIDC_SECRET=my-32-character-encryption-key!! \
  traefik-oidc-auth:latest
```

### Keycloak Setup

```bash
docker run -d \
  -p 8080:8080 \
  -e TRAEFIK_AUTH_UPSTREAM_URL=http://backend:8080 \
  -e OIDC_PROVIDER_URL=https://keycloak.example.com/realms/master \
  -e OIDC_CLIENT_ID=traefik-app \
  -e OIDC_CLIENT_SECRET=your-keycloak-secret \
  -e OIDC_SECRET=my-32-character-encryption-key!! \
  -e OIDC_USE_PKCE=true \
  -e LOG_LEVEL=debug \
  traefik-oidc-auth:latest
```

### Docker Compose

```yaml
version: '3.8'

services:
  oidc-auth:
    image: traefik-oidc-auth:latest
    ports:
      - "8080:8080"
      - "9090:9090"
    environment:
      # Upstream service
      - TRAEFIK_AUTH_UPSTREAM_URL=http://api:3000
      
      # OIDC configuration
      - OIDC_PROVIDER_URL=https://auth.example.com
      - OIDC_CLIENT_ID=${CLIENT_ID}
      - OIDC_CLIENT_SECRET=${CLIENT_SECRET}
      - OIDC_SECRET=${ENCRYPTION_SECRET}
      - OIDC_USE_PKCE=true
      - LOG_LEVEL=info
      
      # Optional overrides
      - OIDC_CALLBACK_URI=/auth/callback
      - OIDC_LOGIN_URI=/auth/login
      - OIDC_LOGOUT_URI=/auth/logout

  api:
    image: my-api:latest
    # No exposed ports needed - accessed through oidc-auth
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oidc-auth-proxy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oidc-auth-proxy
  template:
    metadata:
      labels:
        app: oidc-auth-proxy
    spec:
      containers:
      - name: oidc-auth
        image: traefik-oidc-auth:latest
        ports:
        - containerPort: 8080
        - containerPort: 9090
        env:
        - name: TRAEFIK_AUTH_UPSTREAM_URL
          value: "http://backend-service:8080"
        - name: OIDC_PROVIDER_URL
          value: "https://auth.example.com"
        - name: OIDC_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: oidc-credentials
              key: client-id
        - name: OIDC_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: oidc-credentials
              key: client-secret
        - name: OIDC_SECRET
          valueFrom:
            secretKeyRef:
              name: oidc-credentials
              key: encryption-secret
```

## Custom Configuration

If you need more complex configuration (like custom headers or authorization rules), you can still mount your own config file:

```bash
docker run -d \
  -p 8080:8080 \
  -v $(pwd)/my-config.json:/config/config.json:ro \
  -e TRAEFIK_AUTH_UPSTREAM_URL=http://backend:8080 \
  traefik-oidc-auth:latest
```

The mounted config can still use environment variables:

```json
{
  "provider": {
    "url": "${OIDC_PROVIDER_URL}",
    "client_id": "${OIDC_CLIENT_ID}",
    "client_secret": "${OIDC_CLIENT_SECRET}"
  },
  "authorization": {
    "assert_claims": [
      {
        "name": "groups",
        "anyOf": ["${ALLOWED_GROUPS}"]
      }
    ]
  }
}
```

## Security Notes

1. **Always use a strong 32-character secret** for `OIDC_SECRET`
2. **Never use default values in production**
3. **Store sensitive values in secrets** (Kubernetes secrets, Docker secrets, etc.)
4. **Use HTTPS in production** - Set `OIDC_INSECURE_SKIP_VERIFY=false`
5. **Enable PKCE when supported** - Set `OIDC_USE_PKCE=true`

## Troubleshooting

Enable debug logging to see detailed information:

```bash
docker run -d \
  -e LOG_LEVEL=debug \
  -e OIDC_PROVIDER_URL=https://auth.example.com \
  # ... other variables
  traefik-oidc-auth:latest
```

Check logs:
```bash
docker logs traefik-oidc-auth
```

Test metrics endpoint:
```bash
curl http://localhost:9090/metrics
```