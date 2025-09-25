import { test, expect, Page, Response } from "@playwright/test";
import * as dockerCompose from "docker-compose";
import { configureTraefik } from "../../utils";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Helper function to wait for Traefik to be ready after configuration changes
async function waitForTraefikReady() {
  console.log("Checking Traefik readiness...");

  // Check container health
  try {
    const containerStatus = await execAsync("docker ps --filter name=keycloak-traefik-1 --format '{{.Status}}'");
    if (!containerStatus.stdout.includes("Up")) {
      throw new Error(`Traefik container is not running: ${containerStatus.stdout}`);
    }
  } catch (e) {
    console.error("Failed to check Traefik container status:", e);
    throw e;
  }

  // Wait for HTTP port to be accessible
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1000)
      });

      // 401 is expected (unauthorized), meaning Traefik is responding
      if (response.status === 401 || response.status === 302 || response.status === 200) {
        console.log(`Traefik HTTP port ${TRAEFIK_HTTP_PORT} is ready (status: ${response.status})`);
        break;
      }
    } catch (e) {
      if (i === 29) {
        // Check container logs for errors
        const logs = await dockerCompose.logs("traefik", { cwd: __dirname });
        console.error("Traefik logs (last 50 lines):", logs);
        throw new Error(`Traefik HTTP port ${TRAEFIK_HTTP_PORT} is not accessible after 30 seconds`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Wait for HTTPS port to be accessible
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`https://localhost:${TRAEFIK_HTTPS_PORT}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1000)
      });

      // 401 is expected (unauthorized), meaning Traefik is responding
      if (response.status === 401 || response.status === 302 || response.status === 200) {
        console.log(`Traefik HTTPS port ${TRAEFIK_HTTPS_PORT} is ready (status: ${response.status})`);
        break;
      }
    } catch (e) {
      // HTTPS might fail due to certificate issues, which is OK
      if (e.message && (e.message.includes("DEPTH_ZERO_SELF_SIGNED_CERT") || e.message.includes("ERR_TLS"))) {
        console.log(`Traefik HTTPS port ${TRAEFIK_HTTPS_PORT} is ready (certificate error, which is expected)`);
        break;
      }
      if (i === 29) {
        console.warn(`Traefik HTTPS port ${TRAEFIK_HTTPS_PORT} may not be fully ready: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Check for any critical errors in Traefik logs
  const logs = await dockerCompose.logs("traefik", { cwd: __dirname });
  if (logs.out && logs.out.includes("[ERROR]")) {
    console.warn("Traefik has errors in logs:", logs.out.match(/\[ERROR\].*/g));
  }

  console.log("Traefik is ready!");
}

//-----------------------------------------------------------------------------
// Test Setup
//-----------------------------------------------------------------------------

// Global variables to store dynamic ports
let KEYCLOAK_HTTP_PORT: number;
let KEYCLOAK_HTTPS_PORT: number;
let KEYCLOAK_HEALTH_PORT: number;
let TRAEFIK_HTTP_PORT: number;
let TRAEFIK_HTTPS_PORT: number;
let TRAEFIK_API_PORT: number;

// Helper function to get container port
async function getContainerPort(containerName: string, internalPort: number): Promise<number> {
  const { stdout } = await execAsync(
    `docker port ${containerName} ${internalPort} | cut -d: -f2`
  );
  return parseInt(stdout.trim());
}

test.use({
  ignoreHTTPSErrors: true
});

test.beforeAll("Starting traefik", async () => {
  test.setTimeout(300000);

  process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
    whoami-secure:
      entryPoints: ["websecure"]
      tls: {}
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  await dockerCompose.upAll({
    cwd: __dirname,
    log: true
  });

  // Get the dynamically assigned ports
  console.log("Getting dynamic ports...");
  KEYCLOAK_HTTP_PORT = await getContainerPort("keycloak-keycloak-1", 8080);
  KEYCLOAK_HTTPS_PORT = await getContainerPort("keycloak-keycloak-1", 8443);
  KEYCLOAK_HEALTH_PORT = await getContainerPort("keycloak-keycloak-1", 9000);
  TRAEFIK_HTTP_PORT = await getContainerPort("keycloak-traefik-1", 80);
  TRAEFIK_HTTPS_PORT = await getContainerPort("keycloak-traefik-1", 443);
  TRAEFIK_API_PORT = await getContainerPort("keycloak-traefik-1", 8080);

  console.log(`Dynamic ports assigned:
    Keycloak HTTP: ${KEYCLOAK_HTTP_PORT}
    Keycloak HTTPS: ${KEYCLOAK_HTTPS_PORT}
    Keycloak Health: ${KEYCLOAK_HEALTH_PORT}
    Traefik HTTP: ${TRAEFIK_HTTP_PORT}
    Traefik HTTPS: ${TRAEFIK_HTTPS_PORT}
    Traefik API: ${TRAEFIK_API_PORT}
  `);

  // Update Keycloak hostname environment variable
  await execAsync(`docker exec keycloak-keycloak-1 sh -c "export KC_HOSTNAME=http://localhost:${KEYCLOAK_HTTP_PORT}"`);

  // Wait for Keycloak to start
  console.log("Waiting for Keycloak to start...");
  for(let i = 0; i < 90; i++) {  // Wait up to 90 seconds
    if (i % 5 === 0 && i > 0) {  // Log every 5 seconds
      console.log(`Waiting for Keycloak... (${i}s)`);
    }

    await new Promise(r => setTimeout(r, 1000));

    try {
      // Try to access the Keycloak HTTP endpoint directly
      const response = await fetch(`http://localhost:${KEYCLOAK_HTTP_PORT}/realms/master/.well-known/openid-configuration`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1000)
      });

      if (response.ok) {
        console.log("Keycloak is ready!");
        break;
      }
    }
    catch (e) {
      // Keycloak is not ready yet, continue waiting
      if (i % 20 === 0 && i > 0) {
        console.log(`Still waiting for Keycloak to be ready...`);
      }
      if (i === 89) {
        throw new Error("Timeout occurred while waiting for Keycloak to start.");
      }
    }
  }

  // Wait for Traefik to be ready
  console.log("Waiting for Traefik to start...");
  for(let i = 0; i < 30; i++) {  // Wait up to 30 seconds
    if (i % 5 === 0 && i > 0) {  // Log every 5 seconds
      console.log(`Waiting for Traefik... (${i}s)`);
    }

    await new Promise(r => setTimeout(r, 1000));

    try {
      // Try to access the Traefik API endpoint
      const response = await fetch(`http://localhost:${TRAEFIK_API_PORT}/api/overview`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000)
      });

      if (response.ok) {
        console.log("Traefik API is ready!");
        break;
      }
    }
    catch (e) {
      // Traefik is not ready yet, continue waiting
      if (i === 29) {
        console.log("Warning: Traefik API may not be fully ready, but continuing...");
      }
    }
  }

  // Give services a moment to fully initialize
  await new Promise(r => setTimeout(r, 2000));

  console.log("All services are ready!");

  // Debug: Check if ports are actually listening
  console.log("\nDebug: Checking port accessibility...");
  try {
    const httpCheck = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000)
    }).then(r => `HTTP port ${TRAEFIK_HTTP_PORT}: ${r.status}`).catch(e => `HTTP port ${TRAEFIK_HTTP_PORT}: ${e.message}`);
    console.log(httpCheck);

    const httpsCheck = await fetch(`https://localhost:${TRAEFIK_HTTPS_PORT}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000)
    }).then(r => `HTTPS port ${TRAEFIK_HTTPS_PORT}: ${r.status}`).catch(e => `HTTPS port ${TRAEFIK_HTTPS_PORT}: ${e.message}`);
    console.log(httpsCheck);

    // Check container ports directly
    const containerPorts = await execAsync("docker ps --format 'table {{.Names}}\t{{.Ports}}'");
    console.log("\nContainer port mappings:");
    console.log(containerPorts);
  } catch (e) {
    console.log("Debug check error:", e);
  }
});

test.beforeEach("Check Traefik health before test", async () => {
  // Give a moment for any previous config changes to settle
  await new Promise(r => setTimeout(r, 1000));

  // Check that Traefik is ready before running the test
  await waitForTraefikReady();
});

test.afterEach("Traefik logs on test failure", async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    console.log(`${testInfo.title} failed, here are Traefik logs:`);
    console.log(await dockerCompose.logs("traefik", { cwd: __dirname }));
    console.log(await dockerCompose.logs("keycloak", { cwd: __dirname }));
  }
});

test.afterAll("Stopping traefik", async () => {
  await dockerCompose.downAll({
    cwd: __dirname,
    log: true
  });
});

//-----------------------------------------------------------------------------
// Tests
//-----------------------------------------------------------------------------

test("login http", async ({ page }) => {
  // Configure Traefik for HTTP login
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "Host(\`localhost\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  // Wait for Traefik to be ready after configuration change
  await waitForTraefikReady();

  // Additional wait and retry logic for navigation
  let retries = 5;
  while (retries > 0) {
    try {
      await page.goto(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
        waitUntil: 'domcontentloaded',
        timeout: 5000
      });
      break; // Success
    } catch (e) {
      if (retries === 1 || !e.message.includes('ERR_CONNECTION_REFUSED')) {
        throw e; // Last retry or different error
      }
      console.log(`Connection refused, retrying... (${retries} attempts left)`);
      await new Promise(r => setTimeout(r, 2000));
      retries--;
    }
  }

  // Now check the status
  const currentUrl = page.url();
  expect(currentUrl).toContain('/realms/master/protocol/openid-connect/auth');

  const response = await login(page, "admin", "admin", `http://localhost:${TRAEFIK_HTTP_PORT}`);

  expect(response.status()).toBe(200);
});

test("login https", async ({ browser }) => {
  // Create a new context with specific HTTPS settings
  const context = await browser.newContext({
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();
  // Configure Traefik for HTTPS login with TLS configuration
  await configureTraefik(`
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /certificates/website_cert/website.pem
        keyFile: /certificates/website_cert/website.key

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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false

  routers:
    whoami-secure:
      entryPoints: ["websecure"]
      tls: {}
      rule: "Host(\`localhost\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  // Wait for HTTPS to be properly configured and ready
  console.log("Waiting for HTTPS configuration to take effect...");
  let httpsReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`https://localhost:${TRAEFIK_HTTPS_PORT}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(1000)
      });
      if (response.status === 401 || response.status === 302 || response.status === 200) {
        console.log(`HTTPS is ready after ${i} seconds (status: ${response.status})`);
        httpsReady = true;
        break;
      }
    } catch (e) {
      // Ignore certificate errors and connection issues during startup
      if (i % 5 === 0) {
        console.log(`Still waiting for HTTPS... (${i}s)`);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!httpsReady) {
    console.error("HTTPS endpoint did not become ready in 30 seconds");
    const logs = await dockerCompose.logs("traefik", { cwd: __dirname, tail: 50 });
    console.error("Traefik logs:", logs);
    throw new Error("HTTPS endpoint not ready");
  }

  // Double-check HTTPS is actually ready before navigating
  console.log(`About to navigate to https://localhost:${TRAEFIK_HTTPS_PORT}`);

  // Try a direct fetch first to verify connectivity
  try {
    const testResponse = await fetch(`https://localhost:${TRAEFIK_HTTPS_PORT}/`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(2000)
    });
    console.log(`Pre-navigation test: HTTPS responded with status ${testResponse.status}`);
  } catch (e) {
    console.log(`Pre-navigation test failed: ${e.message}`);
    console.log("Checking if Traefik container is still running...");
    const containerStatus = await execAsync("docker ps --filter name=keycloak-traefik-1 --format '{{.Status}}'");
    console.log("Traefik container status:", containerStatus.stdout);

    // Check Traefik logs for errors
    const logs = await dockerCompose.logs("traefik", { cwd: __dirname });
    console.log("Recent Traefik logs:", logs.out);
  }

  // Navigate with ignoring HTTPS errors for self-signed certificates
  console.log(`Navigating to https://localhost:${TRAEFIK_HTTPS_PORT}`);
  const initialResponse = await page.goto(`https://localhost:${TRAEFIK_HTTPS_PORT}`, {
    waitUntil: 'domcontentloaded'
  });

  // Should redirect to login page
  console.log(`Redirected to: ${page.url()}`);
  expect(page.url()).toContain('/realms/master/protocol/openid-connect/auth');

  // Wait for the login form to be visible
  console.log("Waiting for login form...");
  await page.waitForSelector("#username", { timeout: 10000 });

  const loginResponse = await login(page, "admin", "admin", `https://localhost:${TRAEFIK_HTTPS_PORT}`);

  expect(loginResponse.status()).toBe(200);

  // Clean up
  await context.close();
});

test("logout", async ({ page }) => {
  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}`);

  const response = await login(page, "admin", "admin", `http://localhost:${TRAEFIK_HTTP_PORT}`);

  expect(response.status()).toBe(200);

  const logoutResponse = await page.goto(`http://localhost:${TRAEFIK_HTTP_PORT}/logout`);

  // After logout we should be at the login page again
  expect(logoutResponse?.url()).toMatch(new RegExp(`http://localhost:${KEYCLOAK_HTTP_PORT}/realms/master/protocol/openid-connect/auth.*`));
});

test("test two services is seamless", async ({ page }) => {
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Headers:
            - Name: "Authorization"
              Value: "{{\`Bearer: {{ .accessToken }}\`}}"
            - Name: "X-Static-Header"
              Value: "42"

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "Host(\`localhost\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
    other:
      entryPoints: ["web"]
      rule: "Host(\`localhost\`) && Path(\`/other\`)"
      service: noop@internal  # serves 418 I'm A Teapot
      middlewares: ["oidc-auth@file"]

`);

  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}/`);

  const response = await login(page, "admin", "admin", `http://localhost:${TRAEFIK_HTTP_PORT}`);

  expect(response.status()).toBe(200);

  const otherSvcResp = await page.goto(`http://localhost:${TRAEFIK_HTTP_PORT}/other`);
  expect(otherSvcResp!.status()).toBe(418);
  expect(otherSvcResp!.request().redirectedFrom()).toBeNull();
});


test("test headers", async ({ page }) => {
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Headers:
            - Name: "Authorization"
              Value: "{{\`Bearer: {{ .accessToken }}\`}}"
            - Name: "X-Static-Header"
              Value: "42"

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}`);

  const response = await login(page, "admin", "admin", `http://localhost:${TRAEFIK_HTTP_PORT}`);

  expect(response.status()).toBe(200);

  const authHeaderExists = await page.locator(`text=Authorization: Bearer: ey`).isVisible();
  expect(authHeaderExists).toBeTruthy();

  const staticHeaderExists = await page.locator(`text=X-Static-Header: 42`).isVisible();
  expect(staticHeaderExists).toBeTruthy();

  // Authorization cookie should not be present in the rendered contents
  const pageText = await page.innerText("html");
  expect(pageText).not.toMatch(/Cookie:\s*(?:^|\s|;)\s*Authorization\s*=\s*[^;\r\n]+/);
});

test("test authorization", async ({ page }) => {
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Authorization:
            AssertClaims:
              - Name: email
                AnyOf: ["admin", "alice@example.com"]

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}`);

  const response = await login(page, "alice@example.com", "alice123", `http://localhost:${TRAEFIK_HTTP_PORT}`);

  expect(response.status()).toBe(200);
});

test("test authorization failing", async ({ page }) => {
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Authorization:
            AssertClaims:
              - Name: email
                AnyOf: ["admin", "alice@example.com"]

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}`);

  const response = await login(page, "bob@example.com", "bob123", `http://localhost:${TRAEFIK_HTTP_PORT}/oidc/callback**`);

  expect(response.status()).toBe(403);

  expect(await response.text()).toContain("It seems like your account is not allowed to access this resource.");
});

test("login at provider via self signed certificate from file", async ({ page }) => {
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
            Url: "\${PROVIDER_URL_HTTPS}"
            CABundleFile: "/certificates/bundle/ca_bundle.pem"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
    whoami-secure:
      entryPoints: ["websecure"]
      tls: {}
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  await expectGotoOkay(page, `https://localhost:${TRAEFIK_HTTPS_PORT}`);

  const response = await login(page, "admin", "admin", `https://localhost:${TRAEFIK_HTTPS_PORT}`);

  expect(response.status()).toBe(200);
});

test("login at provider via self signed inline certificate", async ({ page }) => {
  const certBundle = fs.readFileSync(path.join(__dirname, "./certificates/bundle/ca_bundle.pem"));
  const base64CertBundle = certBundle.toString("base64");

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
            Url: "\${PROVIDER_URL_HTTPS}"
            CABundle: "base64:${base64CertBundle}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
    whoami-secure:
      entryPoints: ["websecure"]
      tls: {}
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  await expectGotoOkay(page, `https://localhost:${TRAEFIK_HTTPS_PORT}`);

  const response = await login(page, "admin", "admin", `https://localhost:${TRAEFIK_HTTPS_PORT}`);

  expect(response.status()).toBe(200);
});

test("access app with bypass rule", async ({ page }) => {
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          BypassAuthenticationRule: "Header(\`MY-HEADER\`, \`123\`)"

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  // The first test should bypass authentication and directly return the whoami page.
  await page.route(`http://localhost:${TRAEFIK_HTTP_PORT}/**/*`, route => {
    const headers = route.request().headers();
    headers["MY-HEADER"] = "123";

    route.continue({ headers });
  });
  
  await page.goto(`http://localhost:${TRAEFIK_HTTP_PORT}/test1`);

  await expect(page.getByText(/My-Header: 123/i)).toBeVisible();

  // The second test should return a redirect to the IDP, because the header doesn't match.
  await page.route(`http://localhost:${TRAEFIK_HTTP_PORT}/**/*`, route => {
    const headers = route.request().headers();
    headers["MY-HEADER"] = "456";

    route.continue({ headers });
  });

  const response = await page.goto(`http://localhost:${TRAEFIK_HTTP_PORT}/test2`);

  expect(response?.url()).toMatch(new RegExp(`http://localhost:${KEYCLOAK_HTTP_PORT}/realms/master/protocol/openid-connect/auth.*`));
});

test("external authentication", async ({ page }) => {
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
                Url: "\${PROVIDER_URL_HTTP}"
                ClientId: "\${CLIENT_ID}"
                ClientSecret: "\${CLIENT_SECRET}"
                UsePkce: false
              AuthorizationHeader:
                Name: "CustomAuth"
              AuthorizationCookie:
                Name: "CustomAuth"
              UnauthorizedBehavior: "Unauthorized"
    
      routers:
        whoami:
          entryPoints: ["web"]
          rule: "HostRegexp(\`.+\`)"
          service: whoami
          middlewares: ["oidc-auth@file"]
  `);

  const token = await loginAndGetToken(page, "admin", "admin");

  const response1 = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
    method: "GET"
  });

  expect(response1.status).toBe(401);

  const response2 = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
    method: "GET",
    "headers": {
      CustomAuth: token
    }
  });

  expect(response2.status).toBe(200);

  const response3 = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
    method: "GET",
    "headers": {
      CustomAuth: "wrong value"
    }
  });

  expect(response3.status).toBe(401);

  const response4 = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
    method: "GET",
    "headers": {
      Cookie: `CustomAuth=${token}`
    }
  });

  expect(response4.status).toBe(200);

  const response5 = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
    method: "GET",
    "headers": {
      Cookie: `CustomAuth=wrong-value`
    }
  });

  expect(response5.status).toBe(401);
});

test("external authentication with authorization rules", async ({ page }) => {
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
                Url: "\${PROVIDER_URL_HTTP}"
                ClientId: "\${CLIENT_ID}"
                ClientSecret: "\${CLIENT_SECRET}"
                UsePkce: false
              AuthorizationHeader:
                Name: "CustomAuth"
              UnauthorizedBehavior: "Unauthorized"
              Authorization:
                AssertClaims:
                  - Name: preferred_username
                    AnyOf: ["admin", "alice"]
    
      routers:
        whoami:
          entryPoints: ["web"]
          rule: "HostRegexp(\`.+\`)"
          service: whoami
          middlewares: ["oidc-auth@file"]
  `);

  const aliceToken = await loginAndGetToken(page, "alice@example.com", "alice123");

  const response1 = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
    method: "GET",
    "headers": {
      CustomAuth: aliceToken
    }
  });

  // Alice should be authorized, based on AssertClaims
  expect(response1.status).toBe(200);

  const bobToken = await loginAndGetToken(page, "bob@example.com", "bob123");

  const response2 = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
    method: "GET",
    "headers": {
      CustomAuth: bobToken
    }
  });

  // but bob should not be authorized
  expect(response2.status).toBe(403);
});

test("test authorization custom error page", async ({ page }) => {
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Authorization:
            AssertClaims:
              - Name: email
                AnyOf: ["admin", "alice@example.com"]
          ErrorPages:
            Unauthorized:
              FilePath: "/data/customUnauthorizedPage.html"

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}`);

  const response = await login(page, "bob@example.com", "bob123", `http://localhost:${TRAEFIK_HTTP_PORT}/oidc/callback**`);

  expect(response.status()).toBe(403);

  expect(await response.text()).toContain("CUSTOM ERROR PAGE");
});

test("test authorization error redirect", async ({ page }) => {
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Authorization:
            AssertClaims:
              - Name: email
                AnyOf: ["admin", "alice@example.com"]
          ErrorPages:
            Unauthorized:
              RedirectTo: "https://httpbin.org/unauthorized"

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "HostRegexp(\`.+\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}`);

  const response = await login(page, "bob@example.com", "bob123", `http://localhost:${TRAEFIK_HTTP_PORT}/oidc/callback**`);

  expect(response.status()).toBe(302);
  expect(await response.headerValue("Location")).toBe("https://httpbin.org/unauthorized");
});

test("test CheckOnEveryRequest", async ({ page }) => {
   await configureTraefik(`
http:
  services:
    whoami:
      loadBalancer:
        servers:
          - url: http://whoami:80

  middlewares:
    auth:
      plugin:
        traefik-oidc-auth:
          LogLevel: DEBUG
          Provider:
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Authorization:
            AssertClaims:
              - Name: email
                AnyOf: ["bob@example.com", "alice@example.com"]
            CheckOnEveryRequest: true
    auth-bob:
      plugin:
        traefik-oidc-auth:
          LogLevel: DEBUG
          Provider:
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Authorization:
            AssertClaims:
              - Name: email
                AnyOf: ["bob@example.com"]
            CheckOnEveryRequest: true

    auth-alice:
      plugin:
        traefik-oidc-auth:
          LogLevel: DEBUG
          Provider:
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false
          Authorization:
            AssertClaims:
              - Name: email
                AnyOf: ["alice@example.com"]
            CheckOnEveryRequest: true

  routers:
    oidc-callback:
      entryPoints: ["web"]
      rule: "PathPrefix(\`/oidc/callback\`)"
      service: noop@internal
      middlewares: ["auth"]

    whoami-bob:
      entryPoints: ["web"]
      rule: "PathPrefix(\`/bob\`)"
      service: whoami
      middlewares: ["auth-bob"]

    whoami-alice:
      entryPoints: ["web"]
      rule: "PathPrefix(\`/alice\`)"
      middlewares: ["auth-alice"]
      service: whoami
`);
  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}/alice`);

  const response = await login(page, "alice@example.com", "alice123", `http://localhost:${TRAEFIK_HTTP_PORT}/alice`);
  expect(response.status()).toBe(200);

  await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}/alice`);

  const respBob = await page.goto(`http://localhost:${TRAEFIK_HTTP_PORT}/bob`);
  expect(respBob?.status()).toBe(403);

});

//-----------------------------------------------------------------------------
// JavaScript Request Detection Tests
//-----------------------------------------------------------------------------

test.describe("JavaScript Request Detection", () => {
  test.beforeEach("Configure Traefik for JavaScript detection tests", async () => {
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
            Url: "\${PROVIDER_URL_HTTP}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
            UsePkce: false

  routers:
    whoami:
      entryPoints: ["web"]
      rule: "Host(\`localhost\`)"
      service: whoami
      middlewares: ["oidc-auth@file"]
`);

    // Wait for Traefik to reload configuration
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  test("should return JSON error for XMLHttpRequest", async ({ page }) => {
    // Wait a bit more for Traefik to be ready
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log(`Testing with Traefik port: ${TRAEFIK_HTTP_PORT}`);

    // Make server-side fetch request with XHR headers
    try {
      const response = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      console.log(`Response status: ${response.status}`);
      console.log(`Content-Type: ${response.headers.get('Content-Type')}`);

      expect(response.status).toBe(401);
      expect(response.headers.get('Content-Type')).toContain('application/json');

      const bodyText = await response.text();
      console.log(`Response body: ${bodyText}`);

      const body = JSON.parse(bodyText);
      expect(body.type).toBe('https://tools.ietf.org/html/rfc9110#section-15.5.2');
      expect(body.title).toBe('Unauthorized');
      expect(body.login_url).toBeDefined();
      expect(body.logout_url).toBeDefined();
    } catch (error) {
      console.error('Test failed with error:', error);
      throw error;
    }
  });

  test("should not redirect for XHR requests", async ({ page }) => {
    // Make server-side fetch request with XHR headers and check for no redirect
    const response = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
      method: 'GET',
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      },
      redirect: 'manual' // Don't follow redirects
    });

    expect(response.status).toBe(401); // Should get 401, not 302
    expect(response.headers.get('Location')).toBeNull(); // No redirect header
  });

  test("should return JSON for fetch with Sec-Fetch-Mode: cors", async ({ page }) => {
    // Make server-side fetch request with Sec-Fetch-Mode header
    const response = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
      method: 'GET',
      headers: {
        'Sec-Fetch-Mode': 'cors'
      }
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toContain('application/json');

    const body = await response.json();
    expect(body.type).toBeDefined();
    expect(body.title).toBe('Unauthorized');
  });

  test("should return JSON for fetch with JSON Content-Type", async ({ page }) => {
    // Make server-side fetch request with JSON Content-Type
    const response = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ test: 'data' })
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  test("should return JSON for fetch with Accept: application/json only", async ({ page }) => {
    await page.goto('about:blank');

    const response = await page.evaluate(async (port) => {
      const resp = await fetch(`http://localhost:${port}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });
      return {
        status: resp.status,
        contentType: resp.headers.get('Content-Type'),
        body: await resp.text()
      };
    }, TRAEFIK_HTTP_PORT);

    expect(response.status).toBe(401);
    expect(response.contentType).toContain('application/json');
  });

  test("should redirect for regular browser navigation without XHR headers", async ({ page }) => {
    // Navigate to a protected resource without XHR headers - should redirect to login
    const response = await page.goto(`http://localhost:${TRAEFIK_HTTP_PORT}`, {
      waitUntil: 'networkidle'
    });

    // Should be redirected to Keycloak login page
    expect(response?.url()).toContain('/realms/master/protocol/openid-connect/auth');
  });

  test("should not return JSON problem details when Accept includes both JSON and HTML", async ({ page }) => {
    await page.goto('about:blank');

    const response = await page.evaluate(async (port) => {
      const resp = await fetch(`http://localhost:${port}`, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/json'
        }
      });
      return {
        status: resp.status,
        contentType: resp.headers.get('Content-Type'),
        redirected: resp.redirected
      };
    }, TRAEFIK_HTTP_PORT);

    // Should either redirect or return HTML, not JSON problem details
    expect(response.contentType).not.toContain('application/json+problem');
  });

  test("should detect headers case-insensitively", async ({ page }) => {
    await page.goto('about:blank');

    const response = await page.evaluate(async (port) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `http://localhost:${port}`, false);
      // Use lowercase header name
      xhr.setRequestHeader('x-requested-with', 'xmlhttprequest');
      xhr.send();
      return {
        status: xhr.status,
        contentType: xhr.getResponseHeader('Content-Type')
      };
    }, TRAEFIK_HTTP_PORT);

    expect(response.status).toBe(401);
    expect(response.contentType).toContain('application/json');
  });

  test("should handle XHR request with authentication gracefully", async ({ page }) => {
    // First login
    await expectGotoOkay(page, `http://localhost:${TRAEFIK_HTTP_PORT}`);
    await login(page, "admin", "admin", `http://localhost:${TRAEFIK_HTTP_PORT}`);

    // Now make an XHR request with valid session
    const response = await page.evaluate(async (port) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `http://localhost:${port}`, false);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.send();
      return {
        status: xhr.status,
        contentType: xhr.getResponseHeader('Content-Type'),
        body: xhr.responseText
      };
    }, TRAEFIK_HTTP_PORT);

    // Should get the actual content, not JSON error
    expect(response.status).toBe(200);
    expect(response.contentType).not.toContain('application/json+problem');
  });
});

//-----------------------------------------------------------------------------
// Helper functions
//-----------------------------------------------------------------------------

async function login(page: Page, username: string, password: string, waitForUrl: string): Promise<Response> {
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);

  const responsePromise = page.waitForResponse(waitForUrl);

  await page.locator('#kc-login').click();

  const response = await responsePromise;

  return response;
}

async function expectGotoOkay(page: Page, url: string) {
  const response = await page.goto(url); // follows redirects
  expect(response?.status()).toBe(200);
}

async function loginAndGetToken(page: Page, username: string, password: string): Promise<string> {
  const tokenResponse = await fetch(`http://localhost:${KEYCLOAK_HTTP_PORT}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers:{
      "Content-Type": "application/x-www-form-urlencoded"
    },    
    body: new URLSearchParams({
        "grant_type": "password",
        "username": username,
        "password": password,
        "client_id": "traefik",
        "client_secret": "LQslcjK8ZeRrrhW7jKaFUUous9W5QvCr",
        "scope": "openid profile email"
    })
  });

  const tokens = await tokenResponse.json();

  console.log("Using token:", tokens.id_token);

  return tokens.id_token;
}
