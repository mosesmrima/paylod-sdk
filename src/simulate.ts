/**
 * The sandbox simulator — a phone that isn't there.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────────
 * Every other part of this SDK is testable from a test file. The one thing that wasn't was the
 * thing that matters most: your own charge path. To see what your `/api/pay` route does when the
 * customer types the wrong PIN, you had to find a handset, send yourself a prompt, and type the
 * wrong PIN. So nobody tested their failure paths, which is precisely where payment bugs live.
 *
 * This surface removes the handset. It does NOT mock anything else:
 *   - it creates a REAL payment row (`env=sandbox`, forced server-side)
 *   - it settles through the SAME code path a real Daraja callback takes
 *   - it carries the REAL Daraja result codes (0 / 1032 / 1037 / 2001 / 1)
 *   - it fires a REAL signed webhook, delivered by the real webhook worker
 *   - `status()` / `check()` / `wait()` read it like any other payment
 *
 * The only fiction is the handset. Everything downstream of it is production code.
 *
 * ── Sandbox only, structurally ────────────────────────────────────────────────────────────
 * Every method here refuses a `mp_live_` key LOCALLY, before a byte leaves the process. The
 * backend 403s it too, but a "simulate" call that can even *attempt* to touch production is a
 * footgun. The key prefix tells us; we don't need the round-trip to find out.
 */

import { PaylodInvalidRequestError, PaylodSandboxOnlyError } from "./errors.js";
import {
  assertAccountReference,
  assertChargeAmount,
  assertDescription,
  assertValidIdempotencyKey,
  parseCollectAck,
  parsePaymentBody,
  resolveIdempotencyKey,
} from "./validate.js";
import { withIdempotencyKey } from "./reconcile.js";
import { toOutcome } from "./outcome.js";
import type { PaymentOutcome } from "./outcome.js";
import { normalizePhone } from "./phone.js";
import type { IdempotencyParams, Payment } from "./types.js";

/**
 * The five things that can happen to an STK prompt, as a typed union — a typo is a compile error,
 * not a 422 you discover in CI.
 *
 * | outcome              | settles as  | Daraja code | `PaymentOutcome.status` |
 * | -------------------- | ----------- | ----------- | ----------------------- |
 * | `approve`            | `success`   | `0`         | `succeeded`             |
 * | `wrong_pin`          | `failed`    | `2001`      | `failed`                |
 * | `insufficient_funds` | `failed`    | `1`         | `failed`                |
 * | `user_cancelled`     | `failed`    | `1032`      | `cancelled`             |
 * | `timeout`            | `failed`    | `1037`      | `failed`                |
 *
 * Note `timeout` here is Daraja's 1037 — "we could not reach the handset" — which is a *settled*
 * failure. It is NOT {@link PaylodTimeoutError}, which is what `wait()` throws when a payment is
 * still pending at your deadline (an indeterminate payment, not a failed one). Different things.
 */
export type SimOutcomeId =
  | "approve"
  | "wrong_pin"
  | "insufficient_funds"
  | "user_cancelled"
  | "timeout";

/** Every outcome, in the order the hosted simulator shows them. Handy for a `for…of` in a test. */
export const SIM_OUTCOMES = [
  "approve",
  "wrong_pin",
  "insufficient_funds",
  "user_cancelled",
  "timeout",
] as const satisfies readonly SimOutcomeId[];

/** What `POST /simulate/collect` accepts, minus the idempotency pair. */
export interface SimulateCollectParamsBase {
  /** Any Kenyan format. Nothing is sent to it — no handset is involved. Defaults to a test number. */
  readonly phone?: string;
  /** Whole KES. Defaults to `1`. */
  readonly amount?: number;
  /** Your correlation id, echoed back on the status read and the webhook. 1–32 chars. */
  readonly accountReference?: string;
  /** Same meaning as on `collect()`. Part of the idempotency fingerprint, so it is forwarded. */
  readonly description?: string;
  /** Same meaning as on `collect()`. Part of the idempotency fingerprint, so it is forwarded. */
  readonly metadata?: Record<string, unknown>;
  /**
   * Same meaning as on `collect()`: one key per payment ATTEMPT. Send the same key twice and you
   * get the SAME simulated payment back — same `paymentId`, no second row. Concurrent duplicates
   * collapse into one. Reuse it with a *different body* and you get the same `409` production
   * gives you — which is why every body field, `description` and `metadata` included, is
   * forwarded here rather than dropped.
   *
   * The simulator runs the same idempotency layer production does, which is what lets a "a
   * double-click must not charge twice" test actually prove something — and for the same reason
   * it is REQUIRED here exactly as it is on `collect()`. A simulator with a laxer idempotency
   * contract than production certifies a guarantee that is not in force. In a test the key is
   * usually just a literal: `idempotencyKey: "t-1"`.
   */
  readonly idempotencyKey: string;
}

/** What `POST /simulate/collect` accepts. See {@link IdempotencyParams}. */
export type SimulateCollectParams = Omit<SimulateCollectParamsBase, "idempotencyKey"> &
  IdempotencyParams;

/** One outcome the simulator will accept for a given payment, as the backend advertises it. */
export interface SimOutcomeChoice {
  readonly id: SimOutcomeId;
  readonly label: string;
  readonly status: "success" | "failed";
}

/** The `202` from `POST /simulate/collect` — a real, pending, sandbox payment. */
export interface SimulatedPayment {
  readonly paymentId: string;
  readonly status: "pending";
  readonly checkoutRequestId: string;
  /** The outcomes you may force on this payment. */
  readonly outcomes: readonly SimOutcomeChoice[];
  /**
   * The `Idempotency-Key` that was actually sent — the one you passed, or the throwaway the SDK
   * minted under `unsafeGeneratedIdempotencyKey`. It mirrors {@link CollectAck.idempotencyKey}
   * for the same reason: it is the handle a caller needs to replay THIS attempt rather than mint
   * a fresh key, and `simulate.pay()` needs it to attach to a post-acknowledgement failure.
   */
  readonly idempotencyKey: string;
}

/** The raw `200` body from `POST /simulate/outcome`. */
interface SimSettleAck {
  readonly paymentId: string;
  readonly status: "success" | "failed";
  readonly resultCode: number | null;
  readonly resultDesc: string | null;
  readonly mpesaReceipt: string | null;
  /** `false` if the signed webhook could not be enqueued (a backend problem, not yours). */
  readonly webhookQueued: boolean;
}

/** A settled simulated payment: a normal {@link PaymentOutcome}, plus whether the webhook fired. */
export interface SimulatedOutcome extends PaymentOutcome {
  /** `true` when the real signed webhook was enqueued for delivery to your endpoint. */
  readonly webhookQueued: boolean;
}

/** Phone numbers are irrelevant to the simulator — nothing is sent — but the API wants one. */
const DEFAULT_SIM_PHONE = "254708374149"; // Safaricom's own sandbox test MSISDN

const SANDBOX_PREFIX = "mp_test_";
const LIVE_PREFIX = "mp_live_";

/**
 * Refuse a production key locally. Called by every simulator method, before any request.
 *
 * The backend 403s a `mp_live_` key as well, but that is a second line of defence. A simulate
 * call must be *structurally* incapable of pointing at production, and the key's own prefix is
 * enough to know.
 */
export function assertSandboxKey(apiKey: string, what: string): void {
  if (apiKey.startsWith(SANDBOX_PREFIX)) return;
  const kind = apiKey.startsWith(LIVE_PREFIX)
    ? "a production (mp_live_) key"
    : "a key that is not a sandbox (mp_test_) key";
  throw new PaylodSandboxOnlyError(
    `${what} refused: you gave it ${kind}.\n` +
      "         The simulator only ever creates SANDBOX payments, so a production key is " +
      "categorically the wrong credential — no amount of retrying or key-rotating will make " +
      "this work.\n" +
      "         Use your mp_test_ key here (mint one in the dashboard, or with the MCP " +
      "`mint_key` tool). Nothing is ever sent to a real phone.",
  );
}

/**
 * The single HTTP hook the simulator borrows from the client. Keeps this module transport-free.
 *
 * `validate` is threaded through deliberately. The simulator used to assert its ack AFTER the
 * request returned, which meant it could only see the parsed body and never the HTTP STATUS — so
 * it could not enforce the `202` half of the collect contract, and it passed a hardcoded `200` to
 * the shared validator, certifying a response production would reject. Running the validator
 * inside the request, exactly as the client does, is what makes "the simulator runs the same
 * checks" true rather than aspirational.
 */
export type SimTransport = <T>(opts: {
  method: "POST";
  path: string;
  body: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  project?: (parsed: unknown, status: number) => T;
}) => Promise<T>;

/**
 * The production redactors and credential list, handed to the simulator rather than reimplemented
 * inside it.
 *
 * The simulator ran `withIdempotencyKey(err, key, (m) => m)` — an IDENTITY redactor — and its two
 * projectors called the shared validators with no `secrets` and no redactors at all. So the one
 * surface every integrator's test suite runs against was the surface where a bearer key echoed in
 * an error message, or carried in a `resultDesc` on a 2xx, sailed through untouched. That is the
 * simulator's characteristic failure mode in this repo, and it has now appeared three rounds
 * running under three different names: the simulator is LAXER than production, so a test goes
 * green on a guarantee that is not actually in force. A simulator that certifies the opposite of
 * production is worse than no simulator.
 */
export interface SimGuards {
  /** Scrubs credentials out of any single string. */
  readonly redactText: (s: string) => string;
  /** The same scrub, through a parsed body. */
  readonly redactBody: (b: unknown) => unknown;
  /** Credentials that must not appear ANYWHERE in a successful body. */
  readonly secrets: () => readonly string[];
}

/**
 * Rebuild the outcome menu from an EXACT allowlist, dropping anything that is not one of the
 * five outcomes this SDK knows how to ask for.
 *
 * The menu is server-controlled data on a public object, so it gets the same treatment every
 * other server-controlled structure in this SDK gets: reconstructed field by field from values
 * that were checked, never cast. `id` must be one of `SIM_OUTCOMES` — an id the SDK cannot ask
 * for is not a choice, it is noise — and `label` / `status` are rebuilt rather than carried, so a
 * sixth field cannot ride along inside an entry.
 */
function parseOutcomeMenu(parsed: unknown): readonly SimOutcomeChoice[] {
  const raw = (parsed as { outcomes?: unknown } | null)?.outcomes;
  if (!Array.isArray(raw)) return [];
  const out: SimOutcomeChoice[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || !(SIM_OUTCOMES as readonly string[]).includes(id)) continue;
    const status = e.status;
    if (status !== "success" && status !== "failed") continue;
    out.push({
      id: id as SimOutcomeId,
      label: typeof e.label === "string" ? e.label : id,
      status,
    });
  }
  return out;
}

/**
 * The settle ack names the payment `paymentId`; a `Payment` names it `id`. Rename so the SHARED
 * payment validator can be run against it rather than a near-copy being written here — a
 * near-copy is how the simulator drifted from production in the first place.
 */
function normalizeSettleAck(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object") return parsed;
  const { paymentId, ...rest } = parsed as Record<string, unknown>;
  return { ...rest, id: paymentId };
}

/**
 * `paylod.simulate` — drive a payment to any of the five outcomes from a test file, with no phone.
 *
 * ```ts
 * const paylod = new Paylod(process.env.PAYLOD_TEST_KEY!);   // mp_test_…
 *
 * // One call: create a payment and force how it resolves.
 * const outcome = await paylod.simulate.pay({ outcome: "wrong_pin" });
 * expect(outcome.status).toBe("failed");
 * expect(outcome.retryable).toBe(true);        // no money moved — a fresh charge is safe
 * expect(outcome.message).toMatch(/PIN/);
 * ```
 *
 * To test *your* code rather than the SDK's, split it in two and put your handler in the middle —
 * the payment id is a real one, so `paylod.check()`, `paylod.wait()`, your webhook route and your
 * UI all run completely unchanged:
 *
 * ```ts
 * const sim = await paylod.simulate.collect({ amount: 250 });
 * // …your app's own polling/rendering code, on a REAL payment id…
 * await paylod.simulate.outcome(sim.paymentId, "insufficient_funds");
 * const view = await readCheckout(sim.paymentId);   // ← the code under test
 * expect(view.message).toMatch(/balance is too low/);
 * ```
 */
export class Simulator {
  readonly #apiKey: string;
  readonly #request: SimTransport;
  readonly #guards: SimGuards;

  constructor(apiKey: string, request: SimTransport, guards: SimGuards) {
    this.#apiKey = apiKey;
    this.#request = request;
    this.#guards = guards;
  }

  /** The five outcomes, typed. `for (const o of paylod.simulate.outcomes) …` */
  get outcomes(): readonly SimOutcomeId[] {
    return SIM_OUTCOMES;
  }

  /**
   * Create a real, pending, sandbox payment. No phone rings.
   *
   * The returned `paymentId` is an ordinary payment id: feed it to `status()`, `check()`,
   * `wait()`, or straight into your own code. It stays `pending` until you call
   * {@link outcome} — which is exactly what a live prompt does while a customer stares at it.
   */
  async collect(
    params: SimulateCollectParams,
    options: { signal?: AbortSignal } = {},
  ): Promise<SimulatedPayment> {
    assertSandboxKey(this.#apiKey, "simulate.collect()");

    // RESOLVED FIRST, exactly as production `collect()` does. A caller who omits the key must
    // hear about the key rather than about whichever other field is validated first.
    // THE production resolver, not a copy of it, and not a weaker rule. The simulator exists so a
    // test can prove "a double-click cannot charge twice" against the code path production runs —
    // which means the simulator's idempotency contract must be production's, exactly. It used to
    // be laxer twice over: a hand-rolled charset check that admitted keys production rejects, and
    // then a silent `?? randomUUID()` for an omitted key. Either one lets a test go green on a
    // guarantee that is not actually in force. So the key is required HERE too, with the same
    // opt-out, the same message and the same every-call warning.
    const idempotencyKey = resolveIdempotencyKey(
      params.idempotencyKey,
      params.unsafeGeneratedIdempotencyKey,
      "simulate.collect()",
    );

    // THE PRODUCTION VALIDATORS, on every simulator dispatch.
    //
    // This used to be a local `Number.isInteger(amount) && amount > 0` and nothing else — no
    // 150,000 KES ceiling, no reference bound, no description bound. So the simulator accepted a
    // charge for 10,000,000 KES with a 200-character description, and a test written against it
    // proved a request production rejects at the boundary. That is the same class of divergence
    // the idempotency-key rule was consolidated to fix: a simulator that is LAXER than production
    // certifies guarantees that are not in force, which is worse than having no simulator.
    // DEFAULT ONLY ON `undefined` — NEVER ON A FALSY OR INVALID VALUE.
    //
    // These were `params.amount ?? 1` and `params.phone ? normalizePhone(...) : DEFAULT_SIM_PHONE`.
    // `??` already handled `amount`, but the phone ternary silently REPLACED every falsy runtime
    // value — `null`, `""`, `0`, `false` — with the default instead of validating it, and a
    // TypeScript-free caller (plain JS, JSON config, a deserialised fixture) is exactly who
    // supplies those. So `simulate.collect({ phone: null })` quietly charged the default handset
    // and returned success, certifying that production accepts a null phone. Production does not.
    // A simulator that is LAXER than production certifies guarantees that are not in force.
    //
    // `undefined` means "not supplied", which is the one case a documented default belongs to.
    // Everything else the caller actually wrote goes through the production validator.
    const amount = assertChargeAmount(params.amount === undefined ? 1 : params.amount, "simulate.collect()");
    assertAccountReference(params.accountReference, "simulate.collect()");
    assertDescription(params.description, "simulate.collect()");

    const body: Record<string, unknown> = {
      phone: params.phone === undefined ? DEFAULT_SIM_PHONE : normalizePhone(params.phone),
      amount,
    };
    // The backend calls this field `accountRef`; the rest of the SDK calls it `accountReference`.
    // Speak the SDK's language to the caller and the backend's language on the wire.
    if (params.accountReference !== undefined) body.accountRef = params.accountReference;
    // Send the FULL body. The idempotency layer fingerprints the request body, so any field we
    // drop here is a field the simulator cannot fingerprint — and a reused key with changed
    // `description`/`metadata` would 409 in production while silently REPLAYING in the simulator.
    // A simulator that certifies the opposite of production is worse than no simulator.
    if (params.description !== undefined) body.description = params.description;
    if (params.metadata !== undefined) body.metadata = params.metadata;

    // THE RECONCILIATION ENVELOPE, on the simulator too. A `simulate.collect()` that fails
    // mid-flight used to throw bare: no key on the error, so a test asserting "I can always
    // recover the key and replay the same attempt" passed against production and would have
    // failed here. The simulator's whole promise is that your charge path runs unchanged, and
    // the error path is part of the charge path.
    try {
      const ack = await this.#request<SimulatedPayment>({
        method: "POST",
        path: "/simulate/collect",
        body,
        idempotencyKey,
        ...(options.signal ? { signal: options.signal } : {}),
        // THE SAME validator production runs, with the REAL HTTP status — including the 202
        // requirement. A simulator that tolerates an acknowledgement production would reject
        // teaches the wrong thing about the shape of a real response, and silently hands back
        // `paymentId: undefined` for the rest of the test to trip over.
        //
        // It RECONSTRUCTS, exactly as production does: the returned object is built from the
        // validated ack plus the outcome menu, never from the parsed body.
        project: (parsed, status) => {
          const validated = parseCollectAck(parsed, {
            httpStatus: status,
            idempotencyKey,
            what: "simulate.collect()",
            // THE PRODUCTION REDACTORS AND CREDENTIAL LIST. Omitting them here made the
            // simulator's success boundary weaker than production's on exactly the check that
            // keeps the bearer key out of a returned object.
            redactBody: this.#guards.redactBody,
            redactText: this.#guards.redactText,
            secrets: this.#guards.secrets(),
          });
          return {
            paymentId: validated.paymentId,
            status: "pending",
            checkoutRequestId: validated.checkoutRequestId,
            // REBUILT FROM AN ALLOWLIST, exactly like every other server-controlled array in
            // this SDK. `raw.outcomes as SimOutcomeChoice[]` was a CAST, which is not a check:
            // the entries reached a public object with whatever fields, and whatever field
            // VALUES, the server chose. `label` in particular is free text that a test harness
            // prints, so an echoed bearer key rode out inside it.
            outcomes: parseOutcomeMenu(parsed),
            idempotencyKey,
          };
        },
      });

      return ack;
    } catch (err) {
      throw withIdempotencyKey(err, idempotencyKey, (m) => this.#guards.redactText(m));
    }
  }

  /**
   * Force how a simulated payment resolves, and get back the ordinary {@link PaymentOutcome} the
   * rest of the SDK returns — decoded, renderable, with `retryable` already correct.
   *
   * A real signed webhook fires as a side effect, so your webhook route is exercised too.
   *
   * @throws {PaylodApiError} `409` if the payment is already settled (you can only do this once —
   *   same as a real handset), `404` if it isn't yours or isn't a simulated payment.
   */
  async outcome(
    paymentId: string,
    outcome: SimOutcomeId,
    options: { signal?: AbortSignal } = {},
  ): Promise<SimulatedOutcome> {
    assertSandboxKey(this.#apiKey, "simulate.outcome()");
    if (!paymentId) throw new PaylodInvalidRequestError("simulate.outcome(): paymentId is required.");

    // THE DERIVED KEY RUNS THE SHARED VALIDATOR.
    //
    // It is built by interpolating a caller-supplied `paymentId` into a template, and then it was
    // put straight into an HTTP header without ever meeting the rule every other key in this SDK
    // must satisfy. A payment id carrying a newline, a space, a C1 control or a non-ASCII
    // character produced a key production would reject outright — either a transport crash or,
    // worse, a silently re-encoded header, which is the exact "two requests stop sharing one key"
    // failure `assertValidIdempotencyKey` exists to prevent. Deriving a key is not a reason to
    // skip validating it; it is a reason to validate it, because nobody reviewed it by hand.
    const idempotencyKey = `sim-outcome-${paymentId}-${outcome}`;
    assertValidIdempotencyKey(idempotencyKey, "simulate.outcome(): derived idempotencyKey");

    try {
      return await this.#settle(paymentId, outcome, idempotencyKey, options);
    } catch (err) {
      // Settling is a mutating call, so its failures carry the key AND the payment id — the two
      // handles needed to find out whether the settle landed before deciding anything else.
      throw withIdempotencyKey(err, idempotencyKey, (m) => this.#guards.redactText(m), paymentId);
    }
  }

  /** The settle dispatch itself. Split out so the reconciliation envelope wraps ALL of it. */
  async #settle(
    paymentId: string,
    outcome: SimOutcomeId,
    idempotencyKey: string,
    options: { signal?: AbortSignal },
  ): Promise<SimulatedOutcome> {
    const ack = await this.#request<SimulatedOutcome>({
      method: "POST",
      path: "/simulate/outcome",
      body: { paymentId, outcome },
      // Settling is a MUTATING call and it carried no idempotency key at all, so a network retry
      // could re-dispatch it. The key is derived deterministically from the operation, which is
      // exactly the right shape here: retrying "settle THIS payment as THIS outcome" is the same
      // operation and must replay, while settling it as a different outcome is a different one.
      idempotencyKey,
      ...(options.signal ? { signal: options.signal } : {}),
      // The settle response describes a PAYMENT, so it runs the payment validator — the same one
      // `status()` runs, ID BINDING included. This surface previously did no validation at all:
      // it read `ack.paymentId` / `ack.status` straight into a `Payment` and handed it to the
      // classifier, so a body describing a DIFFERENT payment (or carrying an unknown status) was
      // classified on its merits and returned as this payment's outcome. Every dispatch surface
      // runs the same validators, or the guarantee is not a guarantee.
      // RECONSTRUCTED, exactly as `status()` is. The settle ack describes a payment, so the
      // shared parser owns the `Payment` that reaches the classifier — the fields are rebuilt
      // from the validated body rather than read off the raw one, so a simulator response cannot
      // carry an unknown field into a `PaymentOutcome` any more than a production one can.
      project: (parsed, status) => {
        const payment = parsePaymentBody(normalizeSettleAck(parsed), {
          httpStatus: status,
          expectedId: paymentId,
          what: "simulate.outcome()",
          redactBody: this.#guards.redactBody,
          redactText: this.#guards.redactText,
          secrets: this.#guards.secrets(),
        });
        const raw = parsed as { webhookQueued?: unknown };
        // A BOOLEAN, OR NOTHING. This was `raw.webhookQueued !== false`, which is true for every
        // value in the language except the literal `false` — so `null`, `0`, `"no"`, `{}` and a
        // missing-but-misspelled field all reported "your reconciliation webhook was queued".
        // That is the one field a caller uses to decide whether to expect delivery at all, so
        // coercing a malformed value to `true` tells them to wait for an event that will never
        // arrive. Absence is the documented default (`true`); anything present and non-boolean is
        // a response we do not understand, and the honest answer there is `false` — do not rely
        // on delivery — rather than an invented reassurance.
        const queued = raw.webhookQueued;
        return {
          ...toOutcome(payment),
          webhookQueued: queued === undefined ? true : queued === true,
        };
      },
    });

    return ack;
  }

  /**
   * {@link collect} + {@link outcome} in one call — the whole point of the simulator, in one line.
   *
   * ```ts
   * for (const outcome of paylod.simulate.outcomes) {
   *   const result = await paylod.simulate.pay({ outcome });
   *   console.log(outcome, "→", result.status, result.message, result.retryable);
   * }
   * ```
   */
  async pay(
    params: SimulateCollectParams & { readonly outcome: SimOutcomeId },
    options: { signal?: AbortSignal } = {},
  ): Promise<SimulatedOutcome> {
    // Rebuilt rather than spread-through: a rest element over a union widens the idempotency pair
    // back into "both optional", which is precisely the shape the required key exists to forbid.
    const { outcome, ...rest } = params;
    const created = await this.collect(rest as SimulateCollectParams, options);

    // POST-ACKNOWLEDGEMENT FAILURES CARRY THE PAYMENT ID.
    //
    // `collect()` above attaches the key to its own failures, but the moment it returns, a
    // payment EXISTS — and everything after that point used to throw with no payment id on it.
    // A caller catching a failed `simulate.pay()` therefore had no handle on the row that had
    // just been created, which is the same loss `collectAndWait` was fixed for on the production
    // side. The simulator has to lose the same things production loses, and no more.
    try {
      return await this.outcome(created.paymentId, outcome, options);
    } catch (err) {
      throw withIdempotencyKey(
        err,
        created.idempotencyKey,
        (m) => this.#guards.redactText(m),
        created.paymentId,
      );
    }
  }
}
