package metrics

import (
	"fmt"
	"io"
	"strings"
)

// PrometheusExporter exports metrics in Prometheus format
type PrometheusExporter struct {
	collector *MetricsCollector
	prefix    string
}

// NewPrometheusExporter creates a new Prometheus exporter
func NewPrometheusExporter(collector *MetricsCollector, prefix string) *PrometheusExporter {
	if prefix == "" {
		prefix = "traefik_oidc_auth"
	}
	return &PrometheusExporter{
		collector: collector,
		prefix:    prefix,
	}
}

// Export writes metrics in Prometheus format to the writer
func (e *PrometheusExporter) Export(w io.Writer) error {
	snapshot := e.collector.GetSnapshot()
	var sb strings.Builder

	// Request metrics
	e.writeMetric(&sb, "requests_total", "Total number of requests", "counter", snapshot.RequestsTotal)
	e.writeMetric(&sb, "requests_authenticated_total", "Total number of authenticated requests", "counter", snapshot.RequestsAuthenticated)
	e.writeMetric(&sb, "requests_unauthenticated_total", "Total number of unauthenticated requests", "counter", snapshot.RequestsUnauthenticated)
	e.writeMetric(&sb, "requests_unauthorized_total", "Total number of unauthorized requests", "counter", snapshot.RequestsUnauthorized)
	e.writeMetric(&sb, "requests_bypassed_total", "Total number of bypassed requests", "counter", snapshot.RequestsBypassed)

	// Authentication metrics
	e.writeMetric(&sb, "login_attempts_total", "Total number of login attempts", "counter", snapshot.LoginAttempts)
	e.writeMetric(&sb, "login_successes_total", "Total number of successful logins", "counter", snapshot.LoginSuccesses)
	e.writeMetric(&sb, "login_failures_total", "Total number of failed logins", "counter", snapshot.LoginFailures)
	e.writeMetric(&sb, "logout_requests_total", "Total number of logout requests", "counter", snapshot.LogoutRequests)
	e.writeMetric(&sb, "token_validations_total", "Total number of token validations", "counter", snapshot.TokenValidations)
	e.writeMetric(&sb, "token_validation_errors_total", "Total number of token validation errors", "counter", snapshot.TokenValidationErrors)

	// Session metrics
	e.writeMetric(&sb, "active_sessions", "Number of active sessions", "gauge", snapshot.ActiveSessions)
	e.writeMetric(&sb, "sessions_created_total", "Total number of sessions created", "counter", snapshot.SessionsCreated)
	e.writeMetric(&sb, "sessions_destroyed_total", "Total number of sessions destroyed", "counter", snapshot.SessionsDestroyed)
	e.writeMetric(&sb, "session_refreshes_total", "Total number of session refreshes", "counter", snapshot.SessionRefreshes)

	// OIDC provider metrics
	e.writeMetric(&sb, "provider_requests_total", "Total number of requests to OIDC provider", "counter", snapshot.ProviderRequests)
	e.writeMetric(&sb, "provider_errors_total", "Total number of OIDC provider errors", "counter", snapshot.ProviderErrors)
	e.writeMetric(&sb, "jwks_refreshes_total", "Total number of JWKS refreshes", "counter", snapshot.JwksRefreshes)

	// Error metrics
	e.writeMetric(&sb, "errors_total", "Total number of errors", "counter", snapshot.ErrorsTotal)
	e.writeMetric(&sb, "errors_configuration_total", "Total number of configuration errors", "counter", snapshot.ErrorsConfiguration)
	e.writeMetric(&sb, "errors_provider_total", "Total number of provider errors", "counter", snapshot.ErrorsProvider)
	e.writeMetric(&sb, "errors_internal_total", "Total number of internal errors", "counter", snapshot.ErrorsInternal)

	// Latency metrics
	if snapshot.RequestLatencyP50 > 0 {
		e.writeHistogramMetric(&sb, "request_duration_milliseconds", "Request duration in milliseconds",
			snapshot.RequestLatencyP50, snapshot.RequestLatencyP95, snapshot.RequestLatencyP99)
	}
	if snapshot.AuthLatencyP50 > 0 {
		e.writeHistogramMetric(&sb, "auth_duration_milliseconds", "Authentication duration in milliseconds",
			snapshot.AuthLatencyP50, snapshot.AuthLatencyP95, snapshot.AuthLatencyP99)
	}
	if snapshot.ProviderLatencyP50 > 0 {
		e.writeHistogramMetric(&sb, "provider_duration_milliseconds", "OIDC provider request duration in milliseconds",
			snapshot.ProviderLatencyP50, snapshot.ProviderLatencyP95, snapshot.ProviderLatencyP99)
	}

	_, err := w.Write([]byte(sb.String()))
	return err
}

func (e *PrometheusExporter) writeMetric(sb *strings.Builder, name, help, metricType string, value int64) {
	fullName := fmt.Sprintf("%s_%s", e.prefix, name)
	sb.WriteString(fmt.Sprintf("# HELP %s %s\n", fullName, help))
	sb.WriteString(fmt.Sprintf("# TYPE %s %s\n", fullName, metricType))
	sb.WriteString(fmt.Sprintf("%s %d\n", fullName, value))
}

func (e *PrometheusExporter) writeHistogramMetric(sb *strings.Builder, name, help string, p50, p95, p99 int64) {
	fullName := fmt.Sprintf("%s_%s", e.prefix, name)
	sb.WriteString(fmt.Sprintf("# HELP %s %s\n", fullName, help))
	sb.WriteString(fmt.Sprintf("# TYPE %s summary\n", fullName))
	sb.WriteString(fmt.Sprintf("%s{quantile=\"0.5\"} %d\n", fullName, p50))
	sb.WriteString(fmt.Sprintf("%s{quantile=\"0.95\"} %d\n", fullName, p95))
	sb.WriteString(fmt.Sprintf("%s{quantile=\"0.99\"} %d\n", fullName, p99))
}
