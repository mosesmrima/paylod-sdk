/**
 * Round-3 review fixes, plus the issues codex found as Critical/High in the SIBLING paylod SDKs
 * and which had to be verified here rather than assumed absent.
 *
 * Theme, as ever: never report an unpaid charge as paid, never invite a second charge, never let a
 * credential reach a place it can be logged.
 */
import { describe, expect, it, vi } from "vitest";
import {
  Paylod,
  PaylodApiError,
  PaylodConfigError,
  PaylodConnectionError,
  PaylodInvalidRequestError,
  PaylodTimeoutError,
  toOutcome,
} from "../src/index.js";
import { parseRetryAfterMs } from "../src/client.js";
import { ACK, mockFetch, payment, type Step } from "./helpers.js";

const KEY = "mp_test_abc123";

function client(steps: Step[], opts = {}) {
  const m = mockFetch(steps);
  return { m, paylod: new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0, ...opts }) };
}

// ── R3-1: the loopback opt-in must not unlock arbitrary protocols ──────────────────────────
describe("R3-1 — protocol is validated BEFORE the loopback opt-in can return", () => {
  // The opt-in returned early from the loopback branch, before the https check ran. So it did not
  // merely relax the ORIGIN rule — it relaxed the SCHEME rule too, and any protocol at all was
  // accepted so long as the host was loopback.
  const schemes = [
    ["ftp", "ftp://127.0.0.1/v1"],
    ["ws", "ws://localhost:4010/v1"],
    ["wss", "wss://localhost:4010/v1"],
    ["gopher", "gopher://[::1]/v1"],
    ["file", "file://localhost/etc/passwd"],
  ] as const;

  it.each(schemes)("rejects a %s loopback baseUrl even WITH the opt-in", (_label, baseUrl) => {
    expect(
      () => new Paylod({ apiKey: KEY, baseUrl, allowInsecureBaseUrl: true }),
    ).toThrow(PaylodConfigError);
  });

  it.each(schemes)("rejects a %s loopback baseUrl without the opt-in too", (_label, baseUrl) => {
    expect(() => new Paylod({ apiKey: KEY, baseUrl })).toThrow(PaylodConfigError);
  });

  it("the rejection names the protocol, so the fix is obvious", () => {
    expect(
      () => new Paylod({ apiKey: KEY, baseUrl: "ftp://127.0.0.1/v1", allowInsecureBaseUrl: true }),
    ).toThrow(/protocol "ftp:"/);
  });

  it("still allows the two shapes the opt-in exists for", () => {
    expect(
      () =>
        new Paylod({ apiKey: KEY, baseUrl: "http://127.0.0.1:4010/v1", allowInsecureBaseUrl: true }),
    ).not.toThrow();
    expect(
      () =>
        new Paylod({ apiKey: KEY, baseUrl: "https://localhost:8443/v1", allowInsecureBaseUrl: true }),
    ).not.toThrow();
  });

  it("and still refuses a live key on every one of them", () => {
    for (const baseUrl of ["http://127.0.0.1:4010/v1", "https://localhost:8443/v1", "ws://localhost/v1"]) {
      expect(
        () => new Paylod({ apiKey: "mp_live_realmoney", baseUrl, allowInsecureBaseUrl: true }),
      ).toThrow(PaylodConfigError);
    }
  });
});

// ── SIBLING CHECK A: the key must survive EVERY post-ack failure ───────────────────────────
describe("sibling A — collectAndWait() attaches the key to every post-acknowledgement failure", () => {
  // A charge is live the moment the ack comes back. Any failure after that point leaves the caller
  // holding a possibly-settling payment; without the key they cannot read it, and the natural
  // recovery — mint a new key and retry — is a second STK prompt.
  const collectThen = (poll: Step) => client([{ status: 202, json: ACK }, poll], { maxRetries: 0 });

  it("a WAIT TIMEOUT carries the key", async () => {
    const { paylod } = collectThen({ status: 200, json: payment({ status: "pending" }) });
    const err = (await paylod
      .collectAndWait(
        { amount: 1, phone: "0712345678", idempotencyKey: "attempt-timeout" },
        { timeoutMs: 50 },
      )
      .catch((e) => e)) as PaylodTimeoutError;
    expect(err).toBeInstanceOf(PaylodTimeoutError);
    expect(err.idempotencyKey).toBe("attempt-timeout");
  });

  it("a TRANSPORT ERROR on a poll carries the key", async () => {
    const { paylod } = collectThen({ throw: new TypeError("fetch failed") });
    const err = (await paylod
      .collectAndWait({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-net" })
      .catch((e) => e)) as PaylodConnectionError;
    expect(err).toBeInstanceOf(PaylodConnectionError);
    expect(err.idempotencyKey).toBe("attempt-net");
  });

  it("an HTTP ERROR on a poll carries the key", async () => {
    const { paylod } = collectThen({ status: 500, json: { error: "boom" } });
    const err = (await paylod
      .collectAndWait({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-500" })
      .catch((e) => e)) as PaylodApiError;
    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.idempotencyKey).toBe("attempt-500");
  });

  it("a MALFORMED POLL BODY carries the key", async () => {
    const { paylod } = collectThen({ status: 200, json: { id: "pay_123", status: "weird" } });
    const err = (await paylod
      .collectAndWait({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-malformed" })
      .catch((e) => e)) as PaylodApiError;
    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.indeterminate).toBe(true);
    expect(err.idempotencyKey).toBe("attempt-malformed");
  });

  it("a GENERATED key is recoverable the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { m, paylod } = collectThen({ throw: new TypeError("fetch failed") });
    const err = (await paylod
      .collectAndWait({ amount: 1, phone: "0712345678", unsafeGeneratedIdempotencyKey: true })
      .catch((e) => e)) as PaylodConnectionError;
    warn.mockRestore();
    const sent = m.calls[0]!.headers["idempotency-key"];
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(err.idempotencyKey).toBe(sent);
  });
});

// ── SIBLING CHECK B: "success" is a claim; paid requires evidence ──────────────────────────
describe("sibling B — reporting paid requires EVIDENCE, not a status string", () => {
  it('{"id","status":"success"} with no receipt and no code is NOT paid', () => {
    const o = toOutcome(payment({ status: "success", mpesaReceipt: null, resultCode: null }));
    expect(o.paid).toBe(false);
    expect(o.status).toBe("pending"); // indeterminate — let the webhook settle it
    expect(o.retryable).toBe(false); // and never invite a second charge
    expect(o.receipt).toBeNull();
  });

  it("a blank receipt string is not evidence either", () => {
    const o = toOutcome(payment({ status: "success", mpesaReceipt: "   ", resultCode: null }));
    expect(o.paid).toBe(false);
  });

  it("a receipt IS evidence", () => {
    const o = toOutcome(payment({ status: "success", mpesaReceipt: "SFF6XYZ123" }));
    expect(o.paid).toBe(true);
    expect(o.receipt).toBe("SFF6XYZ123");
  });

  it("result code 0 IS evidence", () => {
    const o = toOutcome(payment({ status: "success", resultCode: 0, mpesaReceipt: null }));
    expect(o.paid).toBe(true);
  });

  it("check() on an unevidenced success does not report paid", async () => {
    const { paylod } = client([{ status: 200, json: { id: "pay_1", status: "success" } }]);
    const o = await paylod.check("pay_1");
    expect(o.paid).toBe(false);
  });

  it("a malformed 2xx status raises an INDETERMINATE error", async () => {
    const { paylod } = client([{ status: 200, json: { id: "pay_1", status: "paid" } }]);
    const err = (await paylod.status("pay_1").catch((e) => e)) as PaylodApiError;
    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.indeterminate).toBe(true);
    expect(err.message).toMatch(/INDETERMINATE/);
  });

  it.each([
    ["a non-object body", "not json at all"],
    ["a missing id", { status: "success" }],
    ["an unknown status", { id: "p", status: "settled" }],
    ["a non-string receipt", { id: "p", status: "success", mpesaReceipt: 42 }],
  ])("rejects %s", async (_label, json) => {
    const { paylod } = client([{ status: 200, json }]);
    await expect(paylod.status("pay_1")).rejects.toBeInstanceOf(PaylodApiError);
  });
});

// ── SIBLING CHECK C: the collect ack is validated as a WHOLE schema ────────────────────────
describe("sibling C — collect-ack validation covers the complete schema", () => {
  it.each([
    ["no paymentId", { status: "pending", checkoutRequestId: "ws_1" }],
    ["no checkoutRequestId", { paymentId: "pay_1", status: "pending" }],
    ["a blank checkoutRequestId", { paymentId: "pay_1", checkoutRequestId: "  ", status: "pending" }],
    // `status` is a hardcoded literal "pending" on every 202 the backend emits, including an
    // idempotent replay (which returns the STORED original ack, not the settled state). So there
    // is no legitimate settled ack — and no legitimate ack missing the field.
    ["a non-pending status", { paymentId: "pay_1", checkoutRequestId: "ws_1", status: "success" }],
    ["a settled status", { paymentId: "pay_1", checkoutRequestId: "ws_1", status: "failed" }],
    ["a missing status", { paymentId: "pay_1", checkoutRequestId: "ws_1" }],
    ["a non-object body", "yes"],
  ])("treats %s as indeterminate, with the key attached", async (_label, json) => {
    const { paylod } = client([{ status: 202, json }]);
    const err = (await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "attempt-schema" })
      .catch((e) => e)) as PaylodApiError;
    expect(err).toBeInstanceOf(PaylodApiError);
    expect(err.indeterminate).toBe(true);
    expect(err.idempotencyKey).toBe("attempt-schema");
  });

  it("a complete ack is accepted", async () => {
    const { paylod } = client([{ status: 202, json: ACK }]);
    await expect(
      paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "ok" }),
    ).resolves.toMatchObject({ paymentId: "pay_123", checkoutRequestId: "ws_CO_0001" });
  });
});

// ── SIBLING CHECK D: Retry-After, both RFC 9110 forms ──────────────────────────────────────
describe("sibling D — Retry-After is parsed in both forms, case-insensitively", () => {
  const NOW = 1_700_000_000_000;

  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("5", NOW)).toBe(5_000);
    expect(parseRetryAfterMs("0", NOW)).toBe(0);
    expect(parseRetryAfterMs("  12  ", NOW)).toBe(12_000);
  });

  it("parses the HTTP-date form (which used to be silently discarded)", () => {
    const when = new Date(NOW + 45_000).toUTCString();
    expect(parseRetryAfterMs(when, NOW)).toBe(45_000);
  });

  it("a past HTTP-date means retry now, never a negative sleep", () => {
    expect(parseRetryAfterMs(new Date(NOW - 60_000).toUTCString(), NOW)).toBe(0);
  });

  it.each([["fractional", "5.5"], ["negative", "-3"], ["garbage", "soon"], ["empty", "   "]])(
    "treats a %s value as absent rather than coercing it",
    (_label, raw) => {
      expect(parseRetryAfterMs(raw, NOW)).toBeUndefined();
    },
  );

  it("applies no independent truncation — the value is returned as asked", () => {
    // Bounding belongs in ONE place (#boundedSleep). A private clamp here would shadow the
    // unbounded-sleep ceiling and leave it untested.
    expect(parseRetryAfterMs("86400", NOW)).toBe(86_400_000);
  });

  it("the HEADER NAME matches whatever case the server used", async () => {
    for (const name of ["Retry-After", "retry-after", "RETRY-AFTER"]) {
      const m = mockFetch([
        { status: 429, headers: { [name]: "1" } },
        { status: 202, json: ACK },
      ]);
      const paylod = new Paylod({ apiKey: KEY, fetch: m.fetch, allowCustomFetch: true, maxRetries: 2 });
      await expect(
        paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: `k-${name}` }),
      ).resolves.toBeDefined();
      expect(m.count).toBe(2);
    }
  });
});

// ── SIBLING CHECK E: timeouts are whole positive integers ──────────────────────────────────
describe("sibling E — timeouts must be finite whole positive integers", () => {
  // setTimeout clamps BOTH NaN and Infinity to fire immediately, so these shapes do not mean
  // "no timeout" — they mean "abort every request at once", which makes a live charge look like
  // a transport failure.
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["fractional", 1500.5],
    ["zero", 0],
    ["negative", -1],
    ["a string", "3000" as unknown as number],
  ])("rejects timeoutMs = %s at construction", (_label, value) => {
    expect(() => new Paylod({ apiKey: KEY, timeoutMs: value })).toThrow(PaylodInvalidRequestError);
  });

  it.each([
    ["NaN", Number.NaN],
    ["fractional", 2.5],
    ["negative", -1],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects maxRetries = %s at construction", (_label, value) => {
    expect(() => new Paylod({ apiKey: KEY, maxRetries: value })).toThrow(PaylodInvalidRequestError);
  });

  it("maxRetries = 0 is legitimate", () => {
    expect(() => new Paylod({ apiKey: KEY, maxRetries: 0 })).not.toThrow();
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["fractional", 100.5],
    ["zero", 0],
  ])("rejects wait timeoutMs = %s", async (_label, value) => {
    const { paylod } = client([{ status: 200, json: payment() }]);
    await expect(paylod.wait("pay_1", { timeoutMs: value })).rejects.toBeInstanceOf(
      PaylodInvalidRequestError,
    );
  });

  it("accepts ordinary whole values", () => {
    expect(() => new Paylod({ apiKey: KEY, timeoutMs: 5_000, maxRetries: 3 })).not.toThrow();
  });
});

// ── SIBLING CHECK F: the simulator runs the PRODUCTION validators ──────────────────────────
describe("sibling F — the simulator reuses the production validators, not weaker copies", () => {
  // The simulator's own copy checked C0 controls and DEL only. Everything below was accepted here
  // and rejected in production — so a "a double-click cannot charge twice" test could pass against
  // a key that would never have provided that guarantee for real.
  it.each([
    ["a C1 control (NEL)", "attempt--1"],
    ["a zero-width space", "attempt-​-1"],
    ["a non-breaking space", "attempt- -1"],
    ["an accented character", "ordr-café-1"],
    ["an emoji", "attempt-\u{1f600}"],
    ["an over-long key", "x".repeat(256)],
  ])("simulate.collect() rejects %s, exactly as production does", async (_label, key) => {
    const { m, paylod } = client([{ status: 202, json: ACK }]);
    await expect(paylod.simulate.collect({ idempotencyKey: key })).rejects.toBeInstanceOf(
      PaylodInvalidRequestError,
    );
    expect(m.count).toBe(0); // rejected before a byte leaves the process

    // …and the production surface agrees. Identical verdict, one validator.
    const { paylod: prod } = client([{ status: 202, json: ACK }]);
    await expect(
      prod.collect({ amount: 1, phone: "0712345678", idempotencyKey: key }),
    ).rejects.toBeInstanceOf(PaylodInvalidRequestError);
  });

  it("simulate.collect() validates the ack schema production validates", async () => {
    const { paylod } = client([{ status: 200, json: { paymentId: "pay_1" } }]); // no checkoutRequestId
    await expect(paylod.simulate.collect({ idempotencyKey: "t-35",})).rejects.toBeInstanceOf(PaylodApiError);
  });

  it("a well-formed simulated ack still works", async () => {
    const { paylod } = client([
      { status: 202, json: { ...ACK, outcomes: [] } },
    ]);
    await expect(paylod.simulate.collect({ idempotencyKey: "t-34",})).resolves.toMatchObject({ paymentId: "pay_123" });
  });
});

// ── SIBLING CHECK G: no secret reaches a message, a stack, or an echoed body ───────────────
describe("sibling G — secrets never reach an error message, stack or echoed body", () => {
  it("a baseUrl password is not echoed back by the check that rejects it", () => {
    const err = (() => {
      try {
        new Paylod({ apiKey: KEY, baseUrl: "https://user:hunter2@paylod.dev/v1" });
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(err).toBeInstanceOf(PaylodConfigError);
    expect(err.message).not.toContain("hunter2");
    expect(err.message).toContain("[redacted]");
    expect(err.stack ?? "").not.toContain("hunter2");
  });

  it("an API key echoed back in a 4xx body is redacted on the error", async () => {
    const secret = "mp_test_super_secret_key";
    const m = mockFetch([
      {
        status: 400,
        json: {
          error: "bad request",
          // A server (or a proxy, or a debug envelope) reflecting the request back at us.
          received: { headers: { authorization: `Bearer ${secret}` } },
          notes: [`token ${secret} rejected`],
        },
      },
    ]);
    const paylod = new Paylod({ apiKey: secret, fetch: m.fetch, allowCustomFetch: true, maxRetries: 0 });
    const err = (await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k" })
      .catch((e) => e)) as PaylodApiError;

    expect(err).toBeInstanceOf(PaylodApiError);
    const serialized = JSON.stringify(err.body);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted]");
    expect(err.message).not.toContain(secret);
  });

  it("the webhook secret is redacted from an echoed body too", async () => {
    const whsec = "whsec_top_secret_value";
    const m = mockFetch([{ status: 500, json: { error: "boom", debug: `secret=${whsec}` } }]);
    const paylod = new Paylod({
      apiKey: KEY,
      webhookSecret: whsec,
      fetch: m.fetch, allowCustomFetch: true,
      maxRetries: 0,
    });
    const err = (await paylod
      .collect({ amount: 1, phone: "0712345678", idempotencyKey: "k" })
      .catch((e) => e)) as PaylodApiError;
    expect(JSON.stringify(err.body)).not.toContain(whsec);
  });
});
