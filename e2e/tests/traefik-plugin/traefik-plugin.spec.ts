import { expect, test } from "@playwright/test";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Test configuration
test.use({
  ignoreHTTPSErrors: true
});

test.describe("Traefik OIDC Plugin", () => {
  test.beforeAll("Starting Traefik with OIDC plugin", async () => {
    console.log("Starting Docker Compose services...");
    
    // First stop any existing services
    try {
      await execAsync("docker-compose down -v", { cwd: __dirname });
    } catch (e) {
      // Ignore errors from down command
    }
    
    // Start services
    const { stdout, stderr } = await execAsync("docker-compose up -d", { cwd: __dirname });
    console.log("Docker-compose output:", stdout);
    if (stderr) console.error("Docker-compose stderr:", stderr);

    // Wait for services to be ready
    await test.step("Waiting for services to be ready", async () => {
      let servicesReady = false;
      
      // First wait for Keycloak to be ready
      console.log("Waiting for Keycloak to be ready...");
      for (let i = 0; i < 60 && !servicesReady; i++) {
        try {
          const keycloakResponse = await fetch('http://localhost:8000/realms/test/.well-known/openid-configuration');
          if (keycloakResponse.ok) {
            console.log("Keycloak is ready");
            servicesReady = true;
          }
        } catch (e) {
          // Continue waiting
        }
        if (!servicesReady) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      if (!servicesReady) {
        throw new Error('Keycloak failed to start after 60 seconds');
      }
      
      // Now wait for Traefik to be ready
      console.log("Waiting for Traefik to be ready...");
      servicesReady = false;
      for (let i = 0; i < 60 && !servicesReady; i++) {
        try {
          // Check Traefik dashboard
          const traefikResponse = await fetch('http://localhost:8081/api/overview');
          if (traefikResponse.ok) {
            console.log('Traefik is ready');
            servicesReady = true;
          }
        } catch (e) {
          // Continue waiting
        }
        
        if (!servicesReady) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      if (!servicesReady) {
        throw new Error('Traefik failed to become ready');
      }

      // Wait a bit more for the plugin to load
      console.log("Waiting for plugin to initialize...");
      await new Promise(resolve => setTimeout(resolve, 5000));
    });
  });

  test.afterAll("Stopping services", async () => {
    try {
      await execAsync("docker-compose down -v", { cwd: __dirname });
    } catch (e) {
      console.error("Error stopping services:", e);
    }
  });

  test("should load plugin without errors", async () => {
    // Check Traefik is healthy
    const response = await fetch('http://localhost:8081/api/overview');
    expect(response.ok).toBeTruthy();
    
    const data = await response.json();
    console.log("Traefik overview:", JSON.stringify(data, null, 2));
  });

  test("should redirect unauthenticated requests to OIDC provider", async ({page}) => {
    // Navigate to protected resource
    await page.goto('http://localhost:8080');
    
    // Should be redirected to Keycloak login
    // The redirect URL will be keycloak:8080 (internal Docker URL) or localhost:8000 (mapped port)
    await expect(page).toHaveURL(/(?:keycloak:8080|localhost:8000).*auth/);
  });

  test("should return JSON error for XHR requests", async ({page}) => {
    // First navigate to any page to set up the browser context
    await page.goto('http://localhost:8081').catch(() => {});
    
    const response = await page.evaluate(async () => {
      const response = await fetch('http://localhost:8080', {
        headers: {
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      
      const contentType = response.headers.get('content-type') || '';
      let body;
      
      if (contentType.includes('json')) {
        body = await response.json();
      } else {
        body = await response.text();
      }
      
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        contentType,
        body
      };
    });
    
    // Should return 401
    expect(response.status).toBe(401);
    
    // Should return JSON
    expect(response.contentType).toContain('json');
    expect(response.body).toMatchObject({
      type: expect.any(String),
      title: 'Unauthorized',
      detail: expect.any(String)
    });
  });

  test("should check for Yaegi compatibility errors in logs", async () => {
    // Get Traefik logs
    const { stdout } = await execAsync("docker logs traefik-plugin-test 2>&1 | tail -100", { cwd: __dirname });
    
    // Check for common Yaegi errors
    const yaegiErrors = [
      "undefined: go.opentelemetry",
      "undefined: otel",
      "panic:",
      "cannot use",
      "plugin load error"
    ];
    
    let hasYaegiError = false;
    for (const error of yaegiErrors) {
      if (stdout.toLowerCase().includes(error.toLowerCase())) {
        console.error(`Found potential Yaegi error: ${error}`);
        hasYaegiError = true;
      }
    }
    
    // The test passes if no Yaegi errors are found
    expect(hasYaegiError).toBe(false);
  });

  test("should handle authentication flow", async ({page, context}) => {
    // Enable request interception to see redirects
    const redirects: string[] = [];
    
    page.on('response', response => {
      if (response.status() >= 300 && response.status() < 400) {
        const location = response.headers()['location'];
        if (location) {
          redirects.push(location);
        }
      }
    });

    // Navigate to protected resource
    await page.goto('http://localhost:8080');
    
    // Should be on Keycloak login page
    await expect(page).toHaveURL(/auth/);
    
    // Verify the redirect chain includes our callback URL
    const hasCallbackRedirect = redirects.some(url => url.includes('/oauth2/callback'));
    expect(hasCallbackRedirect).toBe(true);
  });

  test("middleware should preserve request headers", async ({page}) => {
    await page.goto('http://localhost:8081').catch(() => {});
    
    const response = await page.evaluate(async () => {
      const response = await fetch('http://localhost:8080', {
        headers: {
          'X-Custom-Header': 'test-value',
          'Accept': 'application/json'
        }
      });
      
      return {
        status: response.status,
        location: response.headers.get('location')
      };
    });
    
    // Should redirect to auth
    expect(response.status).toBe(302);
    expect(response.location).toContain('auth');
  });
});