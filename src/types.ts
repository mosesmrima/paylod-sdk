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
  /**
   * Your correlation id (invoice/order number), returned as `accountRef` on the status read
   * and on the webhook. Shown to the payer only on a Paybill, where it is the account number
   * they are paying into; a Till (Buy Goods) never displays it — the payer sees just your
   * business name and the amount. 1–12 chars.
   *
   * Defaults to a short prefix of the `paymentId`, so an omitted reference is still unique and
   * still correlatable back to the payment.
   *
   * NOTE: this is a *label*, not a lock. It does not deduplicate anything — putting your order id
   * here does not stop a second charge. {@link idempotencyKey} is what does that. Passing your
   * order id to both is a good idea.
   */
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
   * **The thing that stops you charging a customer twice.** Pass the id of what is being paid
   * for — an order id, an invoice number — not a fresh random value:
   *
   * ```ts
   * await paylod.collectAndWait({ phone, amount, idempotencyKey: order.id });
   * ```
   *
   * Send the same key twice and the second call returns the *original* payment — same
   * `paymentId`, same `checkoutRequestId` — rather than firing a second STK prompt. So a
   * double-clicked Pay button, a refreshed tab, or a retried request charges once.
   * Same key + a *different* body → `409` (that means two different charges collided on one key:
   * a bug on your side).
   *
   * Only you can supply this: paylod cannot know that a retry of order 1042 is the same charge
   * rather than the customer deliberately buying again.
   *
   * **If you omit it**, the SDK generates a fresh key for each call. That makes an internal
   * network retry of one call safe, but it does NOT stop your application from sending the same
   * logical charge twice — which is the common way customers get double-charged. The SDK emits a
   * one-time `console.warn` in that case.
   */
  readonly idempotencyKey?: string;
}

/** The `202 Accepted` body from `POST /collect`. The STK prompt is now on the phone. */
export interface CollectAck {
  readonly paymentId: string;
  readonly status: "pending";
  readonly checkoutRequestId: string;
  /**
   * The `Idempotency-Key` that was actually sent: the one you passed, or the random one the SDK
   * generated because you did not. Replaying this exact key returns this exact payment instead of
   * charging again — so if you generated nothing, persist this before you retry.
   */
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
  /**
   * **Simulator mode — for tests.** `collect()` and `collectAndWait()` create a *simulated*
   * payment instead of ringing a phone. Nothing else changes: a real sandbox payment row, real
   * Daraja result codes, a real signed webhook, and `status()` / `check()` / `wait()` behave
   * exactly as they always do.
   *
   * This is what makes your own charge path testable. Build the client this way in your test
   * setup, leave your `/api/pay` handler and your UI completely unchanged, and force the result
   * from the test:
   *
   * ```ts
   * const paylod = new Paylod(process.env.PAYLOD_TEST_KEY!, { simulate: true });
   *
   * const view = await startCheckout(order.id, "0712345678", attemptId);  // your code, unchanged
   * await paylod.simulate.outcome(view.paymentId!, "wrong_pin");          // no handset involved
   * expect((await readCheckout(view.paymentId!)).message).toMatch(/PIN/); // your code, unchanged
   * ```
   *
   * **Requires a `mp_test_` key** — the constructor throws {@link PaylodSandboxOnlyError}
   * immediately otherwise, so this flag can never point at production, even by accident.
   *
   * `idempotencyKey` is honoured here exactly as it is in production: the same key returns the
   * SAME simulated payment (same `paymentId`, no second row), a different key creates a new one.
   * So a test asserting "a double-click cannot charge twice" tests the real thing.
   */
  readonly simulate?: boolean;
}

export interface WaitOptions {
  /** Give up after this long. Default 120_000 ms (STK prompts expire around 60s). */
  readonly timeoutMs?: number;
  /** Called with each `pending` snapshot — handy for a "waiting for PIN…" spinner. */
  readonly onPoll?: (payment: Payment) => void;
  /** Abort the wait early. */
  readonly signal?: AbortSignal;
}
