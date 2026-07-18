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

That's the whole integration. `collectAndWait` sends the STK prompt, polls with a sane backoff, and hands you something you can **render**.

> [!WARNING]
> **Pass `idempotencyKey`, and mint one per payment attempt.** Duplicates of that attempt — a
> double-clicked Pay button, a refreshed tab, a redelivered job — collapse into **one** prompt and
> **one** charge. Omit it and every call is a new charge: two clicks, two prompts, two debits.
>
> Do **not** key on the order or the product: that replays an old payment instead of making a new
> one. A retry after a wrong PIN is a new charge and needs a **new** key.
> See [Idempotency](#idempotency).

**One argument in, one renderable thing out.** You pass an API key — not a base URL, not a config object, not an OAuth token. You get back a `message` a customer can read and a `retryable` flag you can hang a button off. There is no result-code table in your app:

```tsx
<p>{outcome.message}</p>
{outcome.retryable && <button onClick={retry}>Try again</button>}
```

> **If you find yourself writing `if (code === 1032)`, we've failed.** Decoding M-Pesa's result codes is our job, not yours — see [The outcome](#the-outcome-one-renderable-shape).

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
| **Idempotency** | A retry (or a nervous double-click, or a Lambda re-invoke) without an `Idempotency-Key` sends a **second STK push**. The customer pays twice. Most people forget the header entirely. | A key is sent on **every** `collect()` and reused across internal retries. Pass one per payment attempt and duplicates of that attempt — double-click, refresh, redelivered job — collapse into one charge and one prompt. |
| **Webhook signatures** | HMAC over `${timestamp}.${rawBody}`, constant-time compare, timestamp tolerance, and the raw body must survive your JSON middleware. Every one of those is easy to get subtly, silently wrong — and getting it wrong means anyone can forge a "payment succeeded". | `paylod.webhook(handler)` — verified, typed, and it shouts at you if your body parser ate the raw bytes. |
| **Error decoding** | You end up writing `switch (resultCode) { case 1032: ... case 2001: ... }` from a forum post, with wrong text. (`2001` is a *wrong PIN* — it is **not** a credentials error, despite what the raw `ResultDesc` implies.) | `outcome.message` — already decoded, from the same catalog the API uses. Render it directly. |
| **Phone formats** | Customers give you `0712…`, `+254712…`, `254712…`, `0712 345 678`. Daraja accepts exactly one of those. | Normalised locally, before the request leaves your process. |

If you only ever need to fire-and-forget an STK push and you already have a webhook consumer you trust, `fetch` is genuinely fine. Use it. The SDK earns its keep the moment you need to *wait* for the money, or *trust* the webhook.

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

There is no base URL to configure: it is the same for every paylod customer, so it is baked in. There is no OAuth token to fetch, cache, or refresh. There is no callback URL to host.

If you consume webhooks, add the signing secret (shown once when you create the endpoint):

```bash
PAYLOD_WEBHOOK_SECRET=whsec_xxxxxxxx   # only if you consume webhooks
```

### Escape hatches (you probably don't need these)

```ts
const paylod = new Paylod(key, {
  baseUrl: "https://paylod.dev/functions/v1", // https required; self-host or a stub
  timeoutMs: 30_000,                          // per HTTP request
  maxRetries: 2,                              // transient failures only (network, 5xx, 429)
  fetch: myFetch,                             // inject an instrumented fetch
  // allowInsecureBaseUrl: true,              // TEST ONLY: permit http://localhost — never with a live key
});
```

> **`baseUrl` must be `https://`.** A plaintext origin would send your API key in the clear and
> opens you to SSRF / redirection, so it is refused at construction. A loopback stub
> (`http://localhost`, `http://127.0.0.1`) is allowed **only** with `allowInsecureBaseUrl: true`,
> and **never** with an `mp_live_` key.

> **Maintainer note:** the docs elsewhere advertise `https://api.paylod.dev/v1`. That hostname **does not route** — it 307s to `/signin`. The working base, and the default here, is `https://paylod.dev/functions/v1`.

### ⚠️ Server-side only — this is **not** browser-safe

Your `PAYLOD_API_KEY` can move money. Anything shipped to a browser is public: reading it out of a bundle, a network tab, or a source map is trivial. Call this SDK from a server, a serverless function, or an edge worker — never from client-side code.

---

## API

### `new Paylod(apiKey?, options?)`

```ts
new Paylod(process.env.PAYLOD_API_KEY!)   // the normal way
new Paylod()                              // reads PAYLOD_API_KEY from the environment
new Paylod(key, { timeoutMs: 10_000 })    // with an escape hatch
new Paylod({ apiKey, fetch })             // everything-in-one-object form, if you prefer
```

Throws `PaylodConfigError` immediately if there is no key anywhere — a client that would 401 on its first call is not worth handing back.

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
  idempotencyKey: attempt.id,     // PASS THIS. One key per payment ATTEMPT — not the order, and
                                  //   never the product. Duplicates of that attempt collapse into
                                  //   one payment and one prompt. A retry after a wrong PIN is a
                                  //   NEW attempt and needs a NEW key. Omit it and the SDK warns,
                                  //   because every call then becomes a new charge.
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

`amount`, `phone`, and the field lengths are validated **locally** — bad input throws `PaylodInvalidRequestError` before a byte hits the network.

---

### `status(paymentId) → Promise<Payment>`

```ts
const p = await paylod.status(ack.paymentId);
// { id, status: "pending" | "success" | "failed", mpesaReceipt, resultCode, resultDesc }
```

> Note the states: **`success`**, not `paid`.

---

### `check(paymentId) → Promise<PaymentOutcome>`

`status()`, but already decoded and renderable. This is the one you want.

### `wait(paymentId, options?) → Promise<PaymentOutcome>`

Poll an existing payment until it settles.

### `collectAndWait(params, options?) → Promise<PaymentOutcome>`

`collect()` + `wait()`.

```ts
const outcome = await paylod.collectAndWait(
  { amount: 100, phone: "0712345678" },
  {
    timeoutMs: 120_000,                    // default; STK prompts expire around 60s
    onPoll: (p) => console.log(p.status),  // called on each pending snapshot
    signal: controller.signal,             // optional AbortSignal
  },
);
```

Polling ramps 1s → 1s → 1.5s → 2s → 2.5s → 3s → 4s → 5s (capped), each with ±20% jitter so a fleet of servers doesn't poll in lockstep.

`wait()` decides "has it settled?" using the **classifier**, not the raw `status` field. Daraja reports code `4999` on a row it also marks `failed`, but `4999` means *"the prompt is live and the customer hasn't typed their PIN yet."* So `wait()` keeps polling, instead of reporting a failure for a payment that is about to succeed.

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

**No `switch` on result codes. No catalog in your app.** If you ever write `if (outcome.code === "1032")` to decide what to *show* a human, something has gone wrong — that's what `message` is for. `code` and `detail` are for your logs and your support tooling.

#### Two invariants worth internalising

**1. `retryable` means SAFE TO CHARGE AGAIN.** It does *not* mean "the user is allowed to press a button". A `pending` payment is **never** retryable: codes `4999` / `500.001.1001` mean the STK prompt is live on the handset and the customer simply hasn't entered their PIN yet. Retrying pushes a **second prompt** and can double-charge them. This bug has shipped twice. Gate the retry button on `retryable`, and it cannot happen to you.

**2. A wrong PIN is not an exception — it's an answer.** Cancellations, wrong PINs and low balances are the most common thing that happens to a payment request. They are business outcomes, so they come back as data (`status: "failed"`, with a `message`), not as a thrown error. Throwing for routine outcomes is how you end up with a codebase that treats "customer changed their mind" as a 500.

**So what *does* throw?** Only things that are genuinely exceptional:

| Throws | When |
|---|---|
| `PaylodInvalidRequestError` | You passed a bad amount/phone. A bug in your code. |
| `PaylodConfigError` | No API key. A bug in your deploy. |
| `PaylodApiError` | Non-2xx from paylod (`.status`, `.isAuthError`, `.isRateLimited`, `.isIdempotencyConflict` — and `.isIdempotencyIndeterminate` / `.isIdempotencyInProgress` / `.isIdempotencyBodyConflict` to tell the three `409`s apart. **Indeterminate is a stop signal**: read the status, then retry with a NEW key). |
| `PaylodConnectionError` | The network failed after retries. |
| `PaylodTimeoutError` | Still `pending` at the deadline. |

**`PaylodTimeoutError` deserves a word.** It throws *on purpose*, and it is deliberately **not** folded into `status: "failed"`. A timeout is not a failed payment — the customer may still be staring at the prompt, and may still pay. If we returned `"failed"` you'd cancel an order that is about to settle. An indeterminate payment is indeterminate; say so. Handle it explicitly:

```ts
try {
  const outcome = await paylod.collectAndWait({ amount: 100, phone: "0712345678" });
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

You should rarely need this — `check()`, `wait()` and `collectAndWait()` already hand back a decoded, renderable `PaymentOutcome`. It's here for logs, dashboards and support tooling, not for deciding what to show a customer.

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

## Test your checkout without a phone

Your failure paths are where payment bugs live, and testing them used to mean finding a handset and deliberately typing a wrong PIN. `paylod.simulate` removes the handset — and nothing else. A real payment row, the real Daraja result codes, the real settlement path, a real signed webhook to your endpoint. Only the phone is fiction.

```ts
const paylod = new Paylod(process.env.PAYLOD_TEST_KEY!);   // mp_test_… key

const outcome = await paylod.simulate.pay({ outcome: "wrong_pin" });

outcome.status;     // "failed"
outcome.message;    // "That M-Pesa PIN was incorrect. Please try again and enter the right PIN."
outcome.retryable;  // true — no money moved, so a fresh charge is safe
```

That is an ordinary `PaymentOutcome` — the identical object `check()` and `wait()` return. No "simulated" type, no special branch: the code you are testing is the code that runs in production.

| `outcome` | `status` | Result code |
| --- | --- | --- |
| `approve` | `succeeded` | `0` |
| `wrong_pin` | `failed` | `2001` |
| `insufficient_funds` | `failed` | `1` |
| `user_cancelled` | `cancelled` | `1032` |
| `timeout` | `failed` | `1037` |

`paylod.simulate.outcomes` (also exported as `SIM_OUTCOMES`) is the whole list, typed — a typo is a compile error, not a `422` you find in CI.

### Testing *your* code

Split it in two and put your handler in the middle. The payment id is a real one, so your poller, webhook route and UI all run unchanged:

```ts
const sim = await paylod.simulate.collect({ amount: 250 });
await paylod.simulate.outcome(sim.paymentId, "insufficient_funds");

const view = await readCheckout(sim.paymentId);   // ← your code, verbatim
```

And to exercise your own `collect()` call, build the client with `simulate: true` — `collect()` then creates a simulated payment instead of ringing a phone, so your `/api/pay` handler runs completely unchanged:

```ts
const paylod = new Paylod(process.env.PAYLOD_TEST_KEY!, { simulate: true });

const view = await startCheckout(order.id, "0712345678", attemptId);  // your handler, verbatim
await paylod.simulate.outcome(view.paymentId!, "user_cancelled");
```

**Sandbox only, structurally.** Every simulator call refuses a `mp_live_…` key *locally*, before a byte leaves the process (`PaylodSandboxOnlyError`), and `{ simulate: true }` throws from the constructor. A simulator that could touch production is not a feature.

> `timeout` is Daraja's `1037` — "we could not reach the handset" — a **settled** failure. It is not `PaylodTimeoutError`, which is what `wait()` throws when a payment is still pending at your deadline. An indeterminate payment is not a failed payment.

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

**Deliveries can repeat.** Retries and a lost 200 both look the same from our side. Key your fulfilment on the **signed** `data.paymentId` and make it idempotent. Do **not** dedup on the `x-webhook-id` header: it is **unsigned**, so an attacker can replay a captured body with a fresh `x-webhook-id` to slip past a header-keyed dedup check. Only the signed body (verified by `verifyWebhook`) is trustworthy — dedup on `data.paymentId` from it.

---

## Idempotency

**This is the section that stops you charging a customer twice. Read it.**

An idempotency key names **one payment attempt**. Duplicate deliveries of that one attempt — a double-click, a refreshed tab, a job-queue redelivery, an internal network retry — collapse into a single charge. That is the guarantee, and it is narrower than "reusing a key is always a safe retry".

```ts
const attempt = await db.attempts.create({ orderId: order.id });   // a row per press of Pay
await paylod.collectAndWait({ amount, phone, idempotencyKey: attempt.id });
```

### Pass a key per attempt — not per order, and not per product

The key must be **stable across duplicates of one attempt** and **fresh for a genuinely new charge**. An order id is stable, but it is not fresh — and a product id is neither:

| Key you pass | What happens |
| --- | --- |
| An id minted per **payment attempt** | Correct. Duplicates of that attempt collapse; a new attempt is a new charge. |
| Your **order id** | The customer mistypes their PIN, you retry the same order — and paylod replays the **failed** first attempt instead of charging them. The order never gets paid. |
| A **product id** (or any value reused across purchases) | Catastrophic. Every customer after the first replays the **first-ever** payment for that product. Nobody after customer one is charged at all. |
| `crypto.randomUUID()` **per call** | Equivalent to no key: a double-click is two keys, two prompts, two charges. |

The rule that resolves all four: **mint the key when a payment attempt begins, persist it on that attempt, and never reuse it for a different charge.** A retry after a wrong PIN, a cancelled prompt or a timeout is a *new attempt* — new row, new key.

### A concurrent double-click cannot double-charge

This part is unconditional. Fire ten simultaneous requests with the same `Idempotency-Key` and you get **one** payment and **one** STK push: the key is reserved before the provider is called, so exactly one request wins and the others replay its answer. All ten come back with the same `paymentId`.

### The one case where the same key is *not* a safe retry

If a request dies mid-flight against Daraja — after paylod handed the call to the provider, before an answer came back — that key is **spent**. A retry under it is not silently re-dispatched. It returns `409` **indeterminate**:

```text
A previous request with this Idempotency-Key was interrupted while the provider call was
in flight, so it may or may not have completed. We will not repeat it — that could charge
or pay twice. Check the payment/disbursement status; if nothing happened, retry with a NEW key.
```

A timeout is not evidence that the money did not move; it is the absence of evidence. So paylod refuses to guess. **For money, at-most-once beats at-least-once** — we would rather make you check than charge someone twice.

> [!WARNING]
> **The indeterminate `409` is a STOP signal, not a retry signal.** Read the payment status first
> — `paylod.check(paymentId)`, `GET /status/:id`, or your webhook — and only then decide. If the
> payment settled, you are done. If nothing happened, start a **new attempt with a new key**.
> Retrying under the spent key returns the same `409`, forever.

### The rules

- **Same key + same body, already settled** → the original payment is replayed. Same `paymentId`, same `checkoutRequestId`. No second prompt, no second debit.
- **Same key + same body, first request still in flight** → `409` with a `Retry-After` (`.isIdempotencyInProgress`), or — for a plain double-click — the SDK simply waits for the winner and hands you its response.
- **Same key + different body** → `409` (`.isIdempotencyBodyConflict`). Always a bug on your side: two different charges collided on one key (you changed the amount but kept the key).
- **Same key, previous attempt interrupted against the provider** → `409` **indeterminate** (`.isIdempotencyIndeterminate`). Check status; retry with a **new** key. Never re-dispatched.
- **Internal retries** (network blip, `5xx`, `429`) reuse the same key automatically — which is what makes retrying a `POST` safe in the first place. If the interruption happened against Daraja, that retry surfaces the indeterminate `409` rather than charging again.

All four are `PaylodApiError` with `.isIdempotencyConflict === true`; the three getters above tell you *which* `409` you have, and only one of them is your bug.

### What happens if you omit it

The SDK generates a fresh UUID per call and returns it on the ack:

```ts
const ack = await paylod.collect({ amount: 100, phone: "0712345678" });
ack.idempotencyKey; // persist it on the attempt — retrying THAT attempt with THAT key collapses
                    // into the original payment. A genuinely new attempt needs a new key.
```

That protects an internal *network* retry of that one call. It does **nothing** about your application sending the same logical charge twice:

| What the user does | With a per-attempt key | Without |
| --- | --- | --- |
| Double-clicks **Pay** | 1 prompt, 1 charge | **2 prompts, 2 charges** |
| Refreshes the tab and re-submits | 1 prompt, 1 charge | **2 prompts, 2 charges** |
| Your job queue retries the handler | 1 prompt, 1 charge | **2 prompts, 2 charges** |

A double-clicked button is by far the most common way a real customer gets double-charged, so the SDK emits a one-time `console.warn` when you call `collect()` / `collectAndWait()` without a key. The only way to silence it is to pass a real one.

> [!WARNING]
> Do **not** silence the warning with `idempotencyKey: crypto.randomUUID()` or `Date.now()` **at
> the call site**. A key that changes on every call is exactly equivalent to having no key at all
> — it just hides the warning telling you the customer is exposed. A random UUID is a perfectly
> good key; it just has to be minted **once per attempt** and stored, not generated inside the call.

---

## Error handling, end to end

```ts
import {
  Paylod, PaylodApiError, PaylodTimeoutError,
  PaylodInvalidRequestError, PaylodConnectionError,
} from "@paylod/node";

try {
  const outcome = await paylod.collectAndWait({ amount, phone });

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

## Migrating from 0.1.x

0.2 is a breaking change, and it is a small one. It exists to delete code from *your* app.

```ts
// 0.1 — you branched, then reached into a decoded error to find a string to show
const paylod = new Paylod({ apiKey: process.env.PAYLOD_API_KEY });
const result = await paylod.collectAndWait({ amount, phone });
if (result.ok) fulfil(result.receipt);
else {
  toast(result.error.customerMessage);
  if (result.error.retryable) showRetry();
}

// 0.2 — the outcome is already renderable
const paylod = new Paylod(process.env.PAYLOD_API_KEY!);
const outcome = await paylod.collectAndWait({ amount, phone });
if (outcome.paid) fulfil(outcome.receipt);
else toast(outcome.message);
if (outcome.retryable) showRetry();
```

| 0.1 | 0.2 |
|---|---|
| `new Paylod({ apiKey })` | `new Paylod(apiKey)` — the object form still works |
| `PaymentResult` (`{ ok, receipt } \| { ok, error }`) | `PaymentOutcome` — one flat, renderable shape |
| `result.ok` | `outcome.paid`, or `outcome.status === "succeeded"` |
| `result.error.customerMessage` | `outcome.message` |
| `result.error.retryable` | `outcome.retryable` |
| `result.error` | `outcome.detail` (and `outcome.code`) |
| — | `paylod.check(id)` — decoded `status()` |
| — | `status: "cancelled"` is now distinct from `"failed"` |

Two behaviour fixes came with it, both on the safe side:

- **`wait()` no longer reports a pending payment as failed.** It classifies on the result code, so a row marked `failed` carrying `4999` keeps polling instead of telling a paying customer they failed.
- **An unknown result code is no longer `retryable: true`.** Until 0.2 the SDK carried a hand-maintained fork of the Daraja table whose fallback invited a blind re-charge on a code it could not classify. The table is now generated from the canonical source (`npm run sync-catalog`, with a `--check` drift guard in `prepublishOnly`) and an indeterminate code is never safe to re-charge.

---

## License

MIT
