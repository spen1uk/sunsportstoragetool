# Architecture decisions (ADRs)

**Principle:** smallest maintainable stack that fits a $100/month total cap; every dependency is a liability to review.

| # | Decision | Why | Revisit when |
|---|---|---|---|
| 1 | Self-contained `jarvis/` project, no shared code with the Sun Sport Marine Next.js/Supabase app | Handoff: new project, do not alter Sandra; also avoids inheriting that app's auth/RLS assumptions | You want a separate repo (easy: `git mv`) |
| 2 | Node 22 + native TypeScript stripping, `node:http`, **no web framework** | Zero server framework dependencies; tiny audit surface. Runtime deps: `zod`, `react`, `react-dom`, `three` | Routing/middleware needs outgrow ~40 routes |
| 3 | SQLite (`node:sqlite`, WAL) for the slice | $0, transactional, single file to back up, enough for one user. `BEGIN IMMEDIATE` gives atomic claim/approval transitions | Always-on multi-device hosting needs a managed DB → PostgreSQL (schema is portable SQL; migrations are plain `.sql`). `node:sqlite` is still flagged experimental by Node — accepted risk, pinned engine |
| 4 | DB-backed queue (leases, `next_run_at`, attempts) | Meets restart/durability/backoff needs without new infra | Throughput or fan-out beyond one worker |
| 5 | Policy lives in server code (tool table, per-task-kind grants, Zod arg schemas, allow-lists), never in prompts | Required: model/content can't widen permissions | — |
| 6 | Approvals = digest of canonical action payload; execution re-verifies digest and uses status transition as the single-use lock | Prevents tamper, replay, duplicates | Adding phone approval (needs verified identity first) |
| 7 | Extractive provider behind a seam (`research.ts`) — no model | Honest slice with $0 variable cost; model provider slots in later with budget reservation already wired in `worker.ts` | Model approved + key provisioned |
| 8 | three.js for the universe, DOM buttons for all interactive targets | GPU scene + accessible, stable hit targets; labels projected from 3D each frame at fixed px size | Perf problems on target Macs |
| 9 | Push via SSE, no polling, no model calls for "live" UI | Required; cheap | WebSocket needed for audio |
| 10 | Voice/telephony: LiveKit Agents is the leading candidate, **not installed** | See DEPENDENCIES.md for the review that must precede it | Phase 2 start |

## Components
`server/http.ts` (router, auth gate, CSRF, Host check, CSP) → `approvals.ts`, `tasks.ts`, `artifacts.ts`, `memory.ts`, `budget.ts`, `chat.ts` → `db.ts`/`audit.ts`.
`worker.ts` → `policy.ts` → `fetch.ts`/`net.ts` → `research.ts`. Same process by default; separable (`npm run worker`).
UI is a static bundle served by the API (loopback), or by Vite in dev with `/api` proxied.

## Data model (implemented)
agents, projects, tasks (+events, lease columns, idempotency key), artifacts + append-only versions + review_requests, messages, memories, approvals, standing_permissions, allowed_domains, connections, budget_ledger, layouts, sessions, audit (hash chain), meta. Not yet: milestones, calendar mappings, notification state, devices, files/object storage.
