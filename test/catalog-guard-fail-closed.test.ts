/**
 * THE DRIFT GUARD MUST FAIL CLOSED.
 *
 * `npm run check-catalog` verifies that the vendored Daraja catalog in `src/` is the catalog the
 * canonical (private, monorepo-resident) source produced. It used to do that by comparing against
 * a SIBLING checkout of that monorepo, and to `exit 0` with a warning when the sibling was absent.
 * In CI the sibling is ALWAYS absent, so the guard verified nothing and the pipeline stayed green
 * regardless. A check that cannot distinguish "I did not look" from "I looked and it is fine" is
 * not a check.
 *
 * The guard's floor is now `daraja-catalog.sha256`, a committed set of pinned digests that needs
 * no monorepo, no network and no credential. These tests pin the two properties that make that
 * floor worth having:
 *
 *   1. FAIL CLOSED — every way the pinned file can stop being a usable record (missing, empty,
 *      malformed, non-hex digest, no data lines, a row quietly dropped) is an ERROR, never a skip.
 *      A guard that degrades to "pass" when its own evidence is gone is the original bug wearing
 *      a different hat.
 *
 *   2. STILL VERIFIES WITHOUT THE MONOREPO — the decisive CI condition. With MPESA_REPO pointing
 *      nowhere the guard must still PASS on an intact tree and must still FAIL on a tampered one.
 *      The second half is the one that matters: passing is cheap, catching is the point.
 *
 * Every case runs against an isolated COPY of the repo's guard inputs in a temp directory, so a
 * corrupted fixture can never race another test file or leave residue in the working tree.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKSUM = "daraja-catalog.sha256";
const GUARD = "scripts/sync-daraja-catalog.mjs";
const VENDORED = ["src/daraja-error-codes.json", "src/daraja-catalog.ts"];

/** Where every fixture tree for this file lives. Removed wholesale afterwards. */
let SANDBOX: string;

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "paylod-catalog-guard-"));
});

afterAll(() => {
  // Leave no residue, even if a case threw partway through.
  rmSync(SANDBOX, { recursive: true, force: true });
});

/**
 * A faithful, isolated copy of everything `--check` reads: the guard, the pinned digests, and the
 * vendored copies. Mutating one of these can affect nothing outside its own temp directory.
 */
function fixture(name: string): string {
  const root = mkdtempSync(join(SANDBOX, `${name}-`));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  cpSync(join(REPO, GUARD), join(root, GUARD));
  cpSync(join(REPO, CHECKSUM), join(root, CHECKSUM));
  for (const f of VENDORED) cpSync(join(REPO, f), join(root, f));
  return root;
}

interface Run {
  status: number;
  output: string;
}

/**
 * Run the guard's `--check` against a fixture. MPESA_REPO defaults to a path that does not exist,
 * because that is exactly the CI condition under test — the guard must stand on the pinned
 * digests alone.
 */
function check(root: string, mpesaRepo = join(SANDBOX, "no-such-monorepo")): Run {
  try {
    const output = execFileSync(process.execPath, [join(root, GUARD), "--check"], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, MPESA_REPO: mpesaRepo },
    });
    return { status: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const dataLines = (text: string): string[] =>
  text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

/** The first pinned row. Throws rather than returning undefined: a fixture with no rows is a bug
 *  in this test file, and must not quietly become the thing under test. */
function firstDataLine(text: string): string {
  const [first] = dataLines(text);
  if (first === undefined) throw new Error("fixture checksum file has no data lines");
  return first;
}

// ── 1. the decisive CI condition ────────────────────────────────────────────────────────────────

describe("the guard without the monorepo — the condition CI actually runs in", () => {
  it("PASSES on an intact tree with a nonexistent MPESA_REPO", () => {
    const run = check(fixture("intact"));
    expect(run.status).toBe(0);
  });

  it("says it VERIFIED, and does not call the run a skip", () => {
    const run = check(fixture("intact-says-verified"));
    // The old guard printed "skipping drift check" and exited 0. A pass that describes itself as
    // a skip is the exact failure this work removed, so the word is now a defect.
    expect(run.output).not.toMatch(/skipping drift check/i);
    expect(run.output).toMatch(/VERIFIED/);
    // and it must name every file it actually hashed, not merely claim success in the abstract
    for (const f of VENDORED) expect(run.output).toContain(f);
  });

  for (const target of VENDORED) {
    it(`still CATCHES a tampered ${target} with a nonexistent MPESA_REPO`, () => {
      const root = fixture("tampered");
      const path = join(root, target);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n// tampered\n`);

      const run = check(root);
      expect(run.status).not.toBe(0);
      expect(run.output).toMatch(/DRIFT/);
      expect(run.output).toContain(target);
    });
  }

  it("CATCHES a vendored file that is missing entirely", () => {
    const root = fixture("absent-copy");
    rmSync(join(root, "src/daraja-catalog.ts"));

    const run = check(root);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/MISSING/);
  });
});

// ── 2. fail closed on the pinned record itself ──────────────────────────────────────────────────

describe("the guard fails closed when its own evidence is unusable", () => {
  /** Each case leaves the vendored copies INTACT and breaks only the pinned record. */
  const cases: { name: string; break: (sum: string) => string | null }[] = [
    { name: "missing", break: () => null },
    { name: "empty", break: () => "" },
    { name: "whitespace only", break: () => "\n\n   \n" },
    {
      name: "header only, zero data lines",
      break: (sum) => `${sum.split("\n").filter((l) => l.startsWith("#")).join("\n")}\n`,
    },
    {
      name: "a data line with too few fields",
      break: (sum) => `${firstDataLine(sum).split(/\s+/).slice(0, 3).join("  ")}\n`,
    },
    {
      name: "a data line with too many fields",
      break: (sum) => `${firstDataLine(sum)}  extra-field\n`,
    },
    {
      name: "a digest that is not 64 hex chars",
      break: (sum) => sum.replace(/^[0-9a-f]{64}/m, "not-a-sha256"),
    },
    {
      name: "a digest with uppercase hex",
      break: (sum) => sum.replace(/^[0-9a-f]{64}/m, "A".repeat(64)),
    },
    {
      name: "a row silently dropped, shrinking what is checked",
      break: (sum) => sum.split("\n").filter((l) => !l.endsWith("src/daraja-catalog.ts")).join("\n"),
    },
    {
      name: "a row pinning a path this SDK does not vendor",
      break: (sum) => `${sum.trimEnd()}\n${"0".repeat(64)}  ${"1".repeat(64)}  a/b.json  src/not-vendored.json\n`,
    },
    {
      name: "the same vendored path pinned twice",
      break: (sum) => `${sum.trimEnd()}\n${firstDataLine(sum)}\n`,
    },
  ];

  for (const c of cases) {
    it(`goes RED when the pinned file is ${c.name}`, () => {
      const root = fixture("failclosed");
      const sumPath = join(root, CHECKSUM);
      const broken = c.break(readFileSync(sumPath, "utf8"));
      if (broken === null) rmSync(sumPath);
      else writeFileSync(sumPath, broken);

      const run = check(root);

      // Non-zero is the whole point: the guard has no evidence, so it must not pass.
      expect(run.status).not.toBe(0);
      // and it must say so in terms a human reading a red build can act on
      expect(run.output).toContain(CHECKSUM);
      expect(run.output).not.toMatch(/skipping/i);
    });
  }
});

// ── 3. the sandbox itself is honest ─────────────────────────────────────────────────────────────

describe("the fixture is a faithful stand-in for the real tree", () => {
  it("the REAL repo passes its own guard, so a RED above means the mutation and nothing else", () => {
    // Without this, every assertion above could be passing for an unrelated reason (a fixture that
    // never worked in the first place), and the suite would be vacuous.
    const run = check(REPO);
    expect(run.status).toBe(0);
  });

  it("leaves the real repo's pinned file and vendored copies untouched", () => {
    // Read back through the same paths the cases above would have damaged if they escaped tmp.
    const sum = readFileSync(join(REPO, CHECKSUM), "utf8");
    expect(dataLines(sum)).toHaveLength(VENDORED.length);
    for (const line of dataLines(sum)) expect(line.split(/\s+/)).toHaveLength(4);
  });
});
