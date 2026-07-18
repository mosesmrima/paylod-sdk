/**
 * @paylod/node — the official Node/TypeScript client for the paylod API.
 *
 * NOT for the browser: your `PAYLOD_API_KEY` is a secret that can move money. Call this
 * from a server, a serverless function, or an edge worker — never from client-side code.
 */

export { Paylod, DEFAULT_BASE_URL, MAX_JSON_DEPTH, MAX_WEBHOOK_BODY_BYTES } from "./client.js";
export { MAX_RESPONSE_BYTES } from "./transport.js";
export type { ExpressLikeRequest, ExpressLikeResponse } from "./client.js";

export {
  PaylodError,
  PaylodApiError,
  PaylodConfigError,
  PaylodConnectionError,
  PaylodInvalidRequestError,
  PaylodResponseTooLargeError,
  PaylodSandboxOnlyError,
  PaylodSecurityError,
  PaylodTerminalTransportError,
  PaylodSignatureVerificationError,
  PaylodTimeoutError,
} from "./errors.js";

/**
 * The sandbox simulator — `paylod.simulate`. Drive a payment to any of the five outcomes
 * (approve / wrong PIN / insufficient funds / cancelled / timeout) from a test file, with no
 * phone. Real payment row, real Daraja codes, real signed webhook; only the handset is fiction.
 * Sandbox (`mp_test_`) keys only, enforced locally.
 */
export {
  Simulator,
  SIM_OUTCOMES,
  type SimOutcomeId,
  type SimOutcomeChoice,
  type SimulateCollectParams,
  type SimulateCollectParamsBase,
  type SimulatedOutcome,
  type SimulatedPayment,
} from "./simulate.js";

/**
 * The renderable result. This is the type you build your UI on:
 *   <p>{outcome.message}</p>
 *   {outcome.retryable && <button>Try again</button>}
 */
export { toOutcome, pendingOutcome, type OutcomeStatus, type PaymentOutcome } from "./outcome.js";

/**
 * The Daraja code table + classifier. GENERATED from the canonical copy in the paylod monorepo
 * (`scripts/sync-daraja-catalog.mjs`) — never hand-edited here. You do not need any of this to
 * render a payment; it is exposed for logs, dashboards and support tooling.
 */
export {
  decodeDarajaResult,
  decodeDarajaResult as decodeError,
  classifyStkResult,
  ERROR_CATALOG,
  ALL_ENTRIES,
  PENDING_RESULT_CODES,
  type CatalogEntry,
  type DarajaCategory,
  type DecodedError,
  type StkOutcome,
} from "./daraja-catalog.js";

export { normalizePhone, normalizeMsisdn, isValidMsisdn, MSISDN_INPUT_RE } from "./phone.js";

export {
  verifyWebhook,
  verifyWebhookSignature,
  signWebhook,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  DEFAULT_TOLERANCE_SEC,
  MAX_TOLERANCE_SEC,
  type VerifyParams,
} from "./webhook.js";

/**
 * The semantic model — the ONE total (claim x evidence) table every verdict comes from. Exposed
 * so the sibling SDKs and their conformance tests can assert against the same rules.
 */
export {
  judge,
  evidenceFor,
  hasReceipt,
  hasResultCode,
  type PaymentEvidence,
  type PaymentJudgement,
  type PaymentVerdict,
} from "./semantics.js";

export type {
  CollectAck,
  CollectParams,
  CollectParamsBase,
  IdempotencyParams,
  Payment,
  PaymentStatus,
  PaylodOptions,
  WaitOptions,
  WebhookEvent,
  WebhookEventType,
} from "./types.js";
