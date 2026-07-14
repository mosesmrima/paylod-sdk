/**
 * Kenyan MSISDN normalisation.
 *
 * Mirrors the server's `normalizePhone` (supabase/functions/_shared/daraja/primitives.ts)
 * so the SDK rejects a bad number locally instead of burning a round-trip on a 422.
 * Accepts `0712345678`, `+254712345678`, `254712345678`, `712345678`, with or without
 * spaces/dashes. Emits the canonical `2547XXXXXXXX` / `2541XXXXXXXX` form.
 */

import { PaylodInvalidRequestError } from "./errors.js";

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
