/**
 * @paylod/node — the official Node/TypeScript client for the paylod API.
 *
 * NOT for the browser: your `PAYLOD_API_KEY` is a secret that can move money. Call this
 * from a server, a serverless function, or an edge worker — never from client-side code.
 */

export { Paylod, DEFAULT_BASE_URL } from "./client.js";
export type { ExpressLikeRequest, ExpressLikeResponse } from "./client.js";

export {
  PaylodError,
  PaylodApiError,
  PaylodConfigError,
  PaylodConnectionError,
  PaylodInvalidRequestError,
  PaylodSignatureVerificationError,
  PaylodTimeoutError,
} from "./errors.js";

export {
  decodeError,
  ERROR_CATALOG,
  type DarajaCategory,
  type DecodedError,
} from "./error-catalog.js";

export { normalizePhone } from "./phone.js";

export {
  verifyWebhook,
  signWebhook,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  DEFAULT_TOLERANCE_SEC,
  type VerifyParams,
} from "./webhook.js";

export type {
  CollectAck,
  CollectParams,
  Payment,
  PaymentResult,
  PaymentStatus,
  PaylodOptions,
  WaitOptions,
  WebhookEvent,
  WebhookEventType,
} from "./types.js";
