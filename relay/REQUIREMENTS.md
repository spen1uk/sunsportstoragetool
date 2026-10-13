# Requirements checklist (mapped to handoff sections)
Legend: [ ] todo · [~] partial · [x] done+verified (evidence in BUILD_STATUS.md) · [B] blocked (external)

## §3 Architecture
- [ ] Postgres + migrations · [ ] authenticated backend · [ ] responsive PWA · [ ] durable jobs · [ ] media storage · [ ] realtime
- [ ] provider adapters + simulators (DEMO label) · [ ] separate dev/test/prod config · [ ] deployment/backup/restore docs
## §4 Interface (Inbox, Team Chat, Customers, Inventory Matches, Reviews, Payments, Automations, Broadcasts, Media, Analytics, Connections, Settings)
- [ ] each screen has working local behaviour; unconnected features explain setup
## §5 Messaging
- [ ] phone normalization · [ ] outbox+idempotency, ambiguous sends not retried · [ ] webhook signature/replay · [ ] dup/out-of-order events
- [ ] open/closed, assignment, tags, search, filters, bulk preview, per-user read state · [ ] presence/typing, concurrent reply warning
- [ ] responsibility states vs handling modes · [ ] server-side takeover fencing · [ ] follow-up rule
- [B] real test-number SMS/MMS
## §6 Customers
- [ ] contacts, identities, boats (structured), groups · [ ] consent states + enforcement at send · [ ] STOP/START/HELP · [ ] timeline · [ ] duplicate merge w/ rollback
## §7 Summaries  [ ] full-history chunked, coverage, versions, citations, provider-failure-safe
## §8 Team chat   [ ] DMs, channels, customer-linked, threads, mentions, tasks, isolation test
## §9 Voice       [ ] record, transcribe (adapter), cleanup draft, explicit send, retention
## §10 Matching   [ ] inventory, explain/rank, recalculation, stale flagging, draft-only outreach
## §11 Templates/scheduling/automations/broadcasts/auto-response  [ ] all
## §12 Reviews/payments/media/analytics  [ ] all
## §13 Connections framework  [ ] contract, encrypted creds, refresh, webhooks, SSRF guard · per-provider status in INTEGRATION_CAPABILITIES.md
## §14 Sandra API  [ ] service identity, scopes, events, fencing, idempotency, fake client, docs
## §15 Security   [ ] roles, dept scope, rate limits, audit, retention/export/delete, secrets
## §16 Phases 0–7 gates  (see BUILD_STATUS.md)
## §17 Final report, cost model, runbook, migration checklist
