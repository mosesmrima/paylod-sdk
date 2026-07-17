/**
 * Kenyan MSISDN normalisation — the REFERENCE implementation of the canonical spec.
 *
 * Mirrors the server's `normalizePhone` (supabase/functions/_shared/daraja/primitives.ts)
 * so the SDK rejects a bad number locally instead of burning a round-trip on a 422.
 * Accepts `0712345678`, `+254712345678`, `254712345678`, `712345678`, with or without
 * spaces/dashes. Emits the canonical `2547XXXXXXXX` / `2541XXXXXXXX` form.
 *
 * These are separate npm packages, so a shared module is impossible — keep this byte-identical
 * with the copies (a divergence is a real bug):
 *   - paylod-cli/src/lib/phone.ts
 *   - paylod-mcp/src/phone.ts
 *   - mpesa _shared/daraja/primitives.ts (canonical backend copy)
 *
 * Two shapes: MSISDN_INPUT_RE validates RAW input; the normalizer strips non-digits and
 * emits the wire form matching /^254[17]\d{8}$/.
 */

import { PaylodInvalidRequestError } from "./errors.js";

/** Validates RAW user input in any accepted Kenyan form (before normalization). */
export const MSISDN_INPUT_RE = /^(?:\+?254|0)?[17]\d{8}$/;

/** True if `input` is an acceptable Kenyan MSISDN form. Does not throw. */
export function isValidMsisdn(input: string): boolean {
  return typeof input === "string" && MSISDN_INPUT_RE.test(input.trim());
}

export function normalizePhone(input: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new PaylodInvalidRequestError("phone is required");
  }
  const digits = input.replace(/\D+/g, "");

  let msisdn: string;
  if (digits.startsWith("254")) {
    msisdn = digits;
  } else if (digits.startsWith("0")) {
    msisdn = `254${digits.slice(1)}`;
  } else if (digits.startsWith("7") || digits.startsWith("1")) {
    msisdn = `254${digits}`;
  } else {
    throw new PaylodInvalidRequestError(`unrecognized Kenyan phone format: ${input}`);
  }

  if (!/^254[17]\d{8}$/.test(msisdn)) {
    throw new PaylodInvalidRequestError(`not a valid Kenyan phone number: ${input}`);
  }
  return msisdn;
}

/** Canonical alias so every package exports the same name (`normalizeMsisdn`). */
export const normalizeMsisdn = normalizePhone;
