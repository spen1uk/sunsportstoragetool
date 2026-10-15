# Project stock-take and server-move plan

**Status: a plan only. Nothing has been bought, created, installed or deployed.** The step-by-step commands are in docs/DEPLOY.md; this page says *what to do in what order, what could go wrong, and how to undo it*.

## 1. Where the project stands (as of this commit)
| Area | State |
|---|---|
| Core (tasks, approvals, budget, audit, pause, modes, reminders, briefings) | Built and tested |
| Command Center + Agent Universe | Built (looked at in a browser) |
| Chat with a language model (text only, proposals + Confirm button, memory suggestions) | Built and tested; needs your Anthropic key on the server |
| Calendar and Notes (read-only, via the Mac helper) | Built; verified on your Mac |
| Life, Workspace, quick links, learning tracker | Built and tested |
| Passkeys, step-up, encrypted backups, restore drill | Built; drill passed on your Mac |
| Health checks, outside-alert heartbeat, off-server backup copies | Built; outside-alert account not created yet |
| Device registry, greeting/glance, handoff, per-device spend limits, `/go` phone/car page | Built and tested; not tried on a real phone or car |
| Security | AI-assisted review round 1 done and fixed. **No human expert review yet.** |
| Not built / blocked | Voice (deferred), phone number and texts (needs your decision and a purchase approval), Sandra read-only (needs access), Trading/Investing (separate chats), Mac screen observation (later) |

## 2. The plan, in order
**Gate 0: before any server (free, on your Mac, a week). Daily checklist: docs/GATE0_CHECKLIST.md.** Use Jarvis normally. Add a passkey at `http://localhost:8788`. Make one encrypted backup and do the restore drill again after any key change. Write down anything annoying. *This is the cheapest place to find mistakes.*

**Gate 1: your decisions** (none cost money yet):
1. Provider and size. My default: a small Hetzner or DigitalOcean Ubuntu 24.04 box, about $5–12/month, in a US region.
2. Whether to turn on inbound calls/texts later (keeps the private link private if the answer is "no" or "poll only").
3. Outside-alert service (a free "dead-man's-switch" account that emails or texts you if Jarvis stops).
4. Anthropic data-retention terms (docs/DEPENDENCIES.md).

**Phase A: build the empty server (about an hour, you approve each purchase/account).** Create server, firewall deny-all, Tailscale on server/Mac/phone, Node, service user, code in a root-owned folder (DEPLOY steps 1–8). At the end Jarvis answers only over Tailscale and is **empty**; your Mac copy is still the real one.

**Phase B: rehearse.** On the new server run setup, set the Anthropic key, make a backup, copy it off, and restore it into a scratch folder (the drill). Add a passkey at the Tailscale address. Open `/go` on your iPhone over Tailscale and try the greeting, chat and voice (HTTPS makes the mic work). Create the outside alert and confirm it fires when you stop the service.

**Phase C: the move (a 20-minute window).**
1. On the Mac: `npm run backup:verify`, then make an encrypted backup.
2. Stop the Mac copy. Copy the database and `secrets.json` to the server (DEPLOY step 9). Start the server.
3. Sign in, check Settings → Health is green, check calendar and tasks look right.
4. `npm run bridge:setup` on the Mac, then `npm run bridge`; confirm Calendar/Notes sync and the first off-server backup lands.
5. Only then uninstall the Mac copy's start-at-login (so two Jarvises never both send reminders).

**Rollback.** Until step 5, nothing on the Mac is deleted: stop the server service and `Jarvis.command` on the Mac starts exactly where it left off (anything done on the server in the meantime would need exporting by hand, so keep the window short and don't do real work on the server until step 3 passes).

**Phase D: settle in.** A week of use; read Health daily; confirm one full week of backups reached the Mac.

**Gate 2: before real money or trading keys.** A human security expert reviews `server/passkey.ts` and the live server. Nothing financial connects before this.

## 3. What it costs
Server $5–12/month, Tailscale free tier, outside alert free tier, Anthropic usage per your budget (hard cap $100/month, expected $10–35), per-device limits default $10. No phone number, voice or SMS until you approve them. Prices are unverified third-party figures (docs/COST_MODEL.md): check them when you pick the provider.

## 4. Risks I'd watch
- **Passkeys are tied to an address.** The Mac's passkey won't work on the server; add a new one there. Keep the passphrase path available until a server passkey works (the "require passkey" switch stays off until then).
- **Two copies running at once** (double reminders). Phase C step 5 prevents it.
- **Lost recovery key = backups can't be opened.** Keep it in a password manager before the move.
- **Mac asleep** means no Calendar/Notes updates and no off-server copies until it wakes (labelled stale, not wrong).
- **Server compromise.** It holds your database and API key; hence private-only access, a root-owned code folder, a service that can write only its data folder, and the expert review before money.

## 5. To-do list (everything still open)
**Needs you**
- [ ] Gate 0 week of normal use on the Mac (docs/GATE0_CHECKLIST.md)
- [ ] Choose provider/size; approve purchase; create the Tailscale account (you do the sign-in)
- [ ] Decide inbound calls/texts (public relay / poll-only / outbound-only)
- [ ] Voice budget ceiling; confirm iPhone; CarPlay research before buying any box
- [ ] Create the outside-alert account; save the recovery key
- [ ] Go-ahead for each phase above
- [ ] Book a human security review before money/trading keys

**I can build, no input needed**
- [ ] **The Real World learning tracker (see section 6)**
- [x] Edit a device's monthly limit without re-creating it (done)
- [x] Standing permissions: a creation flow (done: narrow kinds only, step-up to grant)
- [x] Touch/phone tuning of the universe; per-panel settings (done; real-device check pending)

**Blocked on others**
- [ ] Trading/Investing report format (waiting on those chats)
- [ ] Sandra read-only view (needs access)
- [ ] Voice, SMS, phone number (need your approval and purchase)

## 6. The Real World ("TRW")
Already in Jarvis: quick links to the site and a weekly learning tracker ("did a TRW lesson" logs one). Jarvis does not log into it, read it or scrape it, by your earlier decision.

**Can I look through it on your computer with you?** Not from this cloud session: I can't see or control your screen from here. It is possible in the **Claude desktop app** with computer use or the Claude in Chrome extension turned on, where you log in yourself and I only look. If we do that, my rules would be: you sign in (I never type or see your password); I read only what's on screen to list the course/module titles and your weekly goals so the learning tracker matches how you actually study; I don't download or copy lesson content (that's the site's paid material); I stop at anything payment-, account- or settings-related; you can stop me any time. Jarvis itself still wouldn't connect to the site afterwards.
