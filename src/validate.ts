/**
 * The validators that guard money.
 *
 * These live in their own module for one structural reason: EVERY surface that can create or read
 * a payment must run the SAME checks. When the simulator carried its own hand-rolled copy of the
 * idempotency-key rule, it accepted keys production rejects — so a test proving "a double-click
 * cannot charge twice" could go green against a simulator that was quietly weaker than the thing
 * it stands in for. A validator that only some callers use is not a validator.
 *
 * Nothing here imports the client, so both `client.ts` and `simulate.ts` can depend on it.
 */

import { PaylodApiError, PaylodInvalidRequestError } from "./errors.js";
import type { PaymentStatus } from "./types.js";

/**
 * Reject an idempotency key that would silently drop double-charge protection: blank/whitespace
 * keys, keys carrying control characters (which also cannot go in an HTTP header), and absurdly
 * long values. A caller-supplied key is the ONE thing standing between a double-click and a
 * double-charge, so a bad one must fail loudly rather than be quietly accepted.
 *
 * @param what The calling surface, so the message names the actual method the developer called.
 */
export function assertValidIdempotencyKey(key: string, what = "idempotencyKey"): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw new PaylodInvalidRequestError(
      `${what} must be a non-empty, non-whitespace string — a blank key silently drops ` +
        "double-charge protection.",
    );
  }
  // The COMPLETE Unicode control set - C0 (U+0000-U+001F), DEL (U+007F) and C1 (U+0080-U+009F).
  // C1 was the hole: U+0085 (NEL) is a line terminator that several proxies and header parsers
  // fold into a newline, so it is a header-injection vector the old C0+DEL check waved through.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(key)) {
    throw new PaylodInvalidRequestError(
      `${what} must not contain control characters (tabs, newlines, NULs, C1 controls).`,
    );
  }
  // Unicode-only whitespace, plus the zero-width / BOM formatting characters. `key.trim()` above
  // does not catch these in the MIDDLE of a key, and they are invisible: two keys that look
  // identical in a log but differ by one U+00A0 are two different keys - i.e. one double charge.
  if (/[\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/.test(key)) {
    throw new PaylodInvalidRequestError(
      `${what} must not contain Unicode whitespace or zero-width characters - they are ` +
        "invisible in logs, so two visually identical keys can silently be different keys.",
    );
  }
  // Bound the BYTE length, not the UTF-16 code-unit count: the key goes out as bytes in a header,
  // and 255 astral characters is 1020 bytes on the wire.
  if (Buffer.byteLength(key, "utf8") > 255) {
    throw new PaylodInvalidRequestError(`${what} must be 255 bytes or fewer (UTF-8).`);
  }
  // Printable ASCII only (0x20-0x7E). HTTP header values are ASCII on the wire (RFC 9110), so a
  // non-ASCII key -- "ordr-café-1", a customer name, an emoji -- either dies as an unactionable
  // transport-level encoding crash, or, on a laxer stack, is SILENTLY re-encoded. The second case
  // is the dangerous one: two requests meant to share one key stop sharing it, which quietly
  // removes the duplicate-charge guard that is the entire purpose of this header.
  if (!/^[\x20-\x7e]+$/.test(key)) {
    throw new PaylodInvalidRequestError(
      `${what} must be printable ASCII (0x20-0x7E). HTTP header values are ASCII on the ` +
        "wire, so a non-ASCII key can be silently re-encoded in transit -- two requests meant to " +
        "share one key would stop sharing it and the customer would be charged twice. Use an " +
        "opaque id (a UUID or your attempt's primary key), not customer- or product-derived text.",
    );
  }
}

/**
 * A duration option must be a finite whole number of milliseconds, greater than zero.
 *
 * A fractional, `NaN` or `Infinity` timeout is not a slow timeout — it is a BROKEN one.
 * `setTimeout(NaN)` fires immediately (so every request aborts instantly and a live charge looks
 * like a transport failure), and `setTimeout(Infinity)` also clamps to fire immediately. Both
 * shapes therefore turn a config typo into a payment that appears to fail while the money moves.
 * Reject them at the boundary rather than discover them mid-charge.
 */
export function assertWholePositiveMs(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new PaylodInvalidRequestError(
      `${name} must be a whole positive number of milliseconds (got ${String(value)}). ` +
        "A fractional, NaN or Infinity timeout does not mean 'no timeout' — setTimeout clamps " +
        "both NaN and Infinity to fire immediately, so every request would abort at once and a " +
        "charge that is actually in flight would look like a transport failure.",
    );
  }
  return value;
}

/** Retry counts follow the same rule, except that zero (no retries) is legitimate. */
export function assertWholeNonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new PaylodInvalidRequestError(
      `${name} must be a whole number >= 0 (got ${String(value)}).`,
    );
  }
  return value;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

const PAYMENT_STATUSES: readonly string[] = ["pending", "success", "failed"];

/**
 * Validate the COMPLETE `POST /collect` acknowledgement, not just its `paymentId`.
 *
 * Every field here is load-bearing, so a partial check is a false sense of safety: a 2xx with a
 * `paymentId` but no `checkoutRequestId`, or with `status: "success"` on an ack that can only ever
 * be `pending`, is a response this SDK does not understand. When we do not understand the answer
 * to a charge request, the money state is INDETERMINATE — the charge may well have been raised —
 * so it must be surfaced as a stop-and-read signal carrying the key, never handed back as a
 * half-populated ack that a caller would treat as a healthy new payment.
 */
export function assertCollectAckShape(
  parsed: unknown,
  httpStatus: number,
  idempotencyKey: string,
  what = "paylod",
): void {
  const indeterminate = (detail: string): never => {
    throw new PaylodApiError(
      `${what} returned a 2xx response that is not a valid collect acknowledgement (${detail}) — ` +
        "the charge state is INDETERMINATE. Read the payment with this idempotencyKey before " +
        "starting any new attempt; do NOT mint a fresh key (that risks a second charge).",
      httpStatus,
      parsed,
      idempotencyKey,
      true,
    );
  };

  if (parsed === null || typeof parsed !== "object") return indeterminate("the body is not an object");
  const ack = parsed as Record<string, unknown>;

  if (!nonEmptyString(ack.paymentId)) return indeterminate("no paymentId");
  if (!nonEmptyString(ack.checkoutRequestId)) return indeterminate("no checkoutRequestId");
  // `status` is a HARDCODED LITERAL "pending" on the backend, present on every 202 — including an
  // idempotent REPLAY, which returns the stored original ack rather than the current settled
  // state. So there is no legitimate ack carrying a settled status, and no legitimate ack missing
  // the field either: both are malformed, and requiring the literal cannot break replay.
  //
  // Note the asymmetry with a STATUS read, which legitimately carries terminal states. There,
  // `success` is not trusted from the string — it must be backed by a receipt or result code 0.
  if (ack.status !== "pending") {
    return indeterminate(`status was ${JSON.stringify(ack.status)}, expected the literal "pending"`);
  }
}

/**
 * Validate a `GET /status/:id` body.
 *
 * A malformed status read is not a cosmetic problem. Reporting a payment on the strength of a body
 * whose `status` field we cannot even place in the known set is how a merchant fulfils an order
 * that was never paid, so an unrecognised shape is raised as an INDETERMINATE error rather than
 * coerced into a `Payment`.
 */
export function assertPaymentShape(parsed: unknown, httpStatus: number): void {
  const bad = (detail: string): never => {
    throw new PaylodApiError(
      `paylod returned a 2xx status body this SDK cannot read (${detail}). The payment state is ` +
        "INDETERMINATE — do not treat it as either paid or failed; read it again or let the " +
        "webhook settle it.",
      httpStatus,
      parsed,
      undefined,
      true,
    );
  };

  if (parsed === null || typeof parsed !== "object") return bad("the body is not an object");
  const p = parsed as Record<string, unknown>;
  if (!nonEmptyString(p.id)) return bad("no payment id");
  if (typeof p.status !== "string" || !PAYMENT_STATUSES.includes(p.status)) {
    return bad(`status was ${JSON.stringify(p.status)}, not one of ${PAYMENT_STATUSES.join("/")}`);
  }
  if (p.mpesaReceipt !== undefined && p.mpesaReceipt !== null && typeof p.mpesaReceipt !== "string") {
    return bad("mpesaReceipt is neither a string nor null");
  }
  if (
    p.resultCode !== undefined &&
    p.resultCode !== null &&
    typeof p.resultCode !== "number" &&
    typeof p.resultCode !== "string"
  ) {
    return bad("resultCode is neither a number/string nor null");
  }
}

/** Narrow a validated body to the `PaymentStatus` union without an unchecked cast at the call site. */
export function asPaymentStatus(v: unknown): PaymentStatus {
  return v as PaymentStatus;
}
