import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  Paylod,
  PaylodSignatureVerificationError,
  SIGNATURE_HEADER,
  signWebhook,
  verifyWebhook,
  verifyWebhookSignature,
} from "../src/index.js";
import type { WebhookEvent } from "../src/index.js";
import { mockFetch } from "./helpers.js";

const SECRET = "whsec_test_secret";

const EVENT: WebhookEvent = {
  type: "payment.success",
  created: 1_700_000_000,
  data: {
    paymentId: "pay_123",
    applicationId: "app_1",
    env: "sandbox",
    status: "success",
    amount: 100,
    phone: "254712345678",
    accountRef: "order-42",
    mpesaReceipt: "SFF6XYZ123",
    checkoutRequestId: "ws_CO_0001",
    resultCode: 0,
    resultDesc: "The service request is processed successfully.",
    decoded: null,
  },
};

const RAW = JSON.stringify(EVENT);
const NOW = EVENT.created; // pin the clock to the event's own timestamp

function paylod() {
  return new Paylod({ apiKey: "mp_test_x", webhookSecret: SECRET, fetch: mockFetch([]).fetch, allowCustomFetch: true });
}

describe("signature scheme parity with the backend", () => {
  it("produces exactly HMAC-SHA256(secret, `${t}.${rawBody}`) in a t=,v1= header", () => {
    const header = signWebhook(RAW, SECRET, NOW);
    const expected = createHmac("sha256", SECRET).update(`${NOW}.${RAW}`).digest("hex");
    expect(header).toBe(`t=${NOW},v1=${expected}`);
  });

  it("uses the x-webhook-signature header name", () => {
    expect(SIGNATURE_HEADER).toBe("x-webhook-signature");
  });

  // SHARED GOLDEN VECTOR — the SAME secret+timestamp+body+expected-hex is pinned, byte-for-byte,
  // in paylod-cli (src/lib/webhook.test.ts) and mirrors the backend signer
  // (supabase/functions/_shared/webhooks/sign.ts). If any of the three signing/verifying impls
  // drifts, its copy of this vector fails — that is the guard against silent cross-repo drift.
  // DO NOT edit these literals to "fix" a failure: a mismatch means the scheme itself changed.
  it("matches the shared golden vector (cross-repo drift guard)", () => {
    const GOLDEN_SECRET = "whsec_golden_vector_v1";
    const GOLDEN_T = 1_700_000_000;
    const GOLDEN_BODY =
      '{"type":"payment.success","created":1700000000,"data":{"paymentId":"pay_golden","amount":100,"phone":"254712345678"}}';
    const GOLDEN_HEADER =
      "t=1700000000,v1=3afe38e4c11734c84fad70dd16bbaeec6057ca998236f253be6bfa09ad2c2eb7";

    expect(signWebhook(GOLDEN_BODY, GOLDEN_SECRET, GOLDEN_T)).toBe(GOLDEN_HEADER);
    // The vector pins the SIGNING SCHEME. Its body is a minimal signing fixture rather than a
    // representative event, so it is verified at the signature layer — `verifyWebhook` also
    // enforces the event schema, which is covered by its own tests instead of by editing these
    // cross-repo-pinned literals.
    // And the verifier accepts its own signer's golden output. The fixed vector pins the clock via
    // `nowSec` at the vector's own `t` and runs a NORMAL 300s window — that is the only sanctioned
    // way to verify an ancient fixture, because the freshness check can no longer be disabled.
    const event = verifyWebhookSignature({
      payload: GOLDEN_BODY,
      signature: GOLDEN_HEADER,
      secret: GOLDEN_SECRET,
      toleranceSec: 300,
      nowSec: GOLDEN_T,
    }) as { data: { paymentId: string } };
    expect(event.data.paymentId).toBe("pay_golden");
  });
});

describe("verifyWebhook", () => {
  it("accepts a valid signature and returns the typed event", () => {
    const event = verifyWebhook({
      payload: RAW,
      signature: signWebhook(RAW, SECRET, NOW),
      secret: SECRET,
      nowSec: NOW,
    });
    expect(event.type).toBe("payment.success");
    expect(event.data.mpesaReceipt).toBe("SFF6XYZ123");
  });

  it("rejects a TAMPERED body signed with the original signature", () => {
    const header = signWebhook(RAW, SECRET, NOW);
    const tampered = RAW.replace('"amount":100', '"amount":1');
    expect(tampered).not.toBe(RAW);

    const err = (() => {
      try {
        verifyWebhook({ payload: tampered, signature: header, secret: SECRET, nowSec: NOW });
      } catch (e) {
        return e;
      }
    })() as PaylodSignatureVerificationError;

    expect(err).toBeInstanceOf(PaylodSignatureVerificationError);
    expect(err.reason).toBe("no_match");
  });

  it("rejects a signature made with the wrong secret", () => {
    const header = signWebhook(RAW, "whsec_attacker", NOW);
    expect(() =>
      verifyWebhook({ payload: RAW, signature: header, secret: SECRET, nowSec: NOW }),
    ).toThrow(/does not match/);
  });

  it("rejects a STALE timestamp outside the tolerance (replay)", () => {
    const header = signWebhook(RAW, SECRET, NOW);
    const err = (() => {
      try {
        verifyWebhook({
          payload: RAW,
          signature: header,
          secret: SECRET,
          nowSec: NOW + 301, // default tolerance is 300s
        });
      } catch (e) {
        return e;
      }
    })() as PaylodSignatureVerificationError;

    expect(err.reason).toBe("stale_timestamp");
  });

  it("rejects a FUTURE-dated timestamp too", () => {
    const header = signWebhook(RAW, SECRET, NOW + 3_600);
    expect(() =>
      verifyWebhook({ payload: RAW, signature: header, secret: SECRET, nowSec: NOW }),
    ).toThrow(/tolerance/);
  });

  it("accepts a timestamp just inside the tolerance", () => {
    const header = signWebhook(RAW, SECRET, NOW);
    expect(() =>
      verifyWebhook({ payload: RAW, signature: header, secret: SECRET, nowSec: NOW + 299 }),
    ).not.toThrow();
  });

  it("rejects a missing or malformed header", () => {
    expect(() => verifyWebhook({ payload: RAW, signature: null, secret: SECRET })).toThrow(
      /Missing x-webhook-signature/,
    );
    expect(() =>
      verifyWebhook({ payload: RAW, signature: "deadbeef", secret: SECRET }),
    ).toThrow(/Malformed/);
  });

  it("refuses to verify when no signing secret is configured", () => {
    expect(() =>
      verifyWebhook({ payload: RAW, signature: signWebhook(RAW, SECRET, NOW), secret: "" }),
    ).toThrow(/signing secret/);
  });

  it("rejects a correctly-signed body that is not JSON", () => {
    const raw = "not json at all";
    const err = (() => {
      try {
        verifyWebhook({
          payload: raw,
          signature: signWebhook(raw, SECRET, NOW),
          secret: SECRET,
          nowSec: NOW,
        });
      } catch (e) {
        return e;
      }
    })() as PaylodSignatureVerificationError;
    expect(err.reason).toBe("invalid_payload");
  });

  it("rejects a correctly-signed body that is not a paylod event", () => {
    const raw = JSON.stringify({ hello: "world" });
    expect(() =>
      verifyWebhook({
        payload: raw,
        signature: signWebhook(raw, SECRET, NOW),
        secret: SECRET,
        nowSec: NOW,
      }),
    ).toThrow(/not a valid paylod event/);
  });

  it("rejects a non-numeric timestamp", () => {
    const good = signWebhook(RAW, SECRET, NOW);
    const bad = good.replace(/^t=\d+/, "t=abc");
    expect(() => verifyWebhook({ payload: RAW, signature: bad, secret: SECRET })).toThrow(
      /not a number/,
    );
  });

  // ── FIX 12: signature header strictness (exactly one integer t + one 64-hex v1) ──────────
  describe("header strictness", () => {
    const goodV1 = () => signWebhook(RAW, SECRET, NOW).split("v1=")[1]!;

    it("rejects a comma-combined header carrying TWO signatures (last-value-wins is unsafe)", () => {
      // Two `x-webhook-signature` values joined by a comma: a forged pair appended after a real one.
      const combined = `t=${NOW},v1=${goodV1()},t=9999999999,v1=${"0".repeat(64)}`;
      const err = (() => {
        try {
          verifyWebhook({ payload: RAW, signature: combined, secret: SECRET, nowSec: NOW });
        } catch (e) {
          return e;
        }
      })() as PaylodSignatureVerificationError;
      expect(err).toBeInstanceOf(PaylodSignatureVerificationError);
      expect(err.reason).toBe("malformed_signature");
    });

    it("rejects a duplicated v1", () => {
      const dup = `t=${NOW},v1=${goodV1()},v1=${goodV1()}`;
      expect(() =>
        verifyWebhook({ payload: RAW, signature: dup, secret: SECRET, nowSec: NOW }),
      ).toThrow(/Malformed/);
    });

    it("rejects a v1 that is not 64 lowercase-hex chars", () => {
      const short = `t=${NOW},v1=deadbeef`;
      const upper = `t=${NOW},v1=${goodV1().toUpperCase()}`;
      expect(() =>
        verifyWebhook({ payload: RAW, signature: short, secret: SECRET, nowSec: NOW }),
      ).toThrow(/Malformed/);
      expect(() =>
        verifyWebhook({ payload: RAW, signature: upper, secret: SECRET, nowSec: NOW }),
      ).toThrow(/Malformed/);
    });

    it("still accepts a single well-formed pair", () => {
      const ok = `t=${NOW},v1=${goodV1()}`;
      expect(() =>
        verifyWebhook({ payload: RAW, signature: ok, secret: SECRET, nowSec: NOW }),
      ).not.toThrow();
    });
  });

  it("verifies an ancient fixture by pinning the clock with nowSec at the fixture's own t", () => {
    const header = signWebhook(RAW, SECRET, 1); // ancient
    expect(() =>
      verifyWebhook({ payload: RAW, signature: header, secret: SECRET, toleranceSec: 300, nowSec: 1 }),
    ).not.toThrow();
  });

  // ── FIX 13: a non-positive tolerance must NOT silently disable replay protection ──────────
  it("REFUSES toleranceSec: 0 in production (no injected clock) — replay protection stays on", () => {
    const header = signWebhook(RAW, SECRET, NOW);
    const err = (() => {
      try {
        verifyWebhook({ payload: RAW, signature: header, secret: SECRET, toleranceSec: 0 });
      } catch (e) {
        return e;
      }
    })() as PaylodSignatureVerificationError;
    expect(err).toBeInstanceOf(PaylodSignatureVerificationError);
    expect(err.reason).toBe("insecure_tolerance");
  });

  it("REFUSES a negative tolerance — an injected nowSec is NOT an escape hatch", () => {
    const header = signWebhook(RAW, SECRET, NOW);
    expect(() =>
      verifyWebhook({ payload: RAW, signature: header, secret: SECRET, toleranceSec: -5 }),
    ).toThrow(/tolerance/i);
    // …and pinning the clock does NOT buy an exemption; the escape hatch is gone entirely.
    expect(() =>
      verifyWebhook({ payload: RAW, signature: header, secret: SECRET, toleranceSec: -5, nowSec: NOW }),
    ).toThrow(/tolerance/i);
  });

  it("verifies a Buffer payload identically to a string", () => {
    const header = signWebhook(RAW, SECRET, NOW);
    const event = verifyWebhook({
      payload: Buffer.from(RAW, "utf8"),
      signature: header,
      secret: SECRET,
      nowSec: NOW,
    });
    expect(event.data.paymentId).toBe("pay_123");
  });

  it("fails a re-serialised body whose bytes differ — proving raw bytes matter", () => {
    const spacedRaw = JSON.stringify(EVENT, null, 2);
    const header = signWebhook(RAW, SECRET, NOW); // signed over the COMPACT bytes
    expect(() =>
      verifyWebhook({ payload: spacedRaw, signature: header, secret: SECRET, nowSec: NOW }),
    ).toThrow(PaylodSignatureVerificationError);
  });
});

describe("failed events carry the decoded error", () => {
  it("exposes decoded.customerMessage identical to the offline catalog", () => {
    const failed: WebhookEvent = {
      type: "payment.failed",
      created: NOW,
      data: {
        ...EVENT.data,
        status: "failed",
        mpesaReceipt: null,
        resultCode: 1037,
        resultDesc: "DS timeout",
        decoded: paylod().decodeError(1037),
      },
    };
    const raw = JSON.stringify(failed);
    const event = verifyWebhook({
      payload: raw,
      signature: signWebhook(raw, SECRET, NOW),
      secret: SECRET,
      nowSec: NOW,
    });
    expect(event.data.decoded?.customerMessage).toBe(
      "The M-Pesa prompt expired before it was answered. Check your phone is on, then try again " +
        "and enter your PIN when it appears.",
    );
  });
});

describe("webhookHandler (Request/Response — Next.js, Hono, Workers)", () => {
  it("200s and invokes the handler on a valid signature", async () => {
    vi.setSystemTime(NOW * 1000);
    const seen: WebhookEvent[] = [];
    const handler = paylod().webhookHandler(async (e) => {
      seen.push(e);
    });

    const res = await handler(
      new Request("https://app.test/webhook", {
        method: "POST",
        headers: { [SIGNATURE_HEADER]: signWebhook(RAW, SECRET, NOW) },
        body: RAW,
      }),
    );

    expect(res.status).toBe(200);
    expect(seen[0]?.data.paymentId).toBe("pay_123");
    vi.useRealTimers();
  });

  it("400s on a bad signature and never calls the handler", async () => {
    const handler = vi.fn();
    const res = await paylod().webhookHandler(handler)(
      new Request("https://app.test/webhook", {
        method: "POST",
        headers: { [SIGNATURE_HEADER]: signWebhook(RAW, "wrong", NOW) },
        body: RAW,
      }),
    );
    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("500s when the handler throws, so paylod retries the delivery", async () => {
    vi.setSystemTime(NOW * 1000);
    const res = await paylod().webhookHandler(() => {
      throw new Error("db down");
    })(
      new Request("https://app.test/webhook", {
        method: "POST",
        headers: { [SIGNATURE_HEADER]: signWebhook(RAW, SECRET, NOW) },
        body: RAW,
      }),
    );
    expect(res.status).toBe(500);
    vi.useRealTimers();
  });
});

describe("webhook (Express middleware)", () => {
  function res() {
    const out = { code: 0, body: null as unknown };
    const r = {
      status(code: number) {
        out.code = code;
        return r;
      },
      json(body: unknown) {
        out.body = body;
        return body;
      },
    };
    return { r, out };
  }

  it("verifies an express.raw() Buffer body and 200s", async () => {
    vi.setSystemTime(NOW * 1000);
    const seen: WebhookEvent[] = [];
    const mw = paylod().webhook((e) => {
      seen.push(e);
    });
    const { r, out } = res();

    await mw(
      {
        headers: { [SIGNATURE_HEADER]: signWebhook(RAW, SECRET, NOW) },
        body: Buffer.from(RAW, "utf8"),
      },
      r,
    );

    expect(out.code).toBe(200);
    expect(seen[0]?.type).toBe("payment.success");
    vi.useRealTimers();
  });

  it("400s with an actionable message when a JSON parser already ate the raw body", async () => {
    const mw = paylod().webhook(() => {});
    const { r, out } = res();

    await mw(
      { headers: { [SIGNATURE_HEADER]: signWebhook(RAW, SECRET, NOW) }, body: { ...EVENT } },
      r,
    );

    expect(out.code).toBe(400);
    expect(String((out.body as { error: string }).error)).toMatch(/express\.raw/);
  });

  it("400s on a tampered body", async () => {
    vi.setSystemTime(NOW * 1000);
    const handler = vi.fn();
    const mw = paylod().webhook(handler);
    const { r, out } = res();

    await mw(
      {
        headers: { [SIGNATURE_HEADER]: signWebhook(RAW, SECRET, NOW) },
        body: Buffer.from(RAW.replace("SFF6XYZ123", "FAKE00000"), "utf8"),
      },
      r,
    );

    expect(out.code).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
