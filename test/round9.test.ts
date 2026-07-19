/**
 * ROUND 9 — the findings from the ninth independent review.
 *
 * Two of these are classes rather than instances, and the tests are written to cover the class:
 *
 *   R9-A  TWO BOUNDS THAT DISAGREE, WHERE THE SHALLOWER ONE FAILS OPEN. `containsSecret` stopped
 *         at depth 8 and reported CLEAN; `parseBounded` admits 64 levels. The gap between them
 *         was a credential-smuggling channel: a signed body carrying the configured API key or
 *         webhook secret at depth 9 walked past the refusal, `verifyWebhookSignature` returned it
 *         raw, and the typed path stripped it during allowlist reconstruction and delivered the
 *         event as valid — so "refuse" and "silently strip" disagreed across two public entry
 *         points to the same channel.
 *
 *         The fix is not a bigger number. It is (1) ONE constant shared by the parser and every
 *         traversal, so the limits cannot drift apart, and (2) every traversal limit FAILING
 *         CLOSED, so "I did not look" can never be reported as "I looked and it is clean".
 *
 *   R9-B  A LEXEME THAT IS NOT A CODE MUST NOT BE EVIDENCE. `CANONICAL_DOTTED_RE` accepted
 *         one-dot forms, so `"500.0"` validated as CANONICAL — the only classification that can
 *         be a confident terminal failure. This is the THIRD sighting of one root across the
 *         SDKs (JVM round 8, Python's `float()` variant, Node here), and every previous fix was
 *         applied at one layer while the laundering survived at another. So it is tested at all
 *         four: classifier, decoder, judge, and webhook verification.
 *
 *   R9-C  A DIAGNOSTIC BUILT FROM SERVER DATA IS A DISCLOSURE CHANNEL. Python's round-9 Critical
 *         was a NEW refusal — written in round 8 — interpolating a raw server header and thereby
 *         putting a bearer token into `str(error)`. The refusal is exactly where the value gets
 *         printed, because a refusal feels safe. The adversarial sweep at the bottom of this file
 *         covers that class rather than its instances.
 *
 * Each test here is the guard for one reverted-protection case in `scripts/non-vacuity.mjs`.
 */

import { describe, expect, it } from "vitest";
import { Paylod } from "../src/client.js";
import {
  PaylodApiError,
  PaylodConfigError,
  PaylodInvalidRequestError,
  PaylodResponseTooLargeError,
  PaylodSignatureVerificationError,
} from "../src/errors.js";
import { MAX_JSON_DEPTH, stringifyBounded, parseBounded } from "../src/json.js";
import { containsSecret } from "../src/validate.js";
import { classifyStkResult, decodeDarajaResult } from "../src/daraja-catalog.js";
import { judge } from "../src/semantics.js";
import { signWebhook, verifyWebhook, verifyWebhookSignature } from "../src/webhook.js";
import { safeUrl } from "../src/transport.js";
import { toOutcome } from "../src/outcome.js";

const KEY = "mp_test_round9apikeyvalue";
const SECRET = "whsec_round9signingsecretvalue";

/** The minimum a simulator collect ack must carry to be accepted. */
const ACK_BODY = {
  paymentId: "pay_r9",
  status: "pending",
  checkoutRequestId: "ws_CO_r9",
  outcomes: [],
};

function client(over: Record<string, unknown> = {}, fetch?: typeof globalThis.fetch) {
  return new Paylod(KEY, {
    fetch: fetch ?? (async () => new Response("{}", { status: 200 })),
    allowCustomFetch: true,
    webhookSecret: SECRET,
    ...over,
  } as never);
}

/** Bytes in, bytes out — never re-serialised, so a deliberate spelling survives to the SDK. */
function rawFetch(status: number, text: string) {
  return (async () =>
    new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

/**
 * Build `{"a":{"a":{...{"leaf": payload}}}}` nested exactly `levels` containers deep.
 *
 * `levels` counts CONTAINERS, which is what `parseBounded` counts, so a value built at
 * `MAX_JSON_DEPTH` is the deepest document the parser will accept — and therefore the deepest
 * place a credential can legally hide.
 */
function nestObject(levels: number, leaf: Record<string, unknown>): unknown {
  // `leaf` is itself one container, so it is wrapped `levels - 1` times.
  let v: unknown = leaf;
  for (let i = 0; i < levels - 1; i++) v = { a: v };
  return v;
}

function signedRequest(bodyObj: unknown, secret = SECRET) {
  const raw = Buffer.from(JSON.stringify(bodyObj), "utf8");
  return { payload: raw, signature: signWebhook(raw, secret), secret, apiKey: KEY };
}

/** A structurally valid `payment.failed` event, before any hostile field is spliced in. */
function failedEvent(over: Record<string, unknown> = {}) {
  return {
    type: "payment.failed",
    created: Math.floor(Date.now() / 1000),
    data: {
      paymentId: "pay_r9",
      applicationId: "app_r9",
      env: "sandbox",
      status: "failed",
      amount: 100,
      phone: "254712345678",
      accountRef: "ORDER-1",
      mpesaReceipt: null,
      checkoutRequestId: "ws_CO_r9",
      resultCode: "1032",
      resultDesc: "Request cancelled by user",
      ...over,
    },
  };
}

// ── R9-A THE DEPTH MISMATCH ───────────────────────────────────────────────────────────────

describe("R9-A the credential scan reaches as deep as the parser accepts", () => {
  it("finds a secret at depth 9, the first level the old cutoff reported CLEAN", () => {
    // The whole Critical in one assertion. Depth 9 is one past the old `depth > 8` cutoff and
    // far inside what `parseBounded` admits, so under the old bound this returned false.
    expect(containsSecret(nestObject(9, { token: KEY }), [KEY])).toBe(true);
    expect(containsSecret(nestObject(9, { [SECRET]: "v" }), [SECRET])).toBe(true);
  });

  it("finds a secret at the deepest level the parser will ever hand it", () => {
    const deepest = nestObject(MAX_JSON_DEPTH, { token: SECRET });
    expect(containsSecret(deepest, [SECRET])).toBe(true);
  });

  it("still reports CLEAN for a deep structure that genuinely holds no secret", () => {
    // THE DISCRIMINATOR. Without this, "fail closed" would be indistinguishable from "always
    // return true", and every assertion above would pass against a scan that had stopped
    // thinking. A deep clean body must still be accepted.
    expect(containsSecret(nestObject(MAX_JSON_DEPTH, { token: "harmless" }), [KEY, SECRET])).toBe(
      false,
    );
  });

  it("FAILS CLOSED past the budget instead of reporting clean", () => {
    // Beyond what the parser can produce, the honest answer is "unknown", and unknown is REFUSED.
    // "I did not look" and "I looked and it is clean" must never be the same answer.
    const tooDeep = nestObject(MAX_JSON_DEPTH + 5, { token: "harmless" });
    expect(containsSecret(tooDeep, [KEY])).toBe(true);
  });

  it("derives the traversal budget from the parser's own constant", () => {
    // One source of truth. If `MAX_JSON_DEPTH` moves, the scan moves with it — the two limits
    // cannot drift apart, which is what made the original bypass possible.
    const atLimit = nestObject(MAX_JSON_DEPTH, { token: KEY });
    expect(() => parseBounded(JSON.stringify(atLimit))).not.toThrow();
    expect(containsSecret(atLimit, [KEY])).toBe(true);
  });

  it("refuses an API 2xx body hiding the bearer key at depth 9", async () => {
    const body = { ...nestObject(9, { echo: KEY }) as object, paymentId: "pay_r9", status: "pending", checkoutRequestId: "ws_CO_r9" };
    const p = client({}, rawFetch(202, JSON.stringify(body)));
    await expect(
      p.collect({ phone: "254712345678", amount: 100, idempotencyKey: "idem-r9-depth9" }),
    ).rejects.toThrow(PaylodApiError);
  });

  it("refuses an API 2xx body hiding the bearer key at the parser's maximum depth", async () => {
    const body = {
      ...nestObject(MAX_JSON_DEPTH, { echo: KEY }) as object,
      paymentId: "pay_r9",
      status: "pending",
      checkoutRequestId: "ws_CO_r9",
    };
    const p = client({}, rawFetch(202, JSON.stringify(body)));
    await expect(
      p.collect({ phone: "254712345678", amount: 100, idempotencyKey: "idem-r9-depth64" }),
    ).rejects.toThrow(PaylodApiError);
  });

  it("REFUSES a signed body hiding a credential at depth 9 — the untyped entry point", () => {
    const evt = failedEvent();
    (evt.data as Record<string, unknown>).extra = nestObject(9, { echo: SECRET });
    expect(() => verifyWebhookSignature(signedRequest(evt))).toThrow(
      PaylodSignatureVerificationError,
    );
  });

  it("REFUSES a signed body hiding a credential at depth 9 — the typed entry point", () => {
    // THE TWO PATHS MUST AGREE. This is the half the finding called out: the typed path
    // reconstructs from an allowlist, so a credential in an unknown deep field was silently
    // STRIPPED and the event accepted as valid. A signed body containing our own credential
    // means the server is compromised or misconfigured; refusing is the only correct response,
    // and it is already the documented posture for the untyped path.
    const evt = failedEvent();
    (evt.data as Record<string, unknown>).extra = nestObject(9, { echo: SECRET });
    expect(() => verifyWebhook(signedRequest(evt))).toThrow(PaylodSignatureVerificationError);
  });

  it("REFUSES a signed body hiding the API KEY at the parser's maximum depth, both entry points", () => {
    const evt = failedEvent();
    (evt.data as Record<string, unknown>).extra = nestObject(MAX_JSON_DEPTH, { echo: KEY });
    const req = signedRequest(evt);
    expect(() => verifyWebhookSignature(req)).toThrow(PaylodSignatureVerificationError);
    expect(() => verifyWebhook(req)).toThrow(PaylodSignatureVerificationError);
  });

  it("still DELIVERS a deep-but-clean signed event — the refusal discriminates", () => {
    // The control for the webhook half: fail-closed must not become refuse-everything, or the
    // tests above would pass against a channel that had simply stopped working.
    const evt = failedEvent();
    (evt.data as Record<string, unknown>).extra = nestObject(9, { echo: "harmless" });
    expect(() => verifyWebhookSignature(signedRequest(evt))).not.toThrow();
    expect(verifyWebhook(signedRequest(evt)).data.paymentId).toBe("pay_r9");
  });
});

// ── R9-B THE ONE-DOT DOTTED CODE ──────────────────────────────────────────────────────────

describe("R9-B a one-dot lexeme is not a Daraja code, at every layer", () => {
  const LAUNDERED = "500.0";
  const REAL = "500.001.1001";

  it("CLASSIFIER: a one-dot code is never a confident terminal failure", () => {
    // `pending` is the ambiguity rule — never success, never a confident failure.
    expect(classifyStkResult(LAUNDERED, "wrong credentials")).toBe("pending");
    // CONTROL: the real three-segment code still classifies as it always did.
    expect(classifyStkResult(REAL, "wrong credentials")).not.toBe("pending");
  });

  it("DECODER: a one-dot code decodes as indeterminate, not as a catalog entry", () => {
    // "unknown" is the decoder's explicit no-outcome-claimed entry — it selects NO catalog row.
    const bad = decodeDarajaResult(LAUNDERED, "wrong credentials");
    expect(bad.code).toBe("unknown");
    expect(bad.retryable).toBe(false);
    // CONTROL: the real code still selects its genuine catalog row.
    const good = decodeDarajaResult(REAL, "wrong credentials");
    expect(good.code).toBe(REAL);
  });

  it("JUDGE: `failed` plus a one-dot code is INDETERMINATE, not a terminal failure", () => {
    const laundered = judge({
      id: "pay_r9",
      status: "failed",
      mpesaReceipt: null,
      resultCode: LAUNDERED,
      resultDesc: "wrong credentials",
    });
    // The guarantee is that a spelling can NEVER be confident terminal failure evidence. It
    // falls through to the ambiguity rule, which never authorises another charge.
    expect(laundered.verdict).not.toBe("failed");
    expect(laundered.verdict).not.toBe("paid");
    expect(toOutcome({ id: "pay_r9", status: "failed", mpesaReceipt: null, resultCode: LAUNDERED, resultDesc: "wrong credentials" }).retryable).toBe(false);

    // CONTROL — no over-correction. A genuine catalog failure code must STILL be a failure.
    const genuine = judge({
      id: "pay_r9",
      status: "failed",
      mpesaReceipt: null,
      resultCode: REAL,
      resultDesc: "wrong credentials",
    });
    expect(genuine.verdict).toBe("failed");
  });

  it("WEBHOOK: an otherwise-valid payment.failed carrying a one-dot code is REFUSED", () => {
    // The layer the previous two fixes were applied above and below. A `payment.failed` must
    // carry real failure evidence; a spelling is not evidence.
    const evt = failedEvent({ resultCode: LAUNDERED, resultDesc: "wrong credentials" });
    expect(() => verifyWebhook(signedRequest(evt))).toThrow(PaylodSignatureVerificationError);
  });

  it("WEBHOOK CONTROL: the same event with a real three-segment code is ACCEPTED", () => {
    const evt = failedEvent({ resultCode: REAL, resultDesc: "wrong credentials" });
    expect(verifyWebhook(signedRequest(evt)).data.resultCode).toBe(REAL);
  });

  it("accepts every dotted shape Daraja actually emits", () => {
    for (const code of ["500.001.1001", "400.002.02", "500.001.1001.0"]) {
      expect(classifyStkResult(code, "")).not.toBe("success");
      expect(decodeDarajaResult(code, "").code).toBeDefined();
    }
  });
});

// ── R9-C BOUNDS, DEFAULTS AND DIAGNOSTICS ─────────────────────────────────────────────────

describe("R9-C the remaining round-9 bounds and coercions", () => {
  it("REFUSES a fractional bodyReadTimeoutMs instead of flooring it to a zero deadline", () => {
    const p = client();
    const noop = async () => {};
    expect(() => p.webhookHandler(noop, { bodyReadTimeoutMs: 0.5 })).toThrow(PaylodConfigError);
    expect(() => p.webhookHandler(noop, { bodyReadTimeoutMs: 1500.5 })).toThrow(PaylodConfigError);
    expect(() => p.webhookHandler(noop, { bodyReadTimeoutMs: 0 })).toThrow(PaylodConfigError);
    expect(() => p.webhookHandler(noop, { bodyReadTimeoutMs: 60_001 })).toThrow(PaylodConfigError);
    // CONTROL: a whole in-range value is still accepted.
    expect(() => p.webhookHandler(noop, { bodyReadTimeoutMs: 1500 })).not.toThrow();
  });

  it("REFUSES a request body nested past the parser's own depth budget, before dispatch", () => {
    expect(() => stringifyBounded(nestObject(MAX_JSON_DEPTH + 5, { x: 1 }))).toThrow(
      PaylodInvalidRequestError,
    );
    // CONTROL: a body at the limit still serialises.
    expect(() => stringifyBounded(nestObject(MAX_JSON_DEPTH - 1, { x: 1 }))).not.toThrow();
  });

  it("REFUSES a circular request body without naming the caller-data path", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    let caught: unknown;
    try {
      stringifyBounded(cyc);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PaylodInvalidRequestError);
    // The CYCLE message specifically. Without cycle detection the walk recurses until the DEPTH
    // guard fires, which throws the same class with a different reason — so asserting only the
    // shared prefix could not tell the two apart, and the case certified nothing.
    expect((caught as Error).message).toMatch(/circular reference/);
    expect((caught as Error).message).toMatch(/NOTHING was dispatched/);
    expect((caught as Error).message).not.toMatch(/self/);
  });

  it("treats a repeated object on sibling branches as legal JSON, not as a cycle", () => {
    // The discriminator between an ancestor set and a global visited set. A DAG is legal JSON.
    const shared = { v: 1 };
    expect(() => stringifyBounded({ left: shared, right: shared })).not.toThrow();
  });

  it("REFUSES an oversized request body before it is dispatched", () => {
    expect(() => stringifyBounded({ metadata: "x".repeat(300_000) })).toThrow(
      PaylodInvalidRequestError,
    );
  });

  it("does not default a runtime-invalid falsy phone in the simulator", async () => {
    // COUNTED DISPATCHES, not just "it threw". With the default restored, `phone: null` silently
    // becomes the default handset and a request GOES OUT — the divergence from production is
    // that a charge was dispatched at all, not that some later step happened to complain.
    for (const [label, phone] of [["null", null], ["blank", ""], ["zero", 0]] as const) {
      let dispatches = 0;
      const fetch = (async () => {
        dispatches++;
        return new Response(JSON.stringify({ ...ACK_BODY }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch;

      const p = client({ simulate: true }, fetch);
      await expect(
        p.simulate.collect({ phone, amount: 100, idempotencyKey: `idem-r9-${label}` } as never),
      ).rejects.toThrow(PaylodInvalidRequestError);
      expect(dispatches).toBe(0);
    }

    // CONTROL: documented absence still defaults, and a real phone still dispatches.
    let sent = 0;
    const okFetch = (async () => {
      sent++;
      return new Response(JSON.stringify({ ...ACK_BODY }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const p = client({ simulate: true }, okFetch);
    await p.simulate.collect({ amount: 100, idempotencyKey: "idem-r9-absent" } as never);
    expect(sent).toBe(1);
  });

  it("does not coerce a malformed webhookQueued to true", async () => {
    // THROUGH THE REAL SURFACE, not a re-implementation of the expression under test. This is the
    // one field a caller uses to decide whether to expect delivery at all, so coercing a
    // malformed value to `true` tells them to wait for an event that will never arrive.
    const settle = (webhookQueued: unknown) => ({
      paymentId: "pay_r9",
      status: "success",
      mpesaReceipt: "QGR1ABCDEF",
      resultCode: "0",
      resultDesc: "The service request is processed successfully.",
      ...(webhookQueued === undefined ? {} : { webhookQueued }),
    });

    for (const bad of [null, 0, 1, "yes", "false", "true", {}, []]) {
      const p = client({ simulate: true }, rawFetch(200, JSON.stringify(settle(bad))));
      const res = await p.simulate.outcome("pay_r9", "approve");
      expect(res.webhookQueued).toBe(false);
    }

    // CONTROLS: a real `true`, a real `false`, and documented absence.
    for (const [given, expected] of [[true, true], [false, false], [undefined, true]] as const) {
      const p = client({ simulate: true }, rawFetch(200, JSON.stringify(settle(given))));
      expect((await p.simulate.outcome("pay_r9", "approve")).webhookQueued).toBe(expected);
    }
  });

  it("REDACTS a configured credential out of a baseUrl diagnostic", () => {
    // The Node instance of Python's round-9 Critical, from the configuration direction.
    expect(() => new Paylod(KEY, { baseUrl: `https://evil.example/${KEY}` } as never)).toThrow(
      PaylodConfigError,
    );
    let message = "";
    try {
      new Paylod(KEY, { baseUrl: `https://evil.example/${KEY}` } as never);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(KEY);
    expect(message).toContain("[redacted]");
  });

  it("BOUNDS the server-chosen lexeme it reproduces in a refusal", () => {
    // The scan reads a "number" to the next `,}] ` or whitespace, all of which the server picks,
    // so the lexeme is unbounded and attacker-controlled unless it is cut.
    const smuggled = `0.0${"A".repeat(400)}${KEY}`;
    let message = "";
    try {
      parseBounded(`{"resultCode":${smuggled}}`);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(KEY);
    expect(message.length).toBeLessThan(1200);
  });
});

// ── R9-D THE PERMANENT ADVERSARIAL SWEEP ──────────────────────────────────────────────────

/**
 * THE CLASS, NOT THE INSTANCES.
 *
 * Every finding above that involves a credential is one instance of a single question: can a
 * value the SERVER chose carry the API key or the webhook secret into something an ordinary
 * application would serialise? Testing the instances leaves the next instance uncovered — and
 * across nine rounds the same root has repeatedly resurfaced one layer above or below the layer
 * that was fixed.
 *
 * So this sweep is written against the surface rather than the bug: a hostile response echoes
 * both configured credentials into every string field, at several depths, and every public
 * object and every public error it can produce is serialised every way an application plausibly
 * would — `JSON.stringify`, `String()`, `.message`, `.stack`, and a recursive walk of every
 * enumerable property, which is what a crash reporter does.
 */
describe("R9-D adversarial sweep: no credential survives into any public serialization", () => {
  const CREDS = [KEY, SECRET];

  /** Every string a crash reporter would reach on this value, including nested own properties. */
  function allStrings(value: unknown, depth = 0, seen = new Set<object>()): string[] {
    if (depth > MAX_JSON_DEPTH) return [];
    if (typeof value === "string") return [value];
    if (value === null || typeof value !== "object") return [];
    if (seen.has(value)) return [];
    seen.add(value);
    const out: string[] = [];
    if (value instanceof Error) {
      out.push(value.message, value.stack ?? "", String(value));
      // `cause` is walked by every error reporter in existence.
      out.push(...allStrings((value as { cause?: unknown }).cause, depth + 1, seen));
    }
    // Own enumerable properties, keys included — a credential can be a key as easily as a value.
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      out.push(...allStrings(v, depth + 1, seen));
    }
    try {
      out.push(JSON.stringify(value) ?? "");
    } catch {
      /* circular or unrenderable — the property walk above already covered it */
    }
    return out;
  }

  /** Run `fn`, returning whatever it produced OR whatever it threw — never both, never neither. */
  function settle(fn: () => unknown): unknown {
    try {
      return fn();
    } catch (e) {
      return e;
    }
  }

  /** The async twin. `await`ing inside a try whose catch also asserts is the same trap. */
  async function settleAsync(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      return await fn();
    } catch (e) {
      return e;
    }
  }

  function assertClean(label: string, value: unknown): void {
    for (const s of allStrings(value)) {
      for (const cred of CREDS) {
        if (s.includes(cred)) {
          throw new Error(`${label}: a configured credential reached a serialization: ${label}`);
        }
      }
    }
  }

  /** A hostile body echoing both credentials into every string field at `depth`. */
  function hostileBody(depth: number, base: Record<string, unknown>): Record<string, unknown> {
    const poisoned: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(poisoned)) {
      if (typeof v === "string") poisoned[k] = `${v} ${KEY} ${SECRET}`;
    }
    poisoned[`k_${SECRET}`] = KEY;
    poisoned.buried = nestObject(depth, { echo: KEY, [SECRET]: SECRET });
    return poisoned;
  }

  const DEPTHS = [1, 2, 9, 32, MAX_JSON_DEPTH];

  for (const depth of DEPTHS) {
    it(`keeps both credentials out of every collect result and error at depth ${depth}`, async () => {
      const body = hostileBody(depth, {
        paymentId: "pay_r9",
        status: "pending",
        checkoutRequestId: "ws_CO_r9",
      });
      const p = client({}, rawFetch(202, JSON.stringify(body)));
      // Result OR error — whichever the call produced, it is the thing an application sees.
      assertClean(
        `collect @${depth}`,
        await settleAsync(() =>
          p.collect({
            phone: "254712345678",
            amount: 100,
            idempotencyKey: `idem-sweep-collect-${depth}`,
          }),
        ),
      );
    });

    it(`keeps both credentials out of every status result and error at depth ${depth}`, async () => {
      const body = hostileBody(depth, {
        id: "pay_r9",
        status: "success",
        mpesaReceipt: "QGR1ABCDEF",
        resultCode: "0",
        resultDesc: "The service request is processed successfully.",
      });
      const p = client({}, rawFetch(200, JSON.stringify(body)));
      const got = await settleAsync(() => p.status("pay_r9"));
      assertClean(`status @${depth}`, got);
      // The rendered object built FROM it is a separate public surface and gets its own sweep.
      if (!(got instanceof Error)) {
        assertClean(`outcome @${depth}`, settle(() => toOutcome(got as never)));
      }
    });

    it(`keeps both credentials out of every non-2xx API error at depth ${depth}`, async () => {
      const body = hostileBody(depth, { error: "something went wrong" });
      const p = client({}, rawFetch(400, JSON.stringify(body)));
      const got = await settleAsync(() => p.status("pay_r9"));
      expect(got).toBeInstanceOf(Error);
      assertClean(`api error @${depth}`, got);
    });

    it(`keeps both credentials out of both webhook entry points at depth ${depth}`, () => {
      const evt = failedEvent();
      (evt.data as Record<string, unknown>).extra = nestObject(depth, {
        echo: KEY,
        [SECRET]: SECRET,
      });
      const req = signedRequest(evt);
      for (const [label, fn] of [
        ["verifyWebhookSignature", () => verifyWebhookSignature(req)],
        ["verifyWebhook", () => verifyWebhook(req)],
      ] as const) {
        assertClean(`${label} @${depth}`, settle(fn));
      }
    });
  }

  it("keeps both credentials out of every configuration refusal", () => {
    // The construction surface, where the credential is the value most likely to be misplaced.
    const badUrls = [
      `https://evil.example/${KEY}`,
      `https://paylod.dev/?t=${SECRET}`,
      `http://paylod.dev/${KEY}`,
      `ftp://paylod.dev/${SECRET}`,
      `https://user:${KEY}@paylod.dev`,
      `https://paylod.dev:8443/${KEY}`,
      `not a url ${KEY}`,
    ];
    for (const baseUrl of badUrls) {
      const got = settle(() => new Paylod(KEY, { baseUrl, webhookSecret: SECRET } as never));
      expect(got).toBeInstanceOf(PaylodConfigError);
      assertClean(`config refusal for ${baseUrl.slice(0, 24)}`, got);
    }
    assertClean("safeUrl", safeUrl(`https://evil.example/${KEY}`, [KEY, SECRET]));
  });

  it("proves the sweep can actually fail", () => {
    // THE SWEEP'S OWN DISCRIMINATOR. Every assertion above is a negative, and a negative
    // assertion over a helper that silently returns nothing is the definition of a vacuous test.
    // This proves `allStrings` reaches nested values, object keys, and error properties.
    expect(() => assertClean("control", { a: { b: [{ c: KEY }] } })).toThrow();
    expect(() => assertClean("control", { [SECRET]: "v" })).toThrow();
    expect(() => assertClean("control", new Error(`boom ${KEY}`))).toThrow();
    expect(() => assertClean("control", Object.assign(new Error("x"), { body: { d: SECRET } }))).toThrow();
    // And that it passes on a genuinely clean value.
    expect(() => assertClean("control", { a: { b: [{ c: "harmless" }] } })).not.toThrow();
  });
});
