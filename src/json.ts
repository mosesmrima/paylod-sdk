/**
 * THE ONE JSON ENTRY POINT.
 *
 * Every untrusted document this SDK reads — an API response body and a signature-verified webhook
 * body alike — comes through here, because `JSON.parse` on its own destroys two things this SDK
 * needs before it is allowed to have an opinion about money:
 *
 *   1. THE STACK, when the document is deep enough. `JSON.parse` recurses, so a body that is
 *      within the byte cap but tens of thousands of levels deep is a `RangeError` thrown from
 *      inside the parser — and after `POST /collect` that RangeError loses the idempotency key
 *      for a charge that may already be live. The depth budget is enforced by SCANNING THE TEXT,
 *      before the parser is allowed to recurse at all.
 *
 *   2. THE NUMERIC LEXEME, always. This is the subtler and more expensive one, and it is a
 *      cross-SDK root: the PHP sibling scanned raw bytes for a literal `"resultCode"` key and was
 *      walked past with an escaped spelling; the Node sibling had no scan at all and was walked
 *      past by arithmetic. `JSON.parse` maps an unbounded family of DIFFERENT spellings onto the
 *      same IEEE-754 double:
 *
 *          {"resultCode": 0.0}      → 0     → "0"    → PAID
 *          {"resultCode": 0e999}    → 0     → "0"    → PAID
 *          {"resultCode": -0}       → -0    → caught by `canonicalCodeForm`, but only by luck
 *          {"resultCode": 1032.0}   → 1032  → "1032" → cancelled, RETRYABLE
 *          {"resultCode": 1.032e3}  → 1032  → "1032" → cancelled, RETRYABLE
 *
 *      `canonicalCodeForm` is strict about STRING spellings — `"0.0"` is refused — and it cannot
 *      be strict about numeric ones, because by the time it sees a `number` the spelling is gone.
 *      There is no value left to inspect. So the check has to happen HERE, on the text, which is
 *      the last point at which the bytes paylod actually sent still exist.
 *
 * ── Why this is a refusal and not a coercion ──────────────────────────────────────────────
 * paylod never emits `1032.0`. A body that does is not a body with a formatting quirk; it is a
 * body from something that is not paylod, or from something between us and paylod. Both money
 * directions are closed by refusing: a laundered `0.0` cannot fulfil an order, and a laundered
 * `1032.0` cannot invite the retry that charges the customer twice. The error is terminal and
 * says INDETERMINATE, so the caller reads the payment rather than minting a fresh key.
 */
import { PaylodInvalidRequestError, PaylodResponseTooLargeError } from "./errors.js";

/**
 * Deepest JSON nesting accepted from any untrusted document.
 *
 * 64 is ~20x the deepest real body and still shallow enough that no runtime is troubled by it.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Member names whose NUMERIC value decides whether money moved, matched case-insensitively and
 * after escape decoding. `resultCode` is the money verdict itself; `errorCode` is the Daraja
 * edge that carries `500.001.1001`, i.e. the same verdict arriving by a different door.
 */
const MONEY_CRITICAL_KEYS: ReadonlySet<string> = new Set(["resultcode", "errorcode"]);

/**
 * The ONLY numeric spelling a canonical result code has: a bare, non-negative, unpadded integer.
 * No sign, no fraction, no exponent, no leading zero. This is deliberately narrower than JSON's
 * own number grammar — every other legal spelling is legal JSON that paylod does not produce.
 */
const CANONICAL_JSON_INTEGER_RE = /^(?:0|[1-9][0-9]*)$/;

const JSON_WS = " \t\n\r";
/** Where a JSON number token ends. */
const NUMBER_TERMINATORS = ',}] \t\n\r';

function isWs(c: string | undefined): boolean {
  return c !== undefined && JSON_WS.includes(c);
}

/**
 * Decode a raw JSON string body (the bytes between the quotes) to the member name it denotes.
 *
 * THIS IS THE ESCAPED-KEY BYPASS, and it is why the scan cannot be a substring search for
 * `"resultCode"`. `{"resultCode": 0.0}` is the same member as `{"resultCode": 0.0}` to every
 * JSON parser in existence, and a raw-bytes search for the literal spelling walks straight past
 * it. `JSON.parse` is used to do the decoding so the SDK's notion of a member name is exactly the
 * parser's, rather than a hand-rolled unescaper that can differ from it in some corner.
 */
function decodeMemberName(rawBody: string): string {
  if (!rawBody.includes("\\")) return rawBody;
  try {
    const decoded: unknown = JSON.parse(`"${rawBody}"`);
    return typeof decoded === "string" ? decoded : rawBody;
  } catch {
    // Not a decodable string body — the whole-document `JSON.parse` below will reject it anyway.
    return rawBody;
  }
}

/**
 * DESCRIBE THE OFFENDING LEXEME. DO NOT REPRODUCE IT. (spec 4.2)
 *
 * The previous version interpolated up to 32 raw server-chosen characters into the refusal, and
 * that was the round-10 High. The scan that produces a lexeme runs to the next `,}] ` or
 * whitespace — terminators the OTHER side controls — so the "number" can contain anything else,
 * including a credential. A short API key or webhook secret placed immediately after a numeric
 * prefix appeared verbatim in the exception message, in its stack, and in the webhook adapter's
 * 400 response. Truncating to 32 characters bounded the leak; it did not remove it, because a
 * credential shorter than 32 characters fits inside the bound. This is the same shape as the
 * Python sibling's round-9 Critical, where a NEW refusal interpolated a raw server header.
 *
 * This module is deliberately dependency-free — it holds no credentials, so it cannot redact
 * against them, and a diagnostic here can never be routed through the client's redactor because
 * it is thrown before the client sees the body. The only sound answer at this layer is to emit
 * NO SERVER BYTES AT ALL.
 *
 * So the refusal names the SHAPE, computed by this SDK from the lexeme, never quoting it. The
 * shape is what a developer actually needs — "it arrived with a fraction" localises the problem
 * exactly as well as echoing `1032.0` does, and carries no attacker-chosen text.
 */
function describeLexemeShape(lexeme: string): string {
  if (lexeme === "") return "an empty token";
  if (/^[+-]/.test(lexeme)) return "a signed form (a leading + or -)";
  if (/^0[0-9]/.test(lexeme)) return "a zero-padded form";
  if (lexeme.includes(".")) return "a fractional form (it contains a decimal point)";
  if (/e/i.test(lexeme)) return "an exponent form";
  if (/^0[xX]/.test(lexeme)) return "a hexadecimal form";
  if (/^[0-9]+$/.test(lexeme)) return "an out-of-range integer form";
  return "a non-numeric or otherwise non-canonical form";
}

/**
 * The member name is NOT server text by the time it reaches here.
 *
 * `refuseLexeme` is only ever called after the decoded, lower-cased member name matched
 * {@link MONEY_CRITICAL_KEYS}, so the name is one of this SDK's own two constants. Rendering the
 * matched CONSTANT rather than the bytes that matched it means an escaped or oddly-cased
 * spelling cannot smuggle anything into the message either.
 */
function refuseLexeme(matchedKey: string, rawLexeme: string): never {
  const shape = describeLexemeShape(rawLexeme);
  throw new PaylodResponseTooLargeError(
    `paylod's response spells the \`${matchedKey}\` member as ${shape}, which is not the ` +
      `canonical integer form paylod emits. The offending value is deliberately NOT reproduced ` +
      `here: it is bytes the other side chose, and this refusal runs before any credential ` +
      `redactor could see them. Different spellings of the same number — \`0.0\`, \`0e999\`, ` +
      `\`1.032e3\` — all collapse onto one value once parsed, so accepting them would let ` +
      `whoever produced this body choose the payment verdict (\`0\` is PAID; \`1032\` is a ` +
      `cancellation that reports RETRYABLE) through arithmetic rather than through the value. ` +
      `The body is refused before it is parsed. The request DID reach paylod, so the state of ` +
      `anything it may have changed is INDETERMINATE — read the payment rather than retrying, ` +
      `and never mint a fresh idempotency key on the strength of this error.`,
  );
}

/**
 * Members whose DUPLICATION decides money, in the sense of spec 2.3.
 *
 * Wider than {@link MONEY_CRITICAL_KEYS} because duplication is a different attack from
 * spelling. `{"status":"failed","status":"success"}` needs no numeric trick at all: it needs
 * only that the SDK and the sender disagree about which copy wins.
 */
const DUPLICATE_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "resultcode",
  "errorcode",
  "status",
  "mpesareceipt",
  "id",
  "paymentid",
  "checkoutrequestid",
]);

function refuseDuplicate(matchedKey: string): never {
  throw new PaylodResponseTooLargeError(
    `paylod's response declares the \`${matchedKey}\` member more than once in the same object. ` +
      `Which duplicate a parser keeps is a PARSER DETAIL — last-wins for JSON.parse, first-wins ` +
      `for others — and this SDK will not make a money decision that depends on agreeing with ` +
      `the sender about it. \`{"resultCode":1032,"resultCode":0}\` would otherwise be a ` +
      `cancellation or a settlement according to which end you ask. The body is refused before ` +
      `it is parsed. The request DID reach paylod, so the state of anything it may have changed ` +
      `is INDETERMINATE — read the payment rather than retrying, and never mint a fresh ` +
      `idempotency key on the strength of this error.`,
  );
}

/**
 * `JSON.parse` with a depth budget AND money-critical numeric-lexeme validation, both enforced
 * BEFORE the parser runs.
 *
 * The check is a scan of the raw text rather than a walk of the parsed value, which is the whole
 * point: by the time there is a value to walk, `JSON.parse` has already recursed to the bottom of
 * the document and has already thrown away every numeric spelling it saw. Only structural
 * brackets count towards the depth — braces inside string literals are skipped, with escape
 * handling, so a body whose *content* is full of JSON text is not mistaken for deep nesting.
 *
 * DUPLICATE KEYS ARE ALL CHECKED, not just the winner. `{"resultCode":1032,"resultCode":-0}`
 * parses to whatever the last occurrence says under every JSON parser, but which one wins is a
 * parser detail and not a thing to build a money guarantee on. Every occurrence anywhere in the
 * document must be canonical, so a hostile spelling cannot hide behind a decoy.
 */
export function parseBounded(text: string, maxDepth = MAX_JSON_DEPTH): unknown {
  let depth = 0;
  let i = 0;
  const n = text.length;

  /**
   * One set of already-seen member names PER OPEN OBJECT (spec 2.3).
   *
   * Duplication is only meaningful within a single object, so the sets are scoped rather than
   * global: `{"a":{"status":"x"},"b":{"status":"y"}}` is two different members that happen to
   * share a name, and refusing that would refuse ordinary bodies. A frame is pushed for arrays
   * too, purely to keep the stack aligned with the bracket nesting — an array has no members, so
   * its frame simply never gets written to.
   */
  const scopes: Array<Set<string>> = [new Set()];

  while (i < n) {
    const c = text[i];

    if (c === '"') {
      // Walk to the closing quote, honouring escapes.
      const start = i + 1;
      let j = start;
      let escaped = false;
      for (; j < n; j++) {
        const s = text[j];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (s === "\\") {
          escaped = true;
          continue;
        }
        if (s === '"') break;
      }
      const rawBody = text.slice(start, j);
      i = j + 1;

      // A string followed by `:` is a MEMBER NAME — the only position where a key can appear.
      let k = i;
      while (k < n && isWs(text[k])) k++;
      if (text[k] !== ":") continue;
      i = k + 1;

      // ONE decode, used for BOTH rules. The name is compared after escape decoding (spec 2.2),
      // so `status` is `status` to the duplicate rule exactly as it is to the parser.
      const memberName = decodeMemberName(rawBody).toLowerCase();

      // DUPLICATE DETECTION (spec 2.3), before the spelling rule — a second declaration is
      // refused whatever it is spelt like, so a hostile value cannot hide behind a canonical one.
      if (DUPLICATE_SENSITIVE_KEYS.has(memberName)) {
        const scope = scopes[scopes.length - 1] as Set<string>;
        if (scope.has(memberName)) refuseDuplicate(memberName);
        scope.add(memberName);
      }

      if (!MONEY_CRITICAL_KEYS.has(memberName)) continue;

      // Find the value token. Only NUMBERS are our business here — a string-valued `resultCode`
      // keeps its spelling all the way to `canonicalCodeForm`, which already refuses `"0.0"`.
      let v = i;
      while (v < n && isWs(text[v])) v++;
      const first = text[v];
      if (first === undefined) continue;
      if (!(first === "-" || first === "+" || first === "." || (first >= "0" && first <= "9"))) {
        continue;
      }
      let e = v;
      while (e < n && !NUMBER_TERMINATORS.includes(text[e] as string)) e++;
      const lexeme = text.slice(v, e);
      if (!CANONICAL_JSON_INTEGER_RE.test(lexeme)) {
        // The MATCHED CONSTANT, never the raw bytes that matched it (spec 4.2).
        refuseLexeme(memberName, lexeme);
      }
      i = e;
      continue;
    }

    if (c === "{" || c === "[") {
      depth++;
      scopes.push(new Set());
      if (depth > maxDepth) {
        throw new PaylodResponseTooLargeError(
          `paylod's response nests more than ${maxDepth} levels deep and was refused before it ` +
            `was parsed. The request DID reach paylod, so the state of anything it may have ` +
            `changed is INDETERMINATE — read the payment rather than retrying, and never mint a ` +
            `fresh idempotency key on the strength of this error.`,
        );
      }
    } else if (c === "}" || c === "]") {
      depth--;
      // Never pop the root frame: a body with unbalanced brackets is `JSON.parse`'s to reject,
      // and this scan must not underflow on its way there.
      if (scopes.length > 1) scopes.pop();
    }
    i++;
  }

  return JSON.parse(text);
}

/**
 * DECODE BYTES TO TEXT, FATALLY. (spec 2.6)
 *
 * `new TextDecoder()` defaults to REPLACEMENT semantics: every byte it cannot make sense of
 * becomes U+FFFD, silently. On a money path that is not a display concern, it is an identity
 * collapse. Two DIFFERENT wire payment ids — differing only in bytes that are invalid UTF-8 —
 * decode to the SAME string, so a correlation that should have failed succeeds against the wrong
 * payment. The same applies to receipts and to anything downstream of an HMAC.
 *
 * `fatal: true` makes an undecodable body an error instead of a quiet normalisation. That is the
 * honest answer: paylod emits UTF-8, so a body that is not UTF-8 did not come from paylod intact,
 * and a body we cannot read exactly is a body we must not act on.
 *
 * The refusal names no bytes, for the same reason `refuseLexeme` names none.
 */
export function decodeUtf8Strict(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PaylodResponseTooLargeError(
      `${what} is not valid UTF-8 and was refused rather than decoded with replacement ` +
        `characters. Substituting U+FFFD would let two DIFFERENT wire values — payment ids, ` +
        `receipts — collapse into one identical string, so a correlation that should fail would ` +
        `instead succeed against the wrong payment. The request DID reach paylod, so the state ` +
        `of anything it may have changed is INDETERMINATE — read the payment rather than ` +
        `retrying, and never mint a fresh idempotency key on the strength of this error.`,
    );
  }
}

/**
 * Hard ceiling on a request body this SDK will serialise, in bytes.
 *
 * A paylod request is a few hundred bytes. 256 KiB is three orders of magnitude of headroom, and
 * bounding it is not about the network — it is about `JSON.stringify` running in THIS process,
 * before anything is dispatched, on a value the caller assembled from data they may not control
 * (a webhook payload echoed into `metadata`, a user-supplied order object, a database row).
 */
export const MAX_REQUEST_BODY_BYTES = 262_144;

/**
 * `JSON.stringify` with the SAME depth budget the reader uses, plus cycle detection and a byte cap.
 *
 * ── Why the write side needs bounds at all ────────────────────────────────────────────────
 * Every bound in this SDK used to face outward: response bytes capped, response depth capped,
 * numeric lexemes validated. The write side had none, so `JSON.stringify(req.body)` on the
 * `collect` path ran unbounded on a caller-assembled value:
 *
 *   • DEEPLY NESTED → `JSON.stringify` recurses, so a body a few thousand levels deep is a
 *     `RangeError` thrown from inside the serialiser. Thrown at THIS point it is survivable; the
 *     danger is that the same shape reaches a retry or a reconciliation path where a stack
 *     overflow costs the idempotency key for a charge that may already be live.
 *   • CYCLIC → `JSON.stringify` throws a `TypeError` whose message quotes the property path it
 *     walked, which is caller data in an exception nobody sanitised.
 *   • ENORMOUS → the serialised copy is committed to memory in full before a single byte is sent.
 *
 * All three are refused BEFORE the serialiser is allowed to recurse, and refused as an
 * INVALID REQUEST — the defining property being that NOTHING WAS DISPATCHED. There is no charge
 * to reconcile and no idempotency key to preserve, which is exactly why this check belongs here,
 * ahead of the dispatch, rather than in a `catch` around it.
 *
 * The depth budget is {@link MAX_JSON_DEPTH}, the same constant `parseBounded` enforces. One
 * constant for every structural bound in this SDK: two limits that can drift apart will.
 */
export function stringifyBounded(value: unknown, what = "the request body"): string {
  const seen = new Set<object>();

  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== "object") return;
    if (depth > MAX_JSON_DEPTH) {
      throw new PaylodInvalidRequestError(
        `${what} nests more than ${MAX_JSON_DEPTH} levels deep. It was refused before it was ` +
          `serialised, so NOTHING was dispatched — no charge was raised and there is no payment ` +
          `to reconcile. Flatten the value and call again with the SAME idempotency key.`,
      );
    }
    // Ancestor set, not a global visited set: a DAG that repeats the same object on two sibling
    // branches is legal JSON and must not be mistaken for a cycle.
    const obj = v as object;
    if (seen.has(obj)) {
      throw new PaylodInvalidRequestError(
        `${what} contains a circular reference. It was refused before it was serialised, so ` +
          `NOTHING was dispatched — no charge was raised and there is no payment to reconcile. ` +
          `The offending property is not named here because its path is caller data that would ` +
          `then travel in this message. Call again with the SAME idempotency key once the cycle ` +
          `is removed.`,
      );
    }
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
    } else {
      for (const item of Object.values(obj as Record<string, unknown>)) walk(item, depth + 1);
    }
    seen.delete(obj);
  };

  walk(value, 1);

  const text = JSON.stringify(value) ?? "null";
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_REQUEST_BODY_BYTES) {
    throw new PaylodInvalidRequestError(
      `${what} serialises to ${bytes} bytes, over the ${MAX_REQUEST_BODY_BYTES}-byte limit. It ` +
        `was refused before it was dispatched, so NOTHING was sent — no charge was raised and ` +
        `there is no payment to reconcile. Shrink the value (\`metadata\` is the usual culprit) ` +
        `and call again with the SAME idempotency key.`,
    );
  }
  return text;
}
