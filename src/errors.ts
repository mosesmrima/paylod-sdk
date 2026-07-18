/**
 * Error taxonomy.
 *
 * DESIGN RULE: a *payment* that fails (wrong PIN, cancelled, low balance) is NOT thrown — it is
 * an expected business outcome, returned as a renderable `PaymentOutcome` from `collectAndWait()`
 * with `status: "failed"` and a customer-facing `message`.
 * Everything in this file is a *programmer, transport, or indeterminate* problem: the kinds
 * of thing you genuinely want to blow up a request handler.
 */

import type { Payment } from "./types.js";

/** Base class — `err instanceof PaylodError` catches every error this SDK throws. */
export class PaylodError extends Error {
  /**
   * The `Idempotency-Key` in effect when this error was raised, when one was.
   *
   * DECLARED here — not bolted on ad hoc — because it is the single most important field on a
   * failed money-moving call: it is what lets you retry the SAME attempt instead of minting a
   * fresh key and double-charging. The client attaches it to whatever error escapes a collect,
   * which can be any subclass (connection, timeout, API). Previously it was assigned as an
   * undeclared property, so it existed at runtime but was invisible to TypeScript: a consumer
   * writing `err.idempotencyKey` got a compile error and was pushed toward the unsafe path.
   *
   * Optional: errors raised before a key is chosen (config, validation) will not carry one.
   */
  idempotencyKey?: string | undefined;

  /**
   * The payment id in effect when this error was raised, when one was known.
   *
   * DECLARED alongside {@link idempotencyKey} because after an acknowledgement the two together
   * are the complete handle on a live charge: the key lets you replay the same attempt, and the
   * id lets you READ it. The sibling JVM SDK carried neither when a non-`Exception` `Error`
   * escaped after the ack, so a caller holding a charge that may already be settling had no way
   * to look it up and no safe way to retry.
   *
   * Optional: errors raised before a payment exists (config, validation, the collect call itself)
   * will not carry one.
   */
  paymentId?: string | undefined;

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

/**
 * A simulator call was made with a key that is not a sandbox (`mp_test_`) key.
 *
 * Thrown LOCALLY, before any request leaves the process — the key's own prefix is enough to know.
 * The backend refuses a live key too, but a "simulate" call that can even *attempt* to reach
 * production is a footgun; this makes it structurally impossible.
 *
 * It extends {@link PaylodConfigError} because that is what it is: the wrong credential, not a
 * transient failure. Retrying will never help.
 */
export class PaylodSandboxOnlyError extends PaylodConfigError {}

/** The API returned a non-2xx response. */
export class PaylodApiError extends PaylodError {
  /** HTTP status code. */
  readonly status: number;
  /** The parsed JSON body, when the response had one. */
  readonly body: unknown;
  /** `Idempotency-Key` sent with the offending request, if any — useful for support tickets. */
  override readonly idempotencyKey?: string | undefined;
  /**
   * `true` when the money state cannot be proven either way. Set for a malformed 2xx (a success
   * response with no `paymentId`): the charge may or may not have been raised, so this is a STOP
   * signal — read the status with {@link idempotencyKey}, do NOT blindly retry with a new key.
   */
  readonly indeterminate: boolean;

  constructor(
    message: string,
    status: number,
    body: unknown,
    idempotencyKey?: string | undefined,
    indeterminate = false,
  ) {
    super(message);
    this.status = status;
    this.body = body;
    this.idempotencyKey = idempotencyKey;
    this.indeterminate = indeterminate;
  }

  /** 401 — the API key is missing or invalid. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** 429 — you are being rate limited. Back off. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** Any 409. Every 409 on a money-moving route comes from the idempotency layer. */
  get isIdempotencyConflict(): boolean {
    return this.status === 409;
  }

  /**
   * `409` **indeterminate** — a previous request under this key died while the call to Daraja was
   * in flight, so it may or may not have moved money. paylod refuses to re-dispatch it: a timeout
   * is not evidence the money did not move, and for money at-most-once beats at-least-once.
   *
   * **This is a STOP signal, not a retry signal.** Read the payment status first
   * (`paylod.check(paymentId)`, `GET /status/:id`, or your webhook). If it settled, you are done.
   * If nothing happened, open a NEW attempt with a NEW key. Retrying under the spent key returns
   * this same `409` forever.
   */
  get isIdempotencyIndeterminate(): boolean {
    return this.status === 409 && /interrupted while the provider call was/i.test(this.message);
  }

  /**
   * `409` **in progress** — the first request under this key is still running. Honour
   * `Retry-After` and retry the *same* key: you will get the winner's answer. (For a plain
   * double-click the SDK usually never surfaces this — the duplicate simply waits.)
   */
  get isIdempotencyInProgress(): boolean {
    return this.status === 409 && /already in progress/i.test(this.message);
  }

  /**
   * `409` **body conflict** — the same `Idempotency-Key` was reused with a *different* body. This
   * is always a bug in your code (you changed the amount or the phone but kept the key): two
   * different charges collided on one key.
   */
  get isIdempotencyBodyConflict(): boolean {
    return (
      this.status === 409 && !this.isIdempotencyIndeterminate && !this.isIdempotencyInProgress
    );
  }
}

/** The request could not be completed at the transport layer (DNS, TLS, socket, abort). */
export class PaylodConnectionError extends PaylodError {}

/**
 * A CREDENTIAL-SAFETY violation was detected on a dispatch: the request was addressed off the
 * pinned origin, a redirect was returned, or the dispatch implementation FOLLOWED a redirect and
 * handed back a final response from somewhere else.
 *
 * ── Why this is its own class ─────────────────────────────────────────────────────────────
 * It extends {@link PaylodConnectionError} so existing `catch (e instanceof PaylodConnectionError)`
 * handlers keep working, but it is a distinct type for one reason: IT MUST NEVER BE RETRIED.
 *
 * These detections mean the bearer token may ALREADY have been replayed to another host. The
 * sibling JVM SDK raised exactly this condition as an ordinary connection error, its retry loop
 * caught it like any other network blip, and it re-sent the request — replaying a credential it
 * had just concluded was leaking, two more times. A retry cannot help here by construction: a
 * redirect or an off-origin response is a configuration fault or an attack, never a transient
 * one, so the second attempt goes to the same wrong place.
 *
 * The retry loop previously recognised this case by REGEX-MATCHING the error message. That worked,
 * but it made a money-and-credential-critical control depend on prose: any rewording of a message
 * — or the redactor rewriting part of one — silently turned the protection off with no test able
 * to notice. {@link terminal} is a structural fact about the error instead.
 */
export class PaylodTerminalTransportError extends PaylodConnectionError {
  /** Always `true`. Read by the retry loop; a terminal error is re-thrown, never re-dispatched. */
  readonly terminal = true;
}

export class PaylodSecurityError extends PaylodTerminalTransportError {}

/**
 * The response exceeded the byte or JSON-depth budget, so it was never fully read or parsed.
 *
 * This is INDETERMINATE, not a failure: the request reached paylod and may well have moved money —
 * we simply refused to buffer or walk the answer. Retrying re-sends the charge, so it is terminal,
 * and the escaping error carries the idempotency key and payment id so the caller can READ the
 * payment instead of guessing.
 *
 * The failure mode this closes is an OOM. A body with no size cap, or a JSON document nested
 * deeply enough to blow the parser's stack, kills the process AFTER the charge has been
 * dispatched — which is the single worst moment to lose the handle on it, because the key dies
 * with the process and the only record of the attempt is gone.
 */
export class PaylodResponseTooLargeError extends PaylodTerminalTransportError {}

/**
 * `collectAndWait()` gave up before the payment reached a terminal state.
 *
 * This deliberately THROWS rather than returning `status: "failed"`. A timeout is not a failed
 * payment — the customer may still be staring at the STK prompt, and may still pay. Folding
 * it into the failure branch would let a merchant cancel an order that is about to settle.
 * Handle it explicitly: keep the order pending and let the webhook settle it.
 */
export class PaylodTimeoutError extends PaylodError {
  /** Always set here: a timeout is only reachable once a payment exists to time out on. */
  override readonly paymentId: string;
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
    | "invalid_payload"
    /** A non-positive `toleranceSec` was used outside a fixed-clock test — replay protection would
     * have been silently disabled. Configure a positive tolerance in production. */
    | "insecure_tolerance";

  constructor(reason: PaylodSignatureVerificationError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}
