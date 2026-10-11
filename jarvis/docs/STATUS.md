# Feature status & acceptance checklist

Legend: ⏸ deferred by decision · ✅ implemented **and tested** · 🟢 implemented, manually verified · 🟡 partial · ⚪ planned (not built) · ⛔ blocked on a decision/access

## Feature matrix

| Area | State | Notes |
|---|---|---|
| Single-user auth (scrypt passphrase, HttpOnly SameSite=Strict cookie, CSRF header, Host allow-list, login lockout) | ✅/🟢 | Passkey/WebAuthn is the planned "strong login" upgrade; passphrase + step-up for now |
| Step-up for high-risk approvals | ✅ | |
| Approvals bound to action digest, expiry, single execution, replay-safe | ✅ | Dashboard channel only; SMS/call channels deliberately rejected until identity verification exists |
| Standing permissions (separate from one-time approvals) | 🟡 | Table + list + revoke; **creation not built** (never inferred) |
| Tool policy engine (server-side, per task kind, arg schemas) | ✅ | |
| SSRF-guarded fetch (allow-list per hop, public-IP pinning, size/time limits) | ✅ | |
| Prompt-injection resistance for fetched content | ✅ | Content quoted as data, flagged, cannot change policy |
| Durable queue, leases, restart recovery, bounded retries/backoff, idempotency | ✅ | DB-backed; survives dashboard close and worker restart |
| Local-Mac tasks wait while no Mac is connected | ✅ | `requires='mac'` never claimed by cloud worker |
| Pause/resume (blocks claims, tool calls, approved-action execution) | ✅ | In-flight count shown; no instant recall |
| Research → sourced draft → review → revise → compare → restore → accept | ✅ | Extractive provider only; free-form rewrite declined honestly |
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
| Planned/demo/live labelling | 🟢 | Everything except Jarvis + Research worker is PLANNED |
| Chat: deterministic commands first, model for everything else | ✅ | Commands stay instant and free. Model replies are **text only** (no tools), so they cannot act |
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
| Apple Calendar / Notes | ⛔ | Needs provider/route verification (see FEASIBILITY) |
| British streaming voice, interruption, audio-driven core | ⏸ deferred | Not a priority (cost). Core animation stays state-driven; it will follow real audio only if voice is ever added |
| SMS/calls on a dedicated number | ⛔ | Needs your approval to buy + registration/pricing verification |
| Sandra integration | ⛔ | Needs access to inspect; read-only first |
| Mac companion, screen observation, wake word | ⚪ | Phase 3 |
| Investing/trading/health managers, financial feeds | ⚪ | Phase 4; no financial connection exists |
| Projects with milestones/evidence-based progress | 🟡 | Projects exist; milestones not yet |
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
