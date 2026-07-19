/**
 * THE POSITIVE GRAMMARS for evidence and identifiers.
 *
 * ── Why this module exists ────────────────────────────────────────────────────────────────
 * Every evidence and identifier check in this SDK used to be a NON-EMPTINESS test:
 * `typeof x === "string" && x.trim() !== ""`. That is not a grammar, it is the absence of one,
 * and it accepts every string a hostile or merely broken producer can construct — including the
 * output of a REDACTOR.
 *
 * That is not hypothetical. The sibling PHP SDK shipped the defect and round 9 closed it there;
 * round 10 found the identical hole still open here. The shape is:
 *
 *     { "status": "success", "mpesaReceipt": "[redacted]" }
 *
 * A credential landed in the receipt field, something upstream redacted it, and the placeholder
 * that redaction left behind was NONBLANK — so `hasReceipt` said yes, `evidenceFor` said
 * "success", and the judge reported PAID for a payment with no receipt and no result code. The
 * sanitizer turned a leak into a false settlement: strictly worse than the leak.
 *
 * The fix is not to blocklist `[redacted]`. A blocklist is another non-emptiness test wearing a
 * hat — `***`, `<hidden>`, `U+FFFD` and whatever the next sanitizer emits all walk past it. The
 * fix is a POSITIVE grammar: state what a receipt IS, and refuse everything else. Every
 * placeholder any sanitizer has ever produced fails `^[A-Z0-9]{10}$` for free, and so does the
 * one nobody has written yet.
 *
 * ── On `$` versus `\z` (spec 7.1) ─────────────────────────────────────────────────────────
 * In PCRE, Python `re` and Java, `$` also matches BEFORE a trailing newline, so `"SFF6XYZ123\n"`
 * satisfies a `$`-anchored pattern and the siblings must use `\z` / `\Z` / `fullmatch`.
 * JavaScript's `$` does NOT have that behaviour without the `m` flag, so `$` is exact here. It is
 * doubly exact in this case because `[A-Z0-9]` cannot match a newline at all, so the character
 * class closes the hole a second time even if the anchor were wrong. The patterns below carry no
 * `m` flag, deliberately.
 */

/**
 * THE receipt grammar: exactly ten uppercase alphanumerics.
 *
 * Derived from every real M-Pesa receipt in the paylod fixtures — `SFF6XYZ123`, `QGR1ABCDEF`,
 * `UG1F3A1U7J`. Safaricom's confirmation codes are a fixed-width ten-character uppercase
 * alphanumeric token, and nothing else is a receipt. The sibling SDKs match this exact grammar,
 * so a body that is evidence in one SDK is evidence in all four.
 */
const RECEIPT_RE = /^[A-Z0-9]{10}$/;

/**
 * THE identifier grammar, for every server-issued correlation handle: `paymentId`,
 * `checkoutRequestId`, `applicationId`.
 *
 * Unlike the receipt these are opaque to the SDK — paylod may change their shape — so the
 * grammar is deliberately permissive about CONTENT and strict about CHARACTER SET. What it must
 * exclude is the class of values that are not identifiers at all: sanitizer placeholders
 * (`[redacted]`, `<hidden>`, `***`), the Unicode replacement character a lossy decode leaves
 * behind, whitespace, and control bytes. The bracket, angle, asterisk and space characters are
 * absent from the class, so every placeholder shape fails on its own punctuation.
 *
 * 128 characters is far above any real paylod identifier and bounds what can be interpolated
 * into a diagnostic or stored on an error.
 */
const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Is this string a valid M-Pesa receipt — i.e. real settlement EVIDENCE?
 *
 * This is the single predicate behind every receipt check in the SDK. A value that fails it is
 * not "a receipt we could not read", it is NOT A RECEIPT, and it must contribute nothing to any
 * verdict in either direction.
 */
export function isValidReceipt(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_RE.test(value);
}

/**
 * Is this string a usable server-issued identifier?
 *
 * Used for `paymentId`, `checkoutRequestId` and `applicationId` on every surface that returns
 * one to the caller or correlates on one. A placeholder that reached an identifier field is a
 * body we do not understand, and correlating on it silently binds a caller's records to a
 * payment that is not theirs.
 */
export function isValidIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

/**
 * Does this string LOOK like the output of a sanitizer?
 *
 * The positive grammars above are the real defence and they already refuse every one of these.
 * This predicate exists for the ONE surface with no positive grammar available: the
 * caller-supplied idempotency key, which is deliberately opaque (a UUID, a database primary key,
 * an application-specific attempt id) and therefore cannot be given a shape.
 *
 * The hazard there is a caller who reads a key back out of their own REDACTED logs and replays
 * it. Two different attempts both logged as `[redacted]` collapse to one key, which is a payment
 * silently not made; or a real key is replaced by a placeholder shared with every other redacted
 * attempt in the system, which is a payment charged against the wrong record. Both are the
 * double-charge guard failing in the direction that looks like it is working.
 *
 * U+FFFD is included because a replacement character means bytes were LOST — see the strict
 * decoders in `transport.ts` and `webhook.ts` (spec 2.6). Distinct wire values that collapse
 * into the same string are not identifiers, whatever else they are.
 */
/**
 * CREDENTIAL SHAPES, redacted whether or not this client was configured with the value.
 *
 * Spec 4.1 forbids two distinct things from reaching output: a CONFIGURED credential, and any
 * value MATCHING A CREDENTIAL SHAPE. The client only ever matched the first — it scrubbed
 * `this.#apiKey` and `this.#webhookSecret` by exact string — so a credential that was not this
 * client's own sailed through untouched. That is not a corner case: a rotated-out key still
 * present in an upstream config, a sibling service's key echoed back by a shared proxy, another
 * tenant's token in a mirrored debug envelope, or a `Bearer` header quoted verbatim in a 4xx are
 * all real, and all of them are still somebody's live credential.
 *
 * An exact-match redactor cannot know about any of them. A shape scan does not need to.
 *
 * The `Bearer` arm is deliberately broad — the token after it is opaque by definition, so the
 * only safe reading is "everything up to whitespace".
 */
const CREDENTIAL_SHAPE_RE =
  /\b(?:mp_live_|mp_test_|whsec_|sk_)[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

/**
 * Replace every credential-SHAPED substring, independent of configuration.
 *
 * Runs alongside the exact-match scrub, never instead of it: a configured secret that does not
 * happen to match one of these prefixes still has to be removed, and a shaped value that is not
 * configured still has to be removed. Neither is a superset of the other.
 */
export function redactCredentialShapes(text: string): string {
  return text.replace(CREDENTIAL_SHAPE_RE, "[redacted]");
}

export function looksSanitized(value: string): boolean {
  if (value.includes("�")) return true;
  // Bracketed / angled placeholders: `[redacted]`, `<hidden>`, `[REDACTED: too deep]`.
  if (/[[\]<>]/.test(value)) return true;
  // Masking runs: `***`, `xxxx`, `----` used as a stand-in rather than as content.
  if (/(\*{2,}|•{2,})/.test(value)) return true;
  return /redact|scrub|sanitiz|sanitis|hidden|masked/i.test(value);
}
