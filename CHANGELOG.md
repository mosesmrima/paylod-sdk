# Changelog

All notable changes to `@paylod/node` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 0.13.1

Catalog resync plus two catalog-wide guards. No API change.

### Fixed

- **`500.001.1001` on the `api_error` surface no longer invites a retry.** It previously read
  "M-Pesa returned an error. Please try again in a moment."; it now reads "M-Pesa returned an
  error and we cannot confirm the outcome. Do not pay again yet. Check your M-Pesa messages
  first."

  That code is overloaded. Its `stk_result` twin means the payment is still in flight, and the
  `api_error` entry is returned when M-Pesa errored *after* dispatch -- the outcome is unconfirmed
  and the debit may already have happened. Inviting a retry there is how a customer pays twice.
  The entry stays `retryable: false`; only the customer-facing wording changed.

  The vendored `src/daraja-error-codes.json` was resynced from the canonical catalog via
  `npm run check-catalog`, and is byte-identical to it.

### Added

- **A duplicate-code guard.** `(code, family)` is the catalog's real key -- `code` alone is
  ambiguous, because `0`, `2001` and `500.001.1001` each appear in two families with different
  categories and, for `2001`, different retryability. The guard asserts every `(code, family)`
  pair is unique, and asserts the bare-code collisions still exist, so it cannot pass by
  inspecting a deduplicated set.

  It also pins the collision behaviour of `ERROR_CATALOG`, the public export keyed on bare `code`:
  STK wins, because STK is the payment path. That is unchanged behaviour, now documented by a
  test rather than only by a comment.

- **A catalog-wide "no non-retryable entry invites another payment attempt" invariant**, matching
  the JVM SDK. Scoped to non-retryable entries in categories `pending` and `mpesa_system` -- the
  ones where a debit may already have occurred. `credentials` and `customer` failures are refused
  before dispatch, so no money moved and "fix it and try again" is correct there.

  The detector is negation-aware: a flat substring match on "again" cannot tell an invitation
  ("Please try again in a moment.") from a prohibition ("Do not pay again yet."), and the
  lookbehind is clamped to the current sentence so a prohibition cannot launder an invitation in
  the sentence after it. It is proved non-vacuous by a discrimination test that feeds it the
  pre-fix text and requires a flag, and the post-fix text and requires none.

## 0.13.0

The tenth independent review, and the first round worked against
[`docs/SDK-CONFORMANCE.md`](https://github.com/mosesmrima/paylod-sdk) rather than against a
findings list.

That change of unit is the point of this release. Ten rounds produced 95 findings across the
four paylod SDKs, and the dominant failure was never that a bug was hard to fix -- it was that a
fix landing in one SDK never reached the other three. PHP closed the
redaction-placeholder-as-receipt defect in round 9; round 10 found the identical defect still
open in Node, Python and JVM. So the unit of work is now a shared specification, every
requirement of which must hold and must have a non-vacuous test.

### Breaking changes

- **A receipt is now validated against a positive grammar: ten uppercase alphanumerics.**
  Previously ANY nonblank string was settlement evidence, so `{"status":"success",
  "mpesaReceipt":"[redacted]"}` with no result code was reported PAID. A credential echoed into
  the receipt field, redacted by something upstream, left a placeholder that `hasReceipt` read as
  proof of payment -- the sanitizer manufactured settlement out of a leak, which is strictly worse
  than the leak. The grammar is derived from every real receipt in the paylod fixtures and is
  shared with the sibling SDKs. It is a grammar and not a blocklist on purpose: `***`, `<hidden>`
  and whatever the next sanitizer emits all fail it for free.

  A `mpesaReceipt` that is present but not a valid receipt is now a refused body rather than a
  silently nulled field.

- **Server-issued identifiers get a positive grammar too.** `paymentId`, `checkoutRequestId` and
  `applicationId` were non-emptiness checks on both the status and the signed-webhook path, so a
  placeholder was returned to callers as an identifier -- one that correlates nothing, and that
  every other redacted payment in the system also carries.

- **A caller-supplied idempotency key that looks like sanitizer output is refused.** The hazard is
  a key read back out of your own redacted logs: every redacted attempt shares one key, so two
  payments collapse into one (a charge silently never made) or a retry replays against the wrong
  attempt.

- **An uncatalogued result code no longer resolves to a terminal failure.** A canonically-shaped
  code the catalog has never heard of -- `77777` -- produced verdict `failed`, ending the wait on
  a payment whose state nobody had established. The classifier is right to call that shape
  `failed`, because it judges SHAPE; but what a record PROVES is a different question, and an
  unrecognised code proves nothing. There is now a distinct `unknown` evidence kind resolving to
  indeterminate under every claim. The verdict table is 3 x 6 = 18 cells.

- **Duplicate money-critical members are refused.** `{"resultCode":1032,"resultCode":-0}` was
  accepted; each spelling is individually canonical, so only a duplicate rule catches it. Which
  copy a parser keeps is a parser detail, and no money verdict should depend on this SDK and the
  sender answering that question the same way. Scoped per object, so the same name in two
  different objects is still legal.

- **Invalid UTF-8 is refused, never normalised.** Both the transport and the webhook path decoded
  with replacement semantics, so two different wire payment ids differing only in invalid bytes
  collapsed into one identical string and a correlation that should have failed succeeded against
  the wrong payment. On the webhook path the strict decode runs AFTER the raw-byte HMAC, so
  verification is unweakened.

### Fixed

- **The numeric-lexeme refusal no longer reproduces server bytes.** It interpolated up to 32 raw
  characters, and the scan that produces them runs to a terminator the other side chooses -- so a
  credential shorter than the bound appeared verbatim in the message, its stack, and the webhook
  adapter's 400 response. It now names the SHAPE ("a fractional form"), computed locally.

- **Credential SHAPES are redacted, not only configured values.** The redactor matched
  `apiKey`/`webhookSecret` by exact string, so it could only ever protect against leaking your own
  key: a rotated-out credential, a sibling service's key returned by a shared proxy, or an echoed
  `Bearer` header passed through untouched. `mp_live_`, `mp_test_`, `whsec_`, `sk_` and `Bearer`
  are now scrubbed whether or not they are configured.

- **The public offline decoder redacts for itself.** `decodeDarajaResult` never touches the
  network and is documented for logs and dashboards, so it had no redaction at all -- while
  interpolating `resultDesc`, the field most likely to carry an echoed `Authorization` header. It
  is now exported from a wrapper this SDK owns; the generated catalog file stays byte-identical to
  the payment engine's copy.

- **A refused collect acknowledgement keeps the payment id.** A malformed 202 discarded a
  perfectly well-formed `paymentId`, leaving the caller told to "read the payment" with no handle
  to read it by. It is salvaged under the same rules that would let it be returned: grammar first,
  credential scan second.

- **The signature header is length-bounded before it is split.** The body has been capped since
  0.9.0; the header was the same unauthenticated input through the same anonymous request, and a
  multi-megabyte value was tokenised into millions of segments before a byte was known to be
  genuine.

- **`t=01700000000` is refused.** The documented format is non-padded, and `t` is HMAC input, so a
  padded spelling is one extra signed spelling of the same instant.

- **Customer messages for codes 17, 26, 1025 and 9999 no longer invite a retry.** These carry
  `retryable: false` -- they do not prove no debit occurred -- while their copy said "Please try
  again". The canonical catalog had already been corrected; this SDK's vendored copy was stale and
  nothing had propagated it, which is exactly the failure the specification exists to prevent.

### Verification

- The adversarial sweep now DEMANDS a declared outcome class per case (it previously accepted "a
  result or any clean exception", so cases passed even if the successful path were removed) and
  SELF-CHECKS that every public type was constructed.
- The every-call idempotency warning is now proven against the BUILT artifact, in a separate
  process, with the build run as part of the test -- it previously read a stale `dist/`.
- Source files are checked for raw control bytes, after a NUL in a test file made the whole file
  invisible to `grep`.
- 16 new non-vacuity cases, four of them CONTROL-DIRECTION mutations that catch over-correction
  rather than removal. Ten pre-existing cases were found to have stopped measuring anything and
  were repaired.

## 0.12.0

The ninth independent review. One Critical, one High, five Mediums and one Low.

The theme of this round is that **two bounds which disagree are a bypass with a number for a
lock**, and that the shallower one deciding "clean" is how the lock opens.

### Breaking changes

- **Every structural traversal now derives its depth budget from one constant, and every one of
  them fails CLOSED.** `containsSecret` — the scan that refuses a body carrying your own API key
  or webhook secret — stopped at depth 8 and returned "no secret here", while the bounded parser
  admits documents 64 levels deep. The gap between those two numbers was a credential-smuggling
  channel: a correctly-signed webhook body with the credential at depth 9 walked straight past the
  refusal, `verifyWebhookSignature` returned it raw, and the typed path silently stripped it
  during allowlist reconstruction and delivered the event as valid — so the two public entry
  points to one channel disagreed about whether to refuse.

  The fix is structural, not a larger number. The traversal budget IS `MAX_JSON_DEPTH`, imported
  from the parser that produced the value, so anything the parser accepted the scan can reach the
  bottom of by construction and the two limits cannot drift apart. Past the budget the answer is
  REFUSE, because "I did not look" and "I looked and it is clean" must never be the same answer
  when every caller reads the second one as permission to hand the value to your application.
  `PaylodApiError.body` redaction now uses the same constant.

- **A dotted result code must have at least two dots.** `CANONICAL_DOTTED_RE` accepted one-dot
  lexemes, so `"500.0"` validated as a CANONICAL code — the only classification that can be
  confident terminal failure evidence. Paired with terminal-500 prose ("wrong credentials") it
  became genuine failure evidence, which is exactly what a `payment.failed` webhook must carry to
  be accepted, so an otherwise-valid forged failure event was admitted on a spelling rather than a
  code. Every real Daraja dotted code has three components, and all nine in the shipped catalog
  still validate. This was the third sighting of one root across the paylod SDKs.

  `"500.0"` and friends now classify as `pending`, decode as `unknown`, never resolve to a
  terminal failure, and are refused by webhook verification.

- **Request bodies are serialised under the same depth budget the reader uses**, with cycle
  detection and a 256 KiB cap, all enforced before `JSON.stringify` is allowed to recurse. Refused
  as `PaylodInvalidRequestError`, whose defining property is that NOTHING was dispatched.

- **`bodyReadTimeoutMs` must be a whole number between 1 and 60000.** It was accepted as any
  finite positive number and then floored, so `0.5` became a zero deadline that refuses every
  legitimate delivery. Validated now, not repaired.

- **The simulator defaults only on `undefined`.** `phone: null`, `phone: ""` and other falsy
  runtime values were silently replaced with the default handset and dispatched, certifying that
  production accepts values production rejects. They are now refused before any request goes out.

### Fixed

- The no-stream Web `Request` body fallback awaited an unbounded `arrayBuffer()` with no byte
  bound and outside the body-read deadline. It now fails closed without a usable `Content-Length`
  and races the read against the same deadline the streaming path uses.
- Configured credentials no longer survive into base-URL configuration refusals. `safeUrl`
  stripped userinfo but reproduced everything else verbatim, so an API key or webhook secret that
  reached `baseUrl` by any other route landed in an ordinary `PaylodConfigError` message.
- The non-canonical-lexeme refusal reproduced an unbounded, server-chosen lexeme in its message.
  Bounded to 32 characters.
- `simulate.outcome()` no longer coerces a malformed `webhookQueued` to `true`, which told callers
  to wait for a reconciliation event that would never arrive.

### Testing

- A permanent adversarial sweep constructs every public object and every public error from a
  hostile server response echoing both configured credentials in every string field at five
  depths, and asserts neither appears in any serialization, message, `cause`, or nested field —
  covering the class rather than its instances. It found the base-URL webhook-secret leak above.
- 99 reverted-protection cases in `scripts/non-vacuity.mjs`, all caught. The Critical is certified
  by seven independent mutations, including the cutoff itself, the fail-closed direction, and both
  webhook entry points.

## 0.11.0

The eighth independent review. Ten findings, four of them High, plus four cross-SDK roots checked
in Node because each had already turned up in two or more sibling SDKs wearing different clothes.

The theme of this round is that a guarantee can be true of a VALUE and false of its SPELLING, and
true at the TOP LEVEL and false one field down.

### Breaking changes

- **A `resultCode` spelt as a non-canonical JSON number is refused, not parsed.** `JSON.parse`
  maps `0.0`, `0e999`, `-0`, `1032.0` and `1.032e3` onto the same doubles as `0` and `1032`, so a
  response body could declare itself PAID, or declare a cancellation RETRYABLE, in a spelling that
  no strictness check downstream could still see — by the time `canonicalCodeForm` holds a
  `number`, the spelling it was written in no longer exists. The check therefore moved to the
  text, in a new bounded parser both the API path and the signed webhook path share. Member names
  are escape-decoded before matching (`"\u0072esultCode"` is the same member to every JSON parser,
  and a raw-bytes key search walks straight past it — that is exactly how the PHP sibling was
  bypassed), and every duplicate occurrence is checked rather than only the parser's winner.

  paylod does not emit these spellings. If you see this error, something between you and paylod is
  rewriting bodies. The error says INDETERMINATE and carries the guidance to read the payment.

- **A correctly-signed webhook body containing one of your own credentials is refused, not
  stripped.** Previously an unknown field carrying the API key was silently dropped during
  reconstruction. Dropping it is not enough: `verifyWebhookSignature` hands back the raw parsed
  body, and the schema diagnostics quote field values into messages that land in 400 responses and
  logs. A signed body containing our credential is evidence that something upstream is echoing it,
  and the honest response is to stop.

- **`detail.retryable` is `false` on every verdict except a proven terminal failure.** If you were
  reading the nested flag rather than the top-level one, you were reading a field that could say
  "another charge is safe" about a payment we could not prove anything about.

### Fixed

- **Nested `retryable` contradicted the top-level one (High).** The decoded block was resolved
  before the verdict and spread into every branch, so an indeterminate payment came back with
  `retryable: false` beside `detail.retryable: true`. Both are public, both answer the same
  question, and they answered it differently. The block is now resolved after the verdict. The
  same defect shipped in the JVM and Python SDKs.

- **The webhook verifier scanned the signing secret and not the API key (High).** The class
  wrapper — the path essentially every integration takes — never passed the key in, so the
  credential that moves money was the one a signed body could echo into a handler's logs. The scan
  now runs on the parsed body before the first schema diagnostic can quote a field value, covers
  every credential the client holds, and guards the signature-only helper as well.

- **The reconciliation envelope could be thrown out of (High).** `instanceof` is a call, not an
  inspection: it invokes a `Proxy`'s `getPrototypeOf` trap, which is attacker-controlled code and
  can throw. A hostile throwable blew up on the wrapper's first statement and escaped carrying
  neither the idempotency key nor the payment id — the failure mode most likely to involve a
  hostile value was the one that stripped the recovery information. The check is guarded, the
  redactor is guarded, and the wrapper as a whole is now non-throwing with an unconditional
  fallback that carries both handles.

- **The simulator ran an identity redactor and no credential scan (Medium).** Its two projectors
  called the shared validators without production's `secrets` and redactors, and its error
  envelopes redacted nothing — so the surface every integrator's test suite runs against was the
  one surface a leaked bearer key survived. It now receives production's guards. The outcome menu
  is rebuilt from an exact allowlist instead of cast.

- **Webhook body reads had a byte cap and no deadline (Medium).** A request dribbling one byte a
  minute stays under 1 MiB essentially forever. Both adapters now bound the read with a
  configurable `bodyReadTimeoutMs` (10s default, 60s ceiling, cannot be disabled) and cancel or
  destroy the source on expiry rather than abandoning it.

- **A contradictory 409 was retried (Medium).** The "already in progress" and "interrupted while
  the provider call was" patterns are not disjoint, and a message carrying both was retried — the
  SDK dispatched a charge a second time against a key whose first attempt may already have taken
  the customer's money. Indeterminate now takes precedence, in the retry decision and in the
  public `isIdempotencyInProgress` getter, which had the same overlap.

- **Signed webhook JSON bypassed the parse-depth budget (Low).** A valid signature proves who sent
  the bytes, not that the bytes are safe to parse.

- **Resolved `onPoll` races left abort listeners attached (Low).** `{ once: true }` only removes a
  listener that fired; the common case is the race resolving, so listeners accumulated on the
  caller's reusable signal across every poll of a `wait()`.

### Testing

- **The mutation harness certified less than it appeared to (Low).** vitest's `-t` is a REGEX, so
  a test name containing `()` silently selected ZERO tests while the runner exited 0 — which reads
  as a live selector. Selectors are now escaped, one case was pointed at a genuinely
  discriminating test instead of one that passed either way, and one was repointed so it can
  produce a verdict at all rather than only `HARNESS-ERROR`. Sixteen round-8 cases were added, and
  the harness now runs in CI, in the release workflow and in `prepublishOnly` — a certification
  nothing gates is documentation.

- **A decompression bomb is proven refused.** The Python sibling applied its response cap after
  automatic decompression, turning 9 KB of gzip into 9 MB of heap. Node's cap is enforced chunk by
  chunk on the decompressed stream, and the test runs against a real HTTP server and the real
  global `fetch` — a hand-constructed `Response` is not decompressed by undici and would have
  proven nothing.

## 0.10.0

**Breaking, and the reason for the version bump.** One finding, rated High by the independent
reviewer against the Python SDK and confirmed here: the SDK generated an idempotency key when the
caller omitted one. This release removes that behaviour on every surface that can move money.

### Breaking changes

- **`idempotencyKey` is now REQUIRED on `collect()`, `collectAndWait()`, `simulate.collect()` and
  `simulate.pay()`.** Omitting it is a TypeScript compile error and a runtime
  `PaylodInvalidRequestError`, thrown before a single byte leaves the process — no request is
  dispatched, no phone number is normalized.

  A GENERATED KEY IS NOT IDEMPOTENCY. It is a fresh value on every invocation, so it collapses
  exactly nothing: a double-clicked Pay button, a refreshed tab, a redelivered queue job and a
  process restart mid-request each minted a NEW key and each raised a SEPARATE charge — a second
  STK prompt on a real customer's phone. Application-level and job-queue retry is explicitly in
  this SDK's threat model, and it is precisely what a per-call generated key cannot survive: the
  caller is the only party that knows a retry is a retry.

  The old posture compounded it. The protection was OFF by default and the warning was emitted
  once per process, so a worker that handled a thousand unprotected charges warned about the first
  one and stayed silent for the other 999 — and a charge fired inside a loop or a job handler is
  exactly the scenario the warning existed to flag.

  **Migration.** Mint one id per payment attempt — where the attempt begins, and persisted — and
  pass it. `tsc` finds every call site for you:

  ```diff
  - const ack = await paylod.collect({ amount, phone });
  + const attempt = await db.attempts.create({ orderId: order.id });
  + const ack = await paylod.collect({ amount, phone, idempotencyKey: attempt.id });
  ```

  In tests any stable literal works (`idempotencyKey: "t-1"`). Do NOT reach for
  `crypto.randomUUID()` at the call site: it satisfies the type and the runtime check while
  providing zero protection, which is the same bug wearing a disguise.

- **`CollectParams` and `SimulateCollectParams` are now type aliases**, not interfaces —
  `CollectParamsBase`/`SimulateCollectParamsBase` intersected with the new `IdempotencyParams`
  union. All three are exported. Code that wrote `interface X extends CollectParams` must switch
  to an intersection; ordinary callers are unaffected.

- **`simulate.collect()` now requires its params argument.** `paylod.simulate.collect()` with no
  arguments no longer compiles, because there is no key to pass in it.

### The escape hatch

`unsafeGeneratedIdempotencyKey: true` opts out and lets the SDK mint a throwaway key. Named to
match the PHP SDK's `unsafeGeneratedIdempotencyKey` and the Python SDK's
`unsafe_generated_idempotency_key` — the reference behaviour all four SDKs are converging on.

It **warns on EVERY call**, never once per process and never once per call site. That detail is
load-bearing: Python's default warning filter is "once per code location", which silently
deduplicated the warning for charges fired inside a loop. Node has an equivalent trap in
`process.emitWarning` — routed through the warning machinery, it is silenced wholesale by
`--no-warnings` / `NODE_OPTIONS=--no-warnings` and de-duplicated by code on the deprecation path —
so the warning is emitted with `console.warn`, which has no dedup and no global mute switch.
Verified empirically against the built artifact: 50 opt-out calls from one call site in one
process on one client produce 50 warnings and 50 distinct keys.

The opt-out fails CLOSED on anything that is not literally `true`: `unsafeGeneratedIdempotencyKey:
"false"` — what reading an environment variable gives you — throws rather than quietly opening the
unsafe path.

### Non-vacuity

Five new mutations, all CAUGHT (48/48 for the suite as a whole): the required-key guard reverted on
`collect()` and on `collectAndWait()` separately, the opt-out made to fail open on a truthy value,
the simulator's collect made laxer than production, and the every-call warning reverted to
once-per-process.

Two of the new selectors initially matched ZERO tests — `-t` is a regex, so `collect()` is
`collect` plus an empty group and the literal parentheses never match. The harness's liveness check
caught it, which is exactly what it is for.

## 0.9.0

Sixth independent review, conducted against the threat model in `SECURITY.md`. One Critical, three
High and two Medium, plus a re-verification of the sibling findings from round 5.

The theme of the round is **ORDERING**. Every previous round answered a finding by adding a stricter
predicate. This round is about the layer BENEATH the predicate quietly repairing its input first, so
the strict check was handed a laundered impostor and answered — correctly — about the wrong value.

Signing is unchanged — the shared golden webhook vector (`whsec_golden_vector_v1` →
`3afe38e4…2c2eb7`) still passes byte for byte, and its literals are untouched.

### Critical

- **Result codes are assessed by exact type and exact bytes; normalization no longer runs before
  validation.** `normalizeCode` did `String(resultCode).trim()`, which maps the number `-0` and the
  strings `" 0"`, `"0 "`, `"\t0\t"` and `"\n0\n"` onto the canonical `"0"`. The strict `raw === "0"`
  success check added in 0.8.0 was therefore never reached by an impostor — it was handed a value
  that had already been repaired into the genuine article. Whoever controls the response body
  controls those bytes, so the SDK shipped a "declare yourself paid" primitive sitting one layer
  beneath the check written to stop exactly that.

  The same laundering ran in the failure direction and cost the same money: `" 1032"` trimmed to
  `"1032"`, whose catalog entry is `retryable: true` (cancelled by the customer). A padded code
  became a confident, RETRYABLE terminal failure — an instruction to charge again — for a payment
  whose real state nobody knew.

  `canonicalCodeForm` now preserves the original type and bytes and classifies the FORM first:
  a number must be a non-negative safe integer and is tested with `Object.is(x, -0)` **before**
  anything stringifies it (`-0 === 0` is true and `String(-0)` is `"0"`, so no check written
  against either could ever have seen it); a string must match a canonical Daraja spelling exactly
  as it arrived, with no trimming. An ambiguous code is **never** success and **never** a confident
  terminal failure — the classifier returns `pending` (which ships nothing and invites no retry,
  and is never `retryable`) and the decoder returns a new explicitly indeterminate block rather
  than the catalog hit normalization used to manufacture.

### High

- **The Web `Request` webhook adapter no longer buffers an unauthenticated body without a limit.**
  It called `await request.text()` before any signature check — all-or-nothing and unbounded — so
  an anonymous remote caller who could reach the route could stream gigabytes into the heap and OOM
  the process before a single check ran. The body is now read incrementally under
  `MAX_WEBHOOK_BODY_BYTES` and the producer is cancelled the moment the budget is gone. The cap is
  also applied to every PRE-BUFFERED form on the Express path (`req.body`, `req.rawBody`, Buffer and
  string alike) — those branches returned unconditionally, so the advertised limit only ever bound
  the one path where this SDK did the reading, and any deployment using `express.raw({ limit: … })`
  or a Vercel/Firebase `rawBody` got no cap at all. An oversized `Content-Length` is refused before
  the stream is touched, while the actual bytes are still counted regardless.

- **Attacker-controlled response values no longer reach exception messages.** The malformed-2xx
  validators quoted the offending value back for diagnostic value. A response whose `status` field,
  or whose mismatched `id`, was set to the bearer key put that key verbatim into the exception
  message and its stack — logged, shipped to an error reporter, rendered in a dashboard. The `body`
  field on the error was carefully deep-redacted; the message beside it was not, so the redaction
  protected the field nobody reads and missed the one everybody does. Every interpolated value now
  goes through one `sanitizeForMessage` (JSON-rendered so a hostile `toString` cannot run,
  truncated, then passed through the same key/secret redactor the body gets).

- **An already-aborted `AbortSignal` stops the dispatch instead of merely being subscribed to.**
  The abort was wired up only via `addEventListener("abort", …)`, which fires only for an abort
  that happens LATER — a signal already aborted on arrival raised no event, so nothing linked it to
  the inner controller and the request went out anyway. Against `POST /collect` the caller had
  cancelled and the SDK charged the customer regardless, returning an acknowledgement that looked
  like an ordinary success. Now checked before the controller and before `fetch`, so the guarantee
  is "no request was dispatched" rather than "a request was dispatched and then abandoned".

### Medium

- **The webhook event schema is enforced completely.** `amount` was checked only for finiteness, so
  `-100`, `100.5` and `1e15` all reached a handler typed as a plain `number`; it must now be a whole
  number of KES between 1 and 150,000, matching the client-side charge limit. `applicationId`, `env`
  and `phone` were treated as optional and then cast into a `WebhookEvent` that types them as
  required — so a handler routing on `applicationId`, or refusing sandbox events with an `env`
  check, was reading `undefined` through a type that promised a string. All three are now required
  and non-blank.

- **`resultDesc` is validated on a status read.** It was the one field on the record nothing
  checked, and it is not inert — the classifier reads it as a corroborating signal. An
  object-valued `resultDesc` passed the validator, reached `classifyStkResult`, and threw a raw
  `TypeError` out of `.trim()`, so `check()` and `wait()` died with an internal stack trace instead
  of raising the indeterminate-response error callers know how to handle. A crash is not a safe
  failure here: it happens after a charge may already be live, and no `catch (e instanceof
  PaylodError)` recovers from it. The classifier is independently hardened to treat a non-string
  description as no signal rather than as a fault.

### Sibling findings — re-verified, not assumed

- The webhook `decoded` block was already rebuilt entirely from the canonical catalog (0.8.0), and
  a `payment.failed` whose data assesses as pending/indeterminate was already rejected. Both
  confirmed still holding, with tests.
- **One gap remained**: a MISSING `decoded` block was mirrored as `null` rather than synthesised.
  Omitting the block from a `payment.failed` produced `decoded: null`, and every handler rendering
  `decoded.customerMessage` or gating a retry on `decoded.retryable` hit a null it was typed to
  believe could not be there — the same defect as a block that lies, reached by omission instead of
  assertion. The block's presence is now derived from the event type: `payment.failed` always
  carries one, synthesised from the catalog; `payment.success` never does.

### Non-vacuity

`scripts/non-vacuity.mjs` grew 13 new cases (43 total, all CAUGHT). The harness itself was fixed:
multiple edits to the SAME file now compose in memory instead of the second silently overwriting
the first, which is the one way a multi-part mutation could degrade into a single-part one — and
therefore into exactly the vacuous result the harness exists to detect. `D2-coerce` became such a
case: the round-6 ordering gate stops a non-canonical code reaching the strict predicate at all, so
reverting the predicate alone is now a no-op, and the mutation must remove BOTH.

## 0.8.0

Fifth independent review. The review of THIS repo was cut off by a content filter before it emitted
its findings list, so unlike the sibling SDKs there was no itemised set to work from. The sibling
reviews did complete, and since all four SDKs share one design, every defect they found was treated
as a candidate here and re-derived against this code rather than assumed absent. That posture is not
paranoia: Node was assumed clean in an earlier round and turned out to fail 8 of 8 equivalent checks.

Six of the sibling defects were present. Three were genuinely absent, with evidence.

Signing is unchanged — the shared golden webhook vector (`whsec_golden_vector_v1` →
`3afe38e4…2c2eb7`) still passes byte for byte, and its literals are untouched.

### Present, and fixed

- **The (claim x evidence) resolution is now a total mapped table**, not a nested `switch` with a
  reachable tail. Verdicts are unchanged; the structure is what changed. Python "fixed" this exact
  shape in a previous round and STILL let `pending` + result code 0 resolve to PAID, because the fix
  was another branch rather than a structure that cannot have a gap. Omitting a cell is now a compile
  error, and the full 3 x 5 cross-product is asserted so a wrong cell fails rather than defaulting.

- **Success evidence is recognised by exact form, never by numeric coercion.** `Number(raw) === 0`
  accepted `"0e999"`, `"+0"`, `"00"`, `"0.0"`, `"-0"` and `"0x0"` as result-code zero — six spellings
  of "declare yourself paid" available to anyone who controls the response body. PHP shipped exactly
  this. Fixed in the **canonical monorepo classifier** and re-synced here, since the backend shares
  it. A non-canonical code is now ambiguous (`pending`), never force-failed.

- **Credential-compromise detections are terminal by type.** New `PaylodSecurityError` extends
  `PaylodConnectionError`, so existing catches keep working, and the retry loop re-throws it
  structurally. It previously depended on a **regex over the error message** — a credential-critical
  control resting on prose, which any rewording would silently disable. The JVM SDK's version was
  worse: it raised these as ordinary connection errors and its retry loop replayed a credential it
  had just concluded was leaking.

- **`data.decoded` on a webhook is recomputed from the canonical catalog.** It carries `retryable`,
  the one boolean meaning SAFE TO CHARGE AGAIN, so passing it through gave whoever produced the
  payload a direct vote on double-charging — a block claiming `retryable: true` beside code 4999 is
  an instruction to charge a customer whose prompt is still live. The JVM SDK trusted this block. A
  signature proves who sent a body, not that its opinions are true.

- **Every throw escaping after an acknowledgement carries the payment id as well as the idempotency
  key** — including thrown primitives, non-`Error` objects and frozen errors. The key lets a caller
  replay the attempt; the id lets them read it. The JVM SDK lost both on a non-`Exception` throw.

- **Response bodies are bounded in bytes and in JSON depth**, both converted into a terminal
  indeterminate error carrying the key. The per-request timeout bounded how LONG a response could
  take; nothing bounded how BIG. The two are independent — a body that streams fast and never ends
  stays inside the timeout all the way to an OOM, and dying after `POST /collect` loses the
  idempotency key for a charge that may be live on a handset.

- **`toleranceSec` gains a documented upper bound** (`MAX_TOLERANCE_SEC`, 24h). A positive-integer
  check passes `86_400_000`, at which point every captured webhook stays valid for three thousand
  years while the check still reads as enabled. That is worse than no check, because it looks like
  one.

### Genuinely absent, with evidence

- **A signed `payment.success` with no evidence was already rejected** (law L2), and the `W-schema`
  non-vacuity case has proven it since 0.7.0 by reverting the guard and requiring the test to fail.
  Python accepted this; Node did not.
- **Deadlines were already monotonic** (`monotonicNowMs`, `performance.now()`), and timeouts and
  retry counts already had finite whole positive bounds with maxima (`MAX_TIMEOUT_MS`,
  `MAX_RETRIES`).
- **The `Retry-After` ceiling was already applied only in the absence of a deadline** — a deadline,
  being the tighter caller-chosen bound, already won inside `#boundedSleep`.

### SECURITY.md

Adds an explicit threat model, identical in substance across the paylod SDKs. It is deliberately
specific about what is NOT defended: an adversary who can already execute arbitrary code in the same
process. In particular it documents, plainly, that **replacing `globalThis.fetch` before the client
is constructed still results in a live bearer token reaching the replacement** — an accepted limit of
the model, not a bug with a pending fix, and equally true of `stripe-node`, `twilio` and `aws-sdk`.
The transport is not a security boundary against same-process code and the document does not claim it
is. Two tests pin that statement so the docs cannot quietly drift into overstating the guarantee.

### Non-vacuity

Ten new harness cases; **29/29 mutations caught**, every selector proven to match at least one test
on clean source. The harness caught two tests of my own that were vacuous — the frozen-error case
threw from `fetch`, where `#request` re-wraps before the normaliser ever sees the value, and the
byte-cap case used a body that the ack validator rejected either way. Both were rewritten to
exercise the path they claim to. Two pre-existing 0.7.0 anchors were reported `BROKEN-ANCHOR` after
`semantics.ts` became a table and are re-pointed at the corresponding cells.

## 0.7.0 — BREAKING

Fourth-round codex review returned **NOT SAFE TO PUBLISH**. Four earlier rounds of per-finding
patching had not converged, for a reason worth stating plainly: the findings were symptoms, and
nobody had fixed the two structures generating them. This release changes the design rather than
the symptoms.

Signing is unchanged — the shared golden webhook vector (`whsec_golden_vector_v1` →
`3afe38e4…2c2eb7`) still passes byte for byte, and its literals are untouched.

### ROOT 1 — credentialed dispatch cannot be replaced

The API key is a bearer credential. It used to be handed to a caller-supplied `fetch`, which was
then policed after the fact: the SDK set `redirect: "manual"` and inspected the response for a
3xx. That is not a control. An injected `fetch` can ignore `redirect: "manual"`, follow a
cross-origin 302 itself, and return an ordinary `200` — and by the time the SDK inspects that
response, the Authorization header has already been replayed to another host.

- **New `Transport` owns the credential.** Callers pass a method, a path and a body. They never
  see the key, never construct headers, and so have no way to address it anywhere.
- **`options.fetch` is now a gated test seam.** It requires `allowCustomFetch: true` **and is
  refused outright for `mp_live_` keys** — the posture `allowInsecureBaseUrl` already had.
- **Origin pinned per dispatch**, not once at construction.
- **Redirects refused four independent ways**: `opaqueredirect`, a 3xx status, `res.redirected`
  (the implementation followed one despite `manual` — detection, with a message telling you to
  rotate the key), and an off-origin `res.url`.

**Migration:** `new Paylod(key, { fetch })` → `new Paylod(key, { fetch, allowCustomFetch: true })`,
and only with an `mp_test_` key.

### ROOT 2 — one semantic model, in `semantics.ts`

Validators checked SHAPE. Every defect below involves a perfectly well-typed body, so shape
validation could not see any of them. A payment record now makes one CLAIM (`status`) and carries
EVIDENCE (`mpesaReceipt`, `resultCode`), and the two are never allowed to substitute for one
another. Four laws, which the sibling PHP/Python/JVM SDKs mirror:

- **L1 BINDING** — a returned payment id that is not the id requested is a hard error.
- **L2 EVIDENCE** — `paid` requires a receipt **or** result code 0. Success *without* a receipt
  stays legitimate: receipts attach asynchronously, so evidence of one kind is required, never a
  receipt outright.
- **L3 CONSISTENCY** — a claim contradicting its evidence is INDETERMINATE, never a failure, and
  never a *retryable* failure.
- **L4 RECEIPT** — a receipt forces `paid` or `indeterminate`; never failed, never in-flight.

Behaviour changes, all confirmed against the previous build:

| record | 0.6.0 | 0.7.0 |
| --- | --- | --- |
| `status: "pending"`, `resultCode: 0` | **paid**, receipt `null` | indeterminate |
| `status: "failed"` + receipt + code 1032 | `cancelled`, **`retryable: true`** | indeterminate |
| `status: "failed"` + receipt, no code | `failed`, receipt dropped | indeterminate |
| `status: "pending"` + receipt | pending | indeterminate |

The second row was the worst defect in the SDK: it told a merchant it was safe to charge again for
a payment carrying an M-Pesa confirmation receipt.

Also in this root:

- **ID binding on every status read.** Nothing previously compared the returned `id` to the
  requested one, so a cache keyed wrongly, a proxy collapsing requests, or a routing bug could
  return a *different* payment — and if that one was paid, the caller shipped goods.
- **Collect acks require HTTP 202**, not any 2xx. A bare `200` is what a cache, a captive portal
  or a rewritten route produces; it is not a dispatched charge.
- **Every dispatch surface runs the same validators, including the simulator.** `simulate.collect`
  validates inside the request (so it sees the real status), generates an idempotency key when the
  caller omits one — production always did — and `simulate.outcome` now carries an idempotency key
  and validates its response as a payment, ID binding included. It previously did none of these.

### Also closed

- Webhook events are **validated, not cast**. `verifyWebhook` enforces the full schema, type/status
  consistency, and success evidence via the same `judge()` the status path uses. Signature
  verification is split out as `verifyWebhookSignature`.
- Escaping failures are **normalised** into an SDK error carrying the idempotency key. The old
  in-place mutation silently dropped it for thrown primitives and frozen errors.
- The response body is read **inside** the timeout window; a stalled body can no longer hang past
  the deadline.
- Sanitised connection errors no longer carry the **unsanitised exception as `cause`**.
- Deep redaction **fails closed** past depth 8 instead of returning values unredacted.
- Malformed-2xx errors store the **redacted** body.
- Deadlines use a **monotonic** clock, not the wall clock.
- **Upper bounds** on timeouts and retries — `1e20` was accepted and, because `setTimeout` clamps
  above 2^31-1 ms, meant "abort immediately".
- Idempotency keys **exclude ASCII space** (HTTP trims field values, so `" k"` and `"k"` are the
  same key on the wire and different keys in your database).
- Webhook adapters no longer **echo handler exception messages**, and the Express adapter caps the
  **unauthenticated** body it buffers at 1 MiB.

### Verification

330 tests, `tsc --noEmit` clean, build clean. Every change above is covered by a mutation test in
`scripts/non-vacuity.mjs`, which reverts the protection in source, requires the guarding test to
FAIL, and restores: **19/19 caught**. That harness found two vacuous tests of its own during this
release — one whose `-t` selector matched zero tests because of a regex metacharacter, and one
whose fixture tripped ID binding before reaching the code under test.

## 0.6.0

Third-round codex review. This SDK came back with only **Low**-severity findings — the cleanest of
the paylod clients — but two of them were **vacuous tests**, which matter more than their severity
suggests: a test that passes whether or not the behaviour exists is not a regression test, it is a
false receipt. Both have been rewritten to genuinely fail when the behaviour is reverted, and every
fix in this release was verified the same way (revert the behaviour, confirm the suite goes red,
restore).

The remaining changes come from auditing this SDK for the issues codex found as **Critical/High in
the sibling paylod SDKs**. Several were genuinely present here.

Signing is unchanged — the shared golden webhook vector (`whsec_golden_vector_v1` →
`3afe38e4…2c2eb7`) still passes byte for byte.

**Minor, not patch:** the evidence requirement and the stricter option validation can reject or
reclassify input 0.5.0 accepted (see *Breaking*).

### Security

- **The loopback opt-in no longer unlocks arbitrary protocols.** `allowInsecureBaseUrl` returned
  from the loopback branch *before* the protocol check ran, so it relaxed not just the origin rule
  but the scheme rule: `ftp://127.0.0.1`, `ws://localhost` and `gopher://[::1]` were all accepted
  as base URLs. The protocol is now validated **first** — https, or http only under the explicit
  test-only opt-in with a non-live key — and the loopback rules apply after.
  (`src/client.ts`, `assertSecureBaseUrl`)
- **A `baseUrl` password is no longer echoed by the check that rejects it.** The credential-in-URL
  rejection interpolated the whole `baseUrl` into its message, so `https://user:hunter2@host` put
  `hunter2` into the exception message and every stack and error tracker downstream. Userinfo is
  stripped before interpolation. (`src/client.ts`, `safeUrl`)
- **Response bodies echoed into an error are redacted.** `PaylodApiError.body` carried the raw
  server response, so an API (or proxy, or debug envelope) reflecting the request back on a 4xx put
  the bearer key straight into the error object — and `message` redaction did not cover it. Strings
  anywhere in the body, keys included, are now scrubbed. (`src/client.ts`, `#redactDeep`)

### Money-correctness

- **`collectAndWait()` attaches the idempotency key to EVERY post-acknowledgement failure.** It
  previously attached it only to failures inside `collect()`. Once the ack came back the key lived
  only on the resolved value, so a wait timeout, a transport drop, a 5xx on a poll or a malformed
  status body all threw bare — leaving the caller with a possibly-live charge and no key to read it
  with, whose natural recovery (mint a fresh key, call again) is a second STK prompt.
  (`src/client.ts`)
- **Reporting `paid` now requires EVIDENCE.** A body of `{"id":"…","status":"success"}` with no
  receipt and no result code is a claim with nothing behind it. It is now treated as
  **indeterminate** — never `paid`, never `retryable`, surfaced as `pending` so `wait()` keeps
  polling and the receipt or webhook settles it — instead of being reported as a completed payment
  a merchant would fulfil against. Evidence is an M-Pesa receipt or result code 0. (`src/outcome.ts`)
- **The collect ack is validated as a complete schema.** Validation checked `paymentId` only; it now
  covers `checkoutRequestId` and `status` as well. A 2xx we cannot fully read means the charge state
  is INDETERMINATE, raised with the key attached. (`src/validate.ts`)
- **Status bodies are validated as a complete schema** — id, a `status` inside the known set, and
  the types of `mpesaReceipt` / `resultCode` — and a malformed 2xx raises an indeterminate error
  rather than being coerced into a `Payment` for the classifier to guess at. (`src/validate.ts`)

### Correctness

- **`Retry-After` is parsed in both RFC 9110 forms.** The HTTP-date form (common behind CDNs) fell
  through `Number()` as `NaN` and was silently discarded, so that backpressure was ignored entirely.
  Delta-seconds is now strict — `"5.5"`, `"-3"` and `""` are treated as absent rather than coerced
  into a bogus pause — and the header name matches case-insensitively. (`src/client.ts`,
  `parseRetryAfterMs`)
- **One bound, in one place.** The independent 10s clamp on `Retry-After` has been removed. It
  shadowed `MAX_UNBOUNDED_SLEEP_MS` and made the ceiling dead code — which is exactly why the test
  covering the ceiling was vacuous. Bounding now happens only in `#boundedSleep`: the operation
  deadline when there is one, the 60s ceiling when there is not.
- **Timeouts are validated as finite whole positive integers.** `timeoutMs`, `maxRetries` and
  `wait({ timeoutMs })` reject fractional, `NaN`, `Infinity` and non-positive values. These are not
  slow timeouts, they are broken ones: `setTimeout` clamps both `NaN` and `Infinity` to fire
  immediately, so a config typo aborted every request at once and made a live charge look like a
  transport failure. (`src/validate.ts`)
- **The simulator runs the production validators.** `simulate.collect()` carried its own weaker copy
  of the idempotency-key rule (C0 controls and DEL only), so it accepted keys production rejects —
  C1 controls, zero-width characters, non-ASCII, over-long keys. A test written to prove "a
  double-click cannot charge twice" could pass against a key that would never have provided that
  guarantee. It now calls the same `assertValidIdempotencyKey` and the same ack-schema validator.
  (`src/simulate.ts`, `src/validate.ts`)

### Tests

- **The redirect regression test was vacuous** and has been rewritten. Its mock always returned the
  supplied 302 and never followed anything, so it could not observe the defence under test — the
  `redirect: "manual"` option — and stayed green with that option deleted, while a real `fetch`
  would have replayed the bearer token to the attacker. The new mock follows redirects unless told
  not to, and the test asserts the 3xx is refused, that the redirect target is **never contacted**,
  and that it never sees the Authorization header. (`test/fixes.test.ts`)
- **The 60-second unbounded-sleep test was vacuous** and has been rewritten. The separate 10s
  `Retry-After` clamp was what bounded the sleep, so deleting the ceiling left the test green. With
  that clamp removed the ceiling is the sole bound on the no-deadline path, and the test now asserts
  the elapsed virtual time is pinned to ~60s rather than merely that the call finished.
  (`test/fixes.test.ts`)
- **New suite** (`test/round3.test.ts`) covering the protocol fix and every sibling-SDK issue
  audited above.
- Every fix in this release was verified non-vacuous by reverting the behaviour and confirming the
  suite fails. 269 tests pass.

### Breaking

- A payment reporting `status: "success"` with **no receipt and no result code** is no longer
  reported as `paid`. It is surfaced as indeterminate (`status: "pending"`, `paid: false`). If you
  relied on the bare status string, you were relying on an unverifiable claim.
- `timeoutMs` / `maxRetries` / `wait({ timeoutMs })` now throw `PaylodInvalidRequestError` on
  fractional, `NaN`, `Infinity` or non-positive values that were previously accepted and silently
  misbehaved.
- A `Retry-After` this SDK previously waited up to 10s on may now be honoured for up to 60s on a
  call with no deadline (`collect()`). Calls with a deadline (`wait()`, `collectAndWait()`) are
  unaffected — the deadline remains the tighter bound.
- Non-https, non-loopback-http `baseUrl` schemes (`ftp`, `ws`, `gopher`, `file`) now throw where the
  loopback opt-in previously accepted them.

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
