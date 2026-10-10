# Integration feasibility & open questions

## What each integration needs (nothing below is connected)

| Integration | Known | Must verify before claiming it works |
|---|---|---|
| Apple Calendar | No first-party cloud REST API. Possible routes: CalDAV (iCloud app-specific password), EventKit via a Mac companion, or a Google/Microsoft-backed calendar if that is what backs it | Which provider actually backs Luke's calendar; recurring events, busy/free, time zones, sync lag, write behavior; a separate "Jarvis Tasks" calendar |
| Apple Notes | No public cloud API | Whether a Mac companion (AppleScript/Shortcuts export) is acceptable; show staleness when the Mac is off |
| Sandra | Existing Claude Code–built manager; **not inspected** | Runtime, API/auth, capabilities, how to get heartbeat + reports + pause. Needs access. First step: read-only status/report. |
| SMS/calls | Dedicated number needed; US A2P 10DLC registration likely needed for SMS | Provider choice, registration lead time, delivery, cost (see COST_MODEL), call-recording consent rules, Luke's country |
| Voice | Streaming STT/TTS + turn detection + interruption | Licensed British voice; provider data-retention terms; latency on Luke's network |
| Language model | Needed for synthesis, free-form revision, memory extraction | Provider + key + data-retention terms; Private-mode wording per provider |
| TradingView charts | Embedding/widget licensing varies; delayed data is common | Use official links/widgets only; label delayed |
| Mac companion | Needs outbound-only authenticated channel, macOS permissions (Screen Recording, Accessibility, Mic) | Notarized build vs. local script; macOS version |

## Questions only Luke can answer (everything else I am proceeding on)

1. **Where should Jarvis live?** Currently `jarvis/` inside this repo as an isolated folder. Do you want a separate repository? (I recommend yes before Phase 2; it's a one-command move.)
2. **The approved concept image did not arrive** — only the handoff `.md` was attached. I built from the written spec. Please re-attach it so I can match the visual details (palette, core, panel layout).
3. **Sandra access** — can I get read access to her repo/runtime (not to change it)? This unblocks Phase 3 mapping.
4. **Calendar backing** — iCloud, Google, Exchange, or other? (Decides the Phase 2 route.)
5. **Country / phone** — US number? (Decides provider and registration path.) **No purchase will be made without your explicit approval.**
6. **Claude Code development spend** — count it against the $100 cap, or separate? I have **not** included it.
7. **Model provider** — which provider/key may Jarvis use, and are you comfortable with its retention terms? Until then chat stays in command mode.

Independent work continues without these: voice-nav/briefing/contact-hours engines, calendar scheduler core (pure logic + tests), project milestones, deploy-readiness (TLS/proxy/passkey design).
