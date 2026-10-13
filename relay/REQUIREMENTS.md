# Requirements checklist (mapped to handoff sections)
Legend: [ ] todo · [~] partial · [x] done+verified (evidence in BUILD_STATUS.md) · [B] blocked (external)

## §3 Architecture
- [x] Postgres + migrations · [x] authenticated backend · [x] responsive PWA (installable manifest; push not built) · [x] durable jobs · [x] media storage (local-disk adapter; object storage pending hosting choice) · [x] realtime (SSE)
- [~] provider adapters + simulators (SMS, summarizer, transcriber interfaces done; others pending) · [ ] separate dev/test/prod config · [ ] deployment/backup/restore docs
## §4 Interface (Inbox, Team Chat, Customers, Inventory Matches, Reviews, Payments, Automations, Broadcasts, Media, Analytics, Connections, Settings)
- [ ] each screen has working local behaviour; unconnected features explain setup
## §5 Messaging
- [x] phone normalization · [x] outbox+idempotency, ambiguous sends not retried · [x] webhook signature/replay (simulator signing) · [x] dup/out-of-order events
- [~] open/closed ✓, assignment ✓, search ✓, filters ✓, per-user read ✓; tags UI, bulk actions w/ preview TODO · [~] typing ✓, concurrent-reply warning ✓, presence TODO
- [x] responsibility states vs handling modes · [x] server-side takeover fencing · [x] follow-up rule (Phase 4)
- [B] real test-number SMS/MMS (needs provider account + spend approval)
## §6 Customers
- [~] contacts ✓, identities ✓, boats ✓ (API; UI read-only), groups TODO · [x] consent states + enforcement · [x] STOP/START/HELP (simulator; real provider rules to verify) · [~] timeline (basic) · [ ] merge w/ rollback
## §7 Summaries  [x] chunked extraction + deterministic reconciliation, coverage, versions, citations, superseded facts, incremental + rebuild, edits/deletes/imports/merges, permission-scoped, provider-failure-safe, usage rows. [~] extractor is rule-based (no AI) — LLM adapters need API key. [ ] externally-shareable summary variant
## §8 Team chat   [x] DMs, department channels, groups, customer-linked, threads, mentions, unread, search, attachments(API), message→task w/ due date & link-back, isolation (import-graph + runtime tests). [ ] chat attachments UI
## §9 Voice       [x] record (MediaRecorder), browser-speech/typed fallback, transcriber adapter (none configured), subset-only cleanup, original+cleaned shown, explicit send, owner-only access, retention purge. [B] mic capture/browser STT untested on real phones
## §10 Matching   [x] inventory w/ source-of-truth+freshness, explicit prefs, explain/rank, missing vs disqualifying, recalculation on all triggers, sold/unknown excluded, stale flagged, feedback, duplicate-outreach log, draft-only packages re-verified at send, future policy (consent/cap/quiet hours) encoded not wired. [B] no live inventory connection
## §11 Templates ✓ (versions, variables, missing-field validation, search, favorites, dept scoping, manager-only edit) · Scheduling ✓ (DST gap/overlap, creator tz, cancel, history, recheck at execution) · [x] automation builder (bounded steps, conditions, branches, delay, stop conditions, preview/dry-run, activate/pause, versions, execution log, idempotency, loop prevention, frequency limits, quiet hours, opt-outs, global pause) · [x] broadcasts · [x] auto-responses/business hours/holidays · [B] external-event triggers need verified adapters
## §12 Analytics [x] (appointments/reviews/payments pending connections) · Media [~] library, validation, signed expiring links, revocation, MMS limits; TODO branded share pages, malware scanner · [x] reviews framework (sync, reply workflow w/ approval + audit, manual import, sentiment-blind requests) · [x] payments framework (signed events, reconciliation, refunds) · [B] provider-backed validation needs credentials/adapters
## §13 Connections framework  [x] adapter contract, encrypted+rotatable creds, OAuth refresh/recovery, scoped read/write, incremental resumable sync, mappings (loop-safe), retries/backoff, reconciliation, disconnect/revoke, last-sync/errors, capability labels, webhook verification, SSRF guard, generic webhooks in/out · [B] real provider adapters (see matrix) · [ ] Relay API keys (Phase 6)
## §14 Sandra API  [ ] service identity, scopes, events, fencing, idempotency, fake client, docs
## §15 Security   [x] roles ✓ dept scope ✓ rate limits ✓ audit ✓ · [ ] retention/export/delete · [ ] secret mgmt (Phase 5)
## §16 Phases 0–7 gates  (see BUILD_STATUS.md)
## §17 Final report, cost model, runbook, migration checklist
