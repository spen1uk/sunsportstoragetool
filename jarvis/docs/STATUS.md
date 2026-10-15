# Feature status & acceptance checklist

Legend: ⏸ deferred by decision · ✅ implemented **and tested** · 🟢 implemented, manually verified · 🟡 partial · ⚪ planned (not built) · ⛔ blocked on a decision/access

## Feature matrix

| Area | State | Notes |
|---|---|---|
| Single-user auth (scrypt passphrase, HttpOnly SameSite=Strict cookie, CSRF header, Host allow-list, login lockout) | ✅/🟢 | Passkey/WebAuthn is the planned "strong login" upgrade; passphrase + step-up for now |
| Step-up for high-risk approvals | ✅ | |
| Approvals bound to action digest, expiry, single execution, replay-safe | ✅ | Dashboard channel only; SMS/call channels deliberately rejected until identity verification exists |
| Standing permissions (separate from one-time approvals) | ✅ | Narrow kinds only, step-up to grant, daily cap, expiry, per-interface, revoke; see below |
| Tool policy engine (server-side, per task kind, arg schemas) | ✅ | |
| SSRF-guarded fetch (allow-list per hop, public-IP pinning, size/time limits) | ✅ | |
| Prompt-injection resistance for fetched content | ✅ | Content quoted as data, flagged, cannot change policy |
| Durable queue, leases, restart recovery, bounded retries/backoff, idempotency | ✅ | DB-backed; survives dashboard close and worker restart |
| Local-Mac tasks wait while no Mac is connected | ✅ | `requires='mac'` never claimed by cloud worker |
| Pause/resume (blocks claims, tool calls, approved-action execution) | ✅ | In-flight count shown; no instant recall |
| Research → sourced draft → review → revise → compare → restore → accept | ✅ | Quotes are always verbatim. With a model connected, a cited **Summary** is added (Sonnet first, Haiku fallback; optional work, so gated at 90% budget and the daily ceiling). Model output is checked: links stripped, bogus citations removed, uncited bullets flagged, citation-free text rejected; pages that look like they instruct an AI are never shown to the model. Without a model, or if it fails, you still get the quotes-only draft |
| Free-form revisions (model) | ✅ | "make this clearer" etc. on a highlighted passage or the whole draft (≤24k chars). Simple commands (remove / replace: / note:) never call the model. Guards: quoted source text and the Sources list can never change, no new links, no wholesale rewrites; always a new version for review, never auto-accepted |
| Accept ≠ publish; publish/delete need their own approval | ✅ | Publish is internal-only (nothing external) |
| Budget ledger: fixed-first, reservations, 75/90/cap, optional-work gating | ✅ | Provider bills not integrated (none connected) |
| Hash-chained audit log + tamper detection; secret redaction | ✅ | |
| Memory: remember/correct/forget (hard delete), secrets refused | ✅ | No auto-extraction (needs model) |
| Private mode (no persistence, no record changes) | ✅ | Server + UI; external-provider retention N/A until a provider exists |
| Backup snapshot + restore verification | ✅ | Unencrypted local file; encryption before off-box copy is a TODO |
| Universe UI: hierarchy, zoom, breadcrumbs, drag + saved layout, reset, stable labels/hit targets, quality + reduced-motion | 🟢 | Verified in headless Chromium; no automated visual tests |
| Art direction from Luke's reference images (painterly ember/violet/cyan/teal nebulae with dark voids, swirl-banded gas giants, lava worlds with night-side city lights, banded rings, black hole with starburst + spiral streaks, indigo/magenta UI palette) | 🟢 | Procedural (no image assets, no licensing issues) |
| Visual upgrade: bloom, procedural nebula, twinkling star layers, black hole with lensed photon ring + Doppler-lit accretion disk, plasma suns, atmospheres, flowing data links, HUD frame/grid/readout | 🟢 | three.js post-processing (EffectComposer + UnrealBloom). "Low" quality skips bloom. Verified in headless Chromium with software GL; real-GPU frame rates unmeasured |
| Cinematic flythrough: curved swooping arcs with ease-in/out, widening FOV, banking, hyperspace streaks, bloom surge, letterbox bars, idle camera drift; ←/→ and ◀▶ hop between systems/departments; Guided tour (ends on Esc or any manual navigation); reduced motion = instant cut | 🟢 | Verified in headless Chromium (software GL; real-GPU smoothness unmeasured). Tour is the foundation for the guided briefing (narration deferred with voice) |
| Energy pulses on links: comet packets fired by REAL events (dispatch out; done/needs-you/failed back to the core), energised link + packet stream while a task is running, arrival flashes and core surge. None when idle. Reduced motion: link lights only | ✅ events tested / 🟢 visuals | Server emits `pulse` only for agent-run work (never Luke's own to-dos); verified end-to-end in the live app. Visual frames verified by freezing packets (software GL ≈ 2 fps) |
| Living background: nebula re-rendered every frame from flowing domain-warped noise (cheap: small texture), sky + stars turn at different rates, filaments shimmer, occasional shooting stars, content-page wash drifts. Reduced motion = still (measured 0.00 change); speed uses real time so it looks the same at any frame rate | 🟢 | Measured 21/255 mean pixel change in 12 s before easing flow by ~30% |
| Planned/demo/live labelling | 🟢 | Everything except Jarvis + Research worker is PLANNED |
| Chat: deterministic commands first, model for everything else | ✅ | Commands stay instant and free. Model replies are **text only** (no tools), so they cannot act |
| Chat knows your real state: open tasks, Jarvis-run work, approvals, review items, projects/milestones, briefing urgencies, contact mode, budget, proposed slots, as a capped read-only snapshot (demo data excluded, text sanitised, none sent in private mode). Model still has no tools and cannot change anything | ✅ | ≈ +1,300 tokens max per message (≈ $0.0001 on Haiku) |
| One-click start: `Jarvis.command` / `npm run launch` (checks Node, sets up, builds when code changed, reuses a running Jarvis, refuses port conflicts); optional start-at-login LaunchAgent (`scripts/autostart.sh`); default port 8788 | ✅ launcher tested on Linux (fresh start, re-launch, port conflict) / 🟡 macOS LaunchAgent: plist generation tested, **`launchctl` itself not run on a Mac** | `open` and `launchctl` are Mac-only: first real run is yours |
| LLM provider layer (Anthropic via official SDK; routing, fallback, usage + cost tracking, daily ceiling, budget reservation) | ✅ tested / 🟡 live | Tested with fixture servers and fakes (59 tests). **Not yet run against the real API: no key configured** |
| Groq / other providers | ⚪ | Interface is ready; deliberately not added (second key + retention review) |
| Secure key storage | ✅ | Env var or `data/secrets.json` (0600), set via hidden-input CLI; never returned by any API (tested with a canary key) |
| Persona + voice config, continuity across sessions | ✅ | Fixed safety preamble first; persona is style-only; injected text can't break out (tested) |
| British voice | 🟡 | Free on-device browser voices (e.g. Daniel). Premium/streaming voice deferred |
| Core states: idle, thinking, executing, speaking, urgent, blocked, paused, disconnected | 🟢 | Driven by real events (speaking = real speech-synthesis start/word/end events) |
| Core "listening" state, mic level visualization | ⏸ deferred | Needs microphone + speech recognition (privacy/cost decisions) |
| Voice nav (typed commands only), "yes" never approves | ✅ | Spoken input not built; spoken output via browser voices |
| Contact-hours rules (sleep, gym text-only, church silence, family/personal/meal, away, emergency exception) | ✅ | Pure logic in `contact.ts`; not yet wired to real notifications |
| Escalation (desktop → text +5 min; urgent call → text → one retry; ack cancels; dedupe) | ✅ | Pure logic; nothing is sent |
| Chicago DST-correct daily times (8:00 briefing, 12/16/20 reminders, 22:00 recap, 7:30/23:05 collection) | ✅ | `schedule.ts` |
| Day planner: work-hour slots, 15-min buffers, deadline/overcapacity flags; reconcile touches only Jarvis-owned blocks | ✅ | Pure logic; no calendar connected yet |
| Briefings page (urgent → updates → proposed schedule → recommendations; Monday = week ahead; narration capped < 3 min; unconnected managers listed as "no report") | ✅ | Text only; read-aloud deferred with voice |
| 12/4/8 p.m. reminders (unfinished tasks by importance; completing cancels), 10 p.m. recap, missed items recorded as missed | ✅ | Runs only while the app is running on the Mac |
| Desktop notifications (browser Notification API) + in-app tray, acknowledge / snooze / open | ✅/🟢 | Needs your browser permission. "Open" suppresses escalation without approving anything |
| Text/SMS step of escalation | 🟡 | Decided and **recorded as "NOT SENT"** — no SMS adapter exists |
| Contact-mode controls (Available, Personal, Family, Meal, Church, Unavailable, "I'm out for a bit" / "I'm back") | ✅ | In the top bar; timed modes expire on their own |
| Overnight Plan page ("Do this tonight" overrides priority; holds, owner, desired result, estimate) | ✅ | Executes only while the app runs |
| Task duration + deadline fields feeding the planner | ✅ | Deadline entered in browser-local time |
| Apple Calendar (iCloud) — read-only copy from the Mac | ✅ logic+tests with a fake Mac / ⛔ not yet run on a real Mac | macOS scripting (osascript/JXA), no password stored; Luke picks which calendars; 15-min refresh while on the Mac; STALE label; feeds planner (timed events block slots), briefings, chat snapshot. Repeating events are expanded from their RRULE text (daily/weekly/monthly/yearly, interval, count, until, ordinals, excluded dates; tested incl. DST); unusual rules are counted and reported, not guessed. Each sync records what was scanned. Works only while Jarvis runs on a Mac |
| Apple Notes — read-only copy from the Mac | ✅ logic+tests with a fake Mac / ⛔ not yet run on a real Mac | Only chosen folders; note text never goes to the model or into chat history; same Mac-only limit |
| British streaming voice, interruption, audio-driven core | ⏸ deferred | Not a priority (cost). Core animation stays state-driven; it will follow real audio only if voice is ever added |
| SMS/calls on a dedicated number | ⛔ | Needs your approval to buy + registration/pricing verification |
| Sandra integration | ⛔ | Needs access to inspect; read-only first |
| Mac companion, screen observation, wake word | ⚪ | Phase 3 |
| Trading and Investing on the dashboard: reviewed rosters, grouped departments, per-agent claimed status + review notes, shared-engine plan | ✅ display / ⛔ connection | Everything is **planned**; statuses are Luke's claims, unverified. See docs/TRADING_INVESTING.md. Their systems are being built on a server; read-only heartbeat/report connection comes after |
| Health manager, financial data feeds | ⚪ | No financial connection exists |
| Projects with milestones and evidence-based progress | ✅ | Milestones with dates, dependencies (no loops/cross-project), linked tasks; status derived from facts; completion needs evidence (all linked tasks done, or written proof ≥ 10 chars); progress shown as "N of M milestones" + segmented bar, **never a percentage**; overdue / at-risk / ready-to-confirm feed the daily briefing; demo data isolated |
| Ready-for-Review region highlight | 🟡 | Text-selection anchor; image/layout regions later |

## Acceptance checks (handoff §13)

| Check | Status |
|---|---|
| Universe hierarchy, click/zoom/back; layout persists; labels usable while planets move | 🟢 manual (drag, reload, zoom, Esc verified) |
| Audio animation follows playback; interruption; voice nav ≠ approval | ⚪ audio / ✅ nav-≠-approval |
| Queued task survives restart; Mac work waits | ✅ |
| Reminder/briefing timing across DST, weekends, modes | ✅ logic / ⚪ delivery |
| Gym/church/sleep/dedupe/5-min escalation/single retry | ✅ logic / ⚪ delivery |
| Calendar block ending ≠ done; auto-reschedule only Jarvis blocks | ✅ logic (no calendar connected; proposed schedule is display-only) |
| Unauthorized tool denied server-side; changed/expired approval denied; no duplicate execution | ✅ |
| Untrusted document can't exfiltrate/alter policy | ✅ |
| Private mode leaves no session content | ✅ |
| Disconnect/pause blocks new work; offline-manager handback | ✅ pause / ⚪ managers |
| Budget reservations stop optional work; fixed costs included | ✅ |
| Missing/stale manager & financial data labelled | ✅ managers (PLANNED, no numbers) / ⚪ financial |
| Version restore and backup restore actually work | ✅ |

## Not verified in this environment
- Live research against the real internet (sandbox has no outbound DNS; the fixture-server test and the browser flow exercised everything up to and including honest failure/retry).
- GPU performance (rendered with software GL). Quality/reduced-motion controls exist but frame rates are unmeasured.

## Command Center home (Jarvis-only interface)
- `#/command` is now the default landing screen: Jarvis himself (greeting, live HUD rings, today/tasks/attention/systems/spend panels, conversation as the main input). All HUD values are real; nothing is simulated.
- `#/universe` keeps the full Agent Universe; flight between the two uses the existing cinematic camera. Esc or clicking the core returns to the Command Center.
- Chat commands "go to the command center" / "open the agent universe" navigate between them.

## Calendar & Notes (read-only, via the Mac)
- Pages: Calendar, Notes. Connections rows update to connected / stale / disconnected from real sync results.
- **Moving to a server:** macOS scripting does not exist there, so syncs fail and the last copy is shown STALE then disconnected. See README for the options (Mac bridge, or CalDAV for calendar).

## My Life and Modular Workspace
- **My Life** ✅ (tested): habits you check off yourself (Chicago days, streak, weekly count, 14-day back-fill, reversible) and people you want to stay in touch with ("every N days", overdue shown, "in touch today"). All typed in by you; never inferred, never sent to the language model; chat understands "I did gym" / "I talked to David" when exactly one thing matches (not in private mode). Overdue contacts appear as suggestions in the briefing. **Health stays ⚪ planned**: no health data is connected.
- **Modular Workspace** ✅ (tested server side, verified in headless Chromium): 10 panel types (conversation, today, next-up calendar, tasks, decisions, ready for review, habits, stay-in-touch, spend, systems) on a 12-column grid; Arrange mode to drag, resize, add and remove panels (others are pushed out of the way); up to 12 named saved layouts, one active; Main can be reset but not deleted. Layouts only change what you see.
- Not done: touch-device drag tuning, per-panel settings, cross-device layout sync beyond what the server stores.

## Quick links and Learning goals
- **Quick links** ✅ (tested): bookmarks Luke adds himself; only plain http/https addresses (no embedded logins, scripts, files); open in a new tab with `noopener noreferrer`. Jarvis never visits, logs into, scrapes or reads them. Max 40.
- **Learning goals** ✅ (tested): weekly targets (e.g. "Campus lessons, 5/week") logged with +1 / Undo; Monday-first Chicago weeks, 5-week history, week streak (an unfinished current week never breaks a streak). Chat: "did a TRW lesson" logs one toward the matching goal (not in private mode).
- Both are also Workspace panels. Neither is sent to the language model.

## Chat proposals with a Confirm button
- ✅ (tested; verified in headless Chromium with seeded proposals; **not yet exercised with the live model**). When a model reply suggests an action, it appears as a card (Confirm / Dismiss) on the Command Center, the chat dock and the Workspace conversation panel. **The model still cannot act**: a proposal is a database row that does nothing until you click Confirm; each one runs once, is re-validated at click time, expires after 24 h, and max 10 can be pending.
- Allow-list only (internal, reversible): add/complete task, queue research (new websites still need their own approval), remember (secrets refused), add/check habit, add person / note contact, add/log learning goal, add quick link. Anything else, or any object with extra fields, is dropped. No sending, spending, deleting, publishing, trading, settings, permissions or approvals.
- The card's wording is built by the server from the validated fields, not from the model's text. The ACTIONS line never reaches the chat history. **Private mode**: the model isn't told about proposals and any it returns are dropped.

## Memory suggestions
- ✅ (tested with a stand-in model; not yet run against the live model). "Look through recent chats" (Memory page) asks the cheap model (Haiku) to read the saved messages since the last look and propose up to 5 short facts Luke himself stated. They wait in a list; **nothing becomes a memory until Luke accepts it** (he can edit first); declined ones are never suggested again; facts already remembered are skipped; secrets and card-number-like text are filtered before they are shown.
- Optional auto mode (off by default): at most once a day, only with ≥ 6 new messages, and it backs off an hour after any attempt. Optional work: gated at 90% budget and the daily ceiling. Private-mode chats are never saved, so are never read. Cost: a fraction of a cent per run.

## Server move groundwork (nothing deployed)
- ✅ (tested) Mac helper bridge: `npm run bridge:setup` / `npm run bridge` reads Calendar/Notes on the Mac (read-only) and pushes to the server; credential created with step-up, stored hashed, revocable, can open only /api/bridge/*; server discards anything outside the ticked calendars/folders; failures show as stale/disconnected. Optional auto-start: `scripts/bridge-autostart.sh`.
- ✅ (tested) `JARVIS_ALLOWED_HOSTS`, `JARVIS_PUBLIC_HTTPS` (Secure cookies + HSTS), `/api/health`.
- 📄 docs/DEPLOY.md, deploy/jarvis.service (hardened systemd unit), deploy/jarvis.env.example. **Not executed.** Still open: passkeys, encrypted off-site backups, security review, uptime alert.

## Passkeys and encrypted backups
- ✅ **Passkeys** (tested with a software authenticator for every failure path, and end-to-end in headless Chromium with its virtual authenticator): register (needs step-up), sign in, step-up for high-risk approvals, remove, "require passkey" switch (passphrase refused with a recovery hint; removing the last passkey can't lock you out; `npm run setup -- --allow-passphrase`). ES256 only, user verification required, single-use 2-minute challenges bound to the session, origin/RP derived from the validated Host, signature-counter rollback refused. **Custom code on a security boundary: on the list for the independent review.** Needs a named address (localhost), not 127.0.0.1.
- ✅ **Encrypted backups** (tested incl. tamper/truncation/wrong key/rotation, and via the real CLI): public-key encryption (X25519 + HKDF + AES-256-GCM), server holds only the public key, recovery key shown once, snapshots verified before encrypting, plaintext removed, newest-N rotation, restore never overwrites, restore drill, Settings shows last backup/drill. systemd timer in deploy/.
- ⚪ Not done: off-site copy job, uptime alert, independent security review.

## Security review round 1
- ✅ Three independent AI-assisted reviews (auth/passkeys/bridge/approvals; untrusted content & LLM boundary; API/web/data-at-rest/backups/deploy). 1 high, ~7 medium, the rest low: all verified and **fixed with regression tests** (see docs/SECURITY_REVIEW.md). Highlights: a hostile web page could freeze the server (fixed: linear-time HTML parsing); no more lockout-DoS; step-up is now spent by one action and passkey-required really means passkey; Confirm cards show exactly what will run.
- ⚪ Still wanted: a human expert's review of `server/passkey.ts` and the deployed server before anything with real money is connected.

## Always-on and Range Rover vision
- 📄 Requirements preserved and checked against the code in docs/ALWAYS_ON_AND_VEHICLE.md (no car hardware chosen or bought; nothing for the car built).
- ✅ Groundwork: every message now records its interface (`channel`).
- ⚠ Findings: device registry with scoped tokens needed; **inbound calls/texts conflict with the private-only link** (decision needed); voice is the main cost risk; greeting and glance/driving-mode APIs should be server-side.

## Uptime alerts and off-server backups
- ✅ (tested) **Health** checks (database, disk, backup age, off-server copy) shown in Settings, the briefing and the Command Center. ✅ Optional **heartbeat** to an outside dead-man's-switch (off until `JARVIS_HEARTBEAT_URL` is set; empty https request; reports failure when an urgent problem exists). ✅ **Mac helper** notifies if the server stops answering. ✅ **Off-server copies**: the Mac helper pulls the encrypted backups over the private link, verifies hash/format, confirms to the server, keeps 30.
- ⚪ Not done by me (needs you): creating the outside-alert account; running `npm run bridge:setup` on the Mac after the server exists. Not executed anywhere yet; no server exists.

## Device registry and server greeting
- ✅ (tested) **Device registry**: phone / car / text / voice clients each get their own revocable key (shown once, hashed on the server, 1-year expiry, max 8). Scopes are only `chat`, `greeting`, `glance`: there is no scope that can confirm an action or change settings, so a device's proposals always wait on your dashboard. Add/remove in Settings → Devices (adding needs step-up).
- ✅ (tested) **Server greeting** (`/api/device/greeting`): built only from real records (appointments, urgent items, decisions, drafts, health); driving profile is two short lines, parked profile is fuller; "Welcome back" if seen in the last 20 minutes. **Glance** (`/api/device/glance`) for a car screen. **Device chat** (`/api/device/chat`) gives short spoken-style replies when driving, rate limited.
- ⚪ Still open: the inbound call/text decision is yours; handoff and per-device spend were added after this (below); the phone/car page is `/go`.
- ✅ (tested) **Conversation handoff**: if your last exchange was on a different interface within 6 hours (e.g. the car), the parked greeting says "Picking up from the car, 12 minutes ago: you asked …" and the chat model is told, so a follow-up like "and the second one?" works on your phone. Built from stored messages only (no model, no cost); private chats are never stored so never appear; driving mode stays short. Device endpoint: `GET /api/device/handoff`.
- ✅ (tested) **Spend per device**: every model call is now tagged with the interface (dashboard / phone / car / sms / voice / system) and the device that made it. Settings → AI models shows "this month by interface"; Settings → Devices shows each device's spend against its **monthly limit** (default $10, set 0.50–50 when adding). A device at its limit gets a polite refusal for chat until next month; greeting and glance stay free. The limit is checked before each call, so one in-flight call can overshoot slightly; the global $100 cap and daily ceiling still apply on top. Voice has no separate pricing yet because voice isn't built.
- ✅ (tested; looked at in a real mobile-size browser) **Jarvis Go** (`/go`): a small phone/car page. Paste a device key once (kept in that browser only); it shows the status line and the glowing core, plays the greeting, takes typed or spoken questions (the browser's own mic and voice, free) and speaks the answers. **Driving** = huge text, big buttons, no keyboard when a mic is available, short answers; **Parked** = normal. It can't confirm anything, and a removed key is dropped from the page at once. Only this page is allowed to ask for the microphone. ⚪ Not tried on a real iPhone or in a car yet: browsers need HTTPS before they allow the mic, which the server move provides (over Tailscale); until then it works with typing at `http://localhost:8788/go` on the Mac.

## Plan
- 📄 Stock-take, server-move phases, rollback, risks and the full open to-do list: **docs/SERVER_MOVE.md** (a plan only; nothing bought or deployed).
- ✅ (tested) **Edit a device's monthly limit** (Settings → Devices → Limit): lowering is immediate; **raising needs your passphrase or passkey** (spent by that one change) so a stolen browser session can't quietly lift a spending cap. Range $0.50–$50; every change is in the activity log.

## Standing permissions
- ✅ (tested) Approvals page → Standing permissions. You can pre-approve **one of four narrow, undoable kinds** of chat suggestion so it runs without the Confirm click: add a task, check off a habit, log learning progress, note you were in touch with someone. Nothing that sends, spends, deletes, fetches a website, saves a memory, completes a task or adds a link can ever be granted (the server rejects them).
- Each grant needs your passphrase/passkey (spent by that one grant), has a **daily cap** (1–30), a **time limit** (1–90 days) and a list of **interfaces** (dashboard, phone, car, voice; texts never). Never created by chat, a device or the model; never inferred from a one-time approval. Revoke is instant. A paused Jarvis never auto-runs anything.
- Every use shows in the reply ("Done under your standing permission: …"), is counted before it runs, and is in the activity log as Jarvis acting under that permission.
