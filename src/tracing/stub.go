//go:build yaegi || !tracing
// +build yaegi !tracing

package tracing

import (
	"context"
	"net/http"
)

// StubTracer is a no-op tracer implementation for Yaegi compatibility
type StubTracer struct{}

// NewTracer creates a new stub tracer (no-op implementation)
func NewTracer(config *Config) *StubTracer {
	return &StubTracer{}
}

// StartSpan starts a new span (no-op)
func (t *StubTracer) StartSpan(ctx context.Context, spanName string) (context.Context, Span) {
	return ctx, &StubSpan{}
}

// StartSpanFromRequest starts a new span from an HTTP request (no-op)
func (t *StubTracer) StartSpanFromRequest(req *http.Request, spanName string) (context.Context, Span) {
	return req.Context(), &StubSpan{}
}

// IsEnabled returns whether tracing is enabled
func (t *StubTracer) IsEnabled() bool {
	return false
}

// Shutdown shuts down the tracer (no-op)
func (t *StubTracer) Shutdown(ctx context.Context) error {
	return nil
}

// StubSpan is a no-op span implementation
type StubSpan struct{}

// End ends the span (no-op)
func (s *StubSpan) End() {}

// SetAttributes sets attributes on the span (no-op)
func (s *StubSpan) SetAttributes(kv ...attribute) {}

// IsRecording returns whether the span is recording
func (s *StubSpan) IsRecording() bool {
	return false
}

// RecordError records an error (no-op)
func (s *StubSpan) RecordError(err error, description string) {}

// Config represents the tracing configuration
type Config struct {
	Enabled       string
	ServiceName   string
	SampleRate    float64
	DetailedSpans bool
}

// Ensure StubTracer implements the Tracer interface
var _ Tracer = (*StubTracer)(nil)
