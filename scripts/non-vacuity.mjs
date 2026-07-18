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
    find: `          return of(
            "indeterminate",
            "status says pending while the evidence says the payment succeeded — a pending " +
              "record must never be reported as paid",
          );`,
    replace: '          return of("paid", "REVERTED");',
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
    find: `        case "none":
          // L2. This is the "a stubbed endpoint / truncated row / cached proxy envelope can
          // write six characters of JSON" case. A claim with nothing behind it is not money.
          return of(
            "indeterminate",
            "status claims success but the record carries neither a receipt nor a result code, " +
              "so there is no evidence the payment actually settled",
          );`,
    replace: `        case "none":
          return of("paid", "REVERTED");`,
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
    find: "      if (total > MAX_WEBHOOK_BODY_BYTES) {",
    replace: "      if (false) {",
    test: "refuses to buffer an unbounded unauthenticated body",
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

  const original = readFileSync(c.file, "utf8");
  const occurrences = original.split(c.find).length - 1;

  if (occurrences !== 1) {
    results.push({ ...c, status: "BROKEN-ANCHOR", detail: `matched ${occurrences}x` });
    continue;
  }

  let alsoOriginal;
  if (c.also) {
    alsoOriginal = readFileSync(c.also.file, "utf8");
    if (alsoOriginal.split(c.also.find).length - 1 !== 1) {
      results.push({ ...c, status: "BROKEN-ANCHOR", detail: "secondary anchor did not match 1x" });
      continue;
    }
    writeFileSync(c.also.file, alsoOriginal.replace(c.also.find, c.also.replace));
  }

  writeFileSync(c.file, original.replace(c.find, c.replace));
  let failed = false;
  let detail = "";
  try {
    execSync(
      `npx vitest run --reporter=dot -t ${JSON.stringify(c.test)}`,
      { stdio: "pipe", timeout: 180_000 },
    );
    detail = "test still PASSED";
  } catch (e) {
    failed = true;
    const out = String(e.stdout ?? "") + String(e.stderr ?? "");
    const m = out.match(/Tests\s+(\d+) failed/);
    detail = m ? `${m[1]} test(s) failed` : "suite failed";
  } finally {
    writeFileSync(c.file, original);
    if (c.also && alsoOriginal !== undefined) writeFileSync(c.also.file, alsoOriginal);
  }

  results.push({ ...c, status: failed ? "CAUGHT" : "VACUOUS", detail: `${detail}; selector covers ${live} test(s)` });
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
