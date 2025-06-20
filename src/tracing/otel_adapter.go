//go:build !yaegi && tracing
// +build !yaegi,tracing

package tracing

import (
	"context"
	"fmt"
	"net/http"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// OtelSpan wraps an OpenTelemetry span to implement our Span interface
type OtelSpan struct {
	span trace.Span
}

// End ends the span
func (s *OtelSpan) End() {
	if s.span != nil {
		s.span.End()
	}
}

// SetAttributes sets attributes on the span
func (s *OtelSpan) SetAttributes(kv ...attribute) {
	if s.span == nil || !s.span.IsRecording() {
		return
	}

	// Convert our attributes to OpenTelemetry attributes
	otelAttrs := make([]attribute.KeyValue, len(kv))
	for i, attr := range kv {
		switch v := attr.Value.(type) {
		case string:
			otelAttrs[i] = attribute.String(attr.Key, v)
		case bool:
			otelAttrs[i] = attribute.Bool(attr.Key, v)
		case int:
			otelAttrs[i] = attribute.Int(attr.Key, v)
		case int64:
			otelAttrs[i] = attribute.Int64(attr.Key, v)
		case float64:
			otelAttrs[i] = attribute.Float64(attr.Key, v)
		case []string:
			otelAttrs[i] = attribute.StringSlice(attr.Key, v)
		default:
			otelAttrs[i] = attribute.String(attr.Key, fmt.Sprintf("%v", v))
		}
	}

	s.span.SetAttributes(otelAttrs...)
}

// IsRecording returns whether the span is recording
func (s *OtelSpan) IsRecording() bool {
	return s.span != nil && s.span.IsRecording()
}

// RecordError records an error
func (s *OtelSpan) RecordError(err error, description string) {
	if s.span == nil || !s.span.IsRecording() || err == nil {
		return
	}

	s.span.RecordError(err)
	s.span.SetStatus(codes.Error, description)
	s.span.SetAttributes(
		attribute.String("error.type", fmt.Sprintf("%T", err)),
		attribute.String("error.message", err.Error()),
	)
}

// OtelTracer wraps the real Tracer to implement our Tracer interface
type OtelTracer struct {
	*Tracer
}

// StartSpan starts a new span
func (t *OtelTracer) StartSpan(ctx context.Context, spanName string) (context.Context, Span) {
	newCtx, span := t.Tracer.StartSpan(ctx, spanName)
	return newCtx, &OtelSpan{span: span}
}

// StartSpanFromRequest starts a new span from an HTTP request
func (t *OtelTracer) StartSpanFromRequest(req *http.Request, spanName string) (context.Context, Span) {
	newCtx, span := t.Tracer.StartSpanFromRequest(req, spanName)
	return newCtx, &OtelSpan{span: span}
}

// NewTracerAdapter creates a new tracer that adapts to our interface
func NewTracerAdapter(config *Config) Tracer {
	tracer := NewTracer(config)
	if tracer == nil {
		return &StubTracer{}
	}
	return &OtelTracer{Tracer: tracer}
}
