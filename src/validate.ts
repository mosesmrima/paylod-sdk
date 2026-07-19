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

import { randomUUID } from "node:crypto";

import { PaylodApiError, PaylodInvalidRequestError } from "./errors.js";
import { MAX_JSON_DEPTH } from "./json.js";
import type { CollectAckWire, Payment, PaymentStatus, WireResultCode } from "./types.js";

/**
 * The largest amount paylod will move in one payment, in KES.
 *
 * It lives HERE, with the other validators, because three surfaces need the same ceiling —
 * `collect()`, the simulator, and the webhook schema — and a ceiling that only some of them
 * apply is not a ceiling. The simulator carried no amount ceiling at all, so a test could prove
 * "we charge 10,000,000 KES successfully" against a simulator that accepted a figure production
 * refuses at the boundary.
 */
export const MAX_AMOUNT = 150_000;

/** `accountReference` is 1-12 chars on the wire; `description` is 1-64. */
export const MAX_ACCOUNT_REFERENCE_LEN = 12;
export const MAX_DESCRIPTION_LEN = 64;

/**
 * THE amount rule, for every surface that dispatches a charge.
 *
 * M-Pesa moves whole Kenyan shillings. A decimal is rejected by Daraja, a non-positive figure is
 * not a payment, and anything above the ceiling could never have been charged.
 */
export function assertChargeAmount(amount: unknown, what: string): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new PaylodInvalidRequestError(`${what}: amount must be a number (whole KES).`);
  }
  if (!Number.isInteger(amount)) {
    throw new PaylodInvalidRequestError(
      `${what}: amount must be a whole number of KES — M-Pesa rejects decimals (got ${amount}).`,
    );
  }
  if (amount <= 0 || amount > MAX_AMOUNT) {
    throw new PaylodInvalidRequestError(
      `${what}: amount must be between 1 and ${MAX_AMOUNT} KES (got ${amount}).`,
    );
  }
  return amount;
}

/** THE `accountReference` rule. Shared so the simulator cannot accept a reference production rejects. */
export function assertAccountReference(value: unknown, what: string): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new PaylodInvalidRequestError(`${what}: accountReference must be a string.`);
  }
  if (value.trim().length > MAX_ACCOUNT_REFERENCE_LEN) {
    throw new PaylodInvalidRequestError(
      `${what}: accountReference must be ${MAX_ACCOUNT_REFERENCE_LEN} characters or fewer.`,
    );
  }
}

/** THE `description` rule, shared for the same reason. */
export function assertDescription(value: unknown, what: string): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new PaylodInvalidRequestError(`${what}: description must be a string.`);
  }
  if (value.trim().length > MAX_DESCRIPTION_LEN) {
    throw new PaylodInvalidRequestError(
      `${what}: description must be ${MAX_DESCRIPTION_LEN} characters or fewer.`,
    );
  }
}

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
 * THE DOUBLE-CHARGE GUARD, resolved before a single byte leaves the process.
 *
 * A GENERATED KEY IS NOT IDEMPOTENCY. It is a fresh value on every invocation, so it collapses
 * exactly nothing: a double-clicked Pay button, a refreshed tab, a redelivered queue job and a
 * process restart mid-request each mint a NEW key and each raise a SEPARATE charge. The previous
 * behaviour — generate one, warn ONCE per process — meant the protection was OFF by default and
 * the warning was invisible in every production posture that matters (the second charge the
 * worker handles, a log nobody reads, a `console.warn` swallowed by a logging shim). The one
 * party that knows a retry is a retry is the caller, and a key minted inside the call cannot
 * survive one by construction.
 *
 * So the key is REQUIRED. The only way to a generated one is to say so in the call itself, and it
 * still warns EVERY time. Naming and semantics match the PHP SDK's `unsafeGeneratedIdempotencyKey`
 * and the Python SDK's `unsafe_generated_idempotency_key`.
 *
 * @param what The calling surface, so the message names the actual method the developer called.
 */
export function resolveIdempotencyKey(
  idempotencyKey: string | undefined,
  unsafeGenerated: boolean | undefined,
  what: string,
): string {
  if (idempotencyKey !== undefined) {
    // A caller-supplied key is the double-charge guard — reject a blank/whitespace/control-char
    // one loudly rather than silently drop protection.
    assertValidIdempotencyKey(idempotencyKey, `${what}: idempotencyKey`);
    return idempotencyKey;
  }

  // `!== true` and not a truthy test: `unsafeGeneratedIdempotencyKey: "false"` — what reading an
  // env var gives you — must not open the unsafe path. Failing CLOSED here costs a clear error;
  // failing open costs a customer a second charge.
  if (unsafeGenerated !== true) {
    throw new PaylodInvalidRequestError(
      `${what} requires an \`idempotencyKey\`. Mint ONE KEY PER PAYMENT ATTEMPT — an id you ` +
        "create when the customer presses Pay and PERSIST on that attempt — and pass it here. " +
        "Without it this charge has no double-charge protection at all: a double-clicked button, " +
        "a refreshed tab, a redelivered job or a process restart will fire a SECOND STK prompt " +
        "and can charge your customer twice. A key the SDK generates for you is not idempotency " +
        "— it is a different value on every call, so it collapses nothing.\n" +
        "             const attempt = await db.attempts.create({ orderId: order.id });\n" +
        "             await paylod.collectAndWait({ phone, amount, idempotencyKey: attempt.id });\n" +
        "         Do NOT key on the order or the product. An order id is stable but never fresh: " +
        "a retry after a wrong PIN replays the FAILED attempt, so that order can never be paid. " +
        "A product id is worse — every customer after the first replays the first-ever payment. " +
        "And `crypto.randomUUID()` at the call site is exactly equivalent to passing nothing.\n" +
        "         If you genuinely want an unprotected charge (a scratch script, never " +
        "production), pass `unsafeGeneratedIdempotencyKey: true` and accept that this call can " +
        "double-charge. https://paylod.dev/docs/sdk#idempotency",
    );
  }

  warnUnsafeGeneratedIdempotencyKey(what);
  return randomUUID();
}

/**
 * Warn on EVERY unprotected charge — never once per process, never once per call site.
 *
 * The old module-level `warnedMissingIdempotencyKey` flag meant a worker that handled a thousand
 * unprotected charges warned about the FIRST one and stayed silent for the other 999, which is
 * the exact scenario — a charge fired in a loop or a job handler — that the warning exists to
 * flag. Each unprotected charge is a SEPARATE opportunity to double-charge a customer, so each
 * one is announced.
 *
 * `console.warn` deliberately, NOT `process.emitWarning`. `emitWarning` routes through Node's
 * warning machinery, which the default handler silences wholesale under `--no-warnings` or
 * `NODE_OPTIONS=--no-warnings` and de-duplicates by code on the deprecation path — every one of
 * those is a way for this warning to vanish in exactly the production posture where it matters.
 * `console.warn` has no dedup and no global mute switch.
 */
function warnUnsafeGeneratedIdempotencyKey(what: string): void {
  console.warn(
    `[paylod] ${what} was called with unsafeGeneratedIdempotencyKey: true, so this charge is ` +
      "NOT protected against being sent twice.\n" +
      "         The SDK generated a key, and a generated key is not idempotency: it is a " +
      "different value on every call, so it collapses nothing. A double-clicked Pay button, a " +
      "refreshed tab, or a redelivered job will fire a SECOND STK prompt and can charge your " +
      "customer twice.\n" +
      "         Pass ONE KEY PER PAYMENT ATTEMPT — an id you mint when the customer presses Pay, " +
      "and persist on that attempt:\n" +
      "             const attempt = await db.attempts.create({ orderId: order.id });\n" +
      "             await paylod.collectAndWait({ phone, amount, idempotencyKey: attempt.id });\n" +
      "         This warning fires on EVERY such call, by design — each one is a separate " +
      "chance to charge a customer twice. https://paylod.dev/docs/sdk#idempotency",
  );
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
 * DEEP CREDENTIAL SCAN over a server-controlled value.
 *
 * ── Why a successful response is scanned at all ───────────────────────────────────────────
 * Every non-2xx path in this SDK is careful: the message is redacted, the body is deep-redacted,
 * and the bearer key cannot ride out on an error. The 2xx path had none of that, because a
 * successful response was implicitly trusted — and trust is exactly the wrong posture for bytes
 * the other side chose. A 2xx body that echoes the request (a debug envelope, a proxy that
 * mirrors headers, a compromised or misconfigured upstream, a `resultDesc` carrying the
 * `Authorization` header verbatim) put the bearer key straight into the returned `CollectAck` or
 * `PaymentOutcome`, and from there into the caller's logs, their APM, and every serialized
 * telemetry frame downstream.
 *
 * Reconstructing an allowlisted object closes the UNKNOWN-field half of that (see
 * `parseCollectAck` / `parsePaymentBody`). This closes the other half: a KNOWN field —
 * `resultDesc`, `mpesaReceipt`, even `id` — that carries the credential in its value. Redaction
 * is not the answer on a success path, because a successful response that contains our own
 * credential is not a response we understand; it is evidence something is echoing or
 * intercepting, and the honest verdict is INDETERMINATE.
 *
 * Object KEYS are scanned as well as values — a secret can appear as a key just as easily.
 *
 * ── THE DEPTH BOUND IS THE SAME BOUND THE PARSER USES, AND IT FAILS CLOSED ────────────────
 * This walk used to stop at depth 8 and `return false` — "no secret here" — while `parseBounded`
 * happily admits documents {@link MAX_JSON_DEPTH} levels deep. Two bounds that disagree, where
 * the SHALLOWER one reports CLEAN, is a bypass with a number for a lock: a signed body carrying
 * the configured API key or webhook secret at depth 9 walked straight past the refusal, and
 * `verifyWebhookSignature` handed it back raw.
 *
 * Two rules close it, and both are structural rather than a bigger number:
 *
 *   1. ONE CONSTANT. The traversal budget IS {@link MAX_JSON_DEPTH}, imported from the parser
 *      that produced the value. Anything the parser accepted, this walk can reach the bottom of,
 *      by construction — the two limits cannot drift apart because there is only one of them.
 *   2. FAIL CLOSED. If the walk cannot reach the bottom anyway (a caller-supplied object that
 *      never came through the parser, a cyclic structure), the answer is `true` — REFUSE. "I did
 *      not look" and "I looked and it is clean" must never produce the same answer, because every
 *      caller of this function treats `false` as permission to hand the value to the application.
 */
export function containsSecret(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): boolean {
  const live = secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (live.length === 0) return false;
  // Bounded like every other structural walk in this SDK: a hostile body must not be able to
  // turn a safety scan into a stack overflow, which would be a crash on the money path. Past the
  // budget the honest answer is "unknown", and unknown is REFUSED — see the note above.
  if (depth > MAX_JSON_DEPTH) return true;

  if (typeof value === "string") return live.some((s) => value.includes(s));
  if (Array.isArray(value)) return value.some((v) => containsSecret(v, live, depth + 1));
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (live.some((s) => k.includes(s))) return true;
      if (containsSecret(v, live, depth + 1)) return true;
    }
  }
  return false;
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
export function parseCollectAck(
  parsed: unknown,
  opts: {
    readonly httpStatus: number;
    readonly idempotencyKey: string;
    readonly what?: string;
    readonly redactBody?: BodyRedactor;
    /** Redacts the API key/secret out of any text interpolated into the message. */
    readonly redactText?: TextRedactor;
    /** Credentials that must not appear ANYWHERE in a successful body. See {@link containsSecret}. */
    readonly secrets?: readonly string[];
  },
): CollectAckWire {
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

  // THE CREDENTIAL SCAN, over the WHOLE body — before anything is handed back. See
  // `containsSecret`. A collect ack that contains our own bearer key is not an ack we can act on.
  if (containsSecret(parsed, opts.secrets ?? [])) {
    return indeterminate(
      "the response body contains this client's own API key or webhook secret — something is " +
        "echoing or intercepting the request, so the acknowledgement cannot be trusted and must " +
        "not be returned (it would carry the credential into your logs and telemetry)",
    );
  }

  // RECONSTRUCTED, NEVER PASSED THROUGH.
  //
  // Returning `parsed` after validating it is a validator that checks a body and then hands back
  // a DIFFERENT, larger object than the one it checked. Every field the schema does not name —
  // an upstream debug envelope, a mirrored `authorization`, a proxy's diagnostic block — rode
  // out inside the public `CollectAck`, was typed as if it did not exist, and was serialized by
  // the first thing that logged the ack. The fields below are the complete contract; the object
  // is built from exactly them, so an unknown field cannot survive validation by definition
  // rather than by our remembering to strip it.
  return {
    paymentId: ack.paymentId,
    status: "pending",
    checkoutRequestId: ack.checkoutRequestId,
  };
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
export function parsePaymentBody(
  parsed: unknown,
  opts: {
    readonly httpStatus: number;
    /** The id that was REQUESTED. The body must agree with it. */
    readonly expectedId: string;
    readonly what?: string;
    readonly redactBody?: BodyRedactor;
    /** Redacts the API key/secret out of any text interpolated into the message. */
    readonly redactText?: TextRedactor;
    /** Credentials that must not appear ANYWHERE in a successful body. See {@link containsSecret}. */
    readonly secrets?: readonly string[];
  },
): Payment {
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

  // THE CREDENTIAL SCAN. Same rule as the collect ack, same reason: `resultDesc` is a
  // server-controlled free-text field that lands in logs and in `PaymentOutcome.message`, so it
  // is the single most likely carrier for an echoed `Authorization` header.
  if (containsSecret(parsed, opts.secrets ?? [])) {
    return bad(
      "the response body contains this client's own API key or webhook secret — something is " +
        "echoing or intercepting the request, so the record cannot be trusted and must not be " +
        "returned (it would carry the credential into your logs and telemetry)",
    );
  }

  // RECONSTRUCTED, NEVER PASSED THROUGH — see `parseCollectAck` for the argument. The public
  // `Payment` is built from exactly the five fields the contract names, so an unknown field
  // cannot reach `PaymentOutcome`, a handler, or a log line.
  //
  // The optional fields are NORMALIZED to `null` here rather than left `undefined`. The type has
  // always said `string | null` / `WireResultCode | null`, but the pass-through returned whatever
  // the body had — so an ABSENT field arrived as `undefined` through a type that promised it
  // could not be, and `payment.resultCode === null` (a perfectly reasonable check, and the one
  // `hasResultCode` is written against) silently read false for a record that carried no code.
  return {
    id: p.id,
    status: p.status as PaymentStatus,
    mpesaReceipt: typeof p.mpesaReceipt === "string" ? p.mpesaReceipt : null,
    resultCode: asWireResultCode(p.resultCode),
    resultDesc: typeof p.resultDesc === "string" ? p.resultDesc : null,
  };
}

/**
 * Narrow an ALREADY-VALIDATED `resultCode` to the wire union.
 *
 * The union is `number | string | null` and that is not a widening — it is what the wire has
 * always carried, and what `classifyStkResult` has always been written to assess by exact form.
 * The public type used to say `number | null` while the validator accepted and returned strings
 * unchanged, so `typeof payment.resultCode === "number"` was a check the types told callers they
 * did not need to write and that the data required them to.
 */
export function asWireResultCode(v: unknown): WireResultCode | null {
  return typeof v === "number" || typeof v === "string" ? v : null;
}

/** Narrow a validated body to the `PaymentStatus` union without an unchecked cast at the call site. */
export function asPaymentStatus(v: unknown): PaymentStatus {
  return v as PaymentStatus;
}
