/**
 * CATALOG-WIDE INVARIANTS.
 *
 * Two properties that no single-entry test can express, and that a catalog resync could silently
 * break:
 *
 *   1. (code, family) is the real key. `code` alone is ambiguous — three codes appear in two
 *      families each, carrying DIFFERENT retryability and category. A resync that collapsed them
 *      would silently change what the SDK tells a customer.
 *
 *   2. No non-retryable entry that may sit on top of a real debit invites another payment
 *      attempt. Telling a customer to "try again" when M-Pesa may already have taken their money
 *      is how a double charge happens.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ALL_ENTRIES, ERROR_CATALOG, decodeDarajaResult } from "../src/daraja-catalog.js";

// ── 1. duplicate-code guard ───────────────────────────────────────────────────────────────

describe("catalog keying — (code, family) is the key, `code` alone is not", () => {
  it("every (code, family) PAIR is unique", () => {
    const seen = new Map<string, number>();
    for (const e of ALL_ENTRIES) {
      const key = `${e.code}\u0000${e.family}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k.split("\u0000"));
    expect(duplicated).toEqual([]);
    expect(seen.size).toBe(ALL_ENTRIES.length);
  });

  /**
   * NON-VACUITY. If this catalog ever became free of bare-code collisions, the uniqueness
   * assertion above would still pass — but it would be guarding nothing, and the family-aware
   * decoding it exists to protect would have quietly stopped mattering. So the ambiguity itself
   * is asserted: these codes MUST still be overloaded.
   */
  it("bare `code` values ARE duplicated — the ambiguity the pair-key exists for is real", () => {
    const byCode = new Map<string, string[]>();
    for (const e of ALL_ENTRIES) {
      byCode.set(e.code, [...(byCode.get(e.code) ?? []), e.family]);
    }
    const overloaded = [...byCode.entries()]
      .filter(([, families]) => families.length > 1)
      .map(([code]) => code)
      .sort();

    expect(overloaded).toEqual(["0", "2001", "500.001.1001"].sort());

    // and each is overloaded across exactly the two families that give it two meanings
    expect(byCode.get("0")!.sort()).toEqual(["b2c_c2b_result", "stk_result"]);
    expect(byCode.get("2001")!.sort()).toEqual(["b2c_c2b_result", "stk_result"]);
    expect(byCode.get("500.001.1001")!.sort()).toEqual(["api_error", "stk_result"]);
  });

  /**
   * `ERROR_CATALOG` is a PUBLIC export keyed on bare `code`, so it cannot represent an overloaded
   * code — one of the two entries has to lose. Changing that would be a breaking change for
   * existing importers, so the behaviour is pinned rather than fixed: STK wins, because STK is
   * the payment path. Callers who need the other meaning must use ALL_ENTRIES or pass a family
   * to decodeDarajaResult.
   */
  it("ERROR_CATALOG resolves bare-code collisions STK-first (pinned, not fixed)", () => {
    expect(ERROR_CATALOG["2001"]!.family).toBe("stk_result");
    expect(ERROR_CATALOG["2001"]!.retryable).toBe(true); // the STK wrong-PIN entry
    expect(ERROR_CATALOG["0"]!.family).toBe("stk_result");
    expect(ERROR_CATALOG["500.001.1001"]!.family).toBe("stk_result");
    expect(ERROR_CATALOG["500.001.1001"]!.category).toBe("pending");

    // the losing entries are reachable only through the family-aware surface
    const b2c2001 = ALL_ENTRIES.find((e) => e.code === "2001" && e.family === "b2c_c2b_result")!;
    expect(b2c2001.retryable).toBe(false);
    expect(b2c2001.category).toBe("credentials");
  });
});

// ── 2. no non-retryable entry invites another payment attempt ─────────────────────────────

/**
 * Does this customer message invite the customer to PAY AGAIN?
 *
 * A substring match on "again" cannot answer that, because the safe messages are the ones that
 * talk about paying again in order to FORBID it ("Do not pay again yet."). So each occurrence of
 * again/retry is read in context: if the ~40 characters before it carry a negation marker, the
 * occurrence is a prohibition. An invitation is an occurrence with no negation in front of it.
 *
 * The lookbehind is clamped to the CURRENT SENTENCE. Without that clamp a prohibition in one
 * sentence launders an invitation in the next -- "Do not pay again yet. If it fails, try again
 * later." would read as safe because "do not" is still inside a flat 40-character window.
 */
export function invitesAnotherAttempt(message: string): boolean {
  const NEGATIONS = ["do not", "don't", "never", "before", "without", "rather than"];
  const WINDOW = 40;
  const re = /\b(again|retry|retries|retrying)\b/gi;

  for (let m = re.exec(message); m !== null; m = re.exec(message)) {
    const upto = message.slice(0, m.index);
    // start of the sentence containing this occurrence
    const sentenceStart = Math.max(
      upto.lastIndexOf("."),
      upto.lastIndexOf("!"),
      upto.lastIndexOf("?"),
      upto.lastIndexOf(";"),
    ) + 1;
    const sentence = upto.slice(sentenceStart);
    const before = sentence.slice(Math.max(0, sentence.length - WINDOW)).toLowerCase();
    const negated = NEGATIONS.some((n) => before.includes(n));
    if (!negated) return true; // an unqualified "try again" — an invitation
  }
  return false;
}

/**
 * Scope. Only entries where A DEBIT MAY HAVE OCCURRED are in scope:
 *
 *   • pending      — the STK prompt is live, or the result is unknown. Money may move.
 *   • mpesa_system — M-Pesa errored after dispatch. The outcome is unconfirmed.
 *
 * `credentials` and `customer` failures are refused BEFORE dispatch (invalid MSISDN, till/paybill
 * mismatch, unknown C2B account reference, bad initiator credentials). No money moved, so "fix it
 * and try again" is both correct and the most useful thing to say — those must NOT be flagged.
 */
const DEBIT_MAY_HAVE_OCCURRED = ["pending", "mpesa_system"] as const;

describe("no non-retryable entry that may sit on a real debit invites another payment attempt", () => {
  const scoped = ALL_ENTRIES.filter(
    (e) =>
      e.retryable === false &&
      (DEBIT_MAY_HAVE_OCCURRED as readonly string[]).includes(e.category),
  );

  it("the catalog is actually populated — 'no offenders' cannot mean 'nothing examined'", () => {
    expect(ALL_ENTRIES.length).toBeGreaterThanOrEqual(30);
    expect(ALL_ENTRIES.filter((e) => e.retryable === false).length).toBeGreaterThanOrEqual(15);
    expect(scoped.length).toBeGreaterThanOrEqual(5);
  });

  it("no scoped entry invites another payment attempt", () => {
    const offenders = scoped
      .filter((e) => invitesAnotherAttempt(e.customerMessage))
      .map((e) => `${e.code}/${e.family}: ${e.customerMessage}`);
    expect(offenders).toEqual([]);
  });

  it("every scoped entry still has a nonblank customer message", () => {
    for (const e of scoped) {
      expect(e.customerMessage.trim().length).toBeGreaterThan(0);
    }
  });
});

// ── the detector itself is tested, so the invariant above cannot pass vacuously ────────────

describe("invitesAnotherAttempt — discrimination", () => {
  it("FLAGS the pre-fix 500.001.1001 text, which genuinely invited a retry", () => {
    expect(invitesAnotherAttempt("M-Pesa returned an error. Please try again in a moment.")).toBe(
      true,
    );
  });

  it("does NOT flag the canonical prohibition that replaced it", () => {
    expect(
      invitesAnotherAttempt(
        "M-Pesa returned an error and we cannot confirm the outcome. Do not pay again yet. Check your M-Pesa messages first.",
      ),
    ).toBe(false);
  });

  it("does not flag other prohibition phrasings", () => {
    expect(invitesAnotherAttempt("Check your M-Pesa messages before paying again.")).toBe(false);
    expect(invitesAnotherAttempt("Please wait — do not retry — while it settles.")).toBe(false);
    expect(invitesAnotherAttempt("Never try again until the payment settles.")).toBe(false);
  });

  it("flags other genuine invitations", () => {
    expect(invitesAnotherAttempt("Something went wrong. Please retry.")).toBe(true);
    expect(invitesAnotherAttempt("Try again in a few minutes.")).toBe(true);
  });

  it("does not flag a message that never mentions retrying at all", () => {
    expect(invitesAnotherAttempt("Check your phone and enter your M-Pesa PIN.")).toBe(false);
  });

  it("flags a message that both forbids AND invites — the invitation is what matters", () => {
    expect(invitesAnotherAttempt("Do not pay again yet. If it fails, try again later.")).toBe(true);
  });

  it("the live 500.001.1001 api_error entry is the fixed text, not the pre-fix text", () => {
    const entry = ALL_ENTRIES.find(
      (e) => e.code === "500.001.1001" && e.family === "api_error",
    )!;
    expect(entry.customerMessage).toBe(
      "M-Pesa returned an error and we cannot confirm the outcome. Do not pay again yet. Check your M-Pesa messages first.",
    );
    expect(entry.retryable).toBe(false);
    expect(invitesAnotherAttempt(entry.customerMessage)).toBe(false);
  });
});

// ── 3. THE FALLBACKS ARE IN SCOPE TOO ─────────────────────────────────────────────────────

/**
 * The sweep above walks `ALL_ENTRIES` — the CATALOG. It never looked at a fallback, and a
 * fallback is not a catalog row: it is the value `decodeDarajaResult` returns when no row
 * matched. So the one path where the SDK knows LEAST about what happened was the one path the
 * requirement-3.7 invariant did not cover, and `failedFallback` sat there for ten review rounds
 * saying "The payment didn't go through. Please try again." beside a `fix` field stating, in the
 * same object, that we cannot prove no money moved. It was found by reading the file, not by a
 * test — which is the same as saying nothing was checking fallbacks.
 *
 * Each fallback is probed through the PUBLIC decode surface, because that is the only way a
 * caller can reach one. The probe list is then checked against the fallback functions actually
 * declared in the source, so adding a fourth fallback fails this file until it is probed.
 */
describe("fallback decodes — the paths with no catalog row are held to requirement 3.7", () => {
  const PROBES = [
    // name              input                 rawDesc                        expected title
    ["pendingFallback", "500.999.9999", undefined, "Payment still in progress"],
    ["failedFallback", null, undefined, "Payment failed"],
    ["indeterminateFallback", " 0", undefined, "Payment outcome unknown"],
  ] as const;

  it("every fallback DECLARED in the source is probed here", () => {
    const src = readFileSync(new URL("../src/daraja-catalog.ts", import.meta.url), "utf8");
    const declared = [...src.matchAll(/^function\s+(\w*[Ff]allback)\s*\(/gm)]
      .map((m) => m[1]!)
      .sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual(PROBES.map(([n]) => n).slice().sort());
  });

  it("each probe actually reaches the fallback it claims to — no probe is a no-op", () => {
    for (const [name, input, desc, title] of PROBES) {
      const r = decodeDarajaResult(input as never, desc as never);
      expect(`${name}: ${r.title}`).toBe(`${name}: ${title}`);
    }
  });

  it("no fallback invites another payment attempt", () => {
    const offenders = PROBES.map(([name, input, desc]) => {
      const r = decodeDarajaResult(input as never, desc as never);
      return [name, r.customerMessage] as const;
    })
      .filter(([, msg]) => invitesAnotherAttempt(msg))
      .map(([name, msg]) => `${name}: ${msg}`);
    expect(offenders).toEqual([]);
  });

  it("every fallback is non-retryable and carries a nonblank customer message", () => {
    for (const [, input, desc] of PROBES) {
      const r = decodeDarajaResult(input as never, desc as never);
      expect(r.retryable).toBe(false);
      expect(r.customerMessage.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * The specific regression. `failedFallback` is reached by the single most common malformed
   * shape there is — `resultCode` absent entirely — so this string is the one a real customer
   * was most likely to be shown.
   */
  it("the absent-code decode does not tell the customer to pay again", () => {
    const r = decodeDarajaResult(null as never);
    expect(r.customerMessage).not.toContain("try again");
    expect(r.customerMessage).toBe(
      "We couldn't confirm this payment yet. Please wait while it settles — do not start a new payment.",
    );
  });
});
