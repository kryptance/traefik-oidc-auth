package tracing

import (
	"context"
	"fmt"
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const (
	// TracerName is the name of the tracer
	TracerName = "github.com/sevensolutions/traefik-oidc-auth"

	// Span names
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

	// Attribute keys
	AttrOIDCProvider           = attribute.Key("oidc.provider")
	AttrOIDCClientID           = attribute.Key("oidc.client_id")
	AttrOIDCScopes             = attribute.Key("oidc.scopes")
	AttrOIDCTokenType          = attribute.Key("oidc.token_type")
	AttrOIDCTokenValidation    = attribute.Key("oidc.token_validation_method")
	AttrOIDCSessionID          = attribute.Key("oidc.session_id")
	AttrOIDCUserID             = attribute.Key("oidc.user_id")
	AttrOIDCUserEmail          = attribute.Key("oidc.user_email")
	AttrOIDCAuthResult         = attribute.Key("oidc.auth_result")
	AttrOIDCAuthReason         = attribute.Key("oidc.auth_reason")
	AttrOIDCBypassRule         = attribute.Key("oidc.bypass_rule")
	AttrOIDCJSRequest          = attribute.Key("oidc.js_request")
	AttrOIDCErrorType          = attribute.Key("oidc.error_type")
	AttrOIDCDiscoveryEndpoint  = attribute.Key("oidc.discovery_endpoint")
	AttrOIDCTokenEndpoint      = attribute.Key("oidc.token_endpoint")
	AttrOIDCJWKSEndpoint       = attribute.Key("oidc.jwks_endpoint")
	AttrOIDCUserInfoEndpoint   = attribute.Key("oidc.userinfo_endpoint")
	AttrOIDCIntrospectEndpoint = attribute.Key("oidc.introspect_endpoint")
	AttrOIDCClaimAssertion     = attribute.Key("oidc.claim_assertion")
	AttrOIDCMetricsEnabled     = attribute.Key("oidc.metrics_enabled")
)

// Tracer provides OpenTelemetry tracing functionality
type Tracer struct {
	tracer     trace.Tracer
	propagator propagation.TextMapPropagator
	enabled    bool
}

// NewTracer creates a new tracer instance
func NewTracer(enabled bool) *Tracer {
	return &Tracer{
		tracer:     otel.Tracer(TracerName),
		propagator: otel.GetTextMapPropagator(),
		enabled:    enabled,
	}
}

// IsEnabled returns whether tracing is enabled
func (t *Tracer) IsEnabled() bool {
	return t != nil && t.enabled
}

// StartSpan starts a new span
func (t *Tracer) StartSpan(ctx context.Context, spanName string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	if !t.IsEnabled() {
		return ctx, trace.SpanFromContext(ctx)
	}
	return t.tracer.Start(ctx, spanName, opts...)
}

// StartSpanFromRequest starts a new span from an HTTP request
func (t *Tracer) StartSpanFromRequest(req *http.Request, spanName string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	if !t.IsEnabled() {
		return req.Context(), trace.SpanFromContext(req.Context())
	}

	// Extract trace context from incoming request
	ctx := t.propagator.Extract(req.Context(), propagation.HeaderCarrier(req.Header))

	// Start new span
	ctx, span := t.tracer.Start(ctx, spanName, opts...)

	// Add common HTTP attributes
	span.SetAttributes(
		attribute.String("http.method", req.Method),
		attribute.String("http.url", req.URL.String()),
		attribute.String("http.target", req.URL.Path),
		attribute.String("http.host", req.Host),
		attribute.String("http.scheme", req.URL.Scheme),
		attribute.String("http.user_agent", req.UserAgent()),
	)

	// Add X-Forwarded headers if present
	if fwdFor := req.Header.Get("X-Forwarded-For"); fwdFor != "" {
		span.SetAttributes(attribute.String("http.x_forwarded_for", fwdFor))
	}
	if fwdProto := req.Header.Get("X-Forwarded-Proto"); fwdProto != "" {
		span.SetAttributes(attribute.String("http.x_forwarded_proto", fwdProto))
	}

	return ctx, span
}

// InjectContext injects trace context into outgoing HTTP request
func (t *Tracer) InjectContext(ctx context.Context, req *http.Request) {
	if !t.IsEnabled() {
		return
	}
	t.propagator.Inject(ctx, propagation.HeaderCarrier(req.Header))
}

// RecordError records an error on the span
func RecordError(span trace.Span, err error, description string) {
	if span == nil || !span.IsRecording() {
		return
	}

	span.RecordError(err)
	span.SetStatus(codes.Error, description)
	span.SetAttributes(
		attribute.String("error.type", fmt.Sprintf("%T", err)),
		attribute.String("error.message", err.Error()),
	)
}

// SetAuthResult sets the authentication result on a span
func SetAuthResult(span trace.Span, result string, reason string) {
	if span == nil || !span.IsRecording() {
		return
	}

	span.SetAttributes(
		AttrOIDCAuthResult.String(result),
		AttrOIDCAuthReason.String(reason),
	)

	// Set span status based on result
	switch result {
	case "authenticated":
		span.SetStatus(codes.Ok, "User authenticated successfully")
	case "unauthenticated":
		span.SetStatus(codes.Error, reason)
	case "unauthorized":
		span.SetStatus(codes.Error, reason)
	case "bypassed":
		span.SetStatus(codes.Ok, "Authentication bypassed by rule")
	case "error":
		span.SetStatus(codes.Error, reason)
	}
}

// SetProviderInfo sets OIDC provider information on a span
func SetProviderInfo(span trace.Span, providerURL string, clientID string, scopes []string) {
	if span == nil || !span.IsRecording() {
		return
	}

	span.SetAttributes(
		AttrOIDCProvider.String(providerURL),
		AttrOIDCClientID.String(clientID),
		AttrOIDCScopes.StringSlice(scopes),
	)
}

// SetUserInfo sets user information on a span
func SetUserInfo(span trace.Span, userID string, email string) {
	if span == nil || !span.IsRecording() {
		return
	}

	if userID != "" {
		span.SetAttributes(AttrOIDCUserID.String(userID))
	}
	if email != "" {
		span.SetAttributes(AttrOIDCUserEmail.String(email))
	}
}

// SetTokenInfo sets token information on a span
func SetTokenInfo(span trace.Span, tokenType string, validationMethod string) {
	if span == nil || !span.IsRecording() {
		return
	}

	span.SetAttributes(
		AttrOIDCTokenType.String(tokenType),
		AttrOIDCTokenValidation.String(validationMethod),
	)
}

// ExtractTraceContext extracts trace context from HTTP headers
func (t *Tracer) ExtractTraceContext(req *http.Request) context.Context {
	if !t.IsEnabled() {
		return req.Context()
	}
	return t.propagator.Extract(req.Context(), propagation.HeaderCarrier(req.Header))
}

// HasTraceContext checks if the request has trace context headers
func HasTraceContext(req *http.Request) bool {
	// Check for common trace headers
	return req.Header.Get("traceparent") != "" ||
		req.Header.Get("X-B3-TraceId") != "" ||
		req.Header.Get("X-Trace-Id") != "" ||
		req.Header.Get("uber-trace-id") != ""
}
