# Skills Architecture and Implementation Plan (the 43-item brief), 2026-10-19

Inspected against the repository as it is today (Phases 1 to 9 of the Master expansion are built; see STATUS.md). **Most of the brief already exists.** The architecture it asks for (central registry, permissions, audit, versions, rollback, composition, safety tests) was built in Phases 1, 3 and 9, so nothing here rebuilds it.

Status key: **Built** (works, tested) · **Partial** (some of it works) · **Not built** · **Blocked** (needs a decision, credentials or a security review from you).

## Section 9, the architecture, against what exists
| Requested | Where it is |
|---|---|
| Registry, unique IDs, versions, enable/disable, rollback | Built: `server/skills/registry.ts`, Skills page |
| Input/output schemas, permissions, tiers, limits, cost | Built: manifests with zod inputs, closed permission list, tier 0 to 4 |
| Central authorization, no bypass | Built: only `invoke()` runs skills; agent ceilings; grants only by you with step-up |
| Composition, reusable workflows | Built: workflows (staged → active by you), re-checked every run |
| Logging and audit | Built: hash-chained audit, `skill_runs`, `workflow_runs` |
| Natural-language request → right skill | **Partial**: chat routes by rules (commands, web, deep research); there is no general "pick any skill from the registry from plain words" step yet |
| Skill discovery and builder (Prometheus) | Built as proposals: Phase 9 finds gaps, drafts workflows or build briefs, tests in a sandbox, you approve. "Agent Foundry" does not exist in this repository; please say what it is |

## The 43, one by one
| # | Skill | Status | What exists / what is missing |
|---|---|---|---|
| 1 | Calendar | Partial | Apple Calendar read-only (Mac), shown in briefing and Calendar page. Missing: writing or rescheduling (would be an approval-gated action), travel/prep time, protected blocks |
| 2 | Task management | Built | Tasks, priorities, deadlines, milestones, dependencies, owners, overdue in briefing, overnight plan. Missing: auto-categories, automatic breakdown of big projects |
| 3 | Email | Blocked | Not built. Waits on your answers F8 to F21 and account decisions; drafts-only first |
| 4 | Research | Built | Web answers, deep research, missions, watches, evidence and citations, contradictions. Missing: auto-saving findings into memory |
| 5 | Meetings | Not built | Needs a transcript source. Decision log and notes cover part of it |
| 6 | Documents | Not built | Only HTML text extraction. PDF/Word/Excel reading needs a parser library (third-party, needs your approval and review) |
| 7 | Personal memory | Built | Memories, suggestions you approve, correct/forget, knowledge graph, exclusions, retention, export |
| 8 | Morning briefing | Built | Scheduled briefing, spoken short form. Investing, Trading, Baseline and business sections wait on those connections |
| 9 | Nightly review | Built (check time) | Evening recap exists; confirm it is at 10 PM Central, and add "ask for decisions" |
| 10 | Goal tracking | Partial | Learning goals, milestones, decision log. Missing: general goals linked to projects and agents |
| 11 | Travel | Partial | Research works via search. No itineraries or budgets. Never books or buys |
| 12 | Knowledge assistant | Partial | Apple Notes read-only, knowledge graph, imported chats. Missing: spaced repetition, learning plans, book summaries |
| 13 to 19 | Business monitoring, CRM, sales, marketing, customer comms, accounting, ops | Blocked | Nothing connected (Sandra not inspected; Zoho, QuickBooks, ad accounts not linked). Each needs credentials from you, read-only first, and the human security review before anything touches money or customers |
| 20 | Galaxy management | Partial | Agents page and roster (read-only). Missing: assigning objectives, pausing galaxies, manager reports (needs the connections above) |
| 21 | Agent delegation | Partial | Tasks have owners; missions go to Prometheus with budgets. Missing: automatic best-agent choice, review-and-return loop |
| 22 | Multi-agent collaboration | Partial | Missions with short-lived scoped helpers; agents cannot see each other's private data. Missing: cross-galaxy sharing rules |
| 23 | Agent performance | Partial | Per-skill stats, mission costs, model evaluations. Missing: per-agent scorecards over time |
| 24 | Agent creation | Partial | Short-lived helpers, proposals (Phase 9). No permanent agent creation by design |
| 25 | Autonomous execution | Built | Queue with leases, retries, checkpoints, dependencies, budgets, approval waits, restart recovery |
| 26 | Overnight work | Partial | Overnight plan and optional work that yields. Missing: development in isolated environments |
| 27 | Proactive detection | Partial | Health checks, overdue items, gap scanner, mission stalls. Business anomalies wait on connections |
| 28 | Notifications | Built | Contact modes, quiet hours, urgency, de-duplication, history. SMS and calls have no adapter yet (blocked on F8 to F21) |
| 29 | Workflow automation | Partial | Workflows chain skills with logs. Missing: triggers and schedules |
| 30 | Computer automation | Blocked | Phase 7, held for the human security review |
| 31 | Decision support | Built | Decision log, scenarios, challenge, calibration |
| 32 | Predictive intelligence | Not built | Low priority; needs data that is not connected yet |
| 33 | Opportunity discovery | Built | Watches, scouting presets, Prometheus proposals |
| 34 | Self-improvement | Built | Phase 9 |
| 35 | Model routing | Built | Phase 6; only Anthropic connected by design |
| 36 | Voice | Deferred | Your decision; Siri Shortcut path exists |
| 37 | Multi-device | Partial | Web, phone and car page, device keys, Siri Shortcut. SMS and calls not built |
| 38 | Command center | Built | Command Center, Universe, Agents, Missions, Knowledge and more |
| 39 | Universal search | Not built | Search exists per area only. Good next build |
| 40 | Permissions | Built | |
| 41 | Emergency stop | Built | |
| 42 | Data protection | Mostly built | Keychain secrets, encrypted backups, restore drill. Dev/production separation arrives with the server move |
| 43 | Skill safety testing | Built | Parity tests, sandbox checks, staged activation, rollback, audit |

## What I recommend building next (nothing blocked, nothing third-party)
1. **Universal search** (#39): one box over memory, notes, tasks, research, decisions and imported chats, with source references.
2. **Plain-words skill routing** (Section 9): Jarvis picks the right registered skill from a request, shows which, and checks authorization first.
3. **Workflow triggers and schedules** (#29), inside existing approvals.
4. **Agent delegation loop and scorecards** (#21, #23).
5. **Calendar writing as an approval-gated action** (#1), the useful half of the calendar.
6. **Documents** (#6) once you approve a parser library.

Your own top-10 list: items 1, 3, 4, 5, 8 and 10 are already built, 2 and 6 are partial, and 9 (email) is blocked on you. So the foundation you asked for is largely done; the value now is in the gaps above.


## Update, 2026-10-19: what changed since this plan
Built since: universal search (#39), plain-words routing, workflow triggers and schedules (#29), delegation and scorecards (#21, #23), the Agent Foundry (#24), calendar writing with protected times, travel/prep and change alerts (#1), task categories and breakdown (#2), goals linked to projects and agents (#10), spaced repetition, study plans and summaries (#12), model skills for comparing, fact-checking, trip plans, feature plans, change reviews, content ideas, decision prep and a weekly review (#4, #11, #31), the 10 PM recap that asks for decisions (#9), and research findings kept in the knowledge graph (#4). Still blocked on you: email (#3), the business items (#13 to #19), computer automation (#30), SMS and calls, meetings (#5, needs a transcript source), documents (#6, needs a reader library you approve), and the human security review. See STATUS.md for details of each.
