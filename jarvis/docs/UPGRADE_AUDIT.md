# Jarvis upgrade: audit, part 1 (Jarvis side) and what is blocked on Sandra

Written 2026-10-25. Nothing in this document changed any code. Everything below was checked in the Jarvis code in this repository (`jarvis/`, branch `claude/magical-heisenberg-ce1m2m`, 330 passing tests in 49 files). "Built" means the code exists and a test exercises it. "Partial" means some of it exists. "Not built" means I found nothing. "Unverified" means it exists but has not been run against the real service or a real Mac.

## 1. Where is Sandra?

**Not found.** This repository contains Jarvis (`jarvis/`) and the Sun Sport Marine Hub (the repository root: a Next.js 16 + Supabase storage-unit management app: units, customers, facility map, photos, notes, QR codes, employees, realtime). The Hub has **no AI code at all**: no model SDK, no prompts, no agent, no memory, no chat, no knowledge tables. A search for "Sandra" finds only Jarvis's own notes, which already say "Existing Claude Code-built manager; not inspected" (`docs/FEASIBILITY.md`) and "planned, not connected" (`server/seed.ts`). The only other repository visible to me is private and named `spen1uk/rsps-dashboard`; its name suggests it is unrelated and I have not opened it.

So Sandra is somewhere I cannot see: a separate repository, a folder on your Mac (for example inside `aicreationfolder`), Supabase edge functions or a hosted service that is not in this repository's `supabase/` folder, or a Claude Code project. **I will not guess her structure.** Everything in sections 3 to 6 that depends on Sandra is therefore marked "needs Sandra".

## 2. What Jarvis is, today (verified)

- **Stack:** TypeScript on Node 22 (native TS, `node:sqlite`), React 19 + Vite web app, zod. About 17,000 lines of TypeScript including tests. Single user. Anthropic API through Jarvis's own gateway (`server/llm/`), cheap-first routing (Haiku, then Sonnet), per-task routes, per-mission budgets, a daily ceiling ($1 default) and a monthly cap ($100).
- **Chat pipeline** (`server/converse.ts`), in this order: sources/yes-offers, founder and browser controls, "what can you do" and "build it", draft-opening, find-in-my-records, calendar add/move/delete (a model reads the sentence, code does it), delegate/mission/deep-research commands, the **front desk** (`server/intent.ts`: one cheap model call per non-trivial message picks up to 3 actions from a fixed menu or says "cannot" and files a gap), internet answers (plain prose, sources only on request), plain-words skill routing, then ordinary model chat. Persona and fixed rules are in `server/persona.ts` (rules 1 to 9).
- **Tools Jarvis can act with** (all code-validated, the model never executes anything): tasks, goals, memory, calendar read and write (Apple Calendar through macOS scripting, outbox, protected times), open web pages/apps/his own pages, email and text **drafts** (opened for him to send), the Jarvis Browser (separate window, he logs in, safe clicks only), research (Prometheus, deep research and missions), delegation to agents, the Agent Foundry (designs new agents), build briefs for Claude Code, 8 model skills, saved workflows with triggers and schedules, the Founder pack.
- **Not connected:** sending email, texts or calls (by your rule), money and trading, Zoho, QuickBooks, ads, Sandra, the screen, files on the Mac, document readers (needs a library approval from you).

## 3. Your 12 phases against Jarvis's actual code

| Area (your list) | Jarvis today | Status | Evidence |
| --- | --- | --- | --- |
| Model integrations and orchestration | Anthropic only, behind a provider interface; routes per task, circuit breaker, latency log, evals on 12 fixed cases, candidate list with approvals | Built (single provider) | `server/llm/*`, `evals/*`, `phase6.test.ts` |
| System prompts and personality | One persona, 9 fixed rules, "sir", British English, voice settings | Built | `persona.ts` |
| Conversation engine | Ordered pipeline above, 3-action front desk, follow-up handling for web answers, "build it", awaiting-answers for Founder runs | Built; see gaps in 4 | `converse.ts`, `intent.ts` |
| Short-term memory | Last 12 chat messages go to the model; web follow-ups use the last 4 web pairs inside 20 minutes; small state keys ("web:offer", "cannot:last", "founder:awaiting") | Partial: no summary of long conversations, no topic tracking | `converse.ts`, `context.ts` |
| Long-term memory | `memories` table: kind, scope, source, confidence; correction supersedes; forget is a hard delete; exclusions list; secrets refused; retention windows for messages, research, missions | Built | `memory.ts`, `exclusions.ts`, `knowledge.ts` (retention) |
| Memory quality (duplicates, contradictions, staleness) | Corrections supersede; nothing detects duplicates or contradictions; confidence is stored but not used to rank or caveat | **Not built** | `memory.ts` |
| Preference memory | Suggests memories from chat for you to accept (`memsuggest.ts`); no automatic adaptation of style | Partial | `memsuggest.ts` |
| Project memory | Projects, milestones, goals (progress from milestones), decisions with scenarios and calibration, knowledge graph with provenance | Built | `milestones.ts`, `goals.ts`, `decisions.ts`, `knowledge.ts` |
| Episodic memory | Chat history, decisions with outcomes, imported ChatGPT chats (private by default); recall is keyword search only | Partial | `chatimport.ts`, `search.ts` |
| Procedural learning | Skill improvement loop (gaps, candidates, sandbox, staged rollout, rollback), delegation send-back, decision reviews. No feedback signal on ordinary answers | Partial | `improve/*`, `delegation.ts` |
| Retrieval | Keyword `LIKE` matching for memories (up to 8 injected per chat); universal search over 17 sources; no embeddings or semantic search | Partial | `converse.ts relevantMemories`, `search.ts` |
| Internet research | Walled-off web search (private data never goes with it), deep research with a source catalog and reliability scores, 2-site corroboration, claims with citations, follow-up proposals | Built; Unverified against the real service at scale | `websearch.ts`, `deepresearch.ts`, `researchrouter.ts` |
| Document analysis | Not built (needs your approval of a document-reader library); HTML pages are read | Not built | `docs/SKILLS_PLAN_43.md` |
| Revisit research when new information appears | Not built (sources have review cadences, nothing re-runs old research) | Not built | |
| Reasoning and planning | Decision log with a challenge step, missions plan steps, Founder runs, multi-action front desk; no general planner/critic loop for arbitrary requests | Partial | `decisions.ts`, `missions.ts` |
| Task execution | Durable queue with leases, worker, missions engine, triggers (daily/interval/event), calendar outbox, restart sweeps for every long job, emergency stop | Built; always-on server move not done | `tasks.ts`, `worker.ts`, `triggers.ts`, `emergency.ts` |
| Multi-agent | Roster, delegation loop (assess, send back up to twice), Foundry, temporary agents. Sandra is a placeholder only | Partial (Sandra not connected) | `delegation.ts`, `foundry.ts` |
| Voice | Browser speech output and input in the web app; server-side voice deferred | Partial, Unverified | `web/src/go.ts`, `speech.ts` |
| Security | Passkey and passphrase sign-in, step-up for protected actions, approvals, capability grants per skill, hash-chained audit log, secrets in Keychain option, exclusions, backups, threat model, prompt-injection tests in 5 test files | Built | `auth.ts`, `approvals.ts`, `audit.ts`, `docs/THREAT_MODEL.md` |
| Monitoring and performance | Latency and cost ledger per call, health page, heartbeat, spend caps | Built | `llm/gateway.ts`, `health.ts` |
| Tests | 330 tests; scripted fake models; a real-browser smoke test run by hand | Built | `server/test/` |

## 4. Jarvis-side gaps worth closing (independent of Sandra)

These come from your list and from what I actually found missing. They are candidates for the plan, not decisions.

1. **Conversation continuity:** a rolling summary of older turns and a "current topic / open thread" record, so a conversation can be resumed after a break and "that" and "the other one" resolve. Today only the last 12 messages are sent.
2. **Memory quality control:** detect duplicates and contradictions when saving, mark facts as verified, preference or assumption, use confidence when answering, show staleness.
3. **Semantic recall:** embeddings or a hybrid keyword and meaning search for memories and past conversations. This needs a design choice about where embeddings come from (a second provider or a local model), so it is a decision for you.
4. **Feedback signal:** a cheap thumbs-up/down and "that was wrong because…" on answers, feeding the existing improvement loop (never rewriting rules by itself).
5. **Research follow-through:** an "open questions" list and re-checks of old research when its sources go stale.
6. **Planner/critic step** for multi-step requests: break down, compare options, challenge weak assumptions, name the approval points.
7. **Provider independence:** a second provider behind the existing interface (not required yet).

## 5. What I need from you to audit Sandra (read-only)

Tell me which of these is true, and I will take the safe route:

- **A. She is in a GitHub repository** (give me its name; it must be one your account can see). I can attach it read-only. I would read code, configuration, migrations and tests.
- **B. She is a folder on your Mac** (for example under `aicreationfolder`). Do not paste it here. Either run Claude Code in that folder on your Mac with a read-only brief that I write for you, or zip the folder **without** `.env` files, keys or customer data and attach it.
- **C. She runs as Supabase edge functions or another hosted service** that is not in the Hub repository. Then I need an export of the function code and the table structure (not the data).

Rules I will follow for any Sandra material: read only; never copy secrets, keys or `.env` files; never touch customer records; never run her against live data; any code idea moves to Jarvis as a reviewed, tested module in an isolated branch, not as a copy.

## 6. What happens once I can see Sandra

1. Audit of Sandra with the same table as section 3 (what exists, what is partial, what is only planned, each with evidence).
2. Side-by-side comparison using your KEEP, ENHANCE, REPLACE, COMBINE, CREATE framework, per capability.
3. Security review of every candidate component before anything moves.
4. A written plan with the risky changes marked, **sent to you for approval** before any implementation.
5. Implementation in small steps on a branch, each with tests and a regression run of the existing 330 tests, and a check that Sandra and the Hub are untouched.

## 7. Risks I can already see

- The biggest unknown is **what Sandra actually is**. She may be mostly prompt and configuration (easy to learn from, nothing to "transfer"), or deep integration with Supabase and the Hub's data (powerful, but exactly where customer records and credentials live).
- Jarvis and Sandra likely use different data stores and different security models. Sharing a capability must go through a narrow, authenticated interface, not a shared database.
- Anything that lets Jarvis reach Sandra's customer data needs its own explicit approval; this plan does not assume it.
- Cost: more memory and research intelligence means more model calls. Your current $1 daily ceiling is already reached by a few Founder runs, so any plan will include a cost budget.
