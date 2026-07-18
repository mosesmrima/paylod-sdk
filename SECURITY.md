# Security

This document states what `@paylod/node` defends against, what it does not, and why. It is
identical in substance across the paylod SDKs (Node, Python, PHP, JVM) — they implement one design,
so they make one set of promises.

The goal here is to be **specific and honest** rather than reassuring. A threat model that implies
protection it does not provide is worse than no threat model, because integrators build on it.

## Reporting a vulnerability

Email **security@paylod.dev**. Please do not open a public issue for an unfixed vulnerability.
Include a description, affected version, and a reproduction if you have one. We will acknowledge
within three business days.

---

## In scope

These are the attacks the SDK is designed to defeat. Each has tests, and each has a case in
`scripts/non-vacuity.mjs` that reverts the protection and requires the guarding test to fail.

### 1. Network attackers and MITM

The API key is a **bearer credential**: whoever receives it can move money.

- `baseUrl` is **allowlisted**, not merely required to be HTTPS. HTTPS proves the transport is
  encrypted; it says nothing about who is on the other end, so `https://evil.example` would receive
  a live key over a perfectly valid TLS connection. Only `paylod.dev` and `api.paylod.dev`, on port
  443, are accepted.
- Plaintext `http://` is refused except for loopback under an explicit `allowInsecureBaseUrl`
  opt-in, which is refused unconditionally for `mp_live_` keys. Every other scheme (`ftp`, `ws`,
  `file`, `data`, …) is refused outright.
- URLs carrying userinfo (`user:pass@host`), a non-default port, a query string, a fragment, or a
  raw/private/link-local IP literal are refused.
- The request origin is **re-pinned on every dispatch**, not once at construction.

### 2. A malicious or compromised API response

A signature or a 200 proves who answered, not that the answer is coherent. The SDK judges the
content:

- Every response body is **schema-validated** before it is trusted. A `2xx` the SDK cannot fully
  read is raised as an **indeterminate** error carrying the idempotency key — never returned as a
  half-populated success.
- `POST /collect` must answer **202** specifically. A bare `200` is the shape a cache, proxy,
  captive portal or stubbed route produces, and treating it as an ack invents a payment.
- "Is this paid?" is decided by one **total (claim x evidence) table** (`src/semantics.ts`). The
  record's `status` field is a *claim*; `mpesaReceipt` and `resultCode` are *evidence*; neither
  substitutes for the other. `status: "success"` with no evidence behind it is never `paid`.
- Result-code zero is recognised by **exact form**, never by numeric coercion. `"0e999"`, `"+0"`,
  `"00"` and `"0.0"` are all `0` to a coercing parser and are all refused as success evidence.
- Response bodies are read under a **byte cap** and parsed under a **depth cap**. Both convert to a
  terminal indeterminate error carrying the key, because an OOM after a charge loses the only
  handle on it.

### 3. Cross-origin redirects attempting to capture the bearer token

Checking a response *after* following a redirect is too late — the `Authorization` header has
already been replayed. The SDK refuses redirects in four independent ways (`opaqueredirect`, a 3xx
status, `res.redirected === true`, and a final `res.url` off the pinned origin), and treats every
one as **terminal**: `PaylodSecurityError` is never retried, because a retry re-sends a credential
the SDK has just concluded may be leaking.

### 4. A response for a DIFFERENT payment (wrong-record settlement)

`GET /status/:id` responses are **bound to the id that was requested**. A cache keyed on the wrong
thing, a proxy collapsing concurrent requests, an off-by-one in a routing or authorization layer, or
a crafted response can all return another payment's record — every field valid, describing a
different payment. If that payment happened to be settled, the caller would be told *theirs* was
paid. A mismatch is indeterminate, never a verdict.

### 5. Webhook forgery and replay

- HMAC-SHA256 over the **raw bytes**, compared in constant time.
- The signature header is parsed **strictly**: exactly one `t` and one `v1`, a 64-char lowercase-hex
  digest, and a digits-only timestamp. Duplicate `t`/`v1` pairs are fatal rather than
  last-value-wins.
- Multiple `x-webhook-signature` headers on one request are rejected outright — signature confusion
  depends on hops disagreeing about which one counts.
- Replay protection **cannot be disabled**. `toleranceSec` must be a whole number of seconds between
  1 and 86 400. Both bounds matter: zero disables the check openly, and an enormous value disables it
  while still looking enabled.
- A valid signature does **not** make a body's contents true. `data.decoded` — which carries
  `retryable`, meaning *safe to charge again* — is **recomputed from the canonical catalog** and the
  payload's own block is discarded. Otherwise whoever produced the payload gets a direct vote on
  whether the merchant charges the customer twice.
- The Express adapter caps the **unauthenticated** body at 1 MiB. The bytes must be buffered before
  the signature can be checked, so the cap is the only thing bounding what an anonymous caller can
  make the process allocate.

### 6. Double-charge through idempotency mishandling

- `collect()`, `collectAndWait()`, `simulate.collect()` and `simulate.pay()` **require** a
  caller-persisted `idempotencyKey`. A key the SDK generates for you is not idempotency: it is a
  different value on every invocation, so it collapses nothing, and a double-clicked Pay button, a
  refreshed tab, a redelivered queue job or a process restart each raise a separate charge. Mint
  one key per payment *attempt* and persist it before calling. The unsafe path exists
  (`unsafeGeneratedIdempotencyKey: true`), is named accordingly, and warns on **every** call — via
  `console.warn`, which `--no-warnings` cannot silence and which does not de-duplicate.
- `Idempotency-Key` is validated at the boundary: non-blank, printable ASCII without spaces, no
  control or zero-width characters, 255 bytes max. A key that is silently re-encoded or trimmed in
  transit stops matching the stored attempt, which removes the guard entirely.
- `retryable` means **safe to charge again** — that no money moved and nothing is in flight. It does
  *not* mean "the user may press a button". A pending or indeterminate payment is **never**
  retryable.
- A `409` **indeterminate** is a stop signal, not a retry signal, and is never retried automatically.
- Every failure escaping a money-moving call carries the **idempotency key and the payment id** —
  including thrown primitives, non-`Error` objects and frozen errors. The key lets a caller replay
  the same attempt; the id lets them read it. Without both, the natural recovery is to mint a fresh
  key, which is a second charge.

### 7. Accidental credential disclosure

Into logs, stack traces, error messages, serialized output, or telemetry a normal application would
plausibly emit:

- The API key and webhook secret are scrubbed from every message the SDK throws.
- `PaylodApiError.body` is **deeply** redacted — strings and object keys, at every level. Past the
  depth limit the subtree is dropped, not passed through: a guard against stack overflow must not
  become the hole that leaks the credential.
- Lower-level transport exceptions are **not** attached as `cause`. Every error reporter walks
  `cause`, and an undici exception routinely carries the request it failed on, headers included. A
  sanitised error that drags its unsanitised source along is not sanitised.
- Webhook adapters never echo a handler's exception message into the HTTP response, which would make
  the endpoint an information-disclosure oracle anyone could probe.
- The key never crosses a replaceable boundary in normal operation: callers pass a method, a path and
  a body, and the transport adds the credential from a private field.

---

## Out of scope

### An adversary who can already execute arbitrary code in the same process

**This is the important one, and it is stated plainly rather than hedged.**

If an attacker can run code inside your process, they have already won, and no in-process client
library can change that. They can read process memory, monkey-patch the runtime, replace built-ins,
hook the module loader, or dump the heap. The credential must exist in memory to be sent at all.

Concretely, and this was found by review rather than assumed: **replacing `globalThis.fetch` before
the client is constructed still results in a live bearer token reaching the replacement.** The
transport captures `globalThis.fetch` at construction time and binds it, so a *later* reassignment
cannot defeat it — but an *earlier* one is simply the `fetch` the SDK finds, and it receives the
`Authorization` header on every request.

That is an accepted limit of this model, not a bug with a pending fix. **The transport is not a
security boundary against same-process code, and this document does not claim it is.** The
`allowCustomFetch` gate and the `mp_live_` refusal are guard rails against *misconfiguration* — a
developer wiring a proxy or an instrumentation wrapper into a production credential path — not
defences against an attacker who already has code execution.

This is not a paylod-specific limitation. It is equally true of `stripe-node`, `twilio` and
`aws-sdk`, none of which defend against same-process adversaries either, and none of which claim to.

### Host compromise

If the machine, container, or CI runner is compromised, the attacker can read environment variables,
config files, secret-manager caches and process memory directly. Nothing the SDK does is relevant at
that point.

### Malicious dependencies already in the module graph

A hostile or compromised package in your dependency tree runs with full in-process privileges before
your code does. It can patch the runtime, intercept module resolution, and observe anything. This is
the same-process case above, arriving through your supply chain rather than through a bug.

Mitigate it where it is actually mitigable — lockfiles, integrity hashes, `npm audit`, provenance
checks, minimal dependency count. `@paylod/node` has **zero runtime dependencies**, which reduces
the surface it contributes to yours but says nothing about the rest of your graph.

---

## What "indeterminate" means, and why so much resolves to it

An indeterminate payment is not an SDK failure mode. It is a real, expected state of a real payment,
and treating it as anything else loses money in one of two directions:

- Reporting it as **paid** ships goods for a payment that never settled.
- Reporting it as a **retryable failure** charges the customer a second time.

So when the SDK cannot prove which way a payment went, it says exactly that: never `paid`, never
`retryable`, surfaced as pending so polling continues and the webhook settles it. Every ambiguity in
this document resolves that way, deliberately.
