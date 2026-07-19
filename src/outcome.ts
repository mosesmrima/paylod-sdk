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
import { type DecodedError, decodeDarajaResult } from "./daraja-catalog.js";
import { judge } from "./semantics.js";
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
/**
 * Shown when the record contradicts itself — the raw `status` field says one terminal thing and
 * the decoded result code says another. We CANNOT prove money did or did not move, so this is an
 * indeterminate payment: never `paid`, never `retryable`. It is surfaced as `pending` so `wait()`
 * lets a webhook settle it (and ultimately throws `PaylodTimeoutError`, the SDK's indeterminate
 * signal) rather than reporting a false success or a false failure.
 */
const INDETERMINATE =
  "We couldn't confirm this payment yet. Please wait — do not retry — while it settles.";
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
  const detail = hasCode ? decodeDarajaResult(payment.resultCode, payment.resultDesc) : null;
  const code = detail?.code ?? null;

  // ── The whole decision, in one call ────────────────────────────────────────────────────
  //
  // Everything about "is this paid?" now lives in `semantics.ts` and is expressed as one total
  // table over (claim, evidence). This function no longer decides anything; it RENDERS. That
  // separation is the point: the rules used to be spread across a `contradictory` boolean, a
  // `classified ?? status` fallback chain and an evidence check nested inside the success branch,
  // and the gaps between those three were where `{ status: "pending", resultCode: 0 }` came back
  // paid and a receipt on a failed row came back `retryable: true`.
  const { verdict } = judge(payment);

  // THE DETAIL BLOCK IS RESOLVED AFTER THE VERDICT, NEVER BEFORE IT.
  //
  // `detail` is decoded from the result code ALONE — it is the catalog's opinion of that code in
  // isolation, and the catalog is right about it: 1032 taken by itself means "the customer
  // cancelled, no money moved, a fresh charge is safe". But `judge()` looks at the whole record,
  // and `{ status: "pending", resultCode: 1032 }` contradicts itself: the record claims the
  // payment is in flight and the code claims it is a dead cancellation. We cannot prove money did
  // or did not move, so the verdict is INDETERMINATE.
  //
  // Decoding first and spreading the result into every branch meant the top-level `retryable`
  // went `false` — correctly — while `detail.retryable` stayed `true` right beside it. Both are
  // PUBLIC fields on the returned object, both answer the same question, and they answered it
  // differently. `outcome.detail.retryable` is not an exotic thing to read: it is the field the
  // types invite you to reach for when you want the reason as well as the flag, and half of the
  // integrations that log an outcome log it. A nested `true` on a payment that may be live is an
  // invitation to charge the customer a second time, delivered by the object whose entire job is
  // to prevent exactly that. The JVM and Python siblings shipped the same defect.
  //
  // So there is ONE rule and it is applied at ONE point: `retryable` means SAFE TO CHARGE AGAIN,
  // and nothing is safe to charge again unless we have proven the charge is dead. Only a `failed`
  // verdict proves that, so every other verdict gets a detail block with `retryable: false`. The
  // rest of the decoded block — title, cause, fix, category, customerMessage — is untouched: it
  // is genuinely useful diagnostic text, and it is not a decision.
  const safeDetail = verdict === "failed" ? detail : withoutRetryability(detail);
  const base = { paymentId: payment.id, code, detail: safeDetail, payment } as const;

  if (verdict === "paid") {
    return {
      ...base,
      status: "succeeded",
      paid: true,
      retryable: false, // it worked — charging again would be a second charge
      receipt: payment.mpesaReceipt,
      message: detail?.customerMessage ?? "Payment received — thank you!",
    };
  }

  if (verdict === "indeterminate") {
    // Rendered as `pending` so `wait()` keeps polling and lets the webhook settle it, rather than
    // reporting a false success (goods shipped for nothing) or a false retryable failure (the
    // customer charged twice). Never paid, never retryable — those are the only two rules that
    // matter here, and both are unconditional.
    return {
      ...base,
      status: "pending",
      paid: false,
      retryable: false,
      receipt: null,
      message: INDETERMINATE,
    };
  }

  if (verdict === "in_flight") {
    return {
      ...base,
      status: "pending",
      paid: false,
      // THE double-charge guard. A live prompt is never safe to re-charge.
      retryable: false,
      receipt: null,
      // `detail` is only useful here if it's genuinely a pending code (4999 / 500.001.1001);
      // anything else that classified as pending has no meaningful customer message.
      message: detail && detail.category === "pending" ? detail.customerMessage : WAITING,
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

/**
 * A decoded block with its `retryable` forced to `false`, everything else preserved.
 *
 * Returns a NEW object — the catalog's entries are shared, frozen-in-spirit singletons, and
 * mutating one would flip `retryable` for every other caller that ever decodes that code.
 */
function withoutRetryability(detail: DecodedError | null): DecodedError | null {
  if (detail === null) return null;
  if (detail.retryable === false) return detail;
  return { ...detail, retryable: false };
}
