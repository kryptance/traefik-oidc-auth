import { test } from "@playwright/test";

interface ServiceCheck {
  url: string;
  expectedStatus: number | number[];
}

export async function waitForServices(services: ServiceCheck[], maxRetries: number = 60, delayMs: number = 1000) {
  await test.step("Waiting for services to be ready", async () => {
    for (const service of services) {
      let servicesReady = false;
      
      for (let i = 0; i < maxRetries && !servicesReady; i++) {
        try {
          const response = await fetch(service.url);
          const expectedStatuses = Array.isArray(service.expectedStatus) 
            ? service.expectedStatus 
            : [service.expectedStatus];
          
          if (expectedStatuses.includes(response.status)) {
            console.log(`Service at ${service.url} is ready (status: ${response.status})`);
            servicesReady = true;
          }
        } catch (e) {
          // Continue waiting
        }
        
        if (!servicesReady) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
      
      if (!servicesReady) {
        throw new Error(`Service at ${service.url} failed to start after ${maxRetries} seconds`);
      }
    }
  });
}

export function generateTraceId(): string {
  // Generate random 16-byte trace ID as hex string
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function generateSpanId(): string {
  // Generate random 8-byte span ID as hex string
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function createTraceparent(traceId?: string, spanId?: string, sampled: boolean = true): string {
  // Create W3C traceparent header
  const version = '00';
  const tid = traceId || generateTraceId();
  const sid = spanId || generateSpanId();
  const flags = sampled ? '01' : '00';
  
  return `${version}-${tid}-${sid}-${flags}`;
}