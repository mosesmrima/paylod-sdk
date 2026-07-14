#!/usr/bin/env node
/**
 * Pull THE Daraja code table + classifier into this SDK from its canonical home.
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
 *   node scripts/sync-daraja-catalog.mjs           # write the copies
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

const BANNER = (from) =>
  `// GENERATED FILE — DO NOT EDIT.\n` +
  `// Source of truth: mpesa/${from}\n` +
  `// Regenerate: node scripts/sync-daraja-catalog.mjs\n`;

/** [canonical, generated copy, transform] */
const TARGETS = [
  [join(SRC, "daraja-error-codes.json"), join(SDK, "src/daraja-error-codes.json"), (s) => s],
  [
    join(SRC, "daraja-catalog.ts"),
    join(SDK, "src/daraja-catalog.ts"),
    (s) => BANNER("supabase/functions/_shared/daraja/daraja-catalog.ts") + s,
  ],
];

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const check = process.argv.includes("--check");

if (!existsSync(SRC)) {
  // A published-package consumer or a CI job without the monorepo cannot sync. The generated
  // files are committed, so that is fine — just don't pretend we verified them.
  const msg = `paylod monorepo not found at ${MPESA} (set MPESA_REPO=/path/to/mpesa)`;
  if (check) {
    console.warn(`⚠ skipping drift check: ${msg}`);
    process.exit(0);
  }
  console.error(`✗ ${msg}`);
  process.exit(1);
}

let drifted = 0;
for (const [from, to, transform] of TARGETS) {
  const want = transform(readFileSync(from, "utf8"));
  const have = existsSync(to) ? readFileSync(to, "utf8") : null;
  const rel = to.replace(SDK, "").replace(/^\//, "");

  if (have === want) {
    console.log(`✓ up to date  ${rel}  (${sha(want)})`);
    continue;
  }
  drifted++;
  if (check) {
    console.error(`✗ DRIFT       ${rel}  (has ${have ? sha(have) : "missing"}, want ${sha(want)})`);
    continue;
  }
  writeFileSync(to, want);
  console.log(`→ wrote       ${rel}  (${sha(want)})`);
}

if (check && drifted > 0) {
  console.error(
    `\n${drifted} generated cop${drifted === 1 ? "y has" : "ies have"} drifted from the canonical ` +
      `Daraja catalog.\nRun: node scripts/sync-daraja-catalog.mjs`,
  );
  process.exit(1);
}
console.log(check ? "\nAll copies match the canonical catalog." : "\nSynced.");
