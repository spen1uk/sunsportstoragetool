# Relay — Sun Sport Marine

Original communications platform (shared SMS inbox, customer records, consent enforcement, Sandra integration interface). Lives in `relay/`; the repo's root app is an unrelated storage tool and is untouched.
**Status: Phase 1 complete, SMS is simulator-only.** See `BUILD_STATUS.md` for evidence, `REQUIREMENTS.md` for the checklist, `DECISIONS.md`, `INTEGRATION_CAPABILITIES.md`.

> No real text has been sent. The business number 262-269-0081, RingCentral and Kenect are untouched.

## Run locally
```bash
service postgresql start                       # or any Postgres 16
createdb relay_dev; createdb relay_test        # role/password per .env.example
cd relay && npm install
npm run migrate && npm run seed                # synthetic demo workspace (logins in seed output)
npm run build:web
npm run start:server                           # http://localhost:4000  (API + SSE + web app)
npm run start:worker                           # background jobs (message sending). Separate process.
npm run check                                  # typecheck + lint + tests (uses relay_test DB)
```
Dev UI with hot reload: `npm run dev:web` (proxies to :4000). Demo logins: `owner@/sam@/sue@/fin@demo.relay.test`, password `relay-demo-password` (synthetic seed only).

## Architecture (short)
Fastify API + SSE · separate worker · PostgreSQL (migrations in `migrations/`, durable `jobs` queue with `SKIP LOCKED`) · React/Vite PWA · provider adapters (`src/providers`) with a DEMO-labelled simulator.
All outbound texts (staff, scheduled, broadcast, automation, Sandra) go through `queueOutbound` (`src/domain/messaging.ts`): idempotency → fencing → consent → outbox → worker, re-checked at execution time. Internal notes are a separate table and have no path to SMS.

## Assistant (Sandra), operations, deployment (Phase 6)
- Assistant API: [docs/SANDRA_API.md](docs/SANDRA_API.md) · connect checklist: [docs/SANDRA_INTEGRATION_GUIDE.md](docs/SANDRA_INTEGRATION_GUIDE.md) · try the reference client: `RELAY_API_KEY=rk_… npm run sandra:fake -- --once` (key from Settings → Assistant). Not connected to a real Sandra.
- Operate: [docs/RUNBOOK.md](docs/RUNBOOK.md) · deploy: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (`npm run build`, Dockerfile/compose/systemd) · security: [docs/SECURITY.md](docs/SECURITY.md) · retention/erasure: [docs/DATA_RETENTION.md](docs/DATA_RETENTION.md) · costs (formulas only): [docs/COST_MODEL.md](docs/COST_MODEL.md).
- Drills with real processes on throwaway databases: `npm run drill:restore` (backup → fresh restore → boot) and `npm run drill:recovery` (SIGKILL worker/server). Backups: `scripts/backup.sh`, `scripts/restore.sh`.
- `/health` liveness · `/ready` · Settings → System health · `/metrics` (needs `METRICS_TOKEN`).
