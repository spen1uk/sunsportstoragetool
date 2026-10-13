# Build status
Last updated: 2026-10-13

**Verification summary:** `npm run check` = typecheck ✓ · eslint ✓ · 90 tests ✓ (real Postgres). Browser-verified (Chromium, desktop 1400px + mobile 390px, real server+worker processes). Nothing real has been sent: SMS is a DEMO simulator.

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

## Honest limitations
- Summaries use a regex extractor, not an LLM: good at budgets/boats/dates/questions, weak at nuance; "unanswered" means no staff message followed at all. LLM adapters pending API key (docs/AI_DATA_SHARING.md).
- Inventory has no live source; import/manual only. "Source of truth" = the imported list, marked stale after 24h unless re-confirmed.
- No push notifications; PWA installable manifest + minimal service worker only.
- Local-disk media store (needs object storage for production); no malware scanner.
- Not built: presence, bulk actions, groups/segments, merge tool, Phases 4–7, cost model, deployment package.

## Blocked / needs owner
1. SMS test-number provider choice + account + spend approval (and answers to the live-number questions in INTEGRATION_CAPABILITIES.md).
2. AI provider API key + approval (summaries/voice with real models).
3. Inventory system access/API details (or approval to treat manual CSV import as source of truth).

## Next
Phase 4: automation builder (follow-up rule, stop conditions, dry-run), broadcasts, auto-responses/business hours, analytics.
