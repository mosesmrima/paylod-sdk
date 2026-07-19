/**
 * ROUND 8 — the findings from the eighth independent review.
 *
 * The cross-SDK roots this round is really about, each of which turned up in two or more sibling
 * SDKs wearing different clothes:
 *
 *   R-A  A MONEY VERDICT MUST NOT BE REACHABLE THROUGH SPELLING. PHP scanned raw bytes for a
 *        literal `"resultCode"` key and was walked past with a JSON-escaped spelling. Node had
 *        no scan at all and was walked past by arithmetic: `JSON.parse` maps `0.0`, `0e999`,
 *        `1.032e3` onto the same doubles as `0` and `1032`, so a body could declare itself PAID,
 *        or declare a cancellation RETRYABLE, in a spelling no strictness check downstream could
 *        still see.
 *
 *   R-B  EVERY EXPOSED `retryable` FIELD, NOT JUST THE TOP-LEVEL ONE. JVM and Python both had a
 *        nested `detail.retryable: true` sitting beside a top-level `retryable: false` on an
 *        indeterminate verdict — a public field telling the caller another charge is safe on a
 *        payment we cannot prove anything about.
 *
 *   R-C  A REFUSAL PATH LEAKS AS READILY AS A SUCCESS PATH. Schema diagnostics interpolate the
 *        field values they are refusing, and those messages go into 400 bodies and logs.
 *
 *   R-D  THE SAFETY NET MUST NOT BE THROWABLE. An exotic throwable that throws during
 *        `instanceof` escaped the reconciliation wrapper carrying neither handle — the failure
 *        mode most likely to involve a hostile value was the one that stripped the recovery
 *        information.
 *
 * Each test here is the guard for one reverted-protection case in `scripts/non-vacuity.mjs`.
 */

import { describe, expect, it, vi } from "vitest";
import { Paylod, parseBounded } from "../src/client.js";
import { withIdempotencyKey } from "../src/reconcile.js";
import {
  PaylodError,
  PaylodResponseTooLargeError,
  PaylodSignatureVerificationError,
} from "../src/errors.js";
import { toOutcome } from "../src/outcome.js";
import { signWebhook, verifyWebhook, verifyWebhookSignature } from "../src/webhook.js";
import { payment } from "./helpers.js";

const KEY = "mp_test_round8secretkey";
const SECRET = "whsec_round8signingsecret";

function client(fetch: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
  return new Paylod(KEY, {
    fetch,
    allowCustomFetch: true,
    webhookSecret: SECRET,
    ...over,
  } as never);
}

/**
 * A fetch that answers with EXACT BYTES.
 *
 * `mockFetch` in `helpers.ts` takes an object and `JSON.stringify`s it, which is precisely the
 * step that destroys a deliberately non-canonical numeric spelling — so every existing
 * result-code test in this repo was structurally incapable of expressing the attack. That is
 * the test-quality finding as much as the code one.
 */
function rawFetch(text: string, status = 200) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, calls };
}

// ── H1 — numeric-lexeme laundering ───────────────────────────────────────────────────────────

describe("H1 a result code cannot be laundered through a JSON number spelling", () => {
  const PAID_SPELLINGS = ["0.0", "0e999", "0E0", "-0", "0.000", "+0"];
  const CANCELLED_SPELLINGS = ["1032.0", "1.032e3", "01032"];

  for (const spelling of [...PAID_SPELLINGS, ...CANCELLED_SPELLINGS]) {
    it(`refuses a status body whose resultCode is spelt ${spelling}`, async () => {
      const body = `{"id":"pay_1","status":"success","mpesaReceipt":null,"resultCode":${spelling},"resultDesc":"ok"}`;
      const { fetch } = rawFetch(body);
      await expect(client(fetch).check("pay_1")).rejects.toThrow(PaylodResponseTooLargeError);
    });
  }

  it("still accepts the canonical spellings paylod actually emits", async () => {
    const body = `{"id":"pay_1","status":"success","mpesaReceipt":"SFF6XYZ123","resultCode":0,"resultDesc":"ok"}`;
    const { fetch } = rawFetch(body);
    const outcome = await client(fetch).check("pay_1");
    expect(outcome.paid).toBe(true);
  });

  it("an ESCAPED member name is decoded before the key is matched", () => {
    // `resultCode` IS `resultCode` to every JSON parser. A raw-bytes search for the literal
    // key walks straight past it — the exact bypass that landed in the PHP sibling.
    expect(() => parseBounded('{"\\u0072esultCode": 0.0}')).toThrow(PaylodResponseTooLargeError);
    expect(() => parseBounded('{"result\\u0043ode": 1.032e3}')).toThrow(
      PaylodResponseTooLargeError,
    );
  });

  it("EVERY duplicate occurrence is checked, not just the winner", () => {
    // Which duplicate wins is a parser detail. Both orders are refused so a hostile spelling
    // cannot hide behind a canonical decoy in either position.
    expect(() => parseBounded('{"resultCode":1032,"resultCode":-0}')).toThrow(
      PaylodResponseTooLargeError,
    );
    expect(() => parseBounded('{"resultCode":-0,"resultCode":1032}')).toThrow(
      PaylodResponseTooLargeError,
    );
  });

  it("a resultCode nested anywhere in the document is checked", () => {
    expect(() => parseBounded('{"a":{"b":[{"resultCode":0.0}]}}')).toThrow(
      PaylodResponseTooLargeError,
    );
  });

  it("does not fire on the same characters inside a STRING VALUE", () => {
    // `"resultCode"` appearing as a value, or as free text in a description, is not a member name.
    expect(parseBounded('{"resultDesc":"resultCode: 1032.0","resultCode":1032}')).toEqual({
      resultDesc: "resultCode: 1032.0",
      resultCode: 1032,
    });
  });

  it("a STRING-valued resultCode is left to the catalog's own strictness", () => {
    // `"0.0"` as a string keeps its spelling all the way to `canonicalCodeForm`, which already
    // refuses it. Refusing here as well would be a second, divergent implementation of one rule.
    expect(parseBounded('{"resultCode":"0.0"}')).toEqual({ resultCode: "0.0" });
  });

  it("a laundered resultCode is refused on the SIGNED WEBHOOK path too", () => {
    const raw = `{"type":"payment.success","created":1,"data":{"paymentId":"pay_1","applicationId":"app_1","env":"sandbox","status":"success","amount":100,"phone":"254712345678","accountRef":null,"mpesaReceipt":null,"checkoutRequestId":"ws_1","resultCode":0.0,"resultDesc":"ok"}}`;
    expect(() =>
      verifyWebhook({
        payload: raw,
        signature: signWebhook(raw, SECRET, 1),
        secret: SECRET,
        nowSec: 1,
      }),
    ).toThrow(PaylodSignatureVerificationError);
  });

  it("the signed webhook path also carries the parse-DEPTH budget", () => {
    const deep = `{"type":"payment.success","created":1,"data":${"[".repeat(200)}${"]".repeat(200)}}`;
    expect(() =>
      verifyWebhookSignature({
        payload: deep,
        signature: signWebhook(deep, SECRET, 1),
        secret: SECRET,
        nowSec: 1,
      }),
    ).toThrow(PaylodSignatureVerificationError);
  });
});

// ── H3 — the webhook credential scan ─────────────────────────────────────────────────────────

describe("H3 a verified webhook body cannot carry any of this client's credentials", () => {
  function signedEvent(over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) {
    return JSON.stringify({
      type: "payment.failed",
      created: 1,
      data: {
        paymentId: "pay_1",
        applicationId: "app_1",
        env: "sandbox",
        status: "failed",
        amount: 100,
        phone: "254712345678",
        accountRef: null,
        mpesaReceipt: null,
        checkoutRequestId: "ws_1",
        resultCode: 1032,
        resultDesc: "Request cancelled by user",
        ...dataOver,
      },
      ...over,
    });
  }

  it("REFUSES a signed body whose resultDesc echoes the API KEY, not just the signing secret", () => {
    const raw = signedEvent({}, { resultDesc: `cancelled (auth: Bearer ${KEY})` });
    expect(() =>
      verifyWebhook({
        payload: raw,
        signature: signWebhook(raw, SECRET, 1),
        secret: SECRET,
        apiKey: KEY,
        nowSec: 1,
      }),
    ).toThrow(PaylodSignatureVerificationError);
  });

  it("the CLASS WRAPPER supplies the API key to the verifier by itself", () => {
    // The integration path. The standalone function can be handed the key by a careful caller;
    // `paylod.verifyWebhook` is what everybody actually uses, and it knew the key all along.
    const raw = signedEvent({}, { resultDesc: `see ${KEY}` });
    const paylod = client(vi.fn() as unknown as typeof globalThis.fetch);
    expect(() =>
      paylod.verifyWebhook({ payload: raw, signature: signWebhook(raw, SECRET, 1) }),
    ).toThrow(PaylodSignatureVerificationError);
  });

  it("the SIGNATURE-ONLY helper refuses a credential-bearing body instead of returning it raw", () => {
    const raw = signedEvent({}, { resultDesc: `token ${KEY}` });
    expect(() =>
      verifyWebhookSignature({
        payload: raw,
        signature: signWebhook(raw, SECRET, 1),
        secret: SECRET,
        apiKey: KEY,
        nowSec: 1,
      }),
    ).toThrow(PaylodSignatureVerificationError);
  });

  it("a SCHEMA DIAGNOSTIC never quotes a credential back to the caller", () => {
    // `status` is invalid AND carries the key, so the refusal path is the one that runs. The old
    // diagnostic interpolated `JSON.stringify(d.status)` straight into the message.
    const raw = signedEvent({}, { status: `not-a-status-${KEY}` });
    try {
      verifyWebhook({
        payload: raw,
        signature: signWebhook(raw, SECRET, 1),
        secret: SECRET,
        apiKey: KEY,
        nowSec: 1,
      });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(PaylodSignatureVerificationError);
      expect((e as Error).message).not.toContain(KEY);
    }
  });

  it("an ordinary event still verifies", () => {
    const raw = signedEvent();
    const event = verifyWebhook({
      payload: raw,
      signature: signWebhook(raw, SECRET, 1),
      secret: SECRET,
      apiKey: KEY,
      nowSec: 1,
    });
    expect(event.data.paymentId).toBe("pay_1");
  });
});

// ── H2 — every exposed retryable field ───────────────────────────────────────────────────────

describe("H2 no exposed retryable field says `safe to charge again` unless the verdict is failed", () => {
  /** Every public boolean in a `PaymentOutcome` that answers "is another charge safe?". */
  function exposedRetryables(o: ReturnType<typeof toOutcome>): boolean[] {
    return [o.retryable, ...(o.detail ? [o.detail.retryable] : [])];
  }

  it("an INDETERMINATE verdict exposes no true retryable anywhere, top level or nested", () => {
    // `status: "pending"` with a terminal cancellation code contradicts itself: we cannot prove
    // money did or did not move. 1032 is `retryable: true` in the catalog, and that nested `true`
    // used to survive into the outcome beside a top-level `false`.
    const o = toOutcome(payment({ status: "pending", resultCode: 1032 }));
    expect(o.status).toBe("pending");
    expect(exposedRetryables(o)).toEqual([false, false]);
  });

  it("an IN-FLIGHT verdict exposes no true retryable anywhere", () => {
    const o = toOutcome(payment({ status: "pending", resultCode: 4999 }));
    expect(o.status).toBe("pending");
    expect(exposedRetryables(o).some(Boolean)).toBe(false);
  });

  it("a PAID verdict exposes no true retryable anywhere", () => {
    const o = toOutcome(
      payment({ status: "success", mpesaReceipt: "SFF6XYZ123", resultCode: 0 }),
    );
    expect(o.paid).toBe(true);
    expect(exposedRetryables(o).some(Boolean)).toBe(false);
  });

  it("a genuine terminal FAILURE still reports retryable at BOTH levels — the fix discriminates", () => {
    // The other direction matters just as much: forcing every nested `retryable` false everywhere
    // would pass the tests above while destroying the one case the field exists for.
    const o = toOutcome(payment({ status: "failed", resultCode: 1032 }));
    expect(o.status).toBe("cancelled");
    expect(exposedRetryables(o)).toEqual([true, true]);
  });

  it("the rest of the decoded detail is untouched on an indeterminate verdict", () => {
    const o = toOutcome(payment({ status: "pending", resultCode: 1032 }));
    expect(o.detail?.code).toBe("1032");
    expect(o.detail?.title.length).toBeGreaterThan(0);
  });
});

// ── H4 — the reconciliation wrapper cannot throw ─────────────────────────────────────────────

describe("H4 the reconciliation envelope survives a throwable that fights back", () => {
  /** A Proxy whose `getPrototypeOf` throws — so `err instanceof PaylodError` itself throws. */
  function hostileThrowable(): unknown {
    return new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("instanceof is not your friend");
        },
        get() {
          throw new Error("nor is a property read");
        },
      },
    );
  }

  it("a throwable that throws during `instanceof` still yields BOTH handles", () => {
    const wrapped = withIdempotencyKey(hostileThrowable(), "attempt-1", (m) => m, "pay_1");
    expect(wrapped).toBeInstanceOf(PaylodError);
    expect((wrapped as PaylodError).idempotencyKey).toBe("attempt-1");
    expect((wrapped as PaylodError).paymentId).toBe("pay_1");
  });

  it("a throwing REDACTOR cannot strip the handles either", () => {
    const wrapped = withIdempotencyKey(
      new Error("boom"),
      "attempt-2",
      () => {
        throw new Error("the redactor itself failed");
      },
      "pay_2",
    );
    expect(wrapped).toBeInstanceOf(PaylodError);
    expect((wrapped as PaylodError).idempotencyKey).toBe("attempt-2");
    expect((wrapped as PaylodError).paymentId).toBe("pay_2");
  });

  it("the wrapper NEVER throws, whatever it is handed", () => {
    for (const value of [hostileThrowable(), Symbol("s"), null, undefined, 0, ""]) {
      expect(() => withIdempotencyKey(value, "k", (m) => m, "pay")).not.toThrow();
    }
  });

  it("an ordinary PaylodError is still returned untouched", () => {
    const err = new PaylodError("ordinary");
    err.idempotencyKey = "already-set";
    const wrapped = withIdempotencyKey(err, "other-key", (m) => m);
    expect(wrapped).toBe(err);
    expect((wrapped as PaylodError).idempotencyKey).toBe("already-set");
  });
});
