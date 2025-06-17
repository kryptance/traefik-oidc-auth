package src

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"text/template"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/sevensolutions/traefik-oidc-auth/src/errorPages"
	"github.com/sevensolutions/traefik-oidc-auth/src/rules"

	"github.com/sevensolutions/traefik-oidc-auth/src/logging"
	"github.com/sevensolutions/traefik-oidc-auth/src/metrics"
	"github.com/sevensolutions/traefik-oidc-auth/src/oidc"
	"github.com/sevensolutions/traefik-oidc-auth/src/session"
	"github.com/sevensolutions/traefik-oidc-auth/src/tracing"
	"github.com/sevensolutions/traefik-oidc-auth/src/utils"
)

type TraefikOidcAuth struct {
	logger                   *logging.Logger
	next                     http.Handler
	httpClient               *http.Client
	ProviderURL              *url.URL
	CallbackURL              *url.URL
	Config                   *Config
	SessionStorage           session.SessionStorage
	DiscoveryDocument        *oidc.OidcDiscovery
	Jwks                     *oidc.JwksHandler
	Lock                     sync.RWMutex
	BypassAuthenticationRule *rules.RequestCondition
	Metrics                  *metrics.MetricsCollector
	Tracer                   *tracing.Tracer
}

// Make sure we fetch oidc discovery document during first request - avoid race condition
// Perform lock when changing document - we are in concurrent environment
func (toa *TraefikOidcAuth) EnsureOidcDiscovery() error {
	return toa.EnsureOidcDiscoveryWithContext(context.Background())
}

func (toa *TraefikOidcAuth) EnsureOidcDiscoveryWithContext(ctx context.Context) error {
	var config = toa.Config
	var parsedURL = toa.ProviderURL
	if toa.DiscoveryDocument == nil {
		toa.Lock.Lock()
		defer toa.Lock.Unlock()
		// check again after lock
		if toa.DiscoveryDocument == nil {
			// Start discovery span
			var span trace.Span
			if toa.Tracer != nil {
				ctx, span = toa.Tracer.StartSpan(ctx, tracing.SpanNameOIDCDiscovery)
				defer span.End()
				span.SetAttributes(tracing.AttrOIDCDiscoveryEndpoint.String(parsedURL.String() + "/.well-known/openid-configuration"))
			}

			var jwks = &oidc.JwksHandler{}
			toa.Jwks = jwks
			toa.logger.Log(logging.LevelInfo, "Getting OIDC discovery document...")

			oidcDiscoveryDocument, err := GetOidcDiscoveryWithContext(ctx, toa.logger, toa.httpClient, parsedURL, toa.Tracer)
			if err != nil {
				toa.logger.Log(logging.LevelError, "Error while retrieving discovery document: %s", err.Error())
				if span != nil && span.IsRecording() {
					tracing.RecordError(span, err, "Failed to fetch OIDC discovery document")
				}
				return err
			}

			if span != nil && span.IsRecording() {
				span.SetAttributes(
					tracing.AttrOIDCTokenEndpoint.String(oidcDiscoveryDocument.TokenEndpoint),
					tracing.AttrOIDCJWKSEndpoint.String(oidcDiscoveryDocument.JWKSURI),
					tracing.AttrOIDCUserInfoEndpoint.String(oidcDiscoveryDocument.UserinfoEndpoint),
				)
			}

			// Apply defaults
			if config.Provider.ValidIssuer == "" {
				config.Provider.ValidIssuer = oidcDiscoveryDocument.Issuer
			}
			if config.Provider.ValidAudience == "" {
				config.Provider.ValidAudience = config.Provider.ClientId
			}

			toa.logger.Log(logging.LevelInfo, "OIDC Discovery successful. AuthEndPoint: %s", oidcDiscoveryDocument.AuthorizationEndpoint)

			toa.DiscoveryDocument = oidcDiscoveryDocument
			toa.Jwks.Url = oidcDiscoveryDocument.JWKSURI
		}
		return nil
	}

	return nil
}

func (toa *TraefikOidcAuth) GetAbsoluteCallbackURL(req *http.Request) *url.URL {
	if utils.UrlIsAbsolute(toa.CallbackURL) {
		return toa.CallbackURL
	} else {
		abs := *toa.CallbackURL
		utils.FillHostSchemeFromRequest(req, &abs)
		return &abs
	}
}

func (toa *TraefikOidcAuth) isCallbackRequest(req *http.Request) bool {
	u := req.URL
	utils.FillHostSchemeFromRequest(req, u)

	if u.Path != toa.CallbackURL.Path {
		return false
	}

	if utils.UrlIsAbsolute(toa.CallbackURL) {
		if u.Scheme != toa.CallbackURL.Scheme || u.Host != toa.CallbackURL.Host {
			return false
		}
	}

	return true
}

func (toa *TraefikOidcAuth) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	// Start metrics tracking
	start := time.Now()
	if toa.Metrics != nil {
		toa.Metrics.RecordRequest()
		defer toa.Metrics.RecordRequestLatency(start)
	}

	// Start tracing if enabled or trace headers present
	var ctx context.Context
	var span trace.Span
	if toa.Tracer != nil && (toa.Tracer.IsEnabled() || tracing.HasTraceContext(req)) {
		ctx, span = toa.Tracer.StartSpanFromRequest(req, tracing.SpanNameServeHTTP)
		defer span.End()

		// Add provider info
		tracing.SetProviderInfo(span, toa.ProviderURL.String(), toa.Config.Provider.ClientId, toa.Config.Scopes)

		// Add metrics status
		if toa.Metrics != nil {
			span.SetAttributes(tracing.AttrOIDCMetricsEnabled.Bool(true))
		}

		// Update request context
		req = req.WithContext(ctx)
	}

	if toa.BypassAuthenticationRule != nil {
		if toa.BypassAuthenticationRule.Match(toa.logger, req) {
			toa.logger.Log(logging.LevelDebug, "BypassAuthenticationRule matched. Forwarding request without authentication.")

			if toa.Metrics != nil {
				toa.Metrics.RecordBypassedRequest()
			}

			if span != nil && span.IsRecording() {
				span.SetAttributes(tracing.AttrOIDCBypassRule.String(toa.Config.BypassAuthenticationRule))
				tracing.SetAuthResult(span, "bypassed", "Authentication bypassed by rule")
			}

			// Forward the request
			toa.sanitizeForUpstream(req)
			toa.next.ServeHTTP(rw, req)
			return
		} else {
			toa.logger.Log(logging.LevelDebug, "BypassAuthenticationRule not matched. Requiring authentication.")
		}
	}

	err := toa.EnsureOidcDiscoveryWithContext(req.Context())

	if err != nil {
		toa.logger.Log(logging.LevelError, "Error getting oidc discovery: %s", err.Error())
		if span != nil && span.IsRecording() {
			tracing.RecordError(span, err, "Failed to ensure OIDC discovery")
			tracing.SetAuthResult(span, "error", "OIDC discovery failed")
		}
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}

	if toa.isCallbackRequest(req) {
		if toa.Tracer != nil {
			callbackCtx, callbackSpan := toa.Tracer.StartSpan(req.Context(), tracing.SpanNameHandleCallback)
			req = req.WithContext(callbackCtx)
			defer callbackSpan.End()
		}
		toa.handleCallback(rw, req)
		return
	}

	if toa.Config.LoginUri != "" && strings.HasPrefix(req.RequestURI, toa.Config.LoginUri) {
		toa.redirectToProvider(rw, req)
		return
	}

	// Start session validation span
	var sessionSpan trace.Span
	if toa.Tracer != nil {
		var sessionCtx context.Context
		sessionCtx, sessionSpan = toa.Tracer.StartSpan(req.Context(), tracing.SpanNameSessionValidation)
		req = req.WithContext(sessionCtx)
		defer sessionSpan.End()
	}

	session, updateSession, claims, err := toa.getSessionForRequest(req)

	if err == nil && session != nil {
		if sessionSpan != nil && sessionSpan.IsRecording() {
			sessionSpan.SetAttributes(tracing.AttrOIDCSessionID.String(session.Id))
			if toa.Config.Tracing.DetailedSpans && claims != nil {
				if sub, ok := claims["sub"].(string); ok {
					tracing.SetUserInfo(sessionSpan, sub, claims["email"].(string))
				}
			}
		}
		// Handle logout
		if strings.HasPrefix(req.RequestURI, toa.Config.LogoutUri) {
			if toa.Tracer != nil {
				logoutCtx, logoutSpan := toa.Tracer.StartSpan(req.Context(), tracing.SpanNameHandleLogout)
				req = req.WithContext(logoutCtx)
				defer logoutSpan.End()
			}
			toa.handleLogout(rw, req, session)
			return
		}

		// If this request is using external authentication by using a header or custom cookie,
		// we need to validate the authorization on every request.
		if session.Id == "AuthorizationHeader" || session.Id == "AuthorizationCookie" {
			if toa.Tracer != nil {
				_, authSpan := toa.Tracer.StartSpan(req.Context(), tracing.SpanNameAuthorizationCheck)
				defer authSpan.End()

				session.IsAuthorized = isAuthorized(toa.logger, toa.Config.Authorization, claims)

				if authSpan.IsRecording() {
					authSpan.SetAttributes(
						tracing.AttrOIDCTokenType.String(session.Id),
						attribute.Bool("authorized", session.IsAuthorized),
					)
				}
			} else {
				session.IsAuthorized = isAuthorized(toa.logger, toa.Config.Authorization, claims)
			}
		}

		// Ensure the session is authorized
		if !session.IsAuthorized {
			if toa.Metrics != nil {
				toa.Metrics.RecordUnauthorizedRequest()
			}
			if span != nil && span.IsRecording() {
				tracing.SetAuthResult(span, "unauthorized", "User not authorized to access resource")
			}
			toa.handleUnauthorized(rw, req)
			return
		}

		// Attach upstream headers
		err = toa.attachHeaders(req, session, claims)
		if err != nil {
			toa.logger.Log(logging.LevelError, "Error while attaching headers: %s", err.Error())
			if toa.Metrics != nil {
				toa.Metrics.RecordError("internal")
			}
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}

		if updateSession {
			if toa.Metrics != nil {
				toa.Metrics.RecordSessionRefresh()
			}
			toa.storeSessionAndAttachCookie(session, rw)
		}

		// Forward the request
		if toa.Metrics != nil {
			toa.Metrics.RecordAuthenticatedRequest()
		}
		if span != nil && span.IsRecording() {
			tracing.SetAuthResult(span, "authenticated", "User authenticated successfully")
		}
		toa.sanitizeForUpstream(req)
		toa.next.ServeHTTP(rw, req)
		return
	} else {
		toa.logger.Log(logging.LevelInfo, "Verifying token: %s", err.Error())
	}

	// Clear the session cookie
	clearChunkedCookie(toa.Config, rw, req, getSessionCookieName(toa.Config))

	if toa.Metrics != nil {
		toa.Metrics.RecordUnauthenticatedRequest()
	}
	if span != nil && span.IsRecording() {
		tracing.SetAuthResult(span, "unauthenticated", "No valid session found")
	}
	toa.handleUnauthenticated(rw, req)
}

func (toa *TraefikOidcAuth) sanitizeForUpstream(req *http.Request) {
	// Remove all internal cookies from the request before forwarding
	keepCookies := make([]*http.Cookie, 0)

	for _, c := range req.Cookies() {
		if !strings.HasPrefix(c.Name, toa.Config.CookieNamePrefix) {
			keepCookies = append(keepCookies, c)
		}
	}

	req.Header.Del("Cookie")

	for _, c := range keepCookies {
		req.AddCookie(c)
	}
}

func (toa *TraefikOidcAuth) attachHeaders(req *http.Request, session *session.SessionState, claims map[string]interface{}) error {
	if toa.Config.Headers != nil {
		evalContext := make(map[string]interface{})

		evalContext["claims"] = claims
		evalContext["accessToken"] = session.AccessToken
		evalContext["idToken"] = session.IdToken
		evalContext["refreshToken"] = session.RefreshToken

		for _, header := range toa.Config.Headers {
			if header.Value != "" {
				if header.template == nil {
					tpl, err := template.New("").Parse(header.Value)

					if err != nil {
						return err
					}

					header.template = tpl
				}

				var renderedValue bytes.Buffer
				err := header.template.Execute(&renderedValue, evalContext)

				if err == nil {
					req.Header.Set(header.Name, renderedValue.String())
				} else {
					req.Header.Set(header.Name, err.Error())
				}
			} else {
				req.Header.Set(header.Name, "")
			}
		}
	}

	return nil
}

func (toa *TraefikOidcAuth) handleCallback(rw http.ResponseWriter, req *http.Request) {
	base64State := req.URL.Query().Get("state")
	if base64State == "" {
		toa.logger.Log(logging.LevelWarn, "State on callback request is missing.")
		http.Error(rw, "State is missing", http.StatusInternalServerError)
		return
	}

	state, err := oidc.DecodeState(base64State)
	if err != nil {
		toa.logger.Log(logging.LevelWarn, "State on callback request is invalid.")
		http.Error(rw, "State is invalid", http.StatusInternalServerError)
		return
	}

	redirectUrl := state.RedirectUrl

	if state.Action == "Login" {
		authCode := req.URL.Query().Get("code")
		if authCode == "" {
			toa.logger.Log(logging.LevelWarn, "Code is missing.")
			http.Error(rw, "Code is missing", http.StatusInternalServerError)
			return
		}

		token, err := exchangeAuthCode(toa, req, authCode)
		if err != nil {
			toa.logger.Log(logging.LevelError, "Exchange Auth Code: %s", err.Error())
			http.Error(rw, "Failed to exchange auth code", http.StatusInternalServerError)
			return
		}

		usedToken := ""

		if toa.Config.Provider.TokenValidation == "AccessToken" {
			usedToken = token.AccessToken
		} else if toa.Config.Provider.TokenValidation == "IdToken" {
			usedToken = token.IdToken
		} else if toa.Config.Provider.TokenValidation == "Introspection" {
			usedToken = token.AccessToken
		} else {
			toa.logger.Log(logging.LevelError, "Invalid value '%s' for VerificationToken", toa.Config.Provider.TokenValidation)
			http.Error(rw, err.Error(), http.StatusInternalServerError)
		}

		redactedToken := usedToken
		if len(redactedToken) > 16 {
			redactedToken = redactedToken[0:16] + " *** REDACTED ***"
		}

		var claims map[string]interface{}

		if toa.Config.Provider.TokenValidation == "Introspection" {
			_, claims, err = toa.introspectTokenWithContext(req.Context(), usedToken)
		} else {
			_, claims, err = toa.validateTokenLocallyWithContext(req.Context(), usedToken)
		}

		if err != nil {
			toa.logger.Log(logging.LevelError, "Returned token is not valid: %s", err.Error())
			http.Error(rw, "Returned token is not valid", http.StatusInternalServerError)
			return
		}

		toa.logger.Log(logging.LevelInfo, "Exchange Auth Code completed. Token: %+v", redactedToken)

		isAuthorized := isAuthorized(toa.logger, toa.Config.Authorization, claims)

		session := &session.SessionState{
			Id:           session.GenerateSessionId(),
			AccessToken:  token.AccessToken,
			IdToken:      token.IdToken,
			RefreshToken: token.RefreshToken,
			IsAuthorized: isAuthorized,
		}

		toa.storeSessionAndAttachCookie(session, rw)

		http.SetCookie(rw, &http.Cookie{
			Name:     getCodeVerifierCookieName(toa.Config),
			Value:    "",
			Expires:  time.Now().Add(-24 * time.Hour),
			MaxAge:   -1,
			Secure:   true,
			HttpOnly: true,
			Path:     toa.CallbackURL.Path,
			Domain:   toa.CallbackURL.Host,
			SameSite: http.SameSiteDefaultMode,
		})

		if redirectUrl != "" {
			redirectUrl = utils.EnsureAbsoluteUrl(req, redirectUrl)
		} else {
			redirectUrl = utils.EnsureAbsoluteUrl(req, toa.Config.PostLoginRedirectUri)
		}

		if !isAuthorized {
			toa.handleUnauthorized(rw, req)
			return
		}

	} else if state.Action == "Logout" {
		toa.logger.Log(logging.LevelDebug, "Post logout. Clearing cookie.")

		// Clear the cookie
		clearChunkedCookie(toa.Config, rw, req, getSessionCookieName(toa.Config))
	}

	toa.logger.Log(logging.LevelInfo, "Redirecting to %s", redirectUrl)

	http.Redirect(rw, req, redirectUrl, http.StatusFound)
}

func (toa *TraefikOidcAuth) handleLogout(rw http.ResponseWriter, req *http.Request, session *session.SessionState) {
	toa.logger.Log(logging.LevelInfo, "Logging out...")

	if toa.Metrics != nil {
		toa.Metrics.RecordLogout()
		toa.Metrics.RecordSessionDestroyed()
	}

	// https://openid.net/specs/openid-connect-rpinitiated-1_0.html

	endSessionURL, err := url.Parse(toa.DiscoveryDocument.EndSessionEndpoint)
	if err != nil {
		toa.logger.Log(logging.LevelError, "Error while parsing the AuthorizationEndpoint: %s", err.Error())
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}

	callbackUri := toa.GetAbsoluteCallbackURL(req).String()
	redirectUri := utils.EnsureAbsoluteUrl(req, toa.Config.PostLogoutRedirectUri)

	redirectUriFromQuery := req.URL.Query().Get("redirect_uri")
	if redirectUriFromQuery == "" {
		redirectUriFromQuery = req.URL.Query().Get("post_logout_redirect_uri")
	}

	if redirectUriFromQuery != "" {
		redirectUriFromQuery, err = utils.ValidateRedirectUri(redirectUriFromQuery, toa.Config.ValidPostLogoutRedirectUris)
		if err != nil {
			toa.logger.Log(logging.LevelError, "%s", err.Error())
			http.Error(rw, err.Error(), http.StatusBadRequest)
			return
		}

		if redirectUriFromQuery != "" {
			redirectUri = utils.EnsureAbsoluteUrl(req, redirectUriFromQuery)
		}
	}

	state := &oidc.OidcState{
		Action:      "Logout",
		RedirectUrl: redirectUri,
	}

	base64State, err := oidc.EncodeState(state)
	if err != nil {
		toa.logger.Log(logging.LevelError, "Failed to serialize state: %s", err.Error())
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}

	endSessionURL.RawQuery = url.Values{
		"client_id":                {toa.Config.Provider.ClientId},
		"post_logout_redirect_uri": {callbackUri},
		"state":                    {base64State},
		"id_token_hint":            {session.IdToken},
	}.Encode()

	http.Redirect(rw, req, endSessionURL.String(), http.StatusFound)
}

func (toa *TraefikOidcAuth) handleUnauthenticated(rw http.ResponseWriter, req *http.Request) {
	// For XHR requests, always return JSON error instead of redirecting
	var jsHeaders map[string][]string
	if toa.Config.JavaScriptRequestDetection != nil {
		jsHeaders = toa.Config.JavaScriptRequestDetection.Headers
	}

	if utils.IsXHRRequestWithHeaders(req, jsHeaders) {
		data := make(map[string]interface{})
		data["statusType"] = "https://tools.ietf.org/html/rfc9110#section-15.5.2"
		data["statusCode"] = http.StatusUnauthorized
		data["statusName"] = "Unauthorized"
		data["description"] = "Session expired or not authenticated"

		// Add login and logout URLs for XHR requests
		data["loginUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LoginUri)
		data["logoutUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LogoutUri)

		errorPages.WriteError(toa.logger, toa.Config.ErrorPages.Unauthenticated, rw, req, data, jsHeaders)
		return
	}

	if toa.Config.UnauthorizedBehavior == "Challenge" {
		toa.redirectToProvider(rw, req)
	} else {
		data := make(map[string]interface{})

		data["statusType"] = "https://tools.ietf.org/html/rfc9110#section-15.5.2"
		data["statusCode"] = http.StatusUnauthorized
		data["statusName"] = "Unauthorized"
		data["description"] = "You're not authorized to access this resource. Please log in to continue."

		if toa.Config.LoginUri != "" {
			data["primaryButtonText"] = "Login"
			data["primaryButtonUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LoginUri)
			data["loginUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LoginUri)
		}
		if toa.Config.LogoutUri != "" {
			data["logoutUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LogoutUri)
		}

		var jsHeaders map[string][]string
		if toa.Config.JavaScriptRequestDetection != nil {
			jsHeaders = toa.Config.JavaScriptRequestDetection.Headers
		}
		errorPages.WriteError(toa.logger, toa.Config.ErrorPages.Unauthenticated, rw, req, data, jsHeaders)
	}
}

func (toa *TraefikOidcAuth) handleUnauthorized(rw http.ResponseWriter, req *http.Request) {
	data := make(map[string]interface{})

	data["statusType"] = "https://tools.ietf.org/html/rfc9110#section-15.5.4"
	data["statusCode"] = http.StatusForbidden
	data["statusName"] = "Forbidden"
	data["description"] = "It seems like your account is not allowed to access this resource.\nTry to log in using a different account or log out by using one of the options below."

	if toa.Config.LoginUri != "" {
		data["primaryButtonText"] = "Login with a different account"
		data["primaryButtonUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LoginUri) + "?prompt=login"
		data["loginUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LoginUri) + "?prompt=login"
	}

	data["secondaryButtonText"] = "Logout"
	data["secondaryButtonUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LogoutUri)
	data["logoutUrl"] = utils.EnsureAbsoluteUrl(req, toa.Config.LogoutUri)

	var jsHeaders map[string][]string
	if toa.Config.JavaScriptRequestDetection != nil {
		jsHeaders = toa.Config.JavaScriptRequestDetection.Headers
	}
	errorPages.WriteError(toa.logger, toa.Config.ErrorPages.Unauthorized, rw, req, data, jsHeaders)
}

func (toa *TraefikOidcAuth) redirectToProvider(rw http.ResponseWriter, req *http.Request) {
	toa.logger.Log(logging.LevelInfo, "Redirecting to OIDC provider...")

	var redirectUrl string

	// If the user specified one on the /login request, use this one
	redirectUriFromQuery, err := utils.ValidateRedirectUri(req.URL.Query().Get("redirect_uri"), toa.Config.ValidPostLoginRedirectUris)
	if err != nil {
		toa.logger.Log(logging.LevelError, "%s", err.Error())
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}

	if toa.Config.LoginUri != "" && strings.HasPrefix(req.RequestURI, toa.Config.LoginUri) && redirectUriFromQuery != "" {
		redirectUrl = redirectUriFromQuery
	} else if toa.Config.PostLoginRedirectUri != "" {
		redirectUrl = utils.EnsureAbsoluteUrl(req, toa.Config.PostLoginRedirectUri)
	} else {
		host := utils.GetFullHost(req)
		redirectUrl = fmt.Sprintf("%s%s", host, req.RequestURI)

		// Special case: If someone just calls /login but doesn't provide a redirect_uri, we go to / instead of /login again.
		if toa.Config.LoginUri != "" && strings.HasPrefix(req.RequestURI, toa.Config.LoginUri) {
			redirectUrl = host
		}
	}

	callbackUrl := toa.GetAbsoluteCallbackURL(req).String()

	state := oidc.OidcState{
		Action:      "Login",
		RedirectUrl: redirectUrl,
	}

	stateBytes, _ := json.Marshal(state)
	stateBase64 := base64.StdEncoding.EncodeToString(stateBytes)

	toa.logger.Log(logging.LevelDebug, "AuthorizationEndPoint: %s", toa.DiscoveryDocument.AuthorizationEndpoint)

	authorizationEndpointUrl, err := url.Parse(toa.DiscoveryDocument.AuthorizationEndpoint)
	if err != nil {
		toa.logger.Log(logging.LevelError, "Error while parsing the AuthorizationEndpoint: %s", err.Error())
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}

	urlValues := url.Values{
		"response_type": {"code"},
		"scope":         {strings.Join(toa.Config.Scopes, " ")},
		"client_id":     {toa.Config.Provider.ClientId},
		"redirect_uri":  {callbackUrl},
		"state":         {stateBase64},
	}

	if prompt := req.URL.Query().Get("prompt"); prompt != "" {
		urlValues.Add("prompt", prompt)
	}

	if toa.Config.Provider.UsePkceBool {
		codeVerifier, err := randomBytesInHex(32)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}

		sha2 := sha256.New()
		if _, writeErr := io.WriteString(sha2, codeVerifier); writeErr != nil {
			http.Error(rw, writeErr.Error(), http.StatusInternalServerError)
			return
		}
		codeChallenge := base64.RawURLEncoding.EncodeToString(sha2.Sum(nil))

		urlValues.Add("code_challenge_method", "S256")
		urlValues.Add("code_challenge", codeChallenge)

		encryptedCodeVerifier, err := utils.Encrypt(codeVerifier, toa.Config.Secret)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}

		// TODO: Make configurable
		// TODO does this need domain tweaks?  it is in the login flow
		http.SetCookie(rw, &http.Cookie{
			Name:     getCodeVerifierCookieName(toa.Config),
			Value:    encryptedCodeVerifier,
			Secure:   true,
			HttpOnly: true,
			Path:     toa.CallbackURL.Path,
			Domain:   toa.CallbackURL.Host,
			SameSite: http.SameSiteDefaultMode,
		})
	}

	authorizationEndpointUrl.RawQuery = urlValues.Encode()

	http.Redirect(rw, req, authorizationEndpointUrl.String(), http.StatusFound)
}
