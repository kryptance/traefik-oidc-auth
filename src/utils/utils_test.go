package utils

import (
	"net/http"
	"testing"
)

func TestChunkString(t *testing.T) {
	originalText := "abcdefghijklmnopqrstuvwxyz"

	chunks := ChunkString(originalText, 10)

	if len(chunks) != 3 {
		t.Fail()
	}

	value := ""

	for i := 0; i < len(chunks); i++ {
		value += chunks[i]
	}

	if value != originalText {
		t.Fail()
	}
}

func TestEncryptDecryptRoundtrip(t *testing.T) {
	secret := "MLFs4TT99kOOq8h3UAVRtYoCTDYXiRcZ"
	originalText := "hello"

	encrypted, err := Encrypt(originalText, secret)
	if err != nil {
		t.Fail()
	}

	decrypted, err := Decrypt(encrypted, secret)
	if err != nil {
		t.Fail()
	}

	if decrypted != originalText {
		t.Fail()
	}
}

func TestDecryptEmptyString(t *testing.T) {
	secret := "MLFs4TT99kOOq8h3UAVRtYoCTDYXiRcZ"

	_, err := Decrypt("", secret)

	// Must return an error
	if err == nil {
		t.Fail()
	}
}

func TestValidateRedirectUri(t *testing.T) {
	validUris := []string{
		"/",
		"https://example.com",
		"https://something.com",
	}

	expectRedirectUriMatch(t, "https://example.com", validUris, true)
	expectRedirectUriMatch(t, "https://malicious.com", validUris, false)
}

func TestValidateRedirectUriWildcards(t *testing.T) {
	validUris := []string{
		"/",
		"https://example.com",
		"https://something.com",
		"*",
	}

	expectRedirectUriMatch(t, "https://malicious.com", validUris, true)

	validUris = []string{
		"https://example.com",
		"https://*.something.com",
		"https://*.something.com/good",
		"https://*.something.com/good/*",
	}

	expectRedirectUriMatch(t, "https://app.something.com", validUris, true)
	expectRedirectUriMatch(t, "https://app.sub.something.com", validUris, false)
	expectRedirectUriMatch(t, "https://app.something.com/login", validUris, false)
	expectRedirectUriMatch(t, "https://app.something.com/good", validUris, true)
	expectRedirectUriMatch(t, "https://app.something.com/good/something", validUris, true)
	expectRedirectUriMatch(t, "https://app.something.com/good/something/bad", validUris, false)
}

func expectRedirectUriMatch(t *testing.T, uri string, validUris []string, shouldMatch bool) {
	matchedUri, err := ValidateRedirectUri(uri, validUris)

	if (shouldMatch && err != nil) || (!shouldMatch && err == nil) {
		t.Fail()
	}

	if (shouldMatch && matchedUri != uri) || (!shouldMatch && matchedUri != "") {
		t.Fail()
	}
}

func TestIsXHRRequest(t *testing.T) {
	tests := []struct {
		name     string
		headers  map[string]string
		expected bool
	}{
		{
			name: "XMLHttpRequest header",
			headers: map[string]string{
				"X-Requested-With": "XMLHttpRequest",
			},
			expected: true,
		},
		{
			name: "Accept application/json only",
			headers: map[string]string{
				"Accept": "application/json",
			},
			expected: true,
		},
		{
			name: "Accept application/json with other types but not text/html",
			headers: map[string]string{
				"Accept": "application/json, text/plain, */*",
			},
			expected: true,
		},
		{
			name: "Accept application/json but also text/html",
			headers: map[string]string{
				"Accept": "application/json, text/html",
			},
			expected: false,
		},
		{
			name: "Regular browser request",
			headers: map[string]string{
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
			},
			expected: false,
		},
		{
			name:     "No relevant headers",
			headers:  map[string]string{},
			expected: false,
		},
		{
			name: "Case sensitive X-Requested-With",
			headers: map[string]string{
				"X-Requested-With": "xmlhttprequest",
			},
			expected: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/", nil)
			for key, value := range test.headers {
				req.Header.Set(key, value)
			}

			result := IsXHRRequest(req)
			if result != test.expected {
				t.Errorf("Expected IsXHRRequest to return %v, got %v for Accept header: %s", test.expected, result, req.Header.Get("Accept"))
			}
		})
	}
}

func TestIsXHRRequestWithHeaders(t *testing.T) {
	tests := []struct {
		name              string
		headers           map[string]string
		detectionHeaders  map[string][]string
		expected          bool
	}{
		{
			name: "XMLHttpRequest header with configured detection",
			headers: map[string]string{
				"X-Requested-With": "XMLHttpRequest",
			},
			detectionHeaders: map[string][]string{
				"X-Requested-With": {"XMLHttpRequest"},
			},
			expected: true,
		},
		{
			name: "Sec-Fetch-Mode cors header",
			headers: map[string]string{
				"Sec-Fetch-Mode": "cors",
			},
			detectionHeaders: map[string][]string{
				"Sec-Fetch-Mode": {"cors", "same-origin"},
			},
			expected: true,
		},
		{
			name: "Sec-Fetch-Mode same-origin header",
			headers: map[string]string{
				"Sec-Fetch-Mode": "same-origin",
			},
			detectionHeaders: map[string][]string{
				"Sec-Fetch-Mode": {"cors", "same-origin"},
			},
			expected: true,
		},
		{
			name: "Sec-Fetch-Mode navigate (not JS request)",
			headers: map[string]string{
				"Sec-Fetch-Mode": "navigate",
			},
			detectionHeaders: map[string][]string{
				"Sec-Fetch-Mode": {"cors", "same-origin"},
			},
			expected: false,
		},
		{
			name: "Content-Type application/json",
			headers: map[string]string{
				"Content-Type": "application/json",
			},
			detectionHeaders: map[string][]string{
				"Content-Type": {"application/json"},
			},
			expected: true,
		},
		{
			name: "Content-Type with charset",
			headers: map[string]string{
				"Content-Type": "application/json; charset=utf-8",
			},
			detectionHeaders: map[string][]string{
				"Content-Type": {"application/json"},
			},
			expected: true,
		},
		{
			name: "Multiple headers match (any matches)",
			headers: map[string]string{
				"Content-Type": "application/json",
				"Sec-Fetch-Mode": "navigate",
			},
			detectionHeaders: map[string][]string{
				"Content-Type": {"application/json"},
				"Sec-Fetch-Mode": {"cors", "same-origin"},
			},
			expected: true,
		},
		{
			name: "Case insensitive matching",
			headers: map[string]string{
				"content-type": "APPLICATION/JSON",
			},
			detectionHeaders: map[string][]string{
				"Content-Type": {"application/json"},
			},
			expected: true,
		},
		{
			name: "Accept header with HTML should not match",
			headers: map[string]string{
				"Accept": "application/json, text/html",
			},
			detectionHeaders: map[string][]string{
				"Accept": {"application/json"},
			},
			expected: false,
		},
		{
			name: "Nil detection headers falls back to legacy",
			headers: map[string]string{
				"X-Requested-With": "XMLHttpRequest",
			},
			detectionHeaders: nil,
			expected: true,
		},
		{
			name: "Empty detection headers falls back to legacy",
			headers: map[string]string{
				"Accept": "application/json",
			},
			detectionHeaders: map[string][]string{},
			expected: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/", nil)
			for key, value := range test.headers {
				req.Header.Set(key, value)
			}

			result := IsXHRRequestWithHeaders(req, test.detectionHeaders)
			if result != test.expected {
				t.Errorf("Expected IsXHRRequestWithHeaders to return %v, got %v", test.expected, result)
			}
		})
	}
}
