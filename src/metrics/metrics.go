package metrics

import (
	"sync"
	"time"
)

// MetricsCollector collects metrics for the OIDC middleware
type MetricsCollector struct {
	mu sync.RWMutex

	// Request metrics
	RequestsTotal           int64
	RequestsAuthenticated   int64
	RequestsUnauthenticated int64
	RequestsUnauthorized    int64
	RequestsBypassed        int64

	// Authentication metrics
	LoginAttempts         int64
	LoginSuccesses        int64
	LoginFailures         int64
	LogoutRequests        int64
	TokenValidations      int64
	TokenValidationErrors int64

	// Session metrics
	ActiveSessions    int64
	SessionsCreated   int64
	SessionsDestroyed int64
	SessionRefreshes  int64

	// OIDC provider metrics
	ProviderRequests  int64
	ProviderErrors    int64
	ProviderLatencyMs []int64
	JwksRefreshes     int64

	// Error metrics
	ErrorsTotal         int64
	ErrorsConfiguration int64
	ErrorsProvider      int64
	ErrorsInternal      int64

	// Latency metrics (in milliseconds)
	RequestLatencyMs []int64
	AuthLatencyMs    []int64
}

// NewMetricsCollector creates a new metrics collector
func NewMetricsCollector() *MetricsCollector {
	return &MetricsCollector{
		ProviderLatencyMs: make([]int64, 0, 1000),
		RequestLatencyMs:  make([]int64, 0, 1000),
		AuthLatencyMs:     make([]int64, 0, 1000),
	}
}

// RecordRequest records a request
func (m *MetricsCollector) RecordRequest() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.RequestsTotal++
}

// RecordAuthenticatedRequest records an authenticated request
func (m *MetricsCollector) RecordAuthenticatedRequest() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.RequestsAuthenticated++
}

// RecordUnauthenticatedRequest records an unauthenticated request
func (m *MetricsCollector) RecordUnauthenticatedRequest() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.RequestsUnauthenticated++
}

// RecordUnauthorizedRequest records an unauthorized request
func (m *MetricsCollector) RecordUnauthorizedRequest() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.RequestsUnauthorized++
}

// RecordBypassedRequest records a bypassed request
func (m *MetricsCollector) RecordBypassedRequest() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.RequestsBypassed++
}

// RecordLoginAttempt records a login attempt
func (m *MetricsCollector) RecordLoginAttempt(success bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.LoginAttempts++
	if success {
		m.LoginSuccesses++
	} else {
		m.LoginFailures++
	}
}

// RecordLogout records a logout request
func (m *MetricsCollector) RecordLogout() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.LogoutRequests++
}

// RecordTokenValidation records a token validation
func (m *MetricsCollector) RecordTokenValidation(success bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.TokenValidations++
	if !success {
		m.TokenValidationErrors++
	}
}

// RecordSessionCreated records a session creation
func (m *MetricsCollector) RecordSessionCreated() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.SessionsCreated++
	m.ActiveSessions++
}

// RecordSessionDestroyed records a session destruction
func (m *MetricsCollector) RecordSessionDestroyed() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.SessionsDestroyed++
	if m.ActiveSessions > 0 {
		m.ActiveSessions--
	}
}

// RecordSessionRefresh records a session refresh
func (m *MetricsCollector) RecordSessionRefresh() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.SessionRefreshes++
}

// RecordProviderRequest records a request to the OIDC provider
func (m *MetricsCollector) RecordProviderRequest(latencyMs int64, success bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ProviderRequests++
	if !success {
		m.ProviderErrors++
	}
	// Keep only last 1000 latency measurements to avoid memory growth
	if len(m.ProviderLatencyMs) >= 1000 {
		m.ProviderLatencyMs = m.ProviderLatencyMs[1:]
	}
	m.ProviderLatencyMs = append(m.ProviderLatencyMs, latencyMs)
}

// RecordJwksRefresh records a JWKS refresh
func (m *MetricsCollector) RecordJwksRefresh() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.JwksRefreshes++
}

// RecordError records an error
func (m *MetricsCollector) RecordError(errorType string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ErrorsTotal++
	switch errorType {
	case "configuration":
		m.ErrorsConfiguration++
	case "provider":
		m.ErrorsProvider++
	case "internal":
		m.ErrorsInternal++
	}
}

// RecordRequestLatency records request latency
func (m *MetricsCollector) RecordRequestLatency(start time.Time) {
	latencyMs := time.Since(start).Milliseconds()
	m.mu.Lock()
	defer m.mu.Unlock()
	// Keep only last 1000 latency measurements to avoid memory growth
	if len(m.RequestLatencyMs) >= 1000 {
		m.RequestLatencyMs = m.RequestLatencyMs[1:]
	}
	m.RequestLatencyMs = append(m.RequestLatencyMs, latencyMs)
}

// RecordAuthLatency records authentication latency
func (m *MetricsCollector) RecordAuthLatency(start time.Time) {
	latencyMs := time.Since(start).Milliseconds()
	m.mu.Lock()
	defer m.mu.Unlock()
	// Keep only last 1000 latency measurements to avoid memory growth
	if len(m.AuthLatencyMs) >= 1000 {
		m.AuthLatencyMs = m.AuthLatencyMs[1:]
	}
	m.AuthLatencyMs = append(m.AuthLatencyMs, latencyMs)
}

// GetSnapshot returns a snapshot of current metrics
func (m *MetricsCollector) GetSnapshot() MetricsSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()

	snapshot := MetricsSnapshot{
		RequestsTotal:           m.RequestsTotal,
		RequestsAuthenticated:   m.RequestsAuthenticated,
		RequestsUnauthenticated: m.RequestsUnauthenticated,
		RequestsUnauthorized:    m.RequestsUnauthorized,
		RequestsBypassed:        m.RequestsBypassed,
		LoginAttempts:           m.LoginAttempts,
		LoginSuccesses:          m.LoginSuccesses,
		LoginFailures:           m.LoginFailures,
		LogoutRequests:          m.LogoutRequests,
		TokenValidations:        m.TokenValidations,
		TokenValidationErrors:   m.TokenValidationErrors,
		ActiveSessions:          m.ActiveSessions,
		SessionsCreated:         m.SessionsCreated,
		SessionsDestroyed:       m.SessionsDestroyed,
		SessionRefreshes:        m.SessionRefreshes,
		ProviderRequests:        m.ProviderRequests,
		ProviderErrors:          m.ProviderErrors,
		JwksRefreshes:           m.JwksRefreshes,
		ErrorsTotal:             m.ErrorsTotal,
		ErrorsConfiguration:     m.ErrorsConfiguration,
		ErrorsProvider:          m.ErrorsProvider,
		ErrorsInternal:          m.ErrorsInternal,
	}

	// Calculate latency percentiles
	if len(m.RequestLatencyMs) > 0 {
		snapshot.RequestLatencyP50 = calculatePercentile(m.RequestLatencyMs, 50)
		snapshot.RequestLatencyP95 = calculatePercentile(m.RequestLatencyMs, 95)
		snapshot.RequestLatencyP99 = calculatePercentile(m.RequestLatencyMs, 99)
	}

	if len(m.AuthLatencyMs) > 0 {
		snapshot.AuthLatencyP50 = calculatePercentile(m.AuthLatencyMs, 50)
		snapshot.AuthLatencyP95 = calculatePercentile(m.AuthLatencyMs, 95)
		snapshot.AuthLatencyP99 = calculatePercentile(m.AuthLatencyMs, 99)
	}

	if len(m.ProviderLatencyMs) > 0 {
		snapshot.ProviderLatencyP50 = calculatePercentile(m.ProviderLatencyMs, 50)
		snapshot.ProviderLatencyP95 = calculatePercentile(m.ProviderLatencyMs, 95)
		snapshot.ProviderLatencyP99 = calculatePercentile(m.ProviderLatencyMs, 99)
	}

	return snapshot
}

// MetricsSnapshot represents a point-in-time snapshot of metrics
type MetricsSnapshot struct {
	// Request metrics
	RequestsTotal           int64 `json:"requests_total"`
	RequestsAuthenticated   int64 `json:"requests_authenticated"`
	RequestsUnauthenticated int64 `json:"requests_unauthenticated"`
	RequestsUnauthorized    int64 `json:"requests_unauthorized"`
	RequestsBypassed        int64 `json:"requests_bypassed"`

	// Authentication metrics
	LoginAttempts         int64 `json:"login_attempts"`
	LoginSuccesses        int64 `json:"login_successes"`
	LoginFailures         int64 `json:"login_failures"`
	LogoutRequests        int64 `json:"logout_requests"`
	TokenValidations      int64 `json:"token_validations"`
	TokenValidationErrors int64 `json:"token_validation_errors"`

	// Session metrics
	ActiveSessions    int64 `json:"active_sessions"`
	SessionsCreated   int64 `json:"sessions_created"`
	SessionsDestroyed int64 `json:"sessions_destroyed"`
	SessionRefreshes  int64 `json:"session_refreshes"`

	// OIDC provider metrics
	ProviderRequests   int64 `json:"provider_requests"`
	ProviderErrors     int64 `json:"provider_errors"`
	ProviderLatencyP50 int64 `json:"provider_latency_p50_ms"`
	ProviderLatencyP95 int64 `json:"provider_latency_p95_ms"`
	ProviderLatencyP99 int64 `json:"provider_latency_p99_ms"`
	JwksRefreshes      int64 `json:"jwks_refreshes"`

	// Error metrics
	ErrorsTotal         int64 `json:"errors_total"`
	ErrorsConfiguration int64 `json:"errors_configuration"`
	ErrorsProvider      int64 `json:"errors_provider"`
	ErrorsInternal      int64 `json:"errors_internal"`

	// Latency metrics (in milliseconds)
	RequestLatencyP50 int64 `json:"request_latency_p50_ms"`
	RequestLatencyP95 int64 `json:"request_latency_p95_ms"`
	RequestLatencyP99 int64 `json:"request_latency_p99_ms"`
	AuthLatencyP50    int64 `json:"auth_latency_p50_ms"`
	AuthLatencyP95    int64 `json:"auth_latency_p95_ms"`
	AuthLatencyP99    int64 `json:"auth_latency_p99_ms"`
}

// calculatePercentile calculates the percentile value from a slice of int64
func calculatePercentile(values []int64, percentile float64) int64 {
	if len(values) == 0 {
		return 0
	}

	// Create a copy to avoid modifying the original
	sorted := make([]int64, len(values))
	copy(sorted, values)

	// Simple bubble sort for small datasets
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[i] > sorted[j] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}

	index := int(float64(len(sorted)-1) * percentile / 100.0)
	return sorted[index]
}
