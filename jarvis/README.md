# Jarvis

Luke's personal assistant and operational coordinator. This is a **new, self-contained project** (own `package.json`, own database); it shares no code or data with the Sun Sport Marine app in the parent repository and does not touch Sandra.

**Honest scope today:** a runnable vertical slice — secure single-user API, durable task queue + worker, policy-gated research, review/versioning, approvals, memory, budget accounting, audit log, and the animated universe UI. No language model, voice, phone, calendar, Sandra, or Mac integration is connected; those are labelled *planned* everywhere they appear. See [docs/STATUS.md](docs/STATUS.md).

## Run it locally

Requires Node ≥ 22.18 (uses built-in `node:sqlite` and native TypeScript stripping — no ORM, no bundler on the server).

```bash
cd jarvis
npm ci
npm run setup          # creates ./data/jarvis.db and prints your owner passphrase ONCE
npm run build          # builds the web UI
npm start              # API + UI on http://127.0.0.1:8787  (loopback only)
```

Development with hot reload: `npm run api` (terminal 1) and `npm run web` (terminal 2, http://localhost:5173).

Optional: `npm run seed:demo` adds clearly-flagged DEMO records (`-- --remove` deletes them). Run the worker separately with `JARVIS_EMBEDDED_WORKER=0 npm start` + `npm run worker`.

## Verify

```bash
npm test               # 23 tests: HTTP auth/CSRF/Host, approvals, policy/SSRF, queue recovery, budget, memory, private mode, e2e research workflow, backup restore
npm run typecheck
npm run backup:verify -- data/backups/<snapshot>.db   # restore test: integrity + audit-chain check
```

## Try the first real workflow

1. Sign in, open **Tasks & Projects → Assign research**, enter a question and an `https://` URL.
2. The worker parks the task and raises an **allow_domain** approval (new domains are an access change). Approve it on **Approvals** (high risk → passphrase step-up).
3. The worker fetches the page (SSRF-guarded), saves a **sourced, quoted draft** (extractive — no model), and it appears in **Ready for Review**.
4. Highlight a passage and request `remove`, `replace: …` or `note: …`; compare v1/v2; restore; **Accept** (which completes the task — it does *not* publish).

## Layout

```
server/   API, auth, policy, approvals, queue/worker, budget, audit, backup (+ test/)
web/      Vite + React + three.js UI
docs/     STATUS, ARCHITECTURE, THREAT_MODEL, DEPENDENCIES, FEASIBILITY, COST_MODEL
```

Never commit `.env` or `data/`. Config examples live in `.env.example`.
