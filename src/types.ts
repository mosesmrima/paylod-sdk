/**
 * Wire types. Every shape here is verified against the live paylod backend:
 *   POST /collect      → supabase/functions/collect/index.ts + _shared/schemas/collect.ts
 *   GET  /status/:id   → supabase/functions/status/index.ts
 *   webhook body       → supabase/functions/_shared/webhooks/sign.ts (buildEvent)
 */

import type { DecodedError } from "./daraja-catalog.js";

/** Terminal + non-terminal payment states. NOTE: it is `success`, never `paid`. */
export type PaymentStatus = "pending" | "success" | "failed";

/** Request body for `POST /collect`. */
export interface CollectParams {
  /** Whole KES. Must be a positive integer ≤ 150000 — M-Pesa rejects decimals. */
  readonly amount: number;
  /** Any Kenyan format: `0712345678`, `+254712345678`, `254712345678`, `712345678`. */
  readonly phone: string;
  /** Shown on the customer's handset and statement. 1–12 chars. Defaults to `collect`. */
  readonly accountReference?: string;
  /** Shown on the STK prompt. 1–64 chars. Defaults to `Payment`. */
  readonly description?: string;
  /**
   * Opaque to paylod. Stored alongside the payment.
   *
   * NOTE: it is NOT currently returned on `GET /status/:id` or on the webhook event — the event
   * carries `paymentId`, `accountRef` and the M-Pesa fields, and nothing else. Key your own
   * records on `paymentId` (or `accountReference`) rather than expecting `metadata` back.
   */
  readonly metadata?: Record<string, unknown>;
  /**
   * Overrides the auto-generated key. Same key + same body → the original 202 is replayed
   * instead of charging twice. Same key + *different* body → 409 (a bug on your side).
   */
  readonly idempotencyKey?: string;
}

/** The `202 Accepted` body from `POST /collect`. The STK prompt is now on the phone. */
export interface CollectAck {
  readonly paymentId: string;
  readonly status: "pending";
  readonly checkoutRequestId: string;
  /** The `Idempotency-Key` that was sent — persist it if you plan to retry this charge. */
  readonly idempotencyKey: string;
}

/** The `200` body from `GET /status/:id`. */
export interface Payment {
  readonly id: string;
  readonly status: PaymentStatus;
  /** The M-Pesa confirmation code (e.g. `SFF6XYZ123`). Only present on success. */
  readonly mpesaReceipt: string | null;
  readonly resultCode: number | null;
  readonly resultDesc: string | null;
}

// The settled-payment result type lives in `./outcome.ts` — see `PaymentOutcome`. v0.1's
// `PaymentResult` discriminated union was removed in 0.2: it forced every integrator to branch
// before they could show a human anything, which just moved the Daraja code table into their UI.

export type WebhookEventType = "payment.success" | "payment.failed";

/** The signed JSON body paylod POSTs to your endpoint. */
export interface WebhookEvent {
  readonly type: WebhookEventType;
  /** Unix seconds. Also the `t=` value inside the signature — signed, so it cannot be forged. */
  readonly created: number;
  readonly data: {
    readonly paymentId: string;
    readonly applicationId: string;
    readonly env: "sandbox" | "production";
    readonly status: PaymentStatus;
    readonly amount: number;
    readonly phone: string;
    readonly accountRef: string | null;
    readonly mpesaReceipt: string | null;
    readonly checkoutRequestId: string | null;
    readonly resultCode: number | null;
    readonly resultDesc: string | null;
    /** Populated on `payment.failed`, `null` on `payment.success`. */
    readonly decoded: DecodedError | null;
  };
}

export interface PaylodOptions {
  /** Defaults to `process.env.PAYLOD_API_KEY`. */
  readonly apiKey?: string;
  /**
   * Defaults to `process.env.PAYLOD_BASE_URL` or `https://paylod.dev/functions/v1`.
   * (`api.paylod.dev/v1` is advertised in the docs but does not route yet.)
   */
  readonly baseUrl?: string;
  /** Defaults to `process.env.PAYLOD_WEBHOOK_SECRET`. Only needed for `webhook()`/`verify()`. */
  readonly webhookSecret?: string;
  /** Per-HTTP-request timeout, ms. Default 30_000. */
  readonly timeoutMs?: number;
  /** Retries for *idempotent/transient* failures (network, 5xx, 429). Default 2. */
  readonly maxRetries?: number;
  /** Inject a fetch implementation (tests, proxies, instrumentation). */
  readonly fetch?: typeof globalThis.fetch;
}

export interface WaitOptions {
  /** Give up after this long. Default 120_000 ms (STK prompts expire around 60s). */
  readonly timeoutMs?: number;
  /** Called with each `pending` snapshot — handy for a "waiting for PIN…" spinner. */
  readonly onPoll?: (payment: Payment) => void;
  /** Abort the wait early. */
  readonly signal?: AbortSignal;
}
