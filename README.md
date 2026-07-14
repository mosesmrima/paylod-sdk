# @paylod/node

The official Node/TypeScript client for the **paylod API** — M-Pesa collections without the Daraja boilerplate.

You send one call. paylod hosts the Daraja callback, refreshes the OAuth token, decodes the result code, and POSTs you a signed webhook when the money lands.

> **Not to be confused with [`@paylod/daraja`](https://github.com/paylod/daraja).** That package is a *raw Daraja SDK* — it talks to Safaricom directly, and you host the callback, manage the token, and decode the codes yourself. **This** package talks to **paylod**, which does all of that for you. Different product, different endpoint, different job.

---

## Install

```bash
npm install @paylod/node
```

Requires **Node 18+** (global `fetch`). **Zero runtime dependencies.**

## Quickstart

```ts
import { Paylod } from "@paylod/node";

const paylod = new Paylod(); // reads PAYLOD_API_KEY from the environment

const result = await paylod.collectAndWait({ amount: 100, phone: "0712345678" });

if (result.ok) console.log(`Paid · ${result.receipt}`);
else           console.log(result.error.customerMessage);
```

That's the whole integration. `collectAndWait` sends the STK prompt, polls with a sane backoff, and hands you a settled outcome.

---

## Why not just use `fetch`?

**Honestly: `fetch` works.** The happy path is about eight lines, and you don't need us for it:

```js
const r = await fetch("https://paylod.dev/functions/v1/collect", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ amount: 100, phone: "254712345678" }),
});
const { paymentId } = await r.json(); // 202 { paymentId, status: "pending", ... }
```

This SDK is not here to save you those lines. It's here for the five things that people reliably get wrong *after* those lines:

| The thing | What goes wrong with hand-rolled `fetch` | What you get here |
|---|---|---|
| **Async settlement** | `/collect` returns `202 pending`. The customer hasn't typed their PIN yet. People hand-roll a `while (true)` poll, hammer the API every 200 ms, or never handle the case where the customer just walks away. | `collectAndWait()` — jittered backoff (1s → 5s), a deadline, and a distinct, loud `PaylodTimeoutError`. |
| **Idempotency** | A retry (or a nervous double-click, or a Lambda re-invoke) without an `Idempotency-Key` sends a **second STK push**. The customer pays twice. Most people forget the header entirely. | A key is generated on **every** `collect()`, and reused across internal retries. You cannot accidentally double-charge. |
| **Webhook signatures** | HMAC over `${timestamp}.${rawBody}`, constant-time compare, timestamp tolerance, and the raw body must survive your JSON middleware. Every one of those is easy to get subtly, silently wrong — and getting it wrong means anyone can forge a "payment succeeded". | `paylod.webhook(handler)` — verified, typed, and it shouts at you if your body parser ate the raw bytes. |
| **Error decoding** | You end up writing `switch (resultCode) { case 1032: ... case 2001: ... }` from a forum post, with wrong text. (`2001` is a *wrong PIN* — it is **not** a credentials error, despite what the raw `ResultDesc` implies.) | `result.error.customerMessage` — already decoded, server-side, from the same catalog. Ready to hand to `toast.error()`. |
| **Phone formats** | Customers give you `0712…`, `+254712…`, `254712…`, `0712 345 678`. Daraja accepts exactly one of those. | Normalised locally, before the request leaves your process. |

If you only ever need to fire-and-forget an STK push and you already have a webhook consumer you trust, `fetch` is genuinely fine. Use it. The SDK earns its keep the moment you need to *wait* for the money, or *trust* the webhook.

---

## Setup

```bash
PAYLOD_API_KEY=mp_live_xxxxxxxx
PAYLOD_WEBHOOK_SECRET=whsec_xxxxxxxx   # only needed if you consume webhooks
PAYLOD_BASE_URL=https://paylod.dev/functions/v1   # optional; this is the default
```

Or pass them explicitly:

```ts
const paylod = new Paylod({
  apiKey: process.env.PAYLOD_API_KEY,
  webhookSecret: process.env.PAYLOD_WEBHOOK_SECRET,
  baseUrl: "https://paylod.dev/functions/v1", // default
  timeoutMs: 30_000,   // per HTTP request
  maxRetries: 2,       // for transient failures only (network, 5xx, 429)
});
```

### Base URL

The default is **`https://paylod.dev/functions/v1`** — the base that currently routes. Some docs advertise `https://api.paylod.dev/v1`; that hostname is not live yet. When it is, point `baseUrl` (or `PAYLOD_BASE_URL`) at it. Nothing else changes.

### ⚠️ Server-side only — this is **not** browser-safe

Your `PAYLOD_API_KEY` can move money. Anything shipped to a browser is public: reading it out of a bundle, a network tab, or a source map is trivial. Call this SDK from a server, a serverless function, or an edge worker.

(The paylod *demo* app does put a key in the browser. That is a deliberate, sandbox-keyed exception so the demo can be served from a static file server. Do not copy the pattern.)

---

## API

### `new Paylod(options?)`

| Option | Type | Default |
|---|---|---|
| `apiKey` | `string` | `process.env.PAYLOD_API_KEY` |
| `baseUrl` | `string` | `process.env.PAYLOD_BASE_URL` ?? `https://paylod.dev/functions/v1` |
| `webhookSecret` | `string` | `process.env.PAYLOD_WEBHOOK_SECRET` |
| `timeoutMs` | `number` | `30_000` |
| `maxRetries` | `number` | `2` |
| `fetch` | `typeof fetch` | global `fetch` |

Throws `PaylodConfigError` if no API key can be found.

---

### `collect(params, options?) → Promise<CollectAck>`

Fire the STK push and return as soon as the prompt is on the phone.

```ts
const ack = await paylod.collect({
  amount: 100,                    // positive INTEGER KES, ≤ 150000 (M-Pesa rejects decimals)
  phone: "0712345678",            // any Kenyan format
  accountReference: "order-42",   // optional, ≤ 12 chars — shown on the handset
  description: "Coffee",          // optional, ≤ 64 chars — shown on the prompt
  metadata: { orderId: "42" },    // optional, echoed back on the webhook
  idempotencyKey: "order-42",     // optional — one is generated if you omit it
});

// { paymentId, status: "pending", checkoutRequestId, idempotencyKey }
```

`amount`, `phone`, and the field lengths are validated **locally** — bad input throws `PaylodInvalidRequestError` before a byte hits the network.

---

### `status(paymentId) → Promise<Payment>`

```ts
const p = await paylod.status(ack.paymentId);
// { id, status: "pending" | "success" | "failed", mpesaReceipt, resultCode, resultDesc }
```

> Note the states: **`success`**, not `paid`.

---

### `wait(paymentId, options?) → Promise<PaymentResult>`

Poll an existing payment until it settles.

### `collectAndWait(params, options?) → Promise<PaymentResult>`

`collect()` + `wait()`.

```ts
const result = await paylod.collectAndWait(
  { amount: 100, phone: "0712345678" },
  {
    timeoutMs: 120_000,                    // default; STK prompts expire around 60s
    onPoll: (p) => console.log(p.status),  // called on each pending snapshot
    signal: controller.signal,             // optional AbortSignal
  },
);
```

Polling ramps 1s → 1s → 1.5s → 2s → 2.5s → 3s → 4s → 5s (capped), each with ±20% jitter so a fleet of servers doesn't poll in lockstep.

---

### The result type: a discriminated union, not an exception

```ts
type PaymentResult =
  | { ok: true;  receipt: string;       payment: Payment }
  | { ok: false; error: DecodedError;   payment: Payment };
```

```ts
const result = await paylod.collectAndWait({ amount: 100, phone: "0712345678" });

if (result.ok) {
  await fulfilOrder(result.receipt);      // string, narrowed — no null check needed
} else {
  toast.error(result.error.customerMessage);
  if (result.error.retryable) showRetryButton();
}
```

**Why not throw?** Because *a wrong PIN is not an exception — it's an answer.* Cancellations, wrong PINs, and low balances are the single most common thing that happens to a payment request. They are business outcomes, and the type system should force you to handle them, which `try/catch` never does: a forgotten `catch` is invisible, while a forgotten `if (result.ok)` is a compile error. Throwing for routine outcomes is how you end up with a codebase that treats "customer changed their mind" as a 500.

**So what *does* throw?** Only things that are genuinely exceptional:

| Throws | When |
|---|---|
| `PaylodInvalidRequestError` | You passed a bad amount/phone. A bug in your code. |
| `PaylodConfigError` | No API key. A bug in your deploy. |
| `PaylodApiError` | Non-2xx from paylod (`.status`, `.isAuthError`, `.isRateLimited`, `.isIdempotencyConflict`). |
| `PaylodConnectionError` | The network failed after retries. |
| `PaylodTimeoutError` | Still `pending` at the deadline. |

**`PaylodTimeoutError` deserves a word.** It throws *on purpose*, and it is deliberately **not** folded into the `ok: false` branch. A timeout is not a failed payment — the customer may still be staring at the prompt, and may still pay. If we returned `{ ok: false }` you'd cancel an order that is about to settle, or refund money you never lost. Handle it explicitly:

```ts
try {
  const result = await paylod.collectAndWait({ amount: 100, phone: "0712345678" });
  // ...
} catch (err) {
  if (err instanceof PaylodTimeoutError) {
    // NOT failed. Leave the order pending — the webhook will settle it.
    await markPending(err.paymentId);
  } else throw err;
}
```

---

### `decodeError(resultCode, rawDesc?) → DecodedError`

Offline. No network, no API call.

```ts
paylod.decodeError(1032);
// {
//   code: "1032",
//   title: "Payment cancelled by the customer",
//   cause: "The customer received the STK prompt but pressed Cancel instead of entering their M-Pesa PIN. No money moved.",
//   fix: "Nothing is wrong with your setup — offer a clear retry so the customer can try again.",
//   category: "customer",       // customer | balance | limit | credentials | network | mpesa_system | success
//   retryable: true,
//   customerMessage: "Payment cancelled — you can try again whenever you're ready.",
// }
```

`customerMessage` is written to be shown to an end user verbatim. The strings are byte-identical to the ones paylod puts in `event.data.decoded`, so your UI reads the same whether it came from a poll or a webhook.

Also exported standalone: `import { decodeError, ERROR_CATALOG } from "@paylod/node"`.

---

## Webhooks

paylod POSTs a signed JSON body to your endpoint when a payment settles.

```
POST /your/webhook
x-webhook-signature: t=1700000000,v1=<hex hmac-sha256>
x-webhook-id: <event id>
x-webhook-event: payment.success
```

The signature is `HMAC-SHA256(secret, "${t}.${rawBody}")`. The SDK verifies it, checks the timestamp against a 300s tolerance (anti-replay), constant-time compares, and hands you a typed event.

### Express / Connect

```ts
import express from "express";
import { Paylod } from "@paylod/node";

const app = express();
const paylod = new Paylod();

app.post(
  "/webhooks/paylod",
  express.raw({ type: "application/json" }),   // ← keep the RAW bytes
  paylod.webhook(async (event) => {
    if (event.type === "payment.success") {
      await fulfil(event.data.paymentId, event.data.mpesaReceipt);
    } else {
      await markFailed(event.data.paymentId, event.data.decoded!.customerMessage);
    }
  }),
);

app.use(express.json()); // everything else can be parsed normally
```

Responds `400` on a bad signature (handler never runs), `500` if your handler throws (so paylod retries), `200` otherwise.

> **The raw body is load-bearing.** `JSON.stringify(JSON.parse(body))` does not reliably reproduce the same bytes, so a re-serialised body will fail verification. Mount the webhook route *before* a global `express.json()`, or give it `express.raw()`. If a parser has already eaten the bytes, the SDK returns a loud `400` that says exactly that — it will never "helpfully" skip verification.

### Next.js / Hono / Remix / Cloudflare Workers / Bun / Deno

```ts
// app/api/webhooks/paylod/route.ts
import { Paylod } from "@paylod/node";

const paylod = new Paylod();

export const POST = paylod.webhookHandler(async (event) => {
  if (event.type === "payment.success") await fulfil(event.data.paymentId);
});
```

`webhookHandler` takes a Web `Request` and returns a `Response`, so it drops straight into any fetch-style runtime. (Next.js App Router gives you the raw body automatically — no config needed.)

### Manual verification

```ts
const event = paylod.verifyWebhook({
  payload: rawBodyStringOrBuffer,
  signature: req.headers["x-webhook-signature"],
  secret: process.env.PAYLOD_WEBHOOK_SECRET,  // optional if set on the client
  toleranceSec: 300,                          // optional; 0 disables the freshness check
});
```

Throws `PaylodSignatureVerificationError` (with `.reason`: `missing_signature` | `malformed_signature` | `stale_timestamp` | `no_match` | `invalid_payload`) on any failure. It never returns a half-trusted value.

### The event

```ts
interface WebhookEvent {
  type: "payment.success" | "payment.failed";
  created: number;               // unix seconds; signed, so it can't be forged
  data: {
    paymentId: string;
    applicationId: string;
    env: "sandbox" | "production";
    status: "pending" | "success" | "failed";
    amount: number;
    phone: string;
    accountRef: string | null;
    mpesaReceipt: string | null;
    checkoutRequestId: string | null;
    resultCode: number | null;
    resultDesc: string | null;
    decoded: DecodedError | null;   // populated on payment.failed, null on success
  };
}
```

**Deliveries can repeat.** Retries and a lost 200 both look the same from our side. Key your fulfilment on `data.paymentId` (or the `x-webhook-id` header) and make it idempotent.

---

## Idempotency

Every `collect()` sends an `Idempotency-Key`. If you don't supply one, a UUID is generated and returned on the ack.

```ts
const ack = await paylod.collect({ amount: 100, phone: "0712345678" });
ack.idempotencyKey; // persist this if you might retry this exact charge
```

- **Same key + same body** → paylod replays the original `202`. No second STK prompt. No double charge.
- **Same key + different body** → `409`, surfaced as `PaylodApiError` with `.isIdempotencyConflict === true`. That is always a bug on your side (you changed the amount but kept the key).
- **Internal retries** (network blip, 5xx, 429) reuse the *same* key, which is precisely what makes retrying a `POST` safe.

For a charge tied to a business object, pass a stable key — then a retry of your whole handler is free:

```ts
await paylod.collect({ amount, phone, idempotencyKey: `order-${orderId}` });
```

---

## Error handling, end to end

```ts
import {
  Paylod, PaylodApiError, PaylodTimeoutError,
  PaylodInvalidRequestError, PaylodConnectionError,
} from "@paylod/node";

try {
  const result = await paylod.collectAndWait({ amount, phone });

  if (result.ok) return { paid: true, receipt: result.receipt };
  return { paid: false, message: result.error.customerMessage, retry: result.error.retryable };

} catch (err) {
  if (err instanceof PaylodTimeoutError)        return { pending: true, paymentId: err.paymentId };
  if (err instanceof PaylodInvalidRequestError) throw err;                      // your bug
  if (err instanceof PaylodApiError && err.isRateLimited) return { retryAfter: true };
  if (err instanceof PaylodApiError && err.isAuthError)   throw err;            // bad key
  if (err instanceof PaylodConnectionError)     return { pending: true };       // unknown — don't assume failure
  throw err;
}
```

---

## Testing your integration

`signWebhook` is exported so you can build realistic fixtures without a network:

```ts
import { signWebhook } from "@paylod/node";

const raw = JSON.stringify(myFakeEvent);
const signature = signWebhook(raw, process.env.PAYLOD_WEBHOOK_SECRET!);
await request(app).post("/webhooks/paylod")
  .set("x-webhook-signature", signature)
  .set("content-type", "application/json")
  .send(Buffer.from(raw));
```

And inject a fake `fetch` to test collection flows:

```ts
const paylod = new Paylod({ apiKey: "mp_test_x", fetch: myMockFetch });
```

---

## License

MIT
