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
import { toOutcome } from "./outcome.js";
import type { PaymentOutcome } from "./outcome.js";
import { normalizePhone } from "./phone.js";
import type { Payment } from "./types.js";

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

/** What `POST /simulate/collect` accepts. */
export interface SimulateCollectParams {
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
   * double-click must not charge twice" test actually prove something.
   */
  readonly idempotencyKey?: string;
}

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

/** The single HTTP hook the simulator borrows from the client. Keeps this module transport-free. */
export type SimTransport = <T>(opts: {
  method: "POST";
  path: string;
  body: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}) => Promise<T>;

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

  constructor(apiKey: string, request: SimTransport) {
    this.#apiKey = apiKey;
    this.#request = request;
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
    params: SimulateCollectParams = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SimulatedPayment> {
    assertSandboxKey(this.#apiKey, "simulate.collect()");

    const amount = params.amount ?? 1;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new PaylodInvalidRequestError(
        `simulate.collect(): amount must be a positive whole number of KES (got ${amount}).`,
      );
    }

    const body: Record<string, unknown> = {
      phone: params.phone ? normalizePhone(params.phone) : DEFAULT_SIM_PHONE,
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

    const ack = await this.#request<{
      paymentId: string;
      checkoutRequestId: string;
      status: "pending";
      outcomes: readonly SimOutcomeChoice[];
    }>({
      method: "POST",
      path: "/simulate/collect",
      body,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    return {
      paymentId: ack.paymentId,
      status: "pending",
      checkoutRequestId: ack.checkoutRequestId,
      outcomes: ack.outcomes ?? [],
    };
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

    const ack = await this.#request<SimSettleAck>({
      method: "POST",
      path: "/simulate/outcome",
      body: { paymentId, outcome },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    // Build the outcome with the SAME classifier every other read uses. This is the point of the
    // whole feature: there is no "simulated" outcome type and no special branch — `paylod.check()`
    // on this id returns an identical object.
    const payment: Payment = {
      id: ack.paymentId,
      status: ack.status,
      mpesaReceipt: ack.mpesaReceipt ?? null,
      resultCode: ack.resultCode ?? null,
      resultDesc: ack.resultDesc ?? null,
    };
    return { ...toOutcome(payment), webhookQueued: ack.webhookQueued !== false };
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
    const { outcome, ...collectParams } = params;
    const created = await this.collect(collectParams, options);
    return this.outcome(created.paymentId, outcome, options);
  }
}
