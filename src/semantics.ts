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
 *   L2  EVIDENCE     A TERMINAL verdict requires evidence, in BOTH directions. A bare
 *                    `status: "success"` with no
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

import { canonicalCodeForm, classifyStkResult, ERROR_CATALOG } from "./daraja-catalog.js";
import { isValidReceipt } from "./grammar.js";
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
  /** A terminal failure code the CATALOG KNOWS (1032 cancelled, 2001 wrong PIN, 1 low balance, …). */
  | "failure"
  /**
   * A canonically-SHAPED code the catalog has never heard of (spec 1.5).
   *
   * Distinct from `failure` on purpose. The vendored classifier answers `failed` for any canonical
   * non-zero code, catalogued or not — it mirrors the payment engine and is right to be
   * conservative about SHAPE — but "I do not recognise this code" is not the same claim as "this
   * payment failed", and collapsing the two made an unknown code into settlement-grade evidence
   * of failure. It is not evidence at all: nobody has established what it means, so it cannot
   * prove a terminal outcome in either direction.
   */
  | "unknown"
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

/**
 * A receipt counts only if it MATCHES THE RECEIPT GRAMMAR — ten uppercase alphanumerics.
 *
 * This was a non-emptiness test (`trim() !== ""`), and that is the round-10 High. `""` and
 * `"   "` proved nothing, correctly — but so did `"[redacted]"`, and that one came back TRUE.
 * A credential echoed into `mpesaReceipt`, redacted by something upstream, left a nonblank
 * placeholder that this function read as settlement evidence: `{status:"success",
 * mpesaReceipt:"[redacted]"}` with no result code was reported PAID. The sanitizer manufactured
 * proof of payment out of a leak.
 *
 * A positive grammar refuses every placeholder, including the ones nobody has invented yet.
 * See `grammar.ts` for why this is not a blocklist.
 */
export function hasReceipt(payment: Pick<Payment, "mpesaReceipt">): boolean {
  return isValidReceipt(payment.mpesaReceipt);
}

/**
 * Does the catalog actually describe this code?
 *
 * Compared on the CANONICAL FORM only — never on a trimmed or coerced spelling — so this cannot
 * become a second, laxer way of matching a code (spec 1.1: a guard at one layer is not a guard
 * at the layer below). A code whose form is not canonical is not catalogued by definition, and
 * `canonicalCodeForm` has already refused it upstream.
 */
function isCataloguedCode(resultCode: unknown): boolean {
  const form = canonicalCodeForm(resultCode);
  return form.kind === "canonical" && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, form.code);
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
  const rawCodeEvidence: PaymentEvidence = hasResultCode(payment)
    ? ({ success: "success", failed: "failure", pending: "in_flight" } as const)[
        classifyStkResult(payment.resultCode, payment.resultDesc)
      ]
    : "none";

  // AN UNCATALOGUED CODE IS NOT EVIDENCE OF FAILURE (spec 1.5).
  //
  // The classifier says `failed` for every canonical non-zero code, because it is judging SHAPE
  // and a well-formed non-zero code is not a success. That is the correct answer to the question
  // it is asked. It is the wrong answer to the question the verdict table asks, which is what the
  // record PROVES — and a code no catalog entry describes proves nothing. `{status:"failed",
  // resultCode:77777}` used to resolve to a confident terminal `failed`, ending the wait on a
  // payment whose actual state nobody had established.
  //
  // The catalog is the authority on which codes have a known meaning, and it is the same table
  // the retryability decision already comes from — so this cannot drift from what the SDK claims
  // to know.
  //
  // A NON-CANONICAL code is `unknown` too (spec 3.5 row 7). `classifyStkResult` answers `pending`
  // for anything whose FORM it refuses — `"500.0"`, `" 1032"`, `"1.032e3"` — which is the right
  // conservative answer to "did this fail?" but reads here as `in_flight`, i.e. a positive claim
  // that the prompt is still live on the handset. A garbled code is not evidence of that either.
  // It is not evidence of anything, which is what `unknown` means.
  //
  // This loses none of the "still processing" safety net: that net (PENDING_DESC_RE) lives on the
  // CANONICAL-numeric branch of the classifier, and a non-canonical code returns from an earlier
  // branch without ever consulting the description. A canonical uncatalogued code whose prose
  // says "still under processing" is still classified pending and still resolves to `in_flight`.
  const codePresentButNotCanonical =
    hasResultCode(payment) && canonicalCodeForm(payment.resultCode).kind !== "canonical";

  const codeEvidence: PaymentEvidence =
    codePresentButNotCanonical ||
    (rawCodeEvidence === "failure" && !isCataloguedCode(payment.resultCode))
      ? "unknown"
      : rawCodeEvidence;

  if (!receiptSaysSuccess) return codeEvidence;
  // A receipt beside a code nobody can place is not a settlement we may act on.
  if (codeEvidence === "unknown") return "conflict";

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
 *   • A failure claim needs evidence too (L2 again). `failed` with NOTHING behind it proves no
 *     more than `success` with nothing behind it: `failed` is TERMINAL here — it stops `wait()`
 *     polling and it is what `verifyWebhook` requires before it will deliver a `payment.failed`
 *     — so an unbacked failure claim ends the wait on a payment that may still be mid-PIN.
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
 *   • A failure claim needs evidence too (L2 again). `failed` with NOTHING behind it proves no
 *     more than `success` with nothing behind it: `failed` is TERMINAL here — it stops `wait()`
 *     polling and it is what `verifyWebhook` requires before it will deliver a `payment.failed`
 *     — so an unbacked failure claim ends the wait on a payment that may still be mid-PIN.
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
    // spec 1.5 / 3.5 row 7. Nobody has established what this code means, so it is not evidence
    // in either direction and the claim beside it gets no vote.
    unknown: [
      "indeterminate",
      "the result code is well-formed but is not in the Daraja catalog, so its meaning has " +
        "never been established — an unrecognised code is not evidence that the payment failed",
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
    // spec 1.5 / 3.5 row 7. Nobody has established what this code means, so it is not evidence
    // in either direction and the claim beside it gets no vote.
    unknown: [
      "indeterminate",
      "the result code is well-formed but is not in the Daraja catalog, so its meaning has " +
        "never been established — an unrecognised code is not evidence that the payment failed",
    ],
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
    // L2, APPLIED SYMMETRICALLY. This cell used to read `failed`, on the argument that "the safe
    // action is the same either way" — do not ship, do not capture. That argument is wrong, and
    // it was the last place in this module where A CLAIM SUBSTITUTED FOR MISSING EVIDENCE.
    //
    // `failed` is not a neutral resting state in this SDK, it is a TERMINAL one with two live
    // consequences. `wait()` stops polling the moment the verdict leaves `pending`, so a bare
    // `{ status: "failed" }` — the shape a truncated row, a stubbed endpoint, a cached error
    // envelope or a partially-written record produces — ends the wait on a payment that may be
    // mid-PIN and about to succeed, and the customer is shown "Please try again" for a charge
    // that then settles. And `verifyWebhook` accepts a `payment.failed` event only when the
    // verdict is `failed`, so this cell was the one that let an evidence-free failure notice
    // through to a handler that reverses an order.
    //
    // We required evidence for `success` for exactly this reason and then took `failed` on
    // trust. Both directions lose money; the success direction loses it visibly, which is the
    // only reason it got the rule first. A record that proves nothing resolves to
    // `indeterminate`, which renders as `pending` — the wait continues, the webhook settles it,
    // and nothing terminal is reported on the strength of an unbacked assertion.
    //
    // NOTE what this deliberately does NOT change: `failed` beside a real catalog failure code
    // is still `failed` (the cell below), and the catalog still decides whether that code is
    // retryable. A cancelled or wrong-PIN payment is as retryable as it ever was.
    none: [
      "indeterminate",
      "status claims failed but the record carries neither a result code nor a receipt, so " +
        "there is no evidence the payment actually failed — reporting a terminal failure on an " +
        "unbacked claim stops the wait on a payment that may still be mid-PIN",
    ],
    failure: ["failed", "the payment failed terminally"],
    in_flight: [
      "in_flight",
      "status says failed but the result code means the prompt is still live and the " +
        "customer has not entered their PIN yet",
    ],
    // spec 1.5 / 3.5 row 7. Nobody has established what this code means, so it is not evidence
    // in either direction and the claim beside it gets no vote.
    unknown: [
      "indeterminate",
      "the result code is well-formed but is not in the Daraja catalog, so its meaning has " +
        "never been established — an unrecognised code is not evidence that the payment failed",
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
