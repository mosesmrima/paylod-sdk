/**
 * Tests for the two ARCHITECTURAL roots closed in 0.7.0, plus the boundary fixes that shipped
 * with them.
 *
 * ROOT 1 — credentialed dispatch goes through an SDK-owned transport that cannot be replaced.
 * ROOT 2 — one semantic model decides what a payment record MEANS.
 *
 * Every test here is written to fail if the specific protection is removed; the non-vacuity run
 * in `scripts/` reverts each change and proves exactly that.
 */

import { describe, expect, it, vi } from "vitest";
import {
  Paylod,
  PaylodApiError,
  PaylodConfigError,
  PaylodConnectionError,
  PaylodInvalidRequestError,
  PaylodSignatureVerificationError,
  signWebhook,
  verifyWebhook,
} from "../src/index.js";
import { judge } from "../src/semantics.js";
import { Transport } from "../src/transport.js";
import type { Payment } from "../src/types.js";
import { mockFetch, payment } from "./helpers.js";

const KEY = "mp_test_key_123";
const LIVE = "mp_live_key_123";

const ACK202 = {
  status: 202,
  json: { paymentId: "pay_1", status: "pending", checkoutRequestId: "ws_CO_1" },
};

function client(steps: Parameters<typeof mockFetch>[0], opts: Record<string, unknown> = {}) {
  const m = mockFetch(steps);
  return {
    m,
    paylod: new Paylod({
      apiKey: KEY,
      fetch: m.fetch,
      allowCustomFetch: true,
      maxRetries: 0,
      ...opts,
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ROOT 1 — the transport seam
// ═══════════════════════════════════════════════════════════════════════════════════════

describe("ROOT 1 — a custom fetch is a gated, test-only seam", () => {
  it("refuses an injected fetch that was not explicitly opted into", () => {
    expect(() => new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch })).toThrow(
      PaylodConfigError,
    );
    expect(() => new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch })).toThrow(
      /allowCustomFetch/,
    );
  });

  it("refuses an injected fetch with a LIVE key even when opted into", () => {
    expect(
      () =>
        new Paylod({ apiKey: LIVE, fetch: mockFetch([]).fetch, allowCustomFetch: true }),
    ).toThrow(PaylodConfigError);
    expect(
      () =>
        new Paylod({ apiKey: LIVE, fetch: mockFetch([]).fetch, allowCustomFetch: true }),
    ).toThrow(/mp_live_/);
  });

  it("accepts the seam for a sandbox key with the explicit opt-in", async () => {
    const { paylod, m } = client([ACK202]);
    await paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "k1" });
    expect(m.calls.length).toBe(1);
  });

  it("still sends the credential itself — callers never construct the header", async () => {
    const { paylod, m } = client([ACK202]);
    await paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "k1" });
    expect(m.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("ROOT 1 — the transport refuses redirects and off-origin responses", () => {
  /** A response object shaped enough for the transport, with fields a real Response makes readonly. */
  function fakeRes(over: Record<string, unknown>) {
    return {
      status: 200,
      ok: true,
      type: "basic",
      redirected: false,
      url: "",
      headers: new Headers(),
      text: async () => "{}",
      ...over,
    } as unknown as Response;
  }

  function transportWith(res: Response) {
    return new Transport({
      apiKey: KEY,
      baseUrl: "https://paylod.dev/functions/v1",
      redact: (s) => s,
      testFetch: (async () => res) as unknown as typeof globalThis.fetch,
    });
  }

  it("refuses a 3xx rather than following it", async () => {
    const t = transportWith(fakeRes({ status: 302, ok: false }));
    await expect(t.send({ method: "GET", path: "/status/x", timeoutMs: 1000 })).rejects.toThrow(
      /redirect/i,
    );
  });

  it("refuses an opaqueredirect", async () => {
    const t = transportWith(fakeRes({ type: "opaqueredirect", status: 0, ok: false }));
    await expect(t.send({ method: "GET", path: "/status/x", timeoutMs: 1000 })).rejects.toThrow(
      /redirect/i,
    );
  });

  it("REFUSES A 2xx THAT THE FETCH IMPL REACHED BY FOLLOWING A REDIRECT", async () => {
    // The exact ROOT-1 attack: an injected fetch ignores redirect:"manual", follows a
    // cross-origin 302, and returns an ordinary 200. Checking only the final status accepts it.
    const t = transportWith(fakeRes({ status: 200, ok: true, redirected: true }));
    await expect(t.send({ method: "GET", path: "/status/x", timeoutMs: 1000 })).rejects.toThrow(
      PaylodConnectionError,
    );
    await expect(t.send({ method: "GET", path: "/status/x", timeoutMs: 1000 })).rejects.toThrow(
      /FOLLOWED a redirect/,
    );
  });

  it("refuses a 2xx whose final URL is off the pinned origin", async () => {
    const t = transportWith(fakeRes({ status: 200, ok: true, url: "https://evil.example/x" }));
    await expect(t.send({ method: "GET", path: "/status/x", timeoutMs: 1000 })).rejects.toThrow(
      /pinned paylod origin/,
    );
  });

  it("accepts a same-origin final URL", async () => {
    const t = transportWith(
      fakeRes({ url: "https://paylod.dev/functions/v1/status/x", text: async () => '{"ok":1}' }),
    );
    await expect(
      t.send({ method: "GET", path: "/status/x", timeoutMs: 1000 }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("refuses to construct with a live key and a custom fetch, on its own terms", () => {
    expect(
      () =>
        new Transport({
          apiKey: LIVE,
          baseUrl: "https://paylod.dev/functions/v1",
          redact: (s) => s,
          testFetch: (async () => fakeRes({})) as unknown as typeof globalThis.fetch,
        }),
    ).toThrow(/mp_live_/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ROOT 2 — the semantic model
// ═══════════════════════════════════════════════════════════════════════════════════════

describe("ROOT 2 — the claim/evidence verdict table", () => {
  const p = (over: Partial<Payment>): Payment => payment({ ...over });

  it.each([
    // claim      evidence                                          expected verdict
    ["success with a receipt", { status: "success", mpesaReceipt: "SFF6" }, "paid"],
    ["success with code zero", { status: "success", resultCode: 0 }, "paid"],
    ["success with no evidence", { status: "success" }, "indeterminate"],
    ["success with a failure code", { status: "success", resultCode: 1032 }, "indeterminate"],
    ["success with a pending code", { status: "success", resultCode: 4999 }, "indeterminate"],
    ["pending with no evidence", { status: "pending" }, "in_flight"],
    ["pending with a pending code", { status: "pending", resultCode: 4999 }, "in_flight"],
    ["a pending row carrying code zero", { status: "pending", resultCode: 0 }, "indeterminate"],
    ["pending with a receipt", { status: "pending", mpesaReceipt: "SFF6" }, "indeterminate"],
    ["pending with a failure code", { status: "pending", resultCode: 1032 }, "indeterminate"],
    ["failed with no evidence", { status: "failed" }, "failed"],
    ["failed with a failure code", { status: "failed", resultCode: 2001 }, "failed"],
    ["failed with a pending code", { status: "failed", resultCode: 4999 }, "in_flight"],
    ["failed with a receipt", { status: "failed", mpesaReceipt: "SFF6" }, "indeterminate"],
    ["failed with code zero", { status: "failed", resultCode: 0 }, "indeterminate"],
    [
      "failed with a receipt and a cancel code",
      { status: "failed", mpesaReceipt: "SFF6", resultCode: 1032 },
      "indeterminate",
    ],
  ])("verdict for %s is %s", (_label, over, expected) => {
    expect(judge(p(over as Partial<Payment>)).verdict).toBe(expected);
  });

  // ── The four laws, asserted directly ──────────────────────────────────────────────────

  it("L2: paid ALWAYS has success evidence (a receipt or code 0)", () => {
    const paidCases: Partial<Payment>[] = [
      { status: "success", mpesaReceipt: "SFF6" },
      { status: "success", resultCode: 0 },
      { status: "success", mpesaReceipt: "SFF6", resultCode: 0 },
    ];
    for (const c of paidCases) expect(judge(p(c)).verdict).toBe("paid");
    // and a success claim with nothing behind it is never paid
    expect(judge(p({ status: "success" })).verdict).not.toBe("paid");
  });

  it("L2 (converse): success WITHOUT a receipt is still legitimate when code 0 proves it", () => {
    // Receipts attach asynchronously, so requiring a receipt outright would reject real payments.
    const o = judge(p({ status: "success", resultCode: 0, mpesaReceipt: null }));
    expect(o.verdict).toBe("paid");
  });

  it("L4: a receipt forces success or indeterminate, never failed and never in flight", () => {
    for (const status of ["pending", "success", "failed"] as const) {
      for (const resultCode of [null, 0, 1032, 4999, 2001]) {
        const v = judge(p({ status, mpesaReceipt: "SFF6", resultCode })).verdict;
        expect(["paid", "indeterminate"]).toContain(v);
      }
    }
  });
});

describe("ROOT 2 — indeterminate is never a retryable failure (L3)", () => {
  it("a receipt on a failed row is NOT reported as a retryable cancellation", async () => {
    // The worst pre-0.7.0 defect: this returned status "cancelled" with retryable:true, telling
    // a merchant it was safe to charge again for a payment carrying an M-Pesa receipt.
    const { paylod } = client([
      { status: 200, json: payment({ status: "failed", mpesaReceipt: "SFF6", resultCode: 1032 }) },
    ]);
    const out = await paylod.check("pay_123");
    expect(out.paid).toBe(false);
    expect(out.retryable).toBe(false);
    expect(out.status).toBe("pending");
  });

  it("a pending row carrying code 0 is NOT reported as paid", async () => {
    const { paylod } = client([
      { status: 200, json: payment({ status: "pending", resultCode: 0 }) },
    ]);
    const out = await paylod.check("pay_123");
    expect(out.paid).toBe(false);
    expect(out.receipt).toBeNull();
  });

  it("a genuine success is still paid, and still renders a receipt", async () => {
    const { paylod } = client([
      { status: 200, json: payment({ status: "success", resultCode: 0, mpesaReceipt: "SFF6" }) },
    ]);
    const out = await paylod.check("pay_123");
    expect(out.paid).toBe(true);
    expect(out.receipt).toBe("SFF6");
  });
});

describe("ROOT 2 — ID binding", () => {
  it("REFUSES a status body describing a DIFFERENT payment", async () => {
    const { paylod } = client([
      { status: 200, json: payment({ id: "pay_SOMEONE_ELSE", status: "success", resultCode: 0 }) },
    ]);
    const err = await paylod.status("pay_123").catch((e) => e);
    expect(err).toBeInstanceOf(PaylodApiError);
    expect((err as PaylodApiError).indeterminate).toBe(true);
    expect((err as PaylodApiError).message).toMatch(/answers a different question/);
  });

  it("a wrong-payment body can never be reported as paid", async () => {
    const { paylod } = client([
      { status: 200, json: payment({ id: "pay_other", status: "success", resultCode: 0, mpesaReceipt: "SFF6" }) },
    ]);
    await expect(paylod.check("pay_123")).rejects.toThrow(PaylodApiError);
  });

  it("accepts the matching id", async () => {
    const { paylod } = client([
      { status: 200, json: payment({ id: "pay_123", status: "success", resultCode: 0 }) },
    ]);
    await expect(paylod.status("pay_123")).resolves.toMatchObject({ id: "pay_123" });
  });
});

describe("ROOT 2 — a collect ack requires HTTP 202", () => {
  it("refuses a 200 that is otherwise a perfect ack", async () => {
    const { paylod } = client([{ status: 200, json: ACK202.json }]);
    const err = await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PaylodApiError);
    expect((err as PaylodApiError).indeterminate).toBe(true);
    expect((err as PaylodApiError).message).toMatch(/202/);
  });

  it("carries the idempotency key on that refusal, so a retry cannot mint a fresh one", async () => {
    const { paylod } = client([{ status: 200, json: ACK202.json }]);
    const err = await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k-202" })
      .catch((e) => e);
    expect((err as PaylodApiError).idempotencyKey).toBe("k-202");
  });

  it("accepts a 202", async () => {
    const { paylod } = client([ACK202]);
    await expect(
      paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "k1" }),
    ).resolves.toMatchObject({ paymentId: "pay_1" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// Boundary fixes
// ═══════════════════════════════════════════════════════════════════════════════════════

describe("boundary — option bounds", () => {
  it("rejects an absurd timeout that setTimeout would clamp to fire immediately", () => {
    expect(() => new Paylod({ apiKey: KEY, timeoutMs: 1e20 })).toThrow(PaylodInvalidRequestError);
  });

  it("rejects an absurd retry count", () => {
    expect(() => new Paylod({ apiKey: KEY, maxRetries: 1e6 })).toThrow(PaylodInvalidRequestError);
  });

  it("still accepts sane values", () => {
    expect(() => new Paylod({ apiKey: KEY, timeoutMs: 5_000, maxRetries: 3 })).not.toThrow();
  });
});

describe("boundary — the idempotency key charset excludes ASCII space", () => {
  it.each([" leading", "trailing ", "has space"])("rejects %j", async (bad) => {
    const { paylod } = client([ACK202]);
    await expect(
      paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: bad }),
    ).rejects.toThrow(PaylodInvalidRequestError);
  });

  it("accepts an opaque space-free id", async () => {
    const { paylod } = client([ACK202]);
    await expect(
      paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-9f3c-11" }),
    ).resolves.toBeTruthy();
  });
});

describe("boundary — redaction", () => {
  it("redacts the key out of a DEEPLY nested error body rather than passing it through", async () => {
    // Build a body nesting the key ~12 levels down, past the old depth-8 cutoff.
    let deep: unknown = { leaked: `Bearer ${KEY}` };
    for (let i = 0; i < 12; i++) deep = { level: deep };
    const { paylod } = client([{ status: 400, json: { error: "bad", detail: deep } }]);

    const err = await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k1" })
      .catch((e) => e);
    expect(JSON.stringify((err as PaylodApiError).body)).not.toContain(KEY);
  });

  it("redacts the raw body stored on a malformed-2xx (indeterminate) error", async () => {
    // A 202 whose body echoes the key back, and which is malformed so it becomes an error.
    const { paylod } = client([
      { status: 202, json: { echoed: `Bearer ${KEY}` } }, // no paymentId -> indeterminate
    ]);
    const err = await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k1" })
      .catch((e) => e);
    expect(JSON.stringify((err as PaylodApiError).body)).not.toContain(KEY);
  });

  it("does NOT attach the unsanitised lower-level exception as `cause`", async () => {
    const leaky = new Error(`connect failed with authorization: Bearer ${KEY}`);
    const { paylod } = client([{ throw: leaky }]);
    const err = await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k1" })
      .catch((e) => e);
    expect((err as Error).message).not.toContain(KEY);
    // The whole point: nothing reachable from the error re-exposes the key.
    expect(JSON.stringify((err as { cause?: unknown }).cause ?? null)).not.toContain(KEY);
    expect(((err as { cause?: Error }).cause?.message ?? "")).not.toContain(KEY);
  });
});

describe("boundary — every escaping failure carries the idempotency key", () => {
  // These go through `collectAndWait`, where the failure escapes AFTER the ack — the money-
  // critical half. A throw from inside `wait()` is NOT pre-wrapped by the transport's
  // connection-error path, so it reaches the normaliser in its original form. That is the case
  // the old in-place mutation dropped on the floor.
  function afterAck(onPoll: () => void) {
    // The poll body's id MUST match the ack's paymentId, or ID binding throws first and this
    // test passes for entirely the wrong reason. (It did; the non-vacuity run caught it.)
    const m = mockFetch([
      ACK202,
      { status: 200, json: payment({ id: "pay_1", status: "pending" }) },
    ]);
    const paylod = new Paylod({
      apiKey: KEY,
      fetch: m.fetch,
      allowCustomFetch: true,
      maxRetries: 0,
    });
    return paylod.collectAndWait(
      { amount: 1, phone: "0712345678", idempotencyKey: "k-after-ack" },
      { onPoll },
    );
  }

  it("carries it when user code throws a PRIMITIVE", async () => {
    const err = await afterAck(() => {
      // eslint-disable-next-line no-throw-literal
      throw "boom-as-a-string";
    }).catch((e) => e);
    expect((err as { idempotencyKey?: string }).idempotencyKey).toBe("k-after-ack");
  });

  it("carries it when user code throws a FROZEN error", async () => {
    const frozen = Object.freeze(new Error("frozen failure"));
    const err = await afterAck(() => {
      throw frozen;
    }).catch((e) => e);
    expect((err as { idempotencyKey?: string }).idempotencyKey).toBe("k-after-ack");
    // The frozen original is not mutated — we wrap rather than write to a value we do not own.
    expect((frozen as { idempotencyKey?: string }).idempotencyKey).toBeUndefined();
  });

  it("carries it on an ordinary transport failure too", async () => {
    const m = mockFetch([{ throw: new TypeError("fetch failed") }]);
    const paylod = new Paylod({
      apiKey: KEY,
      fetch: m.fetch,
      allowCustomFetch: true,
      maxRetries: 0,
    });
    const err = await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k-net" })
      .catch((e) => e);
    expect((err as { idempotencyKey?: string }).idempotencyKey).toBe("k-net");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// Webhook schema
// ═══════════════════════════════════════════════════════════════════════════════════════

describe("webhook — the full event schema is validated, not cast", () => {
  const SECRET = "whsec_x";
  const T = 1_700_000_000;

  function verify(data: Record<string, unknown>, type = "payment.success") {
    const raw = JSON.stringify({ type, created: T, data });
    return verifyWebhook({
      payload: raw,
      signature: signWebhook(raw, SECRET, T),
      secret: SECRET,
      nowSec: T,
      toleranceSec: 300,
    });
  }

  const goodSuccess = {
    paymentId: "pay_1",
    applicationId: "app_1",
    env: "sandbox",
    status: "success",
    amount: 100,
    phone: "254712345678",
    accountRef: null,
    mpesaReceipt: "SFF6XYZ123",
    checkoutRequestId: "ws_CO_1",
    resultCode: 0,
    resultDesc: "ok",
    decoded: null,
  };

  it("accepts a well-formed, evidenced success", () => {
    expect(verify(goodSuccess).data.paymentId).toBe("pay_1");
  });

  it("rejects a signed success whose data.status contradicts the event type", () => {
    expect(() => verify({ ...goodSuccess, status: "failed" })).toThrow(
      PaylodSignatureVerificationError,
    );
    expect(() => verify({ ...goodSuccess, status: "failed" })).toThrow(/contradicts itself/);
  });

  it("REJECTS a signed payment.success with NO evidence of settlement", () => {
    expect(() =>
      verify({ ...goodSuccess, mpesaReceipt: null, resultCode: null }),
    ).toThrow(/does not prove one/);
  });

  it("accepts a success proven by code 0 with no receipt yet", () => {
    expect(verify({ ...goodSuccess, mpesaReceipt: null, resultCode: 0 }).data.paymentId).toBe(
      "pay_1",
    );
  });

  it("rejects a payment.failed that carries a receipt", () => {
    expect(() =>
      verify(
        { ...goodSuccess, status: "failed", mpesaReceipt: "SFF6", resultCode: 1032 },
        "payment.failed",
      ),
    ).toThrow(PaylodSignatureVerificationError);
  });

  it("rejects mistyped fields the old cast waved through", () => {
    expect(() => verify({ ...goodSuccess, amount: "100" })).toThrow(/amount/);
    expect(() => verify({ ...goodSuccess, mpesaReceipt: 12345 })).toThrow(/mpesaReceipt/);
    expect(() => verify({ ...goodSuccess, status: "paid" })).toThrow(/status/);
  });

  it("rejects an unknown event type", () => {
    expect(() => verify(goodSuccess, "payment.refunded")).toThrow(/type/);
  });
});

describe("webhook adapters — no handler detail on the wire, and a bounded body", () => {
  it("does NOT echo the handler's exception message into the 500", async () => {
    const paylod = new Paylod({ apiKey: KEY, webhookSecret: "whsec_x" });
    const T = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({
      type: "payment.success",
      created: T,
      data: {
        paymentId: "pay_1",
        applicationId: "app_1",
        env: "sandbox",
        status: "success",
        amount: 100,
        phone: "254712345678",
        accountRef: null,
        mpesaReceipt: "SFF6",
        checkoutRequestId: "ws_1",
        resultCode: 0,
        resultDesc: "ok",
        decoded: null,
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const handlerFn = paylod.webhookHandler(async () => {
        throw new Error("postgres://user:hunter2@db.internal/orders is down");
      });
      const res = await handlerFn(
        new Request("https://x.test/hook", {
          method: "POST",
          body: raw,
          headers: { [ "x-webhook-signature" ]: signWebhook(raw, "whsec_x", T) },
        }),
      );
      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toContain("hunter2");
      expect(body).not.toContain("postgres");
      // …but the operator still gets it.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to buffer an unbounded unauthenticated body", async () => {
    const paylod = new Paylod({ apiKey: KEY, webhookSecret: "whsec_x" });
    const mw = paylod.webhook(async () => {});

    // A stream that would never stop if nothing capped it.
    const flood = {
      headers: {},
      [Symbol.asyncIterator]: async function* () {
        for (;;) yield Buffer.alloc(64 * 1024, 0x61);
      },
    };
    let code = 0;
    let body: unknown;
    const res = {
      status(c: number) {
        code = c;
        return res;
      },
      json(b: unknown) {
        body = b;
        return b;
      },
    };
    await mw(flood as never, res as never);
    expect(code).toBe(400);
    expect(String((body as { error: string }).error)).toMatch(/exceeds/);
  });
});
