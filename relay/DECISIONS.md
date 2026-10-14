# Relay — Decisions

## D1 (2026-10-13) Location: `relay/` subdirectory, separate from the storage tool
The repo already contains an unrelated Next.js 16 + Supabase **storage-facility tool** (root `app/`, `lib/`, `supabase/`).
Relay is a different product, so it lives in `relay/` with its own `package.json`, database and tests. Nothing in the storage tool is modified.
Future link: Relay's "Storage" department/events can connect to that tool through a read adapter.

## D2 Stack: modular monolith, TypeScript
- **Server**: Fastify (REST + SSE realtime) — one long-running Node process; **Worker**: separate process, same codebase.
- **DB**: PostgreSQL 16, plain SQL migrations (`migrations/`), `pg` driver. Workspace-scoped rows (`workspace_id`).
- **Queue**: Postgres-backed `jobs` table using `FOR UPDATE SKIP LOCKED` + outbox table. No Redis dependency → fewer moving parts and lower hosting cost; durable across restarts.
- **Realtime**: Postgres `LISTEN/NOTIFY` → Server-Sent Events (works across server instances, no extra infra).
- **Web**: React + Vite SPA, installable PWA. Reason for not using the repo's Next.js: Relay needs long-lived worker/SSE processes and webhooks that a serverless model handles poorly, and AGENTS.md notes Next 16 has breaking changes; keeping Relay independent avoids coupling.
- **Auth**: argon2id password hashes, opaque server-side sessions in DB (HttpOnly cookie), CSRF via SameSite=Lax + custom header requirement.
- **Tests**: vitest against a real Postgres (`relay_test`).

## D3 Provider adapters; no provider is predetermined
SMS/AI/email/payments/inventory are behind adapter interfaces with a **Simulator** adapter (labelled DEMO in UI). Real provider chosen after verification (see INTEGRATION_CAPABILITIES.md).

## D4 Safety invariants (never relax)
1. No live customer message without owner approval; real adapters are disabled unless explicitly configured.
2. All sends (human, scheduled, broadcast, automation, Sandra) go through ONE `sendMessage` pipeline: consent → handling-mode/fencing → outbox idempotency → provider.
3. Internal chat is a separate table/type and has no path to the SMS pipeline.
4. UI never states a provider outcome that the provider hasn't reported; statuses queued/accepted/delivered/failed/unknown are distinct.
5. RingCentral voice, number 262-269-0081 routing, Kenect: untouched.

## D5 Phase 6 decisions
- **Assistant = machine identity, not a user.** Separate table, hashed keys, no cookie path; read-side visibility reuses staff rules via a 'staff'-role actor whose id is the identity id (can never match a real assignee). Writes are bespoke functions (not staff functions) so no FK to `users` is faked.
- **Two guards for fencing**: API pre-check (clean 409 body, audit) and the shared pipeline check (covers every caller). Worker re-checks at execution.
- **Idempotency ledger shares the write's transaction** (insert-first on a unique key ⇒ concurrent duplicates serialize; thrown errors roll back and are retryable; returned rejections are stored).
- **Events are a workspace log filtered at read time** (department changes apply immediately); metadata only; cumulative monotonic ack; push is optional and equals pull.
- **Authority**: keyword lists + ungrounded $ amounts; fails closed into a staff draft. Honest heuristic, not understanding.
- **Erase = anonymize in place** (keeps FKs, analytics counts, consent proof); number kept only as an opt-out suppression record.
- **Production refuses dev defaults** (exit 78) and the simulator webhook is 404 in production (it was forgeable with the default secret).
- **Undici blocks fetch to some ports (e.g. 4190)**: drills use 429x.

## D6 Phase 7 decisions
- **No vendor client for Kenect**: its export format is unseen, so imports are generic CSV + mapping; completeness is the owner's reconciliation job (the not-imported CSV).
- **Imports are inert by construction**: closed/unassigned conversations, `imported_batch_id` excluded from unread, analytics and the stale-send guard; no jobs, notifications or sends; commit is one transaction.
- **Consent is monotonic through imports**: latest-by-original-time wins, STOP wins ties, imports never create opt-in from a number, never roll back an opt-out. Unmapped opt-out-looking columns raise a warning.
- **Never auto-merge people**: shared numbers become separate `needs-review` contacts; ambiguous multi-contact numbers are skipped, not guessed.
- **The checklist is a ledger, not a controller**: it cannot (and nothing in Relay can) change routing/port/cancel; owner-only items, prerequisite order, an enforced post-cutover validation window and Relay's own data checks gate the *record*.
- **Thread ordering is `(created_at, seq)`** so imported history interleaves correctly with live traffic; imported rows carry their original timestamp as `created_at`.

