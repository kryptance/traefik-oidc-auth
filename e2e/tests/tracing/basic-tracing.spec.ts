import { expect, test } from "@playwright/test";

// Simple trace collector for testing
interface TraceData {
  resourceSpans?: Array<{
    scopeSpans?: Array<{
      spans?: Array<{
        name: string;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        attributes?: Array<{
          key: string;
          value: any;
        }>;
        status?: {
          code: number;
          message?: string;
        };
        events?: Array<{
          name: string;
          timeUnixNano: string;
          attributes?: Array<{
            key: string;
            value: any;
          }>;
        }>;
      }>;
    }>;
  }>;
}

class SimpleTraceCollector {
  private traces: TraceData[] = [];
  private server: any;

  async start(port: number = 4318): Promise<void> {
    const http = require('http');
    
    this.server = http.createServer((req: any, res: any) => {
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/traces') {
        let body = '';
        req.on('data', (chunk: any) => body += chunk);
        req.on('end', () => {
          try {
            const trace = JSON.parse(body);
            this.traces.push(trace);
            res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ partialSuccess: {} }));
          } catch (e) {
            res.writeHead(400, headers);
            res.end('Bad Request');
          }
        });
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', traces: this.traces.length }));
      } else {
        res.writeHead(404, headers);
        res.end('Not Found');
      }
    });

    return new Promise((resolve) => {
      this.server.listen(port, '0.0.0.0', () => {
        console.log(`Trace collector listening on port ${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getSpans(spanName?: string): any[] {
    const spans: any[] = [];
    for (const trace of this.traces) {
      if (trace.resourceSpans) {
        for (const rs of trace.resourceSpans) {
          if (rs.scopeSpans) {
            for (const ss of rs.scopeSpans) {
              if (ss.spans) {
                for (const span of ss.spans) {
                  if (!spanName || span.name === spanName) {
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

  clear(): void {
    this.traces = [];
  }
}

//-----------------------------------------------------------------------------
// Basic Tracing Tests
//-----------------------------------------------------------------------------

test.describe("Basic OpenTelemetry Tracing", () => {
  let collector: SimpleTraceCollector;

  test.beforeAll(async () => {
    collector = new SimpleTraceCollector();
    await collector.start(4318);
  });

  test.afterAll(async () => {
    await collector.stop();
  });

  test.beforeEach(async () => {
    collector.clear();
  });

  test("should verify OTLP collector is running", async () => {
    const response = await fetch('http://localhost:4318/health');
    expect(response.ok).toBeTruthy();
    
    const health = await response.json();
    expect(health.status).toBe('ok');
  });

  test("should send traces to OTLP endpoint", async () => {
    // Create a sample trace
    const trace: TraceData = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "test.span",
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "b7ad6b7169203331",
            startTimeUnixNano: "1677089400000000000",
            endTimeUnixNano: "1677089401000000000",
            attributes: [
              { key: "test.attribute", value: { stringValue: "test-value" } }
            ]
          }]
        }]
      }]
    };

    // Send trace to collector
    const response = await fetch('http://localhost:4318/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trace)
    });

    expect(response.ok).toBeTruthy();
    
    // Verify trace was collected
    const spans = collector.getSpans('test.span');
    expect(spans).toHaveLength(1);
    expect(spans[0].traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  test("should handle trace context propagation", async ({ page }) => {
    // This would test with a real OIDC setup
    // For now, just verify the collector works
    
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    
    // Create a trace with parent-child relationship
    const trace: TraceData = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [
            {
              name: "oidc.serve_http",
              traceId: traceId,
              spanId: spanId,
              startTimeUnixNano: "1677089400000000000",
              endTimeUnixNano: "1677089401000000000",
              attributes: [
                { key: "http.method", value: { stringValue: "GET" } },
                { key: "http.target", value: { stringValue: "/" } }
              ]
            },
            {
              name: "oidc.discovery",
              traceId: traceId,
              spanId: "1234567890abcdef",
              parentSpanId: spanId,
              startTimeUnixNano: "1677089400100000000",
              endTimeUnixNano: "1677089400200000000",
              attributes: [
                { key: "oidc.discovery_endpoint", value: { stringValue: "https://example.com/.well-known/openid-configuration" } }
              ]
            }
          ]
        }]
      }]
    };

    const response = await fetch('http://localhost:4318/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trace)
    });

    expect(response.ok).toBeTruthy();
    
    // Verify parent-child relationship
    const spans = collector.getSpans();
    expect(spans).toHaveLength(2);
    
    const parentSpan = spans.find(s => s.name === 'oidc.serve_http');
    const childSpan = spans.find(s => s.name === 'oidc.discovery');
    
    expect(parentSpan).toBeTruthy();
    expect(childSpan).toBeTruthy();
    expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
    expect(childSpan.traceId).toBe(parentSpan.traceId);
  });

  test("should record span attributes correctly", async () => {
    const trace: TraceData = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "oidc.token_validation",
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "b7ad6b7169203331",
            startTimeUnixNano: "1677089400000000000",
            endTimeUnixNano: "1677089401000000000",
            attributes: [
              { key: "oidc.token_validation", value: { stringValue: "local_jwt" } },
              { key: "oidc.jwks_endpoint", value: { stringValue: "https://example.com/jwks" } },
              { key: "oidc.user_id", value: { stringValue: "user123" } },
              { key: "token_expired", value: { boolValue: false } }
            ]
          }]
        }]
      }]
    };

    const response = await fetch('http://localhost:4318/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trace)
    });

    expect(response.ok).toBeTruthy();
    
    const spans = collector.getSpans('oidc.token_validation');
    expect(spans).toHaveLength(1);
    
    const span = spans[0];
    const attrs = new Map(span.attributes.map((a: any) => [a.key, a.value]));
    
    expect(attrs.get('oidc.token_validation')).toEqual({ stringValue: 'local_jwt' });
    expect(attrs.get('oidc.user_id')).toEqual({ stringValue: 'user123' });
    expect(attrs.get('token_expired')).toEqual({ boolValue: false });
  });

  test("should record errors in spans", async () => {
    const trace: TraceData = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "oidc.token_exchange",
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "b7ad6b7169203331",
            startTimeUnixNano: "1677089400000000000",
            endTimeUnixNano: "1677089401000000000",
            status: {
              code: 2, // ERROR
              message: "Token exchange failed with status 400"
            },
            events: [{
              name: "exception",
              timeUnixNano: "1677089400500000000",
              attributes: [
                { key: "exception.type", value: { stringValue: "Error" } },
                { key: "exception.message", value: { stringValue: "invalid_grant" } }
              ]
            }]
          }]
        }]
      }]
    };

    const response = await fetch('http://localhost:4318/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trace)
    });

    expect(response.ok).toBeTruthy();
    
    const spans = collector.getSpans('oidc.token_exchange');
    expect(spans).toHaveLength(1);
    
    const span = spans[0];
    expect(span.status.code).toBe(2); // ERROR
    expect(span.status.message).toContain('Token exchange failed');
    expect(span.events).toHaveLength(1);
    expect(span.events[0].name).toBe('exception');
  });

  test("should calculate span duration", async () => {
    const startTime = Date.now() * 1_000_000; // Convert to nanoseconds
    const endTime = startTime + 150_000_000; // 150ms later
    
    const trace: TraceData = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            name: "oidc.serve_http",
            traceId: "0af7651916cd43dd8448eb211c80319c",
            spanId: "b7ad6b7169203331",
            startTimeUnixNano: startTime.toString(),
            endTimeUnixNano: endTime.toString(),
          }]
        }]
      }]
    };

    const response = await fetch('http://localhost:4318/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(trace)
    });

    expect(response.ok).toBeTruthy();
    
    const spans = collector.getSpans('oidc.serve_http');
    expect(spans).toHaveLength(1);
    
    const span = spans[0];
    const durationNs = parseInt(span.endTimeUnixNano) - parseInt(span.startTimeUnixNano);
    const durationMs = durationNs / 1_000_000;
    
    // Allow for minor floating point differences
    expect(Math.round(durationMs)).toBe(150);
  });
});