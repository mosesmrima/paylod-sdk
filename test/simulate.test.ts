/**
 * The simulator surface.
 *
 * Two things are being pinned here, and only one of them is "does the HTTP call have the right
 * shape":
 *
 *   1. A `mp_live_` key can NEVER reach the simulator — and is refused LOCALLY, before a request
 *      is sent. Every test that asserts this also asserts `calls.length === 0`, because "the
 *      backend would have 403'd it" is not good enough for a method that could otherwise point at
 *      production.
 *   2. A simulated payment settles to the SAME `PaymentOutcome` a real one does — same classifier,
 *      same `retryable` semantics. If this drifted, the simulator would be testing a fiction.
 */
import { describe, expect, it, vi } from "vitest";

import {
  Paylod,
  PaylodApiError,
  PaylodSandboxOnlyError,
  PaylodInvalidRequestError,
  SIM_OUTCOMES,
  type SimOutcomeId,
} from "../src/index.js";
import { mockFetch } from "./helpers.js";

const TEST_KEY = "mp_test_abc123";
const LIVE_KEY = "mp_live_abc123";

const SIM_ACK = {
  paymentId: "pay_sim_1",
  checkoutRequestId: "sim_ws_CO_1",
  status: "pending",
  provider: "mpesa",
  outcomes: [
    { id: "approve", label: "Approve", status: "success" },
    { id: "wrong_pin", label: "Wrong PIN", status: "failed" },
  ],
};

/** The exact settlement shapes the backend returns, per `_shared/provider/simulator.ts`. */
const SETTLED: Record<SimOutcomeId, Record<string, unknown>> = {
  approve: {
    paymentId: "pay_sim_1",
    status: "success",
    resultCode: 0,
    resultDesc: "The service request is processed successfully.",
    mpesaReceipt: "SFF6XYZ123",
    webhookQueued: true,
  },
  wrong_pin: {
    paymentId: "pay_sim_1",
    status: "failed",
    resultCode: 2001,
    resultDesc: "The initiator information is invalid. (Wrong M-Pesa PIN)",
    mpesaReceipt: null,
    webhookQueued: true,
  },
  insufficient_funds: {
    paymentId: "pay_sim_1",
    status: "failed",
    resultCode: 1,
    resultDesc: "The balance is insufficient for the transaction.",
    mpesaReceipt: null,
    webhookQueued: true,
  },
  user_cancelled: {
    paymentId: "pay_sim_1",
    status: "failed",
    resultCode: 1032,
    resultDesc: "Request cancelled by user",
    mpesaReceipt: null,
    webhookQueued: true,
  },
  timeout: {
    paymentId: "pay_sim_1",
    status: "failed",
    resultCode: 1037,
    resultDesc: "DS timeout user cannot be reached",
    mpesaReceipt: null,
    webhookQueued: true,
  },
};

describe("simulate — the live-key fence", () => {
  it("refuses a mp_live_ key on simulate.collect(), before any request is sent", async () => {
    const m = mockFetch([{ status: 202, json: SIM_ACK }]);
    const paylod = new Paylod(LIVE_KEY, { fetch: m.fetch, maxRetries: 0 });

    await expect(paylod.simulate.collect()).rejects.toThrow(PaylodSandboxOnlyError);
    // The whole point: it never even tried.
    expect(m.calls.length).toBe(0);
  });

  it("refuses a mp_live_ key on simulate.outcome() and simulate.pay(), with no request sent", async () => {
    const m = mockFetch([{ status: 200, json: SETTLED.approve }]);
    const paylod = new Paylod(LIVE_KEY, { fetch: m.fetch, maxRetries: 0 });

    await expect(paylod.simulate.outcome("pay_1", "approve")).rejects.toThrow(
      PaylodSandboxOnlyError,
    );
    await expect(paylod.simulate.pay({ outcome: "approve" })).rejects.toThrow(
      PaylodSandboxOnlyError,
    );
    expect(m.calls.length).toBe(0);
  });

  it("says WHY, and does not imply the key is broken", async () => {
    const paylod = new Paylod(LIVE_KEY, { fetch: mockFetch([]).fetch });
    await expect(paylod.simulate.collect()).rejects.toThrow(/production \(mp_live_\) key/i);
    await expect(paylod.simulate.collect()).rejects.toThrow(/mp_test_ key/i);
  });

  it("refuses to CONSTRUCT a simulate-mode client with a live key", () => {
    expect(() => new Paylod(LIVE_KEY, { simulate: true })).toThrow(PaylodSandboxOnlyError);
    // A PaylodSandboxOnlyError is a PaylodConfigError — existing catches keep working.
    expect(() => new Paylod(LIVE_KEY, { simulate: true })).toThrow(/simulate/i);
  });

  it("a sandbox key is accepted", () => {
    expect(() => new Paylod(TEST_KEY, { simulate: true })).not.toThrow();
  });
});

describe("simulate.collect", () => {
  it("POSTs /simulate/collect with a normalised phone and returns a real pending payment", async () => {
    const m = mockFetch([{ status: 202, json: SIM_ACK }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0 });

    const sim = await paylod.simulate.collect({ phone: "0712345678", amount: 250, accountReference: "order-1" });

    expect(m.calls[0]!.url).toContain("/simulate/collect");
    expect(m.calls[0]!.body).toEqual({ phone: "254712345678", amount: 250, accountRef: "order-1" });
    expect(m.calls[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`);

    expect(sim.paymentId).toBe("pay_sim_1");
    expect(sim.status).toBe("pending");
    expect(sim.outcomes.map((o) => o.id)).toContain("wrong_pin");
  });

  it("needs no arguments at all — no phone, no amount", async () => {
    const m = mockFetch([{ status: 202, json: SIM_ACK }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0 });

    await paylod.simulate.collect();
    expect(m.calls[0]!.body).toEqual({ phone: "254708374149", amount: 1 });
  });

  it("rejects a nonsense amount locally", async () => {
    const m = mockFetch([{ status: 202, json: SIM_ACK }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0 });

    await expect(paylod.simulate.collect({ amount: 1.5 })).rejects.toThrow(
      PaylodInvalidRequestError,
    );
    expect(m.calls.length).toBe(0);
  });
});

describe("simulate.outcome — the same PaymentOutcome the rest of the SDK returns", () => {
  const drive = async (outcome: SimOutcomeId) => {
    const m = mockFetch([{ status: 200, json: SETTLED[outcome] }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0 });
    const result = await paylod.simulate.outcome("pay_sim_1", outcome);
    return { result, m };
  };

  it("approve → succeeded, paid, a receipt, and NOT retryable", async () => {
    const { result, m } = await drive("approve");
    expect(m.calls[0]!.url).toContain("/simulate/outcome");
    expect(m.calls[0]!.body).toEqual({ paymentId: "pay_sim_1", outcome: "approve" });

    expect(result.status).toBe("succeeded");
    expect(result.paid).toBe(true);
    expect(result.receipt).toBe("SFF6XYZ123");
    expect(result.retryable).toBe(false); // "retry" a success and you charge them twice
    expect(result.webhookQueued).toBe(true);
  });

  it("wrong_pin → failed, and genuinely safe to charge again", async () => {
    const { result } = await drive("wrong_pin");
    expect(result.status).toBe("failed");
    expect(result.code).toBe("2001");
    expect(result.retryable).toBe(true); // no money moved
    expect(result.message).toMatch(/PIN/i);
    expect(result.paid).toBe(false);
  });

  it("insufficient_funds → failed, human message, no raw code leaked", async () => {
    const { result } = await drive("insufficient_funds");
    expect(result.status).toBe("failed");
    expect(result.code).toBe("1");
    expect(result.message).toMatch(/balance is too low/i);
    expect(result.message).not.toMatch(/\b1\b.*result/i);
  });

  it("user_cancelled → its own `cancelled` status, not a generic failure", async () => {
    const { result } = await drive("user_cancelled");
    expect(result.status).toBe("cancelled");
    expect(result.code).toBe("1032");
    expect(result.paid).toBe(false);
  });

  it("timeout → a SETTLED failure (1037), which is not PaylodTimeoutError", async () => {
    const { result } = await drive("timeout");
    expect(result.status).toBe("failed");
    expect(result.code).toBe("1037");
    expect(result.message).toMatch(/prompt expired/i);
  });

  it("every outcome in SIM_OUTCOMES is drivable and never leaves the payment pending", async () => {
    for (const outcome of SIM_OUTCOMES) {
      const { result } = await drive(outcome);
      expect(result.status).not.toBe("pending");
      expect(result.paymentId).toBe("pay_sim_1");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("requires a paymentId", async () => {
    const paylod = new Paylod(TEST_KEY, { fetch: mockFetch([]).fetch });
    await expect(paylod.simulate.outcome("", "approve")).rejects.toThrow(PaylodInvalidRequestError);
  });
});

describe("simulate.pay — collect + outcome in one call", () => {
  it("creates the payment then settles it, in two requests", async () => {
    const m = mockFetch([
      { status: 202, json: SIM_ACK },
      { status: 200, json: SETTLED.user_cancelled },
    ]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0 });

    const result = await paylod.simulate.pay({ amount: 99, outcome: "user_cancelled" });

    expect(m.calls.map((c) => c.url.split("/functions/v1")[1])).toEqual([
      "/simulate/collect",
      "/simulate/outcome",
    ]);
    expect(m.calls[0]!.body).toMatchObject({ amount: 99 });
    expect(m.calls[1]!.body).toEqual({ paymentId: "pay_sim_1", outcome: "user_cancelled" });
    expect(result.status).toBe("cancelled");
  });
});

describe("simulate mode — the integrator's OWN collect() path, unchanged", () => {
  it("collect() creates a simulated payment instead of ringing a phone", async () => {
    const m = mockFetch([{ status: 202, json: SIM_ACK }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0, simulate: true });

    // This is the caller's production code, verbatim.
    const ack = await paylod.collect({
      amount: 250,
      phone: "0712345678",
      idempotencyKey: "order-1042",
    });

    expect(m.calls[0]!.url).toContain("/simulate/collect");
    expect(m.calls[0]!.url).not.toContain("/functions/v1/collect");
    // The ack is an ordinary CollectAck — the caller cannot tell.
    expect(ack.paymentId).toBe("pay_sim_1");
    expect(ack.status).toBe("pending");
    expect(ack.idempotencyKey).toBe("order-1042");
  });

  // THE point of the whole simulate surface: a developer's double-click test has to mean something.
  // The simulator used to ignore `Idempotency-Key`, and the SDK did not even send it here — so a
  // test that asserted "one payment" against the simulator was asserting a lie. Both ends are fixed:
  // the header goes out, and the backend replays the first payment.
  it("simulate mode SENDS the Idempotency-Key header (it used to be dropped)", async () => {
    const m = mockFetch([{ status: 202, json: SIM_ACK }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0, simulate: true });
    await paylod.collect({ amount: 250, phone: "0712345678", idempotencyKey: "order-1042" });
    expect(m.calls[0]!.headers["idempotency-key"]).toBe("order-1042");
  });

  it("a double-clicked collect() in simulate mode returns the SAME payment (backend replays)", async () => {
    // The backend now replays the first response for a repeated key — so both calls see one payment.
    const m = mockFetch([
      { status: 202, json: SIM_ACK },
      { status: 202, json: SIM_ACK },
    ]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0, simulate: true });

    const a = await paylod.collect({ amount: 250, phone: "0712345678", idempotencyKey: "order-1042" });
    const b = await paylod.collect({ amount: 250, phone: "0712345678", idempotencyKey: "order-1042" });

    expect(b.paymentId).toBe(a.paymentId);
    expect(m.calls[0]!.headers["idempotency-key"]).toBe("order-1042");
    expect(m.calls[1]!.headers["idempotency-key"]).toBe("order-1042");
  });

  // The idempotency layer fingerprints the request BODY. So any field the simulator never sees is
  // a field it cannot fingerprint — and a reused key with changed `metadata` would 409 in
  // production while silently REPLAYING here. That is precisely the false confidence the simulator
  // exists to remove: a developer's test asserting "a reused key with a changed body is rejected"
  // would go green against the simulator and be WRONG in production.
  //
  // These two fail against 0.3.0, which forwarded only { phone, amount, accountReference, key }.
  it("simulate mode forwards the FULL body — `description` and `metadata` included", async () => {
    const m = mockFetch([{ status: 202, json: SIM_ACK }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0, simulate: true });

    await paylod.collect({
      amount: 250,
      phone: "0712345678",
      accountReference: "INV-2041",
      description: "Order #2041",
      metadata: { attemptId: "a1" },
      idempotencyKey: "attempt-1",
    });

    const body = m.calls[0]!.body as Record<string, unknown>;
    expect(body.description).toBe("Order #2041");
    expect(body.metadata).toEqual({ attemptId: "a1" });
    expect(body.accountRef).toBe("INV-2041");
    expect(body.amount).toBe(250);
  });

  it("a reused key with only `metadata` changed reaches the backend as a DIFFERENT body → 409", async () => {
    const m = mockFetch([
      { status: 202, json: SIM_ACK },
      { status: 409, json: { error: "Idempotency-Key was reused with a different request body" } },
    ]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0, simulate: true });

    const base = { amount: 250, phone: "0712345678", idempotencyKey: "attempt-1" } as const;
    await paylod.collect({ ...base, metadata: { attemptId: "a1" } });

    const err = await paylod
      .collect({ ...base, metadata: { attemptId: "a2" } })
      .catch((e: unknown) => e as PaylodApiError);

    // The bodies the SDK actually put on the wire must DIFFER — otherwise the backend has nothing
    // to 409 on, and the simulator replays where production rejects.
    expect((m.calls[0]!.body as Record<string, unknown>).metadata).toEqual({ attemptId: "a1" });
    expect((m.calls[1]!.body as Record<string, unknown>).metadata).toEqual({ attemptId: "a2" });

    expect(err).toBeInstanceOf(PaylodApiError);
    expect((err as PaylodApiError).status).toBe(409);
    expect((err as PaylodApiError).isIdempotencyBodyConflict).toBe(true);
    expect((err as PaylodApiError).isIdempotencyIndeterminate).toBe(false);
  });

  it("simulate.collect() forwards an explicit idempotencyKey", async () => {
    const m = mockFetch([{ status: 202, json: SIM_ACK }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0 });
    await paylod.simulate.collect({ amount: 5, idempotencyKey: "order-7" });
    expect(m.calls[0]!.headers["idempotency-key"]).toBe("order-7");
  });

  it("without `simulate`, collect() still goes to the real /collect", async () => {
    const m = mockFetch([{ status: 202, json: { paymentId: "p", status: "pending", checkoutRequestId: "c" } }]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0 });
    await paylod.collect({ amount: 1, phone: "0712345678", idempotencyKey: "k" });
    expect(m.calls[0]!.url.endsWith("/functions/v1/collect")).toBe(true);
  });

  it("collectAndWait() in simulate mode polls the real /status and settles like any payment", async () => {
    const m = mockFetch([
      { status: 202, json: SIM_ACK },
      {
        status: 200,
        json: { id: "pay_sim_1", status: "success", mpesaReceipt: "SFF6XYZ123", resultCode: 0, resultDesc: "ok" },
      },
    ]);
    const paylod = new Paylod(TEST_KEY, { fetch: m.fetch, maxRetries: 0, simulate: true });

    const outcome = await paylod.collectAndWait({
      amount: 1,
      phone: "0712345678",
      idempotencyKey: "k",
    });

    expect(m.calls[1]!.url).toContain("/status/pay_sim_1");
    expect(outcome.paid).toBe(true);
    expect(outcome.receipt).toBe("SFF6XYZ123");
  });
});

describe("SIM_OUTCOMES", () => {
  it("is the full set of five, and is what `paylod.simulate.outcomes` exposes", () => {
    expect([...SIM_OUTCOMES]).toEqual([
      "approve",
      "wrong_pin",
      "insufficient_funds",
      "user_cancelled",
      "timeout",
    ]);
    const paylod = new Paylod(TEST_KEY, { fetch: vi.fn() as never });
    expect([...paylod.simulate.outcomes]).toEqual([...SIM_OUTCOMES]);
  });
});
