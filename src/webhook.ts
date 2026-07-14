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
  /** Reject timestamps further than this from now. Default 300s. `0` disables the check. */
  readonly toleranceSec?: number;
  /** Injectable clock (unix seconds) — tests only. */
  readonly nowSec?: number;
}

function toBuffer(payload: string | Buffer | Uint8Array): Buffer {
  if (typeof payload === "string") return Buffer.from(payload, "utf8");
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}

function parseHeader(header: string): { t: string; v1: string } | null {
  const parts = new Map<string, string>();
  for (const seg of header.split(",")) {
    const idx = seg.indexOf("=");
    if (idx <= 0) continue;
    parts.set(seg.slice(0, idx).trim(), seg.slice(idx + 1).trim());
  }
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) return null;
  return { t, v1 };
}

/**
 * Verify a paylod webhook and return the typed event.
 *
 * Throws {@link PaylodSignatureVerificationError} on any failure — never returns a
 * half-trusted value. Respond `400` and drop the request when it throws.
 */
export function verifyWebhook(params: VerifyParams): WebhookEvent {
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

  if (toleranceSec > 0) {
    const t = Number(parsed.t);
    if (!Number.isFinite(t)) {
      throw new PaylodSignatureVerificationError(
        "malformed_signature",
        "Signature timestamp is not a number.",
      );
    }
    const now = params.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - t) > toleranceSec) {
      throw new PaylodSignatureVerificationError(
        "stale_timestamp",
        `Signature timestamp is outside the ${toleranceSec}s tolerance (replay?).`,
      );
    }
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

  let event: unknown;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new PaylodSignatureVerificationError(
      "invalid_payload",
      "Webhook body is signed correctly but is not valid JSON.",
    );
  }
  if (
    typeof event !== "object" ||
    event === null ||
    typeof (event as WebhookEvent).type !== "string" ||
    typeof (event as WebhookEvent).data !== "object"
  ) {
    throw new PaylodSignatureVerificationError(
      "invalid_payload",
      "Webhook body is not a paylod event (missing `type`/`data`).",
    );
  }
  return event as WebhookEvent;
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
