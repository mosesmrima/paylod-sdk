/**
 * NON-VACUITY HARNESS.
 *
 * A test that passes both with and without the fix it claims to cover proves nothing. codex has
 * previously caught vacuous tests in this repo, so each protection landed in 0.7.0 is verified
 * the only way that actually settles the question: REVERT the change in the source, run the test
 * that is supposed to catch it, and require that it FAILS. The file is restored afterwards.
 *
 * Run: node scripts/non-vacuity.mjs
 * Exit code 0 only if every mutation was caught.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Each case reverts ONE protection to its pre-0.7.0 behaviour.
 * `find` must match exactly once, so a silent no-op mutation cannot masquerade as a caught one.
 */
const CASES = [
  {
    id: "R1-gate",
    what: "custom fetch no longer requires the explicit opt-in",
    file: "src/client.ts",
    find: "      if (options.allowCustomFetch !== true) {",
    replace: "      if (false) {",
    test: "ROOT 1 — a custom fetch is a gated, test-only seam",
  },
  {
    id: "R1-live",
    what: "custom fetch permitted with a live key (BOTH guards reverted)",
    file: "src/client.ts",
    find: '      if (this.#apiKey.startsWith("mp_live_")) {',
    replace: "      if (false) {",
    // The live-key rule is enforced in the client AND again inside the transport. Reverting one
    // alone proves nothing, because the other still holds the line — so the mutation has to
    // remove the guarantee, not just one of its two implementations.
    also: {
      file: "src/transport.ts",
      find: '      if (init.apiKey.startsWith("mp_live_")) {',
      replace: "      if (false) {",
    },
    test: "refuses an injected fetch with a LIVE key",
  },
  {
    id: "R1-followed",
    what: "a 2xx reached by FOLLOWING a redirect is accepted",
    file: "src/transport.ts",
    find: "    if (res.redirected === true) {",
    replace: "    if (false) {",
    test: "REFUSES A 2xx THAT THE FETCH IMPL REACHED BY FOLLOWING A REDIRECT",
  },
  {
    id: "R1-origin",
    what: "the responding URL is not checked against the pinned origin",
    file: "src/transport.ts",
    find: '    if (res.url) this.#assertOnOrigin(res.url, "the responding URL");',
    replace: "    void res;",
    test: "refuses a 2xx whose final URL is off the pinned origin",
  },
  {
    id: "R2-bind",
    what: "the returned payment id is not bound to the requested id",
    file: "src/validate.ts",
    find: "  if (p.id !== opts.expectedId) {",
    replace: "  if (false) {",
    test: "ROOT 2 — ID binding",
  },
  {
    id: "R2-202",
    what: "any 2xx is accepted as a collect ack",
    file: "src/validate.ts",
    find: "  if (opts.httpStatus !== 202) {",
    replace: "  if (false) {",
    test: "a collect ack requires HTTP 202",
  },
  {
    id: "R2-pending0",
    what: "a pending record carrying code 0 is treated as paid",
    file: "src/semantics.ts",
    find: `    success: [
      "indeterminate",
      "status says pending while the evidence says the payment succeeded — a pending " +
        "record must never be reported as paid",
    ],`,
    replace: '    success: ["paid", "REVERTED"],',
    test: "a pending row carrying code zero",
  },
  {
    id: "R2-receipt",
    what: "a receipt beside a failure code no longer forces indeterminate",
    file: "src/semantics.ts",
    find: "  if (codeEvidence === \"success\" || codeEvidence === \"none\") return \"success\";\n  return \"conflict\";",
    replace: "  return codeEvidence === \"none\" ? \"success\" : codeEvidence;",
    test: "L4: a receipt forces success or indeterminate, never failed and never in flight",
  },
  {
    id: "R2-evidence",
    what: "a bare status:success with no evidence is treated as paid",
    file: "src/semantics.ts",
    find: `    none: [
      "indeterminate",
      "status claims success but the record carries neither a receipt nor a result code, " +
        "so there is no evidence the payment actually settled",
    ],`,
    replace: '    none: ["paid", "REVERTED"],',
    test: "L2: paid ALWAYS has success evidence",
  },
  {
    id: "B-space",
    what: "the idempotency key charset admits ASCII space again",
    file: "src/validate.ts",
    find: "  if (!/^[\\x21-\\x7e]+$/.test(key)) {",
    replace: "  if (!/^[\\x20-\\x7e]+$/.test(key)) {",
    test: "the idempotency key charset excludes ASCII space",
  },
  {
    id: "B-bounds",
    what: "no upper bound on timeouts",
    file: "src/validate.ts",
    find: "    value > MAX_TIMEOUT_MS\n  ) {",
    replace: "    false\n  ) {",
    test: "rejects an absurd timeout",
  },
  {
    id: "B-depth",
    what: "deep redaction passes values through past depth 8",
    file: "src/client.ts",
    find: '    if (depth > 8) return "[redacted: structure too deeply nested to scan]";',
    replace: "    if (depth > 8) return value;",
    test: "redacts the key out of a DEEPLY nested error body",
  },
  {
    id: "B-rawbody",
    what: "the indeterminate error stores the RAW parsed body, bypassing redaction",
    file: "src/validate.ts",
    find: "      redactBody(parsed),\n      opts.idempotencyKey,",
    replace: "      parsed,\n      opts.idempotencyKey,",
    test: "redacts the raw body stored on a malformed-2xx",
  },
  {
    id: "B-cause",
    what: "the sanitised connection error carries the unsanitised exception as `cause`",
    file: "src/client.ts",
    find: "          // The redacted message retains the diagnostic content that is safe to keep.\n        );",
    replace: "          { cause: e },\n        );",
    test: "does NOT attach the unsanitised lower-level exception",
  },
  {
    id: "B-key",
    what: "escaping failures are not normalised, so a primitive throw loses the key",
    file: "src/client.ts",
    find: "  const wrapped = new PaylodConnectionError(",
    replace: "  if (!(err instanceof PaylodError)) return err;\n  const wrapped = new PaylodConnectionError(",
    test: "carries it when user code throws a PRIMITIVE",
  },
  {
    id: "W-schema",
    what: "webhook success evidence is not required",
    file: "src/webhook.ts",
    find: '  if (e.type === "payment.success" && verdict !== "paid") {',
    replace: "  if (false) {",
    test: "REJECTS a signed payment.success with NO evidence",
  },
  {
    id: "W-consistency",
    what: "webhook type/status consistency is not checked",
    file: "src/webhook.ts",
    find: "  if (d.status !== expectedStatus) {",
    replace: "  if (false) {",
    test: "rejects a signed success whose data.status contradicts",
  },
  {
    id: "W-leak",
    what: "the adapter echoes the handler's exception message",
    file: "src/client.ts",
    find: '        return new Response(JSON.stringify({ error: "handler failed" }), {',
    replace:
      '        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "handler failed" }), {',
    test: "does NOT echo the handler's exception message",
  },
  {
    id: "W-size",
    what: "the unauthenticated webhook body is buffered without a cap",
    file: "src/client.ts",
    // Since round 6 the byte counter exists on BOTH the Express drain and the Web stream reader,
    // so the bare `if (total > …)` is no longer a unique anchor. The preceding line disambiguates
    // (`buf.length` is the Express path; the Web path counts `value.byteLength`).
    find: "      total += buf.length;\n      if (total > MAX_WEBHOOK_BODY_BYTES) {",
    replace: "      total += buf.length;\n      if (false) {",
    test: "refuses to buffer an unbounded unauthenticated body",
  },

  // ── 0.8.0 — the round-5 (sibling-derived) protections ──────────────────────────────────────
  {
    id: "D1-total",
    what: "the failed x in_flight cell reports a LIVE prompt as a terminal failure",
    file: "src/semantics.ts",
    find: `    in_flight: [
      "in_flight",
      "status says failed but the result code means the prompt is still live and the " +
        "customer has not entered their PIN yet",
    ],`,
    replace: '    in_flight: ["failed", "REVERTED"],',
    test: "covers the FULL cross-product",
  },
  {
    id: "D1-claim",
    what: "an unrecognised claim falls back to a verdict derived from the evidence",
    file: "src/semantics.ts",
    find: "  const row = Object.prototype.hasOwnProperty.call(VERDICTS, claimed)\n    ? VERDICTS[claimed]\n    : undefined;",
    replace: "  const row = VERDICTS[claimed] ?? VERDICTS.success;",
    test: "an unrecognised claim resolves as indeterminate",
  },
  {
    id: "D2-coerce",
    what: "result-code zero is decided by Number() coercion again",
    file: "src/daraja-catalog.ts",
    find: '  if (raw === "0") return "success";',
    replace: '  if (raw !== "" && Number(raw) === 0) return "success";',
    // Since round 6 the canonical-form gate stops a non-canonical code REACHING this line at all,
    // so reverting the predicate alone is a no-op — which is precisely the shape of a vacuous
    // mutation. The guarantee is "an impostor is never success", and removing it takes BOTH the
    // ordering rule and the strict predicate. (Same pattern as R1-live.)
    also: {
      file: "src/daraja-catalog.ts",
      find: "  if (resultCode === null || resultCode === undefined) return { kind: \"absent\" };",
      replace:
        "  if (resultCode === null || resultCode === undefined) return { kind: \"absent\" };\n  resultCode = String(resultCode).trim();",
    },
    test: "does NOT classify",
  },
  {
    id: "D3-terminal",
    what: "a credential-compromise detection is retried like an ordinary network blip",
    file: "src/client.ts",
    find: "        if (e instanceof PaylodTerminalTransportError) throw e;",
    replace: "        if (false) throw e;",
    test: "does NOT retry after the fetch impl FOLLOWED a redirect",
  },
  {
    id: "D4-decoded",
    what: "the payload's own `decoded` block is trusted instead of recomputed",
    file: "src/webhook.ts",
    find: `  const decoded =
    e.type === "payment.failed"
      ? decodeDarajaResult(
          d.resultCode ?? null,
          typeof d.resultDesc === "string" ? d.resultDesc : null,
        )
      : null;`,
    replace: "  const decoded = d.decoded as never;",
    test: "OVERRIDES a hostile retryable:true",
  },

  // ── 0.9.0 — the round-6 (ordering / boundary) protections ─────────────────────────────────
  {
    id: "C1-order",
    what: "the result code is normalized (String+trim) BEFORE its form is validated",
    file: "src/daraja-catalog.ts",
    find: '  if (resultCode === null || resultCode === undefined) return { kind: "absent" };',
    replace:
      '  if (resultCode === null || resultCode === undefined) return { kind: "absent" };\n  resultCode = String(resultCode).trim();',
    test: "does NOT report",
  },
  {
    id: "C1-decode",
    what: "an ambiguous code is re-normalized into a catalog hit by the DECODER",
    file: "src/daraja-catalog.ts",
    find: "  if (form.kind === \"ambiguous\") return indeterminateFallback(form.code, rawDesc);",
    replace:
      "  if (form.kind === \"ambiguous\") return decodeDarajaResult(form.code.trim(), rawDesc, family);",
    test: "does NOT decode",
  },
  {
    id: "C1-negzero",
    what: "numeric negative zero is no longer distinguished from zero",
    file: "src/daraja-catalog.ts",
    find: '    if (Object.is(resultCode, -0)) return { kind: "ambiguous", code: "-0" };',
    replace: "    void 0;",
    test: "numeric negative zero",
  },
  {
    id: "H1-web",
    what: "the Web Request adapter buffers the unauthenticated body with request.text()",
    file: "src/client.ts",
    find: "        raw = await readWebRequestBody(request);",
    replace: "        raw = await request.text();",
    test: "refuses an oversized STREAMED body without buffering it",
  },
  {
    id: "H1-buffered",
    what: "a PRE-BUFFERED body (express.raw / Vercel rawBody) bypasses the advertised cap",
    file: "src/client.ts",
    find: '    assertBufferedSizeOk(req.body.length, "req.body");',
    replace: "    void 0;",
    test: "refuses an oversized pre-buffered Buffer body",
  },
  {
    id: "H1-declared",
    what: "an oversized Content-Length is not refused before the stream is touched",
    file: "src/client.ts",
    find: "  if (Number(s) > MAX_WEBHOOK_BODY_BYTES) {",
    replace: "  if (false) {",
    test: "refuses an oversized declared Content-Length",
  },
  {
    id: "H2-leak",
    what: "a malformed `status` is quoted verbatim into the exception message",
    file: "src/validate.ts",
    find: '    return bad(`status was ${safe(p.status)}, not one of ${PAYMENT_STATUSES.join("/")}`);',
    replace:
      '    return bad(`status was ${JSON.stringify(p.status)}, not one of ${PAYMENT_STATUSES.join("/")}`);',
    test: "IS the bearer key does not leak it",
  },
  {
    id: "H2-bind-leak",
    what: "a MISMATCHED payment id is quoted verbatim into the exception message",
    file: "src/validate.ts",
    find: "      `the body describes payment ${safe(p.id)} but ${safe(opts.expectedId)} was requested — ` +",
    replace:
      "      `the body describes payment ${JSON.stringify(p.id)} but ${JSON.stringify(opts.expectedId)} was requested — ` +",
    test: "a MISMATCHED id that is the bearer key",
  },
  {
    id: "H3-abort",
    what: "an ALREADY-aborted signal is subscribed to but never checked, so the charge dispatches",
    file: "src/transport.ts",
    find: "    if (req.signal?.aborted) {",
    replace: "    if (false) {",
    test: "dispatches ZERO requests",
  },
  {
    id: "M5-desc",
    what: "resultDesc is unvalidated, so an object value crashes the classifier with a TypeError",
    file: "src/validate.ts",
    find: '  if (p.resultDesc !== undefined && p.resultDesc !== null && typeof p.resultDesc !== "string") {',
    replace: "  if (false) {",
    test: "rather than throwing a raw TypeError",
  },
  {
    id: "M4-amount",
    what: "a webhook amount is only checked for finiteness (negatives and fractions pass)",
    file: "src/webhook.ts",
    find: "  assertAmount(d.amount);",
    replace:
      '  if (typeof d.amount !== "number" || !Number.isFinite(d.amount)) invalid("data.amount is not a finite number");',
    test: "rejects a negative amount",
  },
  {
    id: "M4-required",
    what: "applicationId is optional again, while the type still promises a string",
    file: "src/webhook.ts",
    find: '  requiredString(d.applicationId, "data.applicationId");',
    replace: '  optionalString(d.applicationId, "data.applicationId");',
    test: "rejects a missing applicationId",
  },
  {
    id: "M4-env",
    what: "env is optional again, so a sandbox/production guard reads undefined",
    file: "src/webhook.ts",
    find: '  if (d.env !== "sandbox" && d.env !== "production") {',
    replace: '  if (d.env !== undefined && d.env !== "sandbox" && d.env !== "production") {',
    test: "rejects a missing env",
  },
  {
    id: "M4-synth",
    what: "a MISSING decoded block is mirrored as null instead of being synthesised",
    file: "src/webhook.ts",
    find: `  const decoded =
    e.type === "payment.failed"
      ? decodeDarajaResult(
          d.resultCode ?? null,
          typeof d.resultDesc === "string" ? d.resultDesc : null,
        )
      : null;`,
    replace: `  const decoded =
    d.decoded === null || d.decoded === undefined
      ? null
      : decodeDarajaResult(
          d.resultCode ?? null,
          typeof d.resultDesc === "string" ? d.resultDesc : null,
        );`,
    test: "gets one built from the catalog",
  },
  {
    id: "D6-paymentid",
    what: "an escaping throw after the ack no longer carries the payment id",
    file: "src/client.ts",
    find: "      throw withIdempotencyKey(err, ack.idempotencyKey, (m) => this.#redact(m), ack.paymentId);",
    replace: "      throw withIdempotencyKey(err, ack.idempotencyKey, (m) => this.#redact(m));",
    test: "carries BOTH when user code throws a PRIMITIVE",
  },
  {
    id: "D6-frozen",
    what: "a frozen error is returned as-is, losing the handle (the JVM defect)",
    file: "src/client.ts",
    find: "  const wrapped = new PaylodConnectionError(\n    `The charge attempt failed and its state is INDETERMINATE",
    replace:
      "  if (err instanceof PaylodError) return err;\n  const wrapped = new PaylodConnectionError(\n    `The charge attempt failed and its state is INDETERMINATE",
    test: "carries BOTH when a FROZEN PaylodError escapes after the ack",
  },
  {
    id: "D7-bytes",
    what: "the response body is buffered with no byte cap (OOM loses the key)",
    file: "src/transport.ts",
    find: "        if (total > MAX_RESPONSE_BYTES) throw this.#tooLarge();",
    replace: "        if (false) throw this.#tooLarge();",
    test: "refuses a body over the byte cap",
  },
  {
    id: "D7-depth",
    what: "JSON is parsed with no depth budget",
    file: "src/client.ts",
    find: "      if (depth > maxDepth) {",
    replace: "      if (false) {",
    test: "refuses a JSON document nested past the depth cap",
  },
  {
    id: "D8-tolerance",
    what: "the webhook tolerance loses its UPPER bound (an enormous window disables replay protection)",
    file: "src/webhook.ts",
    find: "  if (!Number.isInteger(toleranceSec) || toleranceSec <= 0 || toleranceSec > MAX_TOLERANCE_SEC) {",
    replace: "  if (!Number.isInteger(toleranceSec) || toleranceSec <= 0) {",
    test: "refuses an ENORMOUS tolerance",
  },

  // -- 0.10.0 -- idempotencyKey is REQUIRED on every money-moving surface -----------------------
  {
    id: "I1-required",
    what: "collect() silently generates a key again instead of requiring one",
    file: "src/validate.ts",
    find: "  if (unsafeGenerated !== true) {",
    replace: "  if (false) {",
    // NO PARENTHESES in a selector: vitest treats `-t` as a REGEX, so "collect()" is
    // "collect" plus an empty group and the literal parens never match. That is precisely how a
    // selector silently covers zero tests while the runner exits 0 -- caught by the liveness check.
    test: "with no idempotencyKey, before a single request is dispatched",
  },
  {
    id: "I1-caw",
    what: "collectAndWait() -- the sibling surface -- no longer requires a key either",
    file: "src/validate.ts",
    find: "  if (unsafeGenerated !== true) {",
    replace: "  if (false) {",
    test: "it is the call most people actually make",
  },
  {
    id: "I1-failopen",
    what: "the opt-out fails OPEN on a truthy non-true value (`\"false\"` from an env var)",
    file: "src/validate.ts",
    find: "  if (unsafeGenerated !== true) {",
    replace: "  if (!unsafeGenerated) {",
    test: "fails CLOSED on a truthy-but-not-true opt-out",
  },
  {
    id: "I2-sim",
    what: "the SIMULATOR's collect is laxer than production and generates a key unasked",
    file: "src/simulate.ts",
    find: `    const idempotencyKey = resolveIdempotencyKey(
      params.idempotencyKey,
      params.unsafeGeneratedIdempotencyKey,
      "simulate.collect()",
    );`,
    replace: `    const idempotencyKey = resolveIdempotencyKey(
      params.idempotencyKey,
      true,
      "simulate.collect()",
    );`,
    test: "a simulator laxer than production certifies a lie",
  },
  {
    id: "I3-everycall",
    what: "the unsafe-path warning goes back to once per process, so a charge in a LOOP warns once",
    file: "src/validate.ts",
    find: "function warnUnsafeGeneratedIdempotencyKey(what: string): void {\n  console.warn(",
    replace:
      "let warnedOnce = false;\nfunction warnUnsafeGeneratedIdempotencyKey(what: string): void {\n  if (warnedOnce) return;\n  warnedOnce = true;\n  console.warn(",
    test: "emits N warnings for N unprotected calls from the SAME call site in ONE process",
  },
  // ── ROUND 7 ────────────────────────────────────────────────────────────────────────────────
  // NOTE ON SELECTORS: vitest's `-t` is a REGEX. Every selector below is chosen to contain no
  // regex metacharacter — no parentheses, no `+`, no `?`, no `.` that matters — because a
  // selector with an unescaped `(` silently matches ZERO tests and the run then exits 0, which
  // the harness used to read as "the mutation was not caught". Each one is proven live by
  // `selected()` before its verdict is trusted.
  {
    id: "R7-ack-rebuild",
    what: "a successful collect ack is passed through raw instead of reconstructed",
    file: "src/validate.ts",
    find: `  return {
    paymentId: ack.paymentId,
    status: "pending",
    checkoutRequestId: ack.checkoutRequestId,
  };`,
    replace: "  return parsed as CollectAckWire;",
    test: "STRIPS unknown fields from a collect ack instead of returning them",
  },
  {
    id: "R7-payment-rebuild",
    what: "a successful status body is passed through raw instead of reconstructed",
    file: "src/validate.ts",
    find: `  return {
    id: p.id,
    status: p.status as PaymentStatus,
    mpesaReceipt: typeof p.mpesaReceipt === "string" ? p.mpesaReceipt : null,
    resultCode: asWireResultCode(p.resultCode),
    resultDesc: typeof p.resultDesc === "string" ? p.resultDesc : null,
  };`,
    replace: "  return parsed as Payment;",
    test: "STRIPS unknown fields from a status body instead of returning them",
  },
  {
    id: "R7-secret-scan",
    what: "a credential-bearing 2xx body is no longer refused",
    file: "src/validate.ts",
    find: `export function containsSecret(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): boolean {`,
    replace: `export function containsSecret(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): boolean {
  if (true) return false;`,
    test: "REFUSES a 2xx collect ack whose KNOWN field carries the bearer key",
  },
  {
    id: "R7-event-rebuild",
    what: "a verified webhook event is SPREAD from the payload again",
    file: "src/webhook.ts",
    find: "  return event;\n}",
    replace: "  return { ...(e as object), data: { ...d, decoded } } as unknown as WebhookEvent;\n}",
    test: "STRIPS unknown top-level and data fields from a correctly-signed event",
  },
  {
    id: "R7-failed-none",
    what: "`failed` with NO evidence resolves as a terminal failure again",
    file: "src/semantics.ts",
    find: `    none: [
      "indeterminate",
      "status claims failed but the record carries neither a result code nor a receipt, so " +`,
    replace: `    none: [
      "failed",
      "status claims failed but the record carries neither a result code nor a receipt, so " +`,
    test: "failed with NO evidence is indeterminate, not a terminal failure",
  },
  {
    id: "R7-onpoll-await",
    what: "a promise-returning onPoll is fired and forgotten again",
    file: "src/client.ts",
    find: "        await this.#awaitOnPoll(options.onPoll(payment), payment, deadline, options.signal);",
    replace: "        void options.onPoll(payment);",
    test: "an async onPoll REJECTION fails the call instead of becoming an unhandled rejection",
  },
  {
    id: "R7-render-throwable",
    what: "the reconciliation wrapper calls String(err) unprotected again",
    file: "src/reconcile.ts",
    find: "  const detail = redact(renderThrowable(err));",
    replace: "  const detail = redact(err instanceof Error ? err.message : String(err));",
    test: "wraps a throwing toString into an error that still carries BOTH handles",
  },
  {
    id: "R7-webhook-bytes",
    what: "the Web Request adapter decodes body bytes to UTF-8 and re-encodes before the HMAC",
    file: "src/webhook.ts",
    find: "  const raw = toBoundedBuffer(payload);",
    replace: "  const raw = Buffer.from(toBoundedBuffer(payload).toString('utf8'), 'utf8');",
    test: "two DIFFERENT invalid-UTF-8 bodies do not share a signature",
  },
  {
    id: "R7-manual-cap",
    what: "the manual verify path has no body-size limit before the HMAC",
    file: "src/webhook.ts",
    find: `  if (declared > MAX_WEBHOOK_BODY_BYTES) {
    throw tooLargeBody(\`the payload passed to verify() is \${declared} bytes\`);
  }`,
    replace: "  void declared;",
    test: "REFUSES an oversized payload on the manual path",
  },
  {
    id: "R7-sim-envelope",
    what: "simulator outcome failures escape without the effective idempotency key",
    file: "src/simulate.ts",
    find: "      throw withIdempotencyKey(err, idempotencyKey, (m) => m, paymentId);",
    replace: "      throw err;",
    test: "simulate.outcome failures carry the derived key AND the payment id",
  },
  {
    id: "R7-sim-validators",
    what: "the simulator drops the 150,000 KES ceiling production enforces",
    file: "src/simulate.ts",
    find: `    const amount = assertChargeAmount(params.amount ?? 1, "simulate.collect()");`,
    replace: "    const amount = params.amount ?? 1;",
    test: "REFUSES an amount above the 150,000 KES ceiling, exactly as collect",
  },
  {
    id: "R7-wire-nulls",
    what: "absent optional wire fields escape as undefined again",
    file: "src/validate.ts",
    find: "    resultCode: asWireResultCode(p.resultCode),",
    replace: "    resultCode: p.resultCode as never,",
    test: "ABSENT optional fields arrive as null, never undefined",
  },
  {
    id: "R7-retryable-integrity",
    what: "the webhook decoded block is trusted from the payload again",
    file: "src/webhook.ts",
    find: `  const decoded =
    e.type === "payment.failed"
      ? decodeDarajaResult(`,
    replace: `  const decoded =
    e.type === "payment.failed"
      ? ((d.decoded as never) ?? decodeDarajaResult(`,
    also: {
      file: "src/webhook.ts",
      find: `          typeof d.resultDesc === "string" ? d.resultDesc : null,
        )
      : null;`,
      replace: `          typeof d.resultDesc === "string" ? d.resultDesc : null,
        ))
      : null;`,
    },
    test: "ignores a payload that asserts the OPPOSITE",
  },
];

const results = [];

/** Number of tests a `-t` selector actually selects, against the CURRENT (unmutated) tree. */
function selected(pattern) {
  try {
    const out = execSync(`npx vitest run --reporter=dot -t ${JSON.stringify(pattern)}`, {
      stdio: "pipe",
      timeout: 180_000,
    });
    const m = String(out).match(/Tests\s+(\d+) passed/);
    return m ? Number(m[1]) : 0;
  } catch {
    // A selector that fails on clean source is broken in its own way; report it as unusable.
    return -1;
  }
}

for (const c of CASES) {
  // A selector containing a regex metacharacter (`+`, `(`, `-`) can silently match NOTHING, and
  // vitest then exits 0 — which reads as "the mutation was not caught" when in truth no test
  // ever ran. Every selector is proven live before its verdict is trusted.
  const live = selected(c.test);
  if (live <= 0) {
    results.push({
      ...c,
      status: "BROKEN-SELECTOR",
      detail: live === 0 ? "matches 0 tests" : "fails on clean source",
    });
    continue;
  }

  // A case is one or more edits. They are applied to an IN-MEMORY copy per file and written once,
  // so two edits to the SAME file compose instead of the second silently overwriting the first —
  // which is the one way a multi-part mutation could quietly degrade into a single-part one, and
  // therefore into exactly the vacuous result this harness exists to detect.
  const edits = [{ file: c.file, find: c.find, replace: c.replace }, ...(c.also ? [c.also] : [])];
  const originals = new Map();
  const pending = new Map();
  let brokenAnchor = null;

  for (const edit of edits) {
    if (!originals.has(edit.file)) {
      const text = readFileSync(edit.file, "utf8");
      originals.set(edit.file, text);
      pending.set(edit.file, text);
    }
    const current = pending.get(edit.file);
    const occurrences = current.split(edit.find).length - 1;
    if (occurrences !== 1) {
      brokenAnchor = `anchor in ${edit.file} matched ${occurrences}x`;
      break;
    }
    pending.set(edit.file, current.replace(edit.find, edit.replace));
  }

  if (brokenAnchor) {
    results.push({ ...c, status: "BROKEN-ANCHOR", detail: brokenAnchor });
    continue;
  }

  for (const [file, text] of pending) writeFileSync(file, text);
  let status = "VACUOUS";
  let detail = "";
  try {
    execSync(
      `npx vitest run --reporter=dot -t ${JSON.stringify(c.test)}`,
      { stdio: "pipe", timeout: 180_000 },
    );
    detail = "test still PASSED";
  } catch (e) {
    // A NONZERO EXIT IS NOT PROOF OF A CAUGHT MUTATION.
    //
    // This was the harness's own blind spot, and it invalidated every verdict it ever produced.
    // `vitest run` exits nonzero for a whole family of reasons that have nothing to do with an
    // assertion noticing anything: a mutated source file that no longer PARSES, a module that
    // throws at import time, an unhandled rejection, a worker crash, the 180s timeout firing,
    // `npx` failing to resolve vitest at all. Each of those was recorded as CAUGHT — so a
    // mutation that merely BROKE THE BUILD was indistinguishable from one a test detected, and
    // the strongest possible evidence of a vacuous test (the test never ran) was being reported
    // as the strongest possible evidence of a live one.
    //
    // CAUGHT now requires POSITIVE evidence of the only thing that actually settles the
    // question: vitest reporting a nonzero count of FAILED TESTS, with no startup or unhandled
    // error alongside it. Everything else is HARNESS-ERROR — not a pass, not a fail, a verdict
    // the harness is not entitled to give.
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    const failedTests = out.match(/Tests\s+(\d+) failed/);
    const startupError = /Error: Failed to load|Startup Error|Unhandled Error|Unhandled Rejection|Transform failed|Failed to parse|SyntaxError|No test (files )?found|Vitest caught \d+ unhandled error/i.test(
      out,
    );
    const timedOut = e.signal === "SIGTERM" || e.code === "ETIMEDOUT" || e.killed === true;

    if (failedTests && Number(failedTests[1]) > 0 && !startupError && !timedOut) {
      status = "CAUGHT";
      detail = `${failedTests[1]} test(s) failed`;
    } else {
      status = "HARNESS-ERROR";
      detail = timedOut
        ? "vitest timed out — no assertion verdict"
        : startupError
          ? "vitest reported a startup/unhandled error, not a test failure"
          : `vitest exited nonzero with no positive failed-test count (${String(e.status ?? "?")})`;
    }
  } finally {
    for (const [file, text] of originals) writeFileSync(file, text);
  }

  results.push({ ...c, status, detail: `${detail}; selector covers ${live} test(s)` });
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\n| id | reverted protection | guarding test | result |");
console.log("| --- | --- | --- | --- |");
for (const r of results) {
  console.log(
    `| ${pad(r.id, 14)} | ${pad(r.what, 62)} | ${pad(r.test.slice(0, 48), 48)} | ${r.status} (${r.detail}) |`,
  );
}

const bad = results.filter((r) => r.status !== "CAUGHT");
console.log(`\n${results.length - bad.length}/${results.length} mutations caught.`);
if (bad.length) {
  console.error("NOT ALL MUTATIONS CAUGHT:", bad.map((b) => `${b.id}=${b.status}`).join(", "));
  process.exit(1);
}
