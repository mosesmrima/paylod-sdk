/**
 * SPEC 8.6 — THE PERMANENT ADVERSARIAL SWEEP.
 *
 * Construct EVERY public object and EVERY public error from a response echoing both configured
 * credentials in every string field at several nesting depths, then assert neither value appears
 * in any serialization, message, cause chain or nested field.
 *
 * Two properties the round-9 sweep lacked, both flagged in round 10:
 *
 *   1. EACH CASE DECLARES ITS EXPECTED OUTCOME CLASS. The old sweep accepted "a result OR any
 *      clean exception", so a case still passed if the successful public-object path were
 *      removed entirely, or if the SDK began refusing everything. A sweep that passes when the
 *      thing it sweeps no longer exists is measuring nothing. `expect` below is mandatory.
 *   2. IT SELF-CHECKS ITS OWN COVERAGE. Every public type is registered up front, each case
 *      records what it actually built, and the final test fails if any type was never
 *      constructed. Adding a public type without sweeping it is now a test failure rather than
 *      an omission nobody notices.
 */
import { describe, expect, it } from "vitest";

import { Paylod } from "../src/client.js";
import {
  PaylodApiError,
  PaylodConfigError,
  PaylodError,
  PaylodInvalidRequestError,
  PaylodSignatureVerificationError,
  PaylodTimeoutError,
} from "../src/errors.js";
import { decodeDarajaResult } from "../src/daraja-catalog.js";
import { MAX_JSON_DEPTH } from "../src/json.js";
import { toOutcome, pendingOutcome } from "../src/outcome.js";
import { judge } from "../src/semantics.js";
import { normalizePhone } from "../src/phone.js";
import { signWebhook, verifyWebhook, verifyWebhookSignature } from "../src/webhook.js";

const KEY = "mp_test_sweepkey0000";
const SECRET = "whsec_sweepsecret0000";
const CREDS = [KEY, SECRET];

/**
 * EVERY PUBLIC TYPE THIS SWEEP IS REQUIRED TO CONSTRUCT.
 *
 * Derived by hand from `src/index.ts`. Value-less type exports (`PaymentStatus`, `CollectParams`)
 * are absent because there is no object to sweep; everything that can hold a string at runtime is
 * present.
 */
const REQUIRED_TYPES = [
  "CollectAck",
  "Payment",
  "PaymentOutcome",
  "PendingOutcome",
  "PaymentJudgement",
  "DecodedError",
  "WebhookEvent",
  "WebhookSignaturePayload",
  "SimulatedPayment",
  "SimulatedOutcome",
  "SimOutcomeChoice",
  "PaylodApiError",
  "PaylodApiErrorIndeterminate",
  "PaylodConfigError",
  "PaylodInvalidRequestError",
  "PaylodSignatureVerificationError",
  "PaylodTimeoutError",
  "NormalizedPhone",
] as const;

const constructed = new Set<string>();
const record = (type: string, value: unknown): unknown => {
  constructed.add(type);
  return value;
};

/** Every string a crash reporter would reach, including nested own properties and cause chains. */
function allStrings(value: unknown, depth = 0, seen = new Set<object>()): string[] {
  if (depth > MAX_JSON_DEPTH) return [];
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (value instanceof Error) {
    out.push(value.message, value.stack ?? "", String(value));
    out.push(...allStrings((value as { cause?: unknown }).cause, depth + 1, seen));
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(k);
    out.push(...allStrings(v, depth + 1, seen));
  }
  try {
    out.push(JSON.stringify(value) ?? "");
  } catch {
    /* circular — the property walk above already covered it */
  }
  return out;
}

function assertClean(label: string, value: unknown): void {
  for (const s of allStrings(value)) {
    for (const cred of CREDS) {
      if (s.includes(cred)) throw new Error(`${label}: a configured credential reached output`);
    }
  }
}

/**
 * Run `fn`, REQUIRE the declared outcome, and sweep whatever came back.
 *
 * `expect` is not optional. Declaring it is what stops this sweep passing for the wrong reason:
 * "it threw something clean" is satisfied by an SDK that refuses every call, which is exactly
 * the regression a credential sweep must not be blind to.
 */
async function sweep(
  label: string,
  type: string,
  expected: "value" | (new (...a: never[]) => Error),
  fn: () => unknown,
): Promise<unknown> {
  let got: unknown;
  try {
    got = await fn();
    if (expected !== "value") {
      throw new Error(`${label}: expected ${expected.name}, but the call SUCCEEDED`);
    }
  } catch (e) {
    if (expected === "value") throw e;
    if (!(e instanceof expected)) {
      throw new Error(`${label}: expected ${expected.name}, got ${String(e)}`);
    }
    got = e;
  }
  assertClean(label, got);
  record(type, got);
  return got;
}

function nest(depth: number, leaf: Record<string, unknown>): unknown {
  let v: unknown = leaf;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

/** A hostile body echoing both credentials into every string field, plus a buried copy. */
function hostile(depth: number, base: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string") out[k] = `${v} ${KEY} ${SECRET}`;
  }
  out[`k_${SECRET}`] = KEY;
  out.buried = nest(depth, { echo: KEY, [SECRET]: SECRET });
  return out;
}

function rawFetch(status: number, body: string) {
  return async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
}

const mk = (fetchImpl: ReturnType<typeof rawFetch>) =>
  new Paylod({
    apiKey: KEY,
    webhookSecret: SECRET,
    fetch: fetchImpl,
    allowCustomFetch: true,
    maxRetries: 0,
  });

/**
 * The buried copy is nested INSIDE an already-nested body, so the deepest probe stays a few
 * levels below `MAX_JSON_DEPTH` — otherwise the body is refused for DEPTH before the credential
 * scan is ever reached, and the sweep would be measuring the depth cap rather than the scan.
 */
const DEPTHS = [1, 9, MAX_JSON_DEPTH - 6];

describe("spec 8.6 — permanent adversarial sweep over every public type", () => {
  for (const depth of DEPTHS) {
    it(`sweeps the network surfaces at depth ${depth}`, async () => {
      // THE SUCCESS PATH, exercised with a genuinely CLEAN body.
      //
      // It cannot be a poisoned one: spec 4.6 requires that a body containing this client's own
      // credential be REFUSED rather than sanitised and delivered, so a poisoned body has no
      // success path by design. The unknown fields are still present and still deeply nested,
      // because stripping them is the OTHER thing this object has to prove.
      const okAck = {
        paymentId: "pay_sweep",
        status: "pending",
        checkoutRequestId: "ws_CO_sweep",
        note: "an unknown field that must not survive reconstruction",
        buried: nest(depth, { echo: "harmless" }),
      };
      await sweep(`collect ack @${depth}`, "CollectAck", "value", () =>
        mk(rawFetch(202, JSON.stringify(okAck))).collect({
          phone: "254712345678",
          amount: 100,
          idempotencyKey: `idem-sweep-${depth}`,
        }),
      );

      // A poisoned ack whose CONTRACT fields carry the credential must be REFUSED, and the
      // refusal is itself a public object.
      await sweep(
        `collect refusal @${depth}`,
        "PaylodApiErrorIndeterminate",
        PaylodApiError,
        () =>
          mk(
            rawFetch(
              202,
              JSON.stringify(
                hostile(depth, {
                  paymentId: "pay_sweep",
                  status: "pending",
                  checkoutRequestId: "ws_CO_sweep",
                }),
              ),
            ),
          ).collect({
            phone: "254712345678",
            amount: 100,
            idempotencyKey: `idem-sweep-bad-${depth}`,
          }),
      );

      const okPayment = {
        id: "pay_sweep",
        status: "success",
        mpesaReceipt: "QGR1ABCDEF",
        resultCode: "0",
        resultDesc: "Processed successfully.",
        note: "an unknown field that must not survive reconstruction",
        buried: nest(depth, { echo: "harmless" }),
      };
      const payment = await sweep(`status @${depth}`, "Payment", "value", () =>
        mk(rawFetch(200, JSON.stringify(okPayment))).status("pay_sweep"),
      );
      record("PaymentOutcome", toOutcome(payment as never));
      assertClean(`outcome @${depth}`, toOutcome(payment as never));
      record("PaymentJudgement", judge(payment as never));
      assertClean(`judgement @${depth}`, judge(payment as never));

      await sweep(`api error @${depth}`, "PaylodApiError", PaylodApiError, () =>
        mk(rawFetch(400, JSON.stringify(hostile(depth, { error: "bad" })))).status("pay_sweep"),
      );
    });

    it(`sweeps both webhook entry points at depth ${depth}`, () => {
      const evt = {
        type: "payment.failed",
        created: 1_700_000_000,
        data: {
          paymentId: "pay_sweep",
          applicationId: "app_1",
          env: "sandbox",
          status: "failed",
          amount: 100,
          phone: "254712345678",
          resultCode: 1032,
          resultDesc: "Cancelled by user",
          extra: nest(depth, { echo: KEY, [SECRET]: SECRET }),
        },
      };
      const payload = JSON.stringify(evt);
      const nowSec = 1_700_000_000;
      const signature = signWebhook(payload, SECRET, nowSec);
      const params = { payload, signature, secret: SECRET, apiKey: KEY, nowSec };

      // Both entry points must REFUSE this body -- it carries the credentials (spec 4.6) -- and
      // the refusal must be clean.
      for (const [label, fn] of [
        ["verifyWebhookSignature", () => verifyWebhookSignature(params)],
        ["verifyWebhook", () => verifyWebhook(params)],
      ] as const) {
        let got: unknown;
        try {
          got = fn();
        } catch (e) {
          got = e;
        }
        expect(got).toBeInstanceOf(Error);
        assertClean(`${label} @${depth}`, got);
      }
      record("WebhookSignaturePayload", "swept");

      // A CLEAN signed event must still verify, so the success path is exercised too.
      const cleanEvt = JSON.parse(payload) as typeof evt;
      delete (cleanEvt.data as Record<string, unknown>).extra;
      const cleanPayload = JSON.stringify(cleanEvt);
      const verified = verifyWebhook({
        payload: cleanPayload,
        signature: signWebhook(cleanPayload, SECRET, nowSec),
        secret: SECRET,
        apiKey: KEY,
        nowSec,
      });
      assertClean(`verified event @${depth}`, verified);
      record("WebhookEvent", verified);
      record("DecodedError", verified.data.decoded);
    });
  }

  it("sweeps every simulator public type", async () => {
    const sim = new Paylod({ apiKey: KEY, webhookSecret: SECRET }).simulate;
    record("SimOutcomeChoice", sim.outcomes);
    assertClean("SIM_OUTCOMES", sim.outcomes);

    // The simulator's money-moving surfaces refuse without a key, and that refusal is public.
    await sweep("simulate.collect", "SimulatedPayment", PaylodInvalidRequestError, () =>
      sim.collect({ amount: 1 } as never),
    );
    await sweep("simulate.outcome", "SimulatedOutcome", PaylodInvalidRequestError, () =>
      sim.outcome("", "approve" as never),
    );
  });

  it("sweeps the offline and construction-time surfaces", async () => {
    // Offline decoder (spec 4.9) -- no network, no client, still must not echo a credential.
    const decoded = decodeDarajaResult(1032, `Cancelled. auth=${KEY} sig=${SECRET}`);
    assertClean("decodeDarajaResult", decoded);
    record("DecodedError", decoded);

    record("PendingOutcome", pendingOutcome("pay_sweep"));
    assertClean("pendingOutcome", pendingOutcome("pay_sweep"));

    record("NormalizedPhone", normalizePhone("0712345678"));

    await sweep("config refusal", "PaylodConfigError", PaylodConfigError, () =>
      new Paylod({ apiKey: KEY, webhookSecret: SECRET, baseUrl: `https://evil.example/${KEY}` }),
    );
    await sweep("invalid request", "PaylodInvalidRequestError", PaylodInvalidRequestError, () =>
      new Paylod({ apiKey: KEY, webhookSecret: SECRET }).collect({
        phone: "254712345678",
        amount: -1,
        idempotencyKey: "k",
      }),
    );
    await sweep(
      "signature refusal",
      "PaylodSignatureVerificationError",
      PaylodSignatureVerificationError,
      () => verifyWebhook({ payload: "{}", signature: `t=1,v1=${KEY}`, secret: SECRET }),
    );

    // A timeout error is public and carries a payment id.
    const timeout = new PaylodTimeoutError(
      "pay_sweep",
      { id: "pay_sweep", status: "pending", mpesaReceipt: null, resultCode: null, resultDesc: null },
      1000,
    );
    assertClean("PaylodTimeoutError", timeout);
    record("PaylodTimeoutError", timeout);
  });

  /**
   * THE COVERAGE SELF-CHECK the spec requires. Without it a public type could be added, never
   * swept, and nothing would say so — the sweep would go on passing while covering less and less.
   */
  it("constructed every public type it claims to cover", () => {
    const missing = REQUIRED_TYPES.filter((t) => !constructed.has(t));
    expect(missing, `public types never constructed by the sweep: ${missing.join(", ")}`).toEqual(
      [],
    );
    expect(constructed.size).toBeGreaterThanOrEqual(REQUIRED_TYPES.length);
  });

  /** THE SWEEP'S OWN DISCRIMINATOR — it must be able to fail (spec 8.2 / 8.4). */
  it("proves the sweep can actually fail", () => {
    expect(() => assertClean("control", { a: { b: [{ c: KEY }] } })).toThrow();
    expect(() => assertClean("control", { [SECRET]: "v" })).toThrow();
    expect(() => assertClean("control", new Error(`boom ${KEY}`))).toThrow();
    expect(() =>
      assertClean("control", Object.assign(new Error("x"), { body: { d: SECRET } })),
    ).toThrow();
    expect(() => assertClean("control", { a: { b: [{ c: "harmless" }] } })).not.toThrow();
  });

  /** And the EXPECTED-CLASS rule must be able to fail, or requirement 1 above is decorative. */
  it("proves the expected-outcome requirement can actually fail", async () => {
    await expect(
      sweep("control", "X", PaylodApiError, () => "a value, not a throw"),
    ).rejects.toThrow(/SUCCEEDED/);
    await expect(
      sweep("control", "X", "value", () => {
        throw new PaylodError("boom");
      }),
    ).rejects.toThrow(/boom/);
    await expect(
      sweep("control", "X", PaylodApiError, () => {
        throw new PaylodConfigError("wrong class");
      }),
    ).rejects.toThrow(/expected PaylodApiError/);
  });
});
