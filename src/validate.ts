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
  // Printable ASCII, SPACE EXCLUDED (0x21-0x7E). HTTP header values are ASCII on the wire
  // (RFC 9110), so a non-ASCII key -- "ordr-café-1", a customer name, an emoji -- either dies as
  // an unactionable transport-level encoding crash, or, on a laxer stack, is SILENTLY re-encoded.
  // The second case is the dangerous one: two requests meant to share one key stop sharing it,
  // which quietly removes the duplicate-charge guard that is the entire purpose of this header.
  //
  // SPACE is excluded for a sharper reason than tidiness, and the old 0x20 floor admitted it.
  // RFC 9110 surrounds a header field value with optional whitespace that the recipient MUST
  // strip, so " k", "k " and "k" are the SAME key to a conforming server but three DIFFERENT
  // strings in your database. That collapses in one direction and diverges in the other: a retry
  // that reads a stored " k" back and re-sends it is no longer replaying the same attempt as far
  // as your records are concerned, and a genuine duplicate can stop being recognised as one. An
  // idempotency key is an opaque id -- a UUID, an attempt's primary key -- and no such id needs
  // a space in it, so the whole class is removed rather than reasoned about per-stack.
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new PaylodInvalidRequestError(
      `${what} must be printable ASCII with no spaces (0x21-0x7E). HTTP header values are ` +
        "ASCII on the wire and are whitespace-trimmed by the recipient, so a key containing a " +
        "space can arrive as a DIFFERENT key than the one you stored -- and a retry that no " +
        "longer matches the original attempt charges the customer a second time. A non-ASCII " +
        "key can be silently re-encoded in transit for the same net effect. Use an opaque id " +
        "(a UUID or your attempt's primary key), not customer- or product-derived text.",
    );
  }
}

/**
 * Upper bounds for duration and count options.
 *
 * A lower bound alone is not validation. `timeoutMs: 1e20` passed every check the previous
 * version made — it is a finite, whole, positive number — and then behaved as the OPPOSITE of
 * what it reads like: `setTimeout` clamps any delay above 2^31-1 ms to fire IMMEDIATELY, so the
 * value that looks like "wait essentially forever" actually meant "abort at once". That turns a
 * config typo (a units mix-up, a bad env var, seconds-vs-milliseconds) into a live charge that
 * looks like a transport failure — the precise failure mode the lower bound exists to prevent.
 * Both ends of the range must be checked, and the ceiling must sit well below the 32-bit clamp.
 *
 * 10 minutes is far longer than any paylod call legitimately needs: an STK prompt expires on the
 * handset in about 60 seconds, and `wait()` defaults to 120s.
 */
export const MAX_TIMEOUT_MS = 600_000;

/**
 * Beyond a handful, retries stop being resilience and become a self-inflicted outage — and
 * against a money endpoint, a very long retry chain is also a long window in which the caller
 * has no answer about a charge that may already be live.
 */
export const MAX_RETRIES = 10;

/**
 * A duration option must be a finite whole number of milliseconds, greater than zero and no more
 * than {@link MAX_TIMEOUT_MS}.
 *
 * A fractional, `NaN` or `Infinity` timeout is not a slow timeout — it is a BROKEN one.
 * `setTimeout(NaN)` fires immediately (so every request aborts instantly and a live charge looks
 * like a transport failure), and `setTimeout(Infinity)` — and anything above 2^31-1 ms — clamps
 * to fire immediately too. All of those shapes turn a config typo into a payment that appears to
 * fail while the money moves. Reject them at the boundary rather than discover them mid-charge.
 */
export function assertWholePositiveMs(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new PaylodInvalidRequestError(
      `${name} must be a whole number of milliseconds between 1 and ${MAX_TIMEOUT_MS} ` +
        `(got ${String(value)}). A fractional, NaN or Infinity timeout does not mean 'no ` +
        "timeout' — setTimeout clamps NaN, Infinity and anything above 2^31-1 ms to fire " +
        "IMMEDIATELY, so every request would abort at once and a charge that is actually in " +
        "flight would look like a transport failure.",
    );
  }
  return value;
}

/** Retry counts follow the same rule, except that zero (no retries) is legitimate. */
export function assertWholeNonNegative(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_RETRIES
  ) {
    throw new PaylodInvalidRequestError(
      `${name} must be a whole number between 0 and ${MAX_RETRIES} (got ${String(value)}).`,
    );
  }
  return value;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export const PAYMENT_STATUSES: readonly string[] = ["pending", "success", "failed"];

/** How a validator renders a body into an error without leaking the API key. */
export type BodyRedactor = (body: unknown) => unknown;

const identity: BodyRedactor = (b) => b;

/** How a validator renders a MESSAGE without leaking the API key. Defaults to no-op. */
export type TextRedactor = (text: string) => string;

const identityText: TextRedactor = (t) => t;

/**
 * THE one sanitizer every SDK error message runs attacker-controlled values through.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────────
 * The malformed-2xx validators quoted the offending value back for diagnostic value — `status was
 * "settled"`, `the body describes payment "pay_9"`. Those values come from the RESPONSE, which is
 * exactly the thing being distrusted. A body whose `status` field, or whose mismatched `id`, is
 * set to the bearer key put that key verbatim into the exception message and into its stack —
 * which is then logged, shipped to an error reporter, and rendered in a dashboard. The `body`
 * field on the error was carefully deep-redacted; the MESSAGE beside it was not, so the redaction
 * protected the field nobody reads and missed the one everybody does.
 *
 * Three things happen here, in order:
 *   1. the value is rendered as JSON, so a hostile object cannot run its own `toString`;
 *   2. it is TRUNCATED, so a megabyte of response cannot become a megabyte of log line;
 *   3. it is passed through the caller's key/secret redactor — the same one the body gets.
 *
 * Truncation before redaction would be wrong (a key split across the cut would survive), so the
 * redactor runs last.
 */
export function sanitizeForMessage(value: unknown, redactText: TextRedactor = identityText): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = "[unrenderable]";
  }
  const redacted = redactText(rendered);
  return redacted.length > 80 ? `${redacted.slice(0, 80)}…` : redacted;
}

/**
 * Validate the COMPLETE `POST /collect` acknowledgement — including its HTTP STATUS.
 *
 * Every field here is load-bearing, so a partial check is a false sense of safety: a 2xx with a
 * `paymentId` but no `checkoutRequestId`, or with `status: "success"` on an ack that can only ever
 * be `pending`, is a response this SDK does not understand. When we do not understand the answer
 * to a charge request, the money state is INDETERMINATE — the charge may well have been raised —
 * so it must be surfaced as a stop-and-read signal carrying the key, never handed back as a
 * half-populated ack that a caller would treat as a healthy new payment.
 */
export function assertCollectAck(
  parsed: unknown,
  opts: {
    readonly httpStatus: number;
    readonly idempotencyKey: string;
    readonly what?: string;
    readonly redactBody?: BodyRedactor;
    /** Redacts the API key/secret out of any text interpolated into the message. */
    readonly redactText?: TextRedactor;
  },
): void {
  const what = opts.what ?? "paylod";
  const redactBody = opts.redactBody ?? identity;
  const safe = (v: unknown) => sanitizeForMessage(v, opts.redactText ?? identityText);
  const indeterminate = (detail: string): never => {
    throw new PaylodApiError(
      `${what} returned a response that is not a valid collect acknowledgement (${detail}) — ` +
        "the charge state is INDETERMINATE. Read the payment with this idempotencyKey before " +
        "starting any new attempt; do NOT mint a fresh key (that risks a second charge).",
      opts.httpStatus,
      // The body goes through the SAME deep redaction the client applies to a non-2xx body.
      // `PaylodApiError.body` is the field people log wholesale in an error handler, and an API
      // that echoes the request back (a validation error quoting the offending headers, a debug
      // envelope, a proxy's error page) would otherwise carry the bearer key straight into the
      // error object and from there into every log sink downstream. Storing the RAW parsed body
      // here bypassed the redaction the rest of the client is careful to apply.
      redactBody(parsed),
      opts.idempotencyKey,
      true,
    );
  };

  // THE STATUS IS PART OF THE CONTRACT. `POST /collect` answers 202 Accepted and nothing else:
  // the STK push has been handed to Daraja and the payment is pending. Accepting ANY 2xx meant a
  // bare `200` — the shape a cache, a proxy, a captive portal, a stubbed endpoint or a rewritten
  // route produces — was read as a successfully dispatched charge. A 200 here is not a successful
  // collect; it is a response from something that is not the collect endpoint, and treating it as
  // an ack invents a payment that may not exist (or hides one that does).
  if (opts.httpStatus !== 202) {
    return indeterminate(
      `HTTP ${opts.httpStatus}, expected 202 Accepted — a collect that was genuinely dispatched ` +
        "always answers 202",
    );
  }

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
    return indeterminate(`status was ${safe(ack.status)}, expected the literal "pending"`);
  }
}

/**
 * Validate a `GET /status/:id` body, and BIND it to the payment that was asked for.
 *
 * A malformed status read is not a cosmetic problem. Reporting a payment on the strength of a body
 * whose `status` field we cannot even place in the known set is how a merchant fulfils an order
 * that was never paid, so an unrecognised shape is raised as an INDETERMINATE error rather than
 * coerced into a `Payment`.
 *
 * ── The binding check ─────────────────────────────────────────────────────────────────────
 * This is the highest-value single check in the SDK. Nothing previously compared the `id` in the
 * response to the id in the request, so ANY mechanism that returned a DIFFERENT payment's record
 * — a cache keyed on the wrong thing, a proxy collapsing concurrent requests, an off-by-one in a
 * routing or authorization layer, a server-side bug, a deliberately crafted response — produced a
 * body the SDK validated happily and then classified on its own merits. If that other payment
 * happened to be settled and paid, the caller was told THEIR payment was paid, and shipped goods
 * for an order nobody had paid for.
 *
 * A response that answers a different question is not a MALFORMED response, it is a WRONG one,
 * and no amount of field-level shape checking can find it — every field is perfectly valid. The
 * request knows which payment it asked about; the answer has to say the same thing, or it is not
 * an answer at all.
 *
 * A mismatch is INDETERMINATE rather than a plain error because that is the honest reading: we
 * now know nothing about the payment we asked about. "I do not know" must never collapse to
 * "failed" (reported as retryable, so the customer is charged twice) or to "paid".
 */
export function assertPaymentBody(
  parsed: unknown,
  opts: {
    readonly httpStatus: number;
    /** The id that was REQUESTED. The body must agree with it. */
    readonly expectedId: string;
    readonly what?: string;
    readonly redactBody?: BodyRedactor;
    /** Redacts the API key/secret out of any text interpolated into the message. */
    readonly redactText?: TextRedactor;
  },
): void {
  const what = opts.what ?? "paylod";
  const redactBody = opts.redactBody ?? identity;
  const safe = (v: unknown) => sanitizeForMessage(v, opts.redactText ?? identityText);
  const bad = (detail: string): never => {
    throw new PaylodApiError(
      `${what} returned a status body this SDK cannot trust (${detail}). The payment state is ` +
        "INDETERMINATE — do not treat it as either paid or failed; read it again or let the " +
        "webhook settle it.",
      opts.httpStatus,
      redactBody(parsed),
      undefined,
      true,
    );
  };

  if (parsed === null || typeof parsed !== "object") return bad("the body is not an object");
  const p = parsed as Record<string, unknown>;
  if (!nonEmptyString(p.id)) return bad("no payment id");

  // ID BINDING. Checked before anything else about the record's CONTENTS, because if this fails
  // then every remaining field describes some other payment and reasoning about them is not just
  // useless but actively misleading.
  if (p.id !== opts.expectedId) {
    return bad(
      `the body describes payment ${safe(p.id)} but ${safe(opts.expectedId)} was requested — ` +
        "this response answers a different question, so it tells you NOTHING about the payment " +
        "you asked about",
    );
  }

  if (typeof p.status !== "string" || !PAYMENT_STATUSES.includes(p.status)) {
    return bad(`status was ${safe(p.status)}, not one of ${PAYMENT_STATUSES.join("/")}`);
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

  // `resultDesc` was the one field on the record nothing checked, and it is not inert: it is a
  // CORROBORATING SIGNAL the classifier reads (a "still processing" phrasing can outrank an
  // uncatalogued code), so it is as load-bearing as `resultCode`. An object-valued `resultDesc`
  // passed this validator, reached `classifyStkResult`, and threw a raw `TypeError` out of
  // `.trim()` — so `check()` and `wait()` died with a stack trace from the middle of the SDK
  // instead of raising the indeterminate-response error the caller knows how to handle. A crash
  // is not a safe failure here: it happens AFTER a charge may have been raised, and it is not a
  // shape any `catch (e instanceof PaylodError)` recovers from.
  if (p.resultDesc !== undefined && p.resultDesc !== null && typeof p.resultDesc !== "string") {
    return bad("resultDesc is neither a string nor null");
  }
}

/** Narrow a validated body to the `PaymentStatus` union without an unchecked cast at the call site. */
export function asPaymentStatus(v: unknown): PaymentStatus {
  return v as PaymentStatus;
}
