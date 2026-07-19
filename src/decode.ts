/**
 * THE PUBLIC OFFLINE DECODER, with the redaction the raw catalog function cannot carry.
 *
 * ── Why this module exists instead of an edit to `daraja-catalog.ts` ──────────────────────
 * `daraja-catalog.ts` is a GENERATED file. It is vendored byte-for-byte from the paylod
 * monorepo by `scripts/sync-daraja-catalog.mjs`, and `npm run check-catalog` fails the build if
 * it drifts. Editing it to add redaction would be undone by the next sync and would break the
 * drift check in the meantime — the fix would look applied and would not be.
 *
 * So the redaction lives HERE, in a wrapper this SDK owns, and `index.ts` exports the wrapper
 * under the public names. The generated classifier stays identical to the payment engine's,
 * which is the property the whole vendoring arrangement exists to guarantee.
 *
 * ── What it is protecting (spec 4.9) ──────────────────────────────────────────────────────
 * `decodeDarajaResult` is public, never touches the network, and is documented for "logs,
 * dashboards and support tooling" — exactly the sinks a credential must not reach. It
 * interpolates `resultDesc`, a server-controlled free-text field and the one most likely to
 * carry an echoed `Authorization` header, into `cause` and `customerMessage`. It had no
 * redaction at all, because having no response to redact made it look like it had nothing to
 * protect. An offline surface has no client to redact for it; it has to do its own.
 *
 * Only the SHAPE scan is possible here — this module holds no configured credentials, by design.
 * `Paylod#decodeError` additionally applies the exact-match scrub for the two values that client
 * does hold, so the method is covered by both rules and the bare function by the one that needs
 * no configuration.
 */
import { decodeDarajaResult as decodeDarajaResultRaw } from "./daraja-catalog.js";
import type { DecodedError } from "./daraja-catalog.js";
import { redactCredentialShapes } from "./grammar.js";

/**
 * Decode a Daraja result code offline, with any credential-shaped text scrubbed out of the
 * description before it can reach the returned object.
 *
 * Behaviourally identical to the generated classifier in every other respect: same codes, same
 * categories, same retryability. The description is the only input that carries server text, and
 * it is the only thing changed.
 */
export function decodeDarajaResult(
  resultCode: number | string | null | undefined,
  rawDesc?: string | null,
  family?: Parameters<typeof decodeDarajaResultRaw>[2],
): DecodedError {
  const safeDesc = typeof rawDesc === "string" ? redactCredentialShapes(rawDesc) : rawDesc;
  return decodeDarajaResultRaw(resultCode, safeDesc ?? null, family);
}
