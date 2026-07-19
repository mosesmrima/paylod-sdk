import {
  PaylodApiError,
  PaylodConfigError,
  PaylodConnectionError,
  PaylodError,
  PaylodInvalidRequestError,
  PaylodResponseTooLargeError,
  PaylodTerminalTransportError,
  PaylodTimeoutError,
} from "./errors.js";
import { decodeDarajaResult } from "./daraja-catalog.js";
import type { DecodedError } from "./daraja-catalog.js";
import { toOutcome } from "./outcome.js";
import type { PaymentOutcome } from "./outcome.js";
import { normalizePhone } from "./phone.js";
import { assertSandboxKey, Simulator } from "./simulate.js";
import {
  assertAccountReference,
  assertChargeAmount,
  assertDescription,
  parseCollectAck,
  parsePaymentBody,
  resolveIdempotencyKey,
  assertWholeNonNegative,
  assertWholePositiveMs,
  MAX_AMOUNT,
} from "./validate.js";
import { withIdempotencyKey } from "./reconcile.js";
import { assertSecureBaseUrl, monotonicNowMs, Transport } from "./transport.js";
import type {
  CollectAck,
  CollectAckWire,
  CollectParams,
  Payment,
  PaylodOptions,
  WaitOptions,
  WebhookEvent,
} from "./types.js";
import {
  MAX_WEBHOOK_BODY_BYTES,
  SIGNATURE_HEADER,
  tooLargeBody,
  verifyWebhook,
} from "./webhook.js";

// Re-exported so the public entry point keeps exporting it from here. The DEFINITION moved to
// `webhook.ts` — see the constant's own comment: the cap belongs to verification, not to the two
// adapters that happen to buffer bytes.
export { MAX_WEBHOOK_BODY_BYTES };

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

/**
 * Hard ceiling for any sleep that has no absolute deadline bounding it.
 *
 * A bare `collect()` carries no polling budget, so before this the only limit on a `Retry-After`
 * pause was the server's own honesty — `Retry-After: 86400` would block the caller for a day.
 * Shared with the other paylod SDKs so every client agrees on the worst case.
 */
const MAX_UNBOUNDED_SLEEP_MS = 60_000;

/** Ramp: quick first look, then ease off. Capped at 5s. Values in ms. */
const POLL_SCHEDULE_MS = [1_000, 1_000, 1_500, 2_000, 2_500, 3_000, 4_000, 5_000] as const;

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

interface RequestOptions<T> {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  /**
   * Absolute deadline on the MONOTONIC clock ({@link monotonicNowMs}) for the WHOLE operation. Each in-flight request is capped
   * to the remaining time, and every backoff / `Retry-After` sleep is clamped to it — so a
   * `wait()` cannot overrun its `timeoutMs` by a full request timeout per poll.
   */
  readonly deadlineMs?: number;
  /**
   * Run against a 2xx body, and RETURN THE OBJECT THAT WILL BE HANDED BACK. Throw here to reject
   * a malformed success (e.g. a 200 with no payment id) as an error instead of silently handing
   * back an empty shape.
   *
   * ── Why this returns instead of asserting ─────────────────────────────────────────────────
   * It used to be `(parsed, status) => void`, and `#request` then did `return parsed as T`. So
   * the object the SDK validated and the object it RETURNED were different sizes: the validator
   * checked the five fields the contract names, and the caller received those five plus every
   * other field the server chose to send. Unknown fields — an upstream debug envelope, a proxy
   * that mirrors request headers, an `authorization` echo — rode out inside a public `CollectAck`
   * or `Payment`, typed as though they did not exist, and were serialized by the first thing that
   * logged the result.
   *
   * A validator that cannot decide what is returned is not a boundary, it is a comment. Making
   * this signature return `T` moves the reconstruction INTO the one place every 2xx passes
   * through, so a new call site cannot forget it: there is no path that returns a raw body.
   */
  readonly project?: (parsed: unknown, status: number) => T;
}

/**
 * A `409` retried only when it is explicitly the "same key still running" case. Every other 409
 * (body conflict, indeterminate) is a real answer and must NOT be retried.
 */
const IN_PROGRESS_409_RE = /already in progress/i;

/**
 * A `409` **indeterminate** — a previous request under this key died mid-dispatch, so it may or
 * may not have moved money. This is the STOP signal, and it takes precedence over every other
 * reading of a 409.
 *
 * The two patterns are not disjoint, and nothing guarantees they ever will be: the server writes
 * prose, and a message can contain both phrases (a conflict raised while a previous attempt was
 * both queued and interrupted, or simply a reworded message that mentions both states). Testing
 * only for "in progress" therefore RETRIED an indeterminate 409 — the SDK dispatched the charge a
 * second time against a key whose first attempt may already have taken the customer's money. The
 * probe counted two dispatches where the documented behaviour is zero retries.
 *
 * When the two disagree, the conservative reading wins. `in progress` costs a caller one extra
 * poll if we get it wrong; `indeterminate` costs a customer a second charge.
 */
const INDETERMINATE_409_RE = /interrupted while the provider call was/i;

/**
 * The WALL clock. Used only where a wall-clock reading is the correct one: comparing against an
 * HTTP-date `Retry-After`, which is an absolute civil time the server named. Operation deadlines
 * use {@link monotonicNowMs} instead — see `#remaining`.
 */
function nowMs(): number {
  return Date.now();
}

/**
 * Parse `Retry-After` in BOTH forms RFC 9110 defines, and return milliseconds.
 *
 * - **delta-seconds** — a non-negative integer. `"5.5"`, `"-1"`, `"soon"` and `""` are not valid
 *   delta-seconds and are treated as absent rather than coerced: `Number("5.5")` would silently
 *   invent a fractional pause, and `Number("")` is `0`, which reads as "retry immediately" when
 *   the server never said that.
 * - **HTTP-date** — `"Wed, 21 Oct 2015 07:28:00 GMT"`. Servers behind CDNs commonly send this
 *   form, and it used to fall through `Number()` as `NaN` and be discarded, so their backpressure
 *   was ignored entirely. A date already in the past yields `0` (retry now), never a negative.
 *
 * The header NAME is matched case-insensitively for free: `Headers.get` is defined to be
 * case-insensitive, so `Retry-After`, `retry-after` and `RETRY-AFTER` all resolve here.
 *
 * No independent truncation is applied. The returned value is what the server asked for; the
 * bounding is the caller's job and belongs in ONE place — {@link Paylod.boundedSleep}, which
 * clamps to the operation deadline when there is one and to {@link MAX_UNBOUNDED_SLEEP_MS} when
 * there is not. A second, private clamp here would silently shadow that ceiling and leave it
 * untested (and therefore, in practice, unmaintained).
 */
export function parseRetryAfterMs(raw: string | null | undefined, now: number = nowMs()): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }

  // Only a string that could actually BE an HTTP-date is handed to `Date.parse`. That parser is
  // far laxer than the grammar: `Date.parse("5.5")` and `Date.parse("-3")` both succeed, yielding
  // dates in the distant past — so a fractional or negative delta-seconds value would come back as
  // "retry immediately" instead of being recognised as malformed. Every HTTP-date form in RFC 9110
  // carries a month or day name (and `GMT`), so requiring a letter is enough to tell them apart.
  if (!/[A-Za-z]/.test(value)) return undefined;

  const when = Date.parse(value);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - now);
}

/**
 * The bounded JSON reader. Lives in `json.ts` because the webhook path needs the IDENTICAL
 * parser — a depth budget and a numeric-lexeme rule that hold on API responses but not on signed
 * events are two different parsers with one name, and the gap between them is where a laundered
 * `resultCode` gets in. Re-exported here so the published entry points are unchanged.
 *
 * See `json.ts` for why `JSON.parse` alone is not safe to point at a money verdict.
 */
import { MAX_JSON_DEPTH, parseBounded } from "./json.js";

export { MAX_JSON_DEPTH, parseBounded };


/**
 * Guarantee that whatever escapes a money-moving call CARRIES THE EFFECTIVE IDEMPOTENCY KEY.
 *
 * This is the single most important field on a failed charge: it is what lets a caller retry the
 * SAME attempt instead of minting a fresh key and double-charging. So "best effort" is not good
 * enough, and best effort is exactly what the previous version was — it MUTATED the thrown value
 * in place and gave up silently in two cases that both drop the key on the floor:
 *
 *   • A PRIMITIVE. `throw "boom"` / `throw undefined` is legal JavaScript, and a caller-supplied
 *     `fetch`, an interceptor or an instrumentation wrapper can throw one. `typeof err === "object"`
 *     was false, so nothing was attached and nothing was reported — the key vanished.
 *   • A FROZEN or read-only error. The assignment threw, the `catch {}` swallowed it, and the
 *     caller received an error that silently lacked the one field they needed.
 *
 * Mutating a value we do not own is also wrong on its own terms: the error may be shared, may be
 * a frozen singleton, and may already be observed elsewhere. So instead of mutating, we NORMALISE
 * — every failure leaves this SDK as a `PaylodError` subclass that is guaranteed to carry the key.
 *
 * An error that already carries the key (the common case: `PaylodApiError` built with it) is
 * returned untouched, so nothing is re-wrapped needlessly and `instanceof` checks keep working.
 */
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
  /**
   * The credentialed transport. NOT replaceable: the API key lives inside it, and this class
   * hands it a method, a path and a body — never headers, never a URL, never the key.
   */
  readonly #transport: Transport;
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
    // PAYLOD_BASE_URL / options.baseUrl still let you point at a stub or a loopback mock, but
    // they are NOT a self-hosting hook: whatever they resolve to must still pass the origin
    // allowlist below, because an API key is a bearer credential and may only ever be addressed
    // to an origin paylod controls.
    this.#baseUrl = (options.baseUrl ?? env.PAYLOD_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    // Reject a plaintext / non-canonical origin BEFORE any key can leave the process. Loopback
    // HTTP is allowed only behind an explicit test-only flag, and never with a live key.
    assertSecureBaseUrl(this.#baseUrl, this.#apiKey, options.allowInsecureBaseUrl === true);
    this.#webhookSecret = options.webhookSecret ?? env.PAYLOD_WEBHOOK_SECRET;
    // A broken timeout is worse than a long one. `setTimeout` clamps BOTH NaN and Infinity to fire
    // immediately, so `timeoutMs: Number(process.env.TIMEOUT)` with an unset env var would abort
    // every request the instant it started — and a charge that is genuinely in flight would come
    // back looking like a transport failure. Validate the shape here, once, at construction.
    this.#timeoutMs =
      options.timeoutMs === undefined
        ? DEFAULT_TIMEOUT_MS
        : assertWholePositiveMs(options.timeoutMs, "timeoutMs");
    this.#maxRetries =
      options.maxRetries === undefined
        ? DEFAULT_MAX_RETRIES
        : assertWholeNonNegative(options.maxRetries, "maxRetries");

    // ── The fetch seam: test-only, and never with a live key ──────────────────────────────
    //
    // An injected `fetch` receives the Authorization header on every request. It can ignore
    // `redirect: "manual"`, follow a cross-origin 302 itself, and return an ordinary 2xx — at
    // which point the bearer key has already been replayed to another host and no amount of
    // inspecting the final response can undo it. So this seam is now gated exactly the way
    // `allowInsecureBaseUrl` is: an explicit opt-in, refused outright for `mp_live_` keys.
    //
    // The gate is on the OPTION, not on its value: passing `fetch: undefined` explicitly is
    // indistinguishable from omitting it, and both mean "use the SDK's own transport".
    if (options.fetch !== undefined) {
      if (options.allowCustomFetch !== true) {
        throw new PaylodConfigError(
          "Passing `fetch` also requires `allowCustomFetch: true`. A custom fetch implementation " +
            "receives your API key — a bearer credential — on every request, and can follow a " +
            "cross-origin redirect that replays it to another host before this SDK ever sees the " +
            "response. It exists for TESTS ONLY (a mock server, a recorded fixture), so it must " +
            "be opted into deliberately: `new Paylod(key, { fetch, allowCustomFetch: true })`. " +
            "It is refused entirely for mp_live_ keys. If you are trying to add a proxy, a " +
            "timeout or instrumentation, use `timeoutMs`/`maxRetries` or an agent configured on " +
            "the runtime instead — do not route a live credential through your own code.",
        );
      }
      if (this.#apiKey.startsWith("mp_live_")) {
        throw new PaylodConfigError(
          "`fetch` may never be used with an mp_live_ key, with or without `allowCustomFetch`. " +
            "Your production API key can move money, and a caller-supplied fetch receives it on " +
            "every request. Use an mp_test_ key for tests that need to stub the transport.",
        );
      }
      if (typeof options.fetch !== "function") {
        throw new PaylodConfigError("`fetch` must be a function.");
      }
    }

    // The transport OWNS the credential from here on. Origin pinning and redirect refusal live
    // inside it and run on every dispatch, including through the test seam.
    this.#transport = new Transport({
      apiKey: this.#apiKey,
      baseUrl: this.#baseUrl,
      redact: (s) => this.#redact(s),
      testFetch: options.fetch,
    });

    // Simulator mode is a TEST posture, so it is fenced off from production at CONSTRUCTION time.
    // A client that could simulate with a live key must never come into existence — failing here
    // means the mistake surfaces in your test setup, not as a 403 halfway through a suite (or,
    // far worse, as a real STK prompt on a customer's phone).
    this.#simulate = options.simulate === true;
    if (this.#simulate) {
      assertSandboxKey(this.#apiKey, "new Paylod({ simulate: true })");
    }

    this.simulate = new Simulator(
      this.#apiKey,
      (opts) =>
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
        // The simulator's validators run INSIDE the request, so they see the real HTTP status and
        // run on exactly the same path production's do.
        ...(opts.project ? { project: opts.project } : {}),
      }),
      // THE PRODUCTION GUARDS, not a weaker copy. The simulator's error envelopes redacted
      // nothing and its projectors scanned for nothing, so the surface every integrator's test
      // suite runs against was the one surface a leaked credential survived.
      {
        redactText: (s) => this.#redact(s),
        redactBody: (b) => this.#redactDeep(b),
        secrets: () => this.#secrets(),
      },
    );
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────────

  /** Scrub the API key and webhook secret out of anything that could be logged or thrown. */
  #redact(s: string): string {
    let out = s;
    if (this.#apiKey) out = out.split(this.#apiKey).join("[redacted]");
    if (this.#webhookSecret) out = out.split(this.#webhookSecret).join("[redacted]");
    return out;
  }

  /**
   * The same scrub, applied through a parsed response body.
   *
   * `PaylodApiError.body` is the raw server response, and it is the field people log wholesale in
   * an error handler. Redacting only `message` therefore left an obvious hole: an API that echoes
   * the request back on a 4xx (a validation error quoting the offending headers, a debug envelope,
   * a proxy's error page) would carry the bearer key straight into the error object, and from
   * there into every log sink and error tracker downstream. Strings are scrubbed wherever they sit
   * in the structure — keys included, since a secret can appear as an object key too.
   */
  #redactDeep(value: unknown, depth = 0): unknown {
    // DEPTH LIMIT: too deep to walk means REDACT WHOLESALE, never pass through.
    //
    // This used to `return value` unchanged past depth 8, which inverted the guarantee at exactly
    // the point it mattered: a body nested deeply enough — trivially arranged by anything
    // upstream that echoes a request, and trivially reached by a proxy's error envelope wrapping
    // the original payload a few layers down — carried the bearer key through the redactor
    // untouched and into `PaylodApiError.body`, which is the field people log wholesale. The
    // guard against blowing the stack became a hole that leaks the credential.
    //
    // The safe answer at the limit is to drop the subtree, not to emit it. Anything past the
    // limit is diagnostic detail of vanishing value; the key is not.
    if (depth > 8) return "[redacted: structure too deeply nested to scan]";
    if (typeof value === "string") return this.#redact(value);
    if (Array.isArray(value)) return value.map((v) => this.#redactDeep(v, depth + 1));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[this.#redact(k)] = this.#redactDeep(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  /**
   * Remaining time to the deadline, or `undefined` when there is no deadline.
   *
   * Measured on the MONOTONIC clock. Deadlines used to be wall-clock (`Date.now()`), which an NTP
   * correction, a DST jump, a VM resuming from suspend or an operator setting the clock can move
   * arbitrarily: a backwards step makes a deadline recede so `wait()` polls a payment far past
   * the timeout the caller asked for, and a forwards step expires a live charge early and reports
   * it as timed out. Neither is acceptable around money.
   */
  #remaining(deadlineMs: number | undefined): number | undefined {
    return deadlineMs === undefined ? undefined : deadlineMs - monotonicNowMs();
  }

  /**
   * A sleep clamped to the operation deadline, so a backoff can never push past `wait()`'s cap.
   *
   * When there is NO deadline to clamp against — a bare `collect()`, which has no polling budget —
   * the sleep is ceilinged at {@link MAX_UNBOUNDED_SLEEP_MS} instead. Otherwise a hostile or
   * simply broken `Retry-After: 86400` would park the caller for a day inside what they believe
   * is a single request. A deadline, when present, still wins: it is the tighter, caller-chosen
   * bound and the ceiling must never extend it.
   */
  async #boundedSleep(ms: number, deadlineMs: number | undefined, signal?: AbortSignal): Promise<void> {
    let capped = ms;
    const remaining = this.#remaining(deadlineMs);
    if (remaining !== undefined) capped = Math.min(capped, Math.max(0, remaining));
    else capped = Math.min(capped, MAX_UNBOUNDED_SLEEP_MS);
    if (capped > 0) await sleep(capped, signal);
  }

  async #request<T>(opts: RequestOptions<T>): Promise<T> {
    const url = `${this.#baseUrl}${opts.path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        await this.#boundedSleep(jitter(250 * 2 ** (attempt - 1)), opts.deadlineMs, opts.signal);
      }

      // Cap this request to whatever time the overall operation has left. A 30s per-request
      // timeout must never let a `wait({ timeoutMs: 5000 })` run for 30s.
      let perRequestTimeout = this.#timeoutMs;
      const remaining = this.#remaining(opts.deadlineMs);
      if (remaining !== undefined) {
        if (remaining <= 0) break; // out of time — surface the last error / a timeout below
        perRequestTimeout = Math.min(perRequestTimeout, remaining);
      }

      // THE DISPATCH. Method, path and body — no headers, no URL, no credential. The transport
      // adds the Authorization header from its own private field, pins the origin, refuses
      // redirects, and reads the body inside the timeout window. None of that is skippable here.
      let res: Awaited<ReturnType<Transport["send"]>>;
      try {
        res = await this.#transport.send({
          method: opts.method,
          path: opts.path,
          ...(opts.body !== undefined ? { body: opts.body } : {}),
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
          timeoutMs: perRequestTimeout,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (e) {
        // A redirect / origin refusal is a security decision, not a network blip: the bearer
        // token may ALREADY have been replayed to another host, so re-dispatching would send it
        // there again. An over-sized / too-deep response is terminal for a different reason —
        // the request reached paylod, so the state is INDETERMINATE and a retry would re-charge.
        //
        // This used to be a REGEX OVER THE MESSAGE. That made a credential-critical control
        // depend on prose: reword a message, or have the redactor rewrite part of one, and the
        // protection silently switched off with no test able to see it. The sibling JVM SDK's
        // version of this defect was worse still — it raised the detection as a plain connection
        // error, its retry loop caught it like any blip, and it replayed the leaking credential
        // twice more. `terminal` is a structural fact about the error, not a description of it.
        if (e instanceof PaylodTerminalTransportError) throw e;
        lastError = new PaylodConnectionError(
          this.#redact(
            `Could not reach paylod at ${url}: ${e instanceof Error ? e.message : String(e)}`,
          ),
          // NOTE: the original exception is deliberately NOT attached as `cause`.
          //
          // The message above is redacted; the cause was not, and `cause` is walked by every
          // error reporter, logger and `util.inspect` in existence. A lower-level fetch/undici
          // exception routinely carries the request it failed on — headers included — so
          // attaching it re-exposed the very bearer key the redaction just removed, one property
          // deeper. A sanitised error that drags its unsanitised source along is not sanitised.
          // The redacted message retains the diagnostic content that is safe to keep.
        );
        if (opts.signal?.aborted) throw lastError;
        continue; // network blip → retry
      }

      const text = res.text;
      let parsed: unknown;
      try {
        parsed = text ? parseBounded(text) : null;
      } catch (e) {
        // A DEPTH violation is not a parse failure and must not degrade to `parsed = text`: on a
        // 2xx that would hand the validators a string, which they reject as "not an object" — the
        // right outcome by luck rather than by rule, and the wrong one on any path that reads the
        // body more leniently. It is terminal and indeterminate, and it is re-thrown so the
        // caller's key/payment-id attachment can ride it out.
        if (e instanceof PaylodResponseTooLargeError) throw e;
        parsed = text;
      }

      if (res.ok) {
        // A malformed 2xx (e.g. no payment id) is INDETERMINATE, not a silent empty success.
        //
        // THE PROJECTOR OWNS THE RETURNED OBJECT. A 2xx body is server-controlled data, and the
        // rule this SDK is built on is that server-controlled data never reaches a public object
        // unvalidated. The old `validate(); return parsed as T` broke exactly that rule on the
        // one path nobody was watching — the SUCCESS path — because success was implicitly
        // trusted. There is now no route from a parsed body to a caller that does not go through
        // a projector which rebuilds the object field by field.
        //
        // The `parsed as T` fallback remains ONLY for requests that declare no projector, which
        // are the ones whose bodies are never returned to a caller.
        if (opts.project) return opts.project(parsed, res.status);
        return parsed as T;
      }

      const message = this.#redact(
        (parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : null) ?? `paylod responded ${res.status}`,
      );

      const apiError = new PaylodApiError(
        message,
        res.status,
        this.#redactDeep(parsed),
        opts.idempotencyKey,
      );

      // 429 / 5xx are transient. A 409 is retried ONLY when it is explicitly "same key still in
      // progress" — every other 409 (body conflict, indeterminate) is a real, terminal answer.
      const transient = res.status === 429 || res.status >= 500;
      // INDETERMINATE WINS. A message carrying both phrases is not retried — see
      // INDETERMINATE_409_RE. The two substring tests overlap, so precedence is the only thing
      // that makes the pair total.
      const inProgress =
        res.status === 409 &&
        IN_PROGRESS_409_RE.test(message) &&
        !INDETERMINATE_409_RE.test(message);
      if ((!transient && !inProgress) || attempt === this.#maxRetries) throw apiError;

      lastError = apiError;
      // Honour Retry-After, in either RFC 9110 form. The ONLY bounds applied are the operation
      // deadline and, when there is none, the unbounded-sleep ceiling — both inside #boundedSleep.
      // If the header is absent, the top-of-loop backoff covers the wait.
      const retryAfterMs = parseRetryAfterMs(res.retryAfter);
      if (retryAfterMs !== undefined && retryAfterMs > 0) {
        await this.#boundedSleep(retryAfterMs, opts.deadlineMs, opts.signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new PaylodConnectionError(this.#redact(`Request to ${url} failed`));
  }

  // ── Validation ────────────────────────────────────────────────────────────────

  /**
   * Validate + normalise locally so a bad amount or phone fails instantly, in your own
   * stack trace, instead of coming back as an opaque 422 a network round-trip later.
   * Bounds mirror `_shared/schemas/collect.ts`.
   */
  #buildCollectBody(params: CollectParams): Record<string, unknown> {
    // THE shared validators, not a local copy. They live in `validate.ts` alongside the
    // idempotency-key rule and for the same reason: the simulator has to run the IDENTICAL check,
    // and it previously ran a weaker one — no amount ceiling at all, no reference or description
    // bound — so a test could go green on a charge production refuses at the boundary.
    const amount = assertChargeAmount(params.amount, "collect()");
    assertAccountReference(params.accountReference, "collect()");
    assertDescription(params.description, "collect()");

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
   * **Pass `idempotencyKey`, and mint ONE KEY PER PAYMENT ATTEMPT.** An attempt is one press of
   * Pay — not an order, and never a product:
   *
   * ```ts
   * const attempt = await db.attempts.create({ orderId: order.id });   // a row per press of Pay
   * const ack = await paylod.collect({ amount: 100, phone, idempotencyKey: attempt.id });
   * ```
   *
   * The key must be **stable across duplicates of one attempt** and **fresh for a genuinely new
   * charge**. That is what rules out the two keys people reach for first:
   *
   * - An **order id** is stable but never fresh. The customer mistypes their PIN, you retry the
   *   same order — and paylod replays the *failed* first attempt instead of charging them. That
   *   order can never be paid.
   * - A **product id** (any value reused across purchases) is catastrophic: every customer after
   *   the first replays the *first-ever* payment for that product. Nobody after customer one is
   *   charged at all.
   * - `crypto.randomUUID()` **at the call site** is equivalent to passing nothing: a double-click
   *   is two keys, two prompts, two charges. Mint the key once per attempt and persist it.
   *
   * **A concurrent double-click cannot double-charge, unconditionally.** The key is reserved
   * before Daraja is called, so ten simultaneous requests with the same key produce exactly ONE
   * payment and ONE STK push; all ten come back with the same `paymentId`.
   *
   * **The one case where the same key is not a safe retry.** If an earlier request under that key
   * died mid-flight against Daraja, the key is *spent*: paylod refuses to re-dispatch it and
   * returns a `409` **indeterminate** ({@link PaylodApiError.isIdempotencyIndeterminate}). A
   * timeout is not evidence the money did not move, so that `409` is a **stop** signal, not a
   * retry signal — read the payment status ({@link check}), and only if nothing happened start a
   * new attempt with a **new** key. For money, at-most-once beats at-least-once.
   *
   * **The key is required** — omitting it is a compile error and a runtime `throw`, not a warning.
   * The SDK used to generate one and warn once per process; that made the protection off by
   * default, because a key minted inside the call is a fresh value on every call and therefore
   * collapses nothing. Only the caller knows a retry is a retry. If you genuinely want an
   * unprotected charge (a scratch script, never production), pass
   * `unsafeGeneratedIdempotencyKey: true` — it warns on EVERY call.
   */
  async collect(params: CollectParams, options: { signal?: AbortSignal } = {}): Promise<CollectAck> {
    // RESOLVED BEFORE THE BODY IS BUILT. A caller who omits the key must hear about the key, not
    // about whichever body field happens to be validated first — and a charge with no
    // double-charge protection must not get as far as normalizing a phone number.
    const idempotencyKey = resolveIdempotencyKey(
      params.idempotencyKey,
      params.unsafeGeneratedIdempotencyKey,
      "collect()",
    );
    const body = this.#buildCollectBody(params);

    try {
      // Simulator mode (`new Paylod(testKey, { simulate: true })`): same call, same ack, no handset.
      // Your charge path runs UNCHANGED — which is the only way to actually test it. The key was
      // proven to be a sandbox key in the constructor, so this branch cannot reach production.
      if (this.#simulate) {
        const created = await this.simulate.collect(
          {
            // Forward the WHOLE body, not a subset. The idempotency layer fingerprints the request
            // body, so a field the simulator never sees is a field it cannot fingerprint: a reused
            // key with changed `metadata` (or `description`) would 409 in production and silently
            // REPLAY here. That is the exact false confidence the simulator exists to remove — a
            // test asserting "a reused key with a different body is rejected" must not go green
            // against a simulator that would let it through.
            phone: params.phone,
            amount: params.amount,
            ...(params.accountReference !== undefined
              ? { accountReference: params.accountReference }
              : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
            ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
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

      const ack = await this.#request<CollectAckWire>({
        method: "POST",
        path: "/collect",
        body,
        idempotencyKey,
        signal: options.signal,
        // A 2xx we cannot fully read is INDETERMINATE: the charge may have moved. The check is on
        // the COMPLETE ack — paymentId, checkoutRequestId and status — because a partial check is
        // a partial guarantee, and it is the shared validator the simulator runs too.
        //
        // It RECONSTRUCTS the ack rather than blessing the parsed body, and it scans that body
        // for this client's own credentials first. Both halves close the same hole from opposite
        // ends: an unknown field carrying the bearer key, and a known field carrying it.
        project: (parsed, status) =>
          parseCollectAck(parsed, {
            httpStatus: status,
            idempotencyKey,
            redactBody: (b) => this.#redactDeep(b),
            redactText: (t) => this.#redact(t),
            secrets: this.#secrets(),
          }),
      });
      return { ...ack, idempotencyKey };
    } catch (err) {
      // Whatever went wrong (network, timeout, 5xx, malformed 2xx), the caller MUST be able to
      // recover the effective key and retry with the SAME one — a fresh key would double-charge.
      throw withIdempotencyKey(err, idempotencyKey, (m) => this.#redact(m));
    }
  }

  /** Read a payment. `GET /status/:id`. */
  async status(
    paymentId: string,
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<Payment> {
    if (!paymentId) throw new PaylodInvalidRequestError("paymentId is required.");
    return this.#request<Payment>({
      method: "GET",
      path: `/status/${encodeURIComponent(paymentId)}`,
      signal: options.signal,
      deadlineMs: options.deadlineMs,
      // A 2xx status body we cannot fully read is malformed — surface it as an INDETERMINATE error
      // rather than return a half-populated Payment that `toOutcome` would then classify. The
      // whole shape is checked, not just the id: a `status` field outside the known set is exactly
      // the case where guessing turns into fulfilling an unpaid order.
      // ID BINDING: the body must describe the payment we ASKED about. A response that answers
      // a different question tells us nothing about this one, however well-formed it is.
      // RECONSTRUCTED, not passed through — see `parsePaymentBody`. A status body's `resultDesc`
      // is free text the server chose, and it lands in `PaymentOutcome.message` and in logs.
      project: (parsed, status) =>
        parsePaymentBody(parsed, {
          httpStatus: status,
          expectedId: paymentId,
          redactBody: (b) => this.#redactDeep(b),
          redactText: (t) => this.#redact(t),
          secrets: this.#secrets(),
        }),
    });
  }

  /**
   * The credentials that must never appear in a SUCCESSFUL response body.
   *
   * The same pair `#redact` scrubs out of error text. A 2xx that contains either of them is not
   * a response we can explain, so it is refused as indeterminate rather than redacted — see
   * `containsSecret`.
   */
  #secrets(): readonly string[] {
    const out: string[] = [];
    if (this.#apiKey) out.push(this.#apiKey);
    if (this.#webhookSecret) out.push(this.#webhookSecret);
    return out;
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
    const timeoutMs =
      options.timeoutMs === undefined
        ? DEFAULT_WAIT_TIMEOUT_MS
        : assertWholePositiveMs(options.timeoutMs, "wait timeoutMs");
    const startedAt = monotonicNowMs();
    const deadline = startedAt + timeoutMs;

    let last: Payment | undefined;
    for (let attempt = 0; ; attempt++) {
      // Propagate the wait's deadline into each poll so no single status read can hang past it.
      const payment = await this.status(paymentId, {
        ...(options.signal ? { signal: options.signal } : {}),
        deadlineMs: deadline,
      });
      last = payment;

      const outcome = toOutcome(payment);
      if (outcome.status !== "pending") return outcome;

      // THE CALLBACK IS AWAITED, UNDER THE WAIT'S OWN DEADLINE.
      //
      // `options.onPoll?.(payment)` discarded the return value. `onPoll` is typed to return
      // `void`, but TypeScript will happily pass an `async` function to a `void`-returning slot —
      // that is a deliberate assignability rule, not a mistake a caller can be warned about — so
      // "a promise is never returned here" was never true in practice. Every realistic `onPoll`
      // does I/O: writing the pending state to a database, pushing a websocket frame, emitting a
      // metric.
      //
      // A rejection from that floating promise is an UNHANDLED REJECTION. Node terminates the
      // process on one by default, and it happens in a microtask — after `collect()` has been
      // acknowledged and a charge is live on a handset, and outside every `try/catch` in this
      // SDK, including `collectAndWait`'s reconciliation wrapper. The process dies holding the
      // only copy of the idempotency key and the payment id, so the charge cannot be reconciled
      // by the code that raised it. That is strictly worse than any spinner update failing.
      //
      // Awaited, the same rejection becomes an ordinary failure of `wait()`, and `collectAndWait`
      // attaches the key and the payment id to it on the way out — a handle to a possibly-live
      // charge instead of a dead process. The deadline is applied so a callback that never
      // settles cannot extend the wait indefinitely either.
      if (options.onPoll) {
        await this.#awaitOnPoll(options.onPoll(payment), payment, deadline, options.signal);
      }

      const delay = pollDelay(attempt);
      if (monotonicNowMs() + delay >= deadline) break;
      await sleep(delay, options.signal);
    }

    throw new PaylodTimeoutError(paymentId, last as Payment, monotonicNowMs() - startedAt);
  }

  /**
   * Await an `onPoll` result under the wait's deadline.
   *
   * A non-promise (the common, synchronous case) returns immediately and costs nothing. A promise
   * is raced against the remaining budget, so a callback that hangs forever fails the wait with a
   * clear message instead of pinning the caller — a `wait({ timeoutMs })` that can be extended
   * without bound by a caller's own callback is not a timeout.
   *
   * The rejection is deliberately NOT swallowed. Swallowing it would trade a process crash for a
   * silent one, and `onPoll` failing usually means the caller's own record of this payment did
   * not get written — precisely the thing they need to know about a live charge.
   */
  async #awaitOnPoll(
    result: void | Promise<void>,
    payment: Payment,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (result === null || result === undefined) return;
    if (typeof (result as Promise<void>).then !== "function") return;

    const remaining = this.#remaining(deadlineMs) ?? MAX_UNBOUNDED_SLEEP_MS;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // THE ABORT HANDLER IS RETAINED SO IT CAN BE REMOVED.
    //
    // `{ once: true }` only removes a listener that FIRED. The common case is the opposite: the
    // onPoll resolves, the race settles, and the listener stays installed on the caller's signal
    // — which is a long-lived object they reuse across the whole operation. `wait()` polls dozens
    // of times, so dozens of listeners accumulate on one signal, every one of them holding a
    // closure over a `Payment` and a rejection function for a race that is long over. Node warns
    // at 11 and the memory is held for as long as the caller holds the signal. A cleanup that
    // runs only when the thing goes wrong is not cleanup.
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        result,
        new Promise<never>((_resolve, reject) => {
          const fail = (): void => {
            reject(new PaylodTimeoutError(payment.id, payment, Math.max(0, remaining)));
          };
          if (remaining <= 0) return fail();
          timer = setTimeout(fail, remaining);
          if (signal) {
            onAbort = () => reject(signal.reason ?? new Error("aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Same `finally`, same guarantee: whatever happened, nothing of this race outlives it.
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * `collect()` + `wait()`. The one-liner most integrations actually want, and the whole SDK in
   * a single call: ring the phone, wait for the PIN, hand back something you can render.
   *
   * ```ts
   * const attempt = await db.attempts.create({ orderId: order.id });   // a row per press of Pay
   *
   * const outcome = await paylod.collectAndWait({
   *   amount: 100,
   *   phone: "0712345678",
   *   idempotencyKey: attempt.id,   // ← ONE key per payment ATTEMPT. Not the order. Not the product.
   * });
   * if (outcome.paid) fulfil(outcome.receipt);
   * else              toast(outcome.message);   // no result-code table in sight
   * ```
   *
   * Duplicates of that one attempt — a double-click, a refreshed tab, a redelivered job — collapse
   * into one payment and one STK prompt. A retry after a wrong PIN is a *new* attempt and needs a
   * *new* key: replaying the old one replays the failure.
   *
   * See {@link collect} for the full rules — including the `409` **indeterminate**, which is a
   * stop-and-read-the-status signal, never a retry signal.
   */
  async collectAndWait(
    params: CollectParams,
    options: WaitOptions = {},
  ): Promise<PaymentOutcome> {
    const signal = options.signal;
    const ack = await this.collect(params, signal ? { signal } : {});
    try {
      return await this.wait(ack.paymentId, options);
    } catch (err) {
      // EVERY failure after the acknowledgement carries the effective key — the wait timing out,
      // the transport dropping, a 5xx on a poll, a malformed status body, all of them.
      //
      // This is the money-critical half of the call and it used to be uncovered: `collect()`
      // attaches the key to its own failures, but the moment the ack came back the key was only
      // on the resolved value, and anything that threw during `wait()` threw bare. A caller
      // catching that error has a charge that is very possibly LIVE and no key to read it with —
      // so the natural recovery is to mint a fresh key and call again, which is a second STK
      // prompt for a payment that may already be settling. The key must ride the error out.
      throw withIdempotencyKey(err, ack.idempotencyKey, (m) => this.#redact(m), ack.paymentId);
    }
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
      // EVERY CREDENTIAL THIS CLIENT HOLDS, not just the signing one.
      //
      // The verifier scanned `secret` alone, and this wrapper — the path essentially every
      // integration actually takes — never told it about the API key. So the credential that
      // MOVES MONEY was the one credential a signed body could echo into a handler's logs. The
      // client knows both; withholding one from the scan was the whole defect.
      ...(this.#apiKey ? { apiKey: this.#apiKey } : {}),
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
    options: { secret?: string; toleranceSec?: number; bodyReadTimeoutMs?: number } = {},
  ): (request: Request) => Promise<Response> {
    const bodyReadMs = resolveBodyReadMs(options.bodyReadTimeoutMs);
    return async (request: Request): Promise<Response> => {
      // THE BYTES ARE CAPPED BEFORE THEY ARE AUTHENTICATED, because there is no order in which
      // they could be authenticated first: verification needs the whole raw body. `request.text()`
      // is all-or-nothing and unbounded, so an anonymous caller who could reach this route could
      // stream gigabytes into the heap and OOM the process before a single check had run. A
      // signature check that happens after unbounded buffering does not protect the buffering.
      // A `Buffer`, never a string — see `readWebRequestBody`. Decoding here and re-encoding for
      // the HMAC collapses distinct invalid-UTF-8 bodies onto one canonical byte string.
      let raw: Buffer;
      try {
        raw = await readWebRequestBody(request, bodyReadMs);
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e instanceof Error ? e.message : "cannot read body" }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

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
        //
        // The handler's own exception message is NOT echoed. This response goes back over the
        // public internet to whoever posted to the endpoint, and a handler message is arbitrary
        // application text: a database error quoting a connection string, an ORM dump, a stack
        // frame, an assertion carrying customer data. Returning it turns a webhook endpoint into
        // an information-disclosure oracle that anyone can probe by posting garbage. The
        // exception is re-thrown into the runtime's own error channel instead, so it still
        // reaches your logs with full fidelity.
        reportHandlerError(e);
        return new Response(JSON.stringify({ error: "handler failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
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
    options: { secret?: string; toleranceSec?: number; bodyReadTimeoutMs?: number } = {},
  ): (req: ExpressLikeRequest, res: ExpressLikeResponse) => Promise<void> {
    const bodyReadMs = resolveBodyReadMs(options.bodyReadTimeoutMs);
    return async (req: ExpressLikeRequest, res: ExpressLikeResponse): Promise<void> => {
      let raw: Buffer;
      try {
        raw = await readRawBody(req, bodyReadMs);
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : "cannot read body" });
        return;
      }

      // A DUPLICATE signature header is not a header to choose from — it is an attack shape.
      // Taking `header[0]` let an attacker append a second `paylod-signature` and rely on the
      // proxy, the framework and this SDK disagreeing about which one counts; verifying the
      // first while a downstream hop honours the last is exactly how signature-confusion works.
      // There is only ever one legitimate signature, so more than one is a hard reject.
      const header = req.headers?.[SIGNATURE_HEADER];
      if (Array.isArray(header)) {
        res.status(400).json({
          error:
            `Multiple ${SIGNATURE_HEADER} headers on one request. A signed webhook carries ` +
            `exactly one signature; duplicates are rejected rather than guessed at.`,
        });
        return;
      }

      let event: WebhookEvent;
      try {
        event = this.verifyWebhook({
          payload: raw,
          signature: header,
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
        // See `webhookHandler` — the handler's message is never echoed to the caller.
        reportHandlerError(e);
        res.status(500).json({ error: "handler failed" });
        return;
      }
      res.status(200).json({ received: true });
    };
  }
}

/**
 * Surface a webhook handler's exception WITHOUT putting it in the HTTP response.
 *
 * The adapters answer 500 so paylod retries the delivery, but the response body is a fixed
 * string: it travels back to whoever posted to the endpoint, and a handler's message is
 * arbitrary application text (a database error quoting a connection string, an ORM dump, a
 * stack frame, an assertion carrying customer data). Logging it locally keeps every bit of that
 * diagnostic value for the operator while giving the caller nothing to probe for.
 *
 * Deliberately NOT re-thrown asynchronously: an exception raised from a microtask is an uncaught
 * exception, and Node's default behaviour for one is to terminate the process. Turning a single
 * failing webhook handler into a server crash would be a far worse bug than the leak this fixes.
 */
function reportHandlerError(e: unknown): void {
  console.error("[paylod] webhook handler threw; responding 500 so paylod retries.", e);
}

/**
 * How long an UNAUTHENTICATED webhook body may take to arrive, in milliseconds.
 *
 * The byte cap and this are two different controls and neither substitutes for the other. The cap
 * bounds how much an anonymous caller can make this process ALLOCATE; it says nothing about how
 * long they can make it WAIT. A request that dribbles one byte a minute stays under 1 MiB
 * essentially forever, and both adapters awaited the next chunk with nothing bounding them — so a
 * handful of such requests pins the handler, the connection and the caller's own request budget
 * indefinitely, at no cost to the attacker. That is a slowloris, reached through the one route on
 * a payments integration that is open to the internet by design.
 *
 * 10 seconds is ~4 orders of magnitude more than a real paylod event needs (a few hundred bytes
 * on an already-established connection) and short enough that holding a worker is not free.
 */
export const DEFAULT_WEBHOOK_BODY_READ_MS = 10_000;

/**
 * The widest body-read deadline this SDK will accept. A bound a caller can set to `Infinity` is
 * not a bound — the same reasoning as `MAX_TOLERANCE_SEC` on the replay window.
 */
export const MAX_WEBHOOK_BODY_READ_MS = 60_000;

function resolveBodyReadMs(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_WEBHOOK_BODY_READ_MS;
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new PaylodConfigError(
      "`bodyReadTimeoutMs` must be a finite positive number of milliseconds. The read deadline " +
        "is what stops an anonymous slow-drip request from pinning the handler, so it cannot be " +
        "disabled.",
    );
  }
  return Math.min(Math.floor(configured), MAX_WEBHOOK_BODY_READ_MS);
}

/** The refusal, so both adapters say the same thing for the same reason. */
function bodyReadTimedOut(ms: number, got: number): Error {
  return new Error(
    `Webhook body did not finish arriving within ${ms}ms (${got} bytes read). The bytes are not ` +
      "authenticated until the whole body is here, so an unbounded wait is a hold an anonymous " +
      "caller controls. The source has been cancelled.",
  );
}

/**
 * Race one read against the remaining budget.
 *
 * The timer is cleared on BOTH paths. Leaving it pending would keep the event loop alive for the
 * full deadline after a body that arrived promptly — a per-request leak on the busiest route in
 * the integration.
 */
async function readWithin<T>(next: Promise<T>, deadlineAt: number, onExpiry: () => void, got: number, ms: number): Promise<T> {
  const remaining = deadlineAt - monotonicNowMs();
  if (remaining <= 0) {
    onExpiry();
    throw bodyReadTimedOut(ms, got);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      next,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onExpiry();
          reject(bodyReadTimedOut(ms, got));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A declared length can be refused before a single byte is pulled. It is a hint, never a bound. */
function assertDeclaredLengthOk(declared: string | null | undefined): void {
  if (typeof declared !== "string") return;
  const s = declared.trim();
  // Digits only, and short enough to be exact as a double. A malformed or absent Content-Length
  // means nothing here — the ACTUAL bytes are counted regardless, which is the real check.
  if (!/^\d{1,15}$/.test(s)) return;
  if (Number(s) > MAX_WEBHOOK_BODY_BYTES) {
    throw tooLargeBody(`Content-Length declared ${s}`);
  }
}

/**
 * Read a Web `Request` body incrementally under {@link MAX_WEBHOOK_BODY_BYTES}.
 *
 * `await request.text()` was the whole defect: it resolves only once the ENTIRE body is resident,
 * so by the time any limit could be measured the memory has already been committed. The stream is
 * consumed chunk by chunk and abandoned the moment the budget is gone — the point of a cap is
 * that the bytes are never allocated, not that they are counted afterwards.
 *
 * The `arrayBuffer()` fallback covers a synthesised `Request` with no readable stream (some
 * runtimes, some test doubles). It is strictly weaker and is applied after the fact, which is all
 * that is available in that shape — but the declared-length check above still runs first.
 *
 * ── THE BYTES ARE NEVER DECODED ───────────────────────────────────────────────────────────
 * This returned a `string`, which meant the raw body was decoded to UTF-8 here and re-encoded
 * inside `verifyWebhookSignature` before the HMAC. That round trip is LOSSY, and lossy in the
 * one direction that matters for a signature check: every invalid UTF-8 byte sequence decodes to
 * U+FFFD, and U+FFFD re-encodes to the fixed bytes `EF BF BD`. So an unbounded family of
 * DIFFERENT bodies — any body containing any invalid sequence — collapsed onto one canonical
 * byte string, and each of them verified against a signature computed for that canonical form.
 * An attacker holding one valid signature over a replacement-character body could therefore mint
 * many distinct bodies that all pass, which is a signature check that no longer binds the bytes
 * it is supposed to bind.
 *
 * The fix is not to decode at all. `Buffer` in, `Buffer` through `verify()`, `Buffer` into the
 * HMAC — the JSON parse at the far end is the only place a decode is legitimate, and by then the
 * bytes have already been authenticated.
 */
async function readWebRequestBody(request: Request, bodyReadMs: number): Promise<Buffer> {
  assertDeclaredLengthOk(request.headers?.get?.("content-length"));
  const deadlineAt = monotonicNowMs() + bodyReadMs;

  const body = request.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    // `arrayBuffer()`, NOT `text()`. `text()` is the decode this function exists to avoid, and
    // using it only "in the fallback" would mean the byte-collapsing bug survived on precisely
    // the runtimes that do not expose a stream — a silent, per-runtime difference in what
    // verifies, which is worse than a uniform bug.
    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.byteLength > MAX_WEBHOOK_BODY_BYTES) {
      throw tooLargeBody("no readable stream was exposed, so the body was measured after reading");
    }
    return buf;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      // THE READ IS BOUNDED IN TIME AS WELL AS IN BYTES. On expiry the producer is CANCELLED,
      // not merely abandoned: an abandoned stream keeps the connection and its buffers alive,
      // which is most of what the attacker wanted.
      const { done, value } = await readWithin(
        reader.read(),
        deadlineAt,
        () => void reader.cancel().catch(() => {}),
        total,
        bodyReadMs,
      );
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        // Abandon the producer rather than politely draining it — draining is the OOM.
        await reader.cancel().catch(() => {});
        throw tooLargeBody(`read ${total} bytes and stopped`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by `cancel()` on some runtimes. Nothing to do.
    }
  }
  return Buffer.concat(chunks);
}

// ── Minimal structural types for Express/Connect (no `express` dependency) ────────

export interface ExpressLikeRequest {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: unknown;
  readableEnded?: boolean;
  /** Node's `IncomingMessage.destroy`, where the runtime exposes it. Used to abandon a slow drip. */
  destroy?: (error?: Error) => void;
  [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>;
}

export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  json(body: unknown): unknown;
}

/**
 * A body somebody else already buffered is still a body this SDK is about to hand to an HMAC, a
 * JSON parser and a handler — so the advertised cap applies to it too.
 *
 * The pre-buffered branches used to return unconditionally, which meant the limit only ever
 * bound the ONE path where this SDK did the reading. Any deployment that mounted
 * `express.raw({ limit: "50mb" })`, or ran on a runtime that hands over `req.rawBody` (Vercel,
 * Firebase), got no cap at all — and those are the common shapes, not the exotic ones. A limit
 * that holds only on the path nobody uses is documentation, not a control.
 *
 * The allocation has already happened by then; refusing here still stops the SDK compounding it
 * (an HMAC pass, a UTF-8 decode and a full JSON parse over the same unauthenticated megabytes)
 * and makes the endpoint's real ceiling equal to its stated one.
 */
function assertBufferedSizeOk(bytes: number, source: string): void {
  if (bytes > MAX_WEBHOOK_BODY_BYTES) {
    throw tooLargeBody(`${source} was already buffered at ${bytes} bytes by the framework`);
  }
}

async function readRawBody(req: ExpressLikeRequest, bodyReadMs: number): Promise<Buffer> {
  assertDeclaredLengthOk(
    typeof req.headers?.["content-length"] === "string"
      ? (req.headers["content-length"] as string)
      : null,
  );

  // express.raw() / body-parser raw → already a Buffer. Best case.
  if (Buffer.isBuffer(req.body)) {
    assertBufferedSizeOk(req.body.length, "req.body");
    return req.body;
  }
  if (typeof req.body === "string") {
    assertBufferedSizeOk(Buffer.byteLength(req.body, "utf8"), "req.body");
    return Buffer.from(req.body, "utf8");
  }
  // body-parser `verify` hook convention (and Vercel/Firebase runtimes).
  if (Buffer.isBuffer(req.rawBody)) {
    assertBufferedSizeOk(req.rawBody.length, "req.rawBody");
    return req.rawBody;
  }
  if (typeof req.rawBody === "string") {
    assertBufferedSizeOk(Buffer.byteLength(req.rawBody, "utf8"), "req.rawBody");
    return Buffer.from(req.rawBody, "utf8");
  }

  // Nothing parsed it yet → drain the stream ourselves, under a hard size cap. These bytes are
  // UNAUTHENTICATED: the signature cannot be checked until they have all arrived, so the cap is
  // the only thing bounding what an anonymous caller can make this process allocate.
  if (req.body === undefined && typeof req[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let total = 0;
    const deadlineAt = monotonicNowMs() + bodyReadMs;
    // Driven manually rather than with `for await`, because `for await` gives no way to bound the
    // wait on the next chunk — which is the entire hold being closed here.
    const it = (req as AsyncIterable<Buffer | Uint8Array | string>)[Symbol.asyncIterator]();
    const abandon = (): void => {
      // Destroy the socket where the runtime exposes it (Node's IncomingMessage does), and close
      // the iterator otherwise. Either way the producer stops being this process's problem.
      try {
        req.destroy?.();
      } catch {
        /* nothing further to do — the deadline refusal is thrown regardless */
      }
      try {
        void it.return?.(undefined as never);
      } catch {
        /* same */
      }
    };
    for (;;) {
      const { done, value } = await readWithin(
        Promise.resolve(it.next()),
        deadlineAt,
        abandon,
        total,
        bodyReadMs,
      );
      if (done) break;
      if (value === undefined || value === null) continue;
      const buf = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
      total += buf.length;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        abandon();
        throw tooLargeBody(`read ${total} bytes and stopped`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  throw new Error(
    "Cannot verify a paylod webhook: the request body was already parsed into an object, so " +
      "the raw bytes are gone. Mount the webhook route BEFORE express.json(), or give it " +
      'express.raw({ type: "application/json" }).',
  );
}
