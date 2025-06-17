import { expect, test } from "@playwright/test";
import * as dockerCompose from "docker-compose";
import { configureTraefik } from "../../utils";

//-----------------------------------------------------------------------------
// Test Setup
//-----------------------------------------------------------------------------

test.use({
  ignoreHTTPSErrors: true
});

test.beforeAll("Starting traefik with Keycloak for XHR tests", async () => {
  const providerUrl = process.env.PROVIDER_URL || "http://keycloak:8080/realms/test";
  const clientId = process.env.CLIENT_ID || "traefik";
  const clientSecret = process.env.CLIENT_SECRET || "test-secret";
  await configureTraefik(`
http:
  services:
    whoami:
      loadBalancer:
        servers:
          - url: http://whoami:80

  middlewares:
    oidc-auth:
      plugin:
        traefik-oidc-auth:
          LogLevel: DEBUG
          Provider:
            Url: "${providerUrl}"
            ClientId: "${clientId}"
            ClientSecret: "${clientSecret}"
          Scopes:
            - openid
            - profile
            - email
          Headers:
            - Name: "X-Oidc-Email"
              Value: "{{\`{{ .claims.email }}\`}}"
          javascript_request_detection:
            Headers:
              X-Requested-With:
                - XMLHttpRequest
              Sec-Fetch-Mode:
                - cors
                - same-origin
              Content-Type:
                - application/json

  routers:
    whoami:
      entryPoints: ["web"]
      rule: Host("whoami.localhost")
      service: whoami
      middlewares: ["oidc-auth@file"]
    health:
      entryPoints: ["web"]
      rule: Host("whoami.localhost") && PathPrefix("/health")
      service: whoami
`);

  await dockerCompose.upAll({
    cwd: __dirname,
    log: false
  });

  // Wait for Keycloak to be ready
  await test.step("Waiting for Keycloak to be ready", async () => {
    const maxRetries = 30;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch('http://localhost:8000/realms/test/.well-known/openid-configuration');
        if (response.ok) {
          console.log('Keycloak is ready');
          break;
        }
      } catch (e) {
        // Continue waiting
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });

  // Wait a bit more for Traefik to be fully ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Verify Traefik is responding
  try {
    const response = await fetch('http://whoami.localhost:9080');
    console.log('Traefik health check status:', response.status);
  } catch (e) {
    console.error('Traefik health check failed:', e);
  }
});

test.afterAll("Stopping services", async () => {
  await dockerCompose.down({cwd: __dirname, log: false});
});

//-----------------------------------------------------------------------------
// XHR Tests
//-----------------------------------------------------------------------------

test.describe("XHR Request Handling", () => {
  test("should return 401 JSON for XHR requests without session", async ({page}) => {
    // Navigate to the target domain first to avoid CORS issues
    await page.goto('http://whoami.localhost:9080/health', {
      waitUntil: 'domcontentloaded'
    });

    // Make an XHR request without authentication from the same origin
    const response = await page.evaluate(async () => {
      const response = await fetch('http://whoami.localhost:9080', {
        headers: {
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      return {
        status: response.status,
        // @ts-ignore
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json()
      };
    });

    // Should get 401 with JSON response
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      type: expect.stringContaining('https://tools.ietf.org/html/rfc9110'),
      title: 'Unauthorized',
      detail: 'Session expired or not authenticated',
      login_url: expect.stringContaining('/oidc/login'),
      logout_url: expect.stringContaining('/logout')
    });
  });

  test("should return 401 JSON for AJAX requests with Accept: application/json", async ({page}) => {
    // Navigate to a blank page first to establish page context
    await page.goto('http://whoami.localhost:9080/health');

    // Make a request with Accept: application/json header
    const response = await page.evaluate(async () => {
      const response = await fetch('http://whoami.localhost:9080', {
        headers: {
          'Accept': 'application/json'
        }
      });
      return {
        status: response.status,
        // @ts-ignore
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json()
      };
    });

    // Should get 401 with JSON response
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      type: expect.any(String),
      title: 'Unauthorized',
      detail: expect.any(String),
      login_url: expect.stringContaining('/oidc/login'),
      logout_url: expect.stringContaining('/logout')
    });
  });

  test("should redirect browser requests to Keycloak login", async ({page}) => {
    // Navigate without XHR headers - should redirect
    await page.goto('http://whoami.localhost:9080');

    // Should be redirected to Keycloak
    await expect(page).toHaveURL(/localhost:8000.*auth/);
    expect(page.url()).toContain('realms/test/protocol/openid-connect/auth');
  });

  test("should handle authenticated XHR requests", async ({page}) => {
    // First, login via browser
    await page.goto('http://whoami.localhost:9080');

    // Login to Keycloak
    await page.fill('#username', 'alice');
    await page.fill('#password', 'alice123');
    await page.click('#kc-login');

    // Wait for redirect back to app
    await expect(page).toHaveURL(/whoami\.localhost:9080/);

    // Now make an XHR request with the session cookie
    const response = await page.evaluate(async () => {
      const response = await fetch('http://whoami.localhost:9080', {
        headers: {
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'include'
      });
      return {
        status: response.status,
        // @ts-ignore
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text()
      };
    });

    // Should get 200 OK with the whoami response
    expect(response.status).toBe(200);
    expect(response.body).toContain('Hostname:');
  });

  test("should return JSON error for expired session XHR requests", async ({page, context}) => {
    // First, login via browser
    await page.goto('http://whoami.localhost:9080');

    // Login to Keycloak
    await page.fill('#username', 'alice');
    await page.fill('#password', 'alice123');
    await page.click('#kc-login');

    // Wait for redirect back to app
    await expect(page).toHaveURL(/whoami\.localhost:9080/);

    // Clear the session cookies to simulate expired session
    await context.clearCookies();

    // Make an XHR request - should get JSON error instead of redirect
    const response = await page.evaluate(async () => {
      const response = await fetch('http://whoami.localhost:9080', {
        headers: {
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'include'
      });
      return {
        status: response.status,
        // @ts-ignore
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json()
      };
    });

    // Should get 401 with JSON response
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      title: 'Unauthorized',
      detail: 'Session expired or not authenticated',
      login_url: expect.stringContaining('/oidc/login'),
      logout_url: expect.stringContaining('/logout')
    });
  });

  test("should return 401 JSON for requests with Sec-Fetch-Mode: cors", async ({page}) => {
    // Navigate to establish context
    await page.goto('http://whoami.localhost:9080/health');

    // Make a request with Sec-Fetch-Mode: cors header
    const response = await page.evaluate(async () => {
      const response = await fetch('http://whoami.localhost:9080', {
        headers: {
          'Sec-Fetch-Mode': 'cors'
        }
      });
      return {
        status: response.status,
        // @ts-ignore
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json()
      };
    });

    // Should get 401 with JSON response
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      title: 'Unauthorized',
      login_url: expect.stringContaining('/oidc/login'),
      logout_url: expect.stringContaining('/logout')
    });
  });

  test("should return 401 JSON for requests with Content-Type: application/json", async ({page}) => {
    // Navigate to establish context
    await page.goto('http://whoami.localhost:9080/health');

    // Make a POST request with Content-Type: application/json
    const response = await page.evaluate(async () => {
      const response = await fetch('http://whoami.localhost:9080', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ test: 'data' })
      });
      return {
        status: response.status,
        // @ts-ignore
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json()
      };
    });

    // Should get 401 with JSON response
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      title: 'Unauthorized',
      login_url: expect.stringContaining('/oidc/login'),
      logout_url: expect.stringContaining('/logout')
    });
  });

  test("should return 401 JSON for requests with multiple XHR indicators", async ({page}) => {
    // Navigate to establish context
    await page.goto('http://whoami.localhost:9080/health');

    // Make a request with multiple indicators
    const response = await page.evaluate(async () => {
      const response = await fetch('http://whoami.localhost:9080', {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json',
          'Sec-Fetch-Mode': 'cors'
        }
      });
      return {
        status: response.status,
        // @ts-ignore
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.json()
      };
    });

    // Should get 401 with JSON response
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toMatchObject({
      title: 'Unauthorized',
      login_url: expect.stringContaining('/oidc/login'),
      logout_url: expect.stringContaining('/logout')
    });
  });

  test("should NOT return JSON for browser navigate requests", async ({page}) => {
    // This test verifies that regular browser navigation doesn't trigger JSON response
    // even if some headers might be present
    
    // Create a promise to catch the redirect
    const navigationPromise = page.waitForNavigation();
    
    // Navigate with browser (this will have Sec-Fetch-Mode: navigate)
    await page.goto('http://whoami.localhost:9080', {
      waitUntil: 'domcontentloaded'
    });
    
    // Should be redirected to Keycloak, not get JSON
    await expect(page).toHaveURL(/localhost:8000.*auth/);
  });

});

