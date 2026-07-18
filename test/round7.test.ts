/**
 * ROUND 7 — the findings from the seventh independent review.
 *
 * The two shared roots this round is really about, and which the JVM and Python SDKs are fixing
 * in parallel:
 *
 *   R-A  UNVALIDATED SERVER-CONTROLLED DATA MUST NEVER REACH A PUBLIC OBJECT. Every 2xx body and
 *        every verified webhook payload is server-controlled, and both were being handed back
 *        after validation rather than REBUILT from the fields that were validated — so unknown
 *        fields, and known free-text fields, could carry the bearer key or the signing secret
 *        into a `CollectAck`, a `Payment`, a `WebhookEvent`, and from there into ordinary logs.
 *
 *   R-B  A CLAIM MUST NEVER SUBSTITUTE FOR MISSING EVIDENCE. `status: "failed"` with no result
 *        code and no receipt was accepted as a terminal failure, in exactly the way
 *        `status: "success"` with no evidence had already been forbidden.
 *
 * Each test here is the guard for one reverted-protection case in `scripts/non-vacuity.mjs`.
 */

import { describe, expect, it, vi } from "vitest";
import { Paylod } from "../src/client.js";
import { renderThrowable, withIdempotencyKey } from "../src/reconcile.js";
import { PaylodApiError, PaylodError, PaylodInvalidRequestError } from "../src/errors.js";
import { judge } from "../src/semantics.js";
import { containsSecret } from "../src/validate.js";
import { MAX_WEBHOOK_BODY_BYTES, signWebhook, verifyWebhook } from "../src/webhook.js";
import { ACK, mockFetch, payment } from "./helpers.js";

const KEY = "mp_test_round7secretkey";
const SECRET = "whsec_round7signingsecret";
const IK = { idempotencyKey: "attempt-1" } as const;

function client(fetch: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
  return new Paylod(KEY, {
    fetch,
    allowCustomFetch: true,
    webhookSecret: SECRET,
    ...over,
  } as never);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// H1 — a successful 2xx body is REBUILT, and a credential-bearing one is refused
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("H1 a successful response is reconstructed, never passed through", () => {
  it("STRIPS unknown fields from a collect ack instead of returning them", async () => {
    const m = mockFetch([
      {
        status: 202,
        json: {
          ...ACK,
          // Everything below is a field the contract does not name. Each of these is a real
          // shape: a debug envelope, a proxy mirroring the request, an upstream echo. (The
          // credential-bearing variant is a SEPARATE test below — here the unknown fields are
          // benign, so this test can only pass by actually stripping them.)
          debug: { note: "upstream diagnostics" },
          __raw: "anything",
          resultDesc: "some server prose",
        },
      },
    ]);
    const ack = await client(m.fetch).collect({ amount: 100, phone: "0712345678", ...IK });

    // The ack carries EXACTLY the contract's fields, plus the client-side key. Nothing else.
    expect(Object.keys(ack).sort()).toEqual(
      ["checkoutRequestId", "idempotencyKey", "paymentId", "status"].sort(),
    );
    expect((ack as unknown as Record<string, unknown>).debug).toBeUndefined();
    expect((ack as unknown as Record<string, unknown>).__raw).toBeUndefined();
    expect((ack as unknown as Record<string, unknown>).resultDesc).toBeUndefined();
    // The serialized form is what reaches a log sink, and it carries only the contract.
    expect(JSON.stringify(ack)).not.toContain("upstream diagnostics");
  });

  it("STRIPS unknown fields from a status body instead of returning them", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      {
        status: 200,
        json: {
          id: "pay_123",
          status: "success",
          mpesaReceipt: "SFF6XYZ123",
          resultCode: 0,
          resultDesc: "Success",
          internal: { note: "upstream diagnostics" },
        },
      },
    ]);
    const c = client(m.fetch);
    await c.collect({ amount: 100, phone: "0712345678", ...IK });
    const p = await c.status("pay_123");

    expect(Object.keys(p).sort()).toEqual(
      ["id", "mpesaReceipt", "resultCode", "resultDesc", "status"].sort(),
    );
    expect((p as unknown as Record<string, unknown>).internal).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("upstream diagnostics");
  });

  it("REFUSES a 2xx collect ack whose KNOWN field carries the bearer key, as indeterminate", async () => {
    // Every field here is well-formed. The only problem is that `checkoutRequestId` contains the
    // API key — which reconstruction alone cannot fix, because the field is on the allowlist.
    const m = mockFetch([
      { status: 202, json: { ...ACK, checkoutRequestId: `ws_CO_${KEY}` } },
    ]);
    const err = await client(m.fetch)
      .collect({ amount: 100, phone: "0712345678", ...IK })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PaylodApiError);
    expect((err as Error).message).toMatch(/INDETERMINATE/);
    expect((err as PaylodError).idempotencyKey).toBe("attempt-1");
    expect((err as Error).message).not.toContain(KEY);
  });

  it("REFUSES a status body whose resultDesc carries the bearer key", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      {
        status: 200,
        json: {
          id: "pay_123",
          status: "success",
          mpesaReceipt: "SFF6XYZ123",
          resultCode: 0,
          resultDesc: `upstream said: Authorization: Bearer ${KEY}`,
        },
      },
    ]);
    const c = client(m.fetch);
    await c.collect({ amount: 100, phone: "0712345678", ...IK });

    const err = await c.status("pay_123").catch((e) => e);
    expect(err).toBeInstanceOf(PaylodApiError);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("the deep scanner finds a secret in a value, in a KEY, and nested in an array", () => {
    expect(containsSecret({ a: `x${KEY}y` }, [KEY])).toBe(true);
    expect(containsSecret({ [KEY]: "v" }, [KEY])).toBe(true);
    expect(containsSecret({ a: [{ b: [KEY] }] }, [KEY])).toBe(true);
    expect(containsSecret({ a: "clean" }, [KEY])).toBe(false);
    // An empty secret list must not make everything match.
    expect(containsSecret({ a: "anything" }, ["", undefined as never])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// H2 — a verified webhook event is REBUILT, and a secret-bearing one is refused
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("H2 a verified webhook event is reconstructed, never spread", () => {
  const nowSec = 1_700_000_000;

  function evt(over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) {
    return {
      type: "payment.failed",
      created: nowSec,
      data: {
        paymentId: "pay_1",
        applicationId: "app_1",
        env: "sandbox",
        status: "failed",
        amount: 100,
        phone: "254712345678",
        accountRef: null,
        mpesaReceipt: null,
        checkoutRequestId: "ws_CO_1",
        resultCode: 1032,
        resultDesc: "Request cancelled by user",
        decoded: null,
        ...dataOver,
      },
      ...over,
    };
  }

  function verify(body: unknown) {
    const raw = JSON.stringify(body);
    return verifyWebhook({
      payload: raw,
      signature: signWebhook(raw, SECRET, nowSec),
      secret: SECRET,
      nowSec,
    });
  }

  it("STRIPS unknown top-level and data fields from a correctly-signed event", () => {
    const event = verify(
      evt({ __extra: "top" }, { debug: { authorization: `Bearer ${SECRET}` }, __raw: "x" }),
    );

    expect(Object.keys(event).sort()).toEqual(["created", "data", "type"]);
    expect((event as unknown as Record<string, unknown>).__extra).toBeUndefined();
    expect((event.data as unknown as Record<string, unknown>).debug).toBeUndefined();
    expect((event.data as unknown as Record<string, unknown>).__raw).toBeUndefined();
    // The signature was VALID. The event is still not delivered with the extra fields on it.
    expect(JSON.stringify(event)).not.toContain(SECRET);
  });

  it("data carries EXACTLY the schema's fields", () => {
    const event = verify(evt());
    expect(Object.keys(event.data).sort()).toEqual(
      [
        "accountRef",
        "amount",
        "applicationId",
        "checkoutRequestId",
        "decoded",
        "env",
        "mpesaReceipt",
        "paymentId",
        "phone",
        "resultCode",
        "resultDesc",
        "status",
      ].sort(),
    );
  });

  it("REFUSES a correctly-signed event whose KNOWN field carries the signing secret", () => {
    // `resultDesc` is on the allowlist, so reconstruction does not remove it. Handlers log the
    // verified event wholesale, so delivering this writes the signing key into their logs.
    expect(() => verify(evt({}, { resultDesc: `cancelled (secret=${SECRET})` }))).toThrow(
      /signing secret/i,
    );
  });

  it("a clean event still verifies — the scan does not reject ordinary traffic", () => {
    const event = verify(evt());
    expect(event.type).toBe("payment.failed");
    expect(event.data.decoded?.retryable).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// H3 — an unbacked `failed` claim is INDETERMINATE (and a backed one is still a failure)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("H3 a failure claim needs evidence, and a real failure code still fails", () => {
  it("failed with NO evidence is indeterminate, not a terminal failure", () => {
    const j = judge(payment({ status: "failed" }));
    expect(j.evidence).toBe("none");
    expect(j.verdict).toBe("indeterminate");
  });

  it("an unbacked failed status read renders as PENDING, so wait() keeps polling", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { status: 200, json: { id: "pay_123", status: "failed" } },
    ]);
    const c = client(m.fetch);
    await c.collect({ amount: 100, phone: "0712345678", ...IK });

    const outcome = await c.check("pay_123");
    expect(outcome.status).toBe("pending");
    expect(outcome.paid).toBe(false);
    // The critical half: an indeterminate payment is NEVER advertised as safe to charge again.
    expect(outcome.retryable).toBe(false);
  });

  it("a payment.failed webhook with NO result evidence is refused", () => {
    const nowSec = 1_700_000_000;
    const body = {
      type: "payment.failed",
      created: nowSec,
      data: {
        paymentId: "pay_1",
        applicationId: "app_1",
        env: "sandbox",
        status: "failed",
        amount: 100,
        phone: "254712345678",
        accountRef: null,
        mpesaReceipt: null,
        checkoutRequestId: "ws_CO_1",
        resultCode: null,
        resultDesc: null,
        decoded: null,
      },
    };
    const raw = JSON.stringify(body);
    expect(() =>
      verifyWebhook({
        payload: raw,
        signature: signWebhook(raw, SECRET, nowSec),
        secret: SECRET,
        nowSec,
      }),
    ).toThrow(/does not support that/i);
  });

  // ── THE CONTROL. The fix must not over-correct. ────────────────────────────────────────
  it("CONTROL: failed + a genuine catalog failure code is STILL a retryable failure", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      {
        status: 200,
        json: {
          id: "pay_123",
          status: "failed",
          mpesaReceipt: null,
          resultCode: 1032,
          resultDesc: "Request cancelled by user",
        },
      },
    ]);
    const c = client(m.fetch);
    await c.collect({ amount: 100, phone: "0712345678", ...IK });

    const outcome = await c.check("pay_123");
    expect(outcome.status).toBe("cancelled");
    expect(outcome.paid).toBe(false);
    // The catalog says 1032 is retryable, and it still is.
    expect(outcome.retryable).toBe(true);
    expect(judge(payment({ status: "failed", resultCode: 1032 })).verdict).toBe("failed");
  });

  it("CONTROL: failed + a NON-retryable catalog code is a failure the catalog calls final", () => {
    expect(judge(payment({ status: "failed", resultCode: 17 })).verdict).toBe("failed");
  });

  it("CONTROL: success + code 0 + a receipt is still PAID", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      {
        status: 200,
        json: {
          id: "pay_123",
          status: "success",
          mpesaReceipt: "SFF6XYZ123",
          resultCode: 0,
          resultDesc: "Success",
        },
      },
    ]);
    const c = client(m.fetch);
    await c.collect({ amount: 100, phone: "0712345678", ...IK });

    const outcome = await c.check("pay_123");
    expect(outcome.paid).toBe(true);
    expect(outcome.receipt).toBe("SFF6XYZ123");
    expect(judge(payment({ status: "success", resultCode: 0 })).verdict).toBe("paid");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// H4 — a promise-returning onPoll is AWAITED, inside the reconciliation envelope
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("H4 onPoll promises are awaited under the deadline", () => {
  it("AWAITS an async onPoll before the next poll — no floating promise", async () => {
    const order: string[] = [];
    const m = mockFetch([
      { status: 200, json: { id: "pay_123", status: "pending" } },
      { status: 200, json: { id: "pay_123", status: "pending" } },
      {
        status: 200,
        json: { id: "pay_123", status: "success", mpesaReceipt: "SFF6", resultCode: 0 },
      },
    ]);

    await client(m.fetch).wait("pay_123", {
      timeoutMs: 30_000,
      onPoll: async () => {
        order.push("start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("end");
      },
    });

    // Every `start` is followed by its own `end` before the next `start`. A floating promise
    // would interleave them.
    expect(order.length).toBeGreaterThan(0);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe("start");
      expect(order[i + 1]).toBe("end");
    }
  });

  it("an async onPoll REJECTION fails the call instead of becoming an unhandled rejection", async () => {
    const m = mockFetch([{ status: 200, json: { id: "pay_123", status: "pending" } }]);

    const err = await client(m.fetch)
      .wait("pay_123", {
        timeoutMs: 30_000,
        onPoll: async () => {
          throw new Error("the spinner write failed");
        },
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("the spinner write failed");
  });

  it("collectAndWait attaches the KEY and the PAYMENT ID to an onPoll rejection", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { status: 200, json: { id: "pay_123", status: "pending" } },
    ]);

    const err = await client(m.fetch)
      .collectAndWait(
        { amount: 100, phone: "0712345678", ...IK },
        {
          timeoutMs: 30_000,
          onPoll: async () => {
            throw new Error("boom");
          },
        },
      )
      .catch((e) => e);

    // THE point of the fix: the caller ends up holding both handles to a possibly-live charge,
    // instead of the process being terminated by an unhandled rejection.
    expect(err).toBeInstanceOf(PaylodError);
    expect((err as PaylodError).idempotencyKey).toBe("attempt-1");
    expect((err as PaylodError).paymentId).toBe("pay_123");
  });

  it("a synchronous onPoll still works and costs nothing", async () => {
    const seen: string[] = [];
    const m = mockFetch([
      { status: 200, json: { id: "pay_123", status: "pending" } },
      {
        status: 200,
        json: { id: "pay_123", status: "success", mpesaReceipt: "SFF6", resultCode: 0 },
      },
    ]);
    await client(m.fetch).wait("pay_123", {
      timeoutMs: 30_000,
      onPoll: (p) => void seen.push(p.status),
    });
    expect(seen).toContain("pending");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// H5 — rendering a hostile throwable cannot itself throw
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("H5 the reconciliation wrapper survives a throwable that cannot be stringified", () => {
  const hostile: Array<[string, unknown]> = [
    [
      "a throwing toString",
      {
        toString() {
          throw new Error("nope");
        },
      },
    ],
    [
      "a throwing message getter",
      Object.defineProperty({}, "message", {
        get() {
          throw new Error("nope");
        },
      }),
    ],
    ["a null-prototype object", Object.assign(Object.create(null), { x: 1 })],
    ["a symbol", Symbol("s")],
    [
      "a throwing Symbol.toPrimitive",
      {
        [Symbol.toPrimitive]() {
          throw new Error("nope");
        },
      },
    ],
  ];

  it.each(hostile)("renders %s without throwing", (_label, value) => {
    expect(() => renderThrowable(value)).not.toThrow();
    expect(typeof renderThrowable(value)).toBe("string");
  });

  it.each(hostile)("wraps %s into an error that still carries BOTH handles", (_label, value) => {
    const wrapped = withIdempotencyKey(value, "attempt-1", (s) => s, "pay_123");
    expect(wrapped).toBeInstanceOf(PaylodError);
    expect((wrapped as PaylodError).idempotencyKey).toBe("attempt-1");
    expect((wrapped as PaylodError).paymentId).toBe("pay_123");
  });

  it("an ordinary error still renders its real message", () => {
    expect(renderThrowable(new Error("a real message"))).toBe("a real message");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// M6 — webhook bytes are never decoded and re-encoded before the HMAC
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("M6 the Web Request adapter preserves bytes end to end", () => {
  it("verifies a body containing INVALID UTF-8 — which a decode round trip would destroy", async () => {
    // `0x80` is a lone continuation byte: invalid UTF-8. Decoding it yields U+FFFD, and
    // re-encoding U+FFFD yields EF BF BD — different bytes, so the HMAC would not match.
    const raw = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0x80]), Buffer.from('"}')]);
    const nowSec = Math.floor(Date.now() / 1000);
    const signature = signWebhook(raw, SECRET, nowSec);

    // Verified directly against the exact bytes: this is the signature that must match.
    expect(() =>
      verifyWebhook({ payload: raw, signature, secret: SECRET, nowSec }),
    ).toThrow(/not a valid paylod event/);
    // It got PAST the signature check (it fails on the schema, not on `no_match`), which is the
    // whole point: the bytes authenticated.
  });

  it("two DIFFERENT invalid-UTF-8 bodies do not share a signature", () => {
    const a = Buffer.concat([Buffer.from("{"), Buffer.from([0x80]), Buffer.from("}")]);
    const b = Buffer.concat([Buffer.from("{"), Buffer.from([0x81]), Buffer.from("}")]);
    const nowSec = 1_700_000_000;

    // A decode-then-re-encode pipeline collapses BOTH onto the replacement character, so one
    // signature would verify both. On raw bytes they are distinct.
    expect(signWebhook(a, SECRET, nowSec)).not.toBe(signWebhook(b, SECRET, nowSec));

    const sigA = signWebhook(a, SECRET, nowSec);
    const err = (() => {
      try {
        verifyWebhook({ payload: b, signature: sigA, secret: SECRET, nowSec });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/does not match/i);
  });

  it("the webhookHandler reads a Request as bytes and verifies it", async () => {
    const body = JSON.stringify({
      type: "payment.success",
      created: Math.floor(Date.now() / 1000),
      data: {
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
        resultDesc: "Success",
        decoded: null,
      },
    });
    const seen: string[] = [];
    const handler = client(vi.fn() as never).webhookHandler(async (e) => {
      seen.push(e.data.paymentId);
    });

    const res = await handler(
      new Request("https://x.test/webhook", {
        method: "POST",
        body,
        headers: { "x-webhook-signature": signWebhook(body, SECRET) },
      }),
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(["pay_1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// M7 — the manual verification path is size-capped
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("M7 verifyWebhook / verifyWebhookSignature cap the body before the HMAC", () => {
  it("REFUSES an oversized payload on the manual path", () => {
    const huge = "a".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    expect(() =>
      verifyWebhook({ payload: huge, signature: "t=1,v1=" + "0".repeat(64), secret: SECRET }),
    ).toThrow(/exceeds/i);
  });

  it("measures BYTES, not UTF-16 length — a multi-byte body cannot slip past", () => {
    // Each `é` is 2 bytes but 1 UTF-16 unit. A length-based check would see half the real size.
    const s = "é".repeat(MAX_WEBHOOK_BODY_BYTES / 2 + 1);
    expect(s.length).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
    expect(Buffer.byteLength(s, "utf8")).toBeGreaterThan(MAX_WEBHOOK_BODY_BYTES);
    expect(() =>
      verifyWebhook({ payload: s, signature: "t=1,v1=" + "0".repeat(64), secret: SECRET }),
    ).toThrow(/exceeds/i);
  });

  it("the cap is checked BEFORE the signature — an oversized body is never HMAC'd", () => {
    const huge = "a".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    // No signature at all. If the cap ran after the signature checks, this would complain about
    // the missing header instead of the size.
    expect(() =>
      verifyWebhook({ payload: huge, signature: null, secret: SECRET }),
    ).toThrow(/exceeds/i);
  });

  it("an ordinary body is unaffected", () => {
    const nowSec = 1_700_000_000;
    const raw = JSON.stringify({ hello: "world" });
    expect(() =>
      verifyWebhook({
        payload: raw,
        signature: signWebhook(raw, SECRET, nowSec),
        secret: SECRET,
        nowSec,
      }),
    ).toThrow(/not a valid paylod event/); // past the signature, failing on schema
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// M8 / L11 — the simulator gets the same envelope and the same validators as production
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("M8 simulator failures carry the reconciliation handles", () => {
  it("simulate.collect() failures carry the effective idempotency key", async () => {
    const m = mockFetch([{ status: 500, json: { error: "nope" } }]);
    const err = await client(m.fetch, { simulate: true })
      .simulate.collect({ amount: 100, ...IK })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PaylodError);
    expect((err as PaylodError).idempotencyKey).toBe("attempt-1");
  });

  it("simulate.outcome() failures carry the derived key AND the payment id", async () => {
    const m = mockFetch([{ status: 500, json: { error: "nope" } }]);
    const err = await client(m.fetch, { simulate: true })
      .simulate.outcome("pay_123", "approve")
      .catch((e) => e);

    expect(err).toBeInstanceOf(PaylodError);
    expect((err as PaylodError).idempotencyKey).toBe("sim-outcome-pay_123-approve");
    expect((err as PaylodError).paymentId).toBe("pay_123");
  });

  it("simulate.pay() attaches the NEWLY ACKNOWLEDGED payment id to a post-ack failure", async () => {
    const m = mockFetch([
      { status: 202, json: { ...ACK, outcomes: [] } },
      { status: 500, json: { error: "settle failed" } },
    ]);
    const err = await client(m.fetch, { simulate: true })
      .simulate.pay({ amount: 100, outcome: "approve", ...IK })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PaylodError);
    expect((err as PaylodError).paymentId).toBe("pay_123");
    expect((err as PaylodError).idempotencyKey).toBeDefined();
  });

  it("the derived outcome key runs the SHARED idempotency-key validator", async () => {
    const m = mockFetch([{ status: 200, json: {} }]);
    // A payment id with a space in it produces a key production would reject outright.
    await expect(
      client(m.fetch, { simulate: true }).simulate.outcome("pay 123", "approve"),
    ).rejects.toThrow(PaylodInvalidRequestError);
    // Refused BEFORE any request went out.
    expect(m.count).toBe(0);
  });
});

describe("L11 the simulator runs production's request validators", () => {
  it("REFUSES an amount above the 150,000 KES ceiling, exactly as collect() does", async () => {
    const m = mockFetch([{ status: 202, json: ACK }]);
    await expect(
      client(m.fetch, { simulate: true }).simulate.collect({ amount: 150_001, ...IK }),
    ).rejects.toThrow(/between 1 and 150000/);
    expect(m.count).toBe(0);
  });

  it("REFUSES an over-long accountReference and description", async () => {
    const m = mockFetch([{ status: 202, json: ACK }]);
    const sim = client(m.fetch, { simulate: true }).simulate;

    await expect(
      sim.collect({ amount: 1, accountReference: "x".repeat(13), ...IK }),
    ).rejects.toThrow(/accountReference/);
    await expect(sim.collect({ amount: 1, description: "x".repeat(65), ...IK })).rejects.toThrow(
      /description/,
    );
    expect(m.count).toBe(0);
  });

  it("production collect() enforces the same three rules", async () => {
    const m = mockFetch([{ status: 202, json: ACK }]);
    const c = client(m.fetch);
    await expect(
      c.collect({ amount: 150_001, phone: "0712345678", ...IK }),
    ).rejects.toThrow(/between 1 and 150000/);
    await expect(
      c.collect({ amount: 1, phone: "0712345678", accountReference: "x".repeat(13), ...IK }),
    ).rejects.toThrow(/accountReference/);
    await expect(
      c.collect({ amount: 1, phone: "0712345678", description: "x".repeat(65), ...IK }),
    ).rejects.toThrow(/description/);
    expect(m.count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// L12 — the wire union is represented honestly, and optional fields are normalized
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("L12 resultCode is the real wire union and absent fields become null", () => {
  it("a STRING result code survives the read and classifies correctly", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      {
        status: 200,
        json: { id: "pay_123", status: "failed", resultCode: "1032", resultDesc: "cancelled" },
      },
    ]);
    const c = client(m.fetch);
    await c.collect({ amount: 100, phone: "0712345678", ...IK });

    const p = await c.status("pay_123");
    expect(p.resultCode).toBe("1032");
    expect(typeof p.resultCode).toBe("string");
  });

  it("ABSENT optional fields arrive as null, never undefined", async () => {
    const m = mockFetch([
      { status: 202, json: ACK },
      { status: 200, json: { id: "pay_123", status: "pending" } },
    ]);
    const c = client(m.fetch);
    await c.collect({ amount: 100, phone: "0712345678", ...IK });

    const p = await c.status("pay_123");
    // The type has always said `| null`. Before reconstruction it returned `undefined`, so a
    // `=== null` check — which is what `hasResultCode` is written against — read false.
    expect(p.mpesaReceipt).toBeNull();
    expect(p.resultCode).toBeNull();
    expect(p.resultDesc).toBeNull();
    expect("mpesaReceipt" in p).toBe(true);
    expect("resultCode" in p).toBe(true);
  });

  it("a webhook's absent optional fields are normalized the same way", () => {
    const nowSec = 1_700_000_000;
    const body = {
      type: "payment.success",
      created: nowSec,
      data: {
        paymentId: "pay_1",
        applicationId: "app_1",
        env: "sandbox",
        status: "success",
        amount: 100,
        phone: "254712345678",
        mpesaReceipt: "SFF6XYZ123",
        resultCode: 0,
      },
    };
    const raw = JSON.stringify(body);
    const event = verifyWebhook({
      payload: raw,
      signature: signWebhook(raw, SECRET, nowSec),
      secret: SECRET,
      nowSec,
    });
    expect(event.data.accountRef).toBeNull();
    expect(event.data.checkoutRequestId).toBeNull();
    expect(event.data.resultDesc).toBeNull();
    expect(event.data.decoded).toBeNull();
  });
});
