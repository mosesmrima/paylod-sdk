# Changelog

All notable changes to `@paylod/node` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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
