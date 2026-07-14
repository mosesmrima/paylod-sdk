/**
 * Error taxonomy.
 *
 * DESIGN RULE: a *payment* that fails (wrong PIN, cancelled, low balance) is NOT thrown —
 * it is an expected outcome, returned as `{ ok: false, error }` from `collectAndWait()`.
 * Everything in this file is a *programmer, transport, or indeterminate* problem: the kinds
 * of thing you genuinely want to blow up a request handler.
 */

import type { Payment } from "./types.js";

/** Base class — `err instanceof PaylodError` catches every error this SDK throws. */
export class PaylodError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Bad input caught locally, before any network call (invalid amount, unparseable phone). */
export class PaylodInvalidRequestError extends PaylodError {}

/** Configuration problem — e.g. no API key supplied and `PAYLOD_API_KEY` is unset. */
export class PaylodConfigError extends PaylodError {}

/** The API returned a non-2xx response. */
export class PaylodApiError extends PaylodError {
  /** HTTP status code. */
  readonly status: number;
  /** The parsed JSON body, when the response had one. */
  readonly body: unknown;
  /** `Idempotency-Key` sent with the offending request, if any — useful for support tickets. */
  readonly idempotencyKey?: string | undefined;

  constructor(
    message: string,
    status: number,
    body: unknown,
    idempotencyKey?: string | undefined,
  ) {
    super(message);
    this.status = status;
    this.body = body;
    this.idempotencyKey = idempotencyKey;
  }

  /** 401 — the API key is missing or invalid. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** 429 — you are being rate limited. Back off. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * 409 — the same `Idempotency-Key` was reused with a *different* body. This is always a
   * bug in your code (you changed the amount or phone but kept the key).
   */
  get isIdempotencyConflict(): boolean {
    return this.status === 409;
  }
}

/** The request could not be completed at the transport layer (DNS, TLS, socket, abort). */
export class PaylodConnectionError extends PaylodError {}

/**
 * `collectAndWait()` gave up before the payment reached a terminal state.
 *
 * This deliberately THROWS rather than returning `{ ok: false }`. A timeout is not a failed
 * payment — the customer may still be staring at the STK prompt, and may still pay. Folding
 * it into the failure branch would let a merchant cancel an order that is about to settle.
 * Handle it explicitly: keep the order pending and let the webhook settle it.
 */
export class PaylodTimeoutError extends PaylodError {
  readonly paymentId: string;
  /** The last `pending` snapshot we read before giving up. */
  readonly payment: Payment;
  readonly waitedMs: number;

  constructor(paymentId: string, payment: Payment, waitedMs: number) {
    super(
      `Payment ${paymentId} was still pending after ${Math.round(waitedMs / 1000)}s. ` +
        `It is NOT failed — the customer may still complete it. Leave the order pending and ` +
        `let the webhook (or a later paylod.status() call) settle it.`,
    );
    this.paymentId = paymentId;
    this.payment = payment;
    this.waitedMs = waitedMs;
  }
}

/** A webhook request could not be verified. Respond 400 and do not process the body. */
export class PaylodSignatureVerificationError extends PaylodError {
  readonly reason:
    | "missing_signature"
    | "malformed_signature"
    | "stale_timestamp"
    | "no_match"
    | "invalid_payload";

  constructor(reason: PaylodSignatureVerificationError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}
