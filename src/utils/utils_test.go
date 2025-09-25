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

func TestParseAcceptType(t *testing.T) {
	acceptType := ParseAcceptType("text/html")
	if acceptType.Type != "text/html" {
		t.Fail()
	}
	if acceptType.Weight != 1.0 {
		t.Fail()
	}

	acceptType = ParseAcceptType("text/html;q=0.8")
	if acceptType.Type != "text/html" {
		t.Fail()
	}
	if acceptType.Weight != 0.8 {
		t.Fail()
	}

	acceptType = ParseAcceptType("application/json; q=0.5")
	if acceptType.Type != "application/json" {
		t.Fail()
	}
	if acceptType.Weight != 0.5 {
		t.Fail()
	}

	acceptType = ParseAcceptType("text/html;q=invalid")
	if acceptType.Type != "" {
		t.Fail()
	}
	if acceptType.Weight != 0.0 {
		t.Fail()
	}

	acceptType = ParseAcceptType("*/*")
	if acceptType.Type != "*/*" {
		t.Fail()
	}
	if acceptType.Weight != 1.0 {
		t.Fail()
	}

	acceptType = ParseAcceptType("")
	if acceptType.Type != "" {
		t.Fail()
	}
	if acceptType.Weight != 0.0 {
		t.Fail()
	}
}

func TestParseAcceptHeader(t *testing.T) {
	acceptTypes := ParseAcceptHeader("text/html,application/json")
	if len(acceptTypes) != 2 {
		t.Fail()
	}
	if acceptTypes[0].Type != "text/html" {
		t.Fail()
	}
	if acceptTypes[0].Weight != 1.0 {
		t.Fail()
	}
	if acceptTypes[1].Type != "application/json" {
		t.Fail()
	}
	if acceptTypes[1].Weight != 1.0 {
		t.Fail()
	}

	acceptTypes = ParseAcceptHeader("application/json;q=0.8,text/html;q=0.9")
	if len(acceptTypes) != 2 {
		t.Fail()
	}
	if acceptTypes[0].Type != "text/html" {
		t.Fail()
	}
	if acceptTypes[0].Weight != 0.9 {
		t.Fail()
	}
	if acceptTypes[1].Type != "application/json" {
		t.Fail()
	}
	if acceptTypes[1].Weight != 0.8 {
		t.Fail()
	}

	acceptTypes = ParseAcceptHeader("*/*")
	if len(acceptTypes) != 1 {
		t.Fail()
	}
	if acceptTypes[0].Type != "*/*" {
		t.Fail()
	}
	if acceptTypes[0].Weight != 1.0 {
		t.Fail()
	}
}

func TestIsHtmlRequest(t *testing.T) {
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	if !IsHtmlRequest(req) {
		t.Fail()
	}

	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/json")
	if IsHtmlRequest(req) {
		t.Fail()
	}

	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "text/html, application/json")
	if !IsHtmlRequest(req) {
		t.Fail()
	}

	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/json;q=0.9, text/html;q=0.8")
	if IsHtmlRequest(req) {
		t.Fail()
	}

	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/json;q=0.8, text/html;q=0.9")
	if !IsHtmlRequest(req) {
		t.Fail()
	}

	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "*/*")
	if IsHtmlRequest(req) {
		t.Fail()
	}

	req, _ = http.NewRequest("GET", "/", nil)
	if IsHtmlRequest(req) {
		t.Fail()
	}
}

func TestIsXHRRequest(t *testing.T) {
	// Test legacy behavior with X-Requested-With header
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	if !IsXHRRequest(req) {
		t.Errorf("Expected XHR request with X-Requested-With header")
	}

	// Test legacy behavior with JSON accept header
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/json")
	if !IsXHRRequest(req) {
		t.Errorf("Expected XHR request with JSON accept header")
	}

	// Test legacy behavior with both JSON and HTML accept headers
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/json, text/html")
	if IsXHRRequest(req) {
		t.Errorf("Should not be XHR request when both JSON and HTML are accepted")
	}

	// Test no XHR indicators
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "text/html")
	if IsXHRRequest(req) {
		t.Errorf("Should not be XHR request with only HTML accept header")
	}
}

func TestIsXHRRequestWithHeaders(t *testing.T) {
	// Test with custom headers configuration
	customHeaders := map[string][]string{
		"X-Requested-With": {"XMLHttpRequest"},
		"Sec-Fetch-Mode":   {"cors", "same-origin"},
		"Content-Type":     {"application/json"},
	}

	// Test X-Requested-With detection
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	if !IsXHRRequestWithHeaders(req, customHeaders) {
		t.Errorf("Expected XHR request with X-Requested-With header")
	}

	// Test Sec-Fetch-Mode detection with "cors"
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Sec-Fetch-Mode", "cors")
	if !IsXHRRequestWithHeaders(req, customHeaders) {
		t.Errorf("Expected XHR request with Sec-Fetch-Mode: cors")
	}

	// Test Sec-Fetch-Mode detection with "same-origin"
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Sec-Fetch-Mode", "same-origin")
	if !IsXHRRequestWithHeaders(req, customHeaders) {
		t.Errorf("Expected XHR request with Sec-Fetch-Mode: same-origin")
	}

	// Test Content-Type detection
	req, _ = http.NewRequest("POST", "/", nil)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	if !IsXHRRequestWithHeaders(req, customHeaders) {
		t.Errorf("Expected XHR request with JSON Content-Type")
	}

	// Test case-insensitive matching
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("x-requested-with", "xmlhttprequest")
	if !IsXHRRequestWithHeaders(req, customHeaders) {
		t.Errorf("Expected XHR request with case-insensitive header matching")
	}

	// Test Accept header special case - should not detect as XHR if HTML is also requested
	customHeadersWithAccept := map[string][]string{
		"Accept": {"application/json"},
	}
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/json, text/html")
	if IsXHRRequestWithHeaders(req, customHeadersWithAccept) {
		t.Errorf("Should not detect as XHR when Accept includes both JSON and HTML")
	}

	// Test Accept header - should detect as XHR if only JSON
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/json")
	if !IsXHRRequestWithHeaders(req, customHeadersWithAccept) {
		t.Errorf("Expected XHR request with JSON-only Accept header")
	}

	// Test no matching headers
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "text/html")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	if IsXHRRequestWithHeaders(req, customHeaders) {
		t.Errorf("Should not detect as XHR with non-matching headers")
	}

	// Test nil headers (should use legacy behavior)
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	if !IsXHRRequestWithHeaders(req, nil) {
		t.Errorf("Expected XHR request with nil headers (legacy behavior)")
	}

	// Test empty headers map (should use legacy behavior)
	req, _ = http.NewRequest("GET", "/", nil)
	req.Header.Set("Accept", "application/json")
	if !IsXHRRequestWithHeaders(req, map[string][]string{}) {
		t.Errorf("Expected XHR request with empty headers map (legacy behavior)")
	}
}
