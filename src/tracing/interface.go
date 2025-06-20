package tracing

import (
	"context"
	"net/http"
)

// Span represents a tracing span interface
type Span interface {
	End()
	SetAttributes(kv ...attribute)
	IsRecording() bool
	RecordError(err error, description string)
}

// Tracer represents the tracing interface
type Tracer interface {
	StartSpan(ctx context.Context, spanName string) (context.Context, Span)
	StartSpanFromRequest(req *http.Request, spanName string) (context.Context, Span)
	IsEnabled() bool
}

// Attribute represents a key-value attribute
type attribute struct {
	Key   string
	Value interface{}
}

// Constants for attribute keys
const (
	AttrOIDCProvider           = "oidc.provider"
	AttrOIDCClientID           = "oidc.client_id"
	AttrOIDCScopes             = "oidc.scopes"
	AttrOIDCTokenType          = "oidc.token_type"
	AttrOIDCTokenValidation    = "oidc.token_validation_method"
	AttrOIDCSessionID          = "oidc.session_id"
	AttrOIDCUserID             = "oidc.user_id"
	AttrOIDCUserEmail          = "oidc.user_email"
	AttrOIDCAuthResult         = "oidc.auth_result"
	AttrOIDCAuthReason         = "oidc.auth_reason"
	AttrOIDCBypassRule         = "oidc.bypass_rule"
	AttrOIDCJSRequest          = "oidc.js_request"
	AttrOIDCErrorType          = "oidc.error_type"
	AttrOIDCDiscoveryEndpoint  = "oidc.discovery_endpoint"
	AttrOIDCTokenEndpoint      = "oidc.token_endpoint"
	AttrOIDCJWKSEndpoint       = "oidc.jwks_endpoint"
	AttrOIDCUserInfoEndpoint   = "oidc.userinfo_endpoint"
	AttrOIDCIntrospectEndpoint = "oidc.introspect_endpoint"
	AttrOIDCMetricsEnabled     = "oidc.metrics_enabled"
	AttrHTTPMethod             = "http.method"
	AttrHTTPStatusCode         = "http.status_code"
	AttrHTTPURL                = "http.url"
	AttrHTTPRoute              = "http.route"
)

// Span names
const (
	SpanNameServeHTTP          = "oidc.serve_http"
	SpanNameOIDCDiscovery      = "oidc.discovery"
	SpanNameHandleCallback     = "oidc.handle_callback"
	SpanNameHandleLogout       = "oidc.handle_logout"
	SpanNameTokenExchange      = "oidc.token_exchange"
	SpanNameTokenValidation    = "oidc.token_validation"
	SpanNameJWKSFetch          = "oidc.jwks_fetch"
	SpanNameUserInfoFetch      = "oidc.userinfo_fetch"
	SpanNameTokenIntrospection = "oidc.token_introspection"
	SpanNameSessionValidation  = "oidc.session_validation"
	SpanNameAuthorizationCheck = "oidc.authorization_check"
	SpanNameProviderRedirect   = "oidc.provider_redirect"
)

// Helper functions that work with both implementations

// StringAttribute creates a string attribute
func StringAttribute(key string, value string) attribute {
	return attribute{Key: key, Value: value}
}

// BoolAttribute creates a bool attribute
func BoolAttribute(key string, value bool) attribute {
	return attribute{Key: key, Value: value}
}

// IntAttribute creates an int attribute
func IntAttribute(key string, value int) attribute {
	return attribute{Key: key, Value: value}
}

// SetProviderInfo adds provider information to the span
func SetProviderInfo(span Span, providerURL, clientID string, scopes []string) {
	if span == nil || !span.IsRecording() {
		return
	}
	span.SetAttributes(
		StringAttribute(AttrOIDCProvider, providerURL),
		StringAttribute(AttrOIDCClientID, clientID),
		StringAttribute(AttrOIDCScopes, joinScopes(scopes)),
	)
}

// SetUserInfo adds user information to the span
func SetUserInfo(span Span, userID, email string) {
	if span == nil || !span.IsRecording() {
		return
	}
	span.SetAttributes(
		StringAttribute(AttrOIDCUserID, userID),
		StringAttribute(AttrOIDCUserEmail, email),
	)
}

// SetAuthResult adds authentication result to the span
func SetAuthResult(span Span, result, reason string) {
	if span == nil || !span.IsRecording() {
		return
	}
	span.SetAttributes(
		StringAttribute(AttrOIDCAuthResult, result),
		StringAttribute(AttrOIDCAuthReason, reason),
	)
}

// RecordError records an error on the span
func RecordError(span Span, err error, description string) {
	if span == nil || err == nil {
		return
	}
	span.RecordError(err, description)
}

// HasTraceContext checks if the request has trace context headers
func HasTraceContext(req *http.Request) bool {
	return req.Header.Get("traceparent") != "" || req.Header.Get("tracestate") != ""
}

func joinScopes(scopes []string) string {
	result := ""
	for i, scope := range scopes {
		if i > 0 {
			result += " "
		}
		result += scope
	}
	return result
}
