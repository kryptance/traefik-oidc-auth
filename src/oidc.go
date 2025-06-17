package src

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"github.com/sevensolutions/traefik-oidc-auth/src/logging"
	"github.com/sevensolutions/traefik-oidc-auth/src/oidc"
	"github.com/sevensolutions/traefik-oidc-auth/src/tracing"
	"github.com/sevensolutions/traefik-oidc-auth/src/utils"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

func GetOidcDiscovery(logger *logging.Logger, httpClient *http.Client, providerUrl *url.URL) (*oidc.OidcDiscovery, error) {
	return GetOidcDiscoveryWithContext(context.Background(), logger, httpClient, providerUrl, nil)
}

func GetOidcDiscoveryWithContext(ctx context.Context, logger *logging.Logger, httpClient *http.Client, providerUrl *url.URL, tracer *tracing.Tracer) (*oidc.OidcDiscovery, error) {
	wellKnownUrl := *providerUrl

	wellKnownUrl.Path = path.Join(wellKnownUrl.Path, ".well-known/openid-configuration")

	// Create request with context
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, wellKnownUrl.String(), nil)
	if err != nil {
		return nil, err
	}

	// Inject trace context if tracer is available
	if tracer != nil && tracer.IsEnabled() {
		tracer.InjectContext(ctx, req)
	}

	// Make HTTP GET request to the OpenID provider's discovery endpoint
	resp, err := httpClient.Do(req)

	if err != nil {
		logger.Log(logging.LevelError, "http-get discovery endpoints - Err: %s", err.Error())
		return nil, errors.New("HTTP GET error")
	}

	defer resp.Body.Close()

	// Check if the response status code is successful
	if resp.StatusCode >= 300 {
		logger.Log(logging.LevelError, "http-get OIDC discovery endpoints - http status code: %s", resp.Status)
		return nil, errors.New("HTTP error - Status code: " + resp.Status)
	}

	// Decode the JSON response
	document := oidc.OidcDiscovery{}
	err = json.NewDecoder(resp.Body).Decode(&document)

	if err != nil {
		logger.Log(logging.LevelError, "Failed to decode OIDC discovery document. Status code: %s", err.Error())
		return &document, errors.New("Failed to decode OIDC discovery document. Status code: " + err.Error())
	}

	return &document, nil
}

func randomBytesInHex(count int) (string, error) {
	buf := make([]byte, count)
	_, err := io.ReadFull(rand.Reader, buf)
	if err != nil {
		return "", fmt.Errorf("could not generate %d random bytes: %v", count, err)
	}

	return hex.EncodeToString(buf), nil
}

func exchangeAuthCode(oidcAuth *TraefikOidcAuth, req *http.Request, authCode string) (*oidc.OidcTokenResponse, error) {
	ctx := req.Context()

	// Start token exchange span
	var span trace.Span
	if oidcAuth.Tracer != nil {
		ctx, span = oidcAuth.Tracer.StartSpan(ctx, tracing.SpanNameTokenExchange)
		defer span.End()
		span.SetAttributes(tracing.AttrOIDCTokenEndpoint.String(oidcAuth.DiscoveryDocument.TokenEndpoint))
	}

	redirectUrl := oidcAuth.GetAbsoluteCallbackURL(req).String()

	urlValues := url.Values{
		"grant_type":   {"authorization_code"},
		"client_id":    {oidcAuth.Config.Provider.ClientId},
		"code":         {authCode},
		"redirect_uri": {redirectUrl},
	}

	if oidcAuth.Config.Provider.ClientSecret != "" {
		urlValues.Add("client_secret", oidcAuth.Config.Provider.ClientSecret)
	}

	if oidcAuth.Config.Provider.UsePkceBool {
		codeVerifierCookie, err := req.Cookie(getCodeVerifierCookieName(oidcAuth.Config))
		if err != nil {
			if span != nil && span.IsRecording() {
				tracing.RecordError(span, err, "Failed to get PKCE code verifier cookie")
			}
			return nil, err
		}

		codeVerifier, err := utils.Decrypt(codeVerifierCookie.Value, oidcAuth.Config.Secret)
		if err != nil {
			if span != nil && span.IsRecording() {
				tracing.RecordError(span, err, "Failed to decrypt PKCE code verifier")
			}
			return nil, err
		}

		urlValues.Add("code_verifier", codeVerifier)
	}

	// Create request with context
	tokenReq, err := http.NewRequestWithContext(ctx, http.MethodPost, oidcAuth.DiscoveryDocument.TokenEndpoint, strings.NewReader(urlValues.Encode()))
	if err != nil {
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, "Failed to create token exchange request")
		}
		return nil, err
	}

	tokenReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	// Inject trace context
	if oidcAuth.Tracer != nil && oidcAuth.Tracer.IsEnabled() {
		oidcAuth.Tracer.InjectContext(ctx, tokenReq)
	}

	resp, err := oidcAuth.httpClient.Do(tokenReq)

	if err != nil {
		oidcAuth.logger.Log(logging.LevelError, "exchangeAuthCode: couldn't POST to Provider: %s", err.Error())
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, "Failed to exchange authorization code")
		}
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		oidcAuth.logger.Log(logging.LevelError, "exchangeAuthCode: received bad HTTP response from Provider: %s", string(body))
		err := errors.New("invalid status code")
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, fmt.Sprintf("Token exchange failed with status %d", resp.StatusCode))
		}
		return nil, err
	}

	tokenResponse := &oidc.OidcTokenResponse{}
	err = json.NewDecoder(resp.Body).Decode(tokenResponse)
	if err != nil {
		oidcAuth.logger.Log(logging.LevelError, "exchangeAuthCode: couldn't decode OidcTokenResponse: %s", err.Error())
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, "Failed to decode token response")
		}
		return nil, err
	}

	if span != nil && span.IsRecording() {
		span.SetAttributes(
			tracing.AttrOIDCTokenType.String("authorization_code"),
		)
	}

	return tokenResponse, nil
}

func (toa *TraefikOidcAuth) validateTokenLocally(tokenString string) (bool, map[string]interface{}, error) {
	return toa.validateTokenLocallyWithContext(context.Background(), tokenString)
}

func (toa *TraefikOidcAuth) validateTokenLocallyWithContext(ctx context.Context, tokenString string) (bool, map[string]interface{}, error) {
	// Start token validation span
	var span trace.Span
	if toa.Tracer != nil {
		ctx, span = toa.Tracer.StartSpan(ctx, tracing.SpanNameTokenValidation)
		defer span.End()
		span.SetAttributes(
			tracing.AttrOIDCTokenValidation.String("local_jwt"),
			tracing.AttrOIDCJWKSEndpoint.String(toa.Jwks.Url),
		)
	}

	claims := jwt.MapClaims{}

	// Start JWKS fetch span if needed
	if span != nil && span.IsRecording() {
		_, jwksSpan := toa.Tracer.StartSpan(ctx, tracing.SpanNameJWKSFetch)
		jwksSpan.SetAttributes(tracing.AttrOIDCJWKSEndpoint.String(toa.Jwks.Url))
		err := toa.Jwks.EnsureLoaded(toa.logger, toa.httpClient, false)
		if err != nil {
			tracing.RecordError(jwksSpan, err, "Failed to load JWKS")
		}
		jwksSpan.End()
		if err != nil {
			tracing.RecordError(span, err, "Failed to load JWKS")
			return false, nil, err
		}
	} else {
		err := toa.Jwks.EnsureLoaded(toa.logger, toa.httpClient, false)
		if err != nil {
			return false, nil, err
		}
	}

	options := []jwt.ParserOption{
		jwt.WithExpirationRequired(),
	}

	if toa.Config.Provider.ValidateIssuerBool {
		options = append(options, jwt.WithIssuer(toa.Config.Provider.ValidIssuer))
	}
	if toa.Config.Provider.ValidateAudienceBool {
		options = append(options, jwt.WithAudience(toa.Config.Provider.ValidAudience))
	}

	parser := jwt.NewParser(options...)

	_, err := parser.ParseWithClaims(tokenString, claims, toa.Jwks.Keyfunc)

	if err != nil {
		// Retry with fresh JWKS
		if span != nil && span.IsRecording() {
			_, jwksSpan := toa.Tracer.StartSpan(ctx, tracing.SpanNameJWKSFetch)
			jwksSpan.SetAttributes(
				tracing.AttrOIDCJWKSEndpoint.String(toa.Jwks.Url),
				attribute.Bool("force_reload", true),
			)
			reloadErr := toa.Jwks.EnsureLoaded(toa.logger, toa.httpClient, true)
			if reloadErr != nil {
				tracing.RecordError(jwksSpan, reloadErr, "Failed to reload JWKS")
			}
			jwksSpan.End()
			if reloadErr != nil {
				tracing.RecordError(span, reloadErr, "Failed to reload JWKS")
				return false, nil, reloadErr
			}
		} else {
			reloadErr := toa.Jwks.EnsureLoaded(toa.logger, toa.httpClient, true)
			if reloadErr != nil {
				return false, nil, reloadErr
			}
		}

		_, err = parser.ParseWithClaims(tokenString, claims, toa.Jwks.Keyfunc)

		if err != nil {
			if errors.Is(err, jwt.ErrTokenExpired) || err.Error() == "token has invalid claims: token is expired" {
				toa.logger.Log(logging.LevelInfo, "The token is expired.")
				if span != nil && span.IsRecording() {
					span.SetAttributes(attribute.Bool("token_expired", true))
				}
			} else {
				toa.logger.Log(logging.LevelError, "Failed to parse token: %v", err)
			}

			if span != nil && span.IsRecording() {
				tracing.RecordError(span, err, "Token validation failed")
			}
			return false, nil, err
		}
	}

	if span != nil && span.IsRecording() && toa.Config.Tracing.DetailedSpans {
		// Add detailed claims attributes
		if sub, ok := claims["sub"].(string); ok {
			tracing.SetUserInfo(span, sub, "")
		}
		if email, ok := claims["email"].(string); ok {
			span.SetAttributes(tracing.AttrOIDCUserEmail.String(email))
		}
		if iss, ok := claims["iss"].(string); ok {
			span.SetAttributes(attribute.String("oidc.issuer", iss))
		}
		if aud, ok := claims["aud"]; ok {
			span.SetAttributes(attribute.String("oidc.audience", fmt.Sprintf("%v", aud)))
		}
	}

	return true, claims, nil
}

func (toa *TraefikOidcAuth) parseTokenWithoutValidation(tokenString string) (map[string]interface{}, error) {
	// Parse token without validation to extract claims
	claims := jwt.MapClaims{}
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())

	_, _, err := parser.ParseUnverified(tokenString, claims)
	if err != nil {
		return nil, err
	}

	return claims, nil
}

func (toa *TraefikOidcAuth) introspectToken(token string) (bool, map[string]interface{}, error) {
	return toa.introspectTokenWithContext(context.Background(), token)
}

func (toa *TraefikOidcAuth) introspectTokenWithContext(ctx context.Context, token string) (bool, map[string]interface{}, error) {
	// Start introspection span
	var span trace.Span
	if toa.Tracer != nil {
		ctx, span = toa.Tracer.StartSpan(ctx, tracing.SpanNameTokenIntrospection)
		defer span.End()
		span.SetAttributes(
			tracing.AttrOIDCIntrospectEndpoint.String(toa.DiscoveryDocument.IntrospectionEndpoint),
			tracing.AttrOIDCTokenValidation.String("introspection"),
		)
	}

	data := url.Values{
		"token": {token},
	}

	endpoint := toa.DiscoveryDocument.IntrospectionEndpoint

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		strings.NewReader(data.Encode()),
	)

	if err != nil {
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, "Failed to create introspection request")
		}
		return false, nil, err
	}

	req.Header.Add("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(toa.Config.Provider.ClientId, toa.Config.Provider.ClientSecret)

	// Inject trace context
	if toa.Tracer != nil && toa.Tracer.IsEnabled() {
		toa.Tracer.InjectContext(ctx, req)
	}

	resp, err := toa.httpClient.Do(req)
	if err != nil {
		toa.logger.Log(logging.LevelError, "Error on introspection request: %s", err.Error())
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, "Introspection request failed")
		}
		return false, nil, err
	}

	defer resp.Body.Close()

	var introspectResponse map[string]interface{}
	err = json.NewDecoder(resp.Body).Decode(&introspectResponse)

	if err != nil {
		toa.logger.Log(logging.LevelError, "Failed to decode introspection response: %s", err.Error())
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, "Failed to decode introspection response")
		}
		return false, nil, err
	}

	if introspectResponse["active"] != nil {
		active := introspectResponse["active"].(bool)
		if span != nil && span.IsRecording() {
			span.SetAttributes(attribute.Bool("token_active", active))
			if toa.Config.Tracing.DetailedSpans {
				// Add detailed introspection results
				if sub, ok := introspectResponse["sub"].(string); ok {
					tracing.SetUserInfo(span, sub, "")
				}
				if scope, ok := introspectResponse["scope"].(string); ok {
					span.SetAttributes(attribute.String("token_scope", scope))
				}
				if exp, ok := introspectResponse["exp"].(float64); ok {
					span.SetAttributes(attribute.Float64("token_exp", exp))
				}
			}
		}
		return active, introspectResponse, nil
	} else {
		err := errors.New("received invalid introspection response")
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, "Invalid introspection response format")
		}
		return false, nil, err
	}
}

func (toa *TraefikOidcAuth) renewToken(refreshToken string) (*oidc.OidcTokenResponse, error) {
	urlValues := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {toa.Config.Provider.ClientId},
		"scope":         {strings.Join(toa.Config.Scopes, " ")},
		"refresh_token": {refreshToken},
	}

	if toa.Config.Provider.ClientSecret != "" {
		urlValues.Add("client_secret", toa.Config.Provider.ClientSecret)
	}

	resp, err := toa.httpClient.PostForm(toa.DiscoveryDocument.TokenEndpoint, urlValues)

	if err != nil {
		toa.logger.Log(logging.LevelError, "renewToken: couldn't POST to Provider: %s", err.Error())
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		toa.logger.Log(logging.LevelError, "renewToken: received bad HTTP response from Provider: %s", string(body))
		return nil, errors.New("invalid status code")
	}

	tokenResponse := &oidc.OidcTokenResponse{}
	err = json.NewDecoder(resp.Body).Decode(tokenResponse)
	if err != nil {
		toa.logger.Log(logging.LevelError, "renewToken: couldn't decode OidcTokenResponse: %s", err.Error())
		return nil, err
	}

	return tokenResponse, nil
}
