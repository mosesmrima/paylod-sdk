#!/usr/bin/env node
/**
 * Pull THE Daraja code table + classifier into this SDK from its canonical home, and verify the
 * vendored copies have not drifted.
 *
 * Canonical (edit these, and ONLY these — they live in the paylod monorepo):
 *   supabase/functions/_shared/daraja/daraja-error-codes.json   ← the one table
 *   supabase/functions/_shared/daraja/daraja-catalog.ts         ← the one classifier + decoder
 *
 * This SDK is a separate git repo and a separate publish artifact, so — exactly like
 * `paylod-mcp` — it cannot import across the repo boundary and must carry a physical copy.
 * That copy is GENERATED. Never hand-edit `src/daraja-catalog.ts` or `src/daraja-error-codes.json`.
 *
 * WHY THIS SCRIPT EXISTS: a hand-maintained copy of this table is what shipped the 4999
 * "false failure / double charge" bug — twice. Before this script, `src/error-catalog.ts` was a
 * fourth hand-maintained fork and had already drifted: it was missing the pending-description
 * safety net and the terminal-500 disambiguation that the canonical classifier has.
 *
 * WHY THE GUARD NO LONGER SKIPS: the check used to compare the vendored copies against a SIBLING
 * checkout of the private monorepo, and to exit 0 with a warning when that directory was absent.
 * In CI it is always absent, so the guard verified nothing and the pipeline stayed green anyway.
 * A check that cannot distinguish "I did not look" from "I looked and it is fine" is not a check.
 *
 * The guard's floor is now `daraja-catalog.sha256`, a COMMITTED, PINNED digest of every vendored
 * copy (and of the canonical bytes each was generated from). It needs no monorepo, no network and
 * no credential, so it runs identically on a laptop and in CI. It FAILS CLOSED: a missing,
 * unreadable, empty, malformed or row-less checksum file is an error, never a skip.
 *
 * WHY A PINNED CHECKSUM AND NOT A CROSS-REPO TOKEN: the alternative was an MPESA_REPO_TOKEN secret
 * so CI could clone the private monorepo. That means minting a long-lived credential with read
 * access to the whole private monorepo and storing it in four SDK repos, three of them public —
 * widening the blast radius to solve what is only a file-availability problem.
 *
 * When the monorepo IS checked out beside this repo, the guard additionally performs the stronger
 * canonical comparison: the canonical file must still hash to the pinned canonical digest, and the
 * vendored bytes must equal the transformed canonical bytes. Its absence downgrades the guard to
 * the pinned check — it never disables it.
 *
 *   node scripts/sync-daraja-catalog.mjs           # write the copies + the checksum file
 *   node scripts/sync-daraja-catalog.mjs --check   # exit 1 if a copy has drifted (CI / prepublish)
 *
 * The monorepo checkout is found at ../mpesa by default; override with MPESA_REPO=/path.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MPESA = process.env.MPESA_REPO ?? resolve(SDK, "..", "mpesa");
const SRC = join(MPESA, "supabase/functions/_shared/daraja");

const CANON_JSON_REL = "supabase/functions/_shared/daraja/daraja-error-codes.json";
const CANON_TS_REL = "supabase/functions/_shared/daraja/daraja-catalog.ts";

/** The pinned-digest file, relative to this repo's root. */
const CHECKSUM_REL = "daraja-catalog.sha256";
const CHECKSUM_PATH = join(SDK, CHECKSUM_REL);

const BANNER = (from) =>
  `// GENERATED FILE — DO NOT EDIT.\n` +
  `// Source of truth: mpesa/${from}\n` +
  `// Regenerate: node scripts/sync-daraja-catalog.mjs\n`;

/**
 * Every vendored artifact: [canonical relpath in the monorepo, vendored relpath here, transform].
 *
 * The transform is why each pinned row carries TWO digests. `daraja-error-codes.json` is
 * byte-identical to canonical; `daraja-catalog.ts` is not, because a banner is prepended.
 */
const TARGETS = [
  [CANON_JSON_REL, "src/daraja-error-codes.json", (s) => s],
  [CANON_TS_REL, "src/daraja-catalog.ts", (s) => BANNER(CANON_TS_REL) + s],
];

const full = (s) => createHash("sha256").update(s).digest("hex");
const sha = (s) => full(s).slice(0, 12);
const short = (h) => h.slice(0, 12);
const check = process.argv.includes("--check");

/**
 * The header of the pinned-checksum file. This MUST stay byte-identical to the block the monorepo
 * generator emits — the monorepo regenerates this file for four SDKs, and any divergence here
 * would surface there as a phantom diff on every sync.
 */
const CHECKSUM_HEADER = [
  "# Daraja catalog provenance — PINNED CHECKSUMS. GENERATED FILE, DO NOT HAND-EDIT.",
  "#",
  "# Regenerate from the paylod monorepo:  node scripts/sync-daraja-catalog.mjs",
  "#",
  "# This repo's drift guard verifies the vendored catalog against these digests, with no access",
  "# to the canonical file. That is deliberate. The canonical catalog lives in a PRIVATE monorepo",
  "# which CI cannot check out, and the guard used to compare against a sibling directory that",
  "# does not exist in CI — so it skipped, silently, and the pipeline stayed green while verifying",
  "# nothing. A check that cannot distinguish \"I did not look\" from \"I looked and it is fine\" is",
  "# not a check.",
  "#",
  "# A cross-repo token was rejected as the fix: it would mint a long-lived credential with read",
  "# access to the private monorepo and store it in four SDK repos, three of them public. A",
  "# committed digest needs no credential, no network, and works in any checkout.",
  "#",
  "# Fields: <canonical sha256>  <vendored sha256>  <canonical path>  <vendored path>",
].join("\n");

const checksumBody = (rows) =>
  `${CHECKSUM_HEADER}\n` +
  rows.map(([cSha, vSha, cRel, vRel]) => `${cSha}  ${vSha}  ${cRel}  ${vRel}`).join("\n") +
  "\n";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Every way the pinned file can fail to be a usable record ends here. All of them are errors and
 * none of them is a skip: without a trustworthy record there is no way to tell an intact vendored
 * catalog from a tampered one, and "I could not check" must never read as "it is fine".
 */
function fail(reason) {
  console.error(`✗ ${reason}`);
  console.error(
    `\n${CHECKSUM_REL} is the drift guard's floor — it is what lets this repo verify its vendored\n` +
      `catalog with no access to the private monorepo. Without it the guard cannot tell an intact\n` +
      `copy from a tampered one, so it refuses to pass.\n` +
      `Regenerate it from the paylod monorepo: node scripts/sync-daraja-catalog.mjs`,
  );
  process.exit(1);
}

/**
 * Read and validate `daraja-catalog.sha256`, failing closed on every defect: missing, unreadable,
 * empty, a data line without exactly four fields, a digest that is not 64 lowercase hex chars, a
 * duplicated vendored path, zero data lines, or a row set that does not match what this SDK
 * actually vendors. Returns the parsed rows.
 */
function readPinnedChecksums() {
  let text;
  try {
    text = readFileSync(CHECKSUM_PATH, "utf8");
  } catch (e) {
    fail(
      existsSync(CHECKSUM_PATH)
        ? `cannot read ${CHECKSUM_REL}: ${e.message}`
        : `${CHECKSUM_REL} is missing (expected at ${CHECKSUM_PATH})`,
    );
  }
  if (text.trim() === "") fail(`${CHECKSUM_REL} is empty — it pins nothing`);

  const rows = [];
  const seen = new Set();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const n = i + 1;
    const fields = line.split(/\s+/);
    if (fields.length !== 4) {
      fail(
        `${CHECKSUM_REL}:${n} is malformed: expected 4 whitespace-separated fields, found ` +
          `${fields.length} — ${line}`,
      );
    }
    const [canonSha, vendSha, canonRel, vendRel] = fields;
    if (!HEX64.test(canonSha)) {
      fail(`${CHECKSUM_REL}:${n} canonical digest is not 64 lowercase hex chars: ${canonSha}`);
    }
    if (!HEX64.test(vendSha)) {
      fail(`${CHECKSUM_REL}:${n} vendored digest is not 64 lowercase hex chars: ${vendSha}`);
    }
    if (seen.has(vendRel)) fail(`${CHECKSUM_REL}:${n} pins ${vendRel} twice`);
    seen.add(vendRel);
    rows.push({ canonSha, vendSha, canonRel, vendRel, line: n });
  });

  if (rows.length === 0) fail(`${CHECKSUM_REL} has no data lines — it pins nothing`);

  // A pinned row this SDK does not generate, or a file this SDK vendors that no row covers, both
  // mean the record and the repo have diverged — and the guard would then be verifying a
  // different set of files than the one that ships. Dropping a row must not shrink the check.
  const expected = new Set(TARGETS.map(([, vendRel]) => vendRel));
  for (const r of rows) {
    if (!expected.has(r.vendRel)) {
      fail(`${CHECKSUM_REL}:${r.line} pins an unknown vendored path: ${r.vendRel}`);
    }
  }
  for (const vendRel of expected) {
    if (!seen.has(vendRel)) fail(`${CHECKSUM_REL} does not pin ${vendRel}, which this SDK vendors`);
  }
  return rows;
}

// ── --check: pinned verification ALWAYS, canonical comparison additionally when available ───────

if (check) {
  const rows = readPinnedChecksums();
  const monorepo = existsSync(SRC);
  let bad = 0;

  for (const { canonSha, vendSha, canonRel, vendRel } of rows) {
    const to = join(SDK, vendRel);
    if (!existsSync(to)) {
      console.error(`✗ MISSING     ${vendRel}  (pinned ${short(vendSha)})`);
      bad++;
      continue;
    }
    const have = readFileSync(to, "utf8");
    const haveSha = full(have);
    if (haveSha !== vendSha) {
      console.error(`✗ DRIFT       ${vendRel}  (has ${short(haveSha)}, pinned ${short(vendSha)})`);
      bad++;
      continue;
    }
    console.log(`✓ pinned ok    ${vendRel}  (${short(haveSha)})`);

    if (!monorepo) continue;

    // The stronger check, available only with the monorepo beside us. It is what catches a pinned
    // digest that was regenerated to bless an edit the canonical source never made.
    const from = join(MPESA, canonRel);
    if (!existsSync(from)) {
      console.error(`✗ MISSING     canonical ${canonRel} (monorepo at ${MPESA})`);
      bad++;
      continue;
    }
    const canonical = readFileSync(from, "utf8");
    const canonicalSha = full(canonical);
    if (canonicalSha !== canonSha) {
      console.error(
        `✗ PROVENANCE  ${canonRel}  (canonical is ${short(canonicalSha)}, pinned ` +
          `${short(canonSha)}) — the canonical catalog moved; resync this SDK`,
      );
      bad++;
      continue;
    }
    const transform = TARGETS.find(([, v]) => v === vendRel)[2];
    if (have !== transform(canonical)) {
      console.error(`✗ DRIFT       ${vendRel} differs from the transformed canonical bytes`);
      bad++;
      continue;
    }
    console.log(`✓ canonical ok ${vendRel}  (from ${canonRel} ${short(canonicalSha)})`);
  }

  if (bad > 0) {
    console.error(
      `\n${bad} problem${bad === 1 ? "" : "s"} with the vendored Daraja catalog.\n` +
        `Resync from the paylod monorepo: node scripts/sync-daraja-catalog.mjs`,
    );
    process.exit(1);
  }

  if (monorepo) {
    console.log(`\nAll copies match the pinned digests AND the canonical catalog at ${MPESA}.`);
  } else {
    // Stated plainly, and explicitly NOT a skip: the pinned verification above DID run over every
    // vendored file, and that is what this exit code reflects.
    console.log(
      `\nVERIFIED: all ${rows.length} vendored file(s) match the pinned digests in ${CHECKSUM_REL}.\n` +
        `The additional canonical comparison was not performed — the paylod monorepo is not checked\n` +
        `out at ${MPESA} (set MPESA_REPO=/path/to/mpesa to enable it). That is expected in CI and\n` +
        `does not weaken the verification above.`,
    );
  }
  process.exit(0);
}

// ── write mode: regenerate the copies AND the pinned-checksum file from canonical ───────────────

if (!existsSync(SRC)) {
  console.error(
    `✗ paylod monorepo not found at ${MPESA} (set MPESA_REPO=/path/to/mpesa)\n` +
      `  Write mode regenerates the vendored copies FROM the canonical catalog, so it needs the\n` +
      `  monorepo. To merely VERIFY the committed copies, run --check — that works in any checkout.`,
  );
  process.exit(1);
}

const rows = [];
for (const [canonRel, vendRel, transform] of TARGETS) {
  const from = join(MPESA, canonRel);
  if (!existsSync(from)) {
    console.error(`✗ missing canonical source: ${from}`);
    process.exit(1);
  }
  const canonical = readFileSync(from, "utf8");
  const want = transform(canonical);
  const to = join(SDK, vendRel);
  const have = existsSync(to) ? readFileSync(to, "utf8") : null;

  if (have === want) {
    console.log(`✓ up to date  ${vendRel}  (${sha(want)})`);
  } else {
    writeFileSync(to, want);
    console.log(`→ wrote       ${vendRel}  (${sha(want)})`);
  }
  // Recorded from the CANONICAL bytes, never from whatever is on disk here. Hashing the copy we
  // just wrote would make the record a tautology; hashing the source makes it provenance that the
  // copy has to live up to.
  rows.push([full(canonical), full(want), canonRel, vendRel]);
}

const wantSum = checksumBody(rows);
const haveSum = existsSync(CHECKSUM_PATH) ? readFileSync(CHECKSUM_PATH, "utf8") : null;
if (haveSum === wantSum) {
  console.log(`✓ up to date  ${CHECKSUM_REL}`);
} else {
  writeFileSync(CHECKSUM_PATH, wantSum);
  console.log(`→ wrote       ${CHECKSUM_REL}`);
}

console.log("\nSynced.");
