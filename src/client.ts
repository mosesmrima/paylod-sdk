import { randomUUID } from "node:crypto";
import {
  PaylodApiError,
  PaylodConfigError,
  PaylodConnectionError,
  PaylodInvalidRequestError,
  PaylodTimeoutError,
} from "./errors.js";
import { decodeDarajaResult } from "./daraja-catalog.js";
import type { DecodedError } from "./daraja-catalog.js";
import { toOutcome } from "./outcome.js";
import type { PaymentOutcome } from "./outcome.js";
import { normalizePhone } from "./phone.js";
import { assertSandboxKey, Simulator } from "./simulate.js";
import type {
  CollectAck,
  CollectParams,
  Payment,
  PaylodOptions,
  WaitOptions,
  WebhookEvent,
} from "./types.js";
import { SIGNATURE_HEADER, verifyWebhook } from "./webhook.js";

/**
 * The base URL. It is the same for every paylod customer, so it is baked in — you never pass
 * it, and there is nothing to configure.
 *
 * (Note for maintainers: the docs advertise `https://api.paylod.dev/v1`, which does NOT route —
 * it 307s to /signin. Do not "fix" this constant to that host until it actually routes.)
 */
export const DEFAULT_BASE_URL = "https://paylod.dev/functions/v1";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

/** Ramp: quick first look, then ease off. Capped at 5s. Values in ms. */
const POLL_SCHEDULE_MS = [1_000, 1_000, 1_500, 2_000, 2_500, 3_000, 4_000, 5_000] as const;

const MAX_AMOUNT = 150_000;

/**
 * Warn at most once per process. A double-charge is a money bug, so it earns a loud warning —
 * but one that fires on every call in a hot checkout path would just be noise people filter out.
 */
let warnedMissingIdempotencyKey = false;

function warnMissingIdempotencyKey(): void {
  if (warnedMissingIdempotencyKey) return;
  warnedMissingIdempotencyKey = true;
  console.warn(
    "[paylod] collect() was called without an `idempotencyKey`, so this charge is not protected " +
      "against being sent twice.\n" +
      "         A double-clicked Pay button, a refreshed tab, or a retried request will fire a " +
      "SECOND STK prompt and can charge your customer twice.\n" +
      "         Pass the id of the thing being paid for — it is the only value that knows a retry " +
      "of order 1042 is the same charge, not a new one:\n" +
      "             paylod.collectAndWait({ phone, amount, idempotencyKey: order.id })\n" +
      "         Same key + same body → the original payment is returned, and no second prompt is " +
      "ever sent. https://paylod.dev/docs/sdk#idempotency",
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** ±20% jitter so a fleet of servers doesn't poll in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function pollDelay(attempt: number): number {
  const base = POLL_SCHEDULE_MS[Math.min(attempt, POLL_SCHEDULE_MS.length - 1)] ?? 5_000;
  return jitter(base);
}

interface RequestOptions {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/**
 * The paylod API client.
 *
 * Construction takes an API key and nothing else. The base URL is the same for every customer,
 * so it is baked in; there is no config object to assemble, no endpoint to look up, and no
 * OAuth token to fetch and refresh.
 *
 * ```ts
 * const paylod = new Paylod(process.env.PAYLOD_API_KEY!);
 * // …or just `new Paylod()`, which reads PAYLOD_API_KEY from the environment itself.
 *
 * const outcome = await paylod.collectAndWait({ amount: 100, phone: "0712345678" });
 * if (outcome.paid) fulfil(outcome.receipt);
 * else              toast(outcome.message);   // already decoded, already human
 * ```
 *
 * The second argument exists only for genuine escape hatches — a custom `baseUrl` when you are
 * testing against a stub, a shorter `timeoutMs`, an injected `fetch`. You should almost never
 * need it.
 */
export class Paylod {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #webhookSecret: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #simulate: boolean;

  /**
   * The sandbox simulator: drive a payment to any of the five outcomes from a test file, with no
   * phone. See {@link Simulator}.
   *
   * ```ts
   * const outcome = await paylod.simulate.pay({ outcome: "insufficient_funds" });
   * ```
   *
   * Every method on it refuses a `mp_live_` key locally, before a byte leaves the process.
   */
  readonly simulate: Simulator;

  /**
   * @param apiKey Your `mp_live_…` / `mp_test_…` key. Omit it to read `PAYLOD_API_KEY` from the
   *   environment. Throws immediately if there is no key anywhere — a client that would 401 on
   *   its first call is not worth handing back.
   * @param options Escape hatches. Rarely needed.
   */
  constructor(apiKey?: string, options?: PaylodOptions);
  /** Everything-in-one-object form. Equivalent; use whichever reads better. */
  constructor(options: PaylodOptions);
  constructor(apiKeyOrOptions?: string | PaylodOptions, maybeOptions: PaylodOptions = {}) {
    const options: PaylodOptions =
      typeof apiKeyOrOptions === "object" && apiKeyOrOptions !== null
        ? apiKeyOrOptions
        : maybeOptions;
    const apiKey = typeof apiKeyOrOptions === "string" ? apiKeyOrOptions : undefined;

    const env: Record<string, string | undefined> =
      typeof process !== "undefined" && process.env ? process.env : {};

    const key = apiKey ?? options.apiKey ?? env.PAYLOD_API_KEY;
    if (!key || typeof key !== "string" || key.trim() === "") {
      throw new PaylodConfigError(
        "No paylod API key. Pass one — `new Paylod(process.env.PAYLOD_API_KEY)` — or set the " +
          "PAYLOD_API_KEY environment variable. This key can move money: keep it on a server " +
          "and never ship it to a browser.",
      );
    }
    this.#apiKey = key.trim();

    // Baked in. The base URL is identical for every customer, so passing one is pure ceremony.
    // PAYLOD_BASE_URL / options.baseUrl remain as escape hatches for self-hosting and tests.
    this.#baseUrl = (options.baseUrl ?? env.PAYLOD_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.#webhookSecret = options.webhookSecret ?? env.PAYLOD_WEBHOOK_SECRET;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new PaylodConfigError(
        "No global fetch available. Use Node 18+, or pass `new Paylod(key, { fetch })`.",
      );
    }
    this.#fetch = f;

    // Simulator mode is a TEST posture, so it is fenced off from production at CONSTRUCTION time.
    // A client that could simulate with a live key must never come into existence — failing here
    // means the mistake surfaces in your test setup, not as a 403 halfway through a suite (or,
    // far worse, as a real STK prompt on a customer's phone).
    this.#simulate = options.simulate === true;
    if (this.#simulate) {
      assertSandboxKey(this.#apiKey, "new Paylod({ simulate: true })");
    }

    this.simulate = new Simulator(this.#apiKey, (opts) =>
      this.#request({
        method: opts.method,
        path: opts.path,
        body: opts.body,
        // The simulator honours `Idempotency-Key` with the SAME semantics as /collect, so the
        // header has to actually reach it — otherwise `{ simulate: true }` would quietly create a
        // second payment where production replays the first, and a developer's "a double-click
        // cannot double-charge" test would pass while proving the opposite.
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────────

  async #request<T>(opts: RequestOptions): Promise<T> {
    const url = `${this.#baseUrl}${opts.path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await sleep(jitter(250 * 2 ** (attempt - 1)), opts.signal);

      const timer = new AbortController();
      const to = setTimeout(() => timer.abort(), this.#timeoutMs);
      const onOuterAbort = () => timer.abort();
      opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

      let res: Response;
      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${this.#apiKey}`,
          accept: "application/json",
        };
        if (opts.body !== undefined) headers["content-type"] = "application/json";
        // Sent on every mutating call — this is what makes a retry safe.
        if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

        res = await this.#fetch(url, {
          method: opts.method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: timer.signal,
        });
      } catch (e) {
        lastError = new PaylodConnectionError(
          `Could not reach paylod at ${url}: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
        if (opts.signal?.aborted) throw lastError;
        continue; // network blip → retry
      } finally {
        clearTimeout(to);
        opts.signal?.removeEventListener("abort", onOuterAbort);
      }

      const text = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      if (res.ok) return parsed as T;

      const message =
        (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : null) ?? `paylod responded ${res.status}`;

      const apiError = new PaylodApiError(message, res.status, parsed, opts.idempotencyKey);

      // 429 / 5xx are transient. Everything else (400/401/404/409/422) is a real answer —
      // retrying it just burns time and, for 409, hides a genuine bug.
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === this.#maxRetries) throw apiError;

      const retryAfter = Number(res.headers.get("retry-after"));
      lastError = apiError;
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await sleep(Math.min(retryAfter * 1000, 10_000), opts.signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new PaylodConnectionError(`Request to ${url} failed`);
  }

  // ── Validation ────────────────────────────────────────────────────────────────

  /**
   * Validate + normalise locally so a bad amount or phone fails instantly, in your own
   * stack trace, instead of coming back as an opaque 422 a network round-trip later.
   * Bounds mirror `_shared/schemas/collect.ts`.
   */
  #buildCollectBody(params: CollectParams): Record<string, unknown> {
    const { amount } = params;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new PaylodInvalidRequestError("amount must be a number (whole KES).");
    }
    if (!Number.isInteger(amount)) {
      throw new PaylodInvalidRequestError(
        `amount must be a whole number of KES — M-Pesa rejects decimals (got ${amount}).`,
      );
    }
    if (amount <= 0 || amount > MAX_AMOUNT) {
      throw new PaylodInvalidRequestError(
        `amount must be between 1 and ${MAX_AMOUNT} KES (got ${amount}).`,
      );
    }
    if (params.accountReference !== undefined && params.accountReference.trim().length > 12) {
      throw new PaylodInvalidRequestError("accountReference must be 12 characters or fewer.");
    }
    if (params.description !== undefined && params.description.trim().length > 64) {
      throw new PaylodInvalidRequestError("description must be 64 characters or fewer.");
    }

    const body: Record<string, unknown> = {
      amount,
      phone: normalizePhone(params.phone),
    };
    if (params.accountReference !== undefined) body.accountReference = params.accountReference;
    if (params.description !== undefined) body.description = params.description;
    if (params.metadata !== undefined) body.metadata = params.metadata;
    return body;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Send an STK Push. Resolves as soon as the prompt is on the customer's phone — the payment
   * is `pending`. Settle it with {@link status}, {@link wait}, or a webhook.
   *
   * **Pass `idempotencyKey` and a double-click can never charge twice.** Use the id of the thing
   * being paid for — an order id, an invoice number:
   *
   * ```ts
   * const ack = await paylod.collect({ amount: 100, phone, idempotencyKey: order.id });
   * ```
   *
   * Send the same key twice and the second call returns the *original* payment — same
   * `paymentId`, same `checkoutRequestId` — instead of firing a second STK prompt. Only you know
   * that a retry of order 1042 is the same charge and not a new one, which is why this cannot be
   * generated for you.
   *
   * Omit it and the SDK generates a fresh key per call. That still makes an internal *network*
   * retry of this one call safe, but it does nothing about your application sending the same
   * logical charge twice — a double-clicked button, a refreshed tab, a retried job — which is by
   * far the more common way a customer gets charged twice. The SDK warns once if you omit it.
   */
  async collect(params: CollectParams, options: { signal?: AbortSignal } = {}): Promise<CollectAck> {
    const body = this.#buildCollectBody(params);
    if (params.idempotencyKey === undefined) warnMissingIdempotencyKey();
    const idempotencyKey = params.idempotencyKey ?? randomUUID();

    // Simulator mode (`new Paylod(testKey, { simulate: true })`): same call, same ack, no handset.
    // Your charge path runs UNCHANGED — which is the only way to actually test it. The key was
    // proven to be a sandbox key in the constructor, so this branch cannot reach production.
    if (this.#simulate) {
      const created = await this.simulate.collect(
        {
          phone: params.phone,
          amount: params.amount,
          ...(params.accountReference !== undefined
            ? { accountReference: params.accountReference }
            : {}),
          // Forward the key: the simulator dedupes on it exactly as production does, so the same
          // key really does return the same paymentId here.
          idempotencyKey,
        },
        options,
      );
      return {
        paymentId: created.paymentId,
        status: "pending",
        checkoutRequestId: created.checkoutRequestId,
        idempotencyKey,
      };
    }

    const ack = await this.#request<Omit<CollectAck, "idempotencyKey">>({
      method: "POST",
      path: "/collect",
      body,
      idempotencyKey,
      signal: options.signal,
    });
    return { ...ack, idempotencyKey };
  }

  /** Read a payment. `GET /status/:id`. */
  async status(paymentId: string, options: { signal?: AbortSignal } = {}): Promise<Payment> {
    if (!paymentId) throw new PaylodInvalidRequestError("paymentId is required.");
    return this.#request<Payment>({
      method: "GET",
      path: `/status/${encodeURIComponent(paymentId)}`,
      signal: options.signal,
    });
  }

  /**
   * Read a payment and return it already decoded and renderable. This is `status()` for people
   * who want to show a human what happened, which is almost everybody.
   *
   * ```ts
   * const outcome = await paylod.check(paymentId);
   * res.json({ message: outcome.message, retryable: outcome.retryable });
   * ```
   */
  async check(paymentId: string, options: { signal?: AbortSignal } = {}): Promise<PaymentOutcome> {
    return toOutcome(await this.status(paymentId, options));
  }

  /**
   * Poll an existing payment until it settles, with a backoff ramp (1s → 5s, jittered).
   *
   * Note what counts as "settled": the CLASSIFIER decides, not the raw `status` field. A row
   * marked `failed` that carries result code 4999 means "the prompt is live and the customer
   * hasn't entered their PIN yet" — so we keep polling instead of returning a failure for a
   * payment that is about to succeed.
   *
   * @throws {PaylodTimeoutError} if still pending at the deadline. That is deliberately NOT a
   *   `status: "failed"` outcome: we do not know what happened, and telling a merchant "failed"
   *   when the customer is mid-PIN loses real money. Leave the order open; the webhook settles it.
   */
  async wait(paymentId: string, options: WaitOptions = {}): Promise<PaymentOutcome> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    let last: Payment | undefined;
    for (let attempt = 0; ; attempt++) {
      const payment = await this.status(paymentId, { signal: options.signal });
      last = payment;

      const outcome = toOutcome(payment);
      if (outcome.status !== "pending") return outcome;
      options.onPoll?.(payment);

      const delay = pollDelay(attempt);
      if (Date.now() + delay >= deadline) break;
      await sleep(delay, options.signal);
    }

    throw new PaylodTimeoutError(paymentId, last, Date.now() - startedAt);
  }

  /**
   * `collect()` + `wait()`. The one-liner most integrations actually want, and the whole SDK in
   * a single call: ring the phone, wait for the PIN, hand back something you can render.
   *
   * ```ts
   * const outcome = await paylod.collectAndWait({
   *   amount: 100,
   *   phone: "0712345678",
   *   idempotencyKey: order.id,   // ← pass your order id; a double-click cannot charge twice
   * });
   * if (outcome.paid) fulfil(outcome.receipt);
   * else              toast(outcome.message);   // no result-code table in sight
   * ```
   *
   * See {@link collect} for what `idempotencyKey` does and what happens if you leave it out.
   */
  async collectAndWait(
    params: CollectParams,
    options: WaitOptions = {},
  ): Promise<PaymentOutcome> {
    const signal = options.signal;
    const ack = await this.collect(params, signal ? { signal } : {});
    return this.wait(ack.paymentId, options);
  }

  /**
   * Decode an M-Pesa result code offline. No network, no API key needed at call time.
   * The strings are identical to the ones the API puts in `event.data.decoded`.
   *
   * You should rarely need this: `check()`, `wait()` and `collectAndWait()` already hand back a
   * decoded, renderable {@link PaymentOutcome}. This is here for logs, dashboards and support
   * tooling — not for deciding what to show a customer.
   */
  decodeError(resultCode: number | string | null | undefined, rawDesc?: string): DecodedError {
    return decodeDarajaResult(resultCode, rawDesc ?? null);
  }

  /**
   * Verify a raw webhook body + signature header and return the typed event.
   * Throws {@link PaylodSignatureVerificationError} if it does not check out.
   */
  verifyWebhook(params: {
    payload: string | Buffer | Uint8Array;
    signature: string | null | undefined;
    secret?: string;
    toleranceSec?: number;
  }): WebhookEvent {
    const secret = params.secret ?? this.#webhookSecret ?? "";
    return verifyWebhook({
      payload: params.payload,
      signature: params.signature,
      secret,
      ...(params.toleranceSec !== undefined ? { toleranceSec: params.toleranceSec } : {}),
    });
  }

  /**
   * A verified webhook handler for the Web `Request`/`Response` world — Next.js route
   * handlers, Hono, Remix, Cloudflare Workers, Bun, Deno.
   *
   * ```ts
   * // app/api/webhooks/paylod/route.ts
   * export const POST = paylod.webhookHandler(async (event) => {
   *   if (event.type === "payment.success") await fulfil(event.data.paymentId);
   * });
   * ```
   * Returns `400` on a bad signature and `200` once your handler resolves. If your handler
   * throws, it returns `500` so paylod retries the delivery.
   */
  webhookHandler(
    handler: (event: WebhookEvent) => void | Promise<void>,
    options: { secret?: string; toleranceSec?: number } = {},
  ): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const raw = await request.text();
      let event: WebhookEvent;
      try {
        event = this.verifyWebhook({
          payload: raw,
          signature: request.headers.get(SIGNATURE_HEADER),
          ...(options.secret !== undefined ? { secret: options.secret } : {}),
          ...(options.toleranceSec !== undefined ? { toleranceSec: options.toleranceSec } : {}),
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e instanceof Error ? e.message : "invalid signature" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      try {
        await handler(event);
      } catch (e) {
        // Non-2xx → paylod retries. Better a duplicate delivery than a lost payment.
        return new Response(
          JSON.stringify({ error: e instanceof Error ? e.message : "handler failed" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  /**
   * A verified webhook middleware for Express/Connect.
   *
   * ```ts
   * app.post("/webhooks/paylod", paylod.webhook(async (event) => { ... }));
   * ```
   *
   * It reads the raw body itself, so mount it BEFORE any global `express.json()`, or give
   * the route `express.raw({ type: "application/json" })`. If a JSON parser already turned
   * the body into an object the raw bytes are gone and verification is impossible — you get
   * a loud 400 explaining exactly that, rather than a silent security hole.
   */
  webhook(
    handler: (event: WebhookEvent) => void | Promise<void>,
    options: { secret?: string; toleranceSec?: number } = {},
  ): (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<void> {
    return async (req: ExpressLikeRequest, res: ExpressLikeResponse): Promise<void> => {
      let raw: Buffer;
      try {
        raw = await readRawBody(req);
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : "cannot read body" });
        return;
      }

      const header = req.headers?.[SIGNATURE_HEADER];
      let event: WebhookEvent;
      try {
        event = this.verifyWebhook({
          payload: raw,
          signature: Array.isArray(header) ? header[0] : header,
          ...(options.secret !== undefined ? { secret: options.secret } : {}),
          ...(options.toleranceSec !== undefined ? { toleranceSec: options.toleranceSec } : {}),
        });
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : "invalid signature" });
        return;
      }

      try {
        await handler(event);
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : "handler failed" });
        return;
      }
      res.status(200).json({ received: true });
    };
  }
}

// ── Minimal structural types for Express/Connect (no `express` dependency) ────────

export interface ExpressLikeRequest {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
  readableEnded?: boolean;
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>;
}

export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  json(body: unknown): unknown;
}

async function readRawBody(req: ExpressLikeRequest): Promise<Buffer> {
  // express.raw() / body-parser raw → already a Buffer. Best case.
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  // body-parser `verify` hook convention (and Vercel/Firebase runtimes).
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody, "utf8");

  // Nothing parsed it yet → drain the stream ourselves.
  if (req.body === undefined && typeof req[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw new Error(
    "Cannot verify a paylod webhook: the request body was already parsed into an object, so " +
      "the raw bytes are gone. Mount the webhook route BEFORE express.json(), or give it " +
      'express.raw({ type: "application/json" }).',
  );
}
