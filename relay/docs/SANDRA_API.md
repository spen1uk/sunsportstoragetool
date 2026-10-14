# Assistant (Sandra) API — v1

Status: **built and tested against a fake client only.** No real Sandra has been connected. The owner connects her by creating access in Settings → Assistant and giving the key to her runtime. Until then nothing calls this API.

Base path `/api/v1`. Machine-to-machine: `Authorization: Bearer rk_<id>_<secret>`. No cookies, no CSRF header; a staff session cannot call it and a key cannot call anything else (`/api/*` outside `/api/v1` answers 401).
Response shapes: `src/sandra/contract.ts` (zod). Worked examples: `docs/sandra/examples.json` (a test validates them). Reference client: `src/sandra/fakeClient.ts` (`npm run sandra:fake`).

## Principles the server enforces (not the client)

1. **One send pipeline.** Her messages go through the same function as staff, scheduled, broadcast and automation messages: idempotency → conversation lock → fence → consent → outbox → worker, with consent and the fence re-checked by the worker at send time. STOP / do-not-text / outbound-block / global pause / paused / draft-only / closed all block her exactly as they block everyone.
2. **Fencing.** Every conversation has a `revision`. Reading returns it; **every send must carry `expectedRevision`** (no default). Any customer reply, staff takeover, assignment, mode change, close/reopen or other send bumps it. A mismatch → `409 stale_revision` with the current revision and mode; nothing is queued. A message already queued when staff take over is suppressed by the takeover and again by the worker.
3. **She cannot grant herself anything.** There is no endpoint to set handling mode to Sandra, take over, change autonomy, scopes, rules or keys. A person (manager+) hands a conversation to Sandra; the owner alone can allow sending.
4. **Customer text is data.** Every inbound message is returned with `untrusted: true, origin: "customer"`. Nothing in a customer message can alter permissions (verified by test).
5. **Authority rules.** Owner-editable keyword lists (defaults: refunds, discounts/negotiation, financing terms) plus “ungrounded dollar amounts” (not an inventory price, not a figure the customer wrote). A send that trips a rule is **not sent**: `422 authority_required` + the text is saved as a staff draft and staff are notified. Keyword matching is a safety net, not understanding: it will miss paraphrases. It is deliberately conservative and owner-extendable; it does not replace limiting her autonomy.
6. **Least privilege.** Scopes say *what*; autonomy says *how far*; departments say *where*. Unknown/foreign/forbidden ids all answer 404.

## Autonomy × scope

| Autonomy | May do |
|---|---|
| `read_only` (default) | reads only (subject to scopes) |
| `drafts` | + drafts, tags, hand-off, pause, tasks (needs the matching scope). Nothing customer-visible |
| `send` | + `POST …/messages`. Needs `messages:send` scope too. **Only the owner can grant either.** |

Scopes: `conversations:read messages:read contacts:read contacts:pii summaries:read inventory:read business:read events:read messages:send drafts:write conversations:write tasks:write`.
Departments: empty list = unrouted (triage) conversations only. Restricted departments (Financing) need explicit inclusion.

## Headers

- `X-Correlation-Id` (optional, echoed/generated; stored in the audit trail for every write).
- `Idempotency-Key` (8–100 chars) **required on every POST**. Per identity namespace. Same key + same body → the stored response is replayed (`Idempotent-Replay: true`) even if state moved on; same key + different body → `422 idempotency_key_reuse`; concurrent duplicates execute once. Validation errors (400) and thrown errors (403/404) are not stored, so they can be retried with the same key. Rejections returned as results (409 stale, 422 authority/consent) **are** stored: after re-reading, use a **new** key.
- Rate limit: per identity, per process (default 120/min, owner-adjustable) → `429` + `Retry-After`.

## Endpoints

| | |
|---|---|
| `GET /me` | identity, scopes, autonomy, departments, limits |
| `GET /events?after=&limit=` · `POST /events/ack {seq}` | event feed (below) |
| `GET /conversations?handlingMode=&responsibility=&limit=` | list (visible only) |
| `GET /conversations/:id?messageLimit=&beforeSeq=` | `conversation` (incl. `revision`, `handlingMode`, `lastTakeoverAt`), `sms {canSend, reason}`, `humanRequiredTopics`, `messages[]` (needs `messages:read`; customer-visible only: no internal notes, no suppressed rows) |
| `GET /contacts/:id` | names, tags, boats, preferences; `contacts:pii` adds phone/email. Never internal notes |
| `GET /contacts/:id/summary` | existing permission-scoped summary (facts citing hidden conversations are removed) |
| `GET /contacts/:id/matches` · `GET /inventory` | `availability` ∈ available / unverified_stale / pending / sold / unknown — only `available` may be promised |
| `GET /business` | name, timezone, hours (`configured:false` ⇒ do not state hours), automation pause, whether texting is live |
| `POST /conversations/:id/messages {body, expectedRevision}` | 202 `{messageId,status,revision}`; 409 `stale_revision` / `not_sandra_handling` / `automation_paused` / `draft_only_mode` / `conversation_closed` / `global_pause`; 422 `authority_required` / `sms_opted_out` / `do_not_text` / `outbound_blocked` / `unresolved_template_variables` |
| `POST …/drafts {body}` | suggestion for staff (a newer one supersedes the older pending one) |
| `POST …/tags {add[],remove[]}` | |
| `POST …/handoff {reason, assigneeUserId?, createTask?}` | → Human handling, bumps revision, drops her queued sends, notifies staff |
| `POST …/pause` | → Paused |
| `POST …/tasks {title, assigneeUserId?, dueAt?}` | task for a person, titled `[Sandra] …` |

Accepted ≠ delivered. Watch `message.status_changed` events (`provider_accepted`, `delivered`, `failed`, `unknown`, `suppressed`+detail). `unknown` means the provider outcome could not be verified: **never resend automatically**.

## Events

At-least-once, ordered by `seq`, metadata only (ids, status, `revision`), never message text. Visibility is evaluated when you read, so department changes apply immediately. Types: `message.received`, `message.status_changed`, `contact.opted_out`, `contact.opted_in`, `conversation.takeover`, `conversation.handling_changed`, `conversation.assigned`, `conversation.status_changed`.
Pull: `GET /events` returns events after your cumulative ack cursor; un-acked events are redelivered; `POST /events/ack {seq}` is monotonic. Optional push: set an https webhook URL (SSRF-guarded: public addresses only, pinned, no redirects); batches are signed `X-Relay-Signature: t=<unix>,v1=<hmac-sha256(secret, "t.body")>` (5-minute tolerance), retried with backoff until 2xx (2xx = ack). Pull always remains available.
**Recommended loop:** receive event → `GET conversation` (take `revision`) → decide → `POST messages` with that revision → on `409 stale_revision` discard the plan and start again from the new state.

## Not built / not verified

- No real assistant exists to integrate against; the contract is exercised only by the fake client and the test-suite.
- Per-key rate limits are per server process (N processes ⇒ N× limit).
- Keyword authority rules cannot understand meaning; see §5.
