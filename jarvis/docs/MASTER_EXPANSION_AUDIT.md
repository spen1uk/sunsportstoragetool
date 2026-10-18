# Master capability expansion: audit, gap analysis and plan (Phase 0)

**Status: audit and proposal only. Nothing has been implemented, installed, bought or changed for this assignment. This document ends with an approval request; I am stopping there.**
Source brief: "Jarvis Master Capability Expansion & Intelligence Framework" (October 2026). Audit date 2026-10-18, branch `claude/magical-heisenberg-ce1m2m`, 183 tests passing. Evidence below is file paths and tests in this repository. Anything I could not inspect is marked **NOT VERIFIED**.

Scope note: the repository I can see contains the Jarvis project (`jarvis/`) and the unrelated Sun Sport Marine Next.js app beside it. I have not inspected Sandra, Prometheus, Trading or Investing code (separate repos/chats). I have not touched them.

---
## A. Executive summary: what Jarvis already does
Jarvis is a single-user, self-contained app (Node 22 + native TypeScript, SQLite, React + three.js; 4 runtime dependencies) with ~4,500 lines of server code, 133 API routes, 18 migrations, 29 test files.

- **Core operations (built, tested):** tasks/projects/milestones, a durable job queue with leases, approvals bound to a digest of the exact action (single-use), standing permissions (4 narrow kinds), audit log with a hash chain, pause switch, contact modes and quiet hours, briefings, reminders logic, habits/people/learning, quick links, modular workspace.
- **Model layer (built, tested, partly live-verified):** Anthropic only, via the official SDK; cheap-first routing (Haiku 5.5 default, Sonnet 5.5 stronger), budget reservations, a $100/month cap, daily ceiling, per-device limits, per-interface spend tracking. The model returns text only; actions are only *proposals* that need a Confirm click.
- **Research (built, narrow):** queue-based research from URLs you approve (domain allow-list, SSRF-safe fetcher, size/time limits, citation-checked summaries, flagged pages never sent to the model). New: opt-in **live weather** and **web search** (explicit "search:" turns walled off from private data), not yet tried against the real services.
- **Security (built, AI-reviewed once):** scrypt passphrase + passkeys, step-up spent per action, CSRF/Origin/Host checks, scoped hashed device tokens, encrypted backups with restore drill, health checks and an outside-alert heartbeat. **No human expert review yet.**
- **Interfaces:** browser dashboard (Command Center, Agent Universe, workspace), `/go` phone/car page, Siri Shortcut guide, Mac helper (read-only Calendar and Notes). Server deployment is **planned, not executed** (docs/SERVER_MOVE.md).
- **Not present:** any Prometheus agent, a skills registry, a source catalog, a knowledge graph, computer/screen/remote control, other model providers, Claude Code or ChatGPT integration, email/SMS delivery, a CI pipeline, or a staging environment.

## B. Feature-by-feature matrix
Legend: **EXISTING** works and is tested here · **PARTIAL** · **MISSING** · **NEEDS VERIFICATION** (built but not proven live / not inspectable).

### Research and internet intelligence (brief §2, §3)
| Requirement | Status | Evidence / gap |
|---|---|---|
| Quick answers with citations, timestamps, uncertainty | PARTIAL | `server/websearch.ts` + test `websearch.test.ts` (fake provider). Weather `weather.ts`. **NEEDS VERIFICATION** against the real services. No source timestamps beyond the provider's. |
| Query planning, decomposition, dedup, cross-source corroboration, contradiction detection | MISSING | Today one search turn = one question, max 3 searches. |
| Research source map/catalog (classify, score, monitor, revalidate, terms, cadence) | MISSING | Only `allowed_domains` (host list) in `approvals.ts`/`policy.ts`. |
| Respect robots/terms/rate limits; never bypass paywalls/CAPTCHAs | PARTIAL | `fetch.ts` has SSRF protection, size/time limits, https only, redirect re-checks. **No robots.txt handling, no per-site rate limiting, no terms tracking** (grep shows none). The search tool runs on Anthropic's side (their rules). |
| Long-form research that checkpoints and resumes after interruption | PARTIAL | DB queue with leases/attempts/backoff (`worker.ts`, `tasks.ts`); research tasks and revisions run. No multi-hour projects, no explicit checkpoint state, no resume-from-evidence. |
| Evidence tables, timelines, decision memos, reusable knowledge entries | PARTIAL | Cited summaries as artifacts with versions (`artifacts.ts`, `synth.ts`). No evidence tables/timelines/memos; no knowledge entries. |
| Proactive topic monitoring and exploratory research | MISSING | |
| Background quotas, rate limits, stop controls, priority preemption | PARTIAL | Budget gating, pause switch, daily ceiling, worker leases. No preemption of lower-priority jobs. |
| Prometheus (manager for deep R&D, patents, inventions) | MISSING | No such agent in code, seed or docs. Sandra exists only as a "planned, not connected" placeholder (`seed.ts`). Trading/Investing rosters are claimed-status displays (`roster.ts`), not connections. |
| Jarvis→Prometheus escalation, report-through-Jarvis | MISSING | |

### Skills (brief §4, §5)
| Requirement | Status | Evidence / gap |
|---|---|---|
| One versioned skills registry with manifests (schemas, permissions, cost, tests, rollback) | MISSING | The nearest things are two hand-written tables: protected actions (`approvals.ts` ACTIONS, with risk and handler) and proposal kinds (`proposals.ts` ACTION_TYPES, strict zod). Both are good patterns to build the registry *on*, not a registry. |
| Capability-based access, per-agent extensions, safe sharing | PARTIAL | Device scopes (`devices.ts`), standing-permission eligibility list (`standing.ts`), task-kind grants (`policy.ts`). Not generalised. |
| Autonomous skill discovery, vetting, build-in-sandbox, benchmark, staged deploy | MISSING | |
| "Ask before installing anything" | EXISTING (by construction) | Jarvis has no install capability; policy and review checklist in `docs/DEPENDENCIES.md`. |
| Combined skills inherit strictest permissions | MISSING (no composition exists) | Must be a design rule of the registry. |
| Skills Command Center | MISSING | |

### Governance, self-improvement, spending (brief §6, §10)
| Requirement | Status | Evidence / gap |
|---|---|---|
| Separate prod and dev/sandbox, staging, CI, scanning | PARTIAL | `npm test` + `typecheck` locally. **No CI pipeline, no staging environment, no automated dependency scanning** (manual `npm audit`, docs/DEPENDENCIES.md). |
| Jarvis may not weaken its own auth/spend/audit/approval | EXISTING (by construction) | Jarvis cannot modify code or settings; only Luke can, with step-up (e.g. standing permissions, caps). |
| Three-tier LOW/MODERATE/HIGH governance for self-changes | PARTIAL | Approvals have `standard`/`high` risk (`approvals.ts`). No self-modification pipeline yet because there is no self-modification. |
| All spending needs explicit advance approval, hard ceilings in code | PARTIAL | `budget.ts` reservations, $100 cap, daily ceiling, device limits, cap increases only via approved action. **Question:** does pre-approved model usage inside the cap count as "approved spending"? (See F.) |
| Missions: originate, decompose, assign, pause/stop agents; Mission Tracker | PARTIAL | Projects, milestones, tasks, roster pages (`milestones.ts`, `tasks.ts`). No proactive mission origination, no temporary scoped agents, no mission tracker UI. |
| Executive decision packages for opportunities | MISSING | |

### Computer, screen and remote access (brief §7)
| Requirement | Status | Evidence / gap |
|---|---|---|
| Three independent switches (computer control, screen viewing, remote control) with grants, audit, revoke, emergency stop | MISSING | The Mac helper is read-only Calendar/Notes (`bridge-mac.ts`, `mac.ts`); no control, no screen. A global pause exists (`pause.ts`) but is not an access-session killer. |
| Host-enforced authorisation, encrypted transport, session timeouts | MISSING for this feature | The *patterns* exist (bridge and device tokens are hashed, scoped, revocable; step-up). |
| Feasibility notes | See D.4 | |

### Models and integrations (brief §8)
| Requirement | Status | Evidence / gap |
|---|---|---|
| Multi-model router (task, latency, privacy, cost, measured performance) | PARTIAL | `llm/gateway.ts` routes by task with fallback and cost; one provider (Anthropic). No quality benchmarks, no other providers. |
| Evaluate OpenAI/Gemini/Grok/Perplexity etc. | MISSING | Interface seam exists (`llm/types.ts` Provider). Each would be a new vendor key and a retention review. |
| Claude Code coordination across repos with branches, review, audit | MISSING | Not feasible to assume: see D.4. |
| Selective ChatGPT import | MISSING | See D.4. |

### Memory and reasoning (brief §9)
| Requirement | Status | Evidence / gap |
|---|---|---|
| Layered memory, provenance, confidence, correction, forget | PARTIAL | `memory.ts` (source, confidence, supersede, forget, search), suggestions you accept (`memsuggest.ts`), private mode stores nothing. **No export** (not found), no knowledge graph, no retention policy per layer. |
| Knowledge graph (people, businesses, agents, decisions, files, goals) | MISSING | |
| Decision journal, scenarios, outcome evaluation | MISSING | |
| Legal-review disclaimers for patents/contracts | NEEDS VERIFICATION | Not specifically in prompts; trivial to add. |

### Communications (brief §11)
| Requirement | Status | Evidence / gap |
|---|---|---|
| Briefings 8 AM, nightly review 10 PM, 6 AM–11 PM window, urgent overrides, dedupe/snooze | PARTIAL | Rules and tests (`contact.ts`, `modes.ts`, `today.ts`, `schedule.ts`) match the described policy as I implemented it from your earlier decisions; **delivery is only desktop notices and the dashboard**. |
| Text/SMS, calls, email | MISSING here / NOT VERIFIED elsewhere | `send_message` is a permanently unavailable action (`approvals.ts`). You said you've worked on this elsewhere; I cannot see it. No messaging policy has been changed. |
| British voice, interruptions, low latency | PARTIAL | Browser speech (free), no streaming/interruption, voice deferred by your earlier decision. |
| Camera | MISSING (not requested now) | |

### Interfaces (brief §12) and security/reliability (brief §13)
| Requirement | Status | Evidence / gap |
|---|---|---|
| Preserve working Command Center; add missing panels | PARTIAL | Existing: Command Center, Universe, workspace (12 panel types), Activity/audit page, approvals inbox, health, spend. Missing: Research CC, Skills Registry, Mission Tracker, source explorer, model-eval dashboard, permission switches page. |
| Encrypted secrets | PARTIAL | `data/secrets.json` mode 0600, never returned by any API (`llm/secrets.ts`); **not encrypted at rest** (relies on disk encryption/FileVault). |
| Prompt-injection defences, sandboxed tools, untrusted-content rules | EXISTING | proposals, flagged-page rules, private-use-char fencing, walled web turns, threat model `docs/THREAT_MODEL.md`. |
| Restricted egress, signed releases, dependency scanning | PARTIAL / MISSING | App-level host allow-lists; no OS/firewall egress rules yet (server phase); no signing; manual audit. |
| Backups, restore test, health, alerting, graceful degradation | EXISTING | `backup-*.ts`, drill passed on your Mac, `health.ts`, `heartbeat.ts`. Outside-alert account not created yet. |
| Human security review | MISSING | Required before any financial or control capability. |

## C. Architectural gaps, security risks, duplication, constraints
**Gaps (largest first):** (1) no registry of capabilities, so every new feature adds another hand-written table; (2) no Prometheus/research manager and no source catalog; (3) no access-control layer for computer/screen/remote; (4) no CI, staging, or dependency scanning; (5) no knowledge graph or decision journal; (6) one model provider and no benchmarks; (7) delivery channels (SMS/email/calls) absent.

**Risks to manage:**
1. *Breadth vs. the $100 cap and the single-person design.* Several requested items (autonomous skill creation, multi-day research, temporary agents) multiply model spend. Every one needs a budget ceiling per mission.
2. *Untrusted content is the main threat*. Search results, pages, repos and chats must never combine with private data or actions. The web-search "wall" is the template; research, missions and skills must follow it.
3. *Self-modification.* "Jarvis builds and deploys skills" must stay: Jarvis proposes and tests in a sandbox; only Luke promotes; Jarvis can never touch approvals, budget, audit or auth code. I recommend skills be **data and tests under review**, not arbitrary code Jarvis can run on the server.
4. *Server not yet live.* Most of this should wait until Gate 0 and the server move are done, otherwise each new feature enlarges what must be validated at once.
5. *Plaintext secrets file.* Acceptable on a single-user Mac; before more providers/keys are added, move to the OS keychain or an encrypted store.
6. *Duplication:* the two action tables (approvals and proposals) plus device scopes plus standing eligibility are four permission vocabularies. The registry should replace them over time without changing behaviour (tests exist to pin it).

**Constraints:** SQLite single-writer (fine for one user); no web framework (small audit surface, but more hand-rolled code); Node 22 native TS; the cloud sandbox cannot reach many external APIs, so live behaviour must be verified on your Mac or server; Siri/CarPlay and Mac screen/control depend on Apple's rules and on you running the Mac helper.

## D. Proposed architecture and skill taxonomy
**D.1 Principle:** keep the modular monolith. Add *data-driven capability layers* on the existing seams; no new infrastructure until a measured need.

```
          Luke (dashboard · /go · Siri · later SMS)
                           │  explicit approvals, step-up
┌──────────────────────────▼─────────────────────────────┐
│ Jarvis core (exists): auth · approvals · audit · budget │
│  · pause · modes · device tokens · private mode         │
├─────────────┬─────────────┬──────────────┬──────────────┤
│ Skills      │ Research    │ Missions     │ Model router │
│ registry    │ router +    │ + agents     │ + evals      │
│ (manifests, │ source map  │ (Prometheus, │ (providers,  │
│  versions,  │ + evidence  │  temp agents)│  benchmarks) │
│  tests)     │ store       │              │              │
├─────────────┴─────────────┴──────────────┴──────────────┤
│ Knowledge: memory (exists) → graph tables + decision log │
├──────────────────────────────────────────────────────────┤
│ Host-enforced access broker (computer / screen / remote): │
│  runs in the Mac helper, not in the model's reach         │
└──────────────────────────────────────────────────────────┘
```
**D.2 Skills registry (the central idea).** A *skill* is a manifest plus a handler, stored under version control: `id, purpose, owner, version, input/output zod schemas, required permissions, dependencies, data sensitivity, side effects, external services, cost model, trust tier, tests, docs`. DB tables hold installed versions, status (staged/active/rolled-back), audit history and quality metrics. Rules enforced in code: a skill can only be called through the registry; its permission set is checked by the server at call time; a composed workflow's permissions are the **intersection/strictest** of its parts; high-risk side effects always route to approvals; no skill can grant itself permissions. Existing proposal kinds and protected actions are migrated in as the first built-in skills (behaviour pinned by their current tests).

**D.3 Skill taxonomy (from brief §4), staged by risk tier.**
- *Tier 0, read-only/internal:* web research, source monitoring, document/PDF/spreadsheet extraction, report generation, knowledge search, charts.
- *Tier 1, internal writes:* tasks, notes, drafts, learning plans, project plans, dashboards.
- *Tier 2, external read with credentials (each needs approval + its own vault entry):* CRM read, inventory/listings read, analytics read, market-data read.
- *Tier 3, external write / communications:* SMS, email, CRM writes, listings edits, social posting: always drafts for approval until a per-skill standing permission exists.
- *Tier 4, money/control:* trading, transfers, computer control, remote access: separate policy documents, separate approvals, human security review first.
- Build order follows value and risk: Tier 0 and 1 first; nothing in Tier 3–4 until the earlier gates pass.

**D.4 Feasibility notes (verified or flagged).**
- *Web research:* Anthropic's web search tool is real, priced $10 per 1,000 searches, and works server-side (verified in Anthropic's docs). "Access to the whole internet" is not literally possible or lawful; the goal is public/authorised sources with provenance. Site-specific APIs and licensed datasets each need their own terms/cost review.
- *Computer/screen/remote:* macOS requires explicit Screen Recording and Accessibility permissions granted by you in System Settings; the access broker would be a Mac helper process that enforces grants itself. A cloud server cannot control your Mac without a secure outbound connection from the Mac; this is possible but is the highest-risk feature in the brief and needs the human security review first. Phone control is not available to third-party apps in general on iOS.
- *Claude Code coordination:* being built in Claude Code does not give Jarvis access. A supported route is an explicit, narrowly scoped integration where Jarvis *prepares task briefs* and you start or approve Claude Code sessions (or a controlled bridge to the Claude Code remote-session API using a dedicated credential, with branch-only writes, no pushes to main and no secrets). I would start with "Jarvis writes the brief and you launch it". **NOT VERIFIED:** I have not tested any Jarvis→session API path.
- *ChatGPT:* no supported API for reading your account's chat history. Supported route: you export your data (or share chosen conversations as files) and Jarvis imports **only what you hand it**, per chat, default private, with provenance and deletion. I will not scrape or automate the account.
- *Other model providers:* each needs an official API account, key, terms and retention review, plus your approval of cost before any call. Consumer chat subscriptions do not include API access.
- *Perplexity/Grok/Gemini* etc. are candidates only; no benchmarks until you approve a provider and a non-sensitive test set.

**D.5 Data additions (all SQLite, additive migrations):** `skills`, `skill_versions`, `skill_runs`; `sources` (host, class, reliability score, terms notes, cadence, last validated), `evidence` (claim, source, retrieved_at, hash, confidence); `missions`, `mission_events`, `agents` extensions (temporary flag, budget, expiry); `entities`, `edges`, `decisions`; `model_evals`; `access_grants` (computer/screen/remote: scope, expiry, revoked_at). Nothing deletes existing data; every migration has a rollback note.

## E. Phased plan, costs and acceptance
Order revised to the real codebase and your gates. **Phase 0 is this document.** Estimated model-spend is inside your existing $100 cap unless stated.

| Phase | Deliverables | Key controls | Tests / acceptance | Migration & rollback | Approval points | Realistic cost |
|---|---|---|---|---|---|---|
| **1: Safety foundations** | GitHub CI (typecheck + tests + `npm audit` on every push); secrets moved to the macOS Keychain / encrypted store; a **permission-ledger** page (what each device/skill can do, grants, revoke); emergency "stop everything" button (pause + revoke all sessions/grants); per-mission budget primitive | Least privilege; CI cannot deploy | CI green on main; stop button halts workers within 5 s (test); secrets never in logs (test) | Keychain read falls back to old file until Luke confirms; keep old file until then | Approve any new CI service (GitHub Actions free tier assumed, NOT VERIFIED for private repos) | $0 expected |
| **2: Research router + source map** | Source catalog tables and UI; research router choosing between search tool, approved URLs, feeds and APIs; evidence store with citations and freshness; contradiction check; robots.txt + per-host rate limits in `fetch.ts`; "Research" Command Center page | Search-turn wall stays; sources need your approval to be marked trusted; no CAPTCHAs/paywalls | Fixture-based tests for each route; injection corpus test; robots honoured test | Additive tables; old research tasks untouched | Approve any paid data API individually | Search $0.01 each; ~$5–15/mo at moderate use |
| **3: Skills registry** | Manifest format + registry + permission-intersection rule; migrate existing proposal kinds and actions into it; Skills Command Center page | Registry is the only call path; skills can't self-grant | Existing 183 tests still pass unchanged; new tests for intersection and rollback | Dual-run (old tables stay as source of truth until parity tests pass) | Your review of the manifest design before migration | $0 |
| **4: Prometheus (manager) and missions** | Prometheus as a defined agent in Jarvis with checkpointed long jobs; escalation from Jarvis; Mission Tracker; temporary agents with scoped budget/time and automatic teardown; delivery rules (briefing/text/call) wired to existing contact policy | Reports to Jarvis; mission budgets; yields to your tasks | Interrupt/resume test; teardown test; budget-exceeded stops; dedup of alerts | New tables; no data deleted | Approve Prometheus charter and per-mission spend defaults | Depends on use; cap per mission, e.g. $1–3 |
| **5: Knowledge graph + decision log** | entities/edges/decisions tables; "what do we know about X" views; memory export/inspect; retention rules | Private/excluded never stored | Round-trip export test; forget propagates | Additive | Approve retention policy | $0 |
| **6: Model router + evaluations** | Provider interface additions; non-sensitive evaluation sets; scores by task type; fallback rules | No paid call to a new provider before your approval; no private text sent to test vendors | Eval harness runs on fake providers in CI | Additive | Approve each provider (key, price, retention) | Eval runs: a few dollars per provider, only with approval |
| **7: Access broker (computer / screen / remote)** | Mac-side broker with three independent switches, time-limited grants, visible status, audit, instant revoke, emergency stop | Enforced on the Mac, not by prompts; sensitive-app exclusions; human security review **before** release | Grant expiry/revoke tests; screen-off stops captures (test); remote ≠ screen | Opt-in, off by default | Separate approval for each capability; security review | $0 software; reviewer fee unknown |
| **8: Integrations** | Claude Code brief workflow; ChatGPT user-export import; (later) email/SMS per the answers to F | Drafts only until policy exists | Per-integration | Per-integration | Each separately | SMS/number/email service costs only after approval |
| **9: Autonomous skill improvement** | Gap detection, candidate evaluation, sandbox build, adversarial tests, staged rollout, rollback | Everything proposed, nothing self-promoted; third-party code never installed without your approval and review | Regression + rollback tests | Registry versions | Every promotion | Model spend per attempt capped |

**Sequencing against what's already planned:** finish Gate 0 and the server move first (docs/SERVER_MOVE.md). Phases 1–3 are safe to start in parallel with Gate 0 on your Mac. Phases 7–8 should wait for the server and the human security review.

**Recurring operating cost today (estimate, unverified):** server $5–12/mo (not yet bought) + model use $10–35/mo (your earlier estimate) + web search $0.01 each. New phases add cost only through model use and any APIs you approve.

## F. Questions that need your answers
**Governance and cost**
1. "All spending requires explicit advance approval": is the monthly model budget (currently $100 cap, per-device limits, daily ceiling) an acceptable *standing* approval for model and search calls, with every *new* vendor, subscription or paid API needing separate approval? Or do you want per-mission approval for each Prometheus project?
2. Per-mission default budgets: what are acceptable numbers for a quick lookup, a deep research project, and an exploratory idea (for example $0.10 / $2 / $5)?
3. Should Prometheus be a new agent inside Jarvis, or does Prometheus already exist elsewhere (a repo or chat)? If it exists, where can I look, and what is its current charter?
4. Who may promote a skill from staging to active: only you, always? Any exceptions for LOW-tier internal changes?

**Research**
5. Which domains/topics matter most first (boats and marine, investing, inventions/patents, competitors, local/regulatory)? This sets the first source catalog.
6. Are you OK with Jarvis using Anthropic's web search as the default engine, plus a small set of specific APIs you approve one at a time (patents, academic papers, market data)? Which do you already pay for?
7. How should patent and legal output be labelled (I propose a standing "research only, not legal advice" footer)?

**Email and SMS (detailed, as requested; I have not changed anything)**
8. What exists now, and where (repo, provider, number, mailbox)? May I see the code, or should Sandra's side stay entirely separate?
9. Accounts/numbers: which email accounts and phone numbers, personal vs business, and which may Jarvis use?
10. Recipients: internal only (you, staff) or external customers too?
11. Drafts vs automatic sends: which message types are draft-for-approval, which can auto-send, and who approves (you, Sandra's rules)?
12. Customer consent and opt-outs (SMS requires prior consent and STOP handling; email needs unsubscribe for marketing): where are consents recorded today? Business-hours rules per recipient timezone?
13. Content: personalisation fields, sensitive content rules, templates, language/tone, signature.
14. Escalation and failure: what happens on bounce, no reply, wrong recipient, provider outage? Frequency caps per person per day/week?
15. Audit: retention length for sent messages and who may read them.
16. Jarvis vs Sandra: which of them may send which categories, and may Jarvis message customers at all?

**Access, integrations, platform**
17. Computer/screen/remote: which Mac apps are always excluded (banking, password manager, Messages)? Is remote control from your phone the actual need, or is read-only status from afar enough to start?
18. Claude Code: do you want "Jarvis writes the task brief, I launch it" first? Should a future connection ever be allowed to push to a branch, and which repos?
19. ChatGPT: are exports you hand over acceptable (per chat, default private), and which projects do you want imported first?
20. Which other model providers, if any, do you already have API accounts for?
21. Server timing: do you want Phases 1–3 started before the server move, or only after Gate 0 and the move?

## G. Recommended immediate priorities and exact approval request
**Recommendation:** (1) finish Gate 0 and the server move as planned; (2) in parallel, do **Phase 1** (CI, keychain secrets, permission ledger, stop button, mission budget primitive) and **Phase 2** (research router, source map, evidence store, robots/rate limits) because they add safety and the capabilities you ranked first; (3) hold Phases 3–9 until you've answered section F and approved the architecture.

**Approval requested (please answer yes/no/changes to each):**
1. Approve the target architecture in section D (skills registry; research router and source map; missions with Prometheus; access broker on the Mac; knowledge tables), including the rule that skills are reviewed data and tests, never code Jarvis can promote by itself.
2. Approve starting **Phase 1 and Phase 2 only**, on branch `claude/magical-heisenberg-ce1m2m`, no installs of third-party software and no new paid services (GitHub Actions on the existing repo is the one external service I'd like to use; tell me if you object).
3. Answer F1–F7 (governance, cost, research) so Phase 2 can be built correctly. F8–F21 can follow later.

Until you reply I will not implement, install, purchase, message, or change anything for this assignment.
