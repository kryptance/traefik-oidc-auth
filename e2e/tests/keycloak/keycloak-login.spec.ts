import { test, expect, Page, Response } from "@playwright/test";
import * as dockerCompose from "docker-compose";
import { configureTraefik } from "../../utils";

//-----------------------------------------------------------------------------
// Test Setup
//-----------------------------------------------------------------------------

test.use({
  ignoreHTTPSErrors: true
});

test.beforeAll("Starting traefik with Keycloak", async () => {
  test.setTimeout(60000); // Increase timeout for container startup
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
            Url: "\${PROVIDER_URL}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
          Scopes:
            - openid
            - profile
            - email
            - roles
          Headers:
            - Name: "X-Oidc-Subject"
              Value: "{{\`{{ .claims.sub }}\`}}"
            - Name: "X-Oidc-Email"
              Value: "{{\`{{ .claims.email }}\`}}"
            - Name: "X-Oidc-PreferredUsername"
              Value: "{{\`{{ .claims.preferred_username }}\`}}"
            - Name: "X-Oidc-Name"
              Value: "{{\`{{ .claims.name }}\`}}"
            - Name: "X-Oidc-Roles"
              Value: "{{\`{{ .claims.realm_access.roles }}\`}}"
    
    oidc-auth-admin:
      plugin:
        traefik-oidc-auth:
          LogLevel: DEBUG
          Provider:
            Url: "\${PROVIDER_URL}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
          Scopes:
            - openid
            - profile
            - email
            - roles
          Headers:
            - Name: "X-Oidc-Subject"
              Value: "{{\`{{ .claims.sub }}\`}}"
            - Name: "X-Oidc-Email"
              Value: "{{\`{{ .claims.email }}\`}}"
            - Name: "X-Oidc-PreferredUsername"
              Value: "{{\`{{ .claims.preferred_username }}\`}}"
            - Name: "X-Oidc-Name"
              Value: "{{\`{{ .claims.name }}\`}}"
            - Name: "X-Oidc-Roles"
              Value: "{{\`{{ .claims.realm_access.roles }}\`}}"
          Authorization:
            AssertClaims:
              - Name: realm_access.roles
                AnyOf: ["admin"]
    
    oidc-auth-users:
      plugin:
        traefik-oidc-auth:
          LogLevel: DEBUG
          Provider:
            Url: "\${PROVIDER_URL}"
            ClientId: "\${CLIENT_ID}"
            ClientSecret: "\${CLIENT_SECRET}"
          Scopes:
            - openid
            - profile
            - email
            - roles
          Headers:
            - Name: "X-Oidc-Subject"
              Value: "{{\`{{ .claims.sub }}\`}}"
            - Name: "X-Oidc-Email"
              Value: "{{\`{{ .claims.email }}\`}}"
            - Name: "X-Oidc-PreferredUsername"
              Value: "{{\`{{ .claims.preferred_username }}\`}}"
            - Name: "X-Oidc-Name"
              Value: "{{\`{{ .claims.name }}\`}}"
            - Name: "X-Oidc-Roles"
              Value: "{{\`{{ .claims.realm_access.roles }}\`}}"
          Authorization:
            AssertClaims:
              - Name: realm_access.roles
                AnyOf: ["user"]

  routers:
    whoami:
      entryPoints: ["web"]
      rule: Host("whoami.localhost")
      service: whoami
      middlewares: ["oidc-auth@file"]
      
    admin-only:
      entryPoints: ["web"]
      rule: Host("admin.localhost")
      service: whoami
      middlewares: ["oidc-auth-admin@file"]
      
    users-only:
      entryPoints: ["web"]
      rule: Host("users.localhost")
      service: whoami
      middlewares: ["oidc-auth-users@file"]
`);

  await dockerCompose.upAll({
    cwd: __dirname,
    log: false
  });
  
  // Wait for Keycloak to be ready
  await new Promise(resolve => setTimeout(resolve, 15000));
});

test.afterAll("Stopping traefik", async () => {
  await dockerCompose.down({
    cwd: __dirname,
    log: false
  });
});

//-----------------------------------------------------------------------------
// Helpers
//-----------------------------------------------------------------------------

async function keycloakLogin(page: Page, username: string, password: string) {
  // Wait for Keycloak login page
  await expect(page).toHaveURL(/.*realms.*auth.*/, { timeout: 10000 });
  
  // Fill in credentials
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  
  // Wait for redirect back
  await expect(page).not.toHaveURL(/.*auth.*/);
}

async function expectWhoamiPage(page: Page, expectedUser?: string) {
  const content = await page.locator("body").textContent();
  expect(content).toContain("Hostname:");
  
  if (expectedUser) {
    // Verify the user info is in headers
    // Check for email header which includes the username
    expect(content).toMatch(new RegExp(`X-Oidc-Email: ${expectedUser}@example.com`, 'i'));
  }
}

//-----------------------------------------------------------------------------
// Tests
//-----------------------------------------------------------------------------

test.describe("Keycloak Authentication", () => {
  test("should redirect to Keycloak for authentication", async ({ page }) => {
    await page.goto("http://whoami.localhost:9080");
    
    // Should redirect to Keycloak
    await expect(page).toHaveURL(/.*realms.*auth.*/, { timeout: 10000 });
    
    // Verify we're on the login page
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
  });

  test("should authenticate admin user", async ({ page }) => {
    await page.goto("http://whoami.localhost:9080");
    
    // Login as admin
    await keycloakLogin(page, "admin", "admin123");
    
    // Should be redirected to whoami
    await expect(page).toHaveURL("http://whoami.localhost:9080/");
    await expectWhoamiPage(page, "admin");
  });

  test("should authenticate regular user", async ({ page }) => {
    await page.goto("http://whoami.localhost:9080");
    
    // Login as alice
    await keycloakLogin(page, "alice", "alice123");
    
    // Should be redirected to whoami
    await expect(page).toHaveURL("http://whoami.localhost:9080/");
    await expectWhoamiPage(page, "alice");
  });

  test("should maintain session across requests", async ({ page }) => {
    // First request - login
    await page.goto("http://whoami.localhost:9080");
    await keycloakLogin(page, "bob", "bob123");
    await expectWhoamiPage(page, "bob");
    
    // Second request - should not require login
    await page.goto("http://whoami.localhost:9080/api/test");
    await expectWhoamiPage(page, "bob");
    
    // Verify no redirect to Keycloak
    expect(page.url()).not.toMatch(/.*realms.*auth.*/);
  });
});

test.describe("Keycloak Authorization", () => {
  test("admin should access admin-only route", async ({ page }) => {
    await page.goto("http://admin.localhost:9080");
    
    // Login as admin
    await keycloakLogin(page, "admin", "admin123");
    
    // Should be able to access
    await expect(page).toHaveURL("http://admin.localhost:9080/");
    await expectWhoamiPage(page, "admin");
  });

  test("regular user should be denied admin-only route", async ({ page }) => {
    await page.goto("http://admin.localhost:9080");
    
    // Login as alice (regular user)
    await keycloakLogin(page, "alice", "alice123");
    
    // Should get 403 Forbidden
    await expect(page.locator("body")).toContainText("403");
  });

  test("all users should access user route", async ({ page, context }) => {
    // Test with admin
    const adminPage = await context.newPage();
    await adminPage.goto("http://users.localhost:9080");
    await keycloakLogin(adminPage, "admin", "admin123");
    await expectWhoamiPage(adminPage, "admin");
    await adminPage.close();
    
    // Test with regular user in new context
    const userContext = await page.context().browser()?.newContext();
    if (!userContext) throw new Error("Failed to create context");
    
    const userPage = await userContext.newPage();
    await userPage.goto("http://users.localhost:9080");
    await keycloakLogin(userPage, "alice", "alice123");
    await expectWhoamiPage(userPage, "alice");
    
    await userContext.close();
  });
});

test.describe("Keycloak Logout", () => {
  test("should logout and require re-authentication", async ({ page }) => {
    // Login first
    await page.goto("http://whoami.localhost:9080");
    await keycloakLogin(page, "admin", "admin123");
    await expectWhoamiPage(page, "admin");
    
    // Logout
    await page.goto("http://whoami.localhost:9080/logout");
    
    // Try to access protected resource again
    await page.goto("http://whoami.localhost:9080");
    
    // Should redirect to Keycloak login
    await expect(page).toHaveURL(/.*realms.*auth.*/, { timeout: 10000 });
  });
});

test.describe("Keycloak Token Claims", () => {
  test("should pass user attributes in headers", async ({ page }) => {
    await page.goto("http://whoami.localhost:9080");
    await keycloakLogin(page, "admin", "admin123");
    
    const content = await page.locator("body").textContent();
    
    // Check for various claims that should be present
    expect(content).toContain("X-Oidc-"); // Headers should be present
    
    // Admin should have admin role
    expect(content).toMatch(/X-Oidc-Roles:.*admin/i);
  });

  test("should handle groups claim", async ({ page }) => {
    await page.goto("http://whoami.localhost:9080");
    await keycloakLogin(page, "alice", "alice123");
    
    const content = await page.locator("body").textContent();
    
    // Alice should be in users group
    expect(content).toMatch(/X-Oidc-.*alice/i);
  });
});
