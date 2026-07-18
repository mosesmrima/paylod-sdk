/**
 * THE semantic model for a payment record.
 *
 * ── Why this module exists ────────────────────────────────────────────────────────────────
 * Before this file, "is this payment paid?" was answered by a scatter of per-field checks
 * spread across `outcome.ts` and `validate.ts`. Each check was locally reasonable and the set
 * of them was collectively wrong, because nothing stated the RULES the fields have to satisfy
 * together. Four rounds of per-finding patching did not converge, and the holes that survived
 * were all of one kind — a body whose fields CONTRADICT each other being resolved in favour of
 * whichever field the code happened to read first:
 *
 *   • `{ status: "pending", resultCode: 0 }`  was reported **paid**, with a null receipt — a
 *     payment the server itself calls unfinished, treated as money in the bank.
 *   • `{ status: "failed", mpesaReceipt: "SFF6XYZ123", resultCode: 1032 }` was reported
 *     `cancelled` **and `retryable: true`** — i.e. the SDK told a merchant it was safe to
 *     charge again for a payment that carries an M-Pesa confirmation receipt. That is a
 *     double-charge generator, and it is the single worst defect a payments SDK can have.
 *
 * Shape validation cannot catch either one: both bodies are perfectly well-typed. What was
 * missing is a model of what the fields MEAN together. That is what this file is.
 *
 * ── The model ─────────────────────────────────────────────────────────────────────────────
 * A payment record makes ONE CLAIM (`status`) and carries EVIDENCE (`mpesaReceipt`,
 * `resultCode`). These are separate things and are never allowed to substitute for one
 * another. Evaluation is three stages:
 *
 *   1. EVIDENCE   — what the record PROVES, independent of what it claims.
 *   2. VERDICT    — the claim and the evidence resolved together, via one total table.
 *   3. LAWS       — invariants the table is required to satisfy (asserted in the tests).
 *
 * ── The four laws ─────────────────────────────────────────────────────────────────────────
 * These are the contract. The sibling PHP / Python / JVM SDKs mirror THESE, not the code.
 *
 *   L1  BINDING      A record whose `id` is not the id that was requested is never evaluated
 *                    at all. It is a hard error. (Enforced at the transport boundary, in
 *                    `validate.ts` — a wrong-payment body must not even reach this file.)
 *   L2  EVIDENCE     `paid` requires SUCCESS evidence. A bare `status: "success"` with no
 *                    receipt and no result code proves nothing and is never paid. Note the
 *                    converse is NOT required: success WITHOUT a receipt is legitimate,
 *                    because receipts attach asynchronously — result code 0 is equally good
 *                    evidence. We require evidence of ONE kind, never a receipt outright.
 *   L3  CONSISTENCY  A claim that contradicts its evidence is INDETERMINATE — never a
 *                    failure, and in particular never a RETRYABLE failure. We cannot prove
 *                    money did not move, so we must not invite a second charge.
 *   L4  RECEIPT      A receipt is proof money moved. Its presence forces the verdict to
 *                    `paid` or `indeterminate` — never `failed`, never `in_flight`.
 *
 * The asymmetry in L3 is deliberate and is the whole safety argument: an indeterminate
 * payment is rendered as `pending` so `wait()` keeps polling and lets the webhook settle it,
 * rather than reporting a false success (merchant ships goods that were never paid for) or a
 * false retryable failure (merchant charges the customer twice).
 */

import { classifyStkResult } from "./daraja-catalog.js";
import type { Payment } from "./types.js";

/**
 * What the record PROVES, derived only from `mpesaReceipt` and `resultCode`. The `status`
 * field is deliberately not an input here — a claim is not evidence for itself.
 */
export type PaymentEvidence =
  /** Nothing to go on: no receipt, no result code. Proves neither direction. */
  | "none"
  /** A receipt, or result code 0. Money moved. */
  | "success"
  /** A terminal failure code (1032 cancelled, 2001 wrong PIN, 1 low balance, …). */
  | "failure"
  /** A pending code (4999, 500.001.1001), or a code we cannot place. Still on the handset. */
  | "in_flight"
  /** The evidence disagrees with ITSELF — e.g. a receipt alongside a cancellation code. */
  | "conflict";

/**
 * The resolved state of a payment. This is the type every caller branches on.
 *
 * `indeterminate` is not a failure mode of the SDK — it is a real, expected state of a real
 * payment, and treating it as anything else is what loses money in both directions.
 */
export type PaymentVerdict =
  /** Money moved, and we can prove it. Fulfil the order. */
  | "paid"
  /** Terminal, no money moved. Safe to charge again IF the catalog says the code is retryable. */
  | "failed"
  /** Still on the handset. Keep polling. NEVER retry — the prompt is live. */
  | "in_flight"
  /** We cannot prove what happened. Never paid, never retryable. Let the webhook settle it. */
  | "indeterminate";

export interface PaymentJudgement {
  readonly verdict: PaymentVerdict;
  readonly evidence: PaymentEvidence;
  /** The record's own `status` field — what it CLAIMED, for diagnostics. */
  readonly claimed: Payment["status"];
  /** Why this verdict, in one human sentence. Goes into logs and error messages, never to a customer. */
  readonly reason: string;
}

/** A receipt counts only if it is a non-blank string. `""` and `"   "` prove nothing. */
export function hasReceipt(payment: Pick<Payment, "mpesaReceipt">): boolean {
  return typeof payment.mpesaReceipt === "string" && payment.mpesaReceipt.trim() !== "";
}

/** A result code is "present" if it is neither null nor undefined. `0` is present and meaningful. */
export function hasResultCode(payment: Pick<Payment, "resultCode">): boolean {
  return payment.resultCode !== null && payment.resultCode !== undefined;
}

/**
 * Stage 1 — what the record proves, ignoring what it claims.
 *
 * The receipt and the result code are two independent witnesses. When they agree, or when only
 * one of them speaks, the answer is theirs. When they DISAGREE the answer is `conflict`, which
 * L3 sends straight to `indeterminate`: a receipt beside a cancellation code is not a
 * cancellation with a stray field, it is a record we have no business acting on.
 */
export function evidenceFor(payment: Payment): PaymentEvidence {
  const receiptSaysSuccess = hasReceipt(payment);

  // `classifyStkResult` is the canonical classifier the payment engine itself uses, so the SDK
  // cannot drift from the backend about what 4999 means. It maps blank/unknown codes to
  // "pending" on purpose — we refuse to force-fail on ambiguity.
  const codeEvidence: PaymentEvidence = hasResultCode(payment)
    ? ({ success: "success", failed: "failure", pending: "in_flight" } as const)[
        classifyStkResult(payment.resultCode, payment.resultDesc)
      ]
    : "none";

  if (!receiptSaysSuccess) return codeEvidence;

  // A receipt is present. It agrees with success evidence and with silence; it CONTRADICTS a
  // terminal failure code and an in-flight code alike — a receipt means M-Pesa has settled,
  // which is incompatible with "still on the handset".
  if (codeEvidence === "success" || codeEvidence === "none") return "success";
  return "conflict";
}

/**
 * Stage 2 — the claim and the evidence resolved together.
 *
 * This table is TOTAL: every (claim, evidence) pair has exactly one verdict, and the pairs are
 * enumerated rather than derived, so adding a status or an evidence kind is a compile error
 * rather than a silent fallthrough to some default. The defaults are where the old code went
 * wrong, so there are none.
 *
 * Reading the table, the rules are:
 *   • Success evidence beside a non-success claim is never paid and never failed — the two
 *     signals contradict, so it is indeterminate (L3 + L4).
 *   • A success claim needs evidence to be believed (L2).
 *   • A failure claim is believed on failure evidence or on silence: proving a payment did NOT
 *     happen is not something we require evidence for, because the safe action (do not ship,
 *     do not capture) is the same either way.
 *   • In-flight evidence outranks a terminal `failed` claim: a `failed` row carrying 4999
 *     means the prompt is STILL LIVE and the customer is mid-PIN. Reporting that as a failure
 *     is the revenue-losing bug this codebase already shipped twice.
 */
/** One resolved cell: the verdict, and the one sentence that explains it. */
type Cell = readonly [PaymentVerdict, string];

/**
 * A shared reason, used by every `conflict` cell. The two witnesses disagree with EACH OTHER, so
 * the claim cannot break the tie no matter what it says.
 */
const CONFLICT_REASON =
  "the record carries an M-Pesa receipt alongside a result code that is not a success — " +
  "the receipt proves money moved and the code denies it, so neither can be trusted";

/**
 * THE TABLE. Every (claim, evidence) pair, written out.
 *
 * ── Why this is a table and not a switch ──────────────────────────────────────────────────
 * The previous version was a nested `switch` whose arms all returned, plus a trailing
 * `return of("indeterminate", …)` that TypeScript demands and that nothing could reach. That
 * shape is exactly what the sibling SDKs got caught by twice: a switch with a reachable tail is
 * one missing `case` away from silently resolving a claim on the strength of its evidence, and
 * the tail hides the omission instead of surfacing it. Python "fixed" precisely this hole in an
 * earlier round and STILL let `pending` + result code 0 resolve to PAID, because the fix was
 * another branch rather than a structure that cannot have a gap.
 *
 * As a mapped type over `Payment["status"] x PaymentEvidence` there is no tail and no default:
 * omitting a single cell is a COMPILE ERROR, and adding a status or an evidence kind breaks the
 * build until every new pair has been decided deliberately. `test/semantics.test.ts` asserts the
 * full 3 x 5 cross-product, so a wrong cell fails a test rather than defaulting quietly.
 *
 * The rules the cells encode:
 *   • Success evidence beside a non-success claim is never paid and never failed — the two
 *     signals contradict, so it is indeterminate (L3 + L4).
 *   • A success claim needs evidence to be believed (L2).
 *   • A failure claim is believed on failure evidence or on silence: proving a payment did NOT
 *     happen is not something we require evidence for, because the safe action (do not ship,
 *     do not capture) is the same either way.
 *   • In-flight evidence outranks a terminal `failed` claim: a `failed` row carrying 4999
 *     means the prompt is STILL LIVE and the customer is mid-PIN. Reporting that as a failure
 *     is the revenue-losing bug this codebase already shipped twice.
 *   • `conflict` is indeterminate under every claim — the claim never gets a vote.
 */
const VERDICTS: {
  readonly [Claim in Payment["status"]]: { readonly [E in PaymentEvidence]: Cell };
} = {
  success: {
    success: ["paid", "status is success and it is backed by a receipt or result code 0"],
    // L2. This is the "a stubbed endpoint / truncated row / cached proxy envelope can write six
    // characters of JSON" case. A claim with nothing behind it is not money.
    none: [
      "indeterminate",
      "status claims success but the record carries neither a receipt nor a result code, " +
        "so there is no evidence the payment actually settled",
    ],
    failure: ["indeterminate", "status claims success but the result code is a terminal failure"],
    in_flight: [
      "indeterminate",
      "status claims success but the result code says the payment is still in flight",
    ],
    conflict: ["indeterminate", CONFLICT_REASON],
  },

  pending: {
    // THE named hole. `{ status: "pending", resultCode: 0 }` used to come back paid, with a null
    // receipt. A record that simultaneously says "not finished" and "succeeded" is not a success
    // we may act on — it is a record mid-write, or one we are misreading.
    success: [
      "indeterminate",
      "status says pending while the evidence says the payment succeeded — a pending " +
        "record must never be reported as paid",
    ],
    none: ["in_flight", "the payment is still on the handset"],
    failure: ["indeterminate", "status says pending while the result code is a terminal failure"],
    in_flight: ["in_flight", "the payment is still on the handset"],
    conflict: ["indeterminate", CONFLICT_REASON],
  },

  failed: {
    // L4. Includes the receipt-on-a-failed-row case that used to be rendered as
    // `cancelled, retryable: true` — an explicit invitation to charge twice.
    success: [
      "indeterminate",
      "status claims failed but the evidence proves the payment succeeded — refusing to " +
        "report a payment that carries proof of settlement as a failure",
    ],
    none: ["failed", "the payment failed terminally"],
    failure: ["failed", "the payment failed terminally"],
    in_flight: [
      "in_flight",
      "status says failed but the result code means the prompt is still live and the " +
        "customer has not entered their PIN yet",
    ],
    conflict: ["indeterminate", CONFLICT_REASON],
  },
};

export function judge(payment: Payment): PaymentJudgement {
  const evidence = evidenceFor(payment);
  const claimed = payment.status;

  // The claim is INPUT, and input is validated before it is looked up — it is not resolved by a
  // default. `assertPaymentBody` / `verifyWebhook` already reject a status outside the union, so
  // this is only reachable when `judge` is called directly with an unchecked record. An
  // unrecognised claim is not evidence of anything, so the answer is "we do not know" — never a
  // verdict derived from the evidence alone, which is the substitution this whole module exists
  // to forbid.
  const row = Object.prototype.hasOwnProperty.call(VERDICTS, claimed)
    ? VERDICTS[claimed]
    : undefined;
  if (row === undefined) {
    return {
      verdict: "indeterminate",
      evidence,
      claimed,
      reason:
        `the record's status field is ${JSON.stringify(claimed)}, which is not a payment status ` +
        "this SDK recognises — an unreadable claim is resolved as indeterminate, never by " +
        "falling back to the evidence",
    };
  }

  const [verdict, reason] = row[evidence];
  return { verdict, evidence, claimed, reason };
}
