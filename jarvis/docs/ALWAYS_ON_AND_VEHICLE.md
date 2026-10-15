# Always-on Jarvis and the Range Rover: requirements, architecture review, roadmap

Source: Luke's project brief (always-on cloud brain; phone, text, computer and Range Rover Velar as clients of one memory; custom Iron-Man-style vehicle dashboard; automatic startup greeting; wake word / steering-wheel activation; driving vs parked modes; proactive contact; cross-device continuity). **Nothing for the car is built yet, and no hardware has been chosen or bought.** This file preserves the requirements and checks today's code against them so later work isn't made harder.

## 1. Requirements (preserved)
1. **Always on, cloud-hosted**, independent of Luke's computer; one central system that every interface (computer dashboard, phone call, text, car) connects to, sharing memory, conversations, tasks and agent state. Overnight autonomous work, with sensitive actions still gated by permissions and approvals.
2. **Range Rover (2020 Velar)**: factory dual-screen, wired CarPlay, steering-wheel voice button, free console space. A compatible Android-based CarPlay "AI box" is a *candidate*, **unverified** (touchscreen, mic, speakers, steering-wheel button, auto-start all need checking before buying anything). The car app is a **thin client**; the AI runs in the cloud.
3. **Custom vehicle dashboard**: premium Iron-Man style, animated circular core that reacts to listening / processing / speaking, contextual cards (agents, schedule, Sun Sport Marine, notifications, weather/navigation, projects; images and reports only when parked). **Driving mode** = hands-free and glanceable; **Parked mode** = full interaction.
4. **Auto-start and greeting** (top priority): Jarvis launches with the car, animation, spoken time-aware greeting that later mentions appointments, notices and overnight results.
5. **Activation**: "Hey Jarvis" and/or the steering-wheel button; whether the hardware allows either must be investigated (a separate mic may be needed).
6. **Continuous conversations across devices** (phone call → car → computer without re-explaining).
7. **Proactive contact**: calls, texts, briefings, urgent alerts, agent-completion notices, with priorities and quiet hours.
8. **Architecture**: secure multi-device API, persistent memory/history, job scheduling, agent orchestration, voice, real-time channel, **device authentication**, remote notifications, spending limits, monitoring/backups/recovery, approval workflows.
9. **Safety**: don't modify factory vehicle software or touch safety systems; plain wireless CarPlay adapters are *not* the same as a full Android box.
10. **Priorities** (brief's phases): 1 core intelligence/memory/agents → 2 always-on cloud → 3 secure phone/text/computer access → 4 reusable interface & comms architecture → 5 research/verify car hardware → 6 vehicle dashboard → 7 voice activation, auto-start, contextual displays.

## 2. Today's code against those requirements
| Requirement | Today | Verdict | What to do (and when) |
|---|---|---|---|
| Central cloud backend, one shared state | One process + one database; deploy kit, private link, backups, Mac helper all built (not yet executed) | ✅ compatible | Execute the move (docs/DEPLOY.md) after the uptime alert + off-site copy |
| One conversation across devices | One shared `messages` history ✅; memory shared ✅; **new: each message records its `channel`** (dashboard / phone / car / sms / voice) | ⚠ partly | Later: a "where we left off" summary per topic/project so a new device can offer to continue (needs conversation topics + a handoff-summary call, ~cheap model) |
| Device authentication | Browser: passphrase + passkeys ✅. Mac helper: scoped bearer token ✅ (the pattern to copy) | ⚠ needs generalising | **Device registry with scoped, revocable tokens** (car, phone app, SMS/voice gateway). Scopes like `chat`, `speak`, `read-glance`; never `approve`, `settings`, `devices`. Created only with step-up; per-device rate limits; last-seen shown |
| Reaching Jarvis from phone/laptop/car box | Private Tailscale link only (decision made) | ✅ for devices that can run Tailscale (phone, laptop; an Android box *may*, to verify) | Car box without Tailscale → needs a different, narrowly scoped path (see next row) |
| **Inbound phone calls and texts** | Nothing; provider (e.g. Twilio-style) must reach *us* | ❌ **conflicts with "private only"** | Decision needed. Options: (a) texts: poll the provider's API outbound (no public URL needed); (b) calls: provider needs a public, signature-checked endpoint → a tiny separate relay that does nothing but verify and forward; (c) outbound-only (Jarvis calls you, you can't call him). Needs your purchase approval + number registration first |
| Voice (talk naturally) | Browser speech only (free, on-device); no server speech-to-text or text-to-speech; chat replies are not streamed; no interruption; no wake word | ❌ not yet | Voice pipeline (streaming STT + TTS, barge-in, short turns), on-device wake word (so the car mic isn't streamed all day), **per-channel spend caps** (voice is the biggest cost risk vs the $100 ceiling; an estimate goes in docs/COST_MODEL.md before building) |
| Proactive contact | Rules ✅ (modes, quiet hours, gym/church/sleep, escalation, dedupe); desktop notices ✅; SMS/call delivery ⚪ | ⚠ | Cheapest first: **web push to your phone** (free; on iPhone it needs the page added to the Home Screen). SMS/calls once the number is approved |
| Overnight autonomous work | Queue + worker ✅ (research/revision), budget gating ✅, "Do this tonight" ✅; proposals need your Confirm ✅ | ✅ compatible | "Finding new projects" should stay *proposals* (cards), never self-starting spend |
| Approvals / sensitive actions | Digest-bound, single-use, step-up spent per action, dashboard-only; **voice can never approve** ✅ | ✅ keep | Car and phone calls may *notify* and deep-link; they must never decide an approval |
| Context-aware greeting | Written in the browser (time of day + real counts) | ⚠ | Move to a server endpoint (`/api/greeting`: spoken-length text from schedule, urgent items, overnight results) so car/phone can use it |
| Driving vs parked | None | ⚪ | Add a **presentation profile** to the API (`glance` = ≤ 2 short lines, no images; `full`), chosen by the client/device; driving mode never asks for step-up or shows long text |
| Real-time channel | Server-sent events for the browser ✅ | ✅ | Car/phone clients can use the same stream (device token); add reconnect + offline "last known" display |
| Spending limits | Budget ledger, daily model ceiling ✅ | ⚠ | Track spend per channel; separate voice ceiling |
| Monitoring / backups / recovery | Encrypted backups + drill ✅, health check ✅, systemd restart ✅ | ⚠ | Uptime alert + off-site backup copy (next) |

## 3. Done now (so nothing painted into a corner)
- `messages.channel` (migration 014): the shared history already records which interface each turn came from; `/api/chat` accepts `channel` (informational only; real device identity will come from device tokens).

## 4. Cheap groundwork worth doing before the move (small, no new risk)
1. Device registry + scoped tokens (generalise the Mac-helper credential).
2. `/api/greeting` and `/api/glance` (server-side, spoken-length, driving vs parked).
3. Conversation topics + handoff summary.
4. Per-channel spend tracking.
None of these needs car hardware.

## 5. Car hardware: research checklist (nothing to buy yet)
- Verify, for the *exact* Velar and candidate box: touchscreen input reaches the box's UI; which microphone the box can hear (the CarPlay audio path may not expose the car's mic to the Android side); whether the steering-wheel voice button is only seen by the car/phone (likely Siri while CarPlay is active) so a wake word or separate mic may be required; true auto-launch on ignition; boot time; connectivity (hotspot or SIM); power (switched accessory USB, not wiring into the car); warranty/insurance implications.
- Also assess the no-extra-hardware alternative: a **phone app/voice interface used through the car's existing CarPlay**, within the categories Apple allows. It may give voice, audio greeting and glanceable cards with no box at all (to be checked against Apple's current CarPlay rules).
- Never modify factory software or touch vehicle networks/safety systems. Keep driving mode voice-first and minimal; no video, long text or step-up prompts while moving.

## 6. Roadmap mapping (brief's phases → status)
| Phase | Status |
|---|---|
| 1 Core intelligence, memory, agents, tasks | ✅ built (agents beyond research are still planned; Sandra/Trading/Investing connect later) |
| 2 Always-on cloud | 🟡 kit built + secured; **not executed** |
| 3 Secure phone / text / computer access | 🟡 computer ✅; phone browser works over the private link; text/call ⚪ (needs approval to buy a number + the ingress decision) |
| 4 Reusable interface/communication architecture | 🟡 channel column ✅; device registry, greeting/glance APIs, topics ⚪ (section 4) |
| 5 Verify car hardware | ⚪ research only |
| 6 Vehicle dashboard | ⚪ (the Command Center's rings and core are reusable for a car skin) |
| 7 Voice, auto-start, contextual displays | ⚪ |

## 7. Decisions needed from Luke (none block the next step)
1. **Inbound calls/texts:** accept a small public, signature-checked relay, poll-only texts, or outbound-only?
2. **Voice budget:** a separate monthly ceiling for voice (e.g. $15–25) inside the $100?
3. **Phone:** iPhone (so CarPlay and Home-Screen push) — confirm. A native iPhone app would need Apple's $99/year developer fee; a Home-Screen web app does not.
4. **Do the car-research alternative first** (phone via existing CarPlay) before buying any box?
