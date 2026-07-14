import { vi } from "vitest";
import type { Payment } from "../src/types.js";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Step {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
  throw?: Error;
}

/** A mocked fetch that replays `steps` in order and records every call. */
export function mockFetch(steps: Step[]) {
  const calls: Call[] = [];
  let i = 0;

  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (!step) throw new Error("mockFetch: no step configured");
    if (step.throw) throw step.throw;

    return new Response(JSON.stringify(step.json ?? {}), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  });

  return { fetch: fn as unknown as typeof globalThis.fetch, calls, get count() { return i; } };
}

export const ACK = {
  paymentId: "pay_123",
  status: "pending",
  checkoutRequestId: "ws_CO_0001",
};

export function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: "pay_123",
    status: "pending",
    mpesaReceipt: null,
    resultCode: null,
    resultDesc: null,
    ...over,
  };
}
