# Build status
Last updated: 2026-10-13

**Verification summary:** `npm run check` = typecheck ✓ · eslint ✓ · 277 tests ✓ (real Postgres). Browser-verified (Chromium, desktop 1400px + mobile 390px, real server+worker processes). Nothing real has been sent: SMS is a DEMO simulator.

## Phase 0 — done (cost model TODO)
## Phase 1 — COMPLETE ✔ (see git history / earlier notes): auth, roles, dept-scoped access, contacts, inbox, assignment, notes, responsibility vs handling states, durable messages, SSE realtime, responsive UI, restart retention.

## Phase 2 — COMPLETE for simulator; live gate BLOCKED
Gate items and evidence:
- Duplicate webhooks/retries don't duplicate: tests (event ledger, provider-id uniqueness, idempotency key, ambiguous → `unknown`, crash mid-send → `unknown`). ✓
- Opted-out scheduled sends suppressed at execution time: test ✓ (also do-not-text, reply-since-scheduling → needs_review, closed → suppressed, cancel race-safe).
- Templates: variables from business-entered data only, missing-field refusal (UI + server), versions/revert, favorites, search, dept scope ✓. Business facts in Settings.
- Scheduling: DST spring-forward gap shifted forward, fall-back overlap = first occurrence, creator timezone preserved, history log ✓ (unit tests + browser).
- Media/MMS: magic-byte type check (spoofed .png rejected), size/type allowlist, sanitized names, private storage, signed expiring links, deletion revokes, MMS 5 MB cap (placeholder pending provider docs), inbound inline MMS stored, voice recordings owner-only ✓. Media library UI ✓.
- Notifications: in-app (assignee → dept → admins; mentions; tasks; scheduled-review) ✓. **Not built:** OS/phone push.
- **BLOCKED (owner action):** real approved test send/receive + attachment evidence. No provider adapter exists yet; needs your provider decision, account and spend approval. Inbound URL-only MMS needs an authenticated, SSRF-safe fetch adapter (not built).

## Phase 3 — COMPLETE for local behaviour (AI = rule-based)
Gate items and evidence:
- **Internal content cannot reach SMS:** chat module has no transitive import of messaging/queue/providers (test scans the import graph; mutation-verified), and a runtime test shows zero messages/jobs/provider sends. ✓
- **Summary covers older + new messages with citations:** 103-message history (3 chunks) → budget stated at message 1 superseded by budget at message ~102, both cited; incremental update re-extracts only changed chunks; imports/edits/deletes/merges handled; partial/failed/stale states reported honestly; permission-scoped (financing-only facts hidden, mutation-verified); notes never included. ✓
- **Voice requires explicit send:** draft stays draft until `confirm:true`; cleanup is delete-only (property test, 300 random inputs); no transcription provider configured → asks for transcript (no silent upload); recordings private + purged on retention. ✓ Browser flow verified with typed transcript. **Not verified:** real microphone capture / browser speech recognition on actual phones (headless Chromium has no mic).
- **Sold/stale inventory excluded or flagged:** sold + unknown excluded with reason; stale source → "unverified", not packageable; packages re-verified at send (price change, sold, stale all refuse). ✓
- Team chat: department/DM/group/customer-linked channels with membership rules (even the owner can't read others' DMs), threads, mentions (only people with access), unread counts, search scoped to readable channels, message→task with due date + link-back ✓.

## Phase 4 — COMPLETE for local behaviour (simulator SMS; no external-event adapters)
Gate items and evidence (`npm run check`: typecheck ✓ · eslint ✓ · **145 tests ✓**; browser-verified desktop + 390px):
- **Staff-wait state prevents customer follow-ups:** a follow-up step is HELD whenever Sun Sport Marine owes the customer a reply ("waiting on staff"/"needs our reply"); the assigned employee is reminded once after N hours, managers are escalated after M hours, and the follow-up resumes only after staff respond. Test walks the whole path and asserts no customer text is sent while we owe; mutation-verified (removing the hold fails 2 tests).
- **Customer reply / takeover (and close, STOP, do-not-text, Sandra/paused modes) stop pending steps:** checked before EVERY step; 7 parameterised cases assert nothing is sent afterwards and the stop reason is logged. Mutation-verified (removing the reply check fails 2 tests).
- **Timezone/DST:** business-hours open/close boundaries tested on spring-forward and fall-back days; quiet-hours end instant tested across both DST changes; holidays override; `nextOpenAt` skips closed days/holidays. Broadcast/scheduled sends convert local time with gap/overlap rules (Phase 2).
- **Restart recovery:** a step-job whose worker "died" holding an expired lease is reclaimed and executes exactly once; concurrent advances of one run send once (row lock + idempotency key); one pending job per run (found & fixed a bug where a re-deferral to the same instant could strand a run).
- **Opt-outs enforced during broadcasts:** audience is resolved at approval, but consent is re-checked per recipient at send time; test: do-not-text, staff opt-out and a STOP reply after approval → only the remaining person is texted (STOP sender gets only the compliance acknowledgment).
- **Logs explain execution:** per-run plain-language log (start, branch decisions with the values checked, waits with the next time, holds/reminders/escalations, stop reasons), conversation timeline entries, per-conversation "Automation activity" panel with next step + Stop button, dry-run preview that explains blocks.
What was built:
- **Business hours / holidays / auto-responses:** nothing assumed (unconfigured = "unknown", features stay off). First-contact greeting once; after-hours/holiday notices on a cadence; one message only when both apply; skipped (with a timeline note) when a human/Sandra owns the thread, staff already replied, STOP/HELP, global pause, or details are missing. Auto-replies are *passive* (don't change who owes the next move or the fence).
- **Automation builder (visual, bounded):** triggers inbound text / no-response follow-up / inventory change (only customers who marked interest); conditions; steps wait, send (follow-up flag), tag, assign, task, notify, set state, if/else; versions; activate/pause; global pause; limits (daily cap, quiet hours, loop protection: one active run per conversation, 5 runs/customer/day, no workflow-triggers-workflow).
- **Broadcasts:** individual texts only, tag/explicit audience, dedupe by number, exclusions with reasons (no marketing opt-in ≠ consent, opt-outs, missing details), preview with personalised samples + segment/cost estimate (cost "unknown" until you enter a rate), manager approval, scheduling, throttled batches, pause/resume/cancel, per-recipient status (accepted ≠ delivered), replies enter the inbox, quiet hours for marketing.
- **Analytics:** volume (tz-aware days, department, channel, staff), unanswered snapshot, first-human-response (hand-checked median/p90; automation replies excluded; waiting turns reported separately), delivery by true status, automation/broadcast performance ("replied within 48h" stated as correlation), tasks, cost estimates, CSV export (formula-injection safe), definitions on every metric, freshness + scope, permission-scoped.
Limitations specific to Phase 4:
- **External-event triggers (appointment/service/storage/invoice) cannot be activated** — no verified adapters exist; the UI says so.
- Dry-run assumes the conversation stays as it is now; real runs re-check live state.
- "Needs a customer response" = conversation is *waiting on customer* (optionally: our last message asked a question). No language understanding.
- Marketing texts: Relay does not auto-append opt-out wording or enforce carrier/legal content rules — verify requirements with the chosen provider/counsel before any live broadcast.
- Throughput settings (batch size / interval) are ours; the provider's real limits are unverified. `BROADCAST_MAX_RECIPIENTS` is our own safety valve, not a carrier rule.
- Analytics has no appointment, review or payment data yet and never computes sales attribution; response times are wall-clock.
- Quiet hours do not delay replies to a customer who just texted (auto-responses).

## Phase 5 — framework COMPLETE; provider-backed validation BLOCKED (no credentials, no real adapters)
`npm run check`: typecheck ✓ · eslint ✓ · **277 tests ✓** (15 files); browser-verified desktop + 390px. **No real provider is connected or tested.** Everything below ran against sandbox adapters (in-process fakes that go through the real framework code) — that proves the framework, NOT any vendor.
Gate items and evidence:
- **Honest blocked statuses:** every requested integration is listed in-app (Connections) with evidence state, scopes, account requirements, cost, tests, blockers and sources; entries with no adapter cannot be connected and say why. Tests assert: no capability is "production-tested", only adapter-backed entries are connectable, "sandbox-tested" appears only where true, personal Facebook Marketplace and RingCentral SMS routing are marked unsupported. Official-docs research (2026-10-13) found real gates: Google Business Profile API needs an approved application; Gmail restricted scopes need a third-party security assessment; Meta Advanced Access needs App Review + Business Verification; TikTok Business Messaging needs security reviews and isn't offered in EEA/CH/UK; Twilio/Telnyx Hosted SMS exclude mobile numbers and need an LOA.
- **Signed payment events:** payment status changes only on a signature-verified webhook (timestamped HMAC, 5-min tolerance) or an authenticated provider-totals fetch. Tests: unsigned/tampered/wrong-secret/stale/replayed webhooks change nothing; duplicates are no-ops; refund-before-payment doesn't corrupt state; any event order gives the same result; reconciliation fills a missed webhook and a late webhook can't double-count (mutation-verified: removing verification and removing the no-double-count rule each fail tests); opening the success URL changes nothing; lower provider totals are flagged MISMATCH, not auto-fixed; paid-in-Relay never touches accounting fields.
- **Failed-token recovery:** refresh before expiry; transient refresh failure → stays connected with backoff; permanent refusal/revocation → `needs_reauth`, admins notified, queued syncs cancelled, no retry storm, secrets masked in errors; **re-authorization resumes from the saved cursor with no duplicates**; writes get one forced refresh then flag the connection. Resumable paged sync, one-pending-job-per-sync, idempotent upserts via external mappings with content hashes (our own reply echoing back is not treated as a change).
- **No unauthorized review publication or customer outreach:** the only code path that publishes to a review platform is `postReply` (static test). It requires: manager role, an approval bound to the exact text (any edit voids it; tampering detected), admin-enabled write permission, a claim so concurrent clicks publish once. Ambiguous outcome → `unknown`, never auto-retried, confirmed by the next sync. Audit trail records who approved what (hash). Drafts are rule-based and labelled "no AI". Review requests are sentiment-blind (strict schema; exclusions only consent/90-day re-ask), reuse broadcast approval/opt-out/quiet-hours safeguards, and replies are tagged private feedback. Inbound webhooks can create contacts/notes only — never send messages — and record consent only with explicit evidence.
- **Security:** credentials AES-256-GCM, bound to their row, key-versioned with rotation, never returned or logged; read and write permissions separate (write off by default); SSRF guard for webhook destinations (https/443 only, public addresses only incl. IPv4-mapped IPv6 and numeric-host tricks, connects to the validated address to defeat DNS rebinding, no redirects, re-checked each delivery; real-transport test proves loopback is unreachable); outbound events are metadata-only unless an admin opts a subscription into content; sandbox adapters refused in production.
What was built: connections framework (adapter contract, encrypted credentials, OAuth refresh, sync runner, mappings, scan, rotation, disconnect/revoke), generic webhooks (outbound with retries/backoff/dead-letter/redeliver; inbound signed lead endpoints), payments (requests, idempotent hosted-link creation, signed webhooks, reconciliation, refunds, manager-only), reviews (sync, summary with source-reported vs computed rating, manual import, reply workflow, review requests), Connections/Payments/Reviews screens.
Limitations specific to Phase 5:
- **No real adapters.** Stripe: only the signature scheme is implemented. Google/QuickBooks/Meta/TikTok/RingCentral/Zoho/OpenAI/Anthropic/SMS providers are documented, not built; their API request shapes are unverified because the docs sites could not be fetched here.
- Sandbox adapters hold state in the server process; run the worker with `SANDBOX_WORKER_SYNC=0` for demos.
- Outbound webhook delivery is tested with an injected transport; real network egress is untested.
- Review "AI drafts" are rule-based templates (no model); review responses to manually imported reviews must be posted on the platform by hand.
- Payments are manager-only to create; staff see statuses for customers they can access. Payment amounts capped at $250,000 per request (our own limit).
- No accounting integration: Relay cannot verify or change invoice balances.

## Honest limitations
- Summaries use a regex extractor, not an LLM: good at budgets/boats/dates/questions, weak at nuance; "unanswered" means no staff message followed at all. LLM adapters pending API key (docs/AI_DATA_SHARING.md).
- Inventory has no live source; import/manual only. "Source of truth" = the imported list, marked stale after 24h unless re-confirmed.
- No push notifications; PWA installable manifest + minimal service worker only.
- Local-disk media store (needs object storage for production); no malware scanner.
- Not built: presence, bulk actions, contact merge tool, Phases 6–7, cost model, deployment package. ("Groups" are tags.)

## Blocked / needs owner
1. SMS test-number provider choice + account + spend approval (and answers to the live-number questions in INTEGRATION_CAPABILITIES.md).
2. AI provider API key + approval (summaries/voice with real models).
3. Inventory system access/API details (or approval to treat manual CSV import as source of truth).

## Next
Phase 6: Sandra API (service identity, scoped access, events, fencing, idempotency, fake client, docs), operational hardening (backup/restore into a fresh environment, worker/realtime recovery demos), deployment package. Then Phase 7 migration preparation.
