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

import { execFileSync } from "node:child_process";
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
    find: '    if (depth > MAX_JSON_DEPTH) return "[redacted: structure too deeply nested to scan]";',
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
    // `withIdempotencyKey` lives in `reconcile.ts` since 0.9.0. The anchor still named
    // `client.ts`, so this case had been silently BROKEN-ANCHOR ever since — a stale anchor is
    // the third way (after a zero selector and a vacuous test) for a certification to certify
    // nothing while looking green.
    file: "src/reconcile.ts",
    find: "  const wrapped = new PaylodConnectionError(\n    `The charge attempt failed and its state is INDETERMINATE",
    replace: "  if (!isPaylodError(err)) return err;\n  const wrapped = new PaylodConnectionError(\n    `The charge attempt failed and its state is INDETERMINATE",
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
    find: "        raw = await readWebRequestBody(request, bodyReadMs);",
    replace: "        raw = Buffer.from(await request.text(), \"utf8\");",
    test: "refuses an oversized STREAMED body without buffering it",
  },
  {
    id: "H1-buffered",
    what: "a PRE-BUFFERED body (express.raw / Vercel rawBody) bypasses the advertised cap",
    file: "src/client.ts",
    find: '    assertBufferedSizeOk(req.body.length, "req.body");',
    replace: "    void 0;",
    // The pre-buffered cap is enforced in the adapter AND again inside `toBoundedBuffer`, so
    // reverting one alone proves nothing — the other still holds the line and the test goes on
    // passing for a different reason. The mutation has to remove the GUARANTEE, not one of its
    // two implementations. Same shape as `R1-live`.
    also: {
      file: "src/webhook.ts",
      find: `  if (declared > MAX_WEBHOOK_BODY_BYTES) {
    throw tooLargeBody(\`the payload passed to verify() is \${declared} bytes\`);
  }`,
      replace: "  void declared;",
    },
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
    // ROUND 11: spec 3.4 added an identifier-grammar check on the same field, which catches a
    // missing applicationId on its own -- so reverting the required check alone stopped removing
    // the guarantee. Both layers go.
    also: {
      file: "src/webhook.ts",
      find: "  if (!isValidIdentifier(d.applicationId)) {",
      replace: "  if (false) {",
    },
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
    file: "src/reconcile.ts",
    // The anchor used to sit after the assignment that THROWS for a frozen error, so the mutated
    // line was unreachable and the case measured nothing. The defect being reverted is the catch:
    // the JVM sibling returned the frozen error as-is, handles and all missing.
    find: "    } catch {\n      /* frozen / read-only — wrap below */\n    }",
    replace: "    } catch {\n      return err;\n    }",
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
    file: "src/json.ts",
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
    mpesaReceipt: isValidReceipt(p.mpesaReceipt) ? p.mpesaReceipt : null,
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
    // NOT the REJECTION test: dropping the await turns its rejection into an UNHANDLED one, which
    // the harness correctly refuses to score as CAUGHT — so that pairing could only ever produce
    // HARNESS-ERROR. Nor the ORDERING test: its callback finishes in 10ms and the poll interval
    // is ~1s, so start/end never interleave whether the await is there or not — it passed both
    // ways. THIS test uses a callback LONGER than the poll interval, which is the only shape in
    // which a floating promise is observable at all.
    test: "never runs two onPoll callbacks at once, even when one outlasts the poll interval",
  },
  {
    id: "R7-render-throwable",
    what: "the reconciliation wrapper calls String(err) unprotected again",
    file: "src/reconcile.ts",
    find: "  const detail = safeRedact(redact, renderThrowable(err));",
    replace: "  const detail = safeRedact(redact, err instanceof Error ? err.message : String(err));",
    // Round 8 added an outer guard around the whole wrapper, which catches the unprotected
    // `String(err)` and synthesises a fallback that carries both handles — so this edit alone
    // stopped removing the guarantee. Both layers go, exactly as in `R8-envelope-total`.
    also: {
      file: "src/reconcile.ts",
      find: "  } catch {\n    // NOTHING gets past this.",
      replace: "  } catch (rethrow) {\n    throw rethrow;\n    // NOTHING gets past this.",
    },
    test: "wraps a throwing toString into an error that still carries BOTH handles",
  },
  {
    id: "R7-webhook-bytes",
    what: "the Web Request adapter decodes body bytes to UTF-8 and re-encodes before the HMAC",
    file: "src/webhook.ts",
    find: "  const raw = toBoundedBuffer(payload);",
    replace: "  const raw = Buffer.from(toBoundedBuffer(payload).toString('utf8'), 'utf8');",
    // NOT "two DIFFERENT invalid-UTF-8 bodies do not share a signature": that test keeps passing
    // after the decode/re-encode is restored, because it goes on rejecting the mismatched
    // signature for an unrelated reason. A test that passes either way certifies nothing. THIS
    // one is the discriminating half of the pair — it asserts that an invalid-UTF-8 body gets
    // PAST the signature check, which is exactly what a lossy decode destroys.
    test: "verifies a body containing INVALID UTF-8 — which a decode round trip would destroy",
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
    find: "      throw withIdempotencyKey(err, idempotencyKey, (m) => this.#guards.redactText(m), paymentId);",
    replace: "      throw err;",
    // The `()` in this name is why the selector must be escaped — see `exact()`.
    test: "simulate.outcome() failures carry the derived key AND the payment id",
  },
  {
    id: "R7-sim-validators",
    what: "the simulator drops the 150,000 KES ceiling production enforces",
    file: "src/simulate.ts",
    find: `    const amount = assertChargeAmount(params.amount === undefined ? 1 : params.amount, "simulate.collect()");`,
    replace: "    const amount = (params.amount ?? 1) as number;",
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

  // ── ROUND 8 ────────────────────────────────────────────────────────────────────────────────
  {
    id: "R8-lexeme",
    what: "JSON numbers are parsed without the money-critical lexeme check",
    file: "src/json.ts",
    find: "      if (!CANONICAL_JSON_INTEGER_RE.test(lexeme)) {\n        // The MATCHED CONSTANT, never the raw bytes that matched it (spec 4.2).\n        refuseLexeme(memberName, lexeme);\n      }",
    replace: "      void lexeme;",
    test: "refuses a status body whose resultCode is spelt 1032.0",
  },
  {
    id: "R8-lexeme-escaped",
    what: "the member-name scan matches raw bytes instead of decoding escapes",
    file: "src/json.ts",
    find: "  if (!rawBody.includes(\"\\\\\")) return rawBody;",
    replace: "  return rawBody;\n  // eslint-disable-next-line no-unreachable\n  if (!rawBody.includes(\"\\\\\")) return rawBody;",
    test: "an ESCAPED member name is decoded before the key is matched",
  },
  {
    id: "R8-webhook-parse",
    what: "the signed webhook path goes back to a bare JSON.parse",
    file: "src/webhook.ts",
    find: "    decodedBody = parseBounded(decodeUtf8Strict(raw, \"the webhook body\"));",
    replace: "    decodedBody = JSON.parse(raw.toString(\"utf8\"));",
    test: "a laundered resultCode is refused on the SIGNED WEBHOOK path too",
  },
  {
    id: "R8-nested-retryable",
    what: "the decoded detail block is resolved BEFORE the verdict again",
    file: "src/outcome.ts",
    find: "  const safeDetail = verdict === \"failed\" ? detail : withoutRetryability(detail);",
    replace: "  const safeDetail = detail;",
    test: "an INDETERMINATE verdict exposes no true retryable anywhere, top level or nested",
  },
  {
    id: "R8-webhook-secrets",
    what: "the webhook verifier scans only the signing secret again",
    file: "src/webhook.ts",
    find: "  if (typeof params.apiKey === \"string\" && params.apiKey) out.push(params.apiKey);",
    replace: "  void params;",
    test: "REFUSES a signed body whose resultDesc echoes the API KEY, not just the signing secret",
  },
  {
    id: "R8-webhook-prescan",
    what: "the credential scan runs only on the reconstructed event, after the diagnostics",
    file: "src/webhook.ts",
    find: "  if (containsSecret(decodedBody, liveSecrets(params))) {",
    replace: "  if (false) {",
    test: "a SCHEMA DIAGNOSTIC never quotes a credential back to the caller",
  },
  {
    id: "R8-instanceof",
    what: "the reconciliation wrapper inspects the throwable with a bare instanceof",
    file: "src/reconcile.ts",
    find: "    return err instanceof PaylodError;\n  } catch {\n    return false;\n  }",
    replace: "    return err instanceof PaylodError;\n  } finally {\n    /* unguarded */\n  }",
    test: "a hostile throwable is reconciled NORMALLY, not by the last-resort fallback",
  },
  {
    id: "R8-envelope-total",
    what: "the reconciliation wrapper is throwable again (no outer guard)",
    file: "src/reconcile.ts",
    find: "  } catch {\n    // NOTHING gets past this.",
    replace: "  } catch (rethrow) {\n    throw rethrow;\n    // NOTHING gets past this.",
    // BOTH guards, because either one alone still produces an error carrying both handles: the
    // inner `isPaylodError` stops the throw, and the outer wrapper catches it if the inner one
    // is gone. Reverting a single layer measures the other layer, not the guarantee.
    also: {
      file: "src/reconcile.ts",
      find: "    return err instanceof PaylodError;\n  } catch {\n    return false;\n  }",
      replace: "    return err instanceof PaylodError;\n  } finally {\n    /* unguarded */\n  }",
    },
    test: "a throwable that throws during `instanceof` still yields BOTH handles",
  },
  {
    id: "R8-409-precedence",
    what: "a contradictory 409 is retried because only the in-progress phrase is tested",
    file: "src/client.ts",
    find: "        IN_PROGRESS_409_RE.test(message) &&\n        !INDETERMINATE_409_RE.test(message);",
    replace: "        IN_PROGRESS_409_RE.test(message);",
    test: "DOES NOT RE-DISPATCH a 409 whose message carries BOTH phrases",
  },
  {
    id: "R8-409-getter",
    what: "the public isIdempotencyInProgress getter loses the precedence rule",
    file: "src/errors.ts",
    find: "      /already in progress/i.test(this.message) &&\n      !this.isIdempotencyIndeterminate\n    );",
    replace: "      /already in progress/i.test(this.message)\n    );",
    test: "the PUBLIC getters agree with the retry decision",
  },
  {
    id: "R8-web-drip",
    what: "the Web Request adapter reads the body with no finite deadline",
    file: "src/client.ts",
    find: "      const { done, value } = await readWithin(\n        reader.read(),",
    replace: "      const { done, value } = await ((x) => x)(\n        reader.read(),",
    test: "REFUSES a Web Request body that stops arriving, and cancels the source",
  },
  {
    id: "R8-express-drip",
    what: "the Express adapter reads the body with no finite deadline",
    file: "src/client.ts",
    find: "      const { done, value } = await readWithin(\n        Promise.resolve(it.next()),",
    replace: "      const { done, value } = await ((x) => x)(\n        Promise.resolve(it.next()),",
    test: "REFUSES an Express body that stops arriving, and destroys the request",
  },
  {
    id: "R8-sim-redactor",
    what: "the simulator envelope goes back to an identity redactor",
    file: "src/simulate.ts",
    find: "      throw withIdempotencyKey(err, idempotencyKey, (m) => this.#guards.redactText(m));",
    replace: "      throw withIdempotencyKey(err, idempotencyKey, (m) => m);",
    // The client's own connection-error redaction runs FIRST on this path, so the simulator's
    // identity redactor was invisible behind it — the case passed either way. Both are reverted,
    // which is what actually removes the guarantee "a simulator failure never quotes the key".
    also: {
      file: "src/client.ts",
      find: "        lastError = new PaylodConnectionError(\n          this.#redact(",
      replace: "        lastError = new PaylodConnectionError(\n          ((x) => x)(",
    },
    test: "REDACTS the API key out of a simulator failure's message",
  },
  {
    id: "R8-sim-secrets",
    what: "the simulator ack is validated without production's credential scan",
    file: "src/simulate.ts",
    find: "            secrets: this.#guards.secrets(),\n          });",
    replace: "          });",
    test: "REFUSES a simulator ack whose body echoes the API key",
  },
  {
    id: "R8-sim-menu",
    what: "the simulator casts the server's outcome menu instead of rebuilding it",
    file: "src/simulate.ts",
    find: "            outcomes: parseOutcomeMenu(parsed),",
    replace: "            outcomes: ((parsed as { outcomes?: unknown }).outcomes ?? []) as never,",
    test: "REBUILDS the outcome menu from an allowlist instead of casting it",
  },
  {
    id: "R8-onpoll-listener",
    what: "the onPoll abort listener is left attached on the success path",
    file: "src/client.ts",
    find: "      if (onAbort !== undefined) signal?.removeEventListener(\"abort\", onAbort);",
    replace: "      void onAbort;",
    test: "removes its abort listener on the SUCCESS path, not just on abort",
  },
  {
    id: "R8-decompression",
    what: "the response byte cap is applied after the whole body is resident",
    file: "src/transport.ts",
    find: "        if (total > MAX_RESPONSE_BYTES) throw this.#tooLarge();",
    replace: "        void total;",
    test: "caps DECOMPRESSED bytes incrementally, so 16 KB of gzip cannot become 9 MB of heap",
  },

  // ── ROUND 9 ───────────────────────────────────────────────────────────────────────────
  //
  // The Critical needs FOUR mutations, not one, because the finding is a MISMATCH between two
  // bounds rather than a wrong value. A test that only exercises a shallow credential passes with
  // every one of these reverted, so each mutation attacks a different half of the fix: the cutoff
  // itself, the fail-closed direction, and the two webhook entry points that must agree.

  {
    id: "R9-depth-cutoff",
    what: "the credential scan stops at depth 8 again while the parser admits 64",
    file: "src/validate.ts",
    find: "  if (depth > MAX_JSON_DEPTH) return true;",
    replace: "  if (depth > 8) return false;",
    test: "finds a secret at depth 9, the first level the old cutoff reported CLEAN",
  },
  {
    id: "R9-depth-max",
    what: "the credential scan stops at depth 8 again (probed at the parser's maximum)",
    file: "src/validate.ts",
    find: "  if (depth > MAX_JSON_DEPTH) return true;",
    replace: "  if (depth > 8) return false;",
    test: "finds a secret at the deepest level the parser will ever hand it",
  },
  {
    id: "R9-depth-open",
    what: "the traversal limit FAILS OPEN again — 'I did not look' reported as 'it is clean'",
    file: "src/validate.ts",
    find: "  if (depth > MAX_JSON_DEPTH) return true;",
    replace: "  if (depth > MAX_JSON_DEPTH) return false;",
    test: "FAILS CLOSED past the budget instead of reporting clean",
  },
  {
    id: "R9-depth-untyped",
    what: "a signed body can smuggle a credential past the UNTYPED webhook entry point again",
    file: "src/validate.ts",
    find: "  if (depth > MAX_JSON_DEPTH) return true;",
    replace: "  if (depth > 8) return false;",
    test: "REFUSES a signed body hiding a credential at depth 9 — the untyped entry point",
  },
  {
    id: "R9-depth-typed",
    what: "the TYPED webhook path silently strips a deep credential instead of refusing",
    file: "src/validate.ts",
    find: "  if (depth > MAX_JSON_DEPTH) return true;",
    replace: "  if (depth > 8) return false;",
    test: "REFUSES a signed body hiding a credential at depth 9 — the typed entry point",
  },
  {
    id: "R9-depth-api",
    what: "an API 2xx body can smuggle the bearer key back to the caller at depth 9",
    file: "src/validate.ts",
    find: "  if (depth > MAX_JSON_DEPTH) return true;",
    replace: "  if (depth > 8) return false;",
    test: "refuses an API 2xx body hiding the bearer key at depth 9",
  },
  {
    id: "R9-sweep-depth",
    what: "the depth cutoff returns, probed by the standing adversarial sweep",
    file: "src/validate.ts",
    find: "  if (depth > MAX_JSON_DEPTH) return true;",
    replace: "  if (depth > 8) return false;",
    test: "keeps both credentials out of both webhook entry points at depth 9",
  },

  // The High, at all four layers the laundering has historically survived at.
  {
    id: "R9-dotted-classify",
    what: "a one-dot lexeme validates as a canonical Daraja code again (classifier)",
    file: "src/daraja-catalog.ts",
    find: "const CANONICAL_DOTTED_RE = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8}){2,6}$/;",
    replace: "const CANONICAL_DOTTED_RE = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8}){1,6}$/;",
    test: "CLASSIFIER: a one-dot code is never a confident terminal failure",
  },
  {
    id: "R9-dotted-decode",
    what: "a one-dot lexeme selects a catalog entry again (decoder)",
    file: "src/daraja-catalog.ts",
    find: "const CANONICAL_DOTTED_RE = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8}){2,6}$/;",
    replace: "const CANONICAL_DOTTED_RE = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8}){1,6}$/;",
    test: "DECODER: a one-dot code decodes as indeterminate, not as a catalog entry",
  },
  {
    id: "R9-dotted-judge",
    what: "`failed` plus a one-dot lexeme becomes a confident terminal failure again (judge)",
    file: "src/daraja-catalog.ts",
    find: "const CANONICAL_DOTTED_RE = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8}){2,6}$/;",
    replace: "const CANONICAL_DOTTED_RE = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8}){1,6}$/;",
    // ROUND 11: spec 1.5 added a SECOND, independent guard -- an uncatalogued canonical code is
    // now `unknown` evidence and resolves to indeterminate regardless of its dot count. So
    // reverting the dotted rule alone no longer changes the verdict and the case went VACUOUS
    // while the guarantee was in fact stronger than before. The mutation has to remove BOTH
    // layers, exactly as R1-live and D2-coerce do.
    also: {
      file: "src/semantics.ts",
      find: "    (rawCodeEvidence === \"failure\" && !isCataloguedCode(payment.resultCode))",
      replace: "    (false)",
    },
    test: "JUDGE: `failed` plus a one-dot code is INDETERMINATE, not a terminal failure",
  },
  {
    id: "R9-dotted-webhook",
    what: "a forged payment.failed passes on one-dot 'evidence' again (webhook verification)",
    file: "src/daraja-catalog.ts",
    find: "const CANONICAL_DOTTED_RE = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8}){2,6}$/;",
    replace: "const CANONICAL_DOTTED_RE = /^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,8}){1,6}$/;",
    // ROUND 11: spec 1.5 added a SECOND, independent guard -- an uncatalogued canonical code is
    // now `unknown` evidence and resolves to indeterminate regardless of its dot count. So
    // reverting the dotted rule alone no longer changes the verdict and the case went VACUOUS
    // while the guarantee was in fact stronger than before. The mutation has to remove BOTH
    // layers, exactly as R1-live and D2-coerce do.
    also: {
      file: "src/semantics.ts",
      find: "    (rawCodeEvidence === \"failure\" && !isCataloguedCode(payment.resultCode))",
      replace: "    (false)",
    },
    test: "WEBHOOK: an otherwise-valid payment.failed carrying a one-dot code is REFUSED",
  },

  // The Mediums and the Low.
  {
    id: "R9-bodyread-int",
    what: "a fractional bodyReadTimeoutMs is floored to a zero deadline again",
    file: "src/client.ts",
    find: "  if (!Number.isInteger(configured) || configured < 1 || configured > MAX_WEBHOOK_BODY_READ_MS) {",
    replace: "  if (!Number.isFinite(configured) || configured <= 0) {",
    test: "REFUSES a fractional bodyReadTimeoutMs instead of flooring it to a zero deadline",
  },
  {
    id: "R9-stringify-depth",
    what: "request-body serialisation loses its depth bound again",
    file: "src/json.ts",
    find: "    if (depth > MAX_JSON_DEPTH) {",
    replace: "    if (false) {",
    test: "REFUSES a request body nested past the parser's own depth budget, before dispatch",
  },
  {
    id: "R9-stringify-cycle",
    what: "request-body serialisation loses its cycle detection again",
    file: "src/json.ts",
    find: "    if (seen.has(obj)) {",
    replace: "    if (false) {",
    test: "REFUSES a circular request body without naming the caller-data path",
  },
  {
    id: "R9-stringify-bytes",
    what: "request-body serialisation loses its byte cap again",
    file: "src/json.ts",
    find: "  if (bytes > MAX_REQUEST_BODY_BYTES) {",
    replace: "  if (false) {",
    test: "REFUSES an oversized request body before it is dispatched",
  },
  {
    id: "R9-sim-phone",
    what: "the simulator silently replaces a runtime-invalid falsy phone with the default again",
    file: "src/simulate.ts",
    find: "      phone: params.phone === undefined ? DEFAULT_SIM_PHONE : normalizePhone(params.phone),",
    replace: "      phone: params.phone ? normalizePhone(params.phone) : DEFAULT_SIM_PHONE,",
    test: "does not default a runtime-invalid falsy phone in the simulator",
  },
  {
    id: "R9-webhookqueued",
    what: "a malformed webhookQueued is coerced to true again",
    file: "src/simulate.ts",
    find: "          webhookQueued: queued === undefined ? true : queued === true,",
    replace: "          webhookQueued: queued !== false,",
    test: "does not coerce a malformed webhookQueued to true",
  },
  {
    id: "R9-safeurl-redact",
    what: "a configured credential is quoted verbatim in a baseUrl refusal again",
    file: "src/transport.ts",
    find: "  for (const s of secrets) {\n    if (typeof s === \"string\" && s.length > 0) rendered = rendered.split(s).join(\"[redacted]\");\n  }",
    replace: "  void secrets;",
    test: "REDACTS a configured credential out of a baseUrl diagnostic",
  },
  {
    id: "R9-safeurl-sweep",
    what: "a configured credential rides out in a config refusal, probed by the standing sweep",
    file: "src/transport.ts",
    find: "  for (const s of secrets) {\n    if (typeof s === \"string\" && s.length > 0) rendered = rendered.split(s).join(\"[redacted]\");\n  }",
    replace: "  void secrets;",
    test: "keeps both credentials out of every configuration refusal",
  },
  {
    id: "R9-lexeme-bound",
    what: "the refusal reproduces the raw server-chosen lexeme again",
    file: "src/json.ts",
    // ROUND 11 RETARGET. The round-9 protection was a LENGTH BOUND on the reproduced lexeme
    // (`quoteServerText`/`MAX_QUOTED_LEXEME`), and round 10 showed a bound is not enough: a
    // credential shorter than the bound fits inside it. The lexeme is no longer reproduced at
    // all, so there is no bound left to revert -- the mutation now restores the raw echo the
    // bound used to trim. Same guarantee, current implementation, and this round-9 test probes
    // it with a LONG credential-bearing lexeme where `S42-lexeme-leak` probes a short one.
    find: "  const shape = describeLexemeShape(rawLexeme);",
    replace: "  const shape = `the JSON number \\`${rawLexeme}\\``;",
    test: "BOUNDS the server-chosen lexeme it reproduces in a refusal",
  },
  {
    id: "R9-sweep-control",
    what: "the adversarial sweep's own detector stops detecting",
    file: "test/round9.test.ts",
    find: "        if (s.includes(cred)) {",
    replace: "        if (false) {",
    test: "proves the sweep can actually fail",
  },

  // ── ROUND 11 — the conformance specification ──────────────────────────────────────────────
  //
  // Each case reverts one requirement of docs/SDK-CONFORMANCE.md to the behaviour round 10 found.

  {
    id: "S33-receipt-grammar",
    what: "every nonblank receipt is settlement evidence again, so a placeholder proves payment",
    file: "src/grammar.ts",
    find: "const RECEIPT_RE = /^[A-Z0-9]{10}$/;",
    replace: "const RECEIPT_RE = /^.*\\S.*$/;",
    test: "does NOT report paid for status success with a redacted receipt and no result code",
  },
  {
    id: "S33-receipt-control",
    what: "the receipt grammar over-corrects and refuses REAL receipts too",
    file: "src/grammar.ts",
    find: "const RECEIPT_RE = /^[A-Z0-9]{10}$/;",
    replace: "const RECEIPT_RE = /^(?!)$/;",
    // THE CONTROL DIRECTION. An SDK that calls every receipt invalid is also non-conformant, and
    // the mutation above cannot detect that. This one does.
    test: "still reports paid for status success with a REAL receipt and no result code",
  },
  {
    id: "S34-identifier-grammar",
    what: "a sanitizer placeholder is accepted as a paymentId again",
    file: "src/grammar.ts",
    find: "const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]{1,128}$/;",
    replace: "const IDENTIFIER_RE = /^.*\\S.*$/;",
    test: "refuses \"[redacted]\" as a collect-ack paymentId",
  },
  {
    id: "S34-idem-sentinel",
    what: "a redacted log value is accepted as an idempotency key again",
    file: "src/validate.ts",
    find: "  if (looksSanitized(key)) {",
    replace: "  if (false) {",
    test: "refuses \"[redacted]\" as a caller-supplied idempotency key",
  },
  {
    id: "S23-duplicate",
    what: "duplicate money-critical members are resolved by the parser instead of refused",
    file: "src/json.ts",
    find: "        if (scope.has(memberName)) refuseDuplicate(memberName);",
    replace: "        if (false) refuseDuplicate(memberName);",
    test: "refuses two resultCode members whose values disagree",
  },
  {
    id: "S23-duplicate-scope",
    what: "the duplicate rule loses its per-object scope and refuses ordinary bodies",
    file: "src/json.ts",
    find: "      scopes.push(new Set());",
    replace: "      void 0;",
    // THE CONTROL DIRECTION: over-refusal is also a defect. Without per-object scoping, two
    // sibling objects each carrying `status` are wrongly refused.
    test: "accepts the same member name in two DIFFERENT objects",
  },
  {
    id: "S42-lexeme-leak",
    what: "the numeric-lexeme refusal interpolates raw server bytes again",
    file: "src/json.ts",
    find: "  const shape = describeLexemeShape(rawLexeme);",
    replace: "  const shape = `the JSON number \\`${rawLexeme.slice(0, 32)}\\``;",
    test: "does NOT echo a credential embedded in a non-canonical numeric lexeme",
  },
  {
    id: "S26-fatal-decode",
    what: "response bytes are decoded with replacement semantics again",
    file: "src/json.ts",
    find: '    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);',
    replace: "    return new TextDecoder().decode(bytes);",
    test: "refuses a lone continuation byte rather than yielding U+FFFD",
  },
  {
    id: "S26-collapse",
    what: "distinct invalid byte sequences collapse into one identical string again",
    file: "src/json.ts",
    find: '    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);',
    replace: "    return new TextDecoder().decode(bytes);",
    test: "does not let two distinct invalid byte sequences collapse into one string",
  },
  {
    id: "S54-paymentid",
    what: "a refused acknowledgement discards a usable payment id again",
    file: "src/validate.ts",
    find: "      salvagedPaymentId(),",
    replace: "      undefined,",
    test: "carries the payment id off a malformed 202 that still has a usable one",
  },
  {
    id: "S54-no-launder",
    what: "the salvaged payment id skips the grammar, so a placeholder is attached",
    file: "src/validate.ts",
    find: "    if (!isValidIdentifier(candidate)) return undefined;",
    replace: "    if (typeof candidate !== \"string\") return undefined;",
    test: "does NOT attach a placeholder payment id",
  },
  {
    id: "S41-shapes",
    what: "only CONFIGURED credentials are redacted, so another party's key rides out",
    file: "src/grammar.ts",
    find: "  return text.replace(CREDENTIAL_SHAPE_RE, \"[redacted]\");",
    replace: "  return text;",
    test: "redacts mp_live_SOMEONE_ELSES_KEY",
  },
  {
    id: "S49-offline",
    what: "the public offline decoder stops redacting, as it did before",
    // The redaction lives in `decode.ts`, a wrapper this SDK owns -- `daraja-catalog.ts` is a
    // GENERATED file and an edit there would be undone by the next sync while breaking the drift
    // check in the meantime.
    file: "src/decode.ts",
    find: "  const safeDesc = typeof rawDesc === \"string\" ? redactCredentialShapes(rawDesc) : rawDesc;",
    replace: "  const safeDesc = rawDesc;",
    test: "keeps mp_live_LEAKED_VIA_DESC out of the bare decodeDarajaResult output",
  },
  {
    id: "S65-sigheader",
    what: "the signature header is split with no length bound again",
    file: "src/webhook.ts",
    find: "  if (header.length > MAX_SIGNATURE_HEADER_CHARS) return null;",
    replace: "  void MAX_SIGNATURE_HEADER_CHARS;",
    test: "refuses an oversized signature header instead of tokenising it",
  },
  {
    id: "S86-sweep-coverage",
    what: "the sweep stops noticing that a public type was never constructed",
    file: "test/conformance-sweep.test.ts",
    // The mutation neuters the REGISTRY rather than the assertion: it simulates the real defect,
    // which is a public type that never gets constructed. Blanking `missing` instead left the
    // second assertion (`constructed.size >= REQUIRED_TYPES.length`) still passing, so the case
    // measured nothing -- a vacuous mutation, caught by this harness on its own certification.
    find: "  constructed.add(type);",
    replace: "  void type;",
    test: "constructed every public type it claims to cover",
  },
  {
    id: "S86-sweep-expected",
    what: "the sweep accepts any clean exception again instead of the declared class",
    file: "test/conformance-sweep.test.ts",
    find: "    if (!(e instanceof expected)) {",
    replace: "    if (false) {",
    test: "proves the expected-outcome requirement can actually fail",
  },
  {
    id: "S15-uncatalogued",
    what: "a canonical code the catalog never heard of is a confident terminal failure again",
    file: "src/semantics.ts",
    find: "    (rawCodeEvidence === \"failure\" && !isCataloguedCode(payment.resultCode))",
    replace: "    (false)",
    test: "a canonically-shaped code the catalog never heard of",
  },
  {
    id: "S15-noncanonical",
    what: "a non-canonical code claims the prompt is still live again",
    file: "src/semantics.ts",
    find: "    codePresentButNotCanonical ||",
    replace: "    false ||",
    test: "is not evidence the prompt is live either",
  },
  {
    id: "S15-control",
    what: "the unknown rule over-corrects and swallows a GENUINE catalog failure",
    file: "src/semantics.ts",
    find: "    codePresentButNotCanonical ||",
    replace: "    hasResultCode(payment) ||",
    // CONTROL DIRECTION: calling everything unknown is also non-conformant.
    test: "a GENUINE catalog failure code is still a terminal failure",
  },
  {
    id: "S53-built-artifact",
    what: "the unsafe-path warning goes back to once per process, probed against the BUILT dist",
    file: "src/validate.ts",
    find: "function warnUnsafeGeneratedIdempotencyKey(what: string): void {\n  console.warn(",
    replace:
      "let warnedOnceDist = false;\nfunction warnUnsafeGeneratedIdempotencyKey(what: string): void {\n  if (warnedOnceDist) return;\n  warnedOnceDist = true;\n  console.warn(",
    test: "warns on EVERY unprotected call in the BUILT artifact, not just in source",
  },
  {
    id: "S37-fallback",
    what: "the unknown-code fallback invites another payment attempt again",
    // `src/daraja-catalog.ts` is a GENERATED copy; the canonical edit lives in the monorepo at
    // supabase/functions/_shared/daraja/daraja-catalog.ts. The mutation is applied to the copy
    // because that is what the tests import, and the harness works on a throwaway tree.
    file: "src/daraja-catalog.ts",
    find:
      "    customerMessage:\n" +
      "      \"We couldn't confirm this payment yet. Please wait while it settles — do not start a new \" +\n" +
      "      \"payment.\",\n" +
      "  };\n" +
      "}\n" +
      "\n" +
      "/**\n" +
      " * The code arrived in a form Daraja does not emit",
    replace:
      "    customerMessage: \"The payment didn't go through. Please try again.\",\n" +
      "  };\n" +
      "}\n" +
      "\n" +
      "/**\n" +
      " * The code arrived in a form Daraja does not emit",
    test: "no fallback invites another payment attempt",
  },
  {
    id: "S37-fallback-coverage",
    what: "a fallback that nobody probes stops being noticed -- the defect was invisible, not merely present",
    file: "src/daraja-catalog.ts",
    // The mutation ADDS a fallback that no probe points at -- the exact shape of the defect,
    // which was not "one bad string" but "a decode path nothing was looking at". It compiles and
    // changes no behaviour, so only the coverage guard can notice it.
    find: "function pendingFallback(code: string): DecodedError {",
    replace:
      "function unprobedFallback(code: string): DecodedError {\n" +
      "  return pendingFallback(code);\n" +
      "}\n" +
      "void unprobedFallback;\n" +
      "function pendingFallback(code: string): DecodedError {",
    test: "every fallback DECLARED in the source is probed here",
  },
];

const results = [];

/**
 * Vitest's `-t` IS A REGEX, and that fact silently invalidated a certification.
 *
 * `R7-sim-envelope` named the test "simulate.outcome() failures carry…". The literal `()` in that
 * name is an empty capture group to a regex engine, so the pattern matched a DIFFERENT string
 * than the one written down — in that case, nothing at all. Vitest then exits 0 for "no tests
 * matched", which reads exactly like "the mutation was not caught" while in truth no assertion
 * ever ran. The strongest evidence of a broken case looked like ordinary evidence of a live one.
 *
 * Every selector is escaped to a LITERAL and anchored, so `-t` means what the string says.
 */
function exact(name) {
  // Escaped but NOT anchored: vitest matches `-t` against the FULL name (describe titles joined
  // to the test title), so an anchored pattern matches nothing at all — the same zero-selector
  // failure this function exists to prevent, arrived at from the other side. Escaping alone is
  // what makes the string mean itself; `selected()` then proves it covers at least one test.
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Number of tests a `-t` selector actually selects, against the CURRENT (unmutated) tree. */
function selected(pattern) {
  try {
    // execFileSync, NOT execSync: there is no shell, so a test name is never re-interpreted on
    // its way to vitest. `a throwable that throws during \`instanceof\`…` contains BACKTICKS, and
    // inside the double quotes execSync's shell produced, those are COMMAND SUBSTITUTION — the
    // selector vitest received was not the selector written here, and it matched nothing. Same
    // class of defect as the unescaped regex, one layer further out.
    const out = execFileSync("npx", ["vitest", "run", "--reporter=dot", "-t", exact(pattern)], {
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

// `NV_ONLY=id1,id2 node scripts/non-vacuity.mjs` re-certifies specific cases. The full pass is
// what gates a release; this is for iterating on one case without paying for all of them.
const only = (process.env.NV_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const SELECTED = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;
if (only.length && SELECTED.length !== only.length) {
  console.error("NV_ONLY named an unknown case id");
  process.exit(1);
}

for (const c of SELECTED) {
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
    execFileSync("npx", ["vitest", "run", "--reporter=dot", "-t", exact(c.test)], {
      stdio: "pipe",
      timeout: 180_000,
    });
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
