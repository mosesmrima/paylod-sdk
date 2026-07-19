/**
 * SPEC 3.3 / 3.4 — the receipt grammar, and sanitizer output as evidence.
 *
 * These cover the round-10 High that PHP had already closed and Node, Python and JVM had not:
 * every nonblank receipt counted as settlement evidence, so a redaction placeholder in
 * `mpesaReceipt` was proof of payment.
 *
 * Every case here is DISCRIMINATING (spec 8.5): each asserts an outcome that flips when the
 * grammar is removed, rather than one that happens to hold either way.
 */
import { describe, expect, it } from "vitest";

import { isValidIdentifier, isValidReceipt, looksSanitized } from "../src/grammar.js";
import { judge, hasReceipt } from "../src/semantics.js";
import { parseCollectAck, parsePaymentBody, assertValidIdempotencyKey } from "../src/validate.js";
import { PaylodApiError, PaylodInvalidRequestError } from "../src/errors.js";
import type { Payment } from "../src/types.js";

const p = (over: Partial<Payment>): Payment => ({
  id: "pay_123",
  status: "success",
  mpesaReceipt: null,
  resultCode: null,
  resultDesc: null,
  ...over,
});

/** Every real receipt in the paylod fixtures. The grammar is derived from exactly these. */
const REAL_RECEIPTS = ["SFF6XYZ123", "QGR1ABCDEF", "UG1F3A1U7J"];

/**
 * The values a sanitizer actually emits, plus the near-misses that make the grammar a GRAMMAR
 * rather than a blocklist. Every one of these is nonblank, so every one of them satisfied the
 * old `trim() !== ""` test.
 */
const NOT_RECEIPTS = [
  "[redacted]",
  "[REDACTED]",
  "***",
  "<hidden>",
  "[redacted: structure too deeply nested to scan]",
  "����������",
  "sff6xyz123", // right shape, wrong case
  "SFF6XYZ12", // nine
  "SFF6XYZ1234", // eleven
  "SFF6-YZ123", // punctuation
  "SFF6 YZ123", // space
  "SFF6XYZ12\n", // trailing newline: the spec-7.1 trap, closed here by the character class
];

describe("spec 3.3 — a receipt is validated against a positive grammar", () => {
  it.each(REAL_RECEIPTS)("accepts the real receipt %s", (r) => {
    expect(isValidReceipt(r)).toBe(true);
    expect(hasReceipt({ mpesaReceipt: r })).toBe(true);
  });

  it.each(NOT_RECEIPTS)("refuses %j as a receipt", (r) => {
    expect(isValidReceipt(r)).toBe(false);
    expect(hasReceipt({ mpesaReceipt: r })).toBe(false);
  });

  it("refuses an absent receipt without confusing it for a rejected one", () => {
    expect(hasReceipt({ mpesaReceipt: null })).toBe(false);
    expect(hasReceipt({ mpesaReceipt: "" })).toBe(false);
  });
});

describe("spec 3.4 — a redaction placeholder is never settlement evidence", () => {
  /**
   * THE ROUND-10 HIGH, stated exactly.
   *
   * `status:"success"` is a CLAIM. With no result code, the only thing that could make it paid
   * is a receipt — and `[redacted]` is not one. Before the grammar this returned `paid`.
   */
  it("does NOT report paid for status success with a redacted receipt and no result code", () => {
    const j = judge(p({ status: "success", mpesaReceipt: "[redacted]", resultCode: null }));
    expect(j.verdict).toBe("indeterminate");
    expect(j.evidence).toBe("none");
  });

  it.each(NOT_RECEIPTS)(
    "does NOT report paid for status success carrying %j as its only evidence",
    (r) => {
      expect(judge(p({ status: "success", mpesaReceipt: r, resultCode: null })).verdict).toBe(
        "indeterminate",
      );
    },
  );

  /**
   * THE CONTROL (spec 8.5 / 3.5). An over-corrected model that calls everything indeterminate
   * is also non-conformant, so the same shape with a REAL receipt must still be paid.
   */
  it("still reports paid for status success with a REAL receipt and no result code", () => {
    const j = judge(p({ status: "success", mpesaReceipt: "SFF6XYZ123", resultCode: null }));
    expect(j.verdict).toBe("paid");
    expect(j.evidence).toBe("success");
  });

  it("refuses a status body whose receipt is a placeholder", () => {
    expect(() =>
      parsePaymentBody(
        { id: "pay_123", status: "success", mpesaReceipt: "[redacted]", resultCode: null },
        { httpStatus: 200, expectedId: "pay_123" },
      ),
    ).toThrow(PaylodApiError);
  });

  it("accepts the same body with a real receipt — the control", () => {
    const out = parsePaymentBody(
      { id: "pay_123", status: "success", mpesaReceipt: "SFF6XYZ123", resultCode: 0 },
      { httpStatus: 200, expectedId: "pay_123" },
    );
    expect(out.mpesaReceipt).toBe("SFF6XYZ123");
  });
});

describe("spec 3.4 — a placeholder never satisfies an identifier or correlation check", () => {
  it.each(["[redacted]", "***", "<hidden>", "�", "  ", ""])(
    "refuses %j as a collect-ack paymentId",
    (bad) => {
      expect(() =>
        parseCollectAck(
          { paymentId: bad, checkoutRequestId: "ws_CO_1", status: "pending" },
          { httpStatus: 202, idempotencyKey: "k1" },
        ),
      ).toThrow(PaylodApiError);
    },
  );

  it("refuses a placeholder checkoutRequestId", () => {
    expect(() =>
      parseCollectAck(
        { paymentId: "pay_123", checkoutRequestId: "[redacted]", status: "pending" },
        { httpStatus: 202, idempotencyKey: "k1" },
      ),
    ).toThrow(PaylodApiError);
  });

  it("accepts a well-formed ack — the control", () => {
    const ack = parseCollectAck(
      { paymentId: "pay_123", checkoutRequestId: "ws_CO_1", status: "pending" },
      { httpStatus: 202, idempotencyKey: "k1" },
    );
    expect(ack.paymentId).toBe("pay_123");
    expect(ack.checkoutRequestId).toBe("ws_CO_1");
  });

  it.each(["[redacted]", "***", "REDACTED", "<hidden>"])(
    "refuses %j as a caller-supplied idempotency key",
    (bad) => {
      expect(() => assertValidIdempotencyKey(bad)).toThrow(PaylodInvalidRequestError);
    },
  );

  it("still accepts a real opaque key — the control", () => {
    expect(() => assertValidIdempotencyKey("6f1c9e2a-6b1e-4f0a-9d3a-2c5e7b8a1f04")).not.toThrow();
    expect(() => assertValidIdempotencyKey("attempt_99182")).not.toThrow();
  });
});

describe("the grammar helpers themselves discriminate", () => {
  it("isValidIdentifier accepts real ids and refuses placeholder punctuation", () => {
    expect(isValidIdentifier("pay_123")).toBe(true);
    expect(isValidIdentifier("ws_CO_190220231234567890")).toBe(true);
    expect(isValidIdentifier("[redacted]")).toBe(false);
    expect(isValidIdentifier("a b")).toBe(false);
    expect(isValidIdentifier("")).toBe(false);
    expect(isValidIdentifier("x".repeat(129))).toBe(false);
  });

  it("looksSanitized fires on sanitizer output and not on real keys", () => {
    expect(looksSanitized("[redacted]")).toBe(true);
    expect(looksSanitized("***")).toBe(true);
    expect(looksSanitized("value was masked")).toBe(true);
    expect(looksSanitized("�")).toBe(true);
    expect(looksSanitized("6f1c9e2a-6b1e-4f0a-9d3a-2c5e7b8a1f04")).toBe(false);
    expect(looksSanitized("attempt_99182")).toBe(false);
  });
});

describe("spec 3.5 / 1.5 — a code that is not evidence resolves to indeterminate", () => {
  it.each([77777, "77777", 424242])(
    "a canonically-shaped code the catalog never heard of (%s) is NOT a terminal failure",
    (code) => {
      expect(judge(p({ status: "failed", resultCode: code as never })).verdict).toBe(
        "indeterminate",
      );
    },
  );

  it.each(["500.0", " 1032", "1.032e3", "1032.0", "+0"])(
    "a NON-canonical code (%j) is not evidence the prompt is live either",
    (code) => {
      expect(judge(p({ status: "failed", resultCode: code })).verdict).toBe("indeterminate");
    },
  );

  /**
   * THE CONTROLS. An SDK that answers indeterminate to everything is also non-conformant, and
   * both of these are revenue-protecting paths that must survive.
   */
  it("a GENUINE catalog failure code is still a terminal failure", () => {
    expect(judge(p({ status: "failed", resultCode: 1032 })).verdict).toBe("failed");
  });

  it("a catalogued PENDING code on a failed row is still in_flight — the prompt is live", () => {
    expect(judge(p({ status: "failed", resultCode: 4999 })).verdict).toBe("in_flight");
  });

  it("the still-processing prose safety net survives for a canonical uncatalogued code", () => {
    // This net lives on the canonical-numeric branch and guards against a pending code paylod
    // has not catalogued yet. Reporting that as indeterminate would be safe; reporting it as
    // in_flight is BETTER, because the wait keeps polling a prompt that is genuinely live.
    const v = judge(
      p({
        status: "failed",
        resultCode: 88888,
        resultDesc: "The transaction is still under processing",
      }),
    ).verdict;
    expect(v).toBe("in_flight");
  });
});
