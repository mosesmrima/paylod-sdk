/**
 * Offline M-Pesa result-code catalog.
 *
 * PORTED VERBATIM from the paylod backend:
 *   supabase/functions/_shared/daraja/error-catalog.ts
 *
 * The strings here are byte-for-byte the same strings the API returns in the `decoded`
 * field of a `payment.failed` webhook, so `paylod.decodeError(1032).customerMessage`
 * and `event.data.decoded.customerMessage` are always identical. Do not edit these
 * strings locally — mirror the backend catalog.
 */

/** WHO/what is at fault — lets a merchant tell their config apart from the customer or M-Pesa. */
export type DarajaCategory =
  | "customer"
  | "balance"
  | "limit"
  | "credentials"
  | "network"
  | "mpesa_system"
  /** Not a failure: the STK prompt is still live on the handset. Keep polling. */
  | "pending"
  | "success";

/** A decoded, human-readable error. Shape matches the `decoded` field on webhook events. */
export interface DecodedError {
  /** The original ResultCode, normalized to a string. */
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly category: DarajaCategory;
  readonly retryable: boolean;
  /** Safe to show a customer verbatim: `toast.error(err.customerMessage)`. */
  readonly customerMessage: string;
}

export const ERROR_CATALOG: Readonly<Record<string, Omit<DecodedError, "code">>> = {
  "0": {
    title: "Success",
    cause: "The STK Push transaction completed and the payment was received.",
    fix: "Treat the transaction as paid and fulfil the order.",
    category: "success",
    retryable: false,
    customerMessage: "Payment received — thank you!",
  },
  "1": {
    title: "Insufficient M-Pesa balance",
    cause:
      "The customer does not have enough M-Pesa balance (including any Fuliza overdraft) to cover the amount.",
    fix: "Nothing to fix on your side — ask the customer to top up M-Pesa and try again.",
    category: "balance",
    retryable: true,
    customerMessage: "Your M-Pesa balance is too low. Please top up and try again.",
  },
  "17": {
    title: "M-Pesa system internal error",
    cause:
      "Safaricom's system was temporarily unable to process the transaction — a transient M-Pesa-side error.",
    fix: "Wait ~30-45 seconds and retry the same request.",
    category: "mpesa_system",
    retryable: true,
    customerMessage: "M-Pesa had a hiccup. Please try again in a moment.",
  },
  "26": {
    title: "M-Pesa system busy",
    cause: "M-Pesa is under high load and rejected the request because the system was busy.",
    fix: "Back off and retry the same request after about 30 seconds.",
    category: "mpesa_system",
    retryable: true,
    customerMessage: "M-Pesa is busy right now. Please try again shortly.",
  },
  "1001": {
    title: "A transaction is already in process for this number",
    cause:
      "M-Pesa could not lock the subscriber — the customer's line already has an active M-Pesa/USSD session or an in-flight transaction.",
    fix:
      "Ask the customer to finish any open M-Pesa prompt, wait 1-3 minutes, then retry. Never fire two STK pushes to the same number at once.",
    category: "customer",
    retryable: true,
    customerMessage:
      "You have another M-Pesa request open. Please finish it, wait a minute, then try again.",
  },
  "1019": {
    title: "Transaction expired",
    cause:
      "The transaction exceeded its processing window because the customer took too long to act.",
    fix: "Let the customer re-initiate the payment and approve promptly.",
    category: "customer",
    retryable: true,
    customerMessage: "The request expired. Please try again and approve quickly.",
  },
  "1025": {
    title: "Error sending the STK prompt",
    cause:
      "M-Pesa could not send the STK prompt — usually a transient system error, or the request text exceeded 182 characters.",
    fix: "Keep TransactionDesc within 182 characters and retry; otherwise retry with backoff.",
    category: "mpesa_system",
    retryable: true,
    customerMessage: "We couldn't reach M-Pesa. Please try again in a moment.",
  },
  "9999": {
    title: "Error sending the STK prompt",
    cause:
      "The push could not be delivered — commonly a transient M-Pesa error, or the request text exceeds 182 characters.",
    fix: "Shorten the request fields and retry; otherwise retry with backoff as a transient M-Pesa error.",
    category: "mpesa_system",
    retryable: true,
    customerMessage: "We couldn't reach M-Pesa. Please try again in a moment.",
  },
  "1032": {
    title: "Payment cancelled by the customer",
    cause:
      "The customer received the STK prompt but pressed Cancel instead of entering their M-Pesa PIN. No money moved.",
    fix: "Nothing is wrong with your setup — offer a clear retry so the customer can try again.",
    category: "customer",
    retryable: true,
    customerMessage: "Payment cancelled — you can try again whenever you're ready.",
  },
  "1037": {
    title: "Timeout — the customer could not be reached",
    cause:
      "The STK prompt could not reach the phone or the customer did not respond in time (~60s). The phone may be off, out of coverage, or the PIN was never entered.",
    fix: "Ask the customer to confirm their phone is on with Safaricom network, then retry.",
    category: "network",
    retryable: true,
    customerMessage: "We couldn't reach your phone. Check your signal and try again.",
  },
  "2001": {
    title: "Wrong M-Pesa PIN",
    cause:
      "The customer entered the wrong M-Pesa PIN when approving the STK prompt. This is a customer input problem, NOT an issue with your credentials.",
    fix: "Nothing to change on your side — ask the customer to retry and enter their correct M-Pesa PIN.",
    category: "customer",
    retryable: true,
    customerMessage: "That M-Pesa PIN was incorrect. Please try again and enter the right PIN.",
  },
  // ── NOT errors: transient "still processing" STK Query states. ───────────────────────
  // The engine's classifier (`_shared/daraja/stk-outcome.ts`) maps these to `pending`, so a
  // payment carrying one is still payable and MUST NOT be shown to a customer as failed.
  // Catalogued so that if one is ever surfaced anyway it decodes honestly instead of hitting
  // the "Payment failed" fallback. `category: "pending"` is the flag to branch on.
  "4999": {
    title: "Still waiting for the customer's PIN",
    cause:
      "The STK prompt is live on the customer's phone and they have not entered their M-Pesa PIN yet. This is NOT a failure — the payment can still succeed.",
    fix: "Keep polling GET /status/:id (or wait for the webhook). Do not tell the customer it failed.",
    category: "pending",
    retryable: true,
    customerMessage: "Waiting for you to enter your M-Pesa PIN.",
  },
  "500.001.1001": {
    title: "Transaction is still being processed",
    cause:
      "M-Pesa is still processing this STK Push — the customer may not have entered their PIN yet. This is NOT a failure.",
    fix: "Keep polling GET /status/:id (or wait for the webhook). Do not tell the customer it failed.",
    category: "pending",
    retryable: true,
    customerMessage: "Waiting for you to enter your M-Pesa PIN.",
  },
  "2028": {
    title: "Payment amount exceeds the M-Pesa limit",
    cause:
      "The requested amount is above the customer's allowed M-Pesa transaction or wallet limit.",
    fix: "Ask the customer to pay a smaller amount, or split the payment.",
    category: "limit",
    retryable: false,
    customerMessage: "This amount is over your M-Pesa limit. Try a smaller amount.",
  },
  "2029": {
    title: "Buy Goods till sent as a Paybill request (or vice versa)",
    cause:
      "The transaction type does not match the shortcode (Till vs Paybill), so Daraja rejects the request.",
    fix:
      "Match the transaction type to the shortcode: CustomerBuyGoodsOnline + till for a till, CustomerPayBillOnline + paybill for a paybill.",
    category: "credentials",
    retryable: false,
    customerMessage: "We hit a setup error on our side. Please try again shortly.",
  },
  "401.002.01": {
    title: "Unauthorized — invalid or expired access token",
    cause: "The OAuth access token is missing, malformed, or expired (tokens have a ~1 hour TTL).",
    fix: "Request a fresh token and send it as an 'Authorization: Bearer <token>' header.",
    category: "credentials",
    retryable: true,
    customerMessage: "We hit an authentication error on our side. Please try again shortly.",
  },
  "404.001.03": {
    title: "Invalid access token",
    cause:
      "Daraja reports the token as invalid; often the shortcode is not authorized/whitelisted for that API.",
    fix: "Confirm the token is valid and contact Safaricom to whitelist the API on your shortcode.",
    category: "credentials",
    retryable: true,
    customerMessage: "We hit an authentication error on our side. Please try again shortly.",
  },
};

function fallback(code: string, rawDesc?: string): DecodedError {
  return {
    code,
    title: "Payment failed",
    cause:
      rawDesc && rawDesc.trim().length > 0
        ? rawDesc.trim()
        : "M-Pesa returned a non-zero ResultCode with no further detail.",
    fix: "Check the raw ResultDesc, verify your credentials + shortcode/till pairing, and retry.",
    category: "mpesa_system",
    retryable: true,
    customerMessage: "The payment didn't go through. Please try again.",
  };
}

/**
 * Decode an M-Pesa ResultCode into a normalized, human-readable error. Pure and offline —
 * no network call. Unknown codes fall back to a generic (retryable) failure, using `rawDesc`
 * as the cause when one is supplied.
 */
export function decodeError(
  resultCode: number | string | null | undefined,
  rawDesc?: string,
): DecodedError {
  const code = resultCode === null || resultCode === undefined ? "" : String(resultCode);
  const entry = ERROR_CATALOG[code];
  if (!entry) return fallback(code || "unknown", rawDesc);
  return { code, ...entry };
}
