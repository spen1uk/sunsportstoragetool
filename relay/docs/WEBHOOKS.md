# Relay webhooks

Two directions. Both use the same signature scheme, which is the timestamped HMAC-SHA256 scheme documented for Stripe webhooks (`Stripe-Signature: t=…,v1=…`): the signed string is `"<timestamp>.<raw request body>"`.

```
X-Relay-Signature: t=1760390000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

## Verifying a request from Relay (outbound events)
Verify against the **raw bytes** of the body, reject timestamps older than 5 minutes, compare in constant time.
```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map(kv => kv.split('=')));   // note: v1 may repeat during secret rotation
  const t = Number(parts.t); if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) throw new Error('stale');
  const want = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  if (!timingSafeEqual(Buffer.from(parts.v1), Buffer.from(want))) throw new Error('bad signature');
}
```
Headers: `X-Relay-Event-Id` (stable across retries — use it to de-duplicate), `X-Relay-Event-Type`, `X-Relay-Delivery-Attempt`, `User-Agent: Relay-Webhooks/1`.

## Events
| type | data (always) | extra when the subscription has "include content" |
|---|---|---|
| `message.received` | conversationId, messageId, contactId, channel | body, from |
| `message.status_changed` | messageId, conversationId, status | — |
| `payment.updated` | paymentRequestId, status, paidCents, refundedCents, amountCents, currency | — |
| `review.created` | reviewId, rating, source | author, text |
| `ping` | message | — |

Envelope: `{ "id": "<event id>", "type": "...", "createdAt": "ISO-8601", "data": { ... } }`. Content is **off by default**; an admin must tick it per subscription. Phone numbers are never included without content.

## Delivery guarantees
- At-least-once. Expect duplicates; de-duplicate on `X-Relay-Event-Id`.
- Success = any `2xx`. Retried with exponential backoff (30 s, 60 s, 120 s … capped at 6 h) on `5xx`, network errors, `408`, `429`. Other `4xx` and **redirects (never followed)** are permanent failures. After 8 attempts a delivery is `dead`; an admin can redeliver it. `410 Gone` disables the subscription.
- **Destination safety (SSRF):** https only, port 443, no credentials in the URL, no internal names, and every resolved address must be public (private, loopback, link-local, CGNAT, cloud-metadata, multicast, IPv4-mapped IPv6 are refused). The connection is made to the address that was validated, so DNS rebinding after creation cannot redirect it; the check is repeated on every delivery and an unsafe destination disables the subscription.
- Signing secrets are shown once at creation/rotation and stored encrypted (AES-256-GCM, key-versioned, rotatable).

## Inbound lead endpoints (website forms, other tools)
`POST /hooks/inbound/<endpointId>` with a JSON body and `X-Relay-Signature` computed with the endpoint's secret. No cookie or CSRF header is needed; the signature is the authentication.
```json
{ "eventId": "unique-per-submission", "firstName": "Pat", "lastName": "Lee", "phone": "(414) 555-0100", "email": "pat@example.com",
  "message": "Interested in the 2019 pontoon", "tags": ["pontoon"],
  "consent": { "marketing": { "granted": true, "evidence": "Ticked 'text me deals' on /contact at 2026-10-13T15:02Z" } } }
```
- `eventId` makes retries safe (a replay creates nothing). Signature timestamp tolerance: 5 minutes.
- Creates or matches a **contact** and adds an internal **note**. It can **never send a message**.
- A phone number matching exactly one contact reuses it; matching **several** (different people sharing a number) creates a separate contact tagged `needs-review` — Relay never guesses a merge.
- Marketing consent is recorded **only** when `consent.marketing.granted` is `true` **and** `evidence` is supplied; a phone number alone is never consent.
- Responses: `200 {duplicate:false, contactId, outcome}`, `200 {duplicate:true}`, `400` invalid, `401` bad/missing/stale signature, `404` unknown or disabled endpoint.
