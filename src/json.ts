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
 * The most server-controlled text this refusal will reproduce.
 *
 * The lexeme is bytes the OTHER side chose, and the scan that produces it runs to the next
 * `,}] ` or whitespace — which an attacker controls, so the "number" can be arbitrarily long and
 * can contain anything but those terminators. Interpolating it whole put an unbounded,
 * attacker-chosen string into an exception message, which is the first thing a crash reporter
 * serialises. This is the Node instance of the Python sibling's round-9 Critical, where a NEW
 * refusal interpolated a raw server header and thereby printed a bearer token.
 *
 * 32 characters is far more than any real numeric spelling needs and short enough that no
 * credential survives the cut. This module is deliberately dependency-free and holds no
 * credentials of its own, so bounding is the control available here; the API path additionally
 * runs every message it emits through the client's redactor.
 */
const MAX_QUOTED_LEXEME = 32;

function quoteServerText(s: string): string {
  return s.length > MAX_QUOTED_LEXEME ? `${s.slice(0, MAX_QUOTED_LEXEME)}…` : s;
}

function refuseLexeme(rawKey: string, rawLexeme: string): never {
  const key = quoteServerText(rawKey);
  const lexeme = quoteServerText(rawLexeme);
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
