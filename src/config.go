package src

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"text/template"

	"github.com/sevensolutions/traefik-oidc-auth/src/errorPages"
	"github.com/sevensolutions/traefik-oidc-auth/src/logging"
	"github.com/sevensolutions/traefik-oidc-auth/src/metrics"
	"github.com/sevensolutions/traefik-oidc-auth/src/rules"
	"github.com/sevensolutions/traefik-oidc-auth/src/session"
	"github.com/sevensolutions/traefik-oidc-auth/src/utils"
)

const DefaultSecret = "MLFs4TT99kOOq8h3UAVRtYoCTDYXiRcZ"

type Config struct {
	LogLevel string `json:"log_level" default:"warn"`

	Secret string `json:"secret" default:"MLFs4TT99kOOq8h3UAVRtYoCTDYXiRcZ"`

	Provider *ProviderConfig `json:"provider"`
	Scopes   []string        `json:"scopes" default:"[\"openid\", \"profile\", \"email\"]"`

	// Can be a relative path or a full URL.
	// If a relative path is used, the scheme and domain will be taken from the incoming request.
	// In this case, the callback path will overlay all hostnames behind the middleware.
	// If a full URL is used, all callbacks are sent there.  It is the user's responsibility to ensure
	// that the callback URL is also routed to this middleware plugin.
	CallbackUri string `json:"callback_uri" default:"/oidc/callback"`

	// The URL used to start authorization when needed.
	// All other requests that are not already authorized will return a 401 Unauthorized.
	// When left empty, all requests can start authorization.
	LoginUri                    string   `json:"login_uri" default:"/oidc/login"`
	PostLoginRedirectUri        string   `json:"post_login_redirect_uri" default:"/"`
	ValidPostLoginRedirectUris  []string `json:"valid_post_login_redirect_uris" default:"[\"/\"]"`
	LogoutUri                   string   `json:"logout_uri" default:"/logout"`
	PostLogoutRedirectUri       string   `json:"post_logout_redirect_uri" default:"/"`
	ValidPostLogoutRedirectUris []string `json:"valid_post_logout_redirect_uris" default:"[\"/\"]"`

	CookieNamePrefix     string                     `json:"cookie_name_prefix" default:"TraefikOidcAuth"`
	SessionCookie        *SessionCookieConfig       `json:"session_cookie"`
	AuthorizationHeader  *AuthorizationHeaderConfig `json:"authorization_header"`
	AuthorizationCookie  *AuthorizationCookieConfig `json:"authorization_cookie"`
	UnauthorizedBehavior string                     `json:"unauthorized_behavior" default:"Challenge"`

	Authorization *AuthorizationConfig `json:"authorization"`

	Headers []HeaderConfig `json:"headers"`

	BypassAuthenticationRule string `json:"bypass_authentication_rule"`

	// JavaScriptRequestDetection allows configuring how to detect JavaScript/AJAX requests
	JavaScriptRequestDetection *JavaScriptRequestDetectionConfig `json:"javascript_request_detection"`

	// JavaScriptRequestDetection allows configuring how to detect JavaScript/AJAX requests
	JavaScriptRequestDetection *JavaScriptRequestDetectionConfig `json:"javascript_request_detection"`

	// Metrics configuration
	Metrics *MetricsConfig `json:"metrics"`

	// Tracing configuration
	Tracing *TracingConfig `json:"tracing"`

	ErrorPages *errorPages.ErrorPagesConfig `json:"error_pages"`
}

type ProviderConfig struct {
	Url string `json:"url"`

	InsecureSkipVerify     string `json:"insecure_skip_verify"`
	InsecureSkipVerifyBool bool   `json:"insecure_skip_verify_bool" default:"false"`

	CABundle     string `json:"ca_bundle"`
	CABundleFile string `json:"ca_bundle_file"`

	ClientId     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`

	UsePkce     string `json:"use_pkce"`
	UsePkceBool bool   `json:"use_pkce_bool" default:"false"`

	ValidateAudience     string `json:"validate_audience"`
	ValidateAudienceBool bool   `json:"validate_audience_bool" default:"true"`
	ValidAudience        string `json:"valid_audience"`

	ValidateIssuer     string `json:"validate_issuer"`
	ValidateIssuerBool bool   `json:"validate_issuer_bool" default:"true"`
	ValidIssuer        string `json:"valid_issuer"`

	// AccessToken or IdToken or Introspection
	TokenValidation string `json:"verification_token"`

	DisableTokenValidation     string `json:"disable_token_validation"`
	DisableTokenValidationBool bool   `json:"disable_token_validation_bool"`
}

type SessionCookieConfig struct {
	Path     string `json:"path" default:"/"`
	Domain   string `json:"domain" default:""`
	Secure   bool   `json:"secure" default:"true"`
	HttpOnly bool   `json:"http_only" default:"true"`
	SameSite string `json:"same_site" default:"default"`
	MaxAge   int    `json:"max_age" default:"0"`
}

type AuthorizationHeaderConfig struct {
	Name string `json:"name"`
}
type AuthorizationCookieConfig struct {
	Name string `json:"name"`
}

type AuthorizationConfig struct {
	AssertClaims []ClaimAssertion `json:"assert_claims"`
}

type ClaimAssertion struct {
	Name  string   `json:"name"`
	AnyOf []string `json:"anyOf"`
	AllOf []string `json:"allOf"`
}

type HeaderConfig struct {
	Name  string `json:"name"`
	Value string `json:"value"`

	// A reference to the parsed Value-template
	template *template.Template
}

type JavaScriptRequestDetectionConfig struct {
	// Headers to check for JavaScript/AJAX request detection
	// Each header can have a list of values to match against
	Headers map[string][]string `json:"headers" default:"{\"X-Requested-With\":[\"XMLHttpRequest\"],\"Sec-Fetch-Mode\":[\"cors\",\"same-origin\"],\"Content-Type\":[\"application/json\"]}"`
}

type JavaScriptRequestDetectionConfig struct {
	// Headers to check for JavaScript/AJAX request detection
	// Each header can have a list of values to match against
	Headers map[string][]string `json:"headers" default:"{\"X-Requested-With\":[\"XMLHttpRequest\"],\"Sec-Fetch-Mode\":[\"cors\",\"same-origin\"],\"Content-Type\":[\"application/json\"]}"`
}

type MetricsConfig struct {
	// Enable metrics collection
	Enabled bool `json:"enabled" default:"false"`
	// Prefix for metric names
	Prefix string `json:"prefix" default:"traefik_oidc_auth"`
	// Path to expose metrics endpoint (only for standalone mode)
	Path string `json:"path" default:"/metrics"`
}

type TracingConfig struct {
	// Enable tracing - automatically enabled if trace headers are detected
	Enabled     string `json:"enabled" default:"auto"`
	EnabledBool bool   `json:"enabled_bool"`
	// Service name for traces
	ServiceName string `json:"service_name" default:"traefik-oidc-auth"`
	// Sample rate (0.0 to 1.0)
	SampleRate float64 `json:"sample_rate" default:"1.0"`
	// OTLP endpoint for standalone mode
	OtlpEndpoint string `json:"otlp_endpoint" default:""`
	// OTLP headers for authentication
	OtlpHeaders map[string]string `json:"otlp_headers"`
	// Enable detailed span attributes (may contain sensitive data)
	DetailedSpans bool `json:"detailed_spans" default:"false"`
}

// Will be called by traefik
func CreateConfig() *Config {
	return &Config{
		LogLevel: logging.LevelWarn,
		Secret:   DefaultSecret,
		Provider: &ProviderConfig{
			InsecureSkipVerifyBool: false,
			UsePkceBool:            false,
			ValidateAudienceBool:   true,
			ValidateIssuerBool:     true,
		},
		CallbackUri:           "/oidc/callback",
		LoginUri:              "/oidc/login",
		PostLoginRedirectUri:  "/",
		LogoutUri:            "/logout",
		PostLogoutRedirectUri: "/",
		CookieNamePrefix:      "TraefikOidcAuth",
		UnauthorizedBehavior:  "Challenge",
		SessionCookie: &SessionCookieConfig{
			Path:     "/",
			Domain:   "",
			Secure:   true,
			HttpOnly: true,
			SameSite: "default",
			MaxAge:   0,
		},
		AuthorizationHeader: &AuthorizationHeaderConfig{},
		AuthorizationCookie: &AuthorizationCookieConfig{},
		Authorization:       &AuthorizationConfig{},
		JavaScriptRequestDetection: &JavaScriptRequestDetectionConfig{
			Headers: map[string][]string{
				"X-Requested-With": {"XMLHttpRequest"},
				"Sec-Fetch-Mode":   {"cors", "same-origin"},
				"Content-Type":     {"application/json"},
			},
		},
		Metrics: &MetricsConfig{
			Enabled: false,
			Prefix:  "traefik_oidc_auth",
			Path:    "/metrics",
		},
		Tracing: &TracingConfig{
			Enabled:       "auto",
			ServiceName:   "traefik-oidc-auth",
			SampleRate:    1.0,
			DetailedSpans: false,
		},
		ErrorPages: &errorPages.ErrorPagesConfig{
			Unauthenticated: &errorPages.ErrorPageConfig{},
			Unauthorized:    &errorPages.ErrorPageConfig{},
		},
	}
}

// Will be called by traefik
func New(uctx context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	config.LogLevel = utils.ExpandEnvironmentVariableString(config.LogLevel)

	logger := logging.CreateLogger(config.LogLevel)

	logger.Log(logging.LevelInfo, "Loading Configuration...")

	if config.Provider == nil {
		return nil, errors.New("missing provider configuration")
	}

	// Hack: Trick the traefik plugin catalog to successfully execute this method with the testData from .traefik.yml.
	if config.Provider.Url == "https://..." {
		return &TraefikOidcAuth{
			next: next,
		}, nil
	}

	var err error

	config.Secret = utils.ExpandEnvironmentVariableString(config.Secret)
	config.CallbackUri = utils.ExpandEnvironmentVariableString(config.CallbackUri)
	config.LoginUri = utils.ExpandEnvironmentVariableString(config.LoginUri)
	config.PostLoginRedirectUri = utils.ExpandEnvironmentVariableString(config.PostLoginRedirectUri)
	config.LogoutUri = utils.ExpandEnvironmentVariableString(config.LogoutUri)
	config.PostLogoutRedirectUri = utils.ExpandEnvironmentVariableString(config.PostLogoutRedirectUri)
	config.CookieNamePrefix = utils.ExpandEnvironmentVariableString(config.CookieNamePrefix)
	config.UnauthorizedBehavior = utils.ExpandEnvironmentVariableString(config.UnauthorizedBehavior)
	config.BypassAuthenticationRule = utils.ExpandEnvironmentVariableString(config.BypassAuthenticationRule)
	config.Provider.Url = utils.ExpandEnvironmentVariableString(config.Provider.Url)
	config.Provider.ClientId = utils.ExpandEnvironmentVariableString(config.Provider.ClientId)
	config.Provider.ClientSecret = utils.ExpandEnvironmentVariableString(config.Provider.ClientSecret)
	config.Provider.UsePkceBool, err = utils.ExpandEnvironmentVariableBoolean(config.Provider.UsePkce, config.Provider.UsePkceBool)
	if err != nil {
		return nil, err
	}
	config.Provider.ValidateIssuerBool, err = utils.ExpandEnvironmentVariableBoolean(config.Provider.ValidateIssuer, config.Provider.ValidateIssuerBool)
	if err != nil {
		return nil, err
	}
	config.Provider.ValidIssuer = utils.ExpandEnvironmentVariableString(config.Provider.ValidIssuer)
	config.Provider.ValidateAudienceBool, err = utils.ExpandEnvironmentVariableBoolean(config.Provider.ValidateAudience, config.Provider.ValidateAudienceBool)
	if err != nil {
		return nil, err
	}
	config.Provider.ValidAudience = utils.ExpandEnvironmentVariableString(config.Provider.ValidAudience)
	config.Provider.InsecureSkipVerifyBool, err = utils.ExpandEnvironmentVariableBoolean(config.Provider.InsecureSkipVerify, config.Provider.InsecureSkipVerifyBool)
	if err != nil {
		return nil, err
	}

	config.Provider.CABundle = utils.ExpandEnvironmentVariableString(config.Provider.CABundle)
	config.Provider.CABundleFile = utils.ExpandEnvironmentVariableString(config.Provider.CABundleFile)
	config.Provider.TokenValidation = utils.ExpandEnvironmentVariableString(config.Provider.TokenValidation)
	config.Provider.DisableTokenValidationBool, err = utils.ExpandEnvironmentVariableBoolean(config.Provider.DisableTokenValidation, config.Provider.DisableTokenValidationBool)
	if err != nil {
		return nil, err
	}

	config.ErrorPages.Unauthenticated.FilePath = utils.ExpandEnvironmentVariableString(config.ErrorPages.Unauthenticated.FilePath)
	config.ErrorPages.Unauthenticated.RedirectTo = utils.ExpandEnvironmentVariableString(config.ErrorPages.Unauthenticated.RedirectTo)
	config.ErrorPages.Unauthorized.FilePath = utils.ExpandEnvironmentVariableString(config.ErrorPages.Unauthorized.FilePath)
	config.ErrorPages.Unauthorized.RedirectTo = utils.ExpandEnvironmentVariableString(config.ErrorPages.Unauthorized.RedirectTo)

	if config.Secret == DefaultSecret {
		logger.Log(logging.LevelWarn, "You're using the default secret! It is highly recommended to change the secret by specifying a random 32 character value using the Secret-option.")
	}

	secret := []byte(config.Secret)
	if len(secret) != 32 {
		logger.Log(logging.LevelError, "Invalid secret provided. Secret must be exactly 32 characters in length. The provided secret has %d characters.", len(secret))
		return nil, errors.New("invalid secret")
	}

	if config.Provider.CABundle != "" && config.Provider.CABundleFile != "" {
		logger.Log(logging.LevelError, "You can only use an inline CABundle OR CABundleFile, not both.")
		return nil, errors.New("you can only use an inline CABundle OR CABundleFile, not both.")
	}

	// Specify default scopes if not provided
	if config.Scopes == nil || len(config.Scopes) == 0 {
		config.Scopes = []string{"openid", "profile", "email"}
	}

	parsedURL, err := utils.ParseUrl(config.Provider.Url)
	if err != nil {
		logger.Log(logging.LevelError, "Error while parsing Provider.Url: %s", err.Error())
		return nil, err
	}

	parsedCallbackURL, err := url.Parse(config.CallbackUri)
	if err != nil {
		logger.Log(logging.LevelError, "Error while parsing CallbackUri: %s", err.Error())
		return nil, err
	}

	if config.Provider.TokenValidation == "" {
		// For EntraID, we cannot validate the access token using JWKS, so we fall back to the id token by default
		if strings.HasPrefix(config.Provider.Url, "https://login.microsoftonline.com") {
			config.Provider.TokenValidation = "IdToken"
		} else {
			config.Provider.TokenValidation = "AccessToken"
		}
	}

	logger.Log(logging.LevelInfo, "Provider Url: %v", parsedURL)
	logger.Log(logging.LevelInfo, "I will use this URL for callbacks from the IDP: %v", parsedCallbackURL)
	if utils.UrlIsAbsolute(parsedCallbackURL) {
		logger.Log(logging.LevelInfo, "Callback URL is absolute, will not overlay wrapped services")
	} else {
		logger.Log(logging.LevelInfo, "Callback URL is relative, will overlay any wrapped host")
	}
	logger.Log(logging.LevelDebug, "Scopes: %s", strings.Join(config.Scopes, ", "))
	logger.Log(logging.LevelDebug, "SessionCookie: %v", config.SessionCookie)

	var conditionalAuth *rules.RequestCondition
	if config.BypassAuthenticationRule != "" {
		ca, err := rules.ParseRequestCondition(config.BypassAuthenticationRule)

		if err != nil {
			return nil, err
		}

		conditionalAuth = ca
	}

	rootCAs, _ := x509.SystemCertPool()
	if rootCAs == nil {
		rootCAs = x509.NewCertPool()
	}

	var caBundleData []byte

	if config.Provider.CABundle != "" {
		if strings.HasPrefix(config.Provider.CABundle, "base64:") {
			caBundleData, err = base64.StdEncoding.DecodeString(strings.TrimPrefix(config.Provider.CABundle, "base64:"))
			if err != nil {
				logger.Log(logging.LevelInfo, "Failed to base64-decode the inline CA bundle")
				return nil, err
			}
		} else {
			caBundleData = []byte(config.Provider.CABundle)
		}

		logger.Log(logging.LevelDebug, "Loaded CA bundle provided inline")
	} else if config.Provider.CABundleFile != "" {
		caBundleData, err = os.ReadFile(config.Provider.CABundleFile)
		if err != nil {
			logger.Log(logging.LevelInfo, "Failed to load CA bundle from %v: %v", config.Provider.CABundleFile, err)
			return nil, err
		}

		logger.Log(logging.LevelDebug, "Loaded CA bundle from %v", config.Provider.CABundleFile)
	}

	if caBundleData != nil {
		// Append our cert to the system pool
		if ok := rootCAs.AppendCertsFromPEM(caBundleData); !ok {
			logger.Log(logging.LevelWarn, "Failed to append CA bundle. Using system certificates only.")
		}

	}

	httpTransport := &http.Transport{
		// MaxIdleConns:    10,
		// IdleConnTimeout: 30 * time.Second,
		Proxy: http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: config.Provider.InsecureSkipVerifyBool,
			RootCAs:            rootCAs,
		},
	}

	httpClient := &http.Client{
		Transport: httpTransport,
	}

	logger.Log(logging.LevelInfo, "Configuration loaded successfully, starting OIDC Auth middleware...")

	// Initialize metrics if enabled
	var metricsCollector *metrics.MetricsCollector
	if config.Metrics != nil && config.Metrics.Enabled {
		metricsCollector = metrics.NewMetricsCollector()
		logger.Log(logging.LevelInfo, "Metrics collection enabled with prefix: %s", config.Metrics.Prefix)
	}

	return &TraefikOidcAuth{
		logger:                   logger,
		next:                     next,
		httpClient:               httpClient,
		ProviderURL:              parsedURL,
		CallbackURL:              parsedCallbackURL,
		Config:                   config,
		SessionStorage:           session.CreateCookieSessionStorage(),
		BypassAuthenticationRule: conditionalAuth,
		Metrics:                  metricsCollector,
	}, nil
}
