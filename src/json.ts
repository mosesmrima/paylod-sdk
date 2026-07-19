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
import { PaylodResponseTooLargeError } from "./errors.js";

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

function refuseLexeme(key: string, lexeme: string): never {
  throw new PaylodResponseTooLargeError(
    `paylod's response spells \`${key}\` as the JSON number \`${lexeme}\`, which is not the ` +
      `canonical integer form paylod emits. Different spellings of the same number — \`0.0\`, ` +
      `\`0e999\`, \`1.032e3\` — all collapse onto one value once parsed, so accepting them would ` +
      `let whoever produced this body choose the payment verdict (\`0\` is PAID; \`1032\` is a ` +
      `cancellation that reports RETRYABLE) through arithmetic rather than through the value. ` +
      `The body is refused before it is parsed. The request DID reach paylod, so the state of ` +
      `anything it may have changed is INDETERMINATE — read the payment rather than retrying, ` +
      `and never mint a fresh idempotency key on the strength of this error.`,
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

      if (!MONEY_CRITICAL_KEYS.has(decodeMemberName(rawBody).toLowerCase())) continue;

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
        refuseLexeme(decodeMemberName(rawBody), lexeme);
      }
      i = e;
      continue;
    }

    if (c === "{" || c === "[") {
      depth++;
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
    }
    i++;
  }

  return JSON.parse(text);
}
