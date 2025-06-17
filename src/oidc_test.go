package src

import (
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func TestParseTokenWithoutValidation(t *testing.T) {
	// Create a test token with some claims
	claims := jwt.MapClaims{
		"sub":   "1234567890",
		"name":  "John Doe",
		"email": "john@example.com",
		"exp":   1234567890, // Expired token
	}

	// Create a token with a fake secret (since we won't validate)
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, err := token.SignedString([]byte("fake-secret"))
	if err != nil {
		t.Fatalf("Failed to create test token: %v", err)
	}

	// Create a test instance
	toa := &TraefikOidcAuth{}

	// Parse the token without validation
	parsedClaims, err := toa.parseTokenWithoutValidation(tokenString)
	if err != nil {
		t.Fatalf("Failed to parse token without validation: %v", err)
	}

	// Verify the claims were extracted correctly
	if parsedClaims["sub"] != "1234567890" {
		t.Errorf("Expected sub claim to be '1234567890', got %v", parsedClaims["sub"])
	}
	if parsedClaims["name"] != "John Doe" {
		t.Errorf("Expected name claim to be 'John Doe', got %v", parsedClaims["name"])
	}
	if parsedClaims["email"] != "john@example.com" {
		t.Errorf("Expected email claim to be 'john@example.com', got %v", parsedClaims["email"])
	}
}

func TestParseTokenWithoutValidation_InvalidToken(t *testing.T) {
	// Create a test instance
	toa := &TraefikOidcAuth{}

	// Try to parse an invalid token
	_, err := toa.parseTokenWithoutValidation("invalid-token")
	if err == nil {
		t.Error("Expected error when parsing invalid token, got nil")
	}
}