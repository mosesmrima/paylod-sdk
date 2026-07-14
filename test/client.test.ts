import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Paylod,
  PaylodApiError,
  PaylodConfigError,
  PaylodInvalidRequestError,
  PaylodTimeoutError,
} from "../src/index.js";
import { ACK, mockFetch, payment } from "./helpers.js";

const KEY = "mp_test_abc123";

function client(steps: Parameters<typeof mockFetch>[0], opts = {}) {
  const m = mockFetch(steps);
  return {
    m,
    paylod: new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 0, ...opts }),
  };
}

/** Runs `fn` with fake timers so the poll backoff doesn't make the suite take 2 minutes. */
async function withFakeClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const promise = fn();
  const settled = promise.then(
    (v) => ({ v }),
    (e) => ({ e }),
  );
  // Drain the timer queue while the polling loop makes progress.
  for (let i = 0; i < 200; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  const out = await settled;
  vi.useRealTimers();
  if ("e" in out) throw out.e;
  return (out as { v: T }).v;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("construction", () => {
  it("reads PAYLOD_API_KEY from the environment", () => {
    vi.stubEnv("PAYLOD_API_KEY", KEY);
    expect(() => new Paylod()).not.toThrow();
  });

  it("throws a config error when no key is available", () => {
    vi.stubEnv("PAYLOD_API_KEY", "");
    expect(() => new Paylod()).toThrow(PaylodConfigError);
  });

  it("defaults to the live base URL and allows an override", async () => {
    const a = client([{ status: 202, json: ACK }]);
    await a.paylod.collect({ amount: 1, phone: "0712345678" });
    expect(a.m.calls[0]!.url).toBe("https://paylod.dev/functions/v1/collect");

    const b = client([{ status: 202, json: ACK }], { baseUrl: "https://api.paylod.dev/v1/" });
    await b.paylod.collect({ amount: 1, phone: "0712345678" });
    expect(b.m.calls[0]!.url).toBe("https://api.paylod.dev/v1/collect");
  });
});

describe("collect", () => {
  it("posts a normalised body and returns the 202 ack", async () => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    const ack = await paylod.collect({ amount: 100, phone: "0712345678" });

    expect(ack.paymentId).toBe("pay_123");
    expect(ack.status).toBe("pending");
    expect(ack.checkoutRequestId).toBe("ws_CO_0001");

    const call = m.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toEqual({ amount: 100, phone: "254712345678" });
  });

  it.each([
    ["0712345678", "254712345678"],
    ["+254712345678", "254712345678"],
    ["254712345678", "254712345678"],
    ["712345678", "254712345678"],
    ["0110 123 456", "254110123456"],
  ])("normalises %s to %s", async (input, expected) => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    await paylod.collect({ amount: 5, phone: input });
    expect((m.calls[0]!.body as { phone: string }).phone).toBe(expected);
  });

  it("rejects bad input locally, before any network call", async () => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    await expect(paylod.collect({ amount: 10.5, phone: "0712345678" })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
    await expect(paylod.collect({ amount: 0, phone: "0712345678" })).rejects.toThrow(/between 1/);
    await expect(paylod.collect({ amount: 150_001, phone: "0712345678" })).rejects.toThrow(
      /150000/,
    );
    await expect(paylod.collect({ amount: 10, phone: "0812345678" })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
    expect(m.count).toBe(0);
  });

  it("surfaces an API error with its status and decoded message", async () => {
    const { paylod } = client([{ status: 401, json: { error: "invalid API key" } }]);
    const err = await paylod.collect({ amount: 10, phone: "0712345678" }).catch((e) => e);
    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.status).toBe(401);
    expect(err.isAuthError).toBe(true);
    expect(err.message).toBe("invalid API key");
  });
});

describe("idempotency", () => {
  it("generates an Idempotency-Key by default and returns it on the ack", async () => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    const ack = await paylod.collect({ amount: 100, phone: "0712345678" });
    const sent = m.calls[0]!.headers["idempotency-key"];
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(ack.idempotencyKey).toBe(sent);
  });

  it("uses a caller-supplied key verbatim", async () => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    await paylod.collect({ amount: 100, phone: "0712345678", idempotencyKey: "order-42" });
    expect(m.calls[0]!.headers["idempotency-key"]).toBe("order-42");
    // ...and does NOT leak into the JSON body.
    expect(m.calls[0]!.body).toEqual({ amount: 100, phone: "254712345678" });
  });

  it("generates a DIFFERENT key per call, so two charges are two charges", async () => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    await paylod.collect({ amount: 100, phone: "0712345678" });
    await paylod.collect({ amount: 100, phone: "0712345678" });
    expect(m.calls[0]!.headers["idempotency-key"]).not.toBe(
      m.calls[1]!.headers["idempotency-key"],
    );
  });

  it("replays the SAME key on a transient retry, so a retry cannot double-charge", async () => {
    const m = mockFetch([
      { status: 503, json: { error: "upstream" } },
      { status: 202, json: ACK },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 2 });
    const ack = await withFakeClock(() => paylod.collect({ amount: 100, phone: "0712345678" }));

    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.headers["idempotency-key"]).toBe(m.calls[1]!.headers["idempotency-key"]);
    expect(ack.paymentId).toBe("pay_123");
  });

  it("does NOT retry a 409 idempotency conflict — that is a bug, not a blip", async () => {
    const m = mockFetch([
      { status: 409, json: { error: "Idempotency-Key was reused with a different request body" } },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 3 });
    const err = await paylod
      .collect({ amount: 100, phone: "0712345678", idempotencyKey: "order-42" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.isIdempotencyConflict).toBe(true);
    expect(err.idempotencyKey).toBe("order-42");
    expect(m.count).toBe(1);
  });
});

describe("status", () => {
  it("GETs /status/:id", async () => {
    const { m, paylod } = client([
      { json: payment({ status: "success", mpesaReceipt: "SFF6XYZ123", resultCode: 0 }) },
    ]);
    const p = await paylod.status("pay_123");
    expect(m.calls[0]!.url).toBe("https://paylod.dev/functions/v1/status/pay_123");
    expect(m.calls[0]!.method).toBe("GET");
    expect(p.status).toBe("success");
    expect(p.mpesaReceipt).toBe("SFF6XYZ123");
  });
});

describe("collectAndWait", () => {
  it("happy path: polls past pending, returns ok:true with the receipt", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { json: payment({ status: "pending" }) },
      { json: payment({ status: "pending" }) },
      { json: payment({ status: "success", mpesaReceipt: "SFF6XYZ123", resultCode: 0 }) },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 0 });

    const onPoll = vi.fn();
    const r = await withFakeClock(() =>
      paylod.collectAndWait({ amount: 100, phone: "0712345678" }, { onPoll }),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.receipt).toBe("SFF6XYZ123");
    expect(r.payment.status).toBe("success");
    expect(onPoll).toHaveBeenCalledTimes(2); // only the pending snapshots
  });

  it("wrong PIN (2001): returns ok:false with the exact server-side customerMessage", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      {
        json: payment({
          status: "failed",
          resultCode: 2001,
          resultDesc: "The initiator information is invalid.",
        }),
      },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 0 });
    const r = await withFakeClock(() =>
      paylod.collectAndWait({ amount: 100, phone: "0712345678" }),
    );

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("2001");
    expect(r.error.title).toBe("Wrong M-Pesa PIN");
    expect(r.error.category).toBe("customer");
    expect(r.error.retryable).toBe(true);
    expect(r.error.customerMessage).toBe(
      "That M-Pesa PIN was incorrect. Please try again and enter the right PIN.",
    );
  });

  it("cancelled (1032): returns ok:false, does not throw", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { json: payment({ status: "failed", resultCode: 1032, resultDesc: "Request cancelled by user" }) },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 0 });
    const r = await withFakeClock(() =>
      paylod.collectAndWait({ amount: 100, phone: "0712345678" }),
    );

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.title).toBe("Payment cancelled by the customer");
    expect(r.error.customerMessage).toBe(
      "Payment cancelled — you can try again whenever you're ready.",
    );
  });

  it("timeout: THROWS PaylodTimeoutError carrying the still-pending payment", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { json: payment({ status: "pending" }) },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 0 });

    const err = await withFakeClock(() =>
      paylod
        .collectAndWait({ amount: 100, phone: "0712345678" }, { timeoutMs: 8_000 })
        .catch((e) => e),
    );

    expect(err).toBeInstanceOf(PaylodTimeoutError);
    expect(err.paymentId).toBe("pay_123");
    expect(err.payment.status).toBe("pending");
    expect(err.message).toMatch(/NOT failed/);
  });

  it("keeps polling while pending and stops on the first terminal state", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { json: payment({ status: "pending" }) },
      { json: payment({ status: "success", mpesaReceipt: "R1", resultCode: 0 }) },
      { json: payment({ status: "success", mpesaReceipt: "R1", resultCode: 0 }) },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 0 });
    await withFakeClock(() => paylod.collectAndWait({ amount: 1, phone: "0712345678" }));
    expect(m.count).toBe(3); // collect + 2 status reads, no more
  });
});

describe("decodeError", () => {
  it("decodes offline with no network call", () => {
    const paylod = new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch });
    const e = paylod.decodeError(1032);
    expect(e).toMatchObject({
      code: "1032",
      title: "Payment cancelled by the customer",
      category: "customer",
      retryable: true,
    });
  });

  it("falls back gracefully on an unknown code, preferring the raw description", () => {
    const paylod = new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch });
    const e = paylod.decodeError(4242, "Something odd happened");
    expect(e.code).toBe("4242");
    expect(e.title).toBe("Payment failed");
    expect(e.cause).toBe("Something odd happened");
    expect(e.retryable).toBe(true);
  });

  it("decodes success (0)", () => {
    const paylod = new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch });
    expect(paylod.decodeError(0).category).toBe("success");
  });
});

describe("phone normalisation edge cases", () => {
  it("rejects empty, non-Kenyan, and wrong-length numbers", async () => {
    const { paylod } = client([]);
    await expect(paylod.collect({ amount: 1, phone: "" })).rejects.toThrow(/required/);
    await expect(paylod.collect({ amount: 1, phone: "+1 415 555 0100" })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
    await expect(paylod.collect({ amount: 1, phone: "07123" })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
  });

  it("rejects over-long accountReference / description before the network", async () => {
    const { m, paylod } = client([]);
    await expect(
      paylod.collect({ amount: 1, phone: "0712345678", accountReference: "x".repeat(13) }),
    ).rejects.toThrow(/12 characters/);
    await expect(
      paylod.collect({ amount: 1, phone: "0712345678", description: "x".repeat(65) }),
    ).rejects.toThrow(/64 characters/);
    expect(m.count).toBe(0);
  });

  it("rejects an empty paymentId on status()", async () => {
    const { paylod } = client([]);
    await expect(paylod.status("")).rejects.toThrow(PaylodInvalidRequestError);
  });
});

describe("retries", () => {
  beforeEach(() => vi.useRealTimers());

  it("retries a network failure and then succeeds", async () => {
    const m = mockFetch([
      { throw: new TypeError("fetch failed") },
      { status: 202, json: ACK },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 2 });
    const ack = await withFakeClock(() => paylod.collect({ amount: 1, phone: "0712345678" }));
    expect(ack.paymentId).toBe("pay_123");
    expect(m.count).toBe(2);
  });

  it("does not retry a 422 validation error from the server", async () => {
    const m = mockFetch([{ status: 422, json: { error: "invalid Kenyan phone number" } }]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, maxRetries: 3 });
    await expect(paylod.collect({ amount: 1, phone: "0712345678" })).rejects.toThrow(
      PaylodApiError,
    );
    expect(m.count).toBe(1);
  });
});
