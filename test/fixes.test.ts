/**
 * Regression tests for the 0.4.0 codex security-review fixes. Each block maps to a numbered fix
 * in the CHANGELOG. The theme is money-correctness: never report an unpaid charge as paid, never
 * invite a double-charge, and never put a secret or a plaintext key on the wire.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_ENTRIES,
  decodeDarajaResult,
  Paylod,
  PaylodApiError,
  PaylodConfigError,
  PaylodConnectionError,
  PaylodInvalidRequestError,
  PaylodSignatureVerificationError,
  SIGNATURE_HEADER,
  signWebhook,
  toOutcome,
  verifyWebhook,
  verifyWebhookSignature,
  type Payment,
} from "../src/index.js";
import { ACK, mockFetch, payment, type Step } from "./helpers.js";

const KEY = "mp_test_abc123";

function client(steps: Step[], opts = {}) {
  const m = mockFetch(steps);
  return { m, paylod: new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0, ...opts }) };
}

async function withFakeClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const promise = fn();
  const settled = promise.then(
    (v) => ({ v }),
    (e) => ({ e }),
  );
  for (let i = 0; i < 200; i++) await vi.advanceTimersByTimeAsync(1_000);
  const out = await settled;
  vi.useRealTimers();
  if ("e" in out) throw out.e;
  return (out as { v: T }).v;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ── FIX 1: raw status must not override the classifier ─────────────────────────────────────
describe("fix 1 — raw status never overrides the classifier", () => {
  const p = (over: Partial<Payment>): Payment => payment(over);

  it("code 4999 (pending) with status:success is NOT reported as paid", () => {
    const o = toOutcome(p({ status: "success", resultCode: 4999 as never, mpesaReceipt: "SFF6XYZ123" }));
    expect(o.paid).toBe(false);
    expect(o.status).toBe("pending");
    expect(o.retryable).toBe(false);
  });

  it("code 1032 (cancel/fail) with status:success is contradictory → indeterminate, not paid", () => {
    const o = toOutcome(p({ status: "success", resultCode: 1032, mpesaReceipt: "SFF6XYZ123" }));
    expect(o.paid).toBe(false);
    expect(o.retryable).toBe(false); // an indeterminate charge is never "safe to charge again"
    expect(o.receipt).toBeNull();
  });

  it("code 0 (success) with status:failed is contradictory → NOT paid", () => {
    const o = toOutcome(p({ status: "failed", resultCode: 0, mpesaReceipt: "SFF6XYZ123" }));
    expect(o.paid).toBe(false);
  });

  it("the ordinary agreeing case still resolves paid", () => {
    const o = toOutcome(p({ status: "success", resultCode: 0, mpesaReceipt: "SFF6XYZ123" }));
    expect(o.paid).toBe(true);
    expect(o.receipt).toBe("SFF6XYZ123");
  });
});

// ── FIX 2: catalog retryable flags flipped to false ────────────────────────────────────────
describe("fix 2 — 17/26/1025/9999 are no longer advertised as safe-to-charge-again", () => {
  it.each(["17", "26", "1025", "9999"])("code %s is retryable:false", (code) => {
    const entry = ALL_ENTRIES.find((e) => e.code === code && e.family === "stk_result");
    expect(entry?.retryable).toBe(false);
    expect(decodeDarajaResult(code).retryable).toBe(false);
  });

  it("4999 and 500.001.1001 remain pending and non-retryable", () => {
    expect(decodeDarajaResult(4999).category).toBe("pending");
    expect(decodeDarajaResult(4999).retryable).toBe(false);
    expect(decodeDarajaResult("500.001.1001").category).toBe("pending");
  });
});

// ── FIX 3: family-aware decoding ───────────────────────────────────────────────────────────
describe("fix 3 — dotted/alphanumeric terminal codes no longer decode as pending", () => {
  it("api_error 400.002.02 decodes as a terminal credentials error, not pending", () => {
    const d = decodeDarajaResult("400.002.02");
    expect(d.category).toBe("credentials");
    expect(d.category).not.toBe("pending");
    expect(d.retryable).toBe(false);
  });

  it("b2c/c2b C2B00011 decodes terminally (not pending)", () => {
    const d = decodeDarajaResult("C2B00011");
    expect(d.category).not.toBe("pending");
    expect(d.title).toMatch(/MSISDN/i);
  });

  it("the OVERLOADED 500.001.1001 decodes per family", () => {
    // api_error surface: the terminal 'merchant does not exist / insufficient funds' server error.
    const api = decodeDarajaResult("500.001.1001", "insufficient funds", "api_error");
    expect(api.category).toBe("mpesa_system");
    expect(api.retryable).toBe(false);
    expect(api.title).toMatch(/insufficient funds|merchant/i);

    // stk surface with no terminal message: still 'still processing' (unchanged, preserved).
    const stk = decodeDarajaResult("500.001.1001");
    expect(stk.category).toBe("pending");
  });

  it("2001 disambiguates by family: wrong PIN on STK, invalid initiator on B2C", () => {
    expect(decodeDarajaResult("2001").category).toBe("customer"); // STK: wrong PIN
    expect(decodeDarajaResult("2001", null, "b2c_c2b_result").category).toBe("credentials");
  });
});

// ── FIX 4: idempotency key validation ──────────────────────────────────────────────────────
describe("fix 4 — blank / whitespace / control-char idempotency keys are rejected", () => {
  it.each(["", "   ", "\t", "\n", "a\u0000b", "key\u007f"])(
    "rejects %j before any network call",
    async (bad) => {
      const { m, paylod } = client([{ status: 202, json: ACK }]);
      await expect(
        paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: bad }),
      ).rejects.toThrow(PaylodInvalidRequestError);
      expect(m.count).toBe(0);
    },
  );

  it("accepts a normal key", async () => {
    const { paylod } = client([{ status: 202, json: ACK }]);
    await expect(
      paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-1" }),
    ).resolves.toBeDefined();
  });
});

// ── FIX 5: a generated key is never lost on failure ────────────────────────────────────────
describe("fix 5 — the effective idempotency key is attached to a thrown error", () => {
  it("a network failure carries the generated key so a retry can reuse it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { m, paylod } = client([{ throw: new TypeError("fetch failed") }]);
    const err = await paylod
      .collect({ amount: 1, phone: "0712345678", unsafeGeneratedIdempotencyKey: true })
      .catch((e) => e);
    warn.mockRestore();
    const sentKey = m.calls[0]!.headers["idempotency-key"];
    expect(sentKey).toMatch(/^[0-9a-f-]{36}$/);
    expect((err as { idempotencyKey?: string }).idempotencyKey).toBe(sentKey);
  });
});

// ── FIX 6: in-progress 409 is the ONLY retried 409 ─────────────────────────────────────────
describe("fix 6 — only an explicit 'already in progress' 409 is retried", () => {
  it("retries an in-progress 409 (honouring Retry-After) with the SAME key, then succeeds", async () => {
    const m = mockFetch([
      {
        status: 409,
        json: { error: "An idempotency request is already in progress for this key" },
        headers: { "retry-after": "1" },
      },
      { status: 202, json: ACK },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 2 });
    const ack = await withFakeClock(() =>
      paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-1" }),
    );
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.headers["idempotency-key"]).toBe("attempt-1");
    expect(m.calls[1]!.headers["idempotency-key"]).toBe("attempt-1");
    expect(ack.paymentId).toBe("pay_123");
  });

  it("does NOT retry a body-conflict 409", async () => {
    const m = mockFetch([
      { status: 409, json: { error: "Idempotency-Key was reused with a different request body" } },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 3 });
    await expect(
      paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-1" }),
    ).rejects.toThrow(PaylodApiError);
    expect(m.count).toBe(1);
  });
});

// ── FIX 7: HTTPS enforcement on baseUrl ────────────────────────────────────────────────────
describe("fix 7 — baseUrl must be https (loopback http only behind a test flag, never live)", () => {
  it("rejects a plaintext non-loopback baseUrl", () => {
    expect(() => new Paylod(KEY, { baseUrl: "http://api.evil.example" })).toThrow(PaylodConfigError);
  });

  it("rejects loopback http WITHOUT the explicit flag", () => {
    expect(() => new Paylod(KEY, { baseUrl: "http://localhost:4010" })).toThrow(PaylodConfigError);
  });

  it("allows loopback http WITH the flag and a test key", () => {
    expect(
      () => new Paylod(KEY, { baseUrl: "http://127.0.0.1:4010", allowInsecureBaseUrl: true }),
    ).not.toThrow();
  });

  it("NEVER allows insecure http with a live key, even with the flag", () => {
    expect(
      () =>
        new Paylod("mp_live_abc123", {
          baseUrl: "http://localhost:4010",
          allowInsecureBaseUrl: true,
        }),
    ).toThrow(PaylodConfigError);
  });

  it("still accepts https", () => {
    expect(() => new Paylod(KEY, { baseUrl: "https://paylod.dev/functions/v1" })).not.toThrow();
  });
});

// ── FIX 8: no secret leakage ───────────────────────────────────────────────────────────────
describe("fix 8 — the API key is redacted from surfaced transport errors", () => {
  it("a transport error mentioning the key comes back redacted", async () => {
    const secretKey = "mp_test_super_secret_key";
    const m = mockFetch([{ throw: new Error(`socket hangup while sending Bearer ${secretKey}`) }]);
    const paylod = new Paylod({ apiKey: secretKey, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    const err = (await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k" })
      .catch((e) => e)) as PaylodConnectionError;
    expect(err).toBeInstanceOf(PaylodConnectionError);
    expect(err.message).not.toContain(secretKey);
    expect(err.message).toContain("[redacted]");
  });
});

// ── FIX 9: redirects are refused, not followed ─────────────────────────────────────────────
describe("fix 9 — a redirect response is refused (Authorization must not follow cross-origin)", () => {
  const EVIL = "https://evil.example/steal";

  /**
   * A fetch that ACTUALLY FOLLOWS REDIRECTS unless it is told `redirect: "manual"` — i.e. one that
   * behaves like the real thing.
   *
   * The previous mock here just handed back the 302 it was configured with and never followed
   * anything, which made the test vacuous in the way that matters most: the defence being tested
   * is the `redirect: "manual"` option, and a mock that ignores that option cannot tell whether
   * the SDK passes it. Delete the option and the old test still went green, while a real `fetch`
   * would have replayed the bearer token to the attacker's host.
   *
   * This one models the hop faithfully, so the test can assert the thing that actually matters:
   * the attacker's origin is NEVER contacted, and never sees the Authorization header.
   */
  function redirectingFetch() {
    const seen: { url: string; authorization: string | undefined }[] = [];

    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
      seen.push({ url: target, authorization: headers.authorization });

      // The attacker's endpoint happily returns a well-formed ack. If the SDK ever reaches this,
      // the charge "succeeds" against the wrong host — which is exactly the disaster in question.
      if (target.startsWith("https://evil.example")) {
        return new Response(
          JSON.stringify({ paymentId: "pay_stolen", checkoutRequestId: "ws_evil", status: "pending" }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }

      // The paylod origin answers with a cross-origin 302.
      if (init?.redirect === "manual") {
        return new Response(null, { status: 302, headers: { location: EVIL } });
      }
      // No `redirect: "manual"` → a real fetch would transparently follow the hop. Model that.
      return fn(EVIL, init);
    });

    return { fetch: fn as unknown as typeof globalThis.fetch, seen };
  }

  it("refuses the 3xx and never issues a second request to the redirect target", async () => {
    const m = redirectingFetch();
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });

    const err = (await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k" })
      .catch((e) => e)) as PaylodConnectionError;

    // 1. The redirect is an error, not a result.
    expect(err).toBeInstanceOf(PaylodConnectionError);
    expect(err.message).toMatch(/redirect/i);

    // 2. Exactly ONE request was made, to paylod. The attacker's host was never contacted —
    //    this is the assertion the old mock structurally could not make.
    expect(m.seen).toHaveLength(1);
    expect(m.seen[0]!.url).toContain("paylod.dev");
    expect(m.seen.some((r) => r.url.includes("evil.example"))).toBe(false);

    // 3. And therefore the bearer token never reached it.
    const leaked = m.seen.filter((r) => r.url.includes("evil.example") && r.authorization);
    expect(leaked).toEqual([]);
  });

  it("asks fetch for manual redirect handling in the first place", async () => {
    const m = redirectingFetch();
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    await paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "k" }).catch(() => {});
    expect((m.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
    });
  });
});

// ── FIX 10: malformed 2xx is indeterminate, not an empty success ───────────────────────────
describe("fix 10 — a 2xx with no id raises an indeterminate error carrying the key", () => {
  it("collect() on a 2xx with no paymentId throws indeterminate + key", async () => {
    const m = mockFetch([{ status: 202, json: { status: "pending" } }]); // no paymentId
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    const err = (await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-9" })
      .catch((e) => e)) as PaylodApiError;
    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.indeterminate).toBe(true);
    expect(err.idempotencyKey).toBe("attempt-9");
  });

  it("status() on a 2xx with no id throws (no silent empty Payment)", async () => {
    const m = mockFetch([{ status: 200, json: { status: "success" } }]); // no id
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    await expect(paylod.status("pay_1")).rejects.toThrow(PaylodApiError);
  });
});

// ── FIX 11: wait() propagates its deadline into each request ────────────────────────────────
describe("fix 11 — a single hung request cannot overrun the wait deadline", () => {
  it("caps the per-request timeout to the remaining wait budget", async () => {
    // fetch hangs until aborted; the CLIENT timeout is huge, the WAIT timeout is tiny.
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as unknown as typeof globalThis.fetch;

    const paylod = new Paylod({ apiKey: KEY, fetch: hangingFetch, allowCustomFetch: true, maxRetries: 0, timeoutMs: 10_000 });
    const started = Date.now();
    await expect(paylod.wait("pay_1", { timeoutMs: 120 })).rejects.toBeInstanceOf(
      PaylodConnectionError,
    );
    // If the deadline were NOT propagated, this would take ~10s (the client timeout).
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// ── FIX A/B: webhook timestamp parsing is lexical, and replay protection cannot be disabled ───
describe("fix A — the signature timestamp is parsed strictly, not with Number()", () => {
  const WH_SECRET = "whsec_fixes_secret";
  const WH_BODY =
    '{"type":"payment.success","created":1700000000,"data":{"paymentId":"pay_a","applicationId":"app_1","env":"sandbox","status":"success","amount":100,"phone":"254712345678","accountRef":null,"mpesaReceipt":"SFF6XYZ123","checkoutRequestId":"ws_CO_1","resultCode":0,"resultDesc":"ok","decoded":null}}';
  const WH_T = 1_700_000_000;

  /** Swap the `t=` field for an attacker-chosen string, keeping a well-formed 64-hex `v1`. */
  function headerWithT(t: string): string {
    const v1 = signWebhook(WH_BODY, WH_SECRET, WH_T).split("v1=")[1]!;
    return `t=${t},v1=${v1}`;
  }

  function reasonFor(t: string): string | undefined {
    try {
      verifyWebhook({
        payload: WH_BODY,
        signature: headerWithT(t),
        secret: WH_SECRET,
        toleranceSec: 300,
        nowSec: WH_T,
      });
    } catch (e) {
      return (e as PaylodSignatureVerificationError).reason;
    }
    return undefined;
  }

  // `Number()` accepts every one of these; `Number.isInteger` then waves the result through.
  it.each([
    ["exponent notation", "1e3"],
    ["a leading plus sign", "+1000"],
    ["hex radix notation", "0x10"],
    ["internal whitespace", "17000 00000"],
    ["a tab inside the value", "1700000000\t1"],
    ["whitespace with nothing else", "   "],
    ["Infinity", "Infinity"],
    ["a leading minus sign", "-1700000000"],
    ["a fractional value", "1700000000.5"],
    ["leading-zero padding beyond the digit budget", "0".repeat(16) + "1"],
  ])("rejects %s as malformed_signature", (_label, t) => {
    expect(reasonFor(t)).toBe("malformed_signature");
  });

  it("still accepts a plain decimal timestamp", () => {
    expect(reasonFor(String(WH_T))).toBeUndefined();
  });

  // Surrounding whitespace is stripped by the header-list parser BEFORE the timestamp is
  // validated — `t=1700000000, v1=…` with a space after the comma is a legitimate HTTP header, and
  // the trim is what makes it parse. So padding is not a way to smuggle a value past the digit
  // check: what reaches the regex is already trimmed, and the HMAC is recomputed over that same
  // trimmed `t`. Only whitespace the trim cannot remove (internal, above) is rejected.
  it("accepts a padded timestamp only because the header parser trims it first", () => {
    expect(reasonFor(" 1700000000 ")).toBeUndefined();
  });
});

describe("fix B — replay protection has no off switch", () => {
  const WH_SECRET = "whsec_fixes_secret";
  const WH_BODY =
    '{"type":"payment.success","created":1700000000,"data":{"paymentId":"pay_b","applicationId":"app_1","env":"sandbox","status":"success","amount":100,"phone":"254712345678","accountRef":null,"mpesaReceipt":"SFF6XYZ123","checkoutRequestId":"ws_CO_1","resultCode":0,"resultDesc":"ok","decoded":null}}';
  const WH_T = 1_700_000_000;
  const HEADER = signWebhook(WH_BODY, WH_SECRET, WH_T);

  function reasonFor(params: { toleranceSec?: number; nowSec?: number }): string | undefined {
    try {
      verifyWebhook({ payload: WH_BODY, signature: HEADER, secret: WH_SECRET, ...params });
    } catch (e) {
      return (e as PaylodSignatureVerificationError).reason;
    }
    return undefined;
  }

  // The regression that matters: each of these used to be ACCEPTED whenever a clock was injected.
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
    ["a non-integer", 0.5],
    ["a large non-integer", 300.5],
  ])("refuses a %s tolerance even WITH a pinned nowSec", (_label, toleranceSec) => {
    expect(reasonFor({ toleranceSec, nowSec: WH_T })).toBe("insecure_tolerance");
    // …and equally without one, so production behaviour is unchanged.
    expect(reasonFor({ toleranceSec })).toBe("insecure_tolerance");
  });

  it("explains that a finite positive integer is required and that replay protection is mandatory", () => {
    const err = (() => {
      try {
        verifyWebhook({
          payload: WH_BODY,
          signature: HEADER,
          secret: WH_SECRET,
          toleranceSec: 0,
          nowSec: WH_T,
        });
      } catch (e) {
        return e;
      }
    })() as PaylodSignatureVerificationError;
    expect(err.message).toMatch(/finite positive integer/i);
    expect(err.message).toMatch(/no way to disable/i);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -1],
    ["a non-integer", 1_700_000_000.5],
  ])("refuses an injected %s nowSec", (_label, nowSec) => {
    expect(reasonFor({ toleranceSec: 300, nowSec })).toBe("insecure_tolerance");
  });

  it("still rejects a stale timestamp under a normal positive tolerance", () => {
    expect(reasonFor({ toleranceSec: 300, nowSec: WH_T + 301 })).toBe("stale_timestamp");
    expect(reasonFor({ toleranceSec: 300, nowSec: WH_T - 301 })).toBe("stale_timestamp");
  });

  it("accepts a fresh timestamp inside the window", () => {
    expect(reasonFor({ toleranceSec: 300, nowSec: WH_T + 299 })).toBeUndefined();
  });

  it("verifies the shared golden vector with a normal window and a pinned clock", () => {
    const GOLDEN_SECRET = "whsec_golden_vector_v1";
    const GOLDEN_T = 1_700_000_000;
    const GOLDEN_BODY =
      '{"type":"payment.success","created":1700000000,"data":{"paymentId":"pay_golden","amount":100,"phone":"254712345678"}}';
    const GOLDEN_HEADER =
      "t=1700000000,v1=3afe38e4c11734c84fad70dd16bbaeec6057ca998236f253be6bfa09ad2c2eb7";

    expect(signWebhook(GOLDEN_BODY, GOLDEN_SECRET, GOLDEN_T)).toBe(GOLDEN_HEADER);
    // The vector pins the SIGNING SCHEME, so it is verified at the signature layer. Its body is a
    // deliberately minimal signing fixture, not a representative event, and the literals must stay
    // byte-identical across paylod-cli and the backend signer — so the schema rules that
    // `verifyWebhook` now enforces are checked separately rather than by editing this vector.
    const event = verifyWebhookSignature({
      payload: GOLDEN_BODY,
      signature: GOLDEN_HEADER,
      secret: GOLDEN_SECRET,
      toleranceSec: 300,
      nowSec: GOLDEN_T,
    }) as { data: { paymentId: string } };
    expect(event.data.paymentId).toBe("pay_golden");
  });
});


// ─────────────────────────────────────────────────────────────────────────────────────────────
// 0.4.1 — second-round codex re-verification fixes.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("0.4.1 fix 1 — an explicitly non-STK decode can never return an STK pending entry", () => {
  // 4999 exists ONLY under `stk_result`. The family-aware decoder used to fall back to "any entry
  // for this code", so asking for `api_error` handed back the STK pending entry — reporting a
  // terminal API failure as a payment still in flight. That is the 4999 double-charge bug's
  // "false pending" shape, reached from the other direction.
  it.each(["api_error", "b2c_c2b_result"] as const)(
    "decodes 4999 as terminal and non-retryable on the %s surface",
    (family) => {
      const d = decodeDarajaResult(4999, null, family);
      expect(d.category).not.toBe("pending");
      expect(d.retryable).toBe(false);
    },
  );

  it("still decodes 4999 as pending on the STK surface (the fix is scoped)", () => {
    const d = decodeDarajaResult(4999, null, "stk_result");
    expect(d.category).toBe("pending");
    expect(d.retryable).toBe(false);
  });

  it("INVARIANT: no code decodes as pending on any non-STK surface", () => {
    for (const entry of ALL_ENTRIES) {
      for (const family of ["api_error", "b2c_c2b_result"] as const) {
        expect(decodeDarajaResult(entry.code, null, family).category).not.toBe("pending");
      }
    }
  });
});

describe("0.4.1 fix 4 — the idempotency key charset rejects invisible characters", () => {
  const send = async (idempotencyKey: string) => {
    const { paylod } = client([{ status: 202, json: ACK }]);
    return paylod.collect({ phone: "254712345678", amount: 10, idempotencyKey });
  };

  // U+0085 (NEL) is a C1 control and a line terminator — several proxies fold it to a newline,
  // so it is a header-injection vector. The old C0+DEL check let the whole C1 block through.
  it.each([
    ["a C1 control (U+0085 NEL)", "key\u0085tail"],
    ["a C1 control (U+009f)", "key\u009ftail"],
    ["a C0 control", "key\u0001tail"],
    ["DEL", "key\u007ftail"],
  ])("rejects %s", async (_label, key) => {
    await expect(send(key)).rejects.toBeInstanceOf(PaylodInvalidRequestError);
  });

  it.each([
    ["a non-breaking space", "key\u00a0tail"],
    ["a zero-width space", "key\u200btail"],
    ["a zero-width joiner", "key\u200dtail"],
    ["an ideographic space", "key\u3000tail"],
    ["a BOM", "key\ufefftail"],
  ])("rejects %s (two keys that look identical are one double charge)", async (_label, key) => {
    await expect(send(key)).rejects.toBeInstanceOf(PaylodInvalidRequestError);
  });

  it("bounds the key by BYTES, not UTF-16 units", async () => {
    // 200 four-byte astral characters = 800 bytes: well under 255 "characters", far over 255 bytes.
    await expect(send("\u{1f600}".repeat(200))).rejects.toThrow(/255 bytes/);
    // A 255-BYTE ASCII key is still perfectly legal.
    await expect(send("a".repeat(255))).resolves.toBeDefined();
  });

  it("still accepts an ordinary UUID-shaped key", async () => {
    await expect(send("9f1c2b3a-0000-4d5e-8f00-112233445566")).resolves.toBeDefined();
  });
});

describe("0.4.1 fix 5 — the effective idempotency key is readable from TypeScript", () => {
  it("exposes idempotencyKey as a DECLARED field on the error, not an ad-hoc property", async () => {
    const { paylod } = client([{ throw: new TypeError("socket hang up") }]);
    const key = "attempt_typed_key_1";

    // The point of the fix: this reads the field through the declared type. Before, the property
    // existed at runtime but not on the type, so this line did not compile and callers were
    // pushed toward minting a fresh key — i.e. toward double-charging.
    let seen: string | undefined;
    try {
      await paylod.collect({ phone: "254712345678", amount: 10, idempotencyKey: key });
    } catch (e) {
      expect(e).toBeInstanceOf(PaylodConnectionError);
      seen = (e as PaylodConnectionError).idempotencyKey;
    }
    expect(seen).toBe(key);
  });
});

describe("0.4.1 fix 6 — the express adapter rejects duplicate signature headers", () => {
  const SECRET = "whsec_dup_header";
  const RAW =
    '{"type":"payment.success","created":1700000000,"data":{"paymentId":"pay_dup","applicationId":"app_1","env":"sandbox","status":"success","amount":100,"phone":"254712345678","accountRef":null,"mpesaReceipt":"SFF6XYZ123","checkoutRequestId":"ws_CO_1","resultCode":0,"resultDesc":"ok","decoded":null}}';
  const NOW = 1_700_000_000;

  function res() {
    const out = { code: 0, body: null as unknown };
    const r = {
      status(code: number) {
        out.code = code;
        return r;
      },
      json(body: unknown) {
        out.body = body;
        return body;
      },
    };
    return { r, out };
  }

  it("400s and never calls the handler when the signature header arrives twice", async () => {
    vi.setSystemTime(NOW * 1000);
    const handler = vi.fn();
    const paylod = new Paylod({ apiKey: KEY, webhookSecret: SECRET });
    const mw = paylod.webhook(handler);
    const { r, out } = res();

    // BOTH values are individually valid. Verifying element [0] while a downstream hop honours
    // the last one is precisely how signature-confusion attacks work — so we reject outright
    // rather than pick a winner.
    const good = signWebhook(RAW, SECRET, NOW);
    await mw(
      { headers: { [SIGNATURE_HEADER]: [good, good] }, body: Buffer.from(RAW, "utf8") },
      r,
    );

    expect(out.code).toBe(400);
    expect(String((out.body as { error: string }).error)).toMatch(/[Mm]ultiple/);
    expect(handler).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("still accepts the single-header happy path", async () => {
    vi.setSystemTime(NOW * 1000);
    const handler = vi.fn();
    const paylod = new Paylod({ apiKey: KEY, webhookSecret: SECRET });
    const mw = paylod.webhook(handler);
    const { r, out } = res();

    await mw(
      {
        headers: { [SIGNATURE_HEADER]: signWebhook(RAW, SECRET, NOW) },
        body: Buffer.from(RAW, "utf8"),
      },
      r,
    );

    expect(out.code).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("0.4.1 fix 7 — baseUrl is an allowlist, not merely https", () => {
  const make = (baseUrl: string, opts = {}) =>
    () => new Paylod({ apiKey: KEY, baseUrl, ...opts });

  it("accepts the canonical paylod origins", () => {
    expect(make("https://paylod.dev/functions/v1")).not.toThrow();
    expect(make("https://api.paylod.dev/v1")).not.toThrow();
  });

  // The core of the fix. Every one of these is valid HTTPS — and every one would have received
  // a live bearer key under the old "is it https?" check.
  it.each([
    ["an arbitrary host", "https://evil.example/v1"],
    ["a lookalike host", "https://paylod.dev.evil.example/v1"],
    ["a bare suffix match", "https://notpaylod.dev/v1"],
    ["userinfo smuggling the real host", "https://paylod.dev@evil.example/v1"],
    ["an unexpected port", "https://paylod.dev:8443/v1"],
    ["a query string", "https://paylod.dev/v1?leak=1"],
    ["a fragment", "https://paylod.dev/v1#x"],
    ["a private address", "https://10.0.0.1/v1"],
    ["cloud metadata", "https://169.254.169.254/v1"],
    ["loopback over https", "https://127.0.0.1/v1"],
  ])("rejects %s", (_label, url) => {
    expect(make(url)).toThrow(PaylodConfigError);
  });

  it("keeps the explicit test-only loopback exception for a test key", () => {
    expect(make("http://localhost:54321/functions/v1", { allowInsecureBaseUrl: true })).not.toThrow();
    expect(make("http://127.0.0.1:54321/functions/v1", { allowInsecureBaseUrl: true })).not.toThrow();
  });

  it("NEVER permits the loopback exception with a live key", () => {
    expect(
      () =>
        new Paylod({
          apiKey: "mp_live_realmoney",
          baseUrl: "http://127.0.0.1:54321/functions/v1",
          allowInsecureBaseUrl: true,
        }),
    ).toThrow(PaylodConfigError);
  });

  it("does not let the loopback opt-in unlock an arbitrary host", () => {
    expect(make("http://evil.example/v1", { allowInsecureBaseUrl: true })).toThrow(
      PaylodConfigError,
    );
    expect(make("https://evil.example/v1", { allowInsecureBaseUrl: true })).toThrow(
      PaylodConfigError,
    );
  });
});

describe("0.5.0 — cross-SDK standardization (loopback shape + unbounded sleep ceiling)", () => {
  it("requires the opt-in for HTTPS loopback too (TLS does not make a local listener paylod)", () => {
    expect(() => new Paylod({ apiKey: KEY, baseUrl: "https://127.0.0.1:8443/v1" })).toThrow(
      PaylodConfigError,
    );
    expect(
      () =>
        new Paylod({
          apiKey: KEY,
          baseUrl: "https://127.0.0.1:8443/v1",
          allowInsecureBaseUrl: true,
        }),
    ).not.toThrow();
  });

  it("never allows loopback with a live key, over http OR https", () => {
    for (const baseUrl of ["http://127.0.0.1:8443/v1", "https://localhost:8443/v1"]) {
      expect(
        () =>
          new Paylod({ apiKey: "mp_live_realmoney", baseUrl, allowInsecureBaseUrl: true }),
      ).toThrow(PaylodConfigError);
    }
  });

  it("a hostile Retry-After cannot park a bare collect() for hours", async () => {
    // THE NO-DEADLINE PATH, exercised on its own.
    //
    // This test used to prove nothing. `Retry-After` was independently clamped to 10s at the call
    // site, so that clamp — not the ceiling — was what bounded the sleep, and deleting
    // MAX_UNBOUNDED_SLEEP_MS entirely left the test green. The clamp has since been removed (one
    // bound, in one place: #boundedSleep), which makes the ceiling the ONLY thing standing between
    // a bare `collect()` and the 86400s the server asked for.
    //
    // `collect()` is the whole point: it carries no polling budget, so there is no deadline to
    // clamp against and the ceiling is the sole bound. Asserting the ELAPSED VIRTUAL TIME (not
    // merely "it finished") is what makes the assertion bite.
    const m = mockFetch([
      { status: 429, headers: { "retry-after": "86400" } },
      { status: 202, json: ACK },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 2 });

    // Both readings must be taken INSIDE the fake clock — `withFakeClock` restores real timers
    // before it returns, so measuring across the boundary would compare two different clocks.
    const { ack, elapsed } = await withFakeClock(async () => {
      const t0 = Date.now();
      const a = await paylod.collect({
        phone: "254712345678",
        amount: 10,
        idempotencyKey: "attempt_retry_after",
      });
      return { ack: a, elapsed: Date.now() - t0 };
    });

    expect(ack.paymentId).toBe("pay_123");
    expect(m.count).toBe(2);
    // Pinned to the 60s ceiling (plus the sub-second retry backoff), NOT to 86400s. Without the
    // ceiling this sleeps for a day: the fake clock only advances 200 virtual seconds, so the
    // collect never settles and the test fails outright.
    expect(elapsed).toBeGreaterThanOrEqual(55_000);
    expect(elapsed).toBeLessThanOrEqual(65_000);
  });

  it("an operation deadline still beats the ceiling (the tighter bound always wins)", async () => {
    // The ceiling must never EXTEND a caller's budget. `wait()` has a deadline, so a huge
    // Retry-After on a poll is cut to the remaining wait time — far below the 60s ceiling.
    const m = mockFetch([
      { status: 500, json: { error: "upstream" }, headers: { "retry-after": "86400" } },
    ]);
    const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 2 });

    const started = Date.now();
    await expect(paylod.wait("pay_1", { timeoutMs: 300 })).rejects.toBeInstanceOf(PaylodApiError);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("0.5.0 — idempotency keys must be printable ASCII", () => {
  const send = async (idempotencyKey: string) => {
    const { paylod } = client([{ status: 202, json: ACK }]);
    return paylod.collect({ phone: "254712345678", amount: 10, idempotencyKey });
  };

  // HTTP header values are ASCII on the wire (RFC 9110). A non-ASCII key either dies as an
  // unactionable encoding crash or, on a laxer stack, is SILENTLY re-encoded — so two requests
  // meant to share one key stop sharing it and the duplicate-charge guard quietly disappears.
  it.each([
    ["an accented latin character", "ordr-café-1"],
    ["a customer name in CJK", "attempt-注文-1"],
    ["cyrillic", "attempt-заказ"],
    ["an emoji", "attempt-\u{1f600}-1"],
  ])("rejects %s before dispatch", async (_label, key) => {
    await expect(send(key)).rejects.toBeInstanceOf(PaylodInvalidRequestError);
    await expect(send(key)).rejects.toThrow(/printable ASCII/);
  });

  it("accepts the full printable ASCII range", async () => {
    await expect(send("attempt_9f1c-2b3a.v1~+/=:")).resolves.toBeDefined();
  });
});
