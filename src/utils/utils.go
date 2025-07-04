package utils

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Expands the environment variable if it is enclosed in ${}. If the variable is not present, the original value is returned.
func ExpandEnvironmentVariableString(value string) string {
	after, hasPrefix := strings.CutPrefix(value, "${")

	if hasPrefix {
		variableName, hasSuffix := strings.CutSuffix(after, "}")

		if hasSuffix {
			variableValue, isDefined := os.LookupEnv(variableName)

			if isDefined {
				return variableValue
			}
		}
	}

	return value
}

func ExpandEnvironmentVariableBoolean(value string, defaultValue bool) (bool, error) {
	after, hasPrefix := strings.CutPrefix(value, "${")

	if hasPrefix {
		variableName, hasSuffix := strings.CutSuffix(after, "}")

		if hasSuffix {
			variableValue, isDefined := os.LookupEnv(variableName)

			if isDefined {
				value = variableValue
			}
		}
	}

	if value == "true" || value == "1" {
		return true, nil
	} else if value == "false" || value == "0" {
		return false, nil
	} else if value != "" {
		return false, errors.New(fmt.Sprintf("Invalid boolean value \"%s\". Boolean values must be true/false or 1/0.", value))
	}

	return defaultValue, nil
}

// ParseBool parses a string value to boolean
func ParseBool(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return value == "true" || value == "1" || value == "yes" || value == "on"
}

func UrlIsAbsolute(u *url.URL) bool {
	return u.Scheme != "" && u.Host != ""
}

func ParseUrl(rawUrl string) (*url.URL, error) {
	if rawUrl == "" {
		return nil, errors.New("invalid empty url")
	}
	if !strings.Contains(rawUrl, "://") {
		rawUrl = "https://" + rawUrl
	}
	u, err := url.Parse(rawUrl)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(u.Scheme, "http") {
		return nil, fmt.Errorf("%v is not a valid scheme", u.Scheme)
	}
	return u, nil
}

func getSchemeFromRequest(req *http.Request) string {
	scheme := req.Header.Get("X-Forwarded-Proto")
	if scheme == "" {
		if req.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	return scheme
}

func FillHostSchemeFromRequest(req *http.Request, u *url.URL) *url.URL {
	scheme := getSchemeFromRequest(req)
	host := req.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = req.Host
	}
	u.Scheme = scheme
	u.Host = host
	return u
}

func GetFullHost(req *http.Request) string {
	scheme := getSchemeFromRequest(req)
	host := req.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = req.Host
	}

	return fmt.Sprintf("%s://%s", scheme, host)
}

func EnsureAbsoluteUrl(req *http.Request, url string) string {
	if strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://") {
		return url
	} else {
		host := GetFullHost(req)

		if !strings.HasPrefix(url, "/") {
			url = "/" + url
		}

		return host + url
	}
}

func ParseBigInt(s string) (*big.Int, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)

	if err != nil {
		return nil, err
	}

	return big.NewInt(0).SetBytes(b), nil
}

func ParseInt(s string) (int, error) {
	v, err := ParseBigInt(s)

	if err != nil {
		return -1, err
	}

	return int(v.Int64()), nil
}

func Encrypt(plaintext string, secret string) (string, error) {
	aesCipher, err := aes.NewCipher([]byte(secret))
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(aesCipher)
	if err != nil {
		return "", err
	}

	// We need a 12-byte nonce for GCM (modifiable if you use cipher.NewGCMWithNonceSize())
	// A nonce should always be randomly generated for every encryption.
	nonce := make([]byte, gcm.NonceSize())
	_, err = rand.Read(nonce)
	if err != nil {
		return "", err
	}

	// ciphertext here is actually nonce+ciphertext
	// So that when we decrypt, just knowing the nonce size
	// is enough to separate it from the ciphertext.
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)

	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func Decrypt(ciphertext string, secret string) (string, error) {
	if ciphertext == "" {
		return "", errors.New("ciphertext must not be an empty string")
	}

	cipherbytes, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}

	ciphertext = string(cipherbytes)

	aesCipher, err := aes.NewCipher([]byte(secret))
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(aesCipher)
	if err != nil {
		return "", err
	}

	// Since we know the ciphertext is actually nonce+ciphertext
	// And len(nonce) == NonceSize(). We can separate the two.
	nonceSize := gcm.NonceSize()
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]

	plaintext, err := gcm.Open(nil, []byte(nonce), []byte(ciphertext), nil)
	if err != nil {
		return "", err
	}

	return string(plaintext), nil
}

func ChunkString(input string, chunkSize int) []string {
	var chunks []string

	for i := 0; i < len(input); i += chunkSize {
		end := i + chunkSize
		if end > len(input) {
			end = len(input)
		}
		chunks = append(chunks, input[i:end])
	}

	return chunks
}

func ValidateRedirectUri(redirectUri string, validUris []string) (string, error) {
	if redirectUri == "" {
		return "", nil
	}

	if validUris != nil && len(validUris) > 0 {
		for _, validUri := range validUris {
			if matchUriTemplate(redirectUri, validUri) {
				return redirectUri, nil
			}
		}
	}

	return "", errors.New("invalid redirect uri")
}

func matchUriTemplate(value string, template string) bool {
	// Match exactly
	if value == template {
		return true
	}

	// Match all
	if template == "*" {
		return true
	}

	// Match wildcards
	escapedTemplate := regexp.QuoteMeta(template)
	escapedTemplate = strings.ReplaceAll(escapedTemplate, "\\*", "[a-zA-Z0-9-_]+")
	escapedTemplate = fmt.Sprintf("^%s$", escapedTemplate)

	regex, err := regexp.Compile(escapedTemplate)
	if err != nil {
		return false
	}

	result := regex.MatchString(value)

	return result
}

// IsXHRRequest checks if the request is an XMLHttpRequest/AJAX request
func IsXHRRequest(req *http.Request) bool {
	// Legacy behavior for backward compatibility
	return IsXHRRequestWithHeaders(req, nil)
}

// IsXHRRequestWithHeaders checks if the request is an XMLHttpRequest/AJAX request using configurable headers
func IsXHRRequestWithHeaders(req *http.Request, headers map[string][]string) bool {
	// If no custom headers configured, use legacy behavior
	if headers == nil || len(headers) == 0 {
		// Check X-Requested-With header (common for AJAX requests)
		if req.Header.Get("X-Requested-With") == "XMLHttpRequest" {
			return true
		}

		// Check Accept header for JSON preference
		accept := req.Header.Get("Accept")

		// If the Accept header contains JSON
		if strings.Contains(accept, "application/json") {
			// But also contains HTML, it's not an XHR request (browser wants both)
			if strings.Contains(accept, "text/html") {
				return false
			}
			// Only JSON, no HTML - it's an XHR request
			return true
		}

		return false
	}

	// Check configured headers
	for headerName, validValues := range headers {
		headerValue := req.Header.Get(headerName)
		if headerValue == "" {
			continue
		}

		// Special handling for Accept header - check if HTML is also requested
		if strings.EqualFold(headerName, "Accept") && strings.Contains(headerValue, "text/html") {
			continue
		}

		// Check if header value matches any of the configured values
		for _, validValue := range validValues {
			if strings.Contains(strings.ToLower(headerValue), strings.ToLower(validValue)) {
				return true
			}
		}
	}

	return false
}
