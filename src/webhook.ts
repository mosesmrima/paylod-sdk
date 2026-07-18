/**
 * Webhook signature verification.
 *
 * VERIFIED AGAINST: supabase/functions/_shared/webhooks/sign.ts (signWebhook / verifyWebhook)
 * and supabase/functions/webhook-worker/index.ts (which sets the headers).
 *
 *   header:    x-webhook-signature: t=<unix-seconds>,v1=<hex>
 *   signed:    HMAC-SHA256( secret, `${t}.${rawBody}` )   → lowercase hex
 *   also sent: x-webhook-id, x-webhook-event
 *   tolerance: the worker signs with the event's OWN `created` timestamp so retries are
 *              byte-identical; we reject a `t` more than `toleranceSec` from now (default 300).
 *
 * THE RAW BODY IS LOAD-BEARING. `JSON.stringify(JSON.parse(body))` is not guaranteed to
 * reproduce the same bytes, so re-serialising a parsed body will fail verification. Always
 * hand `verify()` the exact bytes that arrived. The framework adapters below do this for you.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { PaylodSignatureVerificationError } from "./errors.js";
import { judge } from "./semantics.js";
import { asPaymentStatus, PAYMENT_STATUSES } from "./validate.js";
import type { WebhookEvent } from "./types.js";

export const SIGNATURE_HEADER = "x-webhook-signature";
export const EVENT_ID_HEADER = "x-webhook-id";
export const EVENT_TYPE_HEADER = "x-webhook-event";

/** Default anti-replay window, seconds. Mirrors the server's `maxSkewSeconds`. */
export const DEFAULT_TOLERANCE_SEC = 300;

export interface VerifyParams {
  /** The EXACT bytes of the request body. Never a re-serialised object. */
  readonly payload: string | Buffer | Uint8Array;
  /** The `x-webhook-signature` header value. */
  readonly signature: string | null | undefined;
  /** The endpoint's signing secret (`whsec_…`). */
  readonly secret: string;
  /**
   * Reject timestamps further than this from now. Default 300s. Must be a finite positive integer
   * — the check cannot be disabled. To verify a fixed vector, pin {@link VerifyParams.nowSec}
   * instead of widening or zeroing this.
   */
  readonly toleranceSec?: number;
  /** Injectable clock (unix seconds) — tests only. Must be a finite non-negative integer. */
  readonly nowSec?: number;
}

function toBuffer(payload: string | Buffer | Uint8Array): Buffer {
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}

/** A well-formed `v1` is 64 lowercase hex chars (HMAC-SHA256 digest). */
const V1_RE = /^[0-9a-f]{64}$/;

/**
 * A well-formed `t` is bare decimal digits — unix seconds, never signed, never in exponent or hex
 * notation, never padded. 15 digits is the ceiling: it keeps every accepted value below
 * Number.MAX_SAFE_INTEGER (and 15 digits of seconds is already ~31 million years out).
 */
const TIMESTAMP_RE = /^\d{1,15}$/;

/**
 * Parse the signature header STRICTLY. The header is `t=<unix>,v1=<hex>` and nothing else that
 * matters — so we require EXACTLY ONE `t` and EXACTLY ONE `v1`, and reject anything else.
 *
 * This closes a last-value-wins hole: two `x-webhook-signature` headers combined into one
 * comma-joined value (`t=1,v1=<real>,t=9999999999,v1=<forged>`) must NOT be accepted by silently
 * taking the last pair. Duplicates of either key are fatal, as is a malformed `v1`.
 */
function parseHeader(header: string): { t: string; v1: string } | null {
  let t: string | undefined;
  let v1: string | undefined;
  let tCount = 0;
  let v1Count = 0;
  for (const seg of header.split(",")) {
    const s = seg.trim();
    if (s === "") continue;
    const idx = s.indexOf("=");
    if (idx <= 0) continue;
    const key = s.slice(0, idx).trim();
    const val = s.slice(idx + 1).trim();
    if (key === "t") {
      t = val;
      tCount++;
    } else if (key === "v1") {
      v1 = val;
      v1Count++;
    }
    // Unknown keys are ignored for forward-compatibility, but a duplicate t/v1 is fatal below.
  }
  if (tCount !== 1 || v1Count !== 1 || !t || !v1) return null;
  // `v1` must be exactly one 64-char lowercase-hex digest. `t` is validated (integer) by the caller
  // so the "not a number" diagnostic stays specific.
  if (!V1_RE.test(v1)) return null;
  return { t, v1 };
}

/**
 * Verify ONLY the signature, the freshness and that the body is JSON. Returns the parsed body
 * WITHOUT validating that it is a paylod event.
 *
 * Split out from {@link verifyWebhook} because these are two genuinely different questions —
 * "did paylod send this?" and "is this a well-formed payment event?" — and conflating them makes
 * both harder to test. The cross-repo golden vector pins the SIGNING SCHEME, so it belongs on
 * this function; the schema rules belong on `verifyWebhook`.
 *
 * Prefer {@link verifyWebhook} in application code. Reach for this only when you deliberately
 * want the raw signed payload (a relay, a recorder, a schema-version shim).
 */
export function verifyWebhookSignature(params: VerifyParams): unknown {
  const { payload, signature, secret, toleranceSec = DEFAULT_TOLERANCE_SEC } = params;

  if (!secret) {
    throw new PaylodSignatureVerificationError(
      "missing_signature",
      "No webhook signing secret configured. Pass `webhookSecret` or set PAYLOD_WEBHOOK_SECRET.",
    );
  }
  if (!signature) {
    throw new PaylodSignatureVerificationError(
      "missing_signature",
      `Missing ${SIGNATURE_HEADER} header.`,
    );
  }

  const parsed = parseHeader(signature);
  if (!parsed) {
    throw new PaylodSignatureVerificationError(
      "malformed_signature",
      `Malformed ${SIGNATURE_HEADER} header — expected "t=<unix>,v1=<hex>".`,
    );
  }

  // `t` must always be a plain decimal integer, regardless of tolerance. We validate the STRING
  // before converting, because `Number()` is far more permissive than the wire format is: it
  // happily accepts `1e3`, `+1000`, `0x10`, `Infinity`, and surrounding whitespace, all of which
  // `Number.isInteger` would then wave through (1000, 1000, 16, …). An attacker who can pick the
  // `t` bytes could use that to smuggle a timestamp past a naive freshness check while signing a
  // DIFFERENT string — remember the HMAC is computed over `parsed.t` verbatim, not over the parsed
  // number, so `t=1e3` and `t=1000` are distinct signing inputs that would collapse to the same
  // freshness decision. Requiring digits-only removes the whole class. The 15-digit ceiling keeps
  // the result inside Number.MAX_SAFE_INTEGER so the arithmetic below is exact.
  if (!TIMESTAMP_RE.test(parsed.t)) {
    throw new PaylodSignatureVerificationError(
      "malformed_signature",
      "Signature timestamp is not a number — `t` must be 1-15 decimal digits (unix seconds), " +
        "with no sign, exponent, radix prefix, or surrounding whitespace.",
    );
  }
  const t = Number(parsed.t);

  // The tolerance is the ONLY thing standing between a captured webhook and an indefinite replay,
  // so it is validated unconditionally — there is deliberately no escape hatch. A previous version
  // allowed a non-positive tolerance whenever a `nowSec` was injected, on the theory that a pinned
  // clock makes replay a non-issue in tests. That reasoning does not survive contact with real
  // code: `nowSec` is a public field on a public API, so any caller that threads a clock through
  // (a scheduler, a deterministic-time framework, a well-meaning wrapper) silently inherited a
  // verifier with replay protection switched off. `Infinity` was accepted too, which is the same
  // hole spelled differently — an infinite window. Fixed-vector tests do not need the hatch: they
  // can pin `nowSec` at the vector's own `t` and pass a normal positive tolerance.
  if (!Number.isInteger(toleranceSec) || toleranceSec <= 0) {
    throw new PaylodSignatureVerificationError(
      "insecure_tolerance",
      `toleranceSec must be a finite positive integer number of seconds (got ${toleranceSec}). ` +
        "Zero, negative, fractional, and non-finite values are refused: there is no way to " +
        "disable webhook replay protection. To verify a fixed/ancient vector, pin the clock with " +
        "`nowSec` and keep a normal tolerance such as the 300s default.",
    );
  }

  // An injected clock is held to the same standard. A `NaN` clock makes every `Math.abs(...)`
  // comparison false (so nothing is ever stale — replay protection off), and an infinite one makes
  // it always true (so nothing ever verifies). Both fail silently in opposite directions, which is
  // exactly the kind of bug that ships.
  if (
    params.nowSec !== undefined &&
    (!Number.isInteger(params.nowSec) || params.nowSec < 0)
  ) {
    throw new PaylodSignatureVerificationError(
      "insecure_tolerance",
      `nowSec must be a finite non-negative integer of unix seconds (got ${params.nowSec}). ` +
        "A non-finite or negative clock would silently disable or break the freshness check.",
    );
  }

  const now = params.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSec) {
    throw new PaylodSignatureVerificationError(
      "stale_timestamp",
      `Signature timestamp is outside the ${toleranceSec}s tolerance (replay?).`,
    );
  }

  const raw = toBuffer(payload);
  const expected = createHmac("sha256", secret)
    .update(`${parsed.t}.`)
    .update(raw)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(parsed.v1, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PaylodSignatureVerificationError(
      "no_match",
      "Webhook signature does not match. Check the signing secret, and make sure you are " +
        "passing the RAW request body (not a re-serialised object).",
    );
  }

  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new PaylodSignatureVerificationError(
      "invalid_payload",
      "Webhook body is signed correctly but is not valid JSON.",
    );
  }
}

/** Reject with a consistent, non-leaking message. */
function invalid(detail: string): never {
  throw new PaylodSignatureVerificationError(
    "invalid_payload",
    `Webhook body is signed correctly but is not a valid paylod event: ${detail}. A signature ` +
      "proves WHO sent the body, not that the body means what your handler assumes — so the " +
      "event is rejected rather than passed on half-understood.",
  );
}

function optionalString(v: unknown, field: string): void {
  if (v !== undefined && v !== null && typeof v !== "string") invalid(`${field} is not a string`);
}

/**
 * Verify a paylod webhook and return the typed event.
 *
 * Throws {@link PaylodSignatureVerificationError} on any failure — never returns a half-trusted
 * value. Respond `400` and drop the request when it throws.
 *
 * ── Why the schema is validated at all ────────────────────────────────────────────────────
 * The previous version checked that `type` was a string and `data` was an object, then CAST the
 * whole body to `WebhookEvent`. Every other field was a lie the type system was happy to tell:
 * `event.data.status`, `event.data.amount` and `event.data.mpesaReceipt` were typed as
 * `PaymentStatus`, `number` and `string | null` while actually being whatever arrived. A handler
 * written against those types — which is every handler, because that is what the types are for —
 * would branch on `data.status === "success"` and fulfil an order on a field nothing had checked.
 *
 * A valid signature does NOT make that safe. It proves the body came from paylod; it says
 * nothing about whether the body is coherent. A bug upstream, a partially-written row, a schema
 * change, or a compromised signing key all produce correctly-signed nonsense, and the handler is
 * the last place that can refuse it.
 *
 * Three layers are enforced:
 *   1. SHAPE       — every field present is the type the interface promises.
 *   2. CONSISTENCY — `type` and `data.status` must agree. A `payment.success` carrying
 *                    `status: "failed"` is not an event we can act on either way.
 *   3. EVIDENCE    — a `payment.success` must satisfy the SAME semantic model a status read
 *                    does: a receipt or result code 0. The event type is a claim, and a claim is
 *                    not evidence for itself — this is law L2 from `semantics.ts`, applied to
 *                    the delivery channel that most often triggers order fulfilment.
 */
export function verifyWebhook(params: VerifyParams): WebhookEvent {
  const body = verifyWebhookSignature(params);

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    invalid("the body is not a JSON object");
  }
  const e = body as Record<string, unknown>;

  if (e.type !== "payment.success" && e.type !== "payment.failed") {
    invalid(`type was ${JSON.stringify(e.type)}, expected payment.success or payment.failed`);
  }
  if (typeof e.created !== "number" || !Number.isSafeInteger(e.created) || e.created < 0) {
    invalid("created is not a non-negative integer of unix seconds");
  }
  if (typeof e.data !== "object" || e.data === null || Array.isArray(e.data)) {
    invalid("data is not an object");
  }
  const d = e.data as Record<string, unknown>;

  if (typeof d.paymentId !== "string" || d.paymentId.trim() === "") {
    invalid("data.paymentId is missing or empty");
  }
  if (typeof d.status !== "string" || !PAYMENT_STATUSES.includes(d.status)) {
    invalid(
      `data.status was ${JSON.stringify(d.status)}, not one of ${PAYMENT_STATUSES.join("/")}`,
    );
  }
  if (typeof d.amount !== "number" || !Number.isFinite(d.amount)) {
    invalid("data.amount is not a finite number");
  }
  if (d.env !== undefined && d.env !== "sandbox" && d.env !== "production") {
    invalid(`data.env was ${JSON.stringify(d.env)}, expected sandbox or production`);
  }
  optionalString(d.applicationId, "data.applicationId");
  optionalString(d.phone, "data.phone");
  optionalString(d.accountRef, "data.accountRef");
  optionalString(d.mpesaReceipt, "data.mpesaReceipt");
  optionalString(d.checkoutRequestId, "data.checkoutRequestId");
  optionalString(d.resultDesc, "data.resultDesc");
  if (
    d.resultCode !== undefined &&
    d.resultCode !== null &&
    typeof d.resultCode !== "number" &&
    typeof d.resultCode !== "string"
  ) {
    invalid("data.resultCode is neither a number/string nor null");
  }

  // 2. CONSISTENCY. The event type and the record's own status must say the same thing.
  const expectedStatus = e.type === "payment.success" ? "success" : "failed";
  if (d.status !== expectedStatus) {
    invalid(
      `type is ${JSON.stringify(e.type)} but data.status is ${JSON.stringify(d.status)} — the ` +
        `event contradicts itself, so neither field can be trusted`,
    );
  }

  // 3. EVIDENCE, via the one semantic model. Reusing `judge` rather than re-deriving the rule
  // here is the whole point of having a model: the webhook path and the status-read path cannot
  // drift into disagreeing about what proves a payment.
  const { verdict, reason } = judge({
    id: d.paymentId,
    status: asPaymentStatus(d.status),
    mpesaReceipt: typeof d.mpesaReceipt === "string" ? d.mpesaReceipt : null,
    resultCode: (d.resultCode ?? null) as number | null,
    resultDesc: typeof d.resultDesc === "string" ? d.resultDesc : null,
  });

  if (e.type === "payment.success" && verdict !== "paid") {
    invalid(
      `it announces a successful payment but the record does not prove one (${reason}). ` +
        "Refusing to hand your handler an unevidenced success — that is how an order gets " +
        "fulfilled for a payment that never settled",
    );
  }
  if (e.type === "payment.failed" && verdict !== "failed") {
    invalid(
      `it announces a failed payment but the record does not support that (${reason}). In ` +
        "particular a failure notice carrying a receipt, or one carrying a still-in-flight " +
        "result code, must not be delivered as a settled failure",
    );
  }

  return body as WebhookEvent;
}

/**
 * Sign a payload the way the paylod webhook worker does. Exported so you can build realistic
 * fixtures in your own tests — you never need this in production code.
 */
export function signWebhook(
  payload: string | Buffer | Uint8Array,
  secret: string,
  timestampSec: number = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret)
    .update(`${timestampSec}.`)
    .update(toBuffer(payload))
    .digest("hex");
  return `t=${timestampSec},v1=${v1}`;
}
