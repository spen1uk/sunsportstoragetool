# Relay — final completion report (Phases 0–7)

Repository: `spen1uk/sunsportstoragetool`, folder `relay/`, branch `claude/busy-wozniak-ngzpnc` (no PR opened).
Verification at completion: typecheck (server, web, scripts) + eslint clean; **401 automated tests passing across 18 files** against real PostgreSQL; backup/restore drill 18/18; crash-recovery drill 10/10; browser checks (desktop + mobile) on new screens.
Details per phase and per gate: `BUILD_STATUS.md`. Requirement matrix: `REQUIREMENTS.md`. Integrations: `INTEGRATION_CAPABILITIES.md` (and the in-app Connections page). Decisions: `DECISIONS.md`.

## 1. Implemented and tested (real code, real database, real processes)
- **Platform**: TypeScript/Fastify API + separate worker + PostgreSQL 16 (9 migrations), React PWA. Durable Postgres job queue with lease reclaim; realtime via LISTEN/NOTIFY → SSE with automatic recovery and client resync.
- **Messaging core**: auth, invitations, roles, department-scoped access (enforced in SQL), contacts/identities, inbox, assignment, notes, responsibility vs handling states, single send pipeline (idempotency → lock → fence → consent → outbox → worker re-check), ambiguous sends marked *unknown* and never auto-retried, duplicate/out-of-order webhook handling, opt-out enforcement everywhere, templates, scheduling, media, notifications.
- **Team features**: internal chat/tasks (no path to SMS), full-history summaries with citations (rule-based extractor), voice drafts requiring explicit send, timeline, inventory matching with stale/sold handling.
- **Automation**: workflows, auto-responses, broadcasts, analytics; follow-up rules (waiting-on-staff pauses customer follow-ups; reply/takeover/opt-out cancel pending steps); timezone/DST handling.
- **Integration framework**: adapter contract, encrypted rotatable credentials, token refresh, scoped read/write, SSRF guard, signed webhooks in/out, payments + reviews with sandbox adapters, reconciliation.
- **Assistant (Sandra) API v1**: machine identities with hashed revocable keys, scopes × autonomy × departments, fenced sends (`expectedRevision`), idempotency ledger, event feed (pull + optional signed push), owner-editable authority rules that divert risky messages to staff drafts, handoff/pause/tags/tasks, audit, fake client + contract tests, Settings → Assistant UI.
- **Operations**: worker heartbeats, `/ready`, health card, token-protected `/metrics`, security headers, log redaction, production boot guard, configurable job lease, backup/restore scripts + rehearsals, contact export/erase, retention doc, runbook, deployment package, security notes, cost-model formulas.
- **Migration preparation**: staged CSV import (contacts, history, opt-outs, templates) with mapping, preview, typed-confirmation commit, reconciliation list, rollback, retained opt-outs, silent/closed imported history, coverage disclosure in summaries; cutover checklist ledger with gates; synthetic fixtures; plan and guide docs.

## 2. Simulator-only / sandbox (works, but not against a real provider)
- **SMS/MMS** runs on the in-process simulator (labelled DEMO in the UI). No real send/receive has ever happened.
- **Payments and reviews** use sandbox adapters (`demo_pay`, `demo_reviews`), refused in production.
- **AI** features (summaries, voice cleanup, review drafts) use rule-based extractors; provider interfaces exist but no model is connected.
- **Sandra** is exercised only by the fake client; no real assistant exists yet.

## 3. External setup required (blocked on you or an outside account)
1. **SMS provider decision, temporary test number, spend approval** → then a real SMS adapter and the Phase 2 live gate (real send/receive, attachments, STOP/HELP, statuses). Not started: no adapter written from memory.
2. **Discovery answers**: who provides SMS on 262-269-0081 and how Kenect texts on it; line type and hosting eligibility; what Kenect can export (and in what format); Kenect contract/notice terms; what RingCentral does on the number.
3. **Kenect export files** (real format unseen).
4. **Hosting/domain/TLS/offsite backup/monitoring** (Docker image and Caddy untested: no container daemon here; systemd units only parse-checked).
5. **AI provider key** if model-backed summaries/drafts are wanted (see `docs/AI_DATA_SHARING.md`).
6. **Integration credentials** per system (Google, QuickBooks, Meta, TikTok, RingCentral call data, Zoho, Stripe, etc.): none built beyond the framework; evidence states in the capability matrix.
7. **Connecting Sandra** (owner action after her runtime exists).

## 4. Unsupported / not promised
- No universal TikTok or personal-Marketplace inbox (no verified API); review platforms only where an API is verified (access is application-gated for Google).
- Relay never ports a number, changes routing, contacts Kenect/RingCentral, or cancels a service; the cutover checklist only records what the owner does elsewhere.
- Native mobile apps and push notifications are not built (installable PWA only; device notification support not validated on target devices).
- No MFA/SSO, no malware scanner, no object-storage media backend, no contact-merge tool, no presence indicators or bulk actions.

## 5. Known limitations to weigh
- Summaries are regex-based, not an LLM: good on budgets/boats/dates/questions, weak on nuance.
- Sandra's authority rules are keyword + dollar-amount heuristics: paraphrases get through. Keep her at drafts-only until you are comfortable.
- Assistant and login rate limits are per server process.
- Contact erase does not reach team-chat mentions, older backups or third-party copies.
- Import completeness depends on what Kenect exports; attachments are not fetched.
- Costs: formulas only — **no prices were verified**, and no savings figure is claimed or guaranteed (Kenect's ~$5,000+/yr is only a comparison target). Capacity has not been load-tested.

## 6. Safety statement
No live customer message was sent. 262-269-0081, RingCentral and Kenect were not touched. Nothing was purchased or spent. No provider account was created. All data in the demo and tests is synthetic.

## 7. Remaining work, in order
Owner answers + provider decision → build/verify SMS adapter and run the live test-number gate → import real Kenect exports (staged, reconciled) → staff pilot → rollback rehearsal → owner go/no-go → cutover performed by the owner outside Relay → validation window → only then the owner decides on Kenect. Then optional: AI provider, Sandra connection, further integrations, native/push needs.
