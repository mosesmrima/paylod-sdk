/**
 * ROUND 5 — the money-correctness defects the sibling SDK reviews found, checked against THIS code.
 *
 * The fifth independent review of this repo was cut off by a content filter before it emitted its
 * findings, so unlike the siblings there was no itemised list. Every defect the PHP / Python / JVM
 * reviews DID surface is therefore re-derived here rather than assumed absent — Node was assumed
 * clean in an earlier round and failed 8 of 8 equivalent checks.
 */

import { describe, expect, it, vi } from "vitest";
import { Paylod } from "../src/client.js";
import { MAX_JSON_DEPTH, parseBounded } from "../src/client.js";
import { classifyStkResult } from "../src/daraja-catalog.js";
import {
  PaylodError,
  PaylodResponseTooLargeError,
  PaylodSecurityError,
  PaylodTerminalTransportError,
} from "../src/errors.js";
import { toOutcome } from "../src/outcome.js";
import { evidenceFor, judge, type PaymentEvidence, type PaymentVerdict } from "../src/semantics.js";
import { MAX_RESPONSE_BYTES } from "../src/transport.js";
import { MAX_TOLERANCE_SEC, signWebhook, verifyWebhook } from "../src/webhook.js";
import type { Payment, PaymentStatus } from "../src/types.js";
import { ACK, mockFetch, payment } from "./helpers.js";

const KEY = "mp_test_round5";
const SECRET = "whsec_round5";

function client(fetch: typeof globalThis.fetch, over: Record<string, unknown> = {}) {
  return new Paylod(KEY, {
    fetch,
    allowCustomFetch: true,
    webhookSecret: SECRET,
    ...over,
  } as never);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. THE CLAIM x EVIDENCE MATRIX IS TOTAL
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("D1 — the claim x evidence table is TOTAL, with no default anywhere on the path", () => {
  const CLAIMS: readonly PaymentStatus[] = ["success", "pending", "failed"];
  const EVIDENCE: readonly PaymentEvidence[] = [
    "success",
    "none",
    "failure",
    "in_flight",
    "conflict",
    // spec 1.5: a canonically-shaped code the catalog has never heard of.
    "unknown",
  ];

  /**
   * A record that produces EXACTLY the named evidence. These are the real field combinations, not
   * a stub of `evidenceFor` — a matrix asserted against a mocked evidence function would prove
   * nothing about the records that actually arrive.
   */
  function recordFor(claim: PaymentStatus, evidence: PaymentEvidence): Payment {
    switch (evidence) {
      case "success":
        return payment({ status: claim, resultCode: 0 });
      case "none":
        return payment({ status: claim });
      case "failure":
        return payment({ status: claim, resultCode: 1032 });
      case "in_flight":
        return payment({ status: claim, resultCode: 4999 });
      case "conflict":
        // A receipt (money moved) beside a cancellation code (it did not). The two witnesses
        // contradict each other, so the claim never gets a vote.
        return payment({ status: claim, mpesaReceipt: "SFF6XYZ123", resultCode: 1032 });
      case "unknown":
        // Well-formed, non-zero, and absent from the catalog. The classifier calls this shape
        // `failed`; the catalog has never described it, so it proves nothing.
        return payment({ status: claim, resultCode: 77777 });
    }
  }

  /** THE MATRIX. Every cell written out; a missing cell fails rather than defaulting. */
  const EXPECTED: Record<PaymentStatus, Record<PaymentEvidence, PaymentVerdict>> = {
    success: {
      success: "paid",
      none: "indeterminate",
      failure: "indeterminate",
      in_flight: "indeterminate",
      conflict: "indeterminate",
      unknown: "indeterminate",
    },
    pending: {
      success: "indeterminate",
      none: "in_flight",
      failure: "indeterminate",
      in_flight: "in_flight",
      conflict: "indeterminate",
      unknown: "indeterminate",
    },
    failed: {
      success: "indeterminate",
      // ROUND 7: was "failed". A claim with no evidence behind it is indeterminate whichever
      // direction it points — see the `failed x none` cell in `semantics.ts`.
      none: "indeterminate",
      failure: "failed",
      in_flight: "in_flight",
      conflict: "indeterminate",
      // spec 3.5 row 7. `failed` + an uncatalogued code is INDETERMINATE, not a terminal
      // failure: nobody has established what the code means, so it is not evidence.
      unknown: "indeterminate",
    },
  };

  it("covers the FULL cross-product — 3 claims x 6 evidence kinds, 18 cells, none missing", () => {
    const seen: string[] = [];
    for (const claim of CLAIMS) {
      for (const evidence of EVIDENCE) {
        const record = recordFor(claim, evidence);
        // The record really does carry the evidence the matrix indexes on.
        expect(evidenceFor(record), `${claim} x ${evidence}: wrong evidence`).toBe(evidence);

        const expected = EXPECTED[claim][evidence];
        expect(expected, `matrix has no cell for ${claim} x ${evidence}`).toBeDefined();
        expect(judge(record).verdict, `${claim} x ${evidence}`).toBe(expected);
        seen.push(`${claim}x${evidence}`);
      }
    }
    // A cell silently dropped from the loop is a cell nothing asserted.
    expect(seen).toHaveLength(18);
  });

  it("NEVER reports a pending record as paid, whatever evidence rides along", () => {
    for (const evidence of EVIDENCE) {
      expect(judge(recordFor("pending", evidence)).verdict).not.toBe("paid");
    }
  });

  it("the named Python hole: pending + resultCode 0 is INDETERMINATE, never paid", () => {
    const j = judge(payment({ status: "pending", resultCode: 0 }));
    expect(j.verdict).toBe("indeterminate");
    expect(j.verdict).not.toBe("paid");
  });

  it("the named Python hole: pending + 1032 is never reported RETRYABLE", () => {
    const record = payment({ status: "pending", resultCode: 1032 });
    expect(judge(record).verdict).toBe("indeterminate");

    // The rendered outcome is what a merchant actually branches on, and `retryable` there means
    // SAFE TO CHARGE AGAIN. Python reported this pair as retryable — a double-charge generator.
    const outcome = toOutcome(record);
    expect(outcome.retryable).toBe(false);
    expect(outcome.paid).toBe(false);
    expect(outcome.status).toBe("pending");
  });

  it("an unrecognised claim resolves as indeterminate, NOT from the evidence alone", () => {
    // The evidence here is a clean success. A permissive default would return `paid`.
    const j = judge({ ...payment({ resultCode: 0 }), status: "settled" as PaymentStatus });
    expect(j.verdict).toBe("indeterminate");
    expect(j.reason).toMatch(/not a payment status this SDK recognises/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. NUMERIC COERCION OF SUCCESS EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("D2 — result-code zero is recognised by EXACT FORM, never by Number() coercion", () => {
  // Every one of these is `0` to JavaScript. None is a result code Daraja emits.
  const COERCIBLE_ZEROS = ["0e999", "+0", "00", "0.0", "-0", "0x0", "0e0", " 0.00 ", "0b0"];

  for (const raw of COERCIBLE_ZEROS) {
    it(`does NOT classify ${JSON.stringify(raw)} as success (Number() says ${Number(raw)})`, () => {
      // The premise: JS really would coerce this to zero.
      expect(Number(raw.trim()) === 0 || Number.isNaN(Number(raw.trim()))).toBe(true);
      expect(classifyStkResult(raw)).not.toBe("success");
    });

    it(`does NOT report ${JSON.stringify(raw)} as PAID through the semantic model`, () => {
      const j = judge(payment({ status: "success", resultCode: raw as unknown as number }));
      expect(j.verdict).not.toBe("paid");
    });
  }

  it("still accepts the two representations the schema DOES permit", () => {
    expect(classifyStkResult(0)).toBe("success");
    expect(classifyStkResult("0")).toBe("success");
    expect(judge(payment({ status: "success", resultCode: 0 })).verdict).toBe("paid");
    expect(
      judge(payment({ status: "success", resultCode: "0" as unknown as number })).verdict,
    ).toBe("paid");
  });

  it("a non-canonical code is ambiguous (pending), never force-failed", () => {
    expect(classifyStkResult("1.5")).toBe("pending");
    expect(classifyStkResult("+1032")).toBe("pending");
  });

  it("canonical non-zero codes still classify as terminal failures", () => {
    expect(classifyStkResult(1032)).toBe("failed");
    expect(classifyStkResult("2001")).toBe("failed");
    expect(classifyStkResult(1)).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. A DETECTED CREDENTIAL COMPROMISE IS NEVER RETRIED
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("D3 — a detected credential compromise is TERMINAL and is never re-dispatched", () => {
  it("does NOT retry after the fetch impl FOLLOWED a redirect (token may already be leaked)", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      const res = new Response(JSON.stringify(ACK), { status: 202 });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    }) as unknown as typeof globalThis.fetch;

    const paylod = client(fetch, { maxRetries: 5 });
    await expect(
      paylod.collect({ amount: 10, phone: "0712345678", idempotencyKey: "k1" }),
    ).rejects.toThrow(/FOLLOWED a redirect/i);

    // THE ASSERTION. One dispatch. A retry loop that caught this would have made six.
    expect(calls).toBe(1);
  });

  it("does NOT retry a response whose final URL is off the pinned origin", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      const res = new Response(JSON.stringify(ACK), { status: 202 });
      Object.defineProperty(res, "url", { value: "https://evil.example/collect" });
      return res;
    }) as unknown as typeof globalThis.fetch;

    const paylod = client(fetch, { maxRetries: 5 });
    await expect(
      paylod.collect({ amount: 10, phone: "0712345678", idempotencyKey: "k2" }),
    ).rejects.toThrow(/pinned paylod origin/i);
    expect(calls).toBe(1);
  });

  it("raises these as PaylodSecurityError — terminal by TYPE, not by message prose", async () => {
    const fetch = vi.fn(async () => {
      const res = new Response(JSON.stringify(ACK), { status: 202 });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    }) as unknown as typeof globalThis.fetch;

    const err = await client(fetch)
      .collect({ amount: 10, phone: "0712345678", idempotencyKey: "k3" })
      .catch((e: unknown) => e);

    // It is normalised into an SDK error carrying the key; the terminal marker is what the retry
    // loop reads, and it is a fact about the type rather than a phrase in the message.
    expect(err).toBeInstanceOf(PaylodError);
    expect(new PaylodSecurityError("x")).toBeInstanceOf(PaylodTerminalTransportError);
    expect(new PaylodSecurityError("x").terminal).toBe(true);
  });

  it("an ordinary network blip IS still retried — the terminal rule is narrow", async () => {
    const mock = mockFetch([
      { throw: new Error("ECONNRESET") },
      { status: 202, json: ACK },
    ]);
    const ack = await client(mock.fetch).collect({
      amount: 10,
      phone: "0712345678",
      idempotencyKey: "k4",
    });
    expect(ack.paymentId).toBe("pay_123");
    expect(mock.count).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. THE WEBHOOK `decoded` BLOCK DOES NOT GET A VOTE
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("D4 — decoded.retryable is recomputed from the catalog, never trusted from the payload", () => {
  function signed(body: unknown, nowSec = 1_700_000_000) {
    const raw = JSON.stringify(body);
    return { raw, signature: signWebhook(raw, SECRET, nowSec), nowSec };
  }

  const failedEvent = (decoded: unknown, resultCode: number) => ({
    type: "payment.failed",
    created: 1_700_000_000,
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
      resultCode,
      resultDesc: "Request cancelled by user",
      decoded,
    },
  });

  it("OVERRIDES a hostile retryable:true on a code that is NOT safe to charge again", () => {
    // 1032 = cancelled by the user. The catalog's own answer for this code is what must win.
    const hostile = {
      code: "1032",
      title: "pwned",
      cause: "pwned",
      fix: "pwned",
      category: "customer",
      retryable: true,
      customerMessage: "Please pay again right now.",
    };
    const { raw, signature, nowSec } = signed(failedEvent(hostile, 1032));

    const event = verifyWebhook({ payload: raw, signature, secret: SECRET, nowSec });

    // The signature was VALID — this is not a rejection, it is a correction.
    expect(event.data.decoded).not.toBeNull();
    expect(event.data.decoded?.customerMessage).not.toBe("Please pay again right now.");
    expect(event.data.decoded?.title).not.toBe("pwned");
    // And it agrees with the offline catalog, which is the only authority.
    const canonical = new Paylod(KEY, { fetch: vi.fn(), allowCustomFetch: true } as never)
      .decodeError(1032, "Request cancelled by user");
    expect(event.data.decoded).toEqual(canonical);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  // ROUND 7: THE DISCRIMINATING RETRYABLE FIXTURE.
  //
  // The test above cannot fail for the right reason and never could. It sends code 1032 with a
  // hostile `retryable: true` — and the CATALOG's own answer for 1032 is ALSO `true` (a payment
  // the customer cancelled is safe to re-attempt). So the value under test is identical whether
  // the SDK recomputes the block or trusts the payload wholesale, and a regression that deleted
  // the recomputation entirely would still have gone green on `retryable`. It discriminates on
  // `title` and `customerMessage`, which is why it looked like it was working.
  //
  // A test for "the payload does not get a vote" has to put the payload and the catalog in
  // DISAGREEMENT on the one boolean that matters, in BOTH directions:
  //   • hostile `true` on codes the catalog calls NOT retryable  (17, 26, 1025, 9999)
  //   • hostile `false` on a code the catalog calls retryable    (1032)
  // and it must assert the canonical boolean EXPLICITLY, not via a `toEqual` against a block
  // derived from the same call the SDK makes.
  //
  // ONLY `retryable` is mutated. Every other field is the catalog's own, so the assertion
  // cannot pass because some unrelated field differed — the boolean is the only variable.
  describe.each([
    [17, false],
    [26, false],
    [1025, false],
    [9999, false],
    [1032, true],
  ])("code %i — the catalog says retryable=%s and the payload cannot change it", (code, canonicalRetryable) => {
    it("ignores a payload that asserts the OPPOSITE", () => {
      const client = new Paylod(KEY, { fetch: vi.fn(), allowCustomFetch: true } as never);
      const canonical = client.decodeError(code, "");

      // Sanity: the fixture is only meaningful if the catalog really says what we think, and if
      // the hostile value really is the opposite. A fixture that silently agreed with the
      // catalog is precisely the defect being fixed, so it is asserted rather than assumed.
      expect(canonical.retryable).toBe(canonicalRetryable);

      const hostile = { ...canonical, retryable: !canonicalRetryable };
      expect(hostile.retryable).toBe(!canonicalRetryable);

      const { raw, signature, nowSec } = signed(failedEvent(hostile, code));
      const event = verifyWebhook({ payload: raw, signature, secret: SECRET, nowSec });

      // THE assertion: the canonical boolean, stated as a literal. `retryable` is the one field
      // in this SDK that means SAFE TO CHARGE AGAIN, so it is asserted directly and not through
      // an object comparison that could pass for a dozen unrelated reasons.
      expect(event.data.decoded?.retryable).toBe(canonicalRetryable);
      expect(event.data.decoded?.retryable).not.toBe(hostile.retryable);
    });
  });

  it("a payload advertising retryable:true for an IN-FLIGHT code cannot invite a double charge", () => {
    // 4999 = the customer is mid-PIN and the prompt is LIVE. `retryable: true` here is an
    // instruction to charge a second time while the first is still on the handset.
    const hostile = {
      code: "4999",
      title: "x",
      cause: "x",
      fix: "x",
      category: "customer",
      retryable: true,
      customerMessage: "x",
    };
    // A `payment.failed` carrying 4999 is refused outright by the evidence rule, so the vote is
    // moot on that path — assert the decode itself never advertises 4999 as retryable.
    const { raw, signature, nowSec } = signed(failedEvent(hostile, 4999));
    expect(() => verifyWebhook({ payload: raw, signature, secret: SECRET, nowSec })).toThrow(
      /still-in-flight|does not support that/i,
    );
  });

  it("null in, null out — recomputing does not invent a block the schema says is absent", () => {
    const successEvent = {
      type: "payment.success",
      created: 1_700_000_000,
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
    };
    const { raw, signature, nowSec } = signed(successEvent);
    const event = verifyWebhook({ payload: raw, signature, secret: SECRET, nowSec });
    expect(event.data.decoded).toBeNull();
  });

  it("every other validated field is passed through untouched", () => {
    const { raw, signature, nowSec } = signed(
      failedEvent(
        {
          code: "1032",
          title: "t",
          cause: "c",
          fix: "f",
          category: "customer",
          retryable: false,
          customerMessage: "m",
        },
        1032,
      ),
    );
    const event = verifyWebhook({ payload: raw, signature, secret: SECRET, nowSec });
    expect(event.data.paymentId).toBe("pay_1");
    expect(event.data.amount).toBe(100);
    expect(event.data.checkoutRequestId).toBe("ws_CO_1");
    expect(event.type).toBe("payment.failed");
    expect(event.created).toBe(1_700_000_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. THE CHARGE HANDLE SURVIVES EXOTIC THROWS
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("D6 — every throw after an acknowledgement carries the key AND the payment id", () => {
  /** collect() succeeds, then the status poll throws whatever `boom` is. */
  async function afterAck(boom: unknown) {
    let n = 0;
    const fetch = vi.fn(async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify(ACK), { status: 202 });
      throw boom;
    }) as unknown as typeof globalThis.fetch;

    return client(fetch, { maxRetries: 0 })
      .collectAndWait(
        { amount: 10, phone: "0712345678", idempotencyKey: "attempt-1" },
        { timeoutMs: 1_000 },
      )
      .catch((e: unknown) => e);
  }

  it("carries BOTH when user code throws a PRIMITIVE", async () => {
    const err = (await afterAck("boom")) as PaylodError;
    expect(err).toBeInstanceOf(PaylodError);
    expect(err.idempotencyKey).toBe("attempt-1");
    expect(err.paymentId).toBe("pay_123");
  });

  it("carries BOTH when user code throws undefined", async () => {
    const err = (await afterAck(undefined)) as PaylodError;
    expect(err.idempotencyKey).toBe("attempt-1");
    expect(err.paymentId).toBe("pay_123");
  });

  it("carries BOTH when user code throws a non-Error object", async () => {
    const err = (await afterAck({ weird: true })) as PaylodError;
    expect(err.idempotencyKey).toBe("attempt-1");
    expect(err.paymentId).toBe("pay_123");
  });

  it("carries BOTH when the thrown Error is FROZEN", async () => {
    const err = (await afterAck(Object.freeze(new Error("frozen")))) as PaylodError;
    expect(err.idempotencyKey).toBe("attempt-1");
    expect(err.paymentId).toBe("pay_123");
  });

  /**
   * Throw from `onPoll`, NOT from `fetch`.
   *
   * A throw out of `fetch` is caught by `#request` and re-wrapped as a fresh connection error, so
   * the exotic value never reaches the normaliser at all — a test that threw there passed with the
   * normaliser fully reverted, i.e. it was vacuous. `onPoll` runs inside `wait()` and its exception
   * propagates verbatim into `collectAndWait`'s catch, which is the code path under test.
   */
  async function afterAckFromPoll(boom: unknown) {
    let n = 0;
    const fetch = vi.fn(async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify(ACK), { status: 202 });
      return new Response(JSON.stringify(payment({ status: "pending" })), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    return client(fetch)
      .collectAndWait(
        { amount: 10, phone: "0712345678", idempotencyKey: "attempt-1" },
        {
          timeoutMs: 5_000,
          onPoll: () => {
            throw boom;
          },
        },
      )
      .catch((e: unknown) => e);
  }

  it("carries BOTH when a FROZEN PaylodError escapes after the ack", async () => {
    const frozen = Object.freeze(new PaylodError("frozen sdk error"));
    // The premise: the object really is un-writable, so in-place assignment cannot work.
    expect(Object.isFrozen(frozen)).toBe(true);

    const err = (await afterAckFromPoll(frozen)) as PaylodError;
    expect(err.idempotencyKey).toBe("attempt-1");
    expect(err.paymentId).toBe("pay_123");
  });

  it("carries BOTH when a frozen foreign Error escapes after the ack", async () => {
    const err = (await afterAckFromPoll(
      Object.freeze(new Error("frozen foreign")),
    )) as PaylodError;
    expect(err).toBeInstanceOf(PaylodError);
    expect(err.idempotencyKey).toBe("attempt-1");
    expect(err.paymentId).toBe("pay_123");
  });

  it("carries BOTH when a PRIMITIVE escapes after the ack", async () => {
    const err = (await afterAckFromPoll("boom")) as PaylodError;
    expect(err).toBeInstanceOf(PaylodError);
    expect(err.idempotencyKey).toBe("attempt-1");
    expect(err.paymentId).toBe("pay_123");
  });

  it("carries BOTH on a wait() TIMEOUT, the most likely real case", async () => {
    let n = 0;
    const fetch = vi.fn(async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify(ACK), { status: 202 });
      return new Response(JSON.stringify(payment({ status: "pending" })), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const err = (await client(fetch)
      .collectAndWait(
        { amount: 10, phone: "0712345678", idempotencyKey: "attempt-2" },
        { timeoutMs: 50 },
      )
      .catch((e: unknown) => e)) as PaylodError;

    expect(err.idempotencyKey).toBe("attempt-2");
    expect(err.paymentId).toBe("pay_123");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 7. BOUNDED RESPONSE BYTES AND JSON DEPTH
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("D7 — an unbounded response cannot OOM the process and lose the key", () => {
  /**
   * A VALID ack plus padding.
   *
   * An over-sized body that is also a malformed ack proves nothing: the ack validator rejects it
   * either way, so the test passed with the cap fully reverted. Padding a body that would
   * otherwise SUCCEED makes the cap the only thing that can produce a failure.
   */
  const overSizedButValidAck = () =>
    JSON.stringify({ ...ACK, pad: "x".repeat(MAX_RESPONSE_BYTES + 1_024) });

  it("refuses a body over the byte cap and reports it as INDETERMINATE, carrying the key", async () => {
    const fetch = vi.fn(
      async () => new Response(overSizedButValidAck(), { status: 202 }),
    ) as unknown as typeof globalThis.fetch;

    const err = (await client(fetch, { maxRetries: 0 })
      .collect({ amount: 10, phone: "0712345678", idempotencyKey: "big-1" })
      .catch((e: unknown) => e)) as PaylodError;

    // Without the cap this body is a perfectly good ack and `collect()` RESOLVES.
    expect(err).toBeInstanceOf(PaylodError);
    expect(err.message).toMatch(/exceeded .* bytes/i);
    expect(err.message).toMatch(/INDETERMINATE/i);
    // THE POINT. The key survives, so the caller can read the payment instead of re-charging.
    expect(err.idempotencyKey).toBe("big-1");
  });

  it("does NOT retry an over-sized response — the request already reached paylod", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      return new Response(overSizedButValidAck(), { status: 202 });
    }) as unknown as typeof globalThis.fetch;

    await client(fetch, { maxRetries: 5 })
      .collect({ amount: 10, phone: "0712345678", idempotencyKey: "big-2" })
      .catch(() => {});
    expect(calls).toBe(1);
  });

  it("a normal-sized body is unaffected", async () => {
    const mock = mockFetch([{ status: 202, json: ACK }]);
    const ack = await client(mock.fetch).collect({
      amount: 10,
      phone: "0712345678",
      idempotencyKey: "small-1",
    });
    expect(ack.paymentId).toBe("pay_123");
  });

  it("refuses a JSON document nested past the depth cap", () => {
    const deep = "[".repeat(MAX_JSON_DEPTH + 5) + "]".repeat(MAX_JSON_DEPTH + 5);
    expect(() => parseBounded(deep)).toThrow(PaylodResponseTooLargeError);
    expect(() => parseBounded(deep)).toThrow(/INDETERMINATE/i);
  });

  it("a deeply nested body is tiny — the byte cap alone would never catch it", () => {
    const deep = "[".repeat(MAX_JSON_DEPTH + 5) + "]".repeat(MAX_JSON_DEPTH + 5);
    expect(deep.length).toBeLessThan(MAX_RESPONSE_BYTES);
  });

  it("does not mistake braces INSIDE strings for nesting", () => {
    const body = JSON.stringify({ note: "{".repeat(500) + "[".repeat(500) });
    expect(() => parseBounded(body)).not.toThrow();
    expect(parseBounded(body)).toEqual(JSON.parse(body));
  });

  it("parses an ordinary body exactly as JSON.parse would", () => {
    const body = JSON.stringify(ACK);
    expect(parseBounded(body)).toEqual(JSON.parse(body));
  });

  it("a depth violation on a status read surfaces as an error, never as an empty success", async () => {
    let n = 0;
    const deep = "[".repeat(MAX_JSON_DEPTH + 5) + "]".repeat(MAX_JSON_DEPTH + 5);
    const fetch = vi.fn(async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify(ACK), { status: 202 });
      return new Response(deep, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const err = (await client(fetch, { maxRetries: 0 })
      .collectAndWait(
        { amount: 10, phone: "0712345678", idempotencyKey: "deep-1" },
        { timeoutMs: 1_000 },
      )
      .catch((e: unknown) => e)) as PaylodError;

    expect(err).toBeInstanceOf(PaylodError);
    expect(err.idempotencyKey).toBe("deep-1");
    expect(err.paymentId).toBe("pay_123");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 8. BOUNDS
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("D8 — the webhook tolerance has a documented UPPER bound", () => {
  const raw = JSON.stringify({ type: "payment.failed" });

  it("refuses an ENORMOUS tolerance, which disables replay protection while looking enabled", () => {
    expect(() =>
      verifyWebhook({
        payload: raw,
        signature: signWebhook(raw, SECRET, 1_700_000_000),
        secret: SECRET,
        toleranceSec: 86_400_000,
        nowSec: 1_700_000_000,
      }),
    ).toThrow(/toleranceSec must be a finite positive integer/i);
  });

  it("names the ceiling in the message so the fix is obvious", () => {
    const err = (() => {
      try {
        verifyWebhook({
          payload: raw,
          signature: signWebhook(raw, SECRET, 1_700_000_000),
          secret: SECRET,
          toleranceSec: MAX_TOLERANCE_SEC + 1,
          nowSec: 1_700_000_000,
        });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err.message).toContain(String(MAX_TOLERANCE_SEC));
    expect(err.message).toMatch(/pin the clock with `nowSec`/i);
  });

  it("accepts a tolerance exactly AT the ceiling", () => {
    // Reaches the schema check rather than the tolerance check — i.e. the tolerance was accepted.
    expect(() =>
      verifyWebhook({
        payload: raw,
        signature: signWebhook(raw, SECRET, 1_700_000_000),
        secret: SECRET,
        toleranceSec: MAX_TOLERANCE_SEC,
        nowSec: 1_700_000_000,
      }),
    ).toThrow(/not a valid paylod event/i);
  });

  it("still refuses zero and negatives — the lower bound did not regress", () => {
    for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() =>
        verifyWebhook({
          payload: raw,
          signature: signWebhook(raw, SECRET, 1_700_000_000),
          secret: SECRET,
          toleranceSec: bad,
          nowSec: 1_700_000_000,
        }),
      ).toThrow(/toleranceSec must be/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE THREAT MODEL'S ACCEPTED LIMIT (SECURITY.md, "out of scope")
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("documented limitation — same-process code is NOT defended against", () => {
  /**
   * This test asserts a LEAK, on purpose.
   *
   * SECURITY.md states plainly that replacing `globalThis.fetch` BEFORE the client is constructed
   * still results in a live bearer token reaching the replacement, and that the transport is
   * therefore not a security boundary against same-process code. That claim has to stay true: if a
   * future change made it false we would want to say so, and if a future change made the docs
   * quietly overstate the guarantee we would want that to fail loudly.
   *
   * The protection that DOES exist is against a LATER reassignment — the transport binds the
   * implementation it captured at construction — and that half is asserted below.
   */
  it("a fetch replaced BEFORE construction receives the token (accepted, documented)", async () => {
    const real = globalThis.fetch;
    let seen: string | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      return new Response(JSON.stringify(ACK), { status: 202 });
    }) as unknown as typeof globalThis.fetch;

    try {
      // No `allowCustomFetch`, and a LIVE key — neither gate is engaged, because this is not the
      // custom-fetch seam at all. It is simply the `fetch` the SDK found in its own runtime.
      const paylod = new Paylod("mp_live_threatmodel");
      await paylod.collect({ amount: 10, phone: "0712345678", idempotencyKey: "tm-1" });
    } finally {
      globalThis.fetch = real;
    }

    expect(seen).toBe("Bearer mp_live_threatmodel");
  });

  it("but a fetch replaced AFTER construction does NOT — the implementation is bound", async () => {
    const real = globalThis.fetch;
    let original = 0;
    let swapped = 0;

    globalThis.fetch = (async () => {
      original++;
      return new Response(JSON.stringify(ACK), { status: 202 });
    }) as unknown as typeof globalThis.fetch;

    try {
      const paylod = new Paylod("mp_test_threatmodel");
      // Swap AFTER construction. The transport captured and bound the one above.
      globalThis.fetch = (async () => {
        swapped++;
        return new Response(JSON.stringify(ACK), { status: 202 });
      }) as unknown as typeof globalThis.fetch;

      await paylod.collect({ amount: 10, phone: "0712345678", idempotencyKey: "tm-2" });
    } finally {
      globalThis.fetch = real;
    }

    expect(original).toBe(1);
    expect(swapped).toBe(0);
  });
});
