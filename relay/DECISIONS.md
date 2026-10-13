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
