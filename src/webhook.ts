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
import { PaylodResponseTooLargeError, PaylodSignatureVerificationError } from "./errors.js";
import { isValidIdentifier, isValidReceipt } from "./grammar.js";
import { parseBounded } from "./json.js";
import { decodeDarajaResult } from "./daraja-catalog.js";
import { judge } from "./semantics.js";
import { asPaymentStatus, asWireResultCode, containsSecret, PAYMENT_STATUSES } from "./validate.js";
import type { WebhookEvent } from "./types.js";

export const SIGNATURE_HEADER = "x-webhook-signature";
export const EVENT_ID_HEADER = "x-webhook-id";
export const EVENT_TYPE_HEADER = "x-webhook-event";

/** Default anti-replay window, seconds. Mirrors the server's `maxSkewSeconds`. */
export const DEFAULT_TOLERANCE_SEC = 300;

/**
 * The widest replay window this SDK will accept, in seconds (24 hours).
 *
 * A lower bound alone does not protect anything. `toleranceSec` was required to be a positive
 * integer, which `86_400_000` satisfies — and at that value every captured webhook stays valid for
 * three thousand years, i.e. replay protection is off while every check still reads as enabled.
 * That is worse than no check, because it looks like one.
 *
 * A day is already far beyond any legitimate need: paylod signs with the event's own `created`
 * timestamp and gives up redelivering long before then, so a tolerance wider than this cannot be
 * accepting anything but an attack or a badly wrong clock. Callers verifying a genuinely ancient
 * fixed vector should pin `nowSec` instead of widening the window — that is what it is for.
 */
export const MAX_TOLERANCE_SEC = 86_400;

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
  /**
   * This client's API key, so a signed body that echoes it is refused rather than handed to a
   * handler that logs it. `Paylod#verifyWebhook` supplies this automatically; supply it yourself
   * only when calling the standalone functions.
   *
   * A verified event is the single most-logged object in an integration, and the API key is the
   * credential that moves money. Scanning only the SIGNING secret closed the smaller half of the
   * hole and left the larger one open.
   */
  readonly apiKey?: string;
  /** Any further values that must never appear inside a verified body. */
  readonly extraSecrets?: readonly string[];
}

function toBuffer(payload: string | Buffer | Uint8Array): Buffer {
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}

/**
 * Hard ceiling on a webhook body this SDK will authenticate, in bytes.
 *
 * ── Why it lives HERE and not on the adapters ─────────────────────────────────────────────
 * It used to live in `client.ts`, next to the Express and Web-`Request` adapters that drain the
 * request stream — which made it a property of THOSE TWO INTAKE PATHS rather than of webhook
 * verification. The manual API is public and documented, and it is what every framework this SDK
 * has no adapter for uses: Fastify, Koa, NestJS, AWS Lambda, Azure Functions, a raw
 * `http.createServer`, a queue consumer replaying stored bodies. All of them call
 * `verifyWebhook` / `verifyWebhookSignature` directly, and all of them got NO cap at all.
 *
 * That is the same OOM the adapters were fixed for, reached through the front door: an anonymous
 * caller who can reach the endpoint hands over an arbitrarily large body, and this SDK then runs
 * an HMAC pass, a UTF-8 decode and a full JSON parse across every unauthenticated byte of it.
 * The bytes cannot be authenticated first — verification needs all of them — so the cap is the
 * only bound that exists, and it has to sit on the function that does the authenticating.
 *
 * 1 MiB is far above any real paylod event (a few hundred bytes) and far below anything that
 * threatens a server. The adapters import this constant rather than declaring their own, so the
 * advertised limit and the enforced limit are the same number in every path.
 */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

/** The one refusal, so every intake path says the same thing for the same reason. */
export function tooLargeBody(detail: string): Error {
  return new Error(
    `Webhook body exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes (${detail}). A paylod event is a few ` +
      "hundred bytes; the request is refused before it is buffered because these bytes are not " +
      "authenticated until the whole body has arrived, and an unbounded buffer an anonymous " +
      "caller can fill is an OOM they control.",
  );
}

/**
 * Convert an incoming payload to bytes and REFUSE IT IF IT IS OVER THE CAP — before the HMAC,
 * before the UTF-8 decode, before `JSON.parse`.
 *
 * The size is measured on the BYTES, never on `String.length`: a UTF-16 length undercounts every
 * non-ASCII character by up to 3x, so a "1 MiB" check on a string length is really a 3 MiB check
 * against an attacker who picks the characters.
 */
function toBoundedBuffer(payload: string | Buffer | Uint8Array): Buffer {
  if (typeof payload !== "string" && !ArrayBuffer.isView(payload)) {
    throw new PaylodSignatureVerificationError(
      "invalid_payload",
      "verify() needs the RAW request body as a string, Buffer or Uint8Array — not a parsed " +
        "object. Re-serialising a parsed body does not reproduce the signed bytes.",
    );
  }
  const declared =
    typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.byteLength;
  if (declared > MAX_WEBHOOK_BODY_BYTES) {
    throw tooLargeBody(`the payload passed to verify() is ${declared} bytes`);
  }
  return toBuffer(payload);
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

  // THE SIZE CAP, FIRST — before the conversion, before the HMAC, before `JSON.parse`.
  //
  // This is the public, manual verification path, and it had no bound of any kind. Every
  // framework without an adapter in this SDK arrives here, so "the webhook endpoint is capped at
  // 1 MiB" was true only for Express and the Web `Request` handler and false everywhere else.
  // These bytes are UNAUTHENTICATED by definition at this point — the signature is what we are
  // about to compute — so an anonymous caller chose them, and without a cap they choose how much
  // work and how much memory this process spends before it is allowed to say no.
  const raw = toBoundedBuffer(payload);

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
  if (!Number.isInteger(toleranceSec) || toleranceSec <= 0 || toleranceSec > MAX_TOLERANCE_SEC) {
    throw new PaylodSignatureVerificationError(
      "insecure_tolerance",
      `toleranceSec must be a finite positive integer number of seconds, no greater than ` +
        `${MAX_TOLERANCE_SEC} (got ${toleranceSec}). ` +
        `Zero, negative, fractional, and non-finite values are refused: ` +
        "there is no way to disable webhook replay protection. An ENORMOUS tolerance is refused " +
        "for the same reason spelled differently — a window of years is not a freshness check, " +
        "it is the absence of one wearing a check's clothes. To verify a fixed/ancient vector, " +
        "pin the clock with `nowSec` and keep a normal tolerance such as the 300s default.",
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

  // THE SAME PARSER THE API PATH USES — depth budget and numeric-lexeme rule included.
  //
  // This was a bare `JSON.parse`, which made the signed channel the WEAKER of the two. Both
  // halves of that mattered. The depth budget: an event is three levels deep, and a signed body
  // nesting tens of thousands deep blew the stack of the process holding a live charge — a valid
  // signature proves who sent the bytes, not that the bytes are safe to parse. The numeric
  // lexeme: `{"resultCode": 0.0}` parses to `0` and `judge()` reads that as PAID, so a signing
  // key (the thing a compromise takes first) plus one non-canonical spelling was an order
  // fulfilled for a payment that never settled. The API path refused exactly that spelling.
  let decodedBody: unknown;
  try {
    decodedBody = parseBounded(raw.toString("utf8"));
  } catch (e) {
    throw new PaylodSignatureVerificationError(
      "invalid_payload",
      e instanceof PaylodResponseTooLargeError
        ? `Webhook body is signed correctly but was refused before it was parsed: ${e.message}`
        : "Webhook body is signed correctly but is not valid JSON.",
    );
  }

  // THE CREDENTIAL SCAN RUNS HERE — ON THE RAW PARSED BODY, BEFORE ANY DIAGNOSTIC QUOTES IT.
  //
  // Three separate leaks closed at one point, all of which lived downstream of this function:
  //
  //   1. THIS FUNCTION RETURNED THE RAW OBJECT. `verifyWebhookSignature` is public and documented
  //      for relays and recorders — the callers most likely to log or forward what they get — and
  //      it handed back the parsed body with no scan at all. `verifyWebhook`'s scan protected
  //      only `verifyWebhook`.
  //   2. THE SCHEMA DIAGNOSTICS INTERPOLATE FIELD VALUES. `invalid()` messages quote
  //      `JSON.stringify(d.status)`, `e.type` and friends, and those messages travel into the
  //      caller's 400 response and their logs. A body whose `status` carries the bearer key
  //      therefore leaked it through the REFUSAL path — the one path nobody thinks to redact,
  //      because a refusal feels safe. Scanning before the first diagnostic runs is what makes
  //      it safe.
  //   3. ONLY THE SIGNING SECRET WAS SCANNED. The API key is the credential that moves money;
  //      the class wrapper never passed it in. Every credential the caller holds is scanned now.
  //
  // Refused, not redacted, and refused AFTER the signature checked out: a correctly-signed event
  // containing our own credential is not a well-formed event with an unfortunate string in it.
  // It is evidence something upstream is echoing the credential, and the honest response is to
  // stop. The refusal message names no field and quotes no value.
  if (containsSecret(decodedBody, liveSecrets(params))) {
    throw new PaylodSignatureVerificationError(
      "invalid_payload",
      "The webhook body is signed correctly but contains one of this client's own credentials " +
        "(the signing secret or the API key). A verified body is logged and forwarded wholesale, " +
        "so delivering it would write a credential into ordinary application logs. No field is " +
        "named here because naming it would reproduce the value.",
    );
  }

  return decodedBody;
}

/**
 * Every credential the caller holds that must never appear inside a body we hand back.
 *
 * The signing secret alone was never the whole set. `secret` proves WHO sent the event; the API
 * KEY is what moves money, and a body echoing it is the worse of the two leaks. `extraSecrets`
 * exists for anything else the integrator considers fatal to log (a shared HMAC key, a tenant
 * token) without needing a new parameter each time.
 */
function liveSecrets(params: VerifyParams): readonly string[] {
  const out: string[] = [];
  if (typeof params.secret === "string" && params.secret) out.push(params.secret);
  if (typeof params.apiKey === "string" && params.apiKey) out.push(params.apiKey);
  for (const s of params.extraSecrets ?? []) {
    if (typeof s === "string" && s) out.push(s);
  }
  return out;
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

/** A field the schema allows to be absent or explicitly null, but never any other shape. */
function optionalString(v: unknown, field: string): void {
  if (v !== undefined && v !== null && typeof v !== "string") invalid(`${field} is not a string`);
}

/**
 * A field the schema says is ALWAYS present and always a non-blank string.
 *
 * `applicationId`, `env` and `phone` were treated as optional and then cast into a `WebhookEvent`
 * that types them as required. A handler reading `event.data.applicationId` to route a payment to
 * the right merchant account, or `event.data.env` to refuse a sandbox event on a production
 * ledger, was reading `undefined` through a type that promised a string — so the sandbox guard
 * silently evaluated `undefined !== "production"` and the multi-tenant guard compared `undefined`
 * against a real id. Optional-in-practice and required-in-the-types is the worst of both: nothing
 * checks it and everything assumes it.
 */
function requiredString(v: unknown, field: string): void {
  if (typeof v !== "string") invalid(`${field} is missing or is not a string`);
  if ((v as string).trim() === "") invalid(`${field} is present but blank`);
}

/**
 * The largest amount paylod will move in one payment, in KES. Mirrors the client-side `MAX_AMOUNT`
 * so the delivery channel cannot admit a figure the charging channel would have refused.
 */
const MAX_WEBHOOK_AMOUNT = 150_000;

/**
 * M-Pesa moves WHOLE KENYAN SHILLINGS. It has no sub-unit on this rail, it cannot move a negative
 * amount, and it cannot move zero.
 *
 * `Number.isFinite` was the whole check, so `-100`, `0.5` and `1e15` all arrived at a handler
 * typed as a plain `number`. Each one is a live reconciliation bug: a negative books a credit
 * against an order, a fraction rounds differently in the ledger than it does in the UI, and an
 * absurd figure trips limits somewhere downstream instead of here. An amount that could never
 * have been charged is a strong signal the record is wrong, and a wrong record must not be
 * delivered as a settled payment.
 */
function assertAmount(v: unknown): void {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    invalid("data.amount is not a finite number");
  }
  const n = v as number;
  if (!Number.isInteger(n) || Object.is(n, -0)) {
    invalid(`data.amount must be a whole number of KES (got ${JSON.stringify(n)})`);
  }
  if (n <= 0 || n > MAX_WEBHOOK_AMOUNT) {
    invalid(
      `data.amount must be between 1 and ${MAX_WEBHOOK_AMOUNT} KES (got ${JSON.stringify(n)}) — ` +
        "an amount M-Pesa could never have moved is evidence the record is wrong",
    );
  }
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

  // POSITIVE GRAMMAR (spec 3.4), not a non-emptiness test. A signed event is authenticated, not
  // trusted: the signature proves who sent the bytes, never that a sanitizer did not rewrite a
  // field on the way. `[redacted]` used to arrive as `event.data.paymentId` and be handed to a
  // handler that routes on it.
  if (!isValidIdentifier(d.paymentId)) {
    invalid("data.paymentId is missing, empty or not a usable identifier");
  }
  if (typeof d.status !== "string" || !PAYMENT_STATUSES.includes(d.status)) {
    invalid(
      `data.status was ${JSON.stringify(d.status)}, not one of ${PAYMENT_STATUSES.join("/")}`,
    );
  }
  assertAmount(d.amount);
  if (d.env !== "sandbox" && d.env !== "production") {
    invalid(`data.env was ${JSON.stringify(d.env)}, expected sandbox or production`);
  }
  requiredString(d.applicationId, "data.applicationId");
  if (!isValidIdentifier(d.applicationId)) {
    invalid("data.applicationId is not a usable identifier");
  }
  requiredString(d.phone, "data.phone");
  optionalString(d.accountRef, "data.accountRef");
  optionalString(d.mpesaReceipt, "data.mpesaReceipt");
  // A receipt on a signed event obeys the SAME grammar as one from the status endpoint (spec
  // 3.3). Absent is fine; present-but-not-a-receipt is a body we do not understand, and on this
  // path it is also the exact shape that forged a `payment.success`.
  if (
    typeof d.mpesaReceipt === "string" &&
    d.mpesaReceipt.trim() !== "" &&
    !isValidReceipt(d.mpesaReceipt)
  ) {
    invalid("data.mpesaReceipt is present but is not a valid M-Pesa receipt");
  }
  optionalString(d.checkoutRequestId, "data.checkoutRequestId");
  if (
    d.checkoutRequestId !== undefined &&
    d.checkoutRequestId !== null &&
    !isValidIdentifier(d.checkoutRequestId)
  ) {
    invalid("data.checkoutRequestId is not a usable identifier");
  }
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

  // 4. THE DECODED BLOCK IS RECOMPUTED, NEVER TRUSTED.
  //
  // `data.decoded` arrives inside the signed body, and it carries `retryable` — the one boolean in
  // this SDK that means SAFE TO CHARGE AGAIN. Passing it through as sent gives whoever produced
  // the payload a direct vote on whether the merchant charges the customer a second time: a block
  // claiming `retryable: true` beside result code 4999 (the customer is mid-PIN, the prompt is
  // LIVE) is an instruction to double-charge, and it would have been handed to the handler with a
  // valid signature on it. The sibling JVM SDK trusted this block.
  //
  // A signature proves WHO sent the body. It does not make the body's opinions correct, and the
  // signing key is exactly what a compromise takes first. So the block is rebuilt here from the
  // canonical catalog, keyed on the fields we DID validate (`resultCode` / `resultDesc`) — the
  // same call `decodeError()` and `check()` make. The payload's own block is discarded.
  //
  // THE BLOCK'S PRESENCE IS DERIVED FROM THE EVENT TYPE, NOT FROM THE PAYLOAD.
  //
  // "Null in, null out" still let the payload vote — just on a different question. Omitting
  // `decoded` from a `payment.failed` produced an event with `decoded: null`, and every handler
  // that renders `event.data.decoded.customerMessage` or gates a retry on
  // `event.data.decoded.retryable` then hits a null it was typed to believe could not be there.
  // A block that goes missing exactly when a hostile sender wants a retry decision skipped is the
  // same defect as a block that lies, reached by omission instead of assertion.
  //
  // So the contract is enforced rather than mirrored: `payment.failed` ALWAYS carries a block,
  // synthesised from the canonical catalog; `payment.success` NEVER does. Nothing the payload
  // sends — a hostile block, a partial block, no block at all — changes either answer.
  const decoded =
    e.type === "payment.failed"
      ? decodeDarajaResult(
          d.resultCode ?? null,
          typeof d.resultDesc === "string" ? d.resultDesc : null,
        )
      : null;

  // 5. THE EVENT IS RECONSTRUCTED FIELD BY FIELD — NEVER SPREAD.
  //
  // `{ ...e, data: { ...d, decoded } }` validated a known set of fields and then returned a
  // strictly LARGER object: every key the payload carried that the schema does not name came
  // along, typed as if it were not there. The signature does not help — it proves paylod sent
  // the bytes, and a compromised or misconfigured signer produces perfectly-signed extra fields.
  // A `__raw`, a `debug`, a mirrored `headers` block lands inside `event.data`, and the FIRST
  // thing a handler does with a verified event is log it. That is the webhook secret (or
  // anything else upstream echoed) written to the caller's log sink under a signature that says
  // it is trustworthy.
  //
  // The allowlist below IS the `WebhookEvent` interface. Building the object from exactly these
  // keys means an unknown field cannot survive verification by construction — not because we
  // remembered to delete it, and not because a `delete` list was kept in sync with the schema.
  // Adding a field to `WebhookEvent` without adding it here is a compile error.
  const event: WebhookEvent = {
    type: e.type,
    created: e.created,
    data: {
      paymentId: d.paymentId,
      applicationId: d.applicationId as string,
      env: d.env,
      status: asPaymentStatus(d.status),
      amount: d.amount as number,
      phone: d.phone as string,
      accountRef: typeof d.accountRef === "string" ? d.accountRef : null,
      // Grammar-gated, matching the status path exactly: the two surfaces must not disagree
      // about what a receipt or an identifier is.
      mpesaReceipt: isValidReceipt(d.mpesaReceipt) ? d.mpesaReceipt : null,
      checkoutRequestId: isValidIdentifier(d.checkoutRequestId) ? d.checkoutRequestId : null,
      resultCode: asWireResultCode(d.resultCode),
      resultDesc: typeof d.resultDesc === "string" ? d.resultDesc : null,
      decoded,
    },
  };

  // 6. THE SECRET MUST NOT APPEAR IN THE EVENT WE HAND OVER.
  //
  // The allowlist above closes the UNKNOWN-field route. This closes the known-field one: a
  // `resultDesc`, an `accountRef` or a `phone` whose VALUE carries the signing secret. Those are
  // free-text fields, they are rendered in dashboards and written to ordinary handler logs, and
  // the secret is the one value that must never reach either — it is what lets an attacker forge
  // events, so leaking it converts a log reader into a signer.
  //
  // Refused rather than redacted, and refused AFTER the signature checked out, because a
  // correctly-signed event that contains the signing secret is not a well-formed event with an
  // unfortunate string in it. It is evidence that something upstream is echoing the secret, and
  // the honest response to that is to stop, not to quietly scrub one copy and continue.
  // `liveSecrets`, not `[params.secret]`: the API key is scanned too, and the raw body was
  // already scanned before the diagnostics above could quote a field value. This is the
  // last of the three gates, on the RECONSTRUCTED event.
  if (containsSecret(event, liveSecrets(params))) {
    invalid(
      "the event body contains one of this client's own credentials. A verified event is logged " +
        "wholesale by handlers, so delivering it would write a credential — the signing key that " +
        "lets anyone forge these events, or the API key that moves money — into ordinary " +
        "application logs",
    );
  }

  return event;
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
