/**
 * The credentialed transport.
 *
 * ── Why this is a class and not a function ────────────────────────────────────────────────
 * The API key is a BEARER credential: whoever receives it can move money. The previous design
 * handed that credential to an arbitrary, caller-supplied `fetch` and then tried to police the
 * result afterwards — it set `redirect: "manual"` and inspected the response for a 3xx. That
 * is not a control. An injected `fetch` is free to ignore `redirect: "manual"`, follow a
 * cross-origin 302 itself, and hand back a perfectly ordinary final `200` from
 * `https://evil.example`. By the time the SDK inspects that response the Authorization header
 * has ALREADY been replayed to another host. Checking after following is too late.
 *
 * So the credential no longer crosses a replaceable boundary at all:
 *
 *   1. The KEY LIVES HERE. Callers pass a method, a path and a body. They never see the key,
 *      never construct headers, and therefore have no way to address it anywhere.
 *   2. The DISPATCH IS SDK-OWNED. The underlying implementation is `globalThis.fetch`, captured
 *      at construction. It can be swapped ONLY through the explicit, test-only opt-in below,
 *      which is refused for `mp_live_` keys — the same posture `allowInsecureBaseUrl` already
 *      had. A production credential can never reach caller code.
 *   3. THE ORIGIN IS PINNED, per dispatch. Not once at construction: the origin of the URL
 *      actually being requested is recomputed and compared every single time.
 *   4. REDIRECTS ARE REFUSED, not followed and then judged — and the refusal is layered, so a
 *      seam that lies about `redirect: "manual"` is still caught (see `#assertNotRedirected`).
 *
 * Points 3 and 4 run INSIDE this class, on every dispatch, with no way for a caller to opt out.
 * That is the difference between a protection and a suggestion.
 */

import { PaylodConfigError, PaylodConnectionError } from "./errors.js";

/** The one origin family a paylod key may ever be addressed to. */
export const ALLOWED_HOSTS = new Set(["paylod.dev", "api.paylod.dev"]);

/** Ports we accept on the canonical origin. Anything else is a redirect to somebody's listener. */
export const ALLOWED_PORTS = new Set(["", "443"]);

/**
 * A monotonic millisecond clock.
 *
 * Deadlines used to be computed from `Date.now()`, which is WALL CLOCK: an NTP correction, a
 * daylight-saving jump, a VM resuming from suspend, or an operator setting the clock backwards
 * moves it arbitrarily. A backwards step makes a `wait()` deadline recede — the SDK keeps
 * polling a payment long past the timeout the caller asked for — and a forwards step expires an
 * in-flight charge early, reporting a live payment as timed out. `performance.now()` is
 * monotonic by specification and is immune to both.
 *
 * The `Date.now()` fallback is for exotic runtimes with no `performance`; it is strictly worse
 * and is never taken on Node 18+, Bun, Deno or any browser.
 */
export function monotonicNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** What a dispatch produced. Deliberately inert data — no live stream, no consumable body. */
export interface TransportResponse {
  readonly status: number;
  readonly ok: boolean;
  /** The body, already fully read inside the timeout window. */
  readonly text: string;
  /** The `Retry-After` header, verbatim, or null. */
  readonly retryAfter: string | null;
}

export interface TransportRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  /** Hard cap for this dispatch, covering the response body read as well as the headers. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Validate a base URL and return its pinned origin.
 *
 * HTTPS alone is NOT enough. `https://` proves the transport is encrypted; it says nothing
 * about WHO is on the other end, so any `https://evil.example` baseUrl (a bad env var, a typo,
 * a poisoned config, a copy-pasted "staging" URL) would receive a live bearer key over a
 * perfectly valid TLS connection. The allowlist is what makes the key un-exfiltratable by
 * configuration.
 */
export function assertSecureBaseUrl(
  baseUrl: string,
  apiKey: string,
  allowInsecure: boolean,
): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new PaylodConfigError(`baseUrl is not a valid URL: "${safeUrl(baseUrl)}".`);
  }

  const isLive = apiKey.startsWith("mp_live_");
  const host = parsed.hostname.toLowerCase();

  if (parsed.username !== "" || parsed.password !== "") {
    throw new PaylodConfigError(
      `baseUrl must not embed credentials (got "${safeUrl(baseUrl)}"). A "user:pass@host" URL leaks those ` +
        `credentials into logs and is a standard host-confusion trick.`,
    );
  }
  if (host === "") {
    throw new PaylodConfigError(`baseUrl has no host: "${safeUrl(baseUrl)}".`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new PaylodConfigError(
      `baseUrl must not carry a query string or fragment (got "${safeUrl(baseUrl)}"). It is a path prefix; ` +
        `a trailing "?..." would corrupt every request path built from it.`,
    );
  }

  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const loopbackOptIn = isLoopback && allowInsecure && !isLive;

  // PROTOCOL IS CHECKED FIRST, before the loopback opt-in can return. It used to be checked
  // after, so the opt-in did not merely relax the ORIGIN rule — it waved through any scheme at
  // all (`ftp://127.0.0.1/`, `ws://localhost/`, `gopher://[::1]/`), and the client would hand a
  // bearer key to whatever `fetch` made of them.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackOptIn)) {
    throw new PaylodConfigError(
      `baseUrl must use https:// (got protocol "${parsed.protocol}" in "${safeUrl(baseUrl)}"). ` +
        `Plaintext HTTP would transmit your API key in the clear, and any other scheme ` +
        `(ftp, ws, gopher, file, data…) is not something this SDK will ever speak. Loopback HTTP ` +
        `(localhost, 127.0.0.1, ::1) is allowed ONLY with { allowInsecureBaseUrl: true } and ` +
        `NEVER with an mp_live_ key.`,
    );
  }

  if (isLoopback) {
    if (loopbackOptIn) return;
    throw new PaylodConfigError(
      `baseUrl points at loopback ("${safeUrl(baseUrl)}"). That is allowed ONLY with ` +
        `{ allowInsecureBaseUrl: true }, and NEVER with an mp_live_ key — a production ` +
        `credential must never be addressed to a local listener.`,
    );
  }

  if (!ALLOWED_HOSTS.has(host)) {
    throw new PaylodConfigError(
      `baseUrl host "${host}" is not a paylod origin (got "${safeUrl(baseUrl)}"). Your API key is a bearer ` +
        `credential: it is sent on every request, so it may only ever be addressed to ` +
        `${[...ALLOWED_HOSTS].join(" or ")}. HTTPS alone does not make an arbitrary host safe.`,
    );
  }
  if (!ALLOWED_PORTS.has(parsed.port)) {
    throw new PaylodConfigError(
      `baseUrl must use the default HTTPS port (got port "${parsed.port}" in "${safeUrl(baseUrl)}").`,
    );
  }
  if (isPrivateOrLoopbackHost(host)) {
    throw new PaylodConfigError(
      `baseUrl must not point at a private, loopback or link-local address (got "${safeUrl(baseUrl)}").`,
    );
  }
}

/** RFC1918 / link-local / CGNAT / loopback literals — never a legitimate paylod origin. */
function isPrivateOrLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  const bare = host.replace(/^\[|\]$/g, "");
  if (/^f[cd][0-9a-f]{2}:/i.test(bare) || /^fe[89ab][0-9a-f]:/i.test(bare)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return true; // any other bare IPv4 literal: the canonical origin is a NAME, never an IP
}

/**
 * Render a URL for an ERROR MESSAGE with any userinfo stripped. The check that exists to stop a
 * credential leaking must not itself be the thing that leaks it.
 */
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username === "" && u.password === "") return raw;
    u.username = "";
    u.password = "";
    return u.toString().replace("://", "://[redacted]@");
  } catch {
    return "[unparseable url]";
  }
}

export interface TransportInit {
  readonly apiKey: string;
  /** Already normalised (no trailing slash) and already passed `assertSecureBaseUrl`. */
  readonly baseUrl: string;
  /** Redacts the key/secret out of any string that could be logged or thrown. */
  readonly redact: (s: string) => string;
  /**
   * TEST ONLY. Replaces the dispatch implementation. Refused for `mp_live_` keys by the caller
   * (`Paylod`'s constructor) before a Transport is ever built; the assertion is repeated here so
   * this class is safe on its own terms and cannot be misused by a future caller.
   */
  readonly testFetch?: typeof globalThis.fetch | undefined;
}

export class Transport {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #redact: (s: string) => string;

  constructor(init: TransportInit) {
    this.#apiKey = init.apiKey;
    this.#baseUrl = init.baseUrl;
    this.#redact = init.redact;
    // The origin is derived ONCE from the validated base URL and is then immutable. Every
    // dispatch is checked against this value, so no path can ever walk the request off-origin.
    this.#origin = new URL(init.baseUrl).origin;

    if (init.testFetch !== undefined) {
      // Belt and braces: `Paylod` refuses this combination before constructing us, but a
      // transport that would hand a production key to caller-supplied code under ANY
      // circumstance is not a transport worth having.
      if (init.apiKey.startsWith("mp_live_")) {
        throw new PaylodConfigError(
          "A custom fetch implementation may never be used with an mp_live_ key. The API key is " +
            "a bearer credential, and a caller-supplied fetch receives it on every request.",
        );
      }
      this.#fetch = init.testFetch;
    } else {
      const f = globalThis.fetch;
      if (typeof f !== "function") {
        throw new PaylodConfigError(
          "No global fetch available. Use Node 18+ (or Bun/Deno/a modern browser).",
        );
      }
      // Bound to `globalThis` so the reference we captured cannot be defeated by a later
      // reassignment of `globalThis.fetch`.
      this.#fetch = f.bind(globalThis);
    }
  }

  /**
   * Dispatch one credentialed request.
   *
   * The caller supplies a method, a path and a body. It does NOT supply headers, a URL, a
   * redirect mode, or the credential — all four are produced here, which is precisely what makes
   * the guarantees below unconditional.
   */
  async send(req: TransportRequest): Promise<TransportResponse> {
    const url = `${this.#baseUrl}${req.path}`;
    this.#assertOnOrigin(url, "the request URL");

    const headers: Record<string, string> = {
      // THE credential. Constructed here, from a private field, on every request.
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
    };
    if (req.body !== undefined) headers["content-type"] = "application/json";
    if (req.idempotencyKey) headers["idempotency-key"] = req.idempotencyKey;

    const timer = new AbortController();
    const to = setTimeout(() => timer.abort(), req.timeoutMs);
    const onOuterAbort = () => timer.abort();
    req.signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const res = await this.#fetch(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: timer.signal,
        // Never auto-follow: a cross-origin 3xx would replay the Authorization header to
        // another host. This is the FIRST line of defence, not the only one — see below.
        redirect: "manual",
      });

      this.#assertNotRedirected(res, url);

      // THE BODY IS READ INSIDE THE TIMEOUT WINDOW.
      //
      // Previously the abort listener was detached and the timer cleared in a `finally` that ran
      // before `res.text()` was called. A server (or a proxy) that sent headers promptly and
      // then dribbled or stalled the body left `res.text()` awaiting with NOTHING bounding it —
      // so a request with a 30s timeout could hang indefinitely, and a `wait()` with a deadline
      // could overrun it without limit. Reading here, before the `finally`, keeps the whole
      // exchange under the one deadline the caller asked for.
      const text = await res.text().catch(() => "");

      return {
        status: res.status,
        ok: res.ok,
        text,
        retryAfter: res.headers.get("retry-after"),
      };
    } finally {
      clearTimeout(to);
      req.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /** The pinned origin, for diagnostics and tests. */
  get origin(): string {
    return this.#origin;
  }

  #assertOnOrigin(candidate: string, what: string): void {
    let origin: string;
    try {
      origin = new URL(candidate).origin;
    } catch {
      throw new PaylodConnectionError(
        this.#redact(`${what} is not a valid URL (${safeUrl(candidate)}).`),
      );
    }
    if (origin !== this.#origin) {
      throw new PaylodConnectionError(
        this.#redact(
          `Refusing a request that is not addressed to the pinned paylod origin: ${what} ` +
            `resolves to "${origin}", but this client is pinned to "${this.#origin}". Your API ` +
            `key is a bearer credential and is sent on every request, so it may only ever be ` +
            `addressed to the origin it was configured for.`,
        ),
      );
    }
  }

  /**
   * Refuse anything that is, or came from, a redirect — in FOUR independent ways, because the
   * dispatch implementation is the thing we are defending against and it cannot be trusted to
   * report honestly:
   *
   *   1. `opaqueredirect` — what a conformant implementation returns for `redirect: "manual"`.
   *   2. a 3xx status — a redirect that was surfaced rather than followed.
   *   3. `res.redirected === true` — the implementation FOLLOWED one despite `manual`. This is
   *      the injected-fetch attack: the credential has already been replayed, so this is a
   *      detection, not a prevention. It is here so the failure is loud rather than silent, and
   *      so the caller learns their key is burned. Prevention is that a live key can never reach
   *      a custom fetch in the first place.
   *   4. `res.url` off-origin — the final response came from somewhere we did not address, which
   *      catches an implementation that follows a redirect while lying about `redirected`.
   *
   * None of these is retryable: a redirect is a configuration or an attack, never a blip.
   */
  #assertNotRedirected(res: Response, requested: string): void {
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new PaylodConnectionError(
        this.#redact(
          `paylod returned an unexpected redirect (HTTP ${res.status || "opaque"}) from ${requested}. ` +
            `Refusing to follow it — a cross-origin redirect could leak your Authorization header ` +
            `to another host.`,
        ),
      );
    }

    if (res.redirected === true) {
      throw new PaylodConnectionError(
        this.#redact(
          `The fetch implementation FOLLOWED a redirect even though this SDK requested ` +
            `redirect: "manual". Your Authorization header may already have been replayed to ` +
            `another host — treat this API key as compromised and rotate it. This is only ` +
            `reachable through the test-only { fetch } option, which is why that option is ` +
            `refused for mp_live_ keys.`,
        ),
      );
    }

    // `res.url` is "" for a synthesised Response (the normal case in tests), which is not
    // evidence of anything and must not be treated as a violation.
    if (res.url) this.#assertOnOrigin(res.url, "the responding URL");
  }
}
