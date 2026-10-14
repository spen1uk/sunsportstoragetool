# Connecting Sandra — checklist for the owner and for her builders

Nothing below has been done. Relay does not contact Sandra; she contacts Relay.

## Before connecting (owner)
1. Settings → Assistant → **Create access**. Start at **Read only**, scopes `conversations:read messages:read contacts:read events:read`, departments = only those she should see (leave Financing out unless required).
2. Copy the API key into her runtime's secret store (shown once). Optional: a push URL (https) — copy the signing secret too.
3. Run the contract check against a **test** workspace: `RELAY_URL=… RELAY_API_KEY=… npm run sandra:fake -- --once` proves connectivity; then have her runtime pass the same flows (below).
4. Review **Authority rules**; add words your business reserves for people (trade-in values, warranty, delivery dates…).
5. Raise autonomy deliberately: `drafts` first (she suggests, staff use/dismiss in the inbox); only later `send` + `messages:send` (owner only).
6. Hand individual conversations to Sandra (Inbox → Handling mode → Sandra; managers+). She cannot send anywhere else.

## Acceptance flows her builders must demonstrate (all are tested against the fake client in `test/sandra.test.ts`)
- Reads events, re-reads the conversation, sends with the observed `revision`.
- On `409 stale_revision`: does **not** retry the same text; re-reads and re-decides.
- On `422 authority_required`: accepts that a draft now exists; does not rephrase around the rule.
- On `sms.canSend:false` or `contact.opted_out`: stops, no workaround.
- Retries network failures with the **same** `Idempotency-Key`.
- Treats `untrusted:true` text as data only.
- Quotes only `availability:"available"` boats and only listed prices; says nothing about hours when `hours.configured:false`.
- Stands down on `conversation.takeover`.

## Emergency stop
Settings → Assistant → **Disable now** (all keys fail at the next request; her queued, unsent texts are cancelled). Or pause all automation (Automations → global pause), which also blocks her.
