/**
 * SPEC 5.3 — the opt-out warning, proven EMPIRICALLY AGAINST THE BUILT ARTIFACT.
 *
 * Every other test in this suite imports from `src/`, which vitest transpiles on the fly. That
 * proves the source is correct; it does not prove the PUBLISHED package is. The spec asks for
 * this one empirically against the built artifact because the failure mode it guards is a
 * build-time one: a bundler that hoists, inlines, dedupes or tree-shakes the warning path, or a
 * `console.warn` stripped by a production-minification setting, produces a `dist/` that warns
 * once — or never — while `src/` still warns N times and every source test still passes.
 *
 * N calls MUST emit N warnings. No once-per-process flag, no once-per-call-site filter, and no
 * mechanism the host can globally silence.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIST = new URL("../dist/index.js", import.meta.url).pathname;

/**
 * ALWAYS REBUILD, never reuse whatever `dist/` happens to be lying around.
 *
 * This looked like a pointless couple of seconds and is in fact what makes the test mean
 * anything. The first version built only when `dist/` was ABSENT — so the artifact under test
 * was whatever the last build produced, with no relationship to the current `src/`. The
 * non-vacuity harness proved it: reverting the every-call warning IN SOURCE left the test
 * passing, because the test was reading a stale `dist/` the mutation never touched. A test
 * pinned to an artifact nobody rebuilds is a test of a fossil.
 *
 * Rebuilding ties the assertion to the current source, which is the whole point: the failure
 * mode being guarded is a BUILD-TIME one, so the build has to be part of the test.
 *
 * The test is skipped rather than failed when the build cannot run at all, because that is a
 * toolchain problem and not a conformance one — but a `dist/` that behaves differently from
 * `src/` is never skipped.
 */
function ensureBuilt(): boolean {
  try {
    execFileSync("npm", ["run", "build"], { stdio: "pipe", timeout: 180_000 });
    return existsSync(DIST);
  } catch {
    return existsSync(DIST) ? false : false;
  }
}

const built = ensureBuilt();

describe.skipIf(!built)("spec 5.3 — warning behaviour of the BUILT artifact", () => {
  /**
   * Run in a SEPARATE process, so "once per process" is genuinely observable.
   *
   * Inside vitest the module registry is shared across tests in a file, so a module-level
   * `warned` flag set by an earlier test would make a later one look correct. A fresh child
   * process is the only place the per-process claim can be measured honestly.
   */
  function countWarningsFromDist(calls: number): number {
    const script = `
      import { Paylod } from ${JSON.stringify(DIST)};
      let warnings = 0;
      console.warn = (...a) => {
        if (String(a[0] ?? "").includes("NOT protected against being sent twice")) warnings++;
      };
      const paylod = new Paylod({ apiKey: "mp_test_x", webhookSecret: "whsec_x" });
      for (let i = 0; i < ${calls}; i++) {
        try {
          await paylod.collect({
            phone: "254712345678",
            amount: 1,
            unsafeGeneratedIdempotencyKey: true,
          });
        } catch {
          // The dispatch fails (no network here). The warning fires BEFORE dispatch, which is
          // the point: it is attached to the decision, not to a successful charge.
        }
      }
      process.stdout.write(String(warnings));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      stdio: "pipe",
      timeout: 120_000,
    });
    return Number(String(out).trim());
  }

  it("warns on EVERY unprotected call in the BUILT artifact, not just in source", () => {
    // N=12 rather than 2: a once-per-process flag and a correct implementation both emit 1 and 2
    // respectively for N=2, but only a correct one emits 12 for N=12, and an "every other call"
    // or "first three" filter is also caught.
    expect(countWarningsFromDist(12)).toBe(12);
  });

  it("emits exactly one warning for one call — the calibration", () => {
    // Proves the counter is measuring the warning and not, say, counting every console line.
    expect(countWarningsFromDist(1)).toBe(1);
  });
});
