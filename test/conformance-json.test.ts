/**
 * SPEC 2.3, 2.6, 4.2, 5.4 — duplicate members, fatal decoding, leak-free diagnostics, and the
 * handles that must survive a refused acknowledgement.
 */
import { describe, expect, it } from "vitest";

import { decodeUtf8Strict, parseBounded } from "../src/json.js";
import { parseCollectAck } from "../src/validate.js";
import { PaylodApiError, PaylodResponseTooLargeError } from "../src/errors.js";

describe("spec 2.3 — duplicate money-critical members are REFUSED, not resolved", () => {
  /**
   * THE ROUND-10 High. Both spellings are individually canonical, so the per-lexeme rule passes
   * each one; only a duplicate rule catches this. Which copy wins is a parser detail, and a
   * money verdict must not depend on the SDK and the sender answering that the same way.
   */
  it("refuses two resultCode members whose values disagree", () => {
    expect(() => parseBounded('{"resultCode":1032,"resultCode":0}')).toThrow(
      PaylodResponseTooLargeError,
    );
    expect(() => parseBounded('{"resultCode":0,"resultCode":1032}')).toThrow(
      PaylodResponseTooLargeError,
    );
  });

  it("refuses duplicates even when the values AGREE — the rule is structural", () => {
    expect(() => parseBounded('{"resultCode":0,"resultCode":0}')).toThrow(
      PaylodResponseTooLargeError,
    );
  });

  it("refuses a duplicate hidden behind a \\u-escaped member name (spec 2.2)", () => {
    expect(() => parseBounded('{"resultCode":1032,"\\u0072esultCode":0}')).toThrow(
      PaylodResponseTooLargeError,
    );
  });

  it.each(["status", "mpesaReceipt", "id", "paymentId", "checkoutRequestId"])(
    "refuses a duplicate %s — not only numeric fields decide money",
    (key) => {
      expect(() => parseBounded(`{"${key}":"a","${key}":"b"}`)).toThrow(
        PaylodResponseTooLargeError,
      );
    },
  );

  /** CONTROLS. The rule must be scoped to one object, or it refuses ordinary bodies. */
  it("accepts the same member name in two DIFFERENT objects", () => {
    expect(() =>
      parseBounded('{"a":{"status":"success"},"b":{"status":"failed"}}'),
    ).not.toThrow();
  });

  it("accepts the same member name across array elements", () => {
    expect(() => parseBounded('[{"status":"success"},{"status":"failed"}]')).not.toThrow();
  });

  it("accepts an ordinary single-membered body", () => {
    expect(parseBounded('{"resultCode":0,"status":"success"}')).toEqual({
      resultCode: 0,
      status: "success",
    });
  });

  it("does not treat a STRING VALUE that looks like a key as a member", () => {
    // `"status"` here is a value, not a member name, so it must not populate the scope.
    expect(() => parseBounded('{"note":"status","status":"success"}')).not.toThrow();
  });
});

describe("spec 4.2 — a refusal reproduces no server-chosen bytes", () => {
  const CREDENTIAL = "mp_live_ABC123";

  /**
   * THE ROUND-10 High. The lexeme scan runs to the next `,}] ` or whitespace, so everything up
   * to that terminator is attacker-chosen text. Truncating to 32 characters bounded the leak but
   * did not remove it: a credential shorter than the bound fits inside it.
   */
  it("does NOT echo a credential embedded in a non-canonical numeric lexeme", () => {
    const body = `{"resultCode":0.0${CREDENTIAL}}`;
    const err = (() => {
      try {
        parseBounded(body);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(PaylodResponseTooLargeError);
    expect(err?.message).not.toContain(CREDENTIAL);
    expect(err?.message).not.toContain("mp_live_");
    // The whole stack, not just the message — a reporter serialises both.
    expect(String(err?.stack ?? "")).not.toContain(CREDENTIAL);
  });

  it("names the SHAPE instead, so the diagnostic is still actionable", () => {
    expect(() => parseBounded('{"resultCode":1032.0}')).toThrow(/fractional form/);
    expect(() => parseBounded('{"resultCode":1.032e3}')).toThrow(/fractional form/);
    expect(() => parseBounded('{"resultCode":-0}')).toThrow(/signed form/);
    expect(() => parseBounded('{"resultCode":00}')).toThrow(/zero-padded form/);
  });

  it("does not echo an escaped member name back either", () => {
    const err = (() => {
      try {
        parseBounded('{"\\u0072esultCode":0.0}');
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    // The MATCHED CONSTANT is rendered, never the bytes that matched it.
    expect(err?.message).toContain("resultcode");
    expect(err?.message).not.toContain("\\u0072");
  });

  it("still refuses the laundered spellings it always refused — the control", () => {
    expect(() => parseBounded('{"resultCode":0.0}')).toThrow(PaylodResponseTooLargeError);
    expect(() => parseBounded('{"resultCode":0e999}')).toThrow(PaylodResponseTooLargeError);
    expect(parseBounded('{"resultCode":1032}')).toEqual({ resultCode: 1032 });
  });
});

describe("spec 2.6 — invalid UTF-8 is refused, never normalised", () => {
  it("refuses a lone continuation byte rather than yielding U+FFFD", () => {
    const bad = new Uint8Array([0x7b, 0x80, 0x7d]);
    expect(() => decodeUtf8Strict(bad, "the body")).toThrow(PaylodResponseTooLargeError);
    expect(() => decodeUtf8Strict(bad, "the body")).toThrow(/not valid UTF-8/);
  });

  /**
   * THE DISCRIMINATING CASE (spec 8.5). Replacement semantics map these two DIFFERENT payment
   * ids onto the same string, so a correlation that must fail would instead succeed against the
   * wrong payment. The lossy decoder is shown collapsing them, then the strict one refusing.
   */
  it("does not let two distinct invalid byte sequences collapse into one string", () => {
    const a = new Uint8Array([...Buffer.from('{"id":"pay_'), 0x80, ...Buffer.from('"}')]);
    const b = new Uint8Array([...Buffer.from('{"id":"pay_'), 0x81, ...Buffer.from('"}')]);

    // The behaviour being forbidden: a replacement decode makes these identical.
    const lossy = new TextDecoder();
    expect(lossy.decode(a)).toBe(lossy.decode(b));

    // The behaviour required: neither is accepted at all.
    expect(() => decodeUtf8Strict(a, "the body")).toThrow(PaylodResponseTooLargeError);
    expect(() => decodeUtf8Strict(b, "the body")).toThrow(PaylodResponseTooLargeError);
  });

  it("decodes valid UTF-8 unchanged, multibyte included — the control", () => {
    const ok = new TextEncoder().encode('{"desc":"aké — 日本"}');
    expect(decodeUtf8Strict(ok, "the body")).toBe('{"desc":"aké — 日本"}');
  });

  it("names no bytes in its refusal", () => {
    const secret = "whsec_SHORT1";
    const bad = new Uint8Array([...Buffer.from(secret), 0x80]);
    const err = (() => {
      try {
        decodeUtf8Strict(bad, "the body");
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain(secret);
  });
});

describe("spec 5.4 — a refused acknowledgement keeps BOTH handles", () => {
  const grab = (body: unknown, httpStatus = 202): PaylodApiError => {
    try {
      parseCollectAck(body, { httpStatus, idempotencyKey: "key-abc" });
      throw new Error("expected a refusal");
    } catch (e) {
      return e as PaylodApiError;
    }
  };

  /**
   * THE ROUND-10 High. The charge was acknowledged, so it may be live; the body is malformed, so
   * it is refused. Refusing it used to discard a perfectly well-formed `paymentId` too, leaving
   * the caller told to "read the payment" with no handle to read it by.
   */
  it("carries the payment id off a malformed 202 that still has a usable one", () => {
    const err = grab({ paymentId: "pay_123", status: "settled" });
    expect(err.indeterminate).toBe(true);
    expect(err.idempotencyKey).toBe("key-abc");
    expect(err.paymentId).toBe("pay_123");
  });

  it("carries both when checkoutRequestId is the missing field", () => {
    const err = grab({ paymentId: "pay_123", status: "pending" });
    expect(err.idempotencyKey).toBe("key-abc");
    expect(err.paymentId).toBe("pay_123");
  });

  it("carries both when the ack arrives on the wrong 2xx", () => {
    const err = grab({ paymentId: "pay_123", checkoutRequestId: "ws_1", status: "pending" }, 200);
    expect(err.idempotencyKey).toBe("key-abc");
    expect(err.paymentId).toBe("pay_123");
  });

  /** It is SALVAGED under the same rules that would let it be returned — never laundered. */
  it("does NOT attach a placeholder payment id", () => {
    const err = grab({ paymentId: "[redacted]", status: "settled" });
    expect(err.idempotencyKey).toBe("key-abc");
    expect(err.paymentId).toBeUndefined();
  });

  it("does NOT attach a payment id carrying this client's own credential", () => {
    const secret = "mp_live_ECHOED";
    try {
      parseCollectAck(
        { paymentId: secret, status: "settled" },
        { httpStatus: 202, idempotencyKey: "key-abc", secrets: [secret] },
      );
      throw new Error("expected a refusal");
    } catch (e) {
      const err = e as PaylodApiError;
      expect(err.paymentId).toBeUndefined();
      expect(err.message).not.toContain(secret);
    }
  });

  it("keeps the key when there is no payment id to salvage — the control", () => {
    const err = grab({ status: "settled" });
    expect(err.idempotencyKey).toBe("key-abc");
    expect(err.paymentId).toBeUndefined();
  });
});
