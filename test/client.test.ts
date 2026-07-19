import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Paylod,
  PaylodApiError,
  PaylodConfigError,
  PaylodInvalidRequestError,
  PaylodTimeoutError,
} from "../src/index.js";
import { ACK, mockFetch, payment, type Step } from "./helpers.js";

const KEY = "mp_test_abc123";

function client(steps: Parameters<typeof mockFetch>[0], opts = {}) {
  const m = mockFetch(steps);
  return {
    m,
    paylod: new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0, ...opts }),
  };
}

/** Runs `fn` with fake timers so the poll backoff doesn't make the suite take 2 minutes. */
async function withFakeClock<T>(fn: () => Promise<T>): Promise<T> {
  // `performance` must be faked alongside `Date`: operation deadlines are measured on the
  // MONOTONIC clock (performance.now()), so a fake clock that only advances Date would leave
  // every deadline permanently in the future and this helper would spin forever.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
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
  it("takes a bare API key — no options object, no base URL, no ceremony", async () => {
    vi.stubEnv("PAYLOD_API_KEY", "");
    const m = mockFetch([{ status: 202, json: ACK }]);
    // The documented form. Everything else is defaulted.
    const paylod = new Paylod(KEY, { fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    await paylod.collect({ idempotencyKey: "t-32", amount: 1, phone: "0712345678" });
    // The base URL is baked in: the caller never supplied one.
    expect(m.calls[0]!.url).toBe("https://paylod.dev/functions/v1/collect");
    expect(m.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("reads PAYLOD_API_KEY from the environment", () => {
    vi.stubEnv("PAYLOD_API_KEY", KEY);
    expect(() => new Paylod()).not.toThrow();
  });

  it("throws a config error when no key is available", () => {
    vi.stubEnv("PAYLOD_API_KEY", "");
    expect(() => new Paylod()).toThrow(PaylodConfigError);
  });

  it("fails loudly at construction rather than handing back a client that will 401", () => {
    vi.stubEnv("PAYLOD_API_KEY", "");
    expect(() => new Paylod("   ")).toThrow(PaylodConfigError);
    expect(() => new Paylod("")).toThrow(PaylodConfigError);
  });

  it("defaults to the live base URL and allows an override", async () => {
    const a = client([{ status: 202, json: ACK }]);
    await a.paylod.collect({ idempotencyKey: "t-31", amount: 1, phone: "0712345678" });
    expect(a.m.calls[0]!.url).toBe("https://paylod.dev/functions/v1/collect");

    const b = client([{ status: 202, json: ACK }], { baseUrl: "https://api.paylod.dev/v1/" });
    await b.paylod.collect({ idempotencyKey: "t-30", amount: 1, phone: "0712345678" });
    expect(b.m.calls[0]!.url).toBe("https://api.paylod.dev/v1/collect");
  });
});

describe("collect", () => {
  it("posts a normalised body and returns the 202 ack", async () => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    const ack = await paylod.collect({ idempotencyKey: "t-29", amount: 100, phone: "0712345678" });

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
    await paylod.collect({ idempotencyKey: "t-28", amount: 5, phone: input });
    expect((m.calls[0]!.body as { phone: string }).phone).toBe(expected);
  });

  it("rejects bad input locally, before any network call", async () => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    await expect(paylod.collect({ idempotencyKey: "t-27", amount: 10.5, phone: "0712345678" })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
    await expect(paylod.collect({ idempotencyKey: "t-26", amount: 0, phone: "0712345678" })).rejects.toThrow(/between 1/);
    await expect(paylod.collect({ idempotencyKey: "t-25", amount: 150_001, phone: "0712345678" })).rejects.toThrow(
      /150000/,
    );
    await expect(paylod.collect({ idempotencyKey: "t-24", amount: 10, phone: "0812345678" })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
    expect(m.count).toBe(0);
  });

  it("surfaces an API error with its status and decoded message", async () => {
    const { paylod } = client([{ status: 401, json: { error: "invalid API key" } }]);
    const err = await paylod.collect({ idempotencyKey: "t-23", amount: 10, phone: "0712345678" }).catch((e) => e);
    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.status).toBe(401);
    expect(err.isAuthError).toBe(true);
    expect(err.message).toBe("invalid API key");
  });
});

describe("idempotency", () => {
  it("generates an Idempotency-Key ONLY under the explicit opt-out, and returns it on the ack", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    const ack = await paylod.collect({
      amount: 100,
      phone: "0712345678",
      unsafeGeneratedIdempotencyKey: true,
    });
    const sent = m.calls[0]!.headers["idempotency-key"];
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(ack.idempotencyKey).toBe(sent);
    warn.mockRestore();
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
    await paylod.collect({ idempotencyKey: "t-21", amount: 100, phone: "0712345678" });
    await paylod.collect({ idempotencyKey: "t-20", amount: 100, phone: "0712345678" });
    expect(m.calls[0]!.headers["idempotency-key"]).not.toBe(
      m.calls[1]!.headers["idempotency-key"],
    );
  });

  it("replays the SAME key on a transient retry, so a retry cannot double-charge", async () => {
    const m = mockFetch([
      { status: 503, json: { error: "upstream" } },
      { status: 202, json: ACK },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 2 });
    const ack = await withFakeClock(() => paylod.collect({ idempotencyKey: "t-19", amount: 100, phone: "0712345678" }));

    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.headers["idempotency-key"]).toBe(m.calls[1]!.headers["idempotency-key"]);
    expect(ack.paymentId).toBe("pay_123");
  });

  it("does NOT retry a 409 idempotency conflict — that is a bug, not a blip", async () => {
    const m = mockFetch([
      { status: 409, json: { error: "Idempotency-Key was reused with a different request body" } },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 3 });
    const err = await paylod
      .collect({ amount: 100, phone: "0712345678", idempotencyKey: "order-42" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.isIdempotencyConflict).toBe(true);
    expect(err.idempotencyKey).toBe("order-42");
    expect(m.count).toBe(1);
  });
});

/**
 * THE DOUBLE-CHARGE GUARD.
 *
 * `idempotencyKey` is REQUIRED. The SDK used to mint one when the caller omitted it and warn once
 * per process — but a key minted inside the call is a fresh value on every call, so it collapses
 * nothing, and the caller is the only party that knows a retry is a retry. Application-level and
 * job-queue retry is explicitly in this SDK's threat model, and it is exactly what a per-call
 * generated key cannot survive.
 *
 * The escape hatch is named for what it is, and it warns on EVERY call — never once per process,
 * because a worker that handles a thousand unprotected charges in a loop must hear about all
 * thousand. Each one is a separate chance to charge a customer twice.
 */
describe("required idempotencyKey", () => {
  const NO_REQUEST: Step[] = [];

  it("REFUSES collect() with no idempotencyKey, before a single request is dispatched", async () => {
    const { m, paylod } = client(NO_REQUEST);

    await expect(
      // @ts-expect-error — omitting the key is a COMPILE error too; this proves the runtime guard.
      paylod.collect({ amount: 100, phone: "0712345678" }),
    ).rejects.toThrow(PaylodInvalidRequestError);

    expect(m.calls).toHaveLength(0);
  });

  it("names the key, the danger and the escape hatch in the refusal", async () => {
    const { paylod } = client(NO_REQUEST);
    const err = await paylod
      // @ts-expect-error — see above.
      .collect({ amount: 100, phone: "0712345678" })
      .catch((e: unknown) => e);
    const message = String((err as Error).message);

    expect(message).toContain("idempotencyKey");
    expect(message).toContain("charge your customer twice");
    expect(message).toContain("unsafeGeneratedIdempotencyKey");
  });

  it("REFUSES collectAndWait() too — it is the call most people actually make", async () => {
    const { m, paylod } = client(NO_REQUEST);

    await expect(
      // @ts-expect-error — see above.
      paylod.collectAndWait({ amount: 100, phone: "0712345678" }),
    ).rejects.toThrow(PaylodInvalidRequestError);

    expect(m.calls).toHaveLength(0);
  });

  it("REFUSES simulate.collect() too — a simulator laxer than production certifies a lie", async () => {
    const paylod = new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch, allowCustomFetch: true });

    await expect(
      // @ts-expect-error — see above.
      paylod.simulate.collect({ amount: 100 }),
    ).rejects.toThrow(PaylodInvalidRequestError);
  });

  it("REFUSES simulate.pay() too", async () => {
    const paylod = new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch, allowCustomFetch: true });

    await expect(
      // @ts-expect-error — see above.
      paylod.simulate.pay({ outcome: "approve" }),
    ).rejects.toThrow(PaylodInvalidRequestError);
  });

  it("fails CLOSED on a truthy-but-not-true opt-out — `\"false\"` from an env var must not open it", async () => {
    const { m, paylod } = client(NO_REQUEST);

    for (const truthy of ["true", 1, "yes", {}]) {
      await expect(
        // @ts-expect-error — the type forbids these; the runtime must too.
        paylod.collect({ amount: 100, phone: "0712345678", unsafeGeneratedIdempotencyKey: truthy }),
      ).rejects.toThrow(PaylodInvalidRequestError);
    }

    expect(m.calls).toHaveLength(0);
  });

  it("stays silent, and dispatches, when the caller supplies a key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { m, paylod } = client([{ status: 202, json: ACK }]);

    await paylod.collect({ amount: 100, phone: "0712345678", idempotencyKey: "order-1042" });

    expect(m.calls[0]!.headers["idempotency-key"]).toBe("order-1042");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("unsafeGeneratedIdempotencyKey warns on EVERY call", () => {
  it("warns once for one opt-out call, naming the flag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { paylod } = client([{ status: 202, json: ACK }]);

    await paylod.collect({ amount: 100, phone: "0712345678", unsafeGeneratedIdempotencyKey: true });

    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain("unsafeGeneratedIdempotencyKey");
    expect(msg).toContain("charge your customer twice");
    warn.mockRestore();
  });

  /**
   * THE REGRESSION THIS EXISTS FOR. The old warner was module-level `warnedMissingIdempotencyKey`
   * state, so N charges in a loop produced exactly ONE warning — and a charge in a loop is the
   * precise scenario the warning is for. N calls, N warnings, from ONE call site, in ONE process,
   * on ONE client. No `vi.resetModules()`: the point is that no per-process state exists to reset.
   */
  it("emits N warnings for N unprotected calls from the SAME call site in ONE process", async () => {
    const N = 25;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { m, paylod } = client(Array.from({ length: N }, () => ({ status: 202, json: ACK }) as Step));

    for (let i = 0; i < N; i++) {
      await paylod.collect({ amount: 100, phone: "0712345678", unsafeGeneratedIdempotencyKey: true });
    }

    expect(warn).toHaveBeenCalledTimes(N);
    expect(m.calls).toHaveLength(N);
    // And every generated key is DIFFERENT, which is the whole reason a generated key is not
    // idempotency: these N calls are N separate charges to the API.
    const keys = new Set(m.calls.map((c) => c.headers["idempotency-key"]));
    expect(keys.size).toBe(N);
    warn.mockRestore();
  });

  it("warns on EVERY call across separate client instances too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      const { paylod } = client([{ status: 202, json: ACK }]);
      await paylod.collect({ amount: 1, phone: "0712345678", unsafeGeneratedIdempotencyKey: true });
    }
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("warns via collectAndWait() and simulate.collect() as well", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { paylod } = client([
      { status: 202, json: ACK },
      { status: 200, json: payment({ status: "success", mpesaReceipt: "UG1F3A1U7J" }) },
    ]);

    await paylod.collectAndWait({ amount: 100, phone: "0712345678", unsafeGeneratedIdempotencyKey: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("collect()");

    const sim = new Paylod({
      apiKey: KEY,
      fetch: mockFetch([{ status: 202, json: { ...ACK, outcomes: [] } }]).fetch,
      allowCustomFetch: true,
    });
    await sim.simulate.collect({ amount: 1, unsafeGeneratedIdempotencyKey: true });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain("simulate.collect()");
    warn.mockRestore();
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
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });

    const onPoll = vi.fn();
    const r = await withFakeClock(() =>
      paylod.collectAndWait({ idempotencyKey: "t-13", amount: 100, phone: "0712345678" }, { onPoll }),
    );

    expect(r.status).toBe("succeeded");
    expect(r.paid).toBe(true);
    expect(r.receipt).toBe("SFF6XYZ123");
    // Succeeded is never "safe to charge again" — that would be a second charge.
    expect(r.retryable).toBe(false);
    expect(r.payment.status).toBe("success");
    expect(onPoll).toHaveBeenCalledTimes(2); // only the pending snapshots
  });

  it("wrong PIN (2001): renderable message + a safe retry, no branching required", async () => {
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
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    const r = await withFakeClock(() =>
      paylod.collectAndWait({ idempotencyKey: "t-12", amount: 100, phone: "0712345678" }),
    );

    // Everything a UI needs, with no `if` over result codes:
    expect(r.status).toBe("failed");
    expect(r.paid).toBe(false);
    expect(r.message).toBe(
      "That M-Pesa PIN was incorrect. Please try again and enter the right PIN.",
    );
    expect(r.retryable).toBe(true); // no money moved → a fresh charge is safe
    // …and the raw detail is still there for developers who want it.
    expect(r.code).toBe("2001");
    expect(r.detail?.title).toBe("Wrong M-Pesa PIN");
    expect(r.detail?.category).toBe("customer");
  });

  it("cancelled (1032): its own status, does not throw", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { json: payment({ status: "failed", resultCode: 1032, resultDesc: "Request cancelled by user" }) },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    const r = await withFakeClock(() =>
      paylod.collectAndWait({ idempotencyKey: "t-11", amount: 100, phone: "0712345678" }),
    );

    expect(r.status).toBe("cancelled"); // not lumped in with "failed"
    expect(r.paid).toBe(false);
    expect(r.retryable).toBe(true); // the customer chose to cancel; no money moved
    expect(r.message).toBe("Payment cancelled — you can try again whenever you're ready.");
    expect(r.detail?.title).toBe("Payment cancelled by the customer");
  });

  // ── THE REGRESSION THAT SHIPPED TWICE ────────────────────────────────────────────────────
  // Daraja reports 4999 / 500.001.1001 on a row the API marks `failed`, but they mean "the STK
  // prompt is live and the customer hasn't typed their PIN yet". Reporting that as a failure
  // and offering a retry fires a SECOND prompt and double-charges a paying customer.
  describe.each([
    [4999, "The transaction is still under processing"],
    ["500.001.1001", "The transaction is being processed"],
  ])("pending code %s masquerading as status:failed", (code, desc) => {
    it("keeps polling instead of returning a failure, then settles on the real outcome", async () => {
      const m = mockFetch([
        { status: 202, json: ACK },
        // The API says "failed" — but the code says "still waiting for the PIN".
        { json: payment({ status: "failed", resultCode: code as never, resultDesc: desc }) },
        // …and the customer then pays.
        { json: payment({ status: "success", resultCode: 0, mpesaReceipt: "SFF6XYZ123" }) },
      ]);
      const paylod = new Paylod(KEY, { fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
      const r = await withFakeClock(() =>
        paylod.collectAndWait({ idempotencyKey: "t-10", amount: 100, phone: "0712345678" }),
      );

      // If the SDK had trusted `status: "failed"`, this payment would have been reported as a
      // failure to a customer who was, at that moment, entering their PIN.
      expect(r.status).toBe("succeeded");
      expect(r.paid).toBe(true);
      expect(r.receipt).toBe("SFF6XYZ123");
    });

    it("check() reports it as pending and NEVER retryable", async () => {
      const m = mockFetch([
        { json: payment({ status: "failed", resultCode: code as never, resultDesc: desc }) },
      ]);
      const paylod = new Paylod(KEY, { fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
      const r = await paylod.check("pay_123");

      expect(r.status).toBe("pending");
      expect(r.paid).toBe(false);
      // The whole ballgame. A live prompt is not safe to charge again.
      expect(r.retryable).toBe(false);
      expect(r.message).toBe(
        "Check your phone and enter your M-Pesa PIN to complete this payment.",
      );
    });
  });

  it("timeout: THROWS PaylodTimeoutError carrying the still-pending payment", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { json: payment({ status: "pending" }) },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });

    const err = await withFakeClock(() =>
      paylod
        .collectAndWait({ idempotencyKey: "t-9", amount: 100, phone: "0712345678" }, { timeoutMs: 8_000 })
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
      { json: payment({ status: "success", mpesaReceipt: "SFF6XYZ123", resultCode: 0 }) },
      { json: payment({ status: "success", mpesaReceipt: "SFF6XYZ123", resultCode: 0 }) },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    await withFakeClock(() => paylod.collectAndWait({ idempotencyKey: "t-8", amount: 1, phone: "0712345678" }));
    expect(m.count).toBe(3); // collect + 2 status reads, no more
  });
});

describe("decodeError", () => {
  it("decodes offline with no network call", () => {
    const paylod = new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch, allowCustomFetch: true });
    const e = paylod.decodeError(1032);
    expect(e).toMatchObject({
      code: "1032",
      title: "Payment cancelled by the customer",
      category: "customer",
      retryable: true,
    });
  });

  it("falls back gracefully on an unknown code, preferring the raw description", () => {
    const paylod = new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch, allowCustomFetch: true });
    const e = paylod.decodeError(4242, "Something odd happened");
    expect(e.code).toBe("4242");
    expect(e.title).toBe("Payment failed");
    expect(e.cause).toBe("Something odd happened");
    // An UNKNOWN code is indeterminate — we do not know whether money moved, so a fresh charge
    // is NOT known to be safe. (Until 0.2 the SDK's forked catalog said `true` here, which
    // invited a blind re-charge on a code we cannot classify. The canonical table says false.)
    expect(e.retryable).toBe(false);
  });

  it("decodes success (0)", () => {
    const paylod = new Paylod({ apiKey: KEY, fetch: mockFetch([]).fetch, allowCustomFetch: true });
    expect(paylod.decodeError(0).category).toBe("success");
  });
});

describe("phone normalisation edge cases", () => {
  it("rejects empty, non-Kenyan, and wrong-length numbers", async () => {
    const { paylod } = client([]);
    await expect(paylod.collect({ idempotencyKey: "t-7", amount: 1, phone: "" })).rejects.toThrow(/required/);
    await expect(paylod.collect({ idempotencyKey: "t-6", amount: 1, phone: "+1 415 555 0100" })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
    await expect(paylod.collect({ idempotencyKey: "t-5", amount: 1, phone: "07123" })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
  });

  it("rejects over-long accountReference / description before the network", async () => {
    const { m, paylod } = client([]);
    await expect(
      paylod.collect({ idempotencyKey: "t-4", amount: 1, phone: "0712345678", accountReference: "x".repeat(13) }),
    ).rejects.toThrow(/12 characters/);
    await expect(
      paylod.collect({ idempotencyKey: "t-3", amount: 1, phone: "0712345678", description: "x".repeat(65) }),
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
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 2 });
    const ack = await withFakeClock(() => paylod.collect({ idempotencyKey: "t-2", amount: 1, phone: "0712345678" }));
    expect(ack.paymentId).toBe("pay_123");
    expect(m.count).toBe(2);
  });

  it("does not retry a 422 validation error from the server", async () => {
    const m = mockFetch([{ status: 422, json: { error: "invalid Kenyan phone number" } }]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 3 });
    await expect(paylod.collect({ idempotencyKey: "t-1", amount: 1, phone: "0712345678" })).rejects.toThrow(
      PaylodApiError,
    );
    expect(m.count).toBe(1);
  });
});
