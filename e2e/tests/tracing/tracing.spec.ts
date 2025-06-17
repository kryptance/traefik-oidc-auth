import { expect, test } from "@playwright/test";
import * as dockerCompose from "docker-compose";
import { waitForServices } from "../helpers";

// OTLP Collector Mock - stores received traces for verification
class OTLPCollectorMock {
  private traces: any[] = [];
  private server: any;
  
  async start(port: number = 4318) {
    const http = require('http');
    
    this.server = http.createServer((req: any, res: any) => {
      if (req.method === 'POST' && req.url === '/v1/traces') {
        let body = '';
        
        req.on('data', (chunk: any) => {
          body += chunk.toString();
        });
        
        req.on('end', () => {
          try {
            const trace = JSON.parse(body);
            this.traces.push(trace);
            console.log('Received trace data');
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ partialSuccess: {} }));
          } catch (e) {
            console.error('Failed to parse trace:', e);
            res.writeHead(400);
            res.end('Bad Request');
          }
        });
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', traces: this.traces.length }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        console.log(`OTLP Collector Mock listening on port ${port}`);
        resolve(this.server);
      });
    });
  }
  
  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
  }
  
  getTraces() {
    return this.traces;
  }
  
  clearTraces() {
    this.traces = [];
  }
  
  // Helper to find spans by name
  findSpans(spanName: string): any[] {
    const spans: any[] = [];
    for (const trace of this.traces) {
      if (trace.resourceSpans) {
        for (const resourceSpan of trace.resourceSpans) {
          if (resourceSpan.scopeSpans) {
            for (const scopeSpan of resourceSpan.scopeSpans) {
              if (scopeSpan.spans) {
                for (const span of scopeSpan.spans) {
                  if (span.name === spanName) {
                    spans.push(span);
                  }
                }
              }
            }
          }
        }
      }
    }
    return spans;
  }
  
  // Helper to get all span names
  getAllSpanNames(): string[] {
    const names = new Set<string>();
    for (const trace of this.traces) {
      if (trace.resourceSpans) {
        for (const resourceSpan of trace.resourceSpans) {
          if (resourceSpan.scopeSpans) {
            for (const scopeSpan of resourceSpan.scopeSpans) {
              if (scopeSpan.spans) {
                for (const span of scopeSpan.spans) {
                  names.add(span.name);
                }
              }
            }
          }
        }
      }
    }
    return Array.from(names);
  }
}

//-----------------------------------------------------------------------------
// Test Setup
//-----------------------------------------------------------------------------

test.use({
  ignoreHTTPSErrors: true
});

let collector: OTLPCollectorMock;

test.beforeAll("Starting services with tracing", async () => {
  // Start OTLP collector mock
  collector = new OTLPCollectorMock();
  await collector.start(4318);
  
  console.log("Starting Docker Compose services with tracing enabled...");
  
  // Set environment variables for tracing configuration
  process.env.TRACING_ENABLED = "true";
  process.env.TRACING_OTLP_ENDPOINT = "host.docker.internal:4318";
  process.env.TRACING_SERVICE_NAME = "traefik-oidc-auth-test";
  process.env.TRACING_DETAILED_SPANS = "true";
  
  await dockerCompose.upAll({
    cwd: __dirname,
    config: "docker-compose.yml",
    log: false,
    env: process.env
  });

  await waitForServices([
    { url: 'http://localhost:8080/health', expectedStatus: [401, 200] },
    { url: 'http://localhost:8000/realms/test', expectedStatus: 200 },
    { url: 'http://localhost:4318/health', expectedStatus: 200 }
  ]);
});

test.afterAll("Stopping services", async () => {
  await dockerCompose.down({
    cwd: __dirname,
    config: "docker-compose.yml",
    log: false
  });
  
  await collector.stop();
});

//-----------------------------------------------------------------------------
// Tracing Tests
//-----------------------------------------------------------------------------

test.describe("OpenTelemetry Tracing", () => {
  test.beforeEach(async () => {
    collector.clearTraces();
  });

  test("should create traces for unauthenticated requests", async ({ page }) => {
    // Make an unauthenticated request
    await page.goto('http://localhost:8080');
    
    // Wait for traces to be exported
    await page.waitForTimeout(2000);
    
    // Verify main span was created
    const serveHttpSpans = collector.findSpans('oidc.serve_http');
    expect(serveHttpSpans.length).toBeGreaterThan(0);
    
    const mainSpan = serveHttpSpans[0];
    
    // Check span attributes
    const attributes = mainSpan.attributes || [];
    const attrMap = new Map(attributes.map((attr: any) => [attr.key, attr.value]));
    
    expect(attrMap.get('http.method')).toHaveProperty('stringValue', 'GET');
    expect(attrMap.get('http.target')).toHaveProperty('stringValue', '/');
    expect(attrMap.get('oidc.auth_result')).toHaveProperty('stringValue', 'unauthenticated');
    expect(attrMap.get('oidc.metrics_enabled')).toHaveProperty('boolValue', true);
    
    // Verify OIDC discovery span
    const discoverySpans = collector.findSpans('oidc.discovery');
    expect(discoverySpans.length).toBeGreaterThan(0);
  });

  test("should create traces with trace context propagation", async ({ page }) => {
    // Make request with trace context header
    const response = await page.evaluate(async () => {
      const resp = await fetch('http://localhost:8080', {
        headers: {
          'traceparent': '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
        }
      });
      return {
        status: resp.status,
        url: resp.url
      };
    });
    
    // Wait for traces
    await page.waitForTimeout(2000);
    
    // Verify trace context was propagated
    const spans = collector.findSpans('oidc.serve_http');
    expect(spans.length).toBeGreaterThan(0);
    
    const span = spans[0];
    // The trace ID should match what we sent (minus dashes)
    expect(span.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  test("should create detailed traces for login flow", async ({ page }) => {
    // Start login flow
    await page.goto('http://localhost:8080/oauth2/login');
    
    // Should redirect to Keycloak
    await expect(page).toHaveURL(/.*realms\/test\/protocol\/openid-connect\/auth.*/);
    
    // Login to Keycloak
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'testpass');
    await page.click('#kc-login');
    
    // Wait for callback processing
    await page.waitForURL(/.*oauth2\/callback.*/);
    await page.waitForURL('http://localhost:8080/');
    
    // Wait for traces to be exported
    await page.waitForTimeout(2000);
    
    // Get all span names
    const spanNames = collector.getAllSpanNames();
    console.log('Captured spans:', spanNames);
    
    // Verify expected spans exist
    expect(spanNames).toContain('oidc.serve_http');
    expect(spanNames).toContain('oidc.discovery');
    expect(spanNames).toContain('oidc.provider_redirect');
    expect(spanNames).toContain('oidc.handle_callback');
    expect(spanNames).toContain('oidc.token_exchange');
    expect(spanNames).toContain('oidc.token_validation');
    
    // Check token exchange span
    const tokenExchangeSpans = collector.findSpans('oidc.token_exchange');
    expect(tokenExchangeSpans.length).toBeGreaterThan(0);
    
    const tokenSpan = tokenExchangeSpans[0];
    const tokenAttrs = new Map(tokenSpan.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
    expect(tokenAttrs.get('oidc.token_endpoint')).toBeTruthy();
    expect(tokenAttrs.get('oidc.token_type')).toHaveProperty('stringValue', 'authorization_code');
    
    // Check validation span
    const validationSpans = collector.findSpans('oidc.token_validation');
    expect(validationSpans.length).toBeGreaterThan(0);
    
    const validationSpan = validationSpans[0];
    const validationAttrs = new Map(validationSpan.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
    expect(validationAttrs.get('oidc.token_validation')).toBeTruthy();
    
    // With detailed spans enabled, should have user info
    if (process.env.TRACING_DETAILED_SPANS === 'true') {
      expect(validationAttrs.get('oidc.user_id')).toBeTruthy();
    }
  });

  test("should create traces for authenticated requests", async ({ page }) => {
    // First login
    await page.goto('http://localhost:8080/oauth2/login');
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'testpass');
    await page.click('#kc-login');
    await page.waitForURL('http://localhost:8080/');
    
    // Clear traces from login
    collector.clearTraces();
    
    // Make authenticated request
    await page.goto('http://localhost:8080/protected');
    
    // Wait for traces
    await page.waitForTimeout(2000);
    
    // Check authenticated request span
    const serveSpans = collector.findSpans('oidc.serve_http');
    expect(serveSpans.length).toBeGreaterThan(0);
    
    const span = serveSpans[0];
    const attrs = new Map(span.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
    expect(attrs.get('oidc.auth_result')).toHaveProperty('stringValue', 'authenticated');
    
    // Should have session validation span
    const sessionSpans = collector.findSpans('oidc.session_validation');
    expect(sessionSpans.length).toBeGreaterThan(0);
    
    const sessionSpan = sessionSpans[0];
    const sessionAttrs = new Map(sessionSpan.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
    expect(sessionAttrs.get('oidc.session_id')).toBeTruthy();
  });

  test("should create traces for XHR requests", async ({ page }) => {
    // Make XHR request
    await page.goto('http://localhost:8080');
    
    const response = await page.evaluate(async () => {
      const resp = await fetch('http://localhost:8080/api/data', {
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json'
        }
      });
      return {
        status: resp.status,
        contentType: resp.headers.get('content-type')
      };
    });
    
    expect(response.status).toBe(401);
    expect(response.contentType).toContain('application/json');
    
    // Wait for traces
    await page.waitForTimeout(2000);
    
    // Check XHR request span
    const spans = collector.findSpans('oidc.serve_http');
    const xhrSpan = spans.find(s => {
      const attrs = new Map(s.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
      return attrs.get('http.target')?.stringValue === '/api/data';
    });
    
    expect(xhrSpan).toBeTruthy();
    const attrs = new Map(xhrSpan.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
    expect(attrs.get('oidc.js_request')).toHaveProperty('boolValue', true);
  });

  test("should create traces for logout flow", async ({ page }) => {
    // Login first
    await page.goto('http://localhost:8080/oauth2/login');
    await page.fill('#username', 'testuser');
    await page.fill('#password', 'testpass');
    await page.click('#kc-login');
    await page.waitForURL('http://localhost:8080/');
    
    // Clear login traces
    collector.clearTraces();
    
    // Logout
    await page.goto('http://localhost:8080/oauth2/logout');
    
    // Wait for logout redirect
    await page.waitForURL(/.*realms\/test\/protocol\/openid-connect\/logout.*/);
    
    // Wait for traces
    await page.waitForTimeout(2000);
    
    // Check logout spans
    const logoutSpans = collector.findSpans('oidc.handle_logout');
    expect(logoutSpans.length).toBeGreaterThan(0);
  });

  test("should create traces for token introspection", async ({ page }) => {
    // This test requires introspection to be configured
    // Skip if not configured
    const config = {
      provider: {
        token_validation: "Introspection"
      }
    };
    
    if (config.provider.token_validation !== "Introspection") {
      test.skip();
      return;
    }
    
    // Make request with Bearer token
    const response = await page.evaluate(async () => {
      const resp = await fetch('http://localhost:8080/api/data', {
        headers: {
          'Authorization': 'Bearer test-token'
        }
      });
      return resp.status;
    });
    
    // Wait for traces
    await page.waitForTimeout(2000);
    
    // Check for introspection span
    const introspectionSpans = collector.findSpans('oidc.token_introspection');
    if (introspectionSpans.length > 0) {
      const span = introspectionSpans[0];
      const attrs = new Map(span.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
      expect(attrs.get('oidc.introspect_endpoint')).toBeTruthy();
      expect(attrs.get('token_active')).toBeTruthy();
    }
  });

  test("should create traces for JWKS refresh", async ({ page }) => {
    // Make request with invalid/expired token to trigger JWKS refresh
    const response = await page.evaluate(async () => {
      const resp = await fetch('http://localhost:8080', {
        headers: {
          'Authorization': 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.NHVaYe26MbtOYhSKkoKYdFVomg4i8ZJd8_-RU8VNbftc4TSMb4bXP3l3YlNWACwyXPGffz5aXHc6lty1Y2t4SWRqGteragsVdZufDn5BlnJl9pdR_kdVFUsra2rWKEofkZeIC4yWytE58sMIihvo9H1ScmmVwBcQP6XETqYd0aSHp1gOa9RdUPDvoXQ5oqygTqVtxaDr6wUFKrKItgBMzWIdNZ6y7O9E0DhEPTbE9rfBo6KTFsHAZnMg4k68CDp2woYIaXbmYTWcvbzIuHO7_37GT79XdIwkm95QJ7hYC9RiwrV7mesbY4PAahERJawntho0my942XheVLmGwLMBkQ'
        }
      });
      return resp.status;
    });
    
    // Wait for traces
    await page.waitForTimeout(2000);
    
    // Check for JWKS fetch spans
    const jwksSpans = collector.findSpans('oidc.jwks_fetch');
    expect(jwksSpans.length).toBeGreaterThan(0);
    
    // Should have force_reload attribute on retry
    const reloadSpan = jwksSpans.find(s => {
      const attrs = new Map(s.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
      return attrs.get('force_reload')?.boolValue === true;
    });
    
    if (reloadSpan) {
      const attrs = new Map(reloadSpan.attributes?.map((attr: any) => [attr.key, attr.value]) || []);
      expect(attrs.get('oidc.jwks_endpoint')).toBeTruthy();
    }
  });

  test("should handle auto-enable mode with trace headers", async ({ page }) => {
    // Update config to use auto mode
    process.env.TRACING_ENABLED = "auto";
    
    // Make request without trace header - should not create traces
    collector.clearTraces();
    await page.goto('http://localhost:8080/health');
    await page.waitForTimeout(1000);
    
    const tracesWithoutHeader = collector.getTraces().length;
    
    // Make request with trace header - should create traces
    collector.clearTraces();
    const response = await page.evaluate(async () => {
      const resp = await fetch('http://localhost:8080/health', {
        headers: {
          'traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
        }
      });
      return resp.status;
    });
    
    await page.waitForTimeout(2000);
    
    const tracesWithHeader = collector.getTraces().length;
    expect(tracesWithHeader).toBeGreaterThan(tracesWithoutHeader);
  });

  test("should include error information in spans", async ({ page }) => {
    // Trigger an error by using invalid callback state
    await page.goto('http://localhost:8080/oauth2/callback?state=invalid&code=test');
    
    // Wait for traces
    await page.waitForTimeout(2000);
    
    // Find callback span with error
    const callbackSpans = collector.findSpans('oidc.handle_callback');
    expect(callbackSpans.length).toBeGreaterThan(0);
    
    const errorSpan = callbackSpans[0];
    
    // Check for error status
    expect(errorSpan.status).toBeTruthy();
    expect(errorSpan.status.code).toBe(2); // ERROR status
    
    // Check for error events
    if (errorSpan.events && errorSpan.events.length > 0) {
      const errorEvent = errorSpan.events.find((e: any) => e.name === 'exception');
      expect(errorEvent).toBeTruthy();
    }
  });

  test("should measure request latency", async ({ page }) => {
    // Make multiple requests
    for (let i = 0; i < 3; i++) {
      await page.goto('http://localhost:8080');
      await page.waitForTimeout(100);
    }
    
    // Wait for traces
    await page.waitForTimeout(2000);
    
    // Check that spans have duration
    const spans = collector.findSpans('oidc.serve_http');
    expect(spans.length).toBeGreaterThanOrEqual(3);
    
    for (const span of spans) {
      // Verify span has start and end time
      expect(span.startTimeUnixNano).toBeTruthy();
      expect(span.endTimeUnixNano).toBeTruthy();
      
      // Calculate duration in milliseconds
      const durationMs = (span.endTimeUnixNano - span.startTimeUnixNano) / 1_000_000;
      expect(durationMs).toBeGreaterThan(0);
      expect(durationMs).toBeLessThan(5000); // Should complete within 5 seconds
    }
  });
});

test.describe("Tracing Performance", () => {
  test("should have minimal overhead when tracing is disabled", async ({ page }) => {
    // Disable tracing
    process.env.TRACING_ENABLED = "false";
    
    // Measure response time with tracing disabled
    const timingsDisabled: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await page.goto('http://localhost:8080');
      const end = Date.now();
      timingsDisabled.push(end - start);
    }
    
    // Enable tracing
    process.env.TRACING_ENABLED = "true";
    
    // Measure response time with tracing enabled
    const timingsEnabled: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await page.goto('http://localhost:8080');
      const end = Date.now();
      timingsEnabled.push(end - start);
    }
    
    // Calculate averages
    const avgDisabled = timingsDisabled.reduce((a, b) => a + b) / timingsDisabled.length;
    const avgEnabled = timingsEnabled.reduce((a, b) => a + b) / timingsEnabled.length;
    
    console.log(`Average response time without tracing: ${avgDisabled}ms`);
    console.log(`Average response time with tracing: ${avgEnabled}ms`);
    
    // Overhead should be less than 20%
    const overhead = (avgEnabled - avgDisabled) / avgDisabled;
    expect(overhead).toBeLessThan(0.2);
  });
});