# @paylod/node

The official Node/TypeScript client for the **paylod API**. This SDK does M-Pesa collections without the Daraja boilerplate.

You send one call. paylod hosts the Daraja callback, refreshes the OAuth token, and decodes the result code. paylod then sends you a signed webhook when the payment settles.

> **This package is not [`@paylod/daraja`](https://github.com/paylod/daraja).** That package is a raw Daraja SDK. It sends requests to Safaricom directly. With that package, you host the callback, you manage the access token, and you decode the result codes. **This** package sends requests to **paylod**. paylod does all of those tasks for you. The two packages are different products, with different endpoints and different functions.

---

## Install

```bash
npm install @paylod/node
```

This SDK requires **Node 18+** for the global `fetch` function. The SDK has **zero runtime dependencies**.

## Quickstart

> [!WARNING]
> Call this SDK from a server only. Your `PAYLOD_API_KEY` can move money. Never ship the key in a
> browser bundle, a mobile application, or any other client.

Pass an idempotency key on every collect call. Mint one key for each payment attempt. Duplicates of that attempt collapse into one STK push and one charge. A double-clicked Pay button, a refreshed tab, and a redelivered job are duplicates of one attempt. Do not use the order id or the product id as the key. A retry after a wrong PIN is a new attempt, and it needs a new key.

```ts
import { Paylod } from "@paylod/node";

const paylod = new Paylod(process.env.PAYLOD_API_KEY!);

const attempt = await db.attempts.create({ orderId: order.id });   // a row per press of Pay

const outcome = await paylod.collectAndWait({
  amount: 100,
  phone: "0712345678",
  idempotencyKey: attempt.id,   // ← one key per payment ATTEMPT. A double-click cannot charge twice.
});

if (outcome.paid) fulfil(outcome.receipt);   // money moved
else              toast(outcome.message);    // already decoded, already human
```

That code is the complete integration. `collectAndWait` sends the STK push. `collectAndWait` then polls at an increasing interval, and returns an outcome that you can **render**.

> [!WARNING]
> The idempotency key is required. The SDK refuses a collect call without one, before the call
> leaves your process. For more information, see [Idempotency](#idempotency).

**You give one argument, and you get one renderable outcome.** You pass an API key. You do not pass a base URL, a configuration object, or an OAuth token. You get back a `message` that a customer can read. You also get a `retryable` flag that controls a retry button. Your application needs no result code table:

```tsx
<p>{outcome.message}</p>
{outcome.retryable && <button onClick={retry}>Try again</button>}
```

> **Do not write `if (code === 1032)` in your application.** paylod decodes the M-Pesa result codes for you. For more information, see [The outcome](#the-outcome-one-renderable-shape).

---

## Why not just use `fetch`?

**`fetch` works.** The success path is approximately eight lines of code. You do not need this SDK for those lines:

```js
const r = await fetch("https://paylod.dev/functions/v1/collect", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ amount: 100, phone: "254712345678" }),
});
const { paymentId } = await r.json(); // 202 { paymentId, status: "pending", ... }
```

This SDK does not replace those lines. This SDK controls the five conditions that occur *after* those lines:

| The subject | The problem with a manual `fetch` | The SDK behaviour |
|---|---|---|
| **Async settlement** | `/collect` returns `202 pending`. The customer did not enter the PIN yet. A manual `while (true)` poll can send a request every 200 ms. A manual poll can also ignore the customer who does not answer. | `collectAndWait()` polls at an interval that increases from 1s to 5s, with jitter. The method applies a deadline, and it throws a distinct `PaylodTimeoutError`. |
| **Idempotency** | A collect call without an `Idempotency-Key` sends a **second STK push**. The customer then pays twice. A retry, a double-clicked Pay button, and a repeated Lambda invocation all cause this result. Many developers omit the header. | `idempotencyKey` is **required**. The TypeScript compiler refuses a call without the key. Pass one key for each payment attempt. Duplicates of that attempt collapse into one charge and one STK push. |
| **Webhook signatures** | You must compute an HMAC over `${timestamp}.${rawBody}`, compare in constant time, and apply a timestamp tolerance. The raw body must also survive your JSON middleware. Each of these steps can fail silently. An incorrect check lets an attacker forge a successful payment. | `paylod.webhook(handler)` verifies the signature and returns a typed event. The handler returns a clear error if your body parser modified the raw bytes. |
| **Error decoding** | You write `switch (resultCode) { case 1032: ... case 2001: ... }` from a forum post, and the text is incorrect. Result code `2001` is a *wrong PIN*. Result code `2001` is **not** a credentials error, although the raw `ResultDesc` suggests a credentials error. | `outcome.message` is already decoded. The message comes from the same catalog that the API uses. Render the message directly. |
| **Phone formats** | Customers enter `0712…`, `+254712…`, `254712…`, and `0712 345 678`. Daraja accepts exactly one of these formats. | The SDK normalises the number locally, before the request leaves your process. |

Use `fetch` if you only send an STK push, and if you already have a webhook consumer that you trust. Use this SDK when you must wait for the payment outcome, or when you must verify the webhook.

---

## Setup

**One environment variable.**

```bash
PAYLOD_API_KEY=mp_live_xxxxxxxx
```

```ts
const paylod = new Paylod(process.env.PAYLOD_API_KEY!);
// …or just `new Paylod()` — with no argument it reads PAYLOD_API_KEY itself.
```

You configure no base URL. The base URL is the same for every paylod customer, so the SDK contains the value. You fetch, cache, and refresh no OAuth token. You host no callback URL.

Add the signing secret if you consume webhooks. paylod shows the secret one time, when you create the endpoint:

```bash
PAYLOD_WEBHOOK_SECRET=whsec_xxxxxxxx   # only if you consume webhooks
```

### Optional overrides (most applications need none of these)

> **Set `baseUrl` to an `https://` origin.** A plaintext origin sends your API key without
> encryption, and it permits SSRF and redirection attacks. The SDK refuses a plaintext origin at
> construction. The SDK permits a loopback stub (`http://localhost`, `http://127.0.0.1`) **only**
> with `allowInsecureBaseUrl: true`. Never use that option with an `mp_live_` key.

```ts
const paylod = new Paylod(key, {
  baseUrl: "https://paylod.dev/functions/v1", // https required; self-host or a stub
  timeoutMs: 30_000,                          // per HTTP request
  maxRetries: 2,                              // transient failures only (network, 5xx, 429)
  fetch: myFetch,                             // inject an instrumented fetch
  // allowInsecureBaseUrl: true,              // TEST ONLY: permit http://localhost — never with a live key
});
```

> **Maintainer note:** other documents give the base URL `https://api.paylod.dev/v1`. That hostname **does not route**. The hostname returns a 307 redirect to `/signin`. The correct base URL, and the default value here, is `https://paylod.dev/functions/v1`.

### Server-side only — this SDK is **not** browser-safe

Call this SDK from a server only. Your `PAYLOD_API_KEY` can move money. Never ship the key in a browser bundle, a mobile application, or any other client. All content in a browser is public. An attacker can read the key from a bundle, a network tab, or a source map. Call this SDK from a server, a serverless function, or an edge worker.

---

## API

### `new Paylod(apiKey?, options?)`

```ts
new Paylod(process.env.PAYLOD_API_KEY!)   // the normal way
new Paylod()                              // reads PAYLOD_API_KEY from the environment
new Paylod(key, { timeoutMs: 10_000 })    // with an escape hatch
new Paylod({ apiKey, fetch })             // everything-in-one-object form, if you prefer
```

The constructor throws `PaylodConfigError` immediately if it finds no API key. A client without a key returns a `401` on the first call, so the SDK refuses to construct one.

| Option | Type | Default |
|---|---|---|
| `apiKey` | `string` | `process.env.PAYLOD_API_KEY` |
| `baseUrl` | `string` | `process.env.PAYLOD_BASE_URL` ?? `https://paylod.dev/functions/v1` |
| `webhookSecret` | `string` | `process.env.PAYLOD_WEBHOOK_SECRET` |
| `timeoutMs` | `number` | `30_000` |
| `maxRetries` | `number` | `2` |
| `fetch` | `typeof fetch` | global `fetch` |

The constructor throws `PaylodConfigError` if it finds no API key.

---

### `collect(params, options?) → Promise<CollectAck>`

This method sends the STK push. The method returns when the STK push is on the handset.

Pass an idempotency key on every collect call. Mint one key for each payment attempt. Duplicates of that attempt collapse into one STK push and one charge. A double-clicked Pay button, a refreshed tab, and a redelivered job are duplicates of one attempt. Do not use the order id or the product id as the key. A retry after a wrong PIN is a new attempt, and it needs a new key.

The idempotency key is required. The SDK refuses a collect call without one, before the call leaves your process.

```ts
const ack = await paylod.collect({
  amount: 100,                    // positive INTEGER KES, ≤ 150000 (M-Pesa rejects decimals)
  phone: "0712345678",            // any Kenyan format
  idempotencyKey: attempt.id,     // PASS THIS. One key per payment ATTEMPT — not the order, and
                                  //   never the product. Duplicates of that attempt collapse into
                                  //   one payment and one prompt. A retry after a wrong PIN is a
                                  //   NEW attempt and needs a NEW key. REQUIRED — omitting it is
                                  //   a compile error and a runtime throw.
  accountReference: "order-42",   // optional, ≤ 12 chars — your correlation id, returned as
                                  //   `accountRef`. Shown to the payer only on a Paybill
                                  //   (it is the account number); a Till never displays it.
                                  //   Defaults to a short prefix of the paymentId.
                                  //   A LABEL, not a lock — it does not deduplicate anything.
  description: "Coffee",          // optional, ≤ 64 chars — shown on the prompt
  metadata: { orderId: "42" },    // optional, stored — NOT returned on /status or the webhook
});

// { paymentId, status: "pending", checkoutRequestId, idempotencyKey }
```

The SDK validates `amount`, `phone`, and the field lengths **locally**. Incorrect input throws `PaylodInvalidRequestError` before the SDK sends the request.

---

### `status(paymentId) → Promise<Payment>`

```ts
const p = await paylod.status(ack.paymentId);
// { id, status: "pending" | "success" | "failed", mpesaReceipt, resultCode, resultDesc }
```

> Note the state names. The successful state is **`success`**. The state name is not `paid`.

---

### `check(paymentId) → Promise<PaymentOutcome>`

This method returns the same data as `status()`, but decoded and renderable. Use this method.

### `wait(paymentId, options?) → Promise<PaymentOutcome>`

This method polls an existing payment until the payment settles.

### `collectAndWait(params, options?) → Promise<PaymentOutcome>`

`collect()` + `wait()`.

```ts
const outcome = await paylod.collectAndWait(
  { amount: 100, phone: "0712345678", idempotencyKey: attempt.id },
  {
    timeoutMs: 120_000,                    // default; STK prompts expire around 60s
    onPoll: (p) => console.log(p.status),  // called on each pending snapshot
    signal: controller.signal,             // optional AbortSignal
  },
);
```

The poll interval increases through 1s, 1s, 1.5s, 2s, 2.5s, 3s, 4s, and 5s. The maximum interval is 5s. The SDK applies jitter of plus or minus 20% to each interval. The jitter prevents synchronised polls from many servers.

`wait()` uses the **classifier** to decide whether the payment settled. `wait()` does not use the raw `status` field. Daraja reports result code `4999` on a record that Daraja also marks `failed`. Result code `4999` means that the STK push is live on the handset. The customer did not enter the PIN yet. The payment is IN FLIGHT, not failed. Therefore `wait()` continues to poll.

---

### The outcome: one renderable shape

```ts
interface PaymentOutcome {
  status: "succeeded" | "pending" | "cancelled" | "failed";
  message: string;        // customer-facing, already decoded. RENDER THIS.
  retryable: boolean;     // SAFE TO CHARGE AGAIN. Gate your retry button on this.
  paid: boolean;          // the one branch a backend needs: if (paid) fulfil()
  receipt: string | null; // M-Pesa confirmation code; non-null exactly when `paid`
  // developer detail — available, never required to render the happy path
  code: string | null;
  detail: DecodedError | null;
  payment: Payment;
}
```

The entire UI:

```tsx
<p>{outcome.message}</p>
{outcome.retryable && <button onClick={retry}>Try again</button>}
```

The entire backend:

```ts
if (outcome.paid) await fulfilOrder(outcome.receipt);
```

**Do not write a `switch` statement on result codes. Do not keep a result code catalog in your application.** Do not use `if (outcome.code === "1032")` to select the text that you show to a customer. Use `message` for that text. Use `code` and `detail` in your logs and your support tools.

#### Two rules

**1.** `retryable` means SAFE TO CHARGE AGAIN. It does not mean that the customer may press a button. `retryable = false` means that paylod cannot prove that no debit occurred. Result code `4999` and result code `500.001.1001` mean that the STK push is live on the handset. The customer did not enter the PIN yet. The payment is IN FLIGHT, not failed. A pending payment is never retryable. A second collect call sends a second STK push, and it can charge the customer twice. Control your retry button with the `retryable` flag.

**2.** A wrong PIN is an answer, not an exception. A cancellation, a wrong PIN, and a low balance come back as data, with `status` and a `message`. They do not raise an error. These three outcomes are the most common outcomes of a collect call. They are business outcomes, not faults in your code.

**The SDK throws only for exceptional conditions:**

| Throws | When |
|---|---|
| `PaylodInvalidRequestError` | You passed an incorrect amount or an incorrect phone number. This condition is a fault in your code. |
| `PaylodConfigError` | The SDK found no API key. This condition is a fault in your deployment. |
| `PaylodApiError` | paylod returned a non-2xx response. Read `.status`, `.isAuthError`, `.isRateLimited`, and `.isIdempotencyConflict`. Read `.isIdempotencyIndeterminate`, `.isIdempotencyInProgress`, and `.isIdempotencyBodyConflict` to identify which of the three `409` responses occurred. An indeterminate `409` is a STOP signal. Read the payment status, then start a new attempt with a NEW key. |
| `PaylodConnectionError` | The network failed after all retries. |
| `PaylodTimeoutError` | The payment was still `pending` at the deadline. |

**Handle `PaylodTimeoutError` explicitly.** A timeout is not a failed payment. The outcome is INDETERMINATE. The customer can still enter the PIN, and the payment can still succeed. Leave the order pending. The webhook settles the order. For this reason the SDK throws a distinct error, and it does not return `status: "failed"`.

```ts
try {
  const outcome = await paylod.collectAndWait({
    amount: 100, phone: "0712345678", idempotencyKey: attempt.id,
  });
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

This method runs offline. The method uses no network and makes no API call.

You need this method rarely. `check()`, `wait()`, and `collectAndWait()` already return a decoded, renderable `PaymentOutcome`. Use `decodeError` for logs, dashboards, and support tools. Do not use `decodeError` to select the text that you show to a customer.

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

Show `customerMessage` to the customer without a change. The strings are byte-identical to the strings that paylod puts in `event.data.decoded`. Your interface therefore shows the same text after a poll and after a webhook.

The SDK also exports these functions standalone: `import { decodeError, ERROR_CATALOG } from "@paylod/node"`.

---

## Test your checkout without a phone

Most payment faults occur on the failure paths. A test of a failure path previously required a handset and a wrong PIN. The simulator removes the handset, and it changes nothing else. You get a real sandbox payment record, real Daraja result codes, and a real signed webhook.

```ts
const paylod = new Paylod(process.env.PAYLOD_TEST_KEY!);   // mp_test_… key

const outcome = await paylod.simulate.pay({ outcome: "wrong_pin", idempotencyKey: "t-1" });

outcome.status;     // "failed"
outcome.message;    // "That M-Pesa PIN was incorrect. Please try again and enter the right PIN."
outcome.retryable;  // true — no money moved, so a fresh charge is safe
```

The simulator returns an ordinary `PaymentOutcome`. The object is identical to the object that `check()` and `wait()` return. There is no simulated type, and your application needs no special branch. The code that you test is the code that runs in production.

| `outcome` | `status` | Result code |
| --- | --- | --- |
| `approve` | `succeeded` | `0` |
| `wrong_pin` | `failed` | `2001` |
| `insufficient_funds` | `failed` | `1` |
| `user_cancelled` | `cancelled` | `1032` |
| `timeout` | `failed` | `1037` |

`paylod.simulate.outcomes` is the complete typed list. The SDK also exports the list as `SIM_OUTCOMES`. An incorrect name is therefore a compile error, and not a `422` response that you find in CI.

### How to test your own code

Divide the simulation into two calls, and run your handler between them. The payment id is a real payment id. Your poller, your webhook route, and your interface all run without a change:

```ts
const sim = await paylod.simulate.collect({ amount: 250, idempotencyKey: "t-1" });
await paylod.simulate.outcome(sim.paymentId, "insufficient_funds");

const view = await readCheckout(sim.paymentId);   // ← your code, verbatim
```

Construct the client with `simulate: true` to test your own `collect()` call. `collect()` then creates a simulated payment, and it sends no STK push to a handset. Your `/api/pay` handler runs without a change:

```ts
const paylod = new Paylod(process.env.PAYLOD_TEST_KEY!, { simulate: true });

const view = await startCheckout(order.id, "0712345678", attemptId);  // your handler, verbatim
await paylod.simulate.outcome(view.paymentId!, "user_cancelled");
```

**The simulator is sandbox-only by construction.** Every simulator call refuses an `mp_live_` key locally, before the call leaves your process. The SDK throws `PaylodSandboxOnlyError`. The constructor also throws for `{ simulate: true }` with a live key.

> The `timeout` outcome is Daraja result code `1037`. Result code `1037` means that Daraja could not reach the handset, and it is a **settled** failure. Result code `1037` is not `PaylodTimeoutError`. `wait()` throws `PaylodTimeoutError` when a payment is still pending at your deadline. An indeterminate payment is not a failed payment.

---

## Webhooks

paylod POSTs a signed JSON body to your endpoint when a payment settles.

```
POST /your/webhook
x-webhook-signature: t=1700000000,v1=<hex hmac-sha256>
x-webhook-id: <event id>
x-webhook-event: payment.success
```

The signature is `HMAC-SHA256(secret, "${t}.${rawBody}")`. The SDK verifies the signature. The SDK also checks the timestamp against a 300s tolerance, which prevents a replay. The SDK compares in constant time, and it returns a typed event.

### Express / Connect

Verify the signature against the raw bytes. A re-serialised body does not reproduce the same bytes, and the signature check then fails. Mount the webhook route *before* a global `express.json()` call, or give the route `express.raw()`.

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

The adapter responds `400` for an incorrect signature, and your handler does not run. The adapter responds `500` if your handler throws, and paylod then retries the delivery. The adapter responds `200` in all other cases.

> If a body parser already modified the raw bytes, the SDK returns a `400` response with that exact reason. The SDK never skips the signature check.

### Next.js / Hono / Remix / Cloudflare Workers / Bun / Deno

```ts
// app/api/webhooks/paylod/route.ts
import { Paylod } from "@paylod/node";

const paylod = new Paylod();

export const POST = paylod.webhookHandler(async (event) => {
  if (event.type === "payment.success") await fulfil(event.data.paymentId);
});
```

`webhookHandler` accepts a Web `Request` and returns a `Response`. The handler therefore works in any fetch-style runtime. The Next.js App Router supplies the raw body automatically, and it needs no configuration.

### Manual verification

Verify the signature against the raw bytes. A re-serialised body does not reproduce the same bytes, and the signature check then fails.

```ts
const event = paylod.verifyWebhook({
  payload: rawBodyStringOrBuffer,
  signature: req.headers["x-webhook-signature"],
  secret: process.env.PAYLOD_WEBHOOK_SECRET,  // optional if set on the client
  toleranceSec: 300,                          // optional; must be positive, cannot be disabled
});
```

You cannot disable the freshness check. The SDK refuses the value `0`. The SDK also refuses a
tolerance window that is too wide to give protection. To verify a fixed test vector, set `nowSec`
instead of a wider `toleranceSec`.

Both framework adapters also accept `bodyReadTimeoutMs`. The default value is `10_000`, and the maximum value is `60_000`:

```ts
app.post("/webhooks/paylod", paylod.webhook(handler, { bodyReadTimeoutMs: 5_000 }));
```

The body-size limit controls how much memory an anonymous caller can make your server ALLOCATE. The `bodyReadTimeoutMs` limit controls how long an anonymous caller can make your server WAIT. A request that sends one byte each minute stays under the size limit for a very long time. Your server therefore needs both limits, and one limit cannot replace the other.

`verifyWebhook` throws `PaylodSignatureVerificationError` on any failure. The `.reason` property holds one of these values: `missing_signature`, `malformed_signature`, `stale_timestamp`, `no_match`, or `invalid_payload`. The method never returns a partially trusted value.

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

paylod can deliver the same webhook more than once. Key your fulfilment on the signed `data.paymentId`, and make the fulfilment idempotent. Do not use the `x-webhook-id` header for this check. The header is unsigned, so an attacker can replay a body under a new header value. Only the signed body is trustworthy, and `verifyWebhook` verifies that body.

---

## Idempotency

**Read this section. This section shows you how to prevent a double charge.**

Pass an idempotency key on every collect call. Mint one key for each payment attempt. Duplicates of that attempt collapse into one STK push and one charge. A double-clicked Pay button, a refreshed tab, and a redelivered job are duplicates of one attempt. Do not use the order id or the product id as the key. A retry after a wrong PIN is a new attempt, and it needs a new key.

An idempotency key names **one payment attempt**. An internal network retry is also a duplicate of one attempt. This guarantee is narrower than a general safe retry. A reused key is not always a safe retry.

```ts
const attempt = await db.attempts.create({ orderId: order.id });   // a row per press of Pay
await paylod.collectAndWait({ amount, phone, idempotencyKey: attempt.id });
```

### Mint one key for each attempt, not for each order and not for each product

The key must be **stable across duplicates of one attempt**. The key must also be **new for each new charge**. An order id is stable, but an order id is not new. A product id is neither stable nor new:

| The key that you pass | The result |
| --- | --- |
| An id minted for each **payment attempt** | Correct. Duplicates of that attempt collapse into one charge. A new attempt is a new charge. |
| Your **order id** | The customer enters a wrong PIN, and you retry the same order. paylod then replays the **failed** first attempt, and paylod does not charge the customer. The order never settles. |
| A **product id**, or any value that you reuse across purchases | Very dangerous. Every customer after the first customer replays the **first** payment for that product. paylod charges no customer after the first customer. |
| `crypto.randomUUID()` inside **each call** | The same as no key. A double-click gives two keys, two STK pushes, and two charges. |

One rule covers all four rows. **Mint the key when a payment attempt begins. Persist the key on that attempt. Never reuse the key for a different charge.** A retry after a wrong PIN, a cancelled STK push, or a timeout is a *new attempt*. A new attempt needs a new record and a new key.

### A concurrent double-click cannot cause a double charge

This guarantee is unconditional. Send ten simultaneous requests with the same `Idempotency-Key`, and you get **one** payment and **one** STK push. paylod reserves the key before it calls the provider. Exactly one request therefore proceeds, and the other requests replay the answer. All ten requests return the same `paymentId`.

### The one case where the same key is not a safe retry

A request can stop in flight against Daraja, after paylod passed the call to the provider and before an answer returned. That key is then **spent**. paylod does not send the request again. paylod returns a `409` **indeterminate** response:

```text
A previous request with this Idempotency-Key was interrupted while the provider call was
in flight, so it may or may not have completed. We will not repeat it — that could charge
or pay twice. Check the payment/disbursement status; if nothing happened, retry with a NEW key.
```

A timeout is not proof that no debit occurred. A timeout gives no evidence at all. paylod therefore refuses to guess.

> [!WARNING]
> Read the payment status before you retry. An interrupted request spends its idempotency key, and
> paylod answers `409` indeterminate. The `409` is a STOP signal, not a retry signal. paylod cannot
> prove that no debit occurred, so paylod refuses to repeat the request. If the payment settled, you
> are done. If nothing occurred, start a new attempt with a NEW key. For money, at-most-once is
> better than at-least-once. Read the status with `paylod.check(paymentId)`, with
> `GET /status/:id`, or from your webhook. A retry under the spent key returns the same `409` every
> time.

### The rules

- **The same key, the same body, and a settled payment.** paylod replays the original payment. You get the same `paymentId` and the same `checkoutRequestId`. paylod sends no second STK push and makes no second debit.
- **The same key, the same body, and a first request still in flight.** paylod returns `409` with a `Retry-After` header (`.isIdempotencyInProgress`). For a double-clicked Pay button, the SDK instead waits for the first request and returns its response.
- **The same key and a different body.** paylod returns `409` (`.isIdempotencyBodyConflict`). This response is always a fault in your code. Two different charges used one key. For example, you changed the amount and kept the key.
- **The same key, and a previous attempt that stopped against the provider.** paylod returns `409` **indeterminate** (`.isIdempotencyIndeterminate`). Read the payment status, then start a new attempt with a **new** key. paylod never sends the request again.
- **Internal retries.** The SDK reuses the same key automatically for a network fault, a `5xx` response, and a `429` response. This behaviour makes a `POST` retry safe. If the interruption occurred against Daraja, the retry returns the indeterminate `409` instead of a second charge.

All four responses are a `PaylodApiError` with `.isIdempotencyConflict === true`. The three getters above identify which `409` response you have. Only one of the three is a fault in your code.

### You cannot omit the key

The idempotency key is required. The SDK refuses a collect call without one, before the call leaves your process. Since version 0.10.0, an omitted key is a TypeScript compile error and a runtime `PaylodInvalidRequestError`:

```ts
await paylod.collect({ amount: 100, phone: "0712345678" });
// PaylodInvalidRequestError: collect() requires an `idempotencyKey`. …
```

Earlier versions minted a key for you, and they warned one time for each process. That default was incorrect. A key minted **inside** the call has a different value on every call, so that key collapses no duplicates. Only your server knows that a call is a retry. The SDK cannot know this fact.

| The customer action | With one key for each attempt | With a key that the SDK mints in each call |
| --- | --- | --- |
| The customer double-clicks **Pay** | 1 STK push, 1 charge | **2 STK pushes, 2 charges** |
| The customer refreshes the tab and submits again | 1 STK push, 1 charge | **2 STK pushes, 2 charges** |
| Your job queue retries the handler | 1 STK push, 1 charge | **2 STK pushes, 2 charges** |

### Migrating from 0.9.x

Every `collect()`, `collectAndWait()`, `simulate.collect()`, and `simulate.pay()` call needs a key. The TypeScript compiler finds every such call. Run `tsc`, and correct each call that the compiler reports.

```diff
- const ack = await paylod.collect({ amount, phone });
+ const attempt = await db.attempts.create({ orderId: order.id });
+ const ack = await paylod.collect({ amount, phone, idempotencyKey: attempt.id });
```

Mint a key where the attempt *begins* if you have no natural id for each attempt. The attempt begins in the request handler, in the job payload, or at the button press. Persist the key there. The key must outlive the call. A key minted inside the call cannot outlive the call.

Any stable literal value works in a test. For example, use `idempotencyKey: "t-1"`.

### The unsafe opt-out

Do not use this option in production. The SDK then mints a throwaway key, and it warns on every call. A throwaway key protects nothing, and the call can charge a customer twice. Use this option only in a temporary script:

```ts
await paylod.collect({ amount, phone, unsafeGeneratedIdempotencyKey: true });
```

The SDK warns on **every call**, and not one time for each process. This behaviour is deliberate. A worker can send a thousand unprotected charges in a loop. A once-per-process warning hides that condition, and each of the thousand calls can charge a customer twice. The SDK writes the warning with `console.warn` and not with `process.emitWarning`, so the `--no-warnings` flag cannot suppress the warning.

> [!WARNING]
> Do not write `idempotencyKey: crypto.randomUUID()` inside the call. That code satisfies the type check and the runtime check, and it gives no protection. A random UUID is a correct key. You must mint the UUID one time for each attempt and store it. Do not mint the UUID inside the call.

---

## Error handling, end to end

```ts
import {
  Paylod, PaylodApiError, PaylodTimeoutError,
  PaylodInvalidRequestError, PaylodConnectionError,
} from "@paylod/node";

try {
  const outcome = await paylod.collectAndWait({ amount, phone, idempotencyKey: attempt.id });

  // No branching over result codes. The outcome is already renderable.
  return {
    paid: outcome.paid,
    receipt: outcome.receipt,
    message: outcome.message,
    retry: outcome.retryable,
  };

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

The SDK exports `signWebhook`. Use this function to build realistic test fixtures without a network:

```ts
import { signWebhook } from "@paylod/node";

const raw = JSON.stringify(myFakeEvent);
const signature = signWebhook(raw, process.env.PAYLOD_WEBHOOK_SECRET!);
await request(app).post("/webhooks/paylod")
  .set("x-webhook-signature", signature)
  .set("content-type", "application/json")
  .send(Buffer.from(raw));
```

Inject a mock `fetch` function to test your collect calls:

```ts
const paylod = new Paylod({ apiKey: "mp_test_x", fetch: myMockFetch });
```

---

## Migrating from 0.1.x

Version 0.2 contains a small breaking change. The change removes code from *your* application.

```ts
// 0.1 — you branched, then reached into a decoded error to find a string to show
const paylod = new Paylod({ apiKey: process.env.PAYLOD_API_KEY });
const result = await paylod.collectAndWait({ amount, phone, idempotencyKey: attempt.id });
if (result.ok) fulfil(result.receipt);
else {
  toast(result.error.customerMessage);
  if (result.error.retryable) showRetry();
}

// 0.2 — the outcome is already renderable
const paylod = new Paylod(process.env.PAYLOD_API_KEY!);
const outcome = await paylod.collectAndWait({ amount, phone, idempotencyKey: attempt.id });
if (outcome.paid) fulfil(outcome.receipt);
else toast(outcome.message);
if (outcome.retryable) showRetry();
```

| 0.1 | 0.2 |
|---|---|
| `new Paylod({ apiKey })` | `new Paylod(apiKey)`. The object form also works. |
| `PaymentResult` (`{ ok, receipt } \| { ok, error }`) | `PaymentOutcome`. One flat, renderable shape. |
| `result.ok` | `outcome.paid`, or `outcome.status === "succeeded"` |
| `result.error.customerMessage` | `outcome.message` |
| `result.error.retryable` | `outcome.retryable` |
| `result.error` | `outcome.detail` and `outcome.code` |
| — | `paylod.check(id)`. A decoded form of `status()`. |
| — | The state `status: "cancelled"` is now distinct from the state `"failed"`. |

Version 0.2 also contains two corrections to the behaviour. Both corrections make the SDK safer:

- **`wait()` no longer reports a pending payment as failed.** `wait()` classifies the payment on the result code. A record marked `failed` that carries result code `4999` therefore keeps the poll active. The SDK does not report a failure for a payment that can still succeed.
- **An unknown result code is no longer `retryable: true`.** Before version 0.2, the SDK held a hand-maintained copy of the Daraja table. The fallback in that copy permitted a second charge on a result code that the SDK could not classify. The SDK now generates the table from the canonical source with `npm run sync-catalog`. A `--check` drift guard runs in `prepublishOnly`. An indeterminate result code is never safe for a second charge.

---

## License

MIT
