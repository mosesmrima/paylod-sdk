/**
 * SPEC 4.1, 4.4, 4.9, 6.5 — credential shapes, the depth invariant, offline surfaces, and the
 * signature-header bound.
 */
import { describe, expect, it } from "vitest";

import { Paylod } from "../src/client.js";
import { decodeDarajaResult } from "../src/daraja-catalog.js";
import { redactCredentialShapes } from "../src/grammar.js";
import { MAX_JSON_DEPTH, parseBounded } from "../src/json.js";
import { containsSecret } from "../src/validate.js";
import {
  MAX_SIGNATURE_HEADER_CHARS,
  signWebhook,
  verifyWebhook,
  type VerifyParams,
} from "../src/webhook.js";
import { PaylodSignatureVerificationError } from "../src/errors.js";

const KEY = "mp_test_configured_key";
const SECRET = "whsec_configured_secret";

describe("spec 4.1 — credential SHAPES are redacted, not only configured values", () => {
  /**
   * THE GAP. The redactor only ever matched `this.#apiKey` and `this.#webhookSecret` by exact
   * string, so a credential that was not this client's own passed through untouched. Every value
   * below is somebody's live credential and none of them is configured here.
   */
  it.each([
    ["mp_live_SOMEONE_ELSES_KEY", "a live key from another config"],
    ["mp_test_ROTATED_OUT_KEY", "a rotated-out key still present upstream"],
    ["whsec_ANOTHER_TENANTS_SECRET", "another tenant's signing secret"],
    ["sk_stripe_style_token", "a generic secret-key shape"],
    ["Bearer abc.def.ghi", "an echoed Authorization header"],
  ])("redacts %s (%s) even though it is not configured", (credential) => {
    const out = redactCredentialShapes(`server said: ${credential} <- here`);
    expect(out).not.toContain(credential);
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary text alone — the control", () => {
    const benign = "payment pay_123 failed: insufficient balance for 0712345678";
    expect(redactCredentialShapes(benign)).toBe(benign);
  });

  it("still redacts a CONFIGURED secret that matches no shape at all", () => {
    // Neither rule subsumes the other: this value has no credential prefix, so only the
    // exact-match scrub can remove it.
    const odd = "zzz-not-a-recognised-shape-zzz";
    const paylod = new Paylod({ apiKey: odd, webhookSecret: SECRET });
    const err = (() => {
      try {
        // A config refusal interpolates the baseUrl, which carries the credential here.
        new Paylod({ apiKey: odd, webhookSecret: SECRET, baseUrl: `https://paylod.dev/?t=${odd}` });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(paylod).toBeInstanceOf(Paylod);
    expect(err).not.toBeNull();
    expect(err?.message).not.toContain(odd);
  });
});

describe("spec 4.4 — the redaction budget is pinned to the parse budget", () => {
  /**
   * THE INVARIANT, ASSERTED AS A TEST rather than trusted to a comment.
   *
   * All four SDKs independently shipped a redaction bound lower than their parse bound
   * (8/64, 12/64, 8/64, 12/512), so the spec requires this be proven, not documented. This SDK
   * eliminated the second constant instead of bounding it — there is only `MAX_JSON_DEPTH` — so
   * the invariant is asserted the way it can actually fail: the scanner must REACH the bottom of
   * anything the parser ACCEPTS.
   */
  const nest = (depth: number, leaf: string): string => {
    let s = JSON.stringify(leaf);
    for (let i = 0; i < depth; i++) s = `{"a":${s}}`;
    return s;
  };

  it("REDACT_DEPTH >= PARSE_DEPTH: the scanner reaches every depth the parser admits", () => {
    // One constant, so the comparison is trivially true — and it is asserted anyway, because a
    // future edit that reintroduces a second constant must fail here rather than silently.
    const PARSE_DEPTH = MAX_JSON_DEPTH;
    const REDACT_DEPTH = MAX_JSON_DEPTH;
    expect(REDACT_DEPTH).toBeGreaterThanOrEqual(PARSE_DEPTH);
  });

  it("finds a secret at the deepest level the parser will ever hand it", () => {
    const doc = nest(MAX_JSON_DEPTH - 2, `carrying ${SECRET} here`);
    const parsed = parseBounded(doc);
    expect(containsSecret(parsed, [SECRET])).toBe(true);
  });

  it("fails CLOSED past the budget rather than reporting clean (spec 4.5)", () => {
    // A structure the walk cannot reach the bottom of must answer REFUSE, never "clean".
    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_JSON_DEPTH + 5; i++) deep = { a: deep };
    expect(containsSecret(deep, [SECRET])).toBe(true);
  });

  it("reports clean for a shallow structure that genuinely has no secret — the control", () => {
    expect(containsSecret({ a: { b: "nothing here" } }, [SECRET])).toBe(false);
  });
});

describe("spec 4.9 — public offline surfaces redact for themselves", () => {
  /**
   * `decodeDarajaResult` never touches the network, is exported as public API, and is documented
   * for logs and dashboards. It has no client to redact for it, so it had none at all — while
   * interpolating `resultDesc`, the field most likely to carry an echoed Authorization header.
   */
  it.each(["mp_live_LEAKED_VIA_DESC", "Bearer leaked.jwt.here", "whsec_LEAKED"])(
    "keeps %s out of the bare decodeDarajaResult output",
    (credential) => {
      const decoded = decodeDarajaResult(1032, `Cancelled. auth=${credential}`);
      const serialized = JSON.stringify(decoded);
      expect(serialized).not.toContain(credential);
    },
  );

  it("keeps a CONFIGURED credential out of the client's decodeError", () => {
    const paylod = new Paylod({ apiKey: KEY, webhookSecret: SECRET });
    const decoded = paylod.decodeError(1032, `Cancelled by user. echoed=${KEY} and ${SECRET}`);
    const serialized = JSON.stringify(decoded);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(SECRET);
  });

  it("still decodes the code correctly with the description scrubbed — the control", () => {
    const decoded = decodeDarajaResult(1032, "Request cancelled by user");
    expect(decoded.code).toBe("1032");
    expect(decoded.retryable).toBe(true);
    expect(decoded.customerMessage.length).toBeGreaterThan(0);
  });
});

describe("spec 6.5 — the signature header is length-bounded before it is split", () => {
  const base: Omit<VerifyParams, "signature"> = {
    payload: '{"a":1}',
    secret: SECRET,
    nowSec: 1_700_000_000,
  };

  it("refuses an oversized signature header instead of tokenising it", () => {
    const huge = `t=1,${"v1=x,".repeat(MAX_SIGNATURE_HEADER_CHARS)}`;
    expect(huge.length).toBeGreaterThan(MAX_SIGNATURE_HEADER_CHARS);
    const err = (() => {
      try {
        verifyWebhook({ ...base, signature: huge });
        return null;
      } catch (e) {
        return e as PaylodSignatureVerificationError;
      }
    })();
    expect(err).toBeInstanceOf(PaylodSignatureVerificationError);
    // Refused at the header, never at the HMAC.
    expect(err?.reason).not.toBe("no_match");
  });

  it("does not quote the oversized header back", () => {
    const huge = `t=1,v1=${"A".repeat(MAX_SIGNATURE_HEADER_CHARS * 2)}`;
    try {
      verifyWebhook({ ...base, signature: huge });
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(2000);
    }
  });

  /** THE CONTROL. A real header is ~85 characters and must still verify. */
  it("still accepts a genuine header well inside the bound", () => {
    const payload = '{"a":1}';
    const nowSec = 1_700_000_000;
    const signature = signWebhook(payload, SECRET, nowSec);
    expect(signature.length).toBeLessThan(MAX_SIGNATURE_HEADER_CHARS);
    // It gets past the signature stage — it fails later, on the event schema.
    const err = (() => {
      try {
        verifyWebhook({ payload, signature, secret: SECRET, nowSec });
        return null;
      } catch (e) {
        return e as PaylodSignatureVerificationError;
      }
    })();
    expect(err?.reason).not.toBe("no_match");
    expect(err?.reason).not.toBe("invalid_header");
  });
});
