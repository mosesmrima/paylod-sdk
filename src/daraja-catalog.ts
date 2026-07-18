// GENERATED FILE — DO NOT EDIT.
// Source of truth: mpesa/supabase/functions/_shared/daraja/daraja-catalog.ts
// Regenerate: node scripts/sync-daraja-catalog.mjs
/**
 * THE single source of truth for Daraja result-code meanings — classification AND decoding.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────────────────
 * This logic used to be duplicated FOUR times: `_shared/provider/mpesa.ts`, `reconciler/
 * logic.ts`, `web/lib/daraja-error-codes.json`, and `paylod-mcp/src/error-catalog.ts`. Each
 * copy drifted. That drift shipped a revenue-losing bug twice:
 *
 *   1. (commit 5f02a35) The STK Query classifier only knew ONE "still processing" code
 *      (`500.001.1001`) via a literal `===`. Daraja ALSO returns `4999` while the customer is
 *      still staring at the PIN prompt, so a live, fully-payable payment was reported `failed`.
 *   2. The MCP's `decode_mpesa_error` kept its own pre-5f02a35 copy of the code table, which
 *      had no `4999` entry at all. It therefore fell through to the generic failure fallback
 *      and told developers (and AI agents) that a mid-PIN-entry payment had FAILED and was
 *      RETRYABLE — inviting a retry of an in-flight charge, i.e. double-charging a customer.
 *
 * There is now ONE table (`daraja-error-codes.json`) and ONE classifier (this file). The
 * copies under `web/lib/` and `paylod-mcp/src/` are byte-identical artifacts emitted by
 * `scripts/sync-daraja-catalog.mjs` — never hand-edit them.
 *
 * ── The `retryable` contract ──────────────────────────────────────────────────────────────
 * `retryable` means **SAFE TO CHARGE AGAIN** — i.e. we know no money moved and no charge is
 * still in flight. It does NOT mean "the user could try again". Consequences:
 *   • A pending / in-flight payment is NEVER retryable. Retrying it double-charges.
 *   • An indeterminate outcome (unknown code) is NEVER retryable.
 *
 * ── STK Query semantics (/mpesa/stkpushquery/v1/query) ────────────────────────────────────
 * TRANSIENT — the prompt is still live on the handset. MUST be `pending`; failing these loses
 * real money, and retrying them takes real money twice.
 *   4999          "The transaction is still under processing" — customer has not entered their
 *                 PIN yet. Community-attested (Safaricom publishes no STK Query code table);
 *                 observed live in production against the paylod till.
 *   500.001.1001  "The transaction is being processed" — same meaning, different Daraja edge.
 *                 Arrives EITHER as a `ResultCode` on a 200 body OR as an `errorCode` on an
 *                 HTTP-500 body (which `stkQuery` throws) — hence `isPendingError`. NOTE this
 *                 code is an OVERLOADED bucket: see TERMINAL_500_MESSAGE_RE.
 *
 * TERMINAL SUCCESS
 *   0             Processed successfully. (Officially documented.)
 *
 * TERMINAL FAILURE — the prompt is dead; this CheckoutRequestID will never complete.
 *   1     Insufficient balance.            1032  Cancelled by the user.
 *   1001  Unable to lock subscriber.       1037  DS timeout / user unreachable (~60s).
 *   1019  Transaction expired.             2001  Wrong M-PESA PIN.
 *   17/26 M-Pesa internal error / busy.
 *
 * AMBIGUOUS (blank / unparseable / unknown non-numeric) → `pending`. We refuse to force-fail
 * on ambiguity; the reconciler's wall-clock cap is the ONLY thing allowed to terminate a
 * payment we cannot classify.
 */

import catalogData from "./daraja-error-codes.json" with { type: "json" };

// ─── Types ────────────────────────────────────────────────────────────────────────────────

export type StkOutcome = "pending" | "success" | "failed";

/** WHO/what is at fault — lets a merchant tell their config apart from the customer or M-Pesa. */
export type DarajaCategory =
  | "customer"
  | "balance"
  | "limit"
  | "credentials"
  | "network"
  | "mpesa_system"
  | "pending"
  | "success";

/**
 * Which Daraja surface a code came from. The SAME numeric code means different things on
 * different surfaces (e.g. 2001 = wrong PIN on STK, but invalid initiator on B2C), so the
 * family disambiguates.
 */
export type DarajaFamily = "stk_result" | "api_error" | "b2c_c2b_result";

/** One catalog entry, as stored in `daraja-error-codes.json`. */
export interface CatalogEntry {
  code: string;
  family: DarajaFamily;
  title: string;
  /** Plain-English "what happened". */
  cause: string;
  /** Actionable "what to do" for the merchant/developer. */
  fix: string;
  category: DarajaCategory;
  /** SAFE TO CHARGE AGAIN — not merely "the user could try again". See the contract above. */
  retryable: boolean;
  /** Short, friendly line a merchant could show THEIR end-customer. */
  customerMessage: string;
  sources?: string[];
}

/** A decoded, human-readable error. Shape matches the `decoded` field on webhook events. */
export interface DecodedError {
  /** The original ResultCode, normalized to a string. */
  code: string;
  title: string;
  cause: string;
  fix: string;
  category: DarajaCategory;
  retryable: boolean;
  customerMessage: string;
}

// ─── The one table ────────────────────────────────────────────────────────────────────────

/** Every catalog entry, in file order. */
export const ALL_ENTRIES: readonly CatalogEntry[] = (catalogData as { codes: CatalogEntry[] })
  .codes;

/**
 * Codes that mean "still processing, poll again", derived FROM the table so the classifier and
 * the decoder can never disagree. Kept as a set (not an `===`) precisely because the one-code
 * version of this check is what caused the production bug. Compared as normalized STRINGS so
 * both `"4999"` and the number `4999` work.
 */
export const PENDING_RESULT_CODES: ReadonlySet<string> = new Set(
  ALL_ENTRIES.filter((e) => e.category === "pending").map((e) => e.code),
);

// ─── Classification (the payment engine's contract) ───────────────────────────────────────

/**
 * `ResultDesc` / `errorMessage` phrasings that mean "still processing", used as a safety net
 * when Daraja hands us a code we don't recognise. The message is better attested than the
 * numeric code, so a matching message wins over the "unknown code" path.
 */
const PENDING_DESC_RE =
  /\b(?:still\s+under\s+processing|is\s+being\s+processed|still\s+processing|being\s+processed)\b/i;

/**
 * The ONLY form a Daraja numeric result code is ever written in: bare decimal digits, no sign, no
 * leading zeros, no exponent, no radix prefix, no fractional part.
 *
 * This exists because `Number()` is not a format check. `Number("0e999")`, `Number("+0")`,
 * `Number("00")`, `Number("0.0")`, `Number("-0")` and `Number("0x0")` are all `0`, so classifying
 * success with `Number(raw) === 0` accepted six spellings of "I succeeded" that Daraja never
 * emits — and whoever controls the response body controls that string. The sibling PHP SDK
 * shipped precisely this and accepted `"0e999"`, `"+0"` and `"00"` as result-code zero.
 *
 * Anything failing this test is a code whose FORM we do not recognise. It is neither a success nor
 * a proven failure; it falls through to the ambiguity rule, which is `pending`.
 */
const CANONICAL_CODE_RE = /^(?:0|[1-9][0-9]*)$/;

/**
 * `500.001.1001` is an overloaded Daraja business-error bucket. Under the SAME code it also
 * returns hard, terminal configuration errors. Polling forever on those would be wrong, so a
 * 500.* whose message matches one of these is NOT treated as pending.
 */
const TERMINAL_500_MESSAGE_RE =
  /\b(?:wrong\s+credentials|merchant\s+does\s+not\s+exist|invalid\s+access\s+token|unable\s+to\s+lock\s+subscriber|insufficient\s+funds?)\b/i;

/** Normalize a `ResultCode` that Daraja may send as a string OR a number (defensive). */
function normalizeCode(resultCode: unknown): string {
  if (resultCode === null || resultCode === undefined) return "";
  return String(resultCode).trim();
}

/**
 * Classify a synchronous STK Query result. THE authoritative call — the decoder below defers
 * to this, so a stale or wrong table entry can never resurrect the 4999 bug.
 *
 * @param resultCode Daraja `ResultCode` — string ("0", "4999", "500.001.1001") or number.
 * @param resultDesc Daraja `ResultDesc` / `errorMessage`, used as a corroborating signal.
 */
export function classifyStkResult(
  resultCode: unknown,
  resultDesc?: string | null,
): StkOutcome {
  const raw = normalizeCode(resultCode);
  const desc = (resultDesc ?? "").trim();

  // A terminal 500.* config error must not be mistaken for "still processing".
  if (raw.startsWith("500.") && TERMINAL_500_MESSAGE_RE.test(desc)) return "failed";

  if (PENDING_RESULT_CODES.has(raw)) return "pending";

  // SUCCESS IS RECOGNISED BY EXACT FORM, NOT BY COERCION. Only the two representations the schema
  // permits — the number `0` and the string `"0"` — reach here as the normalized `"0"`. See
  // CANONICAL_CODE_RE for why `Number(raw) === 0` was a "declare yourself paid" primitive.
  if (raw === "0") return "success";

  if (CANONICAL_CODE_RE.test(raw)) {
    // A known-numeric, non-zero code is terminal — UNLESS the description says otherwise
    // (guards against a new "still processing" code we haven't catalogued yet).
    return PENDING_DESC_RE.test(desc) ? "pending" : "failed";
  }

  // Blank / non-numeric / unknown → never force-fail on ambiguity.
  return "pending";
}

/**
 * True when a thrown `stkQuery` error is really a "still processing" signal (an HTTP-500 body
 * carrying a pending errorCode) rather than a genuine transport/auth failure. Substring match
 * because `stkQuery` embeds the raw Daraja body text in the Error message.
 */
export function isPendingError(message: string | null | undefined): boolean {
  const s = message ?? "";
  if (TERMINAL_500_MESSAGE_RE.test(s)) return false;
  if (PENDING_DESC_RE.test(s)) return true;
  for (const code of PENDING_RESULT_CODES) {
    // Bare "4999" is too generic to substring-match against an arbitrary error body; only the
    // dotted business codes are safe to match on code alone.
    if (code.includes(".") && s.includes(code)) return true;
  }
  return false;
}

// ─── Decoding (the human/agent-facing contract) ───────────────────────────────────────────

/**
 * Pick the right entry for a code. The same code can appear in several families, so:
 *   1. The CLASSIFIER wins. If it says `pending`, only a `pending` entry may be used; if it
 *      says otherwise, a `pending` entry may NOT be used. This is what makes an overloaded
 *      code like 500.001.1001 ("still processing" vs "merchant does not exist") decode
 *      correctly off the ResultDesc, and what stops a bad table entry causing a false failure.
 *   2. Then prefer the caller's family (STK by default — it is the payment path).
 */
function pickEntry(
  code: string,
  family: DarajaFamily,
  outcome: StkOutcome,
): CatalogEntry | undefined {
  const matches = ALL_ENTRIES.filter((e) => e.code === code);
  if (matches.length === 0) return undefined;

  const consistent = matches.filter((e) =>
    outcome === "pending" ? e.category === "pending" : e.category !== "pending"
  );
  const pool = consistent.length > 0 ? consistent : [];
  if (pool.length === 0) return undefined;

  return pool.find((e) => e.family === family) ?? pool[0];
}

/** In-flight: NOT a failure, and NOT safe to charge again. */
function pendingFallback(code: string): DecodedError {
  return {
    code,
    title: "Payment still in progress",
    cause:
      "M-Pesa is still processing this payment — the customer has most likely not entered their " +
      "M-Pesa PIN yet. This is NOT a failure: the payment is still live and can still succeed.",
    fix:
      "Keep polling GET /status/:id (or wait for the webhook). Do NOT retry the charge — a retry " +
      "sends a second prompt and can double-charge the customer.",
    category: "pending",
    retryable: false,
    customerMessage:
      "Check your phone and enter your M-Pesa PIN to complete this payment.",
  };
}

/**
 * Unknown code. The outcome is INDETERMINATE — we cannot prove no money moved — so it is NOT
 * safely retryable. (The old fallback said `retryable: true`, which invited a blind re-charge.)
 */
function failedFallback(code: string, rawDesc?: string | null): DecodedError {
  const desc = (rawDesc ?? "").trim();
  return {
    code,
    title: "Payment failed",
    cause:
      desc.length > 0 ? desc : "M-Pesa returned a non-zero ResultCode with no further detail.",
    fix:
      "Check the raw ResultDesc, verify your credentials + shortcode/till pairing, and confirm " +
      "the payment's final state with GET /status/:id before charging again — this code is not " +
      "in the catalog, so we cannot prove no money moved.",
    category: "mpesa_system",
    retryable: false,
    customerMessage: "The payment didn't go through. Please try again.",
  };
}

/** Strip the internal-only fields off a catalog entry to produce a `DecodedError`. */
function decodedFrom(code: string, entry: CatalogEntry): DecodedError {
  const { code: _c, family: _f, sources: _s, ...rest } = entry;
  return { code, ...rest };
}

/**
 * Decode a Daraja ResultCode into a normalized, human-readable error.
 *
 * ── Family-awareness ──────────────────────────────────────────────────────────────────────
 * The STK "still processing → pending" semantics (and the blank/unknown-numeric → pending
 * fallback) apply ONLY to the STK result surface. A dotted `api_error` code (e.g. 400.002.02,
 * 500.001.1001) or an alphanumeric `b2c_c2b_result` code (e.g. C2B00011) is a TERMINAL error;
 * routing it through `classifyStkResult` used to misclassify it as `pending` and decode it as
 * "payment still in progress", which is wrong. So we select by family:
 *
 *   • STK family: defer to `classifyStkResult`, so 4999 / 500.001.1001 can never decode as a
 *     failure and can never be advertised as retryable.
 *   • Non-STK families: decode straight from the catalog by family — no pending semantics. This
 *     also disambiguates the OVERLOADED 500.001.1001, whose `api_error` entry is the terminal
 *     "merchant does not exist / insufficient funds" server error.
 *
 * If the caller asks for the (default) STK family but the code exists ONLY in non-STK families,
 * we decode it by its real family rather than letting the STK unknown→pending rule mislabel it.
 *
 * @param resultCode the Daraja ResultCode (number or string). `null`/`undefined` is treated as
 *   an unknown/indeterminate outcome.
 * @param rawDesc the raw ResultDesc — corroborating signal for the classifier, and the `cause`
 *   when the code is unknown.
 * @param family which Daraja surface the code came from. Defaults to the STK payment path.
 */
export function decodeDarajaResult(
  resultCode: number | string | null | undefined,
  rawDesc?: string | null,
  family: DarajaFamily = "stk_result",
): DecodedError {
  const code = normalizeCode(resultCode);

  // An ABSENT code is not evidence of an in-flight payment — it is simply unknown. (The
  // classifier maps blank → `pending` on purpose, but that is a *polling* decision for the
  // engine; for a human/agent-facing decode it would be a lie.) Indeterminate ⇒ not retryable.
  if (code === "") return failedFallback("unknown", rawDesc);

  const matches = ALL_ENTRIES.filter((e) => e.code === code);
  const hasStk = matches.some((e) => e.family === "stk_result");

  // If STK was requested but the code is not an STK code, decode it by the family it DOES have.
  const effectiveFamily: DarajaFamily =
    family === "stk_result" && !hasStk && matches.length > 0 ? matches[0]!.family : family;

  if (effectiveFamily === "stk_result") {
    const outcome = classifyStkResult(code, rawDesc);
    const entry = pickEntry(code, effectiveFamily, outcome);
    if (entry) return decodedFrom(code, entry);
    if (outcome === "pending") return pendingFallback(code);
    return failedFallback(code || "unknown", rawDesc);
  }

  // Terminal (api_error / b2c_c2b_result): no STK pending semantics, EVER. Select only the entry
  // for the requested family, or — failing that — another NON-STK entry for the same code.
  //
  // Falling back to `matches[0]` here was a live bug: a code that exists ONLY under `stk_result`
  // (e.g. 4999, "still waiting for the customer's PIN") would, when explicitly decoded as
  // `api_error` or `b2c_c2b_result`, come back as the STK *pending* entry — telling the caller a
  // terminal API/result failure was a payment still in flight. That is the exact "false pending"
  // shape of the 4999 double-charge bug, just reached from the other direction. An STK entry can
  // never describe a non-STK surface, so when no non-STK entry exists we return the terminal,
  // non-retryable fallback instead.
  const entry =
    matches.find((e) => e.family === effectiveFamily) ??
    matches.find((e) => e.family !== "stk_result");
  if (entry) return decodedFrom(code, entry);
  return failedFallback(code || "unknown", rawDesc);
}

/** Catalog entries keyed by ResultCode, STK-first. Back-compat for existing importers. */
export const ERROR_CATALOG: Record<string, Omit<CatalogEntry, "code">> = (() => {
  const out: Record<string, Omit<CatalogEntry, "code">> = {};
  for (const e of ALL_ENTRIES) {
    const { code, ...rest } = e;
    // STK is the payment path — it wins when a code appears in several families.
    if (!out[code] || e.family === "stk_result") out[code] = rest;
  }
  return out;
})();
