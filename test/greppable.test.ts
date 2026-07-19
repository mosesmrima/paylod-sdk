import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Conformance spec §8.7 — source files MUST stay greppable.
 *
 * A raw control byte in a source file makes it binary to `file(1)`, and GNU grep then treats it
 * as a binary file and prints nothing for a match. Not an error — no output. Every search for
 * anything in that file silently returns "not found".
 *
 * This is not hypothetical. Two of the four paylod SDKs shipped it:
 *
 *   - paylod-jvm: a NUL in `internal/Json.kt` hid the parse-depth constant. The redaction depth
 *     drifted to 8 against a parse bound of 64 and survived NINE review rounds, because every
 *     grep for the bound — by humans, by agents, and by the external reviewer — returned nothing
 *     and read as "the constant is not there".
 *   - paylod-sdk: a raw NUL and a raw DEL inside fixture strings in `test/fixes.test.ts` made all
 *     823 lines invisible. Any review grepping for what that file covers concluded it covered
 *     nothing.
 *
 * Both were written deliberately, to test handling of those bytes. That is a legitimate thing to
 * test — but the byte belongs in the SOURCE as an escape (`"\u0000"`), which produces an identical
 * runtime string while leaving the file readable by tooling.
 */

const TEXT_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".md"];

/** Bytes that make `file(1)` classify a file as data: C0 controls except tab/LF/CR, plus DEL. */
function rawControlBytes(buf: Buffer): { offset: number; byte: number }[] {
  const found: { offset: number; byte: number }[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    const isAllowedWhitespace = b === 0x09 || b === 0x0a || b === 0x0d;
    if ((b < 0x20 && !isAllowedWhitespace) || b === 0x7f) found.push({ offset: i, byte: b });
  }
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === "coverage") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

describe("conformance §8.7 — sources stay greppable", () => {
  const root = join(__dirname, "..");
  const files = [...walk(join(root, "src")), ...walk(join(root, "test")), ...walk(join(root, "scripts"))];

  // Guard the guard: if the walk ever returns nothing, this suite would pass while checking
  // nothing at all — the exact vacuity §8.3 exists to prevent.
  it("actually inspects a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("no source file contains a raw control byte", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const hits = rawControlBytes(readFileSync(file));
      if (hits.length > 0) {
        const where = hits
          .slice(0, 3)
          .map((h) => `offset ${h.offset} (0x${h.byte.toString(16).padStart(2, "0")})`)
          .join(", ");
        offenders.push(`${file.slice(root.length + 1)}: ${where}`);
      }
    }
    expect(
      offenders,
      `Raw control bytes make a file binary to grep, so searches silently return nothing.\n` +
        `Write the byte as an escape instead — "\\u0000" produces an identical runtime string.\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("detects a raw control byte when one is present", () => {
    // Positive control: proves the detector can fail, so a green result means something.
    expect(rawControlBytes(Buffer.from("ok", "utf8"))).toEqual([]);
    expect(rawControlBytes(Buffer.from([0x61, 0x00, 0x62]))).toEqual([{ offset: 1, byte: 0x00 }]);
    expect(rawControlBytes(Buffer.from([0x61, 0x7f]))).toEqual([{ offset: 1, byte: 0x7f }]);
  });
});
