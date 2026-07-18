/**
 * ROUND 6 — the boundary defects: adapters, transport, diagnostics and the webhook schema.
 *
 * Companion to `round6.test.ts`, which covers the result-code ordering defect. Split out so each
 * fix could land with its own guarding tests rather than one undifferentiated block.
 */

import { describe, expect, it, vi } from "vitest";
import { Paylod } from "../src/client.js";
import { classifyStkResult, decodeDarajaResult } from "../src/daraja-catalog.js";
import { signWebhook, verifyWebhook } from "../src/webhook.js";

const KEY = "mp_test_abcdefghijklmnopqrstuvwxyz";
const SECRET = "whsec_round6_secret";
const NOW = 1_700_000_000;

function client(fetch: typeof globalThis.fetch) {
  return new Paylod({ apiKey: KEY, fetch, allowCustomFetch: true, maxRetries: 0 });
}

function signedEvent(data: Record<string, unknown>, type = "payment.success") {
  const raw = JSON.stringify({ type, created: NOW, data });
  return { payload: raw, signature: signWebhook(raw, SECRET, NOW), secret: SECRET, nowSec: NOW };
}

function successData(over: Record<string, unknown> = {}) {
  return {
    paymentId: "pay_1",
    applicationId: "app_1",
    env: "sandbox",
    status: "success",
    amount: 100,
    phone: "254712345678",
    accountRef: null,
    mpesaReceipt: null,
    checkoutRequestId: "ws_CO_1",
    resultCode: 0,
    resultDesc: "The service request is processed successfully.",
    decoded: null,
    ...over,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// H2 — resultDesc is validated, so it can never crash the classifier
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("H2 — an object-valued resultDesc is an indeterminate response, never a TypeError", () => {
  it("status() raises a stop-and-read error rather than throwing a raw TypeError", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "pay_1",
          status: "failed",
          mpesaReceipt: null,
          resultCode: 1032,
          resultDesc: { toString: "not a string" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const err = await client(fetch)
      .status("pay_1")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).not.toBeNull();
    expect((err as Error).constructor.name).not.toBe("TypeError");
    expect((err as Error).message).toMatch(/resultDesc/);
    expect((err as Error).message).toMatch(/INDETERMINATE/);
  });

  it("check() surfaces the same refusal rather than crashing mid-render", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "pay_1",
          status: "success",
          mpesaReceipt: "SFF6XYZ123",
          resultCode: 0,
          resultDesc: ["an", "array"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    await expect(client(fetch).check("pay_1")).rejects.toThrow(/resultDesc/);
  });

  it("the classifier itself is total — a non-string desc is simply no signal", () => {
    expect(() => classifyStkResult(1032, { x: 1 } as never)).not.toThrow();
    expect(classifyStkResult(1032, { x: 1 } as never)).toBe("failed");
    expect(() => decodeDarajaResult(4242, { x: 1 } as never)).not.toThrow();
  });

  it("a null/absent resultDesc is still perfectly legitimate", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "pay_1", status: "failed", resultCode: 1032 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;
    await expect(client(fetch).status("pay_1")).resolves.toMatchObject({ id: "pay_1" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// H3 — a malformed-2xx diagnostic never quotes the response back verbatim
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("H3 — attacker-controlled response values never reach an exception message", () => {
  it("a status body whose `status` field IS the bearer key does not leak it", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "pay_1", status: KEY }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const err = (await client(fetch)
      .status("pay_1")
      .catch((e: unknown) => e)) as Error;

    expect(err.message).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
  });

  it("a MISMATCHED id that is the bearer key does not leak it either", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: KEY, status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const err = (await client(fetch)
      .status("pay_1")
      .catch((e: unknown) => e)) as Error;

    expect(err.message).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
    // The diagnostic still says WHAT went wrong — it just does not quote the payload.
    expect(err.message).toMatch(/different/i);
  });

  it("a collect ack whose `status` field is the bearer key does not leak it", async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ paymentId: "p", checkoutRequestId: "c", status: KEY }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const err = (await client(fetch)
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k-leak" })
      .catch((e: unknown) => e)) as Error;

    expect(err.message).not.toContain(KEY);
    expect(String(err.stack)).not.toContain(KEY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// H4 — an already-aborted signal dispatches NOTHING
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("H4 — an already-aborted signal never reaches the money endpoint", () => {
  it("collect() with a pre-aborted signal dispatches ZERO requests", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ paymentId: "p", checkoutRequestId: "c", status: "pending" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctrl = new AbortController();
    ctrl.abort();

    const err = await client(fetch)
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k-abort" }, { signal: ctrl.signal })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).not.toBeNull();
    // THE assertion. Not "it rejected" — it must not have CHARGED.
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it("the escaping error still carries the idempotency key, because nothing is ever certain", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const ctrl = new AbortController();
    ctrl.abort();

    const err = (await client(fetch)
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k-abort-2" }, { signal: ctrl.signal })
      .catch((e: unknown) => e)) as { idempotencyKey?: string };

    expect(err.idempotencyKey).toBe("k-abort-2");
  });

  it("status() with a pre-aborted signal dispatches ZERO requests", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "pay_1", status: "success", resultCode: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctrl = new AbortController();
    ctrl.abort();

    await expect(client(fetch).status("pay_1", { signal: ctrl.signal })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(0);
  });

  it("a signal that is NOT aborted dispatches normally", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "pay_1", status: "pending" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctrl = new AbortController();
    await expect(client(fetch).status("pay_1", { signal: ctrl.signal })).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// H1 — the unauthenticated webhook body is capped on EVERY intake path
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("H1 — the Web Request adapter caps the body BEFORE authenticating it", () => {
  function handlerFor() {
    const seen: unknown[] = [];
    const paylod = new Paylod({
      apiKey: KEY,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      allowCustomFetch: true,
      webhookSecret: SECRET,
    });
    return { seen, handler: paylod.webhookHandler(async (e) => void seen.push(e)) };
  }

  it("refuses an oversized STREAMED body without buffering it", async () => {
    const { handler } = handlerFor();
    let produced = 0;
    // 64 MiB, one MiB at a time. If the adapter buffers it all, this test is the OOM.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 64 * 1024 * 1024) return controller.close();
        produced += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
      },
    });

    const res = await handler(
      new Request("https://example.test/hook", { method: "POST", body: stream, duplex: "half" } as RequestInit),
    );

    expect(res.status).toBe(400);
    // The cap fired long before the producer finished.
    expect(produced).toBeLessThanOrEqual(3 * 1024 * 1024);
  });

  it("the cap is enforced on the ACTUAL bytes, not on a declared length", async () => {
    // `Content-Length` is a forbidden header name in the fetch spec — the `Request` constructor
    // strips it, so on this adapter a declared length is not something that can be relied on at
    // all. That is exactly why the byte counter above is the real control and the declared-length
    // check is only ever an early-out. (It IS load-bearing on the Express path, where the header
    // survives; see the Express suite below.)
    const { handler } = handlerFor();
    const res = await handler(
      new Request("https://example.test/hook", {
        method: "POST",
        body: "a".repeat(2 * 1024 * 1024),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/exceeds/) });
  });

  it("a NORMAL webhook still verifies through the Web adapter", async () => {
    const { seen, handler } = handlerFor();
    const raw = JSON.stringify({ type: "payment.success", created: NOW, data: successData() });
    const res = await handler(
      new Request("https://example.test/hook", {
        method: "POST",
        body: raw,
        headers: { "x-webhook-signature": signWebhook(raw, SECRET, Math.floor(Date.now() / 1000)) },
      }),
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});

describe("H1 — the Express adapter caps PRE-BUFFERED bodies too", () => {
  function expressHandler() {
    const paylod = new Paylod({
      apiKey: KEY,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      allowCustomFetch: true,
      webhookSecret: SECRET,
    });
    return paylod.webhook(async () => {});
  }

  function res() {
    const out = { code: 0, body: null as unknown };
    const r = {
      status(c: number) {
        out.code = c;
        return r;
      },
      json(b: unknown) {
        out.body = b;
        return b;
      },
    };
    return { out, r };
  }

  it("refuses an oversized pre-buffered Buffer body", async () => {
    const { out, r } = res();
    await expressHandler()({ headers: {}, body: Buffer.alloc(2 * 1024 * 1024) }, r);
    expect(out.code).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/exceeds/);
  });

  it("refuses an oversized pre-buffered string body", async () => {
    const { out, r } = res();
    await expressHandler()({ headers: {}, body: "a".repeat(2 * 1024 * 1024) }, r);
    expect(out.code).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/exceeds/);
  });

  it("refuses an oversized declared Content-Length before touching the stream", async () => {
    const { out, r } = res();
    let pulled = false;
    const req = {
      headers: { "content-length": String(50 * 1024 * 1024) },
      async *[Symbol.asyncIterator]() {
        pulled = true;
        yield Buffer.from("{}");
      },
    };
    await expressHandler()(req as never, r);
    expect(out.code).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/exceeds/);
    // The refusal happened without a single byte being pulled off the socket.
    expect(pulled).toBe(false);
  });

  it("refuses an oversized pre-buffered rawBody", async () => {
    const { out, r } = res();
    await expressHandler()({ headers: {}, rawBody: Buffer.alloc(2 * 1024 * 1024) }, r);
    expect(out.code).toBe(400);
    expect(JSON.stringify(out.body)).toMatch(/exceeds/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// M4 — the complete webhook schema
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("M4 — the webhook event schema is enforced COMPLETELY, not partially", () => {
  const bad: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    ["a negative amount", { amount: -100 }, /amount/],
    ["a fractional amount", { amount: 100.5 }, /amount/],
    ["a zero amount", { amount: 0 }, /amount/],
    ["an absurd amount", { amount: 1e15 }, /amount/],
    ["a missing applicationId", { applicationId: undefined }, /applicationId/],
    ["a missing env", { env: undefined }, /env/],
    ["a missing phone", { phone: undefined }, /phone/],
    ["a blank applicationId", { applicationId: "  " }, /applicationId/],
    ["a blank phone", { phone: "" }, /phone/],
  ];

  for (const [label, over, re] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => verifyWebhook(signedEvent(successData(over)))).toThrow(re);
    });
  }

  it("accepts the complete, well-formed event", () => {
    expect(() => verifyWebhook(signedEvent(successData()))).not.toThrow();
  });

  it("still accepts a NULLABLE field that is genuinely null", () => {
    expect(() =>
      verifyWebhook(signedEvent(successData({ accountRef: null, mpesaReceipt: null }))),
    ).not.toThrow();
  });
});

describe("M4/D4 — the decoded block is SYNTHESISED, never taken and never left missing", () => {
  it("a payment.failed with NO decoded block gets one built from the catalog", () => {
    const event = verifyWebhook(
      signedEvent(
        successData({
          status: "failed",
          resultCode: 1032,
          resultDesc: "Request cancelled by user",
          decoded: undefined,
        }),
        "payment.failed",
      ),
    );
    expect(event.data.decoded).not.toBeNull();
    expect(event.data.decoded?.code).toBe("1032");
    expect(event.data.decoded?.retryable).toBe(true);
  });

  it("a payment.success NEVER carries a decoded block, even if the payload supplies one", () => {
    const hostile = {
      code: "0",
      title: "pwned",
      cause: "pwned",
      fix: "pwned",
      category: "success",
      retryable: true,
      customerMessage: "pwned",
    };
    const event = verifyWebhook(signedEvent(successData({ decoded: hostile })));
    expect(event.data.decoded).toBeNull();
  });

  it("every field of a supplied decoded block is replaced, not merged", () => {
    const hostile = {
      code: "9999",
      title: "pwned",
      cause: "pwned",
      fix: "pwned",
      category: "success",
      retryable: true,
      customerMessage: "Please pay again right now.",
      extra: "smuggled",
    };
    const event = verifyWebhook(
      signedEvent(
        successData({
          status: "failed",
          resultCode: 1037,
          resultDesc: "DS timeout",
          decoded: hostile,
        }),
        "payment.failed",
      ),
    );
    const d = event.data.decoded as unknown as Record<string, unknown>;
    expect(d.code).toBe("1037");
    expect(d.title).not.toBe("pwned");
    expect(d.category).not.toBe("success");
    expect(d.customerMessage).not.toBe("Please pay again right now.");
    expect(d.extra).toBeUndefined();
  });
});
