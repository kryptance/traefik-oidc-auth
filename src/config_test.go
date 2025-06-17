package src

import (
	"context"
	"net/http"
	"testing"

	"github.com/sevensolutions/traefik-oidc-auth/src/logging"
)

func TestConfigDefaults(t *testing.T) {
	config := CreateConfig()

	// Test basic config defaults
	if config.LogLevel != logging.LevelWarn {
		t.Errorf("Expected LogLevel to be %s, got %s", logging.LevelWarn, config.LogLevel)
	}
	if config.Secret != DefaultSecret {
		t.Errorf("Expected Secret to be %s, got %s", DefaultSecret, config.Secret)
	}
	if config.CallbackUri != "/oidc/callback" {
		t.Errorf("Expected CallbackUri to be /oidc/callback, got %s", config.CallbackUri)
	}
	if config.LoginUri != "/oidc/login" {
		t.Errorf("Expected LoginUri to be /oidc/login, got %s", config.LoginUri)
	}
	if config.PostLoginRedirectUri != "/" {
		t.Errorf("Expected PostLoginRedirectUri to be /, got %s", config.PostLoginRedirectUri)
	}
	if config.LogoutUri != "/logout" {
		t.Errorf("Expected LogoutUri to be /logout, got %s", config.LogoutUri)
	}
	if config.PostLogoutRedirectUri != "/" {
		t.Errorf("Expected PostLogoutRedirectUri to be /, got %s", config.PostLogoutRedirectUri)
	}
	if config.CookieNamePrefix != "TraefikOidcAuth" {
		t.Errorf("Expected CookieNamePrefix to be TraefikOidcAuth, got %s", config.CookieNamePrefix)
	}
	if config.UnauthorizedBehavior != "Challenge" {
		t.Errorf("Expected UnauthorizedBehavior to be Challenge, got %s", config.UnauthorizedBehavior)
	}

	// Test Provider config defaults
	if config.Provider == nil {
		t.Error("Expected Provider to be initialized")
	} else {
		if config.Provider.InsecureSkipVerifyBool != false {
			t.Error("Expected Provider.InsecureSkipVerifyBool to be false")
		}
		if config.Provider.UsePkceBool != false {
			t.Error("Expected Provider.UsePkceBool to be false")
		}
		if config.Provider.ValidateAudienceBool != true {
			t.Error("Expected Provider.ValidateAudienceBool to be true")
		}
		if config.Provider.ValidateIssuerBool != true {
			t.Error("Expected Provider.ValidateIssuerBool to be true")
		}
	}

	// Test SessionCookie config defaults
	if config.SessionCookie == nil {
		t.Error("Expected SessionCookie to be initialized")
	} else {
		if config.SessionCookie.Path != "/" {
			t.Errorf("Expected SessionCookie.Path to be /, got %s", config.SessionCookie.Path)
		}
		if config.SessionCookie.Domain != "" {
			t.Errorf("Expected SessionCookie.Domain to be empty, got %s", config.SessionCookie.Domain)
		}
		if !config.SessionCookie.Secure {
			t.Error("Expected SessionCookie.Secure to be true")
		}
		if !config.SessionCookie.HttpOnly {
			t.Error("Expected SessionCookie.HttpOnly to be true")
		}
		if config.SessionCookie.SameSite != "default" {
			t.Errorf("Expected SessionCookie.SameSite to be default, got %s", config.SessionCookie.SameSite)
		}
		if config.SessionCookie.MaxAge != 0 {
			t.Errorf("Expected SessionCookie.MaxAge to be 0, got %d", config.SessionCookie.MaxAge)
		}
	}

	// Test AuthorizationHeader config defaults
	if config.AuthorizationHeader == nil {
		t.Error("Expected AuthorizationHeader to be initialized")
	}

	// Test AuthorizationCookie config defaults
	if config.AuthorizationCookie == nil {
		t.Error("Expected AuthorizationCookie to be initialized")
	}

	// Test Authorization config defaults
	if config.Authorization == nil {
		t.Error("Expected Authorization to be initialized")
	}

	// Test JavaScriptRequestDetection config defaults
	if config.JavaScriptRequestDetection == nil {
		t.Error("Expected JavaScriptRequestDetection to be initialized")
	} else {
		if config.JavaScriptRequestDetection.Headers == nil {
			t.Error("Expected JavaScriptRequestDetection.Headers to be initialized")
		} else {
			// Check default headers
			expectedHeaders := map[string][]string{
				"X-Requested-With": {"XMLHttpRequest"},
				"Sec-Fetch-Mode":   {"cors", "same-origin"},
				"Content-Type":     {"application/json"},
			}
			for header, values := range expectedHeaders {
				actualValues, exists := config.JavaScriptRequestDetection.Headers[header]
				if !exists {
					t.Errorf("Expected header %s to exist in JavaScriptRequestDetection.Headers", header)
					continue
				}
				if len(actualValues) != len(values) {
					t.Errorf("Expected header %s to have %d values, got %d", header, len(values), len(actualValues))
					continue
				}
				for i, value := range values {
					if actualValues[i] != value {
						t.Errorf("Expected header %s value at index %d to be %s, got %s", header, i, value, actualValues[i])
					}
				}
			}
		}
	}

	// Test ErrorPages config defaults
	if config.ErrorPages == nil {
		t.Error("Expected ErrorPages to be initialized")
	} else {
		if config.ErrorPages.Unauthenticated == nil {
			t.Error("Expected ErrorPages.Unauthenticated to be initialized")
		}
		if config.ErrorPages.Unauthorized == nil {
			t.Error("Expected ErrorPages.Unauthorized to be initialized")
		}
	}
}

func TestConfigDefaultScopes(t *testing.T) {
	config := CreateConfig()
	config.Provider.Url = "http://example.com"
	New(context.Background(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), config, "test")

	// Test default scopes
	expectedScopes := []string{"openid", "profile", "email"}
	if len(config.Scopes) != len(expectedScopes) {
		t.Errorf("Expected %d scopes, got %d", len(expectedScopes), len(config.Scopes))
	} else {
		for i, scope := range expectedScopes {
			if config.Scopes[i] != scope {
				t.Errorf("Expected scope at index %d to be %s, got %s", i, scope, config.Scopes[i])
			}
		}
	}
}

func TestConfigValidation(t *testing.T) {
	config := CreateConfig()
	config.Secret = "too-short" // Should be exactly 32 characters

	_, err := New(context.Background(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), config, "test")
	if err == nil || err.Error() != "invalid secret" {
		t.Error("Expected error for invalid secret length")
	}

	// Test CA bundle validation
	config = CreateConfig()
	config.Secret = DefaultSecret
	config.Provider.CABundle = "some-bundle"
	config.Provider.CABundleFile = "some-file"
	config.Provider.Url = "http://example.com" // Set a valid URL to avoid the empty URL error

	_, err = New(context.Background(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}), config, "test")
	expectedError := "you can only use an inline CABundle OR CABundleFile, not both."
	if err == nil || err.Error() != expectedError {
		t.Errorf("Expected error '%s', got '%v'", expectedError, err)
	}
} 