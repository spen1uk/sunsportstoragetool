# Requirements checklist (mapped to handoff sections)
Legend: [ ] todo · [~] partial · [x] done+verified (evidence in BUILD_STATUS.md) · [B] blocked (external)

## §3 Architecture
- [x] Postgres + migrations · [x] authenticated backend · [x] responsive PWA (installable manifest; push not built) · [x] durable jobs · [ ] media storage · [x] realtime (SSE)
- [~] provider adapters + simulators (SMS done; others pending) · [ ] separate dev/test/prod config · [ ] deployment/backup/restore docs
## §4 Interface (Inbox, Team Chat, Customers, Inventory Matches, Reviews, Payments, Automations, Broadcasts, Media, Analytics, Connections, Settings)
- [ ] each screen has working local behaviour; unconnected features explain setup
## §5 Messaging
- [x] phone normalization · [x] outbox+idempotency, ambiguous sends not retried · [x] webhook signature/replay (simulator signing) · [x] dup/out-of-order events
- [~] open/closed ✓, assignment ✓, search ✓, filters ✓, per-user read ✓; tags UI, bulk actions w/ preview TODO · [~] typing ✓, concurrent-reply warning ✓, presence TODO
- [x] responsibility states vs handling modes · [x] server-side takeover fencing · [ ] follow-up rule (Phase 4)
- [B] real test-number SMS/MMS
## §6 Customers
- [~] contacts ✓, identities ✓, boats ✓ (API; UI read-only), groups TODO · [x] consent states + enforcement · [x] STOP/START/HELP (simulator; real provider rules to verify) · [~] timeline (basic) · [ ] merge w/ rollback
## §7 Summaries  [ ] full-history chunked, coverage, versions, citations, provider-failure-safe
## §8 Team chat   [ ] DMs, channels, customer-linked, threads, mentions, tasks, isolation test
## §9 Voice       [ ] record, transcribe (adapter), cleanup draft, explicit send, retention
## §10 Matching   [ ] inventory, explain/rank, recalculation, stale flagging, draft-only outreach
## §11 Templates/scheduling/automations/broadcasts/auto-response  [ ] all
## §12 Reviews/payments/media/analytics  [ ] all
## §13 Connections framework  [ ] contract, encrypted creds, refresh, webhooks, SSRF guard · per-provider status in INTEGRATION_CAPABILITIES.md
## §14 Sandra API  [ ] service identity, scopes, events, fencing, idempotency, fake client, docs
## §15 Security   [x] roles ✓ dept scope ✓ rate limits ✓ audit ✓ · [ ] retention/export/delete · [ ] secret mgmt (Phase 5)
## §16 Phases 0–7 gates  (see BUILD_STATUS.md)
## §17 Final report, cost model, runbook, migration checklist
