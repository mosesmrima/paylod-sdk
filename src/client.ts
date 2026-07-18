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
      "         A double-clicked Pay button, a refreshed tab, or a redelivered job will fire a " +
      "SECOND STK prompt and can charge your customer twice.\n" +
      "         Pass ONE KEY PER PAYMENT ATTEMPT — an id you mint when the customer presses Pay, " +
      "and persist on that attempt:\n" +
      "             const attempt = await db.attempts.create({ orderId: order.id });\n" +
      "             paylod.collectAndWait({ phone, amount, idempotencyKey: attempt.id })\n" +
      "         Do NOT key on the order or the product. An order id is stable but never fresh: a " +
      "retry after a wrong PIN replays the FAILED attempt, so that order can never be paid. A " +
      "product id is worse — every customer after the first replays the first-ever payment, and " +
      "nobody after customer one is charged at all.\n" +
      "         Do NOT generate the key inside the call either (`crypto.randomUUID()` at the call " +
      "site is exactly equivalent to passing nothing — it just hides this warning).\n" +
      "         Duplicates of one attempt collapse into one payment and one prompt. A genuine " +
      "retry is a NEW attempt and needs a NEW key. https://paylod.dev/docs/sdk#idempotency",
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
  /**
   * Absolute deadline (`Date.now()` ms) for the WHOLE operation. Each in-flight request is capped
   * to the remaining time, and every backoff / `Retry-After` sleep is clamped to it — so a
   * `wait()` cannot overrun its `timeoutMs` by a full request timeout per poll.
   */
  readonly deadlineMs?: number;
  /**
   * Run against a 2xx body before it is returned. Throw here to reject a malformed success (e.g. a
   * 200 with no payment id) as an error instead of silently handing back an empty shape.
   */
  readonly validate?: (parsed: unknown, status: number) => void;
}

/**
 * A `409` retried only when it is explicitly the "same key still running" case. Every other 409
 * (body conflict, indeterminate) is a real answer and must NOT be retried.
 */
const IN_PROGRESS_409_RE = /already in progress/i;

/** The wall clock, in one place. (`Date` is what the fake-timer test harness controls.) */
function nowMs(): number {
  return Date.now();
}

/**
 * Reject an idempotency key that would silently drop double-charge protection: blank/whitespace
 * keys, keys carrying control characters (which also cannot go in an HTTP header), and absurdly
 * long values. A caller-supplied key is the ONE thing standing between a double-click and a
 * double-charge, so a bad one must fail loudly rather than be quietly accepted.
 */
function assertValidIdempotencyKey(key: string): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw new PaylodInvalidRequestError(
      "idempotencyKey must be a non-empty, non-whitespace string — a blank key silently drops " +
        "double-charge protection.",
    );
  }
  // The COMPLETE Unicode control set - C0 (U+0000-U+001F), DEL (U+007F) and C1 (U+0080-U+009F).
  // C1 was the hole: U+0085 (NEL) is a line terminator that several proxies and header parsers
  // fold into a newline, so it is a header-injection vector the old C0+DEL check waved through.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(key)) {
    throw new PaylodInvalidRequestError(
      "idempotencyKey must not contain control characters (tabs, newlines, NULs, C1 controls).",
    );
  }
  // Unicode-only whitespace, plus the zero-width / BOM formatting characters. `key.trim()` above
  // does not catch these in the MIDDLE of a key, and they are invisible: two keys that look
  // identical in a log but differ by one U+00A0 are two different keys - i.e. one double charge.
  if (
    /[\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u2060\u3000\ufeff]/.test(key)
  ) {
    throw new PaylodInvalidRequestError(
      "idempotencyKey must not contain Unicode whitespace or zero-width characters - they are " +
        "invisible in logs, so two visually identical keys can silently be different keys.",
    );
  }
  // Bound the BYTE length, not the UTF-16 code-unit count: the key goes out as bytes in a header,
  // and 255 astral characters is 1020 bytes on the wire.
  if (Buffer.byteLength(key, "utf8") > 255) {
    throw new PaylodInvalidRequestError(
      "idempotencyKey must be 255 bytes or fewer (UTF-8).",
    );
  }
  // Printable ASCII only (0x20-0x7E). HTTP header values are ASCII on the wire (RFC 9110), so a
  // non-ASCII key -- "ordr-café-1", a customer name, an emoji -- either dies as an unactionable
  // transport-level encoding crash, or, on a laxer stack, is SILENTLY re-encoded. The second case
  // is the dangerous one: two requests meant to share one key stop sharing it, which quietly
  // removes the duplicate-charge guard that is the entire purpose of this header.
  if (!/^[\x20-\x7e]+$/.test(key)) {
    throw new PaylodInvalidRequestError(
      "idempotencyKey must be printable ASCII (0x20-0x7E). HTTP header values are ASCII on the " +
        "wire, so a non-ASCII key can be silently re-encoded in transit -- two requests meant to " +
        "share one key would stop sharing it and the customer would be charged twice. Use an " +
        "opaque id (a UUID or your attempt's primary key), not customer- or product-derived text.",
    );
  }
}

/**
 * If the SDK generated the idempotency key (or even if the caller supplied it), a failed collect
 * MUST hand the effective key back on the error so the caller can retry with the SAME key rather
 * than mint a fresh one and double-charge. Best-effort: never clobber a key an error already set.
 */
function attachIdempotencyKey(err: unknown, key: string): void {
  if (
    err &&
    typeof err === "object" &&
    (err as { idempotencyKey?: unknown }).idempotencyKey === undefined
  ) {
    try {
      (err as { idempotencyKey?: string }).idempotencyKey = key;
    } catch {
      /* frozen error object — nothing more we can do */
    }
  }
}

/**
 * The ONE origin a paylod key may ever be sent to.
 *
 * HTTPS alone is NOT enough. `https://` proves only that the transport is encrypted — it says
 * nothing about WHO is on the other end, so any `https://evil.example` baseUrl (from a bad env
 * var, a typo, a poisoned config, a copy-pasted "staging" URL) would happily receive a live
 * bearer key over a perfectly valid TLS connection. An allowlist is what makes the key
 * un-exfiltratable by configuration.
 */
const ALLOWED_HOSTS = new Set(["paylod.dev", "api.paylod.dev"]);

/** Ports we accept on the canonical origin. Anything else is a redirect to somebody's listener. */
const ALLOWED_PORTS = new Set(["", "443"]);

/** RFC1918 / link-local / CGNAT / loopback literals — never a legitimate paylod origin. */
function isPrivateOrLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10), in bracketed or bare form.
  const bare = host.replace(/^\[|\]$/g, "");
  if (/^f[cd][0-9a-f]{2}:/i.test(bare) || /^fe[89ab][0-9a-f]:/i.test(bare)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata (169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return true; // any other bare IPv4 literal: the canonical origin is a NAME, never an IP
}

/**
 * Enforce that `baseUrl` is the canonical paylod origin.
 *
 * Checks, in order: parseable; no embedded credentials (`https://user:pass@host` — userinfo is
 * both a credential leak and a classic host-confusion trick); a real host; no query or fragment
 * (a baseUrl is a prefix, and a trailing `?x=` silently corrupts every path built on it); an
 * allowlisted host on an expected port; and no private/loopback address.
 *
 * The single exception is the explicit, test-only loopback opt-in — which remains forbidden with
 * a live (`mp_live_`) key, so a production credential can never reach a local listener either.
 */
function assertSecureBaseUrl(baseUrl: string, apiKey: string, allowInsecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new PaylodConfigError(`baseUrl is not a valid URL: "${baseUrl}".`);
  }

  const isLive = apiKey.startsWith("mp_live_");
  const host = parsed.hostname.toLowerCase();

  if (parsed.username !== "" || parsed.password !== "") {
    throw new PaylodConfigError(
      `baseUrl must not embed credentials (got "${baseUrl}"). A "user:pass@host" URL leaks those ` +
        `credentials into logs and is a standard host-confusion trick.`,
    );
  }
  if (host === "") {
    throw new PaylodConfigError(`baseUrl has no host: "${baseUrl}".`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new PaylodConfigError(
      `baseUrl must not carry a query string or fragment (got "${baseUrl}"). It is a path prefix; ` +
        `a trailing "?..." would corrupt every request path built from it.`,
    );
  }

  // Test-only escape hatch: loopback — over http OR https — explicitly opted into, and NEVER with
  // a live key. https loopback needs the same opt-in as http: a local listener holding a valid
  // certificate is still not paylod, so TLS alone must not buy it a pass.
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (isLoopback) {
    if (allowInsecure && !isLive) return;
    throw new PaylodConfigError(
      `baseUrl points at loopback ("${baseUrl}"). That is allowed ONLY with ` +
        `{ allowInsecureBaseUrl: true }, and NEVER with an mp_live_ key — a production ` +
        `credential must never be addressed to a local listener.`,
    );
  }

  if (parsed.protocol !== "https:") {
    throw new PaylodConfigError(
      `baseUrl must use https:// (got "${baseUrl}"). Plaintext HTTP would transmit your API key ` +
        `in the clear. Loopback HTTP (localhost, 127.0.0.1) is allowed ONLY with ` +
        `{ allowInsecureBaseUrl: true } and NEVER with an mp_live_ key.`,
    );
  }

  if (!ALLOWED_HOSTS.has(host)) {
    throw new PaylodConfigError(
      `baseUrl host "${host}" is not a paylod origin (got "${baseUrl}"). Your API key is a bearer ` +
        `credential: it is sent on every request, so it may only ever be addressed to ` +
        `${[...ALLOWED_HOSTS].join(" or ")}. HTTPS alone does not make an arbitrary host safe.`,
    );
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    throw new PaylodConfigError(
      `baseUrl must use the default HTTPS port (got port "${parsed.port}" in "${baseUrl}").`,
    );
  }
  if (isPrivateOrLoopbackHost(host)) {
    throw new PaylodConfigError(
      `baseUrl must not point at a private, loopback or link-local address (got "${baseUrl}").`,
    );
  }
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

  /** Scrub the API key and webhook secret out of anything that could be logged or thrown. */
  #redact(s: string): string {
    let out = s;
    if (this.#apiKey) out = out.split(this.#apiKey).join("[redacted]");
    if (this.#webhookSecret) out = out.split(this.#webhookSecret).join("[redacted]");
    return out;
  }

  /** Remaining time to the deadline, or `undefined` when there is no deadline. */
  #remaining(deadlineMs: number | undefined): number | undefined {
    return deadlineMs === undefined ? undefined : deadlineMs - nowMs();
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

  async #request<T>(opts: RequestOptions): Promise<T> {
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

      const timer = new AbortController();
      const to = setTimeout(() => timer.abort(), perRequestTimeout);
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
          // Never auto-follow a redirect: a cross-origin 3xx would replay the Authorization header
          // to another host. We inspect and refuse it ourselves instead.
          redirect: "manual",
        });
      } catch (e) {
        lastError = new PaylodConnectionError(
          this.#redact(
            `Could not reach paylod at ${url}: ${e instanceof Error ? e.message : String(e)}`,
          ),
          { cause: e },
        );
        if (opts.signal?.aborted) throw lastError;
        continue; // network blip → retry
      } finally {
        clearTimeout(to);
        opts.signal?.removeEventListener("abort", onOuterAbort);
      }

      // A redirect is never expected from the API. Refuse it rather than follow it to a host that
      // would receive the bearer token. Not retryable — a redirect loop is not a transient blip.
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        throw new PaylodConnectionError(
          this.#redact(
            `paylod returned an unexpected redirect (HTTP ${res.status || "opaque"}) from ${url}. ` +
              `Refusing to follow it — a cross-origin redirect could leak your Authorization header ` +
              `to another host.`,
          ),
        );
      }

      const text = await res.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      if (res.ok) {
        // A malformed 2xx (e.g. no payment id) is INDETERMINATE, not a silent empty success.
        opts.validate?.(parsed, res.status);
        return parsed as T;
      }

      const message = this.#redact(
        (parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : null) ?? `paylod responded ${res.status}`,
      );

      const apiError = new PaylodApiError(message, res.status, parsed, opts.idempotencyKey);

      // 429 / 5xx are transient. A 409 is retried ONLY when it is explicitly "same key still in
      // progress" — every other 409 (body conflict, indeterminate) is a real, terminal answer.
      const transient = res.status === 429 || res.status >= 500;
      const inProgress = res.status === 409 && IN_PROGRESS_409_RE.test(message);
      if ((!transient && !inProgress) || attempt === this.#maxRetries) throw apiError;

      lastError = apiError;
      // Honour Retry-After (clamped to 10s and to the operation deadline). If absent, the
      // top-of-loop backoff covers the wait.
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await this.#boundedSleep(Math.min(retryAfter * 1000, 10_000), opts.deadlineMs, opts.signal);
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
   * Omit the key and the SDK generates a fresh one per call. That still makes an internal
   * *network* retry of this one call safe, but it does nothing about your application sending the
   * same logical charge twice — a double-clicked button, a refreshed tab, a redelivered job —
   * which is by far the more common way a customer gets charged twice. The SDK warns once if you
   * omit it.
   */
  async collect(params: CollectParams, options: { signal?: AbortSignal } = {}): Promise<CollectAck> {
    const body = this.#buildCollectBody(params);
    if (params.idempotencyKey === undefined) warnMissingIdempotencyKey();
    // A caller-supplied key is the double-charge guard — reject a blank/whitespace/control-char
    // one loudly rather than silently drop protection. A generated key is always well-formed.
    else assertValidIdempotencyKey(params.idempotencyKey);
    const idempotencyKey = params.idempotencyKey ?? randomUUID();

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

      const ack = await this.#request<Omit<CollectAck, "idempotencyKey">>({
        method: "POST",
        path: "/collect",
        body,
        idempotencyKey,
        signal: options.signal,
        // A 2xx with no payment id is INDETERMINATE: the charge may have moved. Fail with the key
        // attached rather than hand back an empty id a caller would treat as a new payment.
        validate: (parsed, status) => {
          const id = (parsed as { paymentId?: unknown } | null)?.paymentId;
          if (typeof id !== "string" || id.trim() === "") {
            throw new PaylodApiError(
              "paylod returned a 2xx response with no paymentId — the charge state is " +
                "INDETERMINATE. Read the payment with this idempotencyKey before starting any new " +
                "attempt; do NOT mint a fresh key (that risks a second charge).",
              status,
              parsed,
              idempotencyKey,
              true,
            );
          }
        },
      });
      return { ...ack, idempotencyKey };
    } catch (err) {
      // Whatever went wrong (network, timeout, 5xx, malformed 2xx), the caller MUST be able to
      // recover the effective key and retry with the SAME one — a fresh key would double-charge.
      attachIdempotencyKey(err, idempotencyKey);
      throw err;
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
      // A 2xx status body with no id is malformed — surface it rather than return an empty Payment.
      validate: (parsed, status) => {
        const id = (parsed as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || id.trim() === "") {
          throw new PaylodApiError(
            "paylod returned a 2xx status body with no payment id (malformed response).",
            status,
            parsed,
          );
        }
      },
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
    const startedAt = nowMs();
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
      options.onPoll?.(payment);

      const delay = pollDelay(attempt);
      if (nowMs() + delay >= deadline) break;
      await sleep(delay, options.signal);
    }

    throw new PaylodTimeoutError(paymentId, last as Payment, nowMs() - startedAt);
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
