# Changelog

All notable changes to `@paylod/node` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.5.0

Second-round fixes from a codex **re-verification** of the 0.4.0 security review. The 0.4.0 pass
was directionally right but incomplete: several of its guards could still be walked around. This
release closes those gaps.

Signing is still unchanged — the shared golden webhook vector (`whsec_golden_vector_v1` →
`3afe38e4…2c2eb7`) still passes, byte for byte. Only validation got stricter.

**Minor, not patch:** two of these fixes can reject input that 0.4.0 accepted (see *Breaking*).

### Money-correctness

- **Family-aware decoding is now actually family-aware.** 0.4.0 selected a non-STK entry but still
  fell back to *any* entry for the code — so a code that exists only under `stk_result` (notably
  **4999**) decoded as the STK **pending** entry when the caller explicitly asked for `api_error`
  or `b2c_c2b_result`. That reports a terminal API/result failure as a payment still in flight:
  the same "false pending" shape as the original 4999 double-charge bug, reached from the other
  direction. A non-STK family now resolves only to the requested entry or another non-STK entry,
  and otherwise returns the terminal, non-retryable fallback. An STK pending entry can never be
  returned for a non-STK surface. (`src/daraja-catalog.ts`, canonical in the paylod monorepo)

### Webhooks

- **Replay protection can no longer be disabled.** `toleranceSec` must be a **finite positive
  integer**, unconditionally. 0.4.0 rejected a non-positive tolerance only when no clock was
  injected — so passing a fixed `nowSec` re-opened the bypass — and accepted `Infinity`, which is
  an infinite freshness window. `0`, negatives, `Infinity`, `NaN` and non-integers are all
  rejected now, and the freshness check always runs. An injected `nowSec` is validated as a finite
  non-negative integer for the same reason. (`src/webhook.ts`)
- **Strict signature timestamp parsing.** `t` is validated lexically as decimal digits only.
  `Number()` had been accepting `1e3`, `+1000` and hex. (`src/webhook.ts`)
- **The Express adapter rejects duplicate signature headers.** It previously verified only
  `header[0]` of a duplicated `paylod-signature`, contradicting the strict duplicate-rejection
  rule — verifying the first while a downstream hop honours the last is how signature-confusion
  attacks work. Duplicates are now a flat `400`. (`src/client.ts`)

### Credential safety

- **`baseUrl` is an allowlist, not just an HTTPS check.** HTTPS proves the transport is encrypted,
  not *who* is on the other end, so 0.4.0 would still send a live bearer key to any `https://`
  host reachable via a bad env var or a typo. Only **`paylod.dev`** and **`api.paylod.dev`**, over
  HTTPS on port 443, are accepted. URLs carrying userinfo (`https://user:pass@host`), no host, a
  non-default port, a query string, a fragment, or a raw/private/loopback/link-local IP are
  rejected. The explicit test-only loopback exception remains, and is still never permitted with
  an `mp_live_` key — including over `https://`. (`src/client.ts`)
- **Idempotency key charset closed.** The 0.4.0 check covered C0 and DEL but let the **C1** block
  through — including U+0085 (NEL), a line terminator some proxies fold into a newline, i.e. a
  header-injection vector. The full Unicode control ranges are now rejected, along with Unicode
  whitespace and zero-width/BOM characters (invisible in logs, so two visually identical keys can
  silently be different keys — one double charge). Length is bounded by **UTF-8 bytes** (≤255)
  rather than UTF-16 code units. (`src/client.ts`)
- **Idempotency keys must be printable ASCII (0x20-0x7E).** HTTP header values are ASCII on the
  wire (RFC 9110), so a non-ASCII key (`ordr-café-1`, a customer name, an emoji) either dies as an
  unactionable transport-level encoding crash or — worse, on a laxer stack — is silently
  re-encoded, so two requests intended to share ONE key no longer do. That quietly removes the
  duplicate-charge guard the header exists to provide. Rejected with an actionable message before
  dispatch. Found by the Python SDK agent. (`src/client.ts`)

### Cross-SDK standardization

`@paylod/node` is canonical; the PHP and JVM SDKs mirror these shapes.

- **Origin allowlist shape is fixed across SDKs:** exact-match set of `paylod.dev` and
  `api.paylod.dev` (never a suffix match), port 443 only. `api.paylod.dev` does not route today —
  an unreachable but owner-controlled host in the allowlist is harmless, and including it avoids a
  future lockout where published SDKs would reject a legitimate migration until every package is
  re-released.
- **Loopback is uniform across schemes.** `https://` loopback now requires the same explicit
  test-only opt-in as `http://` loopback, and is likewise never permitted with an `mp_live_` key.
  A local listener holding a valid certificate is still not paylod, so TLS alone must not buy it a
  pass. (Raised by the PHP SDK agent, where https loopback was slipping through unchecked.)
- **Any sleep without a deadline is ceilinged at 60s** (`MAX_UNBOUNDED_SLEEP_MS`). A bare
  `collect()` has no polling budget, so a hostile or buggy `Retry-After: 86400` would otherwise
  park the caller for a day inside what they believe is one request. When an absolute deadline
  exists it still wins, being the tighter caller-chosen bound. (Node additionally clamps
  `Retry-After` itself to 10s, so this is defence in depth here; the ceiling exists so every SDK
  agrees on the worst case.) (`src/client.ts`)

### Types

- **`idempotencyKey` is declared on the error types.** It was attached as an undeclared ad-hoc
  property, so it existed at runtime but TypeScript consumers could not read it without a cast —
  pushing them toward minting a fresh key, which is exactly the double-charge path. It is now a
  declared optional field on `PaylodError`, inherited by every subclass. (`src/errors.ts`)

### Breaking

- `toleranceSec: 0` (or any non-positive / non-finite value) now **throws** instead of disabling
  the freshness check. If you were disabling replay protection for a fixed-vector test, pass a
  normal positive window alongside your pinned `nowSec`.
- A `baseUrl` pointing anywhere other than `paylod.dev` / `api.paylod.dev` (or opted-in loopback)
  now **throws** `PaylodConfigError`. `baseUrl` was never a self-hosting hook; it is a stub/test
  pointer, and that is now enforced rather than documented.
- A non-ASCII `idempotencyKey` now **throws** `PaylodInvalidRequestError`. In practice such keys
  were already failing — as a transport-level encoding crash, or silently as a lost duplicate
  guard — so this converts an obscure failure into an actionable one.

## 0.4.0

Security- and money-correctness hardening from a codex security review. `@paylod/node` is the
canonical SDK; these fixes land here first and are then propagated to the other language SDKs.

Signing is unchanged — the shared golden webhook vector (`whsec_golden_vector_v1` →
`3afe38e4…2c2eb7`) still passes. Only parsing/validation got stricter.

### Money-correctness

- **Raw status can no longer override the classifier.** `toOutcome()` now derives the outcome from
  `classifyStkResult` alone whenever a `ResultCode` is present; the raw `status` field is never
  allowed to force a `paid` result. `status:"success"` carrying a pending code (`4999`) or a
  failure code (`1032`) is no longer reported as paid. A genuine contradiction between the two
  terminal signals (e.g. `status:"success"` + code `1032`, or `status:"failed"` + code `0`) is now
  treated as **indeterminate** — not paid, not retryable — and surfaced as `pending` so `wait()`
  lets it settle (and ultimately throws `PaylodTimeoutError`) rather than reporting a false
  success. (`src/outcome.ts`)
- **Catalog `retryable` flags corrected (owner-approved).** Codes **17, 26, 1025, 9999** changed
  from `retryable:true` to `retryable:false`. "Safe to charge again" had been set on
  non-authoritative community evidence; until no-debit is proven, `false` is the safe money call.
  `4999` and `500.001.1001` remain pending / non-retryable (already correct). Provenance is
  recorded in each entry's `sources[]`. (`src/daraja-error-codes.json`)
- **Family-aware decoding.** `decodeDarajaResult` no longer routes every code through the STK
  classifier. Dotted `api_error` codes (e.g. `400.002.02`, `500.001.1001`) and alphanumeric
  `b2c_c2b_result` codes (e.g. `C2B00011`) used to fall through the STK "unknown → pending" rule
  and decode as "payment still in progress"; they now decode terminally by family. The overloaded
  `500.001.1001` decodes as the terminal server error on the `api_error` surface and as "still
  processing" on the STK surface, and `"insufficient funds"` was added to the terminal-500 message
  matcher. (`src/daraja-catalog.ts`)

### Idempotency / double-charge

- **Idempotency keys are validated.** Blank, whitespace-only, control-character, and over-long
  keys are rejected up front (in both `collect()` and `simulate.collect()`) instead of being
  silently accepted and dropping double-charge protection. (`src/client.ts`, `src/simulate.ts`)
- **A generated key is never lost on failure.** When `collect()` throws (network, timeout, 5xx,
  malformed 2xx), the effective idempotency key is attached to the thrown error so a caller can
  retry with the **same** key rather than mint a fresh one and double-charge. (`src/client.ts`)
- **In-progress 409 handling.** Only an explicitly-identified `409` "idempotency request already in
  progress" is retried (bounded by `maxRetries`, honouring `Retry-After`). Body-conflict and
  indeterminate 409s remain terminal, non-retried answers. (`src/client.ts`)

### Security

- **HTTPS enforced on `baseUrl`.** A non-HTTPS origin is refused at construction. Loopback HTTP
  (`localhost` / `127.0.0.1`) is permitted only behind the new **`allowInsecureBaseUrl`** test-only
  flag, and never with an `mp_live_` key — preventing plaintext key transmission / SSRF.
  (`src/client.ts`, `src/types.ts`)
- **Secret redaction.** The API key and webhook signing secret are scrubbed (`[redacted]`) from any
  error message surfaced by the transport layer. (`src/client.ts`)
- **Redirects are refused.** Requests use `redirect: "manual"` and a redirect response is rejected
  rather than followed, so a cross-origin redirect can never carry the `Authorization` header to
  another host. (`src/client.ts`)

### Robustness

- **Malformed 2xx is indeterminate.** A `collect()`/`status()` 2xx with no payment id now raises an
  indeterminate `PaylodApiError` (new `indeterminate` flag; `collect()` also carries the
  idempotency key) instead of silently producing an empty id. (`src/client.ts`, `src/errors.ts`)
- **`wait()` respects its deadline.** The wait's remaining deadline is propagated into every poll,
  and each request timeout plus every `Retry-After`/backoff sleep is capped to it — so a `wait()`
  can no longer overrun `timeoutMs` by a full request timeout per poll. (`src/client.ts`)
- **Webhook header strictness.** The signature header must carry exactly one integer `t` and
  exactly one 64-char lowercase-hex `v1`. Duplicate, malformed, or comma-combined multi-value
  headers are rejected (closing a last-value-wins hole). (`src/webhook.ts`)
- **Tolerance guard.** A non-positive `toleranceSec` no longer silently disables timestamp/replay
  validation; it is refused (new `insecure_tolerance` reason) unless a fixed `nowSec` clock is
  injected for a deterministic fixed-vector test. (`src/webhook.ts`, `src/errors.ts`)

### Docs

- README webhook dedup guidance corrected: dedup on the **signed** `data.paymentId`, never on the
  unsigned, replayable `x-webhook-id` header. The `baseUrl` escape-hatch example now uses HTTPS and
  documents `allowInsecureBaseUrl`.

### Maintainer note

`src/daraja-catalog.ts` and `src/daraja-error-codes.json` are marked "generated" from the paylod
monorepo, but this release edits them directly because this SDK is the source of truth for the fix.
They now diverge from the monorepo canonical until the change is propagated back;
`node scripts/sync-daraja-catalog.mjs --check` will report drift until then.
