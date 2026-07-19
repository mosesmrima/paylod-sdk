/**
 * THE RECONCILIATION ENVELOPE.
 *
 * One rule, in one place: if anything goes wrong on a money-moving call, the error the caller
 * catches MUST carry the handles needed to find out what happened to the charge — the
 * `idempotencyKey` (which lets them replay the SAME attempt instead of minting a fresh one that
 * double-charges) and, once it exists, the `paymentId` (which lets them READ it).
 *
 * ── Why this is its own module ────────────────────────────────────────────────────────────
 * It used to be a private function in `client.ts`, which meant it protected the production
 * client and nothing else. The SIMULATOR — the surface every integrator's test suite runs
 * against, and the one whose entire promise is "your charge path runs unchanged" — had no
 * envelope at all: `simulate.collect()` failures escaped with no key, `simulate.outcome()`
 * failures escaped with no key, and `simulate.pay()` lost the payment id it had just been
 * acknowledged. So a test written to assert "on failure I can still reconcile" passed against
 * production and would have failed against the simulator, which is the exact inversion the
 * simulator exists to prevent.
 *
 * Lifting it here makes the envelope a property of the SDK rather than of one class, so a new
 * dispatch surface gets it by importing it rather than by remembering to reimplement it.
 */

import { PaylodConnectionError, PaylodError } from "./errors.js";

/**
 * Render ANY throwable to a string WITHOUT the rendering being able to throw.
 *
 * `String(err)` looks total and is not. It invokes `err.toString()` / `Symbol.toPrimitive` /
 * `err.message`'s getter — all attacker- or library-controlled code — and every one of them can
 * throw. It also throws outright on a null-prototype object (no `toString` at all) and on a
 * `Symbol`. That mattered here more than anywhere else in the SDK, because the ONE call site was
 * inside `withIdempotencyKey`: the function whose entire job is to guarantee that no matter what
 * failed, the caller ends up holding the idempotency key and payment id needed to reconcile a
 * charge that may already be in flight.
 *
 * When the render threw, it threw from INSIDE the reconciliation wrapper, before the wrapped
 * `PaylodError` had been constructed. The original error was discarded and a bare `Error` escaped
 * carrying neither handle — so the single failure mode most likely to involve a hostile or exotic
 * throwable was also the one that stripped the recovery information. The safety net had a hole in
 * exactly the shape of the thing it was there to catch.
 *
 * Every step is guarded and there is a fixed fallback, so this function cannot throw.
 */
export function renderThrowable(err: unknown): string {
  try {
    if (err instanceof Error) {
      const m = err.message;
      if (typeof m === "string") return m;
    }
    if (typeof err === "string") return err;
    if (err === null) return "null";
    if (err === undefined) return "undefined";
    if (typeof err === "symbol") return err.description ?? "Symbol()";
    if (typeof err === "object") {
      const m = (err as { message?: unknown }).message;
      if (typeof m === "string") return m;
    }
    const s = String(err);
    return typeof s === "string" ? s : "[unrenderable throwable]";
  } catch {
    // A throwing `toString`/`message` getter, a null-prototype object, a revoked Proxy. The
    // detail is lost; the KEY and the PAYMENT ID — the things that actually matter — are not.
    return "[unrenderable throwable]";
  }
}

/**
 * `err instanceof PaylodError` WITHOUT the check being able to throw.
 *
 * `instanceof` is not an inspection, it is a CALL: it invokes the `[Symbol.hasInstance]` of the
 * right operand and, failing that, walks the left operand's prototype chain — which for a `Proxy`
 * means invoking its `getPrototypeOf` trap. That trap is attacker-controlled code and it can
 * throw. `renderThrowable` was guarded for exactly this reason and this line, three above it, was
 * not: a Proxy whose `getPrototypeOf` throws blew up on the FIRST statement of the reconciliation
 * wrapper, before either handle had been attached to anything, and escaped as a bare `Error`
 * carrying neither the idempotency key nor the payment id.
 *
 * That is the worst possible shape for this bug. The wrapper exists so that no matter what
 * failed, the caller ends up holding the handles to a charge that may already be live — and the
 * one input most likely to be hostile was the one input that defeated it.
 */
function isPaylodError(err: unknown): err is PaylodError {
  try {
    return err instanceof PaylodError;
  } catch {
    return false;
  }
}

/** Redact WITHOUT the redactor being able to throw. A caller-supplied closure is caller code. */
function safeRedact(redact: (s: string) => string, s: string): string {
  try {
    const out = redact(s);
    return typeof out === "string" ? out : "[unrenderable throwable]";
  } catch {
    // The detail is lost rather than leaked — an unredacted string is the one thing we must not
    // fall back to, because redaction is what keeps the bearer key out of this message.
    return "[redaction failed; detail withheld]";
  }
}

/**
 * THE ENVELOPE. It returns an error carrying both handles, and it CANNOT THROW.
 *
 * "Cannot throw" is the actual contract, not a nice property. Every call site is a `catch` block
 * on a money-moving path, and the value it is handed came from arbitrary code — a caller-supplied
 * `fetch`, an interceptor, an instrumentation wrapper, a Proxy. If this function throws, whatever
 * it throws replaces the error the caller was about to receive, and the handles go with it. So
 * the whole body is guarded and there is an unconditional final fallback that carries both.
 */
export function withIdempotencyKey(
  err: unknown,
  key: string,
  redact: (s: string) => string,
  paymentId?: string,
): unknown {
  try {
    return reconcile(err, key, redact, paymentId);
  } catch {
    // NOTHING gets past this. Not a throwing trap, not an exhausted stack, not a bug in the
    // guarding above. A caller holding a possibly-live charge gets the handles regardless.
    const wrapped = new PaylodConnectionError(
      "The charge attempt failed, the failure itself could not be inspected, and its state is " +
        "INDETERMINATE. Read the payment with this error's idempotencyKey before starting any " +
        "new attempt; do NOT mint a fresh key, which risks charging the customer a second time.",
    );
    try {
      wrapped.idempotencyKey = key;
      if (paymentId !== undefined) wrapped.paymentId = paymentId;
    } catch {
      /* unreachable: a fresh error we constructed is never frozen */
    }
    return wrapped;
  }
}

function reconcile(
  err: unknown,
  key: string,
  redact: (s: string) => string,
  paymentId?: string,
): unknown {
  if (isPaylodError(err)) {
    // One of ours. Fill in whichever half of the handle is missing, in place where we can. Never
    // clobber a value the error already set — the site that raised it knew more than we do.
    //
    // Both halves matter and they do different jobs: the KEY lets the caller replay the same
    // attempt instead of minting a fresh one (which double-charges), and the PAYMENT ID lets them
    // READ it. The sibling JVM SDK lost both when a non-`Exception` `Error` escaped after the
    // acknowledgement, leaving a caller holding a possibly-live charge with no handle on it at all.
    try {
      if (err.idempotencyKey === undefined) err.idempotencyKey = key;
      if (paymentId !== undefined && err.paymentId === undefined) err.paymentId = paymentId;
      const keyOk = err.idempotencyKey !== undefined;
      const idOk = paymentId === undefined || err.paymentId !== undefined;
      if (keyOk && idOk) return err;
    } catch {
      /* frozen / read-only — wrap below */
    }
  }

  // Anything else: a foreign Error, a frozen error, or a thrown primitive. Wrap it in an SDK error
  // that definitely carries the key. The state of the charge is unknown, so this is INDETERMINATE
  // — the caller must read the payment with this key, never blind-retry with a new one.
  // Redacted: a foreign error from a caller-supplied fetch can easily quote the request headers,
  // and the bearer key with them.
  const detail = safeRedact(redact, renderThrowable(err));
  const wrapped = new PaylodConnectionError(
    `The charge attempt failed and its state is INDETERMINATE (${detail}). Read the payment ` +
      "with this error's idempotencyKey before starting any new attempt; do NOT mint a fresh " +
      "key, which risks charging the customer a second time.",
  );
  wrapped.idempotencyKey = key;
  if (paymentId !== undefined) wrapped.paymentId = paymentId;
  return wrapped;
}

