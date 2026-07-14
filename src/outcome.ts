/**
 * The renderable payment outcome.
 *
 * ── The problem this type solves ──────────────────────────────────────────────────────────
 * v0.1 handed back a discriminated union (`{ ok: true, receipt } | { ok: false, error }`) and
 * a `DecodedError`. To show a human anything, an integrator had to branch — and to branch
 * *correctly* they had to know that `category === "pending"` is not a failure, and that
 * `retryable` is not the same question as "should I show a retry button". In other words we
 * had moved the Daraja result-code table out of their backend and into their frontend. That is
 * a relocation, not an improvement.
 *
 * A `PaymentOutcome` is already renderable:
 *
 * ```tsx
 * <p>{outcome.message}</p>
 * {outcome.retryable && <button onClick={retry}>Try again</button>}
 * ```
 *
 * No `if` over result codes. No catalog in the UI. No M-Pesa knowledge in the app at all.
 *
 * ── The two invariants ────────────────────────────────────────────────────────────────────
 * 1. `retryable` means SAFE TO CHARGE AGAIN — we know no money moved and nothing is still in
 *    flight. It does NOT mean "the user is allowed to press a button". A `pending` payment is
 *    therefore NEVER retryable: codes 4999 / 500.001.1001 mean the STK prompt is live on the
 *    handset and the customer simply has not typed their PIN yet. Retrying pushes a SECOND
 *    prompt and can double-charge them. This is a real bug that shipped twice.
 * 2. An indeterminate payment is not a failed payment. `wait()` THROWS `PaylodTimeoutError`
 *    rather than folding a timeout into `status: "failed"`, because a customer staring at a
 *    live prompt may still pay, and a merchant who cancels that order loses real money.
 */
import {
  type DecodedError,
  classifyStkResult,
  decodeDarajaResult,
} from "./daraja-catalog.js";
import type { Payment } from "./types.js";

/**
 * The whole vocabulary. Four words, deliberately.
 *
 * - `succeeded` — money moved. Fulfil the order.
 * - `pending`   — still in flight. Keep polling. NEVER retry.
 * - `cancelled` — the customer pressed Cancel. No money moved; a fresh charge is safe.
 * - `failed`    — everything else terminal (wrong PIN, low balance, M-Pesa error).
 */
export type OutcomeStatus = "succeeded" | "pending" | "cancelled" | "failed";

export interface PaymentOutcome {
  readonly status: OutcomeStatus;

  /**
   * A customer-facing sentence, already decoded from the M-Pesa result code. Safe to render
   * verbatim. This is the field the happy path is built on — you should never need to look at
   * `code` to show a human what happened.
   */
  readonly message: string;

  /**
   * SAFE TO CHARGE AGAIN — i.e. we know no money moved and no charge is still in flight.
   * Gate your retry button on exactly this. It is `false` for `pending` and for `succeeded`.
   */
  readonly retryable: boolean;

  /** The one branch a *backend* legitimately needs: `if (outcome.paid) fulfil(order)`. */
  readonly paid: boolean;

  readonly paymentId: string;
  /** The M-Pesa confirmation code (e.g. `SFF6XYZ123`). Non-null exactly when `paid`. */
  readonly receipt: string | null;

  // ── Developer detail. Available, never required to render the happy path. ──
  /** The raw M-Pesa `ResultCode`, normalized to a string. `null` when M-Pesa hasn't spoken. */
  readonly code: string | null;
  /** Title / cause / fix / category, for logs, support tickets and dashboards. */
  readonly detail: DecodedError | null;
  /** The raw payment record, for anything the above doesn't cover. */
  readonly payment: Payment;
}

/** Shown while the prompt is live but M-Pesa has not given us a code to decode yet. */
const WAITING = "Check your phone and enter your M-Pesa PIN to complete this payment.";
const CANCELLED_CODE = "1032";

/**
 * The renderable form of a freshly-sent STK prompt.
 *
 * `collect()` hands back an ack, not a payment — but a prompt sitting on a handset IS a pending
 * payment, and a UI wants to render it the same way it renders every other state. This saves you
 * from hand-writing a "check your phone" string (and from getting `retryable` wrong on it: a live
 * prompt is never safe to re-charge).
 *
 * ```ts
 * const ack = await paylod.collect({ amount, phone });
 * return pendingOutcome(ack.paymentId);   // same shape as check() / wait()
 * ```
 */
export function pendingOutcome(paymentId: string): PaymentOutcome {
  return {
    status: "pending",
    message: WAITING,
    retryable: false, // the prompt is live — a second charge is exactly what we must not do
    paid: false,
    paymentId,
    receipt: null,
    code: null,
    detail: null,
    payment: {
      id: paymentId,
      status: "pending",
      mpesaReceipt: null,
      resultCode: null,
      resultDesc: null,
    },
  };
}

/**
 * Build a renderable outcome from a payment record.
 *
 * The classification is delegated to `classifyStkResult`, the canonical classifier that the
 * payment engine itself uses. That matters: it means the SDK cannot disagree with the backend
 * about whether 4999 is a failure, and a `status: "failed"` row carrying a pending code is
 * correctly reported as `pending` here rather than being rendered as a failure to a customer
 * who is, at that exact moment, typing their PIN.
 */
export function toOutcome(payment: Payment): PaymentOutcome {
  const hasCode = payment.resultCode !== null && payment.resultCode !== undefined;
  const detail = hasCode
    ? decodeDarajaResult(payment.resultCode, payment.resultDesc)
    : null;
  const code = detail?.code ?? null;

  // When M-Pesa has given us a code, the classifier is authoritative — that is what it is for.
  // Before then, the API's own status is all we have.
  const outcome = hasCode
    ? classifyStkResult(payment.resultCode, payment.resultDesc)
    : payment.status === "success"
      ? "success"
      : payment.status === "failed"
        ? "failed"
        : "pending";

  const base = { paymentId: payment.id, code, detail, payment } as const;

  if (outcome === "success" || payment.status === "success") {
    return {
      ...base,
      status: "succeeded",
      paid: true,
      retryable: false, // it worked — charging again would be a second charge
      receipt: payment.mpesaReceipt,
      message: detail?.customerMessage ?? "Payment received — thank you!",
    };
  }

  if (outcome === "pending") {
    return {
      ...base,
      status: "pending",
      paid: false,
      // THE double-charge guard. A live prompt is never safe to re-charge.
      retryable: false,
      receipt: null,
      // `detail` is only useful here if it's genuinely a pending code (4999 / 500.001.1001);
      // anything else that classified as pending has no meaningful customer message.
      message:
        detail && detail.category === "pending" ? detail.customerMessage : WAITING,
    };
  }

  // Terminal failure. Cancellation gets its own word: the customer chose this, it is not an
  // error, and a UI usually wants to say so more gently.
  return {
    ...base,
    status: code === CANCELLED_CODE ? "cancelled" : "failed",
    paid: false,
    // Straight from the canonical table, which defines `retryable` as "safe to charge again".
    retryable: detail?.retryable ?? false,
    receipt: null,
    message: detail?.customerMessage ?? "The payment didn't go through. Please try again.",
  };
}
