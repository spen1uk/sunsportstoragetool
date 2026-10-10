# Feature status & acceptance checklist

Legend: ✅ implemented **and tested** · 🟢 implemented, manually verified · 🟡 partial · ⚪ planned (not built) · ⛔ blocked on a decision/access

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
| Planned/demo/live labelling | 🟢 | Everything except Jarvis + Research worker is PLANNED |
| Chat | 🟡 | Deterministic command mode, persistent; **no language model** |
| Voice nav (typed commands only), "yes" never approves | ✅ | Real speech not built |
| Briefings, reminders, contact-hours/escalation engine, Chicago DST | ⚪ | Phase 2 (budget period already uses America/Chicago ✅) |
| Apple Calendar / Notes | ⛔ | Needs provider/route verification (see FEASIBILITY) |
| British streaming voice, interruption, audio-driven core | ⚪ | Phase 2; animation will follow real audio only |
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
| Reminder/briefing timing across DST, weekends, modes | ⚪ |
| Gym/church/sleep/dedupe/5-min escalation/single retry | ⚪ |
| Calendar block ending ≠ done; auto-reschedule only Jarvis blocks | ✅ (no path marks done by time) / ⚪ scheduler |
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
