import { test, expect, Page, Response } from "@playwright/test";
import * as dockerCompose from "docker-compose";
import { configureTraefik, setTraefikApiPort } from "../../utils";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { setupKeycloak } from "./setup-keycloak";

const execAsync = promisify(exec);

// Helper function to wait for Traefik to be ready after configuration changes
async function waitForTraefikReady() {
  console.log("Checking Traefik readiness...");

  // Check container health
  try {
    const containerStatus = await execAsync(`docker ps --filter name=${traefikContainer || 'keycloak_traefik_1'} --format '{{.Status}}'`);
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
let DOCKER_HOST: string = 'localhost'; // Will be determined dynamically
let keycloakContainer: string; // Container name for keycloak
let traefikContainer: string; // Container name for traefik

// Wrap all tests in a describe block to ensure they share the same setup
test.describe("Keycloak OIDC Auth Tests", () => {

// Helper function to wait for Traefik to be ready with specific configuration
async function waitForTraefikReady(maxWaitMs = 30000) {
  console.log("Verifying Traefik is ready with current configuration...");

  const startTime = Date.now();
  let attempts = 0;
  let pollInterval = 250; // Start with 250ms
  const maxPollInterval = 2000;

  while ((Date.now() - startTime) < maxWaitMs) {
    attempts++;

    try {
      // Parallel check of both API and HTTP endpoints
      const [apiResult, httpResult] = await Promise.allSettled([
        fetch(`http://localhost:${TRAEFIK_API_PORT}/api/overview`, {
          signal: AbortSignal.timeout(2000)
        }),
        fetch(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(2000)
        })
      ]);

      // Both checks must pass
      if (apiResult.status === 'fulfilled' && apiResult.value.ok &&
          httpResult.status === 'fulfilled' &&
          (httpResult.value.status === 401 || httpResult.value.status === 302)) {

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`✅ Traefik is ready and middleware is active! (${attempts} attempts in ${elapsed}s)`);
        return true;
      }

      // Log status periodically
      if (attempts % 10 === 0) {
        console.log(`Traefik config check #${attempts}:
  - API: ${apiResult.status === 'fulfilled' ? `HTTP ${apiResult.value.status}` : 'Failed'}
  - HTTP: ${httpResult.status === 'fulfilled' ? `HTTP ${httpResult.value.status}` : 'Failed'}`);
      }
    } catch (e) {
      // Silent catch - we'll handle timeout below
    }

    // Wait with exponential backoff
    await new Promise(r => setTimeout(r, pollInterval));
    pollInterval = Math.min(pollInterval * 1.3, maxPollInterval);
  }

  // Timeout reached
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.error(`Traefik readiness check timed out after ${attempts} attempts over ${elapsed}s`);
  throw new Error(`Traefik did not become ready within ${maxWaitMs / 1000} seconds`);
}

// Helper function to get container port
async function getContainerPort(containerName: string, internalPort: number): Promise<number> {
  const { stdout } = await execAsync(
    `docker port ${containerName} ${internalPort} | cut -d: -f2`
  );
  return parseInt(stdout.trim());
}

// Helper function to get the host IP that works for accessing Docker containers
async function getDockerHostIP(): Promise<string> {
  // Try different options in order of preference
  const options = [
    'localhost',
    '127.0.0.1',
    'host.docker.internal',
    '172.17.0.1', // Default Docker bridge gateway
  ];

  // If running on Linux, try to get the main network interface IP
  try {
    const { stdout } = await execAsync("ip -4 addr show | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}' | grep -v '127.0.0.1' | head -1");
    const hostIP = stdout.trim();
    if (hostIP) {
      options.push(hostIP);
    }
  } catch (e) {
    // Ignore error, use default options
  }

  console.log(`Testing connectivity with options: ${options.join(', ')}`);

  // Test each option with a simple fetch to see which one works
  for (const host of options) {
    try {
      // Just test if we can connect to port 1 (will fail but differently if host is reachable)
      await fetch(`http://${host}:1`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(100)
      });
    } catch (e) {
      // ECONNREFUSED means the host is reachable but port is closed (good)
      // Timeout or other errors mean host is not reachable
      if (e.cause?.code === 'ECONNREFUSED' || e.message.includes('ECONNREFUSED')) {
        console.log(`Found working host: ${host}`);
        return host;
      }
    }
  }

  // Default to localhost if nothing else works
  console.log('Defaulting to localhost');
  return 'localhost';
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

  // Set environment variables for docker-compose
  const certPath = process.env.CERT_PATH || __dirname;
  const env = {
    ...process.env,
    CERT_PATH: certPath,
    TRAEFIK_CONFIG_PATH: process.env.TRAEFIK_CONFIG_PATH || `${__dirname}/../../../workspaces/configs`,
    PLUGIN_PATH: process.env.PLUGIN_PATH || `${__dirname}/../../..`,
    HTTP_CONFIG_PATH: process.env.HTTP_CONFIG_PATH || `${__dirname}/../..`,
    DATA_PATH: process.env.DATA_PATH || __dirname,
  };

  // Remove docker-compose.override.yml if it exists to ensure clean state
  const overrideFile = path.join(__dirname, 'docker-compose.override.yml');
  if (fs.existsSync(overrideFile)) {
    fs.unlinkSync(overrideFile);
    console.log('Removed docker-compose.override.yml for clean state');
  }

  // Note: Running without HTTPS to avoid Docker-in-Docker volume mount issues
  console.log('Running tests in HTTP-only mode');

  await dockerCompose.upAll({
    cwd: __dirname,
    log: true,
    env: env
  });

  // Get the dynamically assigned ports
  console.log("Getting dynamic ports...");
  // Try both naming conventions (docker-compose v1 uses _, v2 uses -)
  keycloakContainer = await execAsync("docker ps --format '{{.Names}}' | grep -E 'keycloak.keycloak.1' | head -1").then(r => r.stdout.trim()).catch(() => "keycloak_keycloak_1");
  traefikContainer = await execAsync("docker ps --format '{{.Names}}' | grep -E 'keycloak.traefik.1' | head -1").then(r => r.stdout.trim()).catch(() => "keycloak_traefik_1");

  console.log(`Container names: ${keycloakContainer}, ${traefikContainer}`);

  KEYCLOAK_HTTP_PORT = await getContainerPort(keycloakContainer, 8080);
  KEYCLOAK_HTTPS_PORT = await getContainerPort(keycloakContainer, 8443);
  KEYCLOAK_HEALTH_PORT = await getContainerPort(keycloakContainer, 9000);
  TRAEFIK_HTTP_PORT = await getContainerPort(traefikContainer, 80);
  TRAEFIK_HTTPS_PORT = await getContainerPort(traefikContainer, 443);
  TRAEFIK_API_PORT = await getContainerPort(traefikContainer, 8080);

  console.log(`Dynamic ports assigned:
    Keycloak HTTP: ${KEYCLOAK_HTTP_PORT}
    Keycloak HTTPS: ${KEYCLOAK_HTTPS_PORT}
    Keycloak Health: ${KEYCLOAK_HEALTH_PORT}
    Traefik HTTP: ${TRAEFIK_HTTP_PORT}
    Traefik HTTPS: ${TRAEFIK_HTTPS_PORT}
    Traefik API: ${TRAEFIK_API_PORT}
  `);

  // Set the Traefik API port for utils to use
  setTraefikApiPort(TRAEFIK_API_PORT);

  // Determine the best host IP for accessing Docker containers
  DOCKER_HOST = await getDockerHostIP();
  console.log(`Using Docker host: ${DOCKER_HOST}`);

  // Update Keycloak hostname environment variable
  await execAsync(`docker exec ${keycloakContainer} sh -c "export KC_HOSTNAME=http://localhost:${KEYCLOAK_HTTP_PORT}"`);

  // Wait for Keycloak to start with intelligent polling
  console.log("Waiting for Keycloak to start...");
  const maxWaitTime = 120000; // 120 seconds total
  const startTime = Date.now();
  let lastError: any = null;
  let attempts = 0;
  let keycloakReady = false;

  // Use exponential backoff: start with 500ms, max 5s between checks
  let pollInterval = 500;
  const maxPollInterval = 5000;

  while (!keycloakReady && (Date.now() - startTime) < maxWaitTime) {
    attempts++;

    try {
      // First check if container is healthy via docker
      const containerHealth = await execAsync(`docker inspect ${keycloakContainer} --format='{{.State.Health.Status}}'`).catch(() => ({ stdout: 'unknown' }));
      const healthStatus = containerHealth.stdout.trim();

      // Log status periodically
      if (attempts % 5 === 0 || attempts === 1) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`Keycloak status check #${attempts} (${elapsed}s elapsed, health: ${healthStatus})`);
      }

      // Try multiple endpoints to determine readiness
      const checks = await Promise.allSettled([
        // Check OpenID configuration endpoint
        fetch(`http://localhost:${KEYCLOAK_HTTP_PORT}/realms/master/.well-known/openid-configuration`, {
          signal: AbortSignal.timeout(2000)
        }),
        // Check health endpoint
        fetch(`http://localhost:${KEYCLOAK_HTTP_PORT}/health/ready`, {
          signal: AbortSignal.timeout(2000)
        }).catch(() => null), // Health endpoint might not exist
        // Check base URL
        fetch(`http://localhost:${KEYCLOAK_HTTP_PORT}/`, {
          signal: AbortSignal.timeout(2000)
        })
      ]);

      const oidcCheck = checks[0];
      const healthCheck = checks[1];
      const baseCheck = checks[2];

      // Keycloak is ready if OpenID configuration is accessible
      if (oidcCheck.status === 'fulfilled' && oidcCheck.value.ok) {
        console.log(`✅ Keycloak is ready! (took ${attempts} attempts, ${Math.round((Date.now() - startTime) / 1000)}s)`);

        // Quick verification that it's actually responding correctly
        const configData = await oidcCheck.value.json();
        if (configData.issuer) {
          console.log(`Keycloak issuer: ${configData.issuer}`);
          keycloakReady = true;

          // Setup Keycloak client for tests
          try {
            await setupKeycloak(KEYCLOAK_HTTP_PORT);
          } catch (error) {
            console.warn('Failed to setup Keycloak client (continuing anyway):', error.message);
          }

          break;
        }
      }

      // Log detailed status for debugging
      if (attempts === 1 || attempts % 10 === 0) {
        console.log(`Keycloak endpoints status:
  - OpenID Config: ${oidcCheck.status === 'fulfilled' ? `HTTP ${oidcCheck.value.status}` : 'Failed'}
  - Health Ready: ${healthCheck.status === 'fulfilled' && healthCheck.value ? `HTTP ${healthCheck.value.status}` : 'N/A'}
  - Base URL: ${baseCheck.status === 'fulfilled' ? `HTTP ${baseCheck.value.status}` : 'Failed'}`);
      }

      lastError = oidcCheck.status === 'rejected' ? oidcCheck.reason : 'Not ready yet';
    } catch (e) {
      lastError = e;
      // Only log unexpected errors
      if (attempts === 1) {
        console.log(`Initial connection attempt failed (this is normal): ${e.message}`);
      }
    }

    if (!keycloakReady) {
      // Wait before next attempt with exponential backoff
      await new Promise(r => setTimeout(r, pollInterval));
      pollInterval = Math.min(pollInterval * 1.5, maxPollInterval);
    }
  }

  if (!keycloakReady) {
    console.error(`Keycloak failed to start after ${attempts} attempts over ${Math.round((Date.now() - startTime) / 1000)}s`);
    console.error(`Last error: ${lastError}`);

    // Get container logs for debugging
    try {
      const logs = await execAsync(`docker logs ${keycloakContainer} --tail 50 2>&1`);
      console.error("Keycloak container logs (last 50 lines):");
      console.error(logs.stdout);
    } catch (e) {
      console.error("Could not retrieve Keycloak logs");
    }

    throw new Error(`Keycloak did not become ready within ${maxWaitTime / 1000} seconds. Last error: ${lastError}`);
  }

  // Wait for Traefik to be ready with intelligent polling
  console.log("Waiting for Traefik to start...");
  const traefikMaxWait = 60000; // 60 seconds
  const traefikStartTime = Date.now();
  let traefikReady = false;
  let traefikAttempts = 0;
  let traefikPollInterval = 500;
  let traefikLastError: any = null;

  while (!traefikReady && (Date.now() - traefikStartTime) < traefikMaxWait) {
    traefikAttempts++;

    try {
      // Check container status
      const containerStatus = await execAsync(`docker ps --filter name=${traefikContainer || 'keycloak_traefik_1'} --format '{{.Status}}'`).catch(() => ({ stdout: '' }));
      const statusText = containerStatus.stdout.trim();

      if (traefikAttempts % 5 === 0 || traefikAttempts === 1) {
        const elapsed = Math.round((Date.now() - traefikStartTime) / 1000);
        console.log(`Traefik status check #${traefikAttempts} (${elapsed}s elapsed): ${statusText || 'checking...'}`);
      }

      // Check Traefik API endpoint
      const apiResponse = await fetch(`http://localhost:${TRAEFIK_API_PORT}/api/overview`, {
        signal: AbortSignal.timeout(2000)
      });

      if (apiResponse.ok) {
        const apiData = await apiResponse.json();
        console.log(`✅ Traefik API is ready! (took ${traefikAttempts} attempts, ${Math.round((Date.now() - traefikStartTime) / 1000)}s)`);
        console.log(`  Routers: ${apiData.http?.routers?.total || 0}, Middlewares: ${apiData.http?.middlewares?.total || 0}`);
        traefikReady = true;
      }
    } catch (e) {
      traefikLastError = e;
      if (traefikAttempts === 1) {
        console.log(`Initial Traefik connection attempt failed (this is normal): ${e.message}`);
      }
    }

    if (!traefikReady) {
      await new Promise(r => setTimeout(r, traefikPollInterval));
      traefikPollInterval = Math.min(traefikPollInterval * 1.5, 3000); // Max 3s between checks
    }
  }

  if (!traefikReady) {
    console.warn(`Traefik API not fully ready after ${Math.round((Date.now() - traefikStartTime) / 1000)}s, but continuing...`);
  }

  // Verify Traefik is ready with the initial configuration
  await waitForTraefikReady(30000); // 30 seconds timeout

  console.log("All services are ready!");

  // IMPORTANT: Add extra wait for Docker iptables rules to fully propagate
  // This is a Linux-specific issue where the port forwarding rules take time to be fully available
  console.log("Waiting for Docker network rules to stabilize...");
  await new Promise(r => setTimeout(r, 3000));

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
  // First check if containers are actually running
  try {
    const containerCheck = await execAsync(`docker ps --filter name=${traefikContainer || 'keycloak_traefik_1'} --format '{{.Status}}'`);
    console.log(`Traefik container status: ${containerCheck.stdout.trim()}`);

    if (!containerCheck.stdout.includes("Up")) {
      throw new Error("Traefik container is not running!");
    }
  } catch (e) {
    console.error("Container check failed:", e);
    throw e;
  }

  // Verify Traefik is still healthy before each test
  await waitForTraefikReady(10, 500);
});

test.afterEach("Traefik logs on test failure", async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    console.log(`${testInfo.title} failed, here are Traefik logs:`);
    console.log(await dockerCompose.logs("traefik", { cwd: __dirname }));
    console.log(await dockerCompose.logs("keycloak", { cwd: __dirname }));
  }
});

test.afterAll("Stopping traefik", async () => {
  // Use same environment variables for docker-compose down
  const env = {
    ...process.env,
    CERT_PATH: process.env.CERT_PATH || __dirname,
    TRAEFIK_CONFIG_PATH: process.env.TRAEFIK_CONFIG_PATH || `${__dirname}/../../../workspaces/configs`,
    PLUGIN_PATH: process.env.PLUGIN_PATH || `${__dirname}/../../..`,
    HTTP_CONFIG_PATH: process.env.HTTP_CONFIG_PATH || `${__dirname}/../..`,
    DATA_PATH: process.env.DATA_PATH || __dirname,
  };

  await dockerCompose.downAll({
    cwd: __dirname,
    log: true,
    env: env
  });
});

//-----------------------------------------------------------------------------
// Tests
//-----------------------------------------------------------------------------

test("login http", async ({ page }) => {
  test.setTimeout(120000); // Set test timeout to 2 minutes

  // Use the pre-determined Docker host
  const url = `http://${DOCKER_HOST}:${TRAEFIK_HTTP_PORT}`;
  console.log(`Attempting to navigate to ${url}`);

  // Verify port variable is set
  if (!TRAEFIK_HTTP_PORT) {
    throw new Error("TRAEFIK_HTTP_PORT is not set! Container setup may have failed.");
  }

  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // Try to navigate
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 5000
      });
      console.log("Navigation successful!");
      break; // Success, exit loop
    } catch (error) {
      lastError = error;
      console.log(`Navigation attempt ${attempt} failed: ${error.message}`);

      if (attempt < 5) {
        // Wait before retry
        console.log("Waiting 2 seconds before retry...");
        await new Promise(r => setTimeout(r, 2000));

        // Double-check port is still accessible from Node.js
        try {
          const checkResponse = await fetch(`http://localhost:${TRAEFIK_HTTP_PORT}/`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(1000)
          });
          console.log(`Node.js port check returned status: ${checkResponse.status}`);

          // Also try 127.0.0.1
          const checkResponse2 = await fetch(`http://127.0.0.1:${TRAEFIK_HTTP_PORT}/`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(1000)
          });
          console.log(`Node.js 127.0.0.1 check returned status: ${checkResponse2.status}`);
        } catch (e) {
          console.log(`Node.js port check failed: ${e.message}`);
        }
      }
    }
  }

  // If all attempts failed, throw the last error
  if (lastError) {
    throw lastError;
  }

  // Now check the status
  const currentUrl = page.url();
  expect(currentUrl).toContain('/realms/master/protocol/openid-connect/auth');

  const response = await login(page, "admin", "admin", `http://localhost:${TRAEFIK_HTTP_PORT}`);

  expect(response.status()).toBe(200);
});

test("login https", async ({ browser }) => {
  test.setTimeout(120000); // Set test timeout to 2 minutes

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
    const containerStatus = await execAsync(`docker ps --filter name=${traefikContainer || 'keycloak_traefik_1'} --format '{{.Status}}'`);
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
}); // End of describe block
