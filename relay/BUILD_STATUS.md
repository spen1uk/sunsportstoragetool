# Build status
Last updated: 2026-10-13

## Phase 0 — done (cost model still TODO, see below)
Repo inspected; Relay built in `relay/` (D1). Provider research logged in INTEGRATION_CAPABILITIES.md (secondary sources only — NOT yet verified against official docs).

## Phase 1 — COMPLETE (simulator SMS)  ✔ gate verified 2026-10-13
Evidence:
- `npm run check` → typecheck ✓, eslint ✓, 33 vitest tests ✓ (real Postgres).
- Two staff accounts see the same persisted synthetic conversation; per-user unread state (test `end-to-end over HTTP`).
- Access control: staff cannot read/send/take over/see contacts of departments they aren't in; financing is restricted; unauthorized assignment rejected; staff can't set Sandra mode or admin blocks; invites admin-only; CSRF header; login lockout (test file `api.test.ts`).
- Restart retention: verified both in-test (app rebuilt) and on real server/worker processes (conversation + unread survived kill/restart).
- Realtime: SSE verified on live server (`message.created` event received after simulated inbound). Payloads carry IDs only.
- UI inspected in Chromium desktop (1360px) and mobile (390px) with real login → simulated inbound → send → worker → "Accepted by provider".
- Mutation checks: removing the execution-time consent check or the worker fence check makes tests fail.

## Phase 2 — partially built early (simulator-tested), live gate BLOCKED
Done: webhook signature + timestamp tolerance + event ledger replay defense; duplicate/out-of-order handling; outbox + idempotency; ambiguous/crash → `unknown` (never auto-resent); STOP/START/HELP with provider-auto-reply flag to avoid duplicate acks; opted-out queued/scheduled sends suppressed; live channels refused unless owner enables them.
TODO: templates, scheduled-send UI/API, MMS/media + storage, notifications, real provider adapter.
**Blocked (needs owner):** test-number SMS provider account + approval to spend; provider choice after verifying official docs.

## Not started: Phases 3–7. Sandra: contract is planned (fencing already enforced server-side); API/fake client in Phase 6.

## Known limitations / honest notes
- SMS is a simulator. No provider adapter exists yet; no MMS.
- Presence (who is viewing) not built; typing is best-effort.
- Bulk actions, tags UI, groups, merge tool, templates, scheduling UI not built.
- Notifications/push not built (manifest + minimal service worker only).
- Cost model not written (needs verified pricing).
- Single-process SSE listener per server instance; fine for one business.

## Next
1. Verify SMS provider docs (official) + hosted-number eligibility questions → recommend test-number provider; ask owner for account/spend approval.
2. Phase 2 remainder: templates, scheduling, media.
3. Phase 3: team chat/tasks, summaries, matching.
