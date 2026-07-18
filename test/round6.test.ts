/**
 * ROUND 6 — the defects the fourth cross-SDK review found in the canonical Node SDK.
 *
 * The organising theme of the round is ORDERING. Every previous round added a strict predicate;
 * this round is about the layer BENEATH the predicate quietly repairing its input first, so the
 * strict check was handed a laundered impostor and answered correctly about the wrong value.
 */

import { describe, expect, it, vi } from "vitest";
import { Paylod } from "../src/client.js";
import { classifyStkResult, decodeDarajaResult } from "../src/daraja-catalog.js";
import { judge } from "../src/semantics.js";
import { toOutcome } from "../src/outcome.js";
import { signWebhook, verifyWebhook } from "../src/webhook.js";
import { payment } from "./helpers.js";

const KEY = "mp_test_abcdefghijklmnopqrstuvwxyz";
const SECRET = "whsec_round6_secret";

function client(fetch: typeof globalThis.fetch) {
  return new Paylod({ apiKey: KEY, fetch, allowCustomFetch: true, maxRetries: 0 });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C1 — NORMALIZATION NEVER RUNS BEFORE VALIDATION
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every entry is a value that a PREVIOUS layer would have laundered into canonical form before
 * the strict `=== "0"` check could see it. `String(x).trim()` maps the whole first group onto the
 * string `"0"`; the second group is the same laundering applied in the failure direction, where
 * arriving at the catalog entry for 1032 means arriving at `retryable: true` — an instruction to
 * charge the customer a second time.
 *
 * `label` exists because `-0` and `0` render identically in a test name.
 */
const ZERO_IMPOSTORS: ReadonlyArray<readonly [string, unknown]> = [
  ["a leading-space zero", " 0"],
  ["a trailing-space zero", "0 "],
  ["a tab-wrapped zero", "\t0\t"],
  ["a newline-wrapped zero", "\n0\n"],
  ["numeric negative zero", -0],
  ["string negative zero", "-0"],
  ["a decimal-point zero", "0.0"],
  ["an exponent zero", "0e999"],
  ["a signed zero", "+0"],
  ["a padded zero", "00"],
  ["a hex zero", "0x0"],
  ["a binary zero", "0b0"],
  ["boolean false", false],
];

const FAILURE_IMPOSTORS: ReadonlyArray<readonly [string, unknown]> = [
  ["a leading-space cancellation", " 1032"],
  ["a trailing-space cancellation", "1032 "],
  ["a tab-wrapped cancellation", "\t1032\t"],
  ["a padded cancellation", "01032"],
  ["a signed cancellation", "+1032"],
];

describe("C1 — a laundered result code can never become success evidence", () => {
  it("the premise: JS really would collapse each of these onto zero", () => {
    for (const [label, raw] of ZERO_IMPOSTORS) {
      // This is the whole reason the defect existed: the old `String(raw).trim()` produced "0"
      // for most of these, and `Number()` finished the job for the rest (`Number(false) === 0`).
      const laundered = String(raw).trim();
      const collapses = laundered === "0" || Number(laundered) === 0 || Number(raw) === 0;
      expect(collapses, `${label} should be a genuine impostor`).toBe(true);
    }
  });

  for (const [label, raw] of ZERO_IMPOSTORS) {
    it(`does NOT classify ${label} as success`, () => {
      expect(classifyStkResult(raw)).not.toBe("success");
    });

    it(`does NOT report ${label} as PAID through the semantic model`, () => {
      expect(judge(payment({ status: "success", resultCode: raw as never })).verdict).not.toBe(
        "paid",
      );
      expect(toOutcome(payment({ status: "success", resultCode: raw as never })).paid).toBe(false);
    });

    it(`does NOT decode ${label} as a catalog success entry`, () => {
      expect(decodeDarajaResult(raw as never).category).not.toBe("success");
      expect(decodeDarajaResult(raw as never).retryable).toBe(false);
    });
  }
});

describe("C1 — a laundered result code can never become a RETRYABLE terminal failure", () => {
  for (const [label, raw] of FAILURE_IMPOSTORS) {
    it(`does NOT decode ${label} into the catalog's retryable cancellation`, () => {
      const decoded = decodeDarajaResult(raw as never);
      expect(decoded.retryable).toBe(false);
      expect(decoded.code).not.toBe("1032");
    });

    it(`does NOT render ${label} as a cancelled, retryable outcome`, () => {
      const out = toOutcome(payment({ status: "failed", resultCode: raw as never }));
      expect(out.status).not.toBe("cancelled");
      expect(out.retryable).toBe(false);
      expect(out.paid).toBe(false);
    });
  }

  it("the CANONICAL cancellation is still recognised, and is still retryable", () => {
    expect(decodeDarajaResult(1032).retryable).toBe(true);
    expect(toOutcome(payment({ status: "failed", resultCode: 1032 })).status).toBe("cancelled");
  });

  it("canonical success is still success — the fix narrows, it does not break", () => {
    expect(classifyStkResult(0)).toBe("success");
    expect(classifyStkResult("0")).toBe("success");
    expect(judge(payment({ status: "success", resultCode: 0 })).verdict).toBe("paid");
    expect(decodeDarajaResult("500.001.1001").category).toBe("pending");
    expect(decodeDarajaResult(4999).retryable).toBe(false);
  });
});

// ── The same matrix, END TO END, through a real status read ──────────────────────────────────

/**
 * JSON has NO representation for negative zero — `JSON.stringify(-0)` is `"0"` and parsing it back
 * yields `+0`. Over the wire it is therefore not an impostor at all but the genuine article, and
 * there is nothing left to detect. It stays in the direct-API matrix above (where a caller CAN
 * hand the SDK a real `-0`) and is excluded from the transport matrices here, because a test that
 * demanded the impossible would be a test nobody could keep green honestly.
 */
const WIRE_ZERO_IMPOSTORS = ZERO_IMPOSTORS.filter(([, raw]) => !Object.is(raw, -0));

/** A value that is refused outright is just as safe as one classified as unpaid — assert BOTH. */
async function neverPaid(promise: Promise<{ paid: boolean; retryable: boolean }>): Promise<void> {
  const out = await promise.catch(() => null);
  if (out === null) return; // rejected — the safest possible answer
  expect(out.paid).toBe(false);
  expect(out.retryable).toBe(false);
}

describe("C1 end-to-end — a status read carrying an impostor code is never PAID", () => {
  for (const [label, raw] of WIRE_ZERO_IMPOSTORS) {
    it(`status() with ${label} does not come back paid`, async () => {
      const fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "pay_1",
            status: "success",
            mpesaReceipt: null,
            resultCode: raw,
            resultDesc: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ) as unknown as typeof globalThis.fetch;

      await neverPaid(client(fetch).check("pay_1"));
    });
  }

  for (const [label, raw] of FAILURE_IMPOSTORS) {
    it(`status() with ${label} is never a retryable cancellation`, async () => {
      const fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "pay_1",
            status: "failed",
            mpesaReceipt: null,
            resultCode: raw,
            resultDesc: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ) as unknown as typeof globalThis.fetch;

      const out = await client(fetch).check("pay_1").catch(() => null);
      if (out === null) return; // refused outright — safest possible answer
      expect(out.retryable).toBe(false);
      expect(out.status).not.toBe("cancelled");
    });
  }
});

// ── And through a signed WEBHOOK, which is the channel that fulfils orders ────────────────────

const NOW = 1_700_000_000;

function signedEvent(data: Record<string, unknown>, type = "payment.success") {
  const raw = JSON.stringify({ type, created: NOW, data });
  return { payload: raw, signature: signWebhook(raw, SECRET, NOW), secret: SECRET, nowSec: NOW };
}

function successData(over: Record<string, unknown> = {}) {
  return {
    paymentId: "pay_1",
    applicationId: "app_1",
    env: "sandbox",
    status: "success",
    amount: 100,
    phone: "254712345678",
    accountRef: null,
    mpesaReceipt: null,
    checkoutRequestId: "ws_CO_1",
    resultCode: 0,
    resultDesc: "The service request is processed successfully.",
    decoded: null,
    ...over,
  };
}

describe("C1 webhook — a signed payment.success carrying an impostor code is REJECTED", () => {
  for (const [label, raw] of WIRE_ZERO_IMPOSTORS) {
    it(`rejects a correctly-signed success whose resultCode is ${label}`, () => {
      // The signature is VALID on every one of these. Rejection is a statement about the BODY.
      expect(() => verifyWebhook(signedEvent(successData({ resultCode: raw })))).toThrow(
        /does not prove one|resultCode/,
      );
    });
  }

  it("a genuine result code 0 still verifies — the rule narrows, it does not break", () => {
    const event = verifyWebhook(signedEvent(successData()));
    expect(event.type).toBe("payment.success");
    expect(event.data.decoded).toBeNull();
  });
});

describe("C1 webhook — a signed payment.failed carrying an impostor code is REJECTED", () => {
  for (const [label, raw] of FAILURE_IMPOSTORS) {
    it(`rejects a correctly-signed failure whose resultCode is ${label}`, () => {
      // An unreadable code assesses as in-flight, and an in-flight record is not a settled
      // failure — so it must not be delivered as one, and can never carry `retryable: true`.
      expect(() =>
        verifyWebhook(
          signedEvent(
            successData({ status: "failed", resultCode: raw, decoded: null }),
            "payment.failed",
          ),
        ),
      ).toThrow(/does not support that|resultCode/);
    });
  }
});

